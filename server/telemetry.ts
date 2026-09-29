import { z } from 'zod';
import { config } from './config.js';
import {
  currentTimestamp, execute, getFeatureFlag, getSiteSetting, insertAudit, primaryTenantId, queryAll, queryOne,
  randomId, rowBoolean, rowNullableNumber, rowNumber, rowText, turso,
} from './database.js';
import { candidateForLevel, evaluateFlood, thresholdForState, type FloodPolicy, type FloodStateName } from '../shared/flood-engine.js';
import type { DeviceRecord } from './devices.js';
import { issueBarrierCommand } from './commands.js';
import { fanOutFloodEvent } from './notifications.js';

/**
 * Telemetry ingestion pipeline.
 *
 * validate -> authenticate -> replay check -> rate of rise -> policy evaluation
 * -> persist telemetry -> persist flood event (duplicate protected) -> command
 * barrier per policy -> queue notifications.
 *
 * Notification delivery happens in the background worker, so a slow SMTP or SMS
 * provider can never delay or fail telemetry ingestion.
 */

export const telemetrySchema = z.object({
  deviceId: z.string().min(3).max(64),
  uid: z.string().min(3).max(64).optional(),
  seq: z.number().int().nonnegative().max(4_294_967_295),
  levelCm: z.number().finite().min(0).max(2000),
  rateCmPerMin: z.number().finite().min(-1000).max(1000).optional(),
  rainfallMm: z.number().finite().min(0).max(2000).optional(),
  sensorHealthy: z.boolean().optional().default(true),
  state: z.enum(['NORMAL', 'WATCH', 'WARNING', 'CRITICAL', 'RECOVERY']).optional(),
  barrierState: z.enum(['DOWN', 'RAISING', 'RAISED', 'FAULT', 'HOLD']).optional(),
  limitSwitchLow: z.boolean().optional(),
  limitSwitchHigh: z.boolean().optional(),
  emergencyStopActive: z.boolean().optional().default(false),
  faultState: z.enum(['NONE', 'SENSOR_FAULT', 'ACTUATOR_FAULT', 'LIMIT_SWITCH_FAULT', 'COMMS_FAULT', 'POWER_FAULT']).optional(),
  rssi: z.number().int().min(-120).max(0).optional(),
  batteryMv: z.number().int().min(0).max(20000).optional(),
  uptimeSeconds: z.number().int().nonnegative().max(2_000_000_000).optional(),
  firmwareVersion: z.string().max(40).optional(),
  timestamp: z.string().datetime().optional(),
  simulated: z.boolean().optional().default(false),
});

export type TelemetryInput = z.infer<typeof telemetrySchema>;

export interface IngestResult {
  accepted: true;
  seq: number;
  state: FloodStateName;
  previousState: FloodStateName;
  changed: boolean;
  barrier: string;
  levelCm: number;
  rateCmPerMin: number | null;
  eventId: string | null;
  commandId: string | null;
  simulated: boolean;
  reason: string;
}

export class TelemetryError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/**
 * Shortest interval (seconds) used when measuring the rate of rise. Two samples
 * closer together than this are measured as if they were this far apart, so a
 * device that bursts samples cannot report an impossible rise rate.
 */
const MIN_RATE_WINDOW_SECONDS = 5;

export async function getPolicyForZone(tenantId: string, zoneId: string | null): Promise<FloodPolicy & { id: string; name: string }> {
  const row = zoneId
    ? await queryOne('SELECT * FROM flood_policies WHERE tenant_id=? AND zone_id=? AND enabled=1 LIMIT 1', [tenantId, zoneId])
    : null;
  const fallback = await queryOne("SELECT * FROM flood_policies WHERE tenant_id=? AND scope='TENANT' AND enabled=1 LIMIT 1", [tenantId]);
  const source = row || fallback;
  if (!source) {
    return { id: 'built-in', name: 'Built-in default policy', ...builtInPolicy() };
  }
  return {
    id: rowText(source, 'id'),
    name: rowText(source, 'name', 'policy'),
    ...builtInPolicy(),
    normalBelowCm: Number(source.normal_below_cm ?? 18),
    watchCm: Number(source.watch_cm ?? 25),
    warningCm: Number(source.warning_cm ?? 40),
    criticalCm: Number(source.critical_cm ?? 55),
    rateOfRiseCmPerMin: Number(source.rate_of_rise_cm_per_min ?? 6),
    hysteresisCm: Number(source.hysteresis_cm ?? 4),
    recoveryCm: Number(source.recovery_cm ?? 20),
    recoveryHoldSeconds: Number(source.recovery_hold_seconds ?? 300),
    cooldownSeconds: Number(source.cooldown_seconds ?? 120),
    confirmationSamples: Number(source.confirmation_samples ?? 1),
    confirmationWindowSeconds: Number(source.confirmation_window_seconds ?? 180),
    autoBarrierStates: csvStates(rowText(source, 'auto_barrier_states', 'WARNING,CRITICAL')),
    barrierRecoveryState: (rowText(source, 'barrier_recovery_state', 'RECOVERY') as FloodStateName),
  };
}

function csvStates(value: string): FloodStateName[] {
  const allowed: FloodStateName[] = ['NORMAL', 'WATCH', 'WARNING', 'CRITICAL', 'RECOVERY'];
  const parsed = value.split(',').map((item) => item.trim().toUpperCase()).filter((item): item is FloodStateName => allowed.includes(item as FloodStateName));
  return parsed.length ? parsed : ['WARNING', 'CRITICAL'];
}

function builtInPolicy(): FloodPolicy {
  return {
    normalBelowCm: 18, watchCm: 25, warningCm: 40, criticalCm: 55,
    rateOfRiseCmPerMin: 6, hysteresisCm: 4, recoveryCm: 20, recoveryHoldSeconds: 300,
    cooldownSeconds: 120, confirmationSamples: 1, confirmationWindowSeconds: 180,
    autoBarrierStates: ['WARNING', 'CRITICAL'], barrierRecoveryState: 'RECOVERY',
  };
}

async function lastTelemetry(deviceId: string) {
  return queryOne('SELECT level_cm, state, created_at FROM telemetry WHERE device_id=? ORDER BY seq DESC LIMIT 1', [deviceId]);
}

async function lastEventForDevice(deviceId: string) {
  return queryOne('SELECT to_state, created_at FROM flood_events WHERE device_id=? ORDER BY created_at DESC LIMIT 1', [deviceId]);
}

async function recoveryStartedAt(deviceId: string) {
  const row = await queryOne("SELECT created_at FROM flood_events WHERE device_id=? AND to_state='RECOVERY' ORDER BY created_at DESC LIMIT 1", [deviceId]);
  return row ? rowText(row, 'created_at') : null;
}

/**
 * Devices in the same zone with a recent sample at or above the escalation
 * threshold (multi-sensor confirmation).
 */
async function confirmingDevices(zoneId: string | null, excludeDeviceId: string, windowSeconds: number, thresholdCm: number): Promise<number> {
  if (!zoneId) return 0;
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const rows = await queryAll(
    `SELECT COUNT(DISTINCT device_id) AS count FROM telemetry
     WHERE device_id IN (SELECT id FROM devices WHERE zone_id=?) AND device_id<>? AND created_at>=? AND level_cm>=?`,
    [zoneId, excludeDeviceId, since, thresholdCm],
  );
  return Number(rows[0]?.count || 0);
}

/**
 * Consecutive samples from this device at or above the escalation threshold,
 * measured inside the confirmation window. Counting levels (rather than stored
 * states) is what makes multi-sample confirmation converge instead of deadlock.
 */
async function consecutiveElevatedSamples(deviceId: string, windowSeconds: number, thresholdCm: number): Promise<number> {
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const rows = await queryAll(
    'SELECT level_cm FROM telemetry WHERE device_id=? AND created_at>=? ORDER BY seq DESC LIMIT 20',
    [deviceId, since],
  );
  let count = 0;
  for (const row of rows) {
    if (Number(row.level_cm ?? 0) >= thresholdCm) count += 1;
    else break;
  }
  return count;
}

/** The threshold (cm) that a raw level must reach to escalate, before hysteresis. */
function escalationThresholdCm(policy: FloodPolicy, levelCm: number, rateCmPerMin: number): number {
  const candidate = candidateForLevel(levelCm, policy, rateCmPerMin, rateCmPerMin > 0).state;
  return thresholdForState(policy, candidate);
}

/**
 * Rate of rise in cm/min.
 *
 * The controller's own value wins when it reports one: firmware knows its
 * sampling interval and can average locally. Otherwise the rate is measured
 * between the two most recent samples. The interval is floored at
 * MIN_RATE_WINDOW_SECONDS so a burst of very fast samples cannot manufacture an
 * absurd spike, and capped at a day so a long gap does not flatten the rate.
 */
async function computeRateCmPerMin(deviceId: string, levelCm: number, reported: number | undefined): Promise<number | null> {
  if (typeof reported === 'number' && Number.isFinite(reported)) return clampRate(reported);
  const previous = await queryOne('SELECT level_cm, created_at FROM telemetry WHERE device_id=? ORDER BY seq DESC LIMIT 1', [deviceId]);
  if (!previous) return null;
  const previousLevel = rowNullableNumber(previous, 'level_cm');
  if (previousLevel === null) return null;
  const elapsedMinutes = (Date.now() - new Date(rowText(previous, 'created_at')).getTime()) / 60_000;
  if (!Number.isFinite(elapsedMinutes) || elapsedMinutes <= 0) return null;
  const windowMinutes = Math.min(Math.max(elapsedMinutes, MIN_RATE_WINDOW_SECONDS / 60), 24 * 60);
  return clampRate((levelCm - previousLevel) / windowMinutes);
}

/** Keep the stored rate inside the range the telemetry schema accepts. */
function clampRate(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return Math.max(-1000, Math.min(1000, rounded));
}

/**
 * Map legacy/unknown stored states onto the five engine states.
 * 'SAFE' (v1 demo bands) and 'UNKNOWN' both map to NORMAL.
 */
export function normalizeState(value: string): FloodStateName {
  const upper = (value || '').toUpperCase();
  if (upper === 'SAFE' || upper === 'UNKNOWN' || upper === '' || upper === 'FAULT') return 'NORMAL';
  if (upper === 'WATCH' || upper === 'WARNING' || upper === 'CRITICAL' || upper === 'RECOVERY') return upper;
  return 'NORMAL';
}

/**
 * Barrier state for a sample. The controller still reports the physical state;
 * this is what the platform expects and stores when the device does not report it.
 */
function barrierFromEvaluation(
  evaluation: { barrierAction: 'RAISE' | 'LOWER' | 'HOLD'; fault: string | null },
  device: DeviceRecord,
  input: { sensorHealthy: boolean; emergencyStopActive: boolean; barrierState?: string },
): 'DOWN' | 'RAISING' | 'RAISED' | 'FAULT' | 'HOLD' {
  if (input.emergencyStopActive) return 'FAULT';
  if (!input.sensorHealthy) return device.barrierState === 'RAISED' ? 'HOLD' : (device.barrierState as 'DOWN' | 'HOLD' | 'FAULT');
  if (evaluation.barrierAction === 'RAISE') return 'RAISED';
  if (evaluation.barrierAction === 'LOWER') return 'DOWN';
  return device.barrierState === 'RAISED' ? 'RAISED' : 'HOLD';
}

/** libSQL file databases can return SQLITE_BUSY under concurrent writers. */
async function withBusyRetry<T>(operation: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const code = String((error as { code?: string }).code || '');
      const message = (error as Error).message || '';
      if (!code.includes('SQLITE_BUSY') && !message.includes('database is locked')) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 60 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function ingestTelemetry(device: DeviceRecord, input: TelemetryInput): Promise<IngestResult> {
  return withBusyRetry(() => ingestTelemetryOnce(device, input));
}

async function ingestTelemetryOnce(device: DeviceRecord, input: TelemetryInput): Promise<IngestResult> {
  if (!device.enabled) throw new TelemetryError(403, 'This device is disabled.');
  if (device.approvalState !== 'APPROVED' && !device.simulation) {
    throw new TelemetryError(403, 'This device has not been approved yet. Ask an administrator to approve it.');
  }
  if (input.seq <= device.lastSeq) {
    throw new TelemetryError(409, `Sequence number ${input.seq} was already received or is out of order (last ${device.lastSeq}).`);
  }
  if (device.board === 'ESP8266' && (input.state || input.barrierState || input.emergencyStopActive)) {
    throw new TelemetryError(400, 'ESP8266 sender nodes cannot report actuator or emergency-stop state.');
  }

  const previous = await lastTelemetry(device.id);
  const previousLevel = previous ? rowNullableNumber(previous, 'level_cm') : null;
  const rateCmPerMin = await computeRateCmPerMin(device.id, input.levelCm, input.rateCmPerMin);

  const tenantId = device.tenantId;
  const policy = await getPolicyForZone(tenantId, device.zoneId);
  const lastEvent = await lastEventForDevice(device.id);
  const lastTransitionAt = lastEvent ? rowText(lastEvent, 'created_at') : null;
  const previousState = normalizeState(lastEvent ? rowText(lastEvent, 'to_state') : device.currentState);
  const recoveryStart = await recoveryStartedAt(device.id);

  const evaluation = evaluateFlood({
    levelCm: input.levelCm,
    rateCmPerMin: rateCmPerMin ?? 0,
    sensorHealthy: input.sensorHealthy,
    emergencyStopActive: input.emergencyStopActive,
    policy,
    previousState: previousState || 'NORMAL',
    previousLevelCm: previousLevel,
    lastTransitionAt,
    recoveryStartedAt: recoveryStart,
    now: new Date(),
    consecutiveElevatedSamples: await consecutiveElevatedSamples(device.id, policy.confirmationWindowSeconds, escalationThresholdCm(policy, input.levelCm, rateCmPerMin ?? 0)),
    confirmingDevices: await confirmingDevices(device.zoneId, device.id, policy.confirmationWindowSeconds, escalationThresholdCm(policy, input.levelCm, rateCmPerMin ?? 0)),
  });

  const nextState: FloodStateName = evaluation.state;
  const barrier = barrierFromEvaluation(evaluation, device, input);

  const now = currentTimestamp();
  const pointId = randomId();
  const eventId = evaluation.changed ? randomId() : null;
  const eventKey = evaluation.changed ? `${device.id}:${input.seq}:${nextState}` : null;
  const autoCommands = await getFeatureFlag('auto_barrier_commands', true);

  let commandId: string | null = null;
  const tx = await turso.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO telemetry(id,device_id,seq,level_cm,rainfall_mm,rate_cm_per_min,state,barrier_state,sensor_healthy,battery_mv,rssi,simulated,uptime_seconds,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        pointId, device.id, input.seq, input.levelCm, input.rainfallMm ?? null, rateCmPerMin,
        nextState, barrier, input.sensorHealthy ? 1 : 0, input.batteryMv ?? null, input.rssi ?? null,
        input.simulated ? 1 : 0, input.uptimeSeconds ?? null, now,
      ],
    });
    await tx.execute({
      sql: `UPDATE devices SET last_seq=?,last_seen_at=?,last_heartbeat_at=?,current_state=?,barrier_state=?,barrier_latched=?,
              emergency_stop_active=?,signal_dbm=COALESCE(?,signal_dbm),uptime_seconds=COALESCE(?,uptime_seconds),
              fault_state=?,limit_switch_low=?,limit_switch_high=?,firmware_version=COALESCE(?,firmware_version),updated_at=?
            WHERE id=?`,
      args: [
        input.seq, now, now, nextState, barrier,
        barrier === 'RAISED' || barrier === 'RAISING' ? 1 : barrier === 'DOWN' ? 0 : device.barrierLatched ? 1 : 0,
        input.emergencyStopActive ? 1 : 0, input.rssi ?? null, input.uptimeSeconds ?? null,
        input.faultState || (input.sensorHealthy ? 'NONE' : 'SENSOR_FAULT'),
        input.limitSwitchLow ? 1 : 0, input.limitSwitchHigh ? 1 : 0,
        input.firmwareVersion || null, now, device.id,
      ],
    });

    if (evaluation.changed && eventId && eventKey) {
      await tx.execute({
        sql: `INSERT INTO flood_events(id,tenant_id,zone_id,device_id,event_key,from_state,to_state,level_cm,rate_cm_per_min,trigger,reason,simulated,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [
          eventId, tenantId, device.zoneId, device.id, eventKey, evaluation.previousState, nextState,
          input.levelCm, rateCmPerMin, evaluation.rateTriggered ? 'RATE_OF_RISE' : 'THRESHOLD',
          evaluation.reason.slice(0, 500), input.simulated ? 1 : 0, now,
        ],
      });
      await tx.execute({
        sql: 'INSERT INTO audit_logs(id,tenant_id,actor_id,action,target_type,target_id,metadata_json,ip_address,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        args: [
          randomId(), tenantId, null, 'FLOOD_STATE_TRANSITION', 'device', device.id,
          JSON.stringify({ from: evaluation.previousState, to: nextState, levelCm: input.levelCm, rateCmPerMin, reason: evaluation.reason, simulated: input.simulated }),
          null, now,
        ],
      });
    }

    if (evaluation.shouldCommandBarrier && autoCommands && device.board === 'ESP32') {
      // Simulation nodes also receive policy commands so the full workflow can be
      // demonstrated; a simulation node is never physical hardware.
      const command = await issueBarrierCommand({
        tenantId, zoneId: device.zoneId, deviceId: device.id, action: 'RAISE',
        requestedBy: null, requestedByKind: 'POLICY',
        reason: `${input.simulated ? 'SIMULATION: ' : ''}Flood engine raised the barrier: ${evaluation.reason}`.slice(0, 400),
      }, tx);
      commandId = command.commandId;
    }
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    const code = String((error as { code?: string }).code || '');
    const message = (error as Error).message || '';
    const isUnique = code.includes('SQLITE_CONSTRAINT') || message.includes('UNIQUE constraint failed');
    if (isUnique) {
      if (message.includes('telemetry.device_id') || message.includes('telemetry.seq')) {
        throw new TelemetryError(409, 'Duplicate or replayed telemetry sample.');
      }
      throw new TelemetryError(409, 'Duplicate flood event prevented by the event key.');
    }
    throw error;
  }

  // Notifications are queued, never sent inline, so ingestion latency is unaffected.
  if (evaluation.changed && eventId) {
    void fanOutFloodEvent({
      tenantId, zoneId: device.zoneId, eventId, state: nextState, previousState: evaluation.previousState,
      levelCm: input.levelCm, deviceId: device.id, deviceName: device.name, zoneName: await zoneName(device.zoneId),
      reason: evaluation.reason, simulated: input.simulated,
      channels: await policyChannels(),
      notifyRecovery: await policyNotifyRecovery(tenantId, device.zoneId),
    }).catch((error) => console.warn('[floodgrid] flood notification fan-out failed', error));
  }

  return {
    accepted: true, seq: input.seq, state: nextState, previousState: evaluation.previousState,
    changed: evaluation.changed, barrier, levelCm: input.levelCm, rateCmPerMin, eventId, commandId,
    simulated: input.simulated, reason: evaluation.reason,
  };
}

async function zoneName(zoneId: string | null): Promise<string> {
  if (!zoneId) return 'the monitored site';
  const row = await queryOne('SELECT name FROM zones WHERE id=?', [zoneId]);
  return row ? rowText(row, 'name') : 'the monitored site';
}

async function policyChannels(): Promise<Array<'IN_APP' | 'EMAIL' | 'SMS' | 'WEB_PUSH'>> {
  const setting = await getSiteSetting('notify_channels', 'IN_APP,EMAIL,WEB_PUSH');
  const raw = typeof setting === 'string' ? setting : 'IN_APP,EMAIL,WEB_PUSH';
  const allowed = ['IN_APP', 'EMAIL', 'SMS', 'WEB_PUSH'] as const;
  return raw.split(',').map((item) => item.trim().toUpperCase()).filter((item): item is (typeof allowed)[number] => (allowed as readonly string[]).includes(item));
}

async function policyNotifyRecovery(tenantId: string, zoneId: string | null): Promise<boolean> {
  const row = zoneId
    ? await queryOne('SELECT notify_recovery FROM flood_policies WHERE tenant_id=? AND zone_id=? AND enabled=1 LIMIT 1', [tenantId, zoneId])
    : null;
  if (row) return rowBoolean(row, 'notify_recovery');
  return true;
}

export interface HeartbeatInput {
  uptimeSeconds?: number;
  rssi?: number;
  batteryMv?: number;
  firmwareVersion?: string;
  faultState?: string;
  freeHeapBytes?: number;
}

export async function recordHeartbeat(device: DeviceRecord, input: HeartbeatInput) {
  const now = currentTimestamp();
  await execute(
    'UPDATE devices SET last_heartbeat_at=?,last_seen_at=?,uptime_seconds=COALESCE(?,uptime_seconds),signal_dbm=COALESCE(?,signal_dbm),firmware_version=COALESCE(?,firmware_version),fault_state=COALESCE(?,fault_state),updated_at=? WHERE id=?',
    [now, now, input.uptimeSeconds ?? null, input.rssi ?? null, input.firmwareVersion || null, input.faultState || null, now, device.id],
  );
  await insertAudit({
    tenantId: device.tenantId, action: 'DEVICE_HEARTBEAT', targetType: 'device', targetId: device.id,
    metadata: { uptimeSeconds: input.uptimeSeconds ?? null, rssi: input.rssi ?? null, firmwareVersion: input.firmwareVersion || null },
  });
  return { heartbeatAt: now, nextHeartbeatInSeconds: device.heartbeatIntervalSeconds };
}

export { primaryTenantId, queryAll, rowNumber, config };
