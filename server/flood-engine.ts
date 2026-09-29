/**
 * Server-side flood engine: wires the pure state machine (shared/flood-engine.ts)
 * to persistent storage, notifications, barrier automation and audit logging.
 *
 * Every accepted transition is persisted to flood_events. Non-duplicate events
 * fan out notifications (queue/retry via the outbox), optionally create a barrier
 * command when the automation policy says so, and always write an audit record.
 */
import {
  DEFAULT_FLOOD_ENGINE_CONFIG,
  advanceEngineContext,
  evaluateFloodEngine,
  emptyEngineContext,
  normalizeFloodState,
  rateOfRiseCmPerMin,
  type FloodEngineConfig,
  type FloodEngineContext,
  type FloodEngineEvent,
  type FloodEngineState,
  type FloodState,
} from '../shared/flood-engine.js';
import { execute, insertAudit, isTursoConfigured, randomId, rowText, rowNumber } from './database.js';
import { createBarrierCommand, type CommandAction } from './commands.js';
import { createSmsUnsubscribeToken } from './security.js';

export interface AutomationPolicy {
  autoBarrierOnWarning: boolean;
  autoBarrierOnCritical: boolean;
  autoLowerOnRecovery: boolean;
  notifyEmailOnCritical: boolean;
  notifySmsOnCritical: boolean;
  notifyPushOnWarning: boolean;
  notifyOnRecovery: boolean;
}

export const DEFAULT_AUTOMATION_POLICY: AutomationPolicy = {
  autoBarrierOnWarning: true,
  autoBarrierOnCritical: true,
  autoLowerOnRecovery: false,
  notifyEmailOnCritical: true,
  notifySmsOnCritical: true,
  notifyPushOnWarning: true,
  notifyOnRecovery: true,
};

let configCache: { config: FloodEngineConfig; loadedAt: number } | null = null;
let policyCache: { policy: AutomationPolicy; loadedAt: number } | null = null;
const CACHE_MS = 30_000;

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? { ...fallback, ...parsed } as T : fallback;
  } catch { return fallback; }
}

export async function resolveEngineConfig(): Promise<FloodEngineConfig> {
  if (configCache && Date.now() - configCache.loadedAt < CACHE_MS) return configCache.config;
  let config = DEFAULT_FLOOD_ENGINE_CONFIG;
  if (isTursoConfigured) {
    try {
      const result = await execute("SELECT value_json FROM site_settings WHERE key='flood_engine_config'");
      if (result.rows.length) config = parseJson(rowText(result.rows[0], 'value_json'), DEFAULT_FLOOD_ENGINE_CONFIG);
    } catch { /* fall back to defaults */ }
  }
  configCache = { config, loadedAt: Date.now() };
  return config;
}

export async function resolveAutomationPolicy(): Promise<AutomationPolicy> {
  if (policyCache && Date.now() - policyCache.loadedAt < CACHE_MS) return policyCache.policy;
  let policy = DEFAULT_AUTOMATION_POLICY;
  if (isTursoConfigured) {
    try {
      const result = await execute("SELECT value_json FROM site_settings WHERE key='automation_policy'");
      if (result.rows.length) policy = parseJson(rowText(result.rows[0], 'value_json'), DEFAULT_AUTOMATION_POLICY);
    } catch { /* fall back to defaults */ }
  }
  policyCache = { policy, loadedAt: Date.now() };
  return policy;
}

export function resetEngineCaches() {
  configCache = null;
  policyCache = null;
}

/** Load the per-device engine context (state, transition times, duplicate keys). */
export async function loadEngineContext(deviceId: string, now = Date.now()): Promise<FloodEngineContext> {
  const fallback = emptyEngineContext('NORMAL', now);
  if (!isTursoConfigured) return fallback;
  const device = await execute('SELECT current_state FROM devices WHERE id=?', [deviceId]);
  if (!device.rows.length) return fallback;
  const state = normalizeEngineState(rowText(device.rows[0], 'current_state', 'NORMAL'));
  const events = await execute('SELECT state,event_key,created_at FROM flood_events WHERE device_id=? ORDER BY created_at DESC LIMIT 20', [deviceId]);
  let lastTransitionAt = now;
  let recoveryEnteredAt = 0;
  const recentEventKeys: Record<string, number> = {};
  for (const raw of events.rows) {
    const row = raw as Record<string, unknown>;
    const at = new Date(rowText(row, 'created_at')).getTime();
    lastTransitionAt = at;
    const eventState = rowText(row, 'state');
    if (eventState === 'RECOVERY' && !recoveryEnteredAt) recoveryEnteredAt = at;
    const key = rowText(row, 'event_key');
    if (key && !(key in recentEventKeys)) recentEventKeys[key] = at;
  }
  const lastSample = await execute('SELECT level_cm,created_at FROM telemetry WHERE device_id=? ORDER BY seq DESC LIMIT 1', [deviceId]);
  const lastLevelCm = lastSample.rows.length ? rowNumber(lastSample.rows[0], 'level_cm') : null;
  const lastSampleAt = lastSample.rows.length ? new Date(rowText(lastSample.rows[0], 'created_at')).getTime() : 0;
  return { state, lastTransitionAt, recoveryEnteredAt, lastSampleAt, lastLevelCm, recentEventKeys };
}

function normalizeEngineState(value: string): FloodEngineState {
  const normalized = normalizeFloodState(value, 'NORMAL');
  if (normalized === 'UNKNOWN' || normalized === 'FAULT') return 'NORMAL';
  return normalized as FloodEngineState;
}

/**
 * Count independent sensors in the same zone whose latest sample within the
 * confirmation window reaches at least the severity of `state`.
 */
export async function confirmingSensorCount(zoneId: string, state: FloodEngineState, now: number, windowSeconds: number): Promise<number> {
  if (!isTursoConfigured) return 1;
  const since = new Date(now - windowSeconds * 1000).toISOString();
  const severity: Record<string, number> = { NORMAL: 0, RECOVERY: 1, WATCH: 2, WARNING: 3, CRITICAL: 4 };
  const need = severity[state] ?? 0;
  const qualifyingStates = Object.keys(severity).filter((key) => severity[key]! >= need).map((key) => `'${key}'`).join(',');
  const qualifying = await execute(
    `SELECT COUNT(DISTINCT t.device_id) AS count FROM telemetry t
     JOIN devices d ON d.id=t.device_id
     WHERE d.zone_id=? AND d.approval_state='APPROVED' AND t.created_at>=?
       AND t.state IN (${qualifyingStates || "''"})`,
    [zoneId, since],
  );
  return Math.max(1, rowNumber(qualifying.rows[0] || {}, 'count', 1));
}

export interface EngineEvaluationInput {
  tenantId: string;
  zoneId: string;
  deviceId: string;
  levelCm: number | null;
  sensorHealthy: boolean;
  emergencyStopActive: boolean;
  reportedBarrier?: string;
  reportedState?: FloodState;
  now?: number;
  simulation?: boolean;
}

export interface EngineEvaluationResult {
  state: FloodState;
  engineState: FloodEngineState;
  changed: boolean;
  event: FloodEngineEvent | null;
  duplicateSuppressed: boolean;
  barrierPolicy: 'RAISE' | 'LOWER' | 'HOLD';
  barrierReason: string;
  floodEventId: string | null;
  commandId: string | null;
}

export function eventTitleFor(state: string): [string, string] {
  return ({
    NORMAL: ['Conditions returned to NORMAL', 'Water level is back below the watch threshold and the recovery cooldown has completed.'],
    RECOVERY: ['Recovery in progress', 'Water level is receding. The state will return to NORMAL after the recovery cooldown below the recovery threshold.'],
    WATCH: ['WATCH threshold reached', 'Water level is in the watch band. Monitor local conditions and prepare the barrier.'],
    WARNING: ['WARNING threshold reached', 'Water level or rate of rise is high. The perimeter barrier policy is active.'],
    CRITICAL: ['CRITICAL threshold reached', 'Water level or rate of rise is critical. The barrier stays raised and latched.'],
    UNKNOWN: ['Sensor reading UNKNOWN', 'Sensor fault or stale reading; hold the last safe position.'],
    FAULT: ['System entered FAULT', 'Actuation is inhibited pending local inspection.'],
  } as Record<string, [string, string]>)[state] || ['Telemetry received', 'New device telemetry has been stored.'];
}

/**
 * Evaluate one telemetry sample against the flood engine and persist everything
 * the workflow requires: telemetry row is written by the caller, this function
 * handles the event, notifications, automation and audit trail.
 */
export async function evaluateAndRecord(input: EngineEvaluationInput): Promise<EngineEvaluationResult> {
  const now = input.now ?? Date.now();
  const config = await resolveEngineConfig();
  const policy = await resolveAutomationPolicy();
  const context = await loadEngineContext(input.deviceId, now);

  // Health states short-circuit the engine but still update device health.
  if (!input.sensorHealthy || input.levelCm === null) {
    return {
      state: 'UNKNOWN', engineState: context.state, changed: false, event: null, duplicateSuppressed: false,
      barrierPolicy: 'HOLD', barrierReason: 'Sensor unavailable; local fail-safe holds the barrier.',
      floodEventId: null, commandId: null,
    };
  }
  if (input.emergencyStopActive) {
    return {
      state: 'FAULT', engineState: context.state, changed: false, event: null, duplicateSuppressed: false,
      barrierPolicy: 'HOLD', barrierReason: 'Emergency stop active; actuation inhibited.',
      floodEventId: null, commandId: null,
    };
  }

  const rate = rateOfRiseCmPerMin(context.lastLevelCm, context.lastSampleAt, input.levelCm, now);
  const confirmingSensors = await confirmingSensorCount(input.zoneId, context.state, now, config.multiSensorWindowSeconds);
  const evaluation = evaluateFloodEngine(context, {
    levelCm: input.levelCm,
    rateOfRiseCmPerMin: rate,
    sensorHealthy: true,
    confirmingSensors,
    now,
  }, config);
  const nextContext = advanceEngineContext(context, evaluation, {
    levelCm: input.levelCm, rateOfRiseCmPerMin: rate, sensorHealthy: true, confirmingSensors, now,
  }, config);
  void nextContext;

  let floodEventId: string | null = null;
  let commandId: string | null = null;

  if (evaluation.changed || evaluation.event) {
    const suppressed = evaluation.changed && !evaluation.event;
    floodEventId = randomId();
    const [title, message] = eventTitleFor(evaluation.state);
    const defaultSeverity = evaluation.state === 'CRITICAL' ? 'CRITICAL'
      : evaluation.state === 'RECOVERY' ? 'RECOVERY'
        : evaluation.state === 'NORMAL' ? 'INFO' : 'WARNING';
    const reason = evaluation.event?.reason
      || (suppressed ? 'Transition recorded without notification (duplicate suppressed).' : 'State transition recorded.');
    await execute(
      `INSERT INTO flood_events(id,tenant_id,zone_id,device_id,event_key,previous_state,state,severity,level_cm,rate_of_rise_cm_min,reason,duplicate_suppressed,simulation,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        floodEventId, input.tenantId, input.zoneId, input.deviceId,
        evaluation.event?.key || `${evaluation.state}:transition`,
        context.state, evaluation.state, evaluation.event?.severity || defaultSeverity,
        input.levelCm, Math.round(rate * 100) / 100, reason,
        suppressed ? 1 : 0, input.simulation ? 1 : 0, new Date(now).toISOString(),
      ],
    );
    await insertAudit({
      tenantId: input.tenantId,
      action: 'FLOOD_STATE_TRANSITION',
      targetType: 'device',
      targetId: input.deviceId,
      metadata: {
        floodEventId, from: context.state, to: evaluation.state, levelCm: input.levelCm,
        rateOfRiseCmPerMin: Math.round(rate * 100) / 100, duplicateSuppressed: suppressed,
        simulation: Boolean(input.simulation), title, message,
      },
    });

    if (evaluation.event && !suppressed) {
      await dispatchFloodEvent({
        event: evaluation.event, tenantId: input.tenantId, zoneId: input.zoneId, deviceId: input.deviceId,
        levelCm: input.levelCm, policy, simulation: Boolean(input.simulation),
      });
    }

    // Barrier automation (real deployments only; simulation never commands hardware).
    if (!input.simulation && evaluation.barrierPolicy !== 'HOLD') {
      const shouldRaise = evaluation.barrierPolicy === 'RAISE'
        && ((evaluation.state === 'WARNING' && policy.autoBarrierOnWarning) || (evaluation.state === 'CRITICAL' && policy.autoBarrierOnCritical));
      const shouldLower = evaluation.barrierPolicy === 'LOWER' && policy.autoLowerOnRecovery;
      if (shouldRaise || shouldLower) {
        const action: CommandAction = shouldRaise ? 'BARRIER_RAISE' : 'BARRIER_LOWER';
        try {
          const command = await createBarrierCommand({
            deviceId: input.deviceId, action, requestedBy: null, tenantId: input.tenantId,
          });
          commandId = command.id;
          await insertAudit({
            tenantId: input.tenantId,
            action: 'FLOOD_AUTOMATION_COMMAND',
            targetType: 'device',
            targetId: input.deviceId,
            metadata: { commandId: command.id, action, floodEventId, barrierReason: evaluation.barrierReason },
          });
        } catch { /* automation must never block telemetry ingestion */ }
      }
    }
  }

  return {
    state: evaluation.state as FloodState,
    engineState: evaluation.state,
    changed: evaluation.changed,
    event: evaluation.event,
    duplicateSuppressed: evaluation.changed && !evaluation.event,
    barrierPolicy: evaluation.barrierPolicy,
    barrierReason: evaluation.barrierReason,
    floodEventId,
    commandId,
  };
}

async function dispatchFloodEvent(input: {
  event: FloodEngineEvent;
  tenantId: string;
  zoneId: string;
  deviceId: string;
  levelCm: number | null;
  policy: AutomationPolicy;
  simulation: boolean;
}) {
  const { event, policy } = input;
  const [title, body] = eventTitleFor(event.state);
  const severity = event.severity;

  const channels: Array<'EMAIL' | 'SMS' | 'WEB_PUSH'> = [];
  if (severity === 'CRITICAL') {
    if (policy.notifyEmailOnCritical) channels.push('EMAIL');
    if (policy.notifySmsOnCritical) channels.push('SMS');
    channels.push('WEB_PUSH');
  } else if (severity === 'WARNING') {
    if (policy.notifySmsOnCritical) channels.push('SMS');
    if (policy.notifyPushOnWarning) channels.push('WEB_PUSH');
    channels.push('EMAIL');
  } else if (severity === 'RECOVERY') {
    if (policy.notifyOnRecovery) channels.push('WEB_PUSH');
    channels.push('EMAIL');
  } else {
    channels.push('WEB_PUSH');
  }

  // In-app notifications for every signed-in user subscribed to this zone's city.
  try {
    const users = await execute(
      `SELECT u.id FROM users u
       JOIN cities c ON (u.city_id=c.id OR u.city_id IS NULL)
       JOIN zones z ON z.city_id=c.id
       WHERE z.id=? AND u.disabled_at IS NULL AND u.notification_prefs_json LIKE '%\"floodAlerts\":true%'`,
      [input.zoneId],
    );
    for (const raw of users.rows) {
      await execute(
        'INSERT INTO in_app_notifications(id,user_id,kind,severity,title,body,link,created_at) VALUES(?,?,?,?,?,?,?,?)',
        [randomId(), rowText(raw, 'id'), 'FLOOD_EVENT', severity, title, body, '/alerts', new Date(event.at).toISOString()],
      );
    }
  } catch { /* in-app delivery is best-effort */ }

  // External channels through the outbox (queue/retry; never blocks ingestion).
  try {
    const recipients = await execute(
      `SELECT * FROM subscriptions WHERE tenant_id=? AND zone_id=? AND unsubscribed_at IS NULL
        AND (verified_at IS NOT NULL OR phone_verified_at IS NOT NULL OR push_endpoint IS NOT NULL)`,
      [input.tenantId, input.zoneId],
    );
    for (const raw of recipients.rows) {
      const recipient = raw as Record<string, unknown>;
      const subscriptionId = rowText(recipient, 'id');
      const targets: Array<{ channel: 'EMAIL' | 'SMS' | 'WEB_PUSH'; recipient: string }> = [];
      const email = rowText(recipient, 'email');
      const phone = rowText(recipient, 'phone');
      const pushEndpoint = rowText(recipient, 'push_endpoint');
      if (email && rowText(recipient, 'verified_at') && channels.includes('EMAIL')) targets.push({ channel: 'EMAIL', recipient: email });
      if (phone && rowText(recipient, 'phone_verified_at') && channels.includes('SMS')) targets.push({ channel: 'SMS', recipient: phone });
      if (pushEndpoint && channels.includes('WEB_PUSH')) targets.push({ channel: 'WEB_PUSH', recipient: subscriptionId });
      for (const target of targets) {
        let payload: string;
        if (target.channel === 'SMS') {
          const unsubscribeToken = createSmsUnsubscribeToken(subscriptionId);
          const origin = process.env.PUBLIC_APP_URL;
          const unsubscribeUrl = origin ? `${origin.replace(/\/$/, '')}/api/notifications/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}` : null;
          if (!unsubscribeUrl) continue;
          payload = JSON.stringify({ title, body, zoneId: input.zoneId, levelCm: input.levelCm, unsubscribeUrl });
        } else {
          payload = JSON.stringify({ title, body, zoneId: input.zoneId, levelCm: input.levelCm, url: '/alerts', tag: `flood-${event.key}` });
        }
        const dedupeKey = `flood:${input.event.key}:${target.channel}:${subscriptionId}`;
        await execute(
          `INSERT INTO outbox_events(id,dedupe_key,tenant_id,zone_id,channel,recipient,payload_json,status,attempts,next_attempt_at,created_at)
           VALUES(?,?,?,?,?,?,?,'PENDING',0,?,?) ON CONFLICT(dedupe_key) DO NOTHING`,
          [randomId(), dedupeKey, input.tenantId, input.zoneId, target.channel, target.recipient, payload, new Date(event.at).toISOString(), new Date(event.at).toISOString()],
        );
      }
    }
  } catch { /* fan-out is best-effort; the flood_events row is already persisted */ }
}
