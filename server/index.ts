import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { barrierForInputs, floodStateForLevel, normalizeFloodState } from '../shared/flood-state.js';
import type { FloodState } from '../shared/flood-state.js';
import type { FloodEvent } from '../shared/types.js';
import { createFreshPreviewStore, currentPreviewState, getPreviewDashboard, makeTelemetryPoint, readStore, writeStore } from './data.js';
import {
  connectDatabase, migrateDatabase, getTursoDashboard, getTursoDeviceCredential, getTursoDeviceDetail,
  getTursoDevices, getTursoHistory, ingestTursoTelemetry, isTursoConfigured,
  DatabaseRequestError, execute, randomId, currentTimestamp, rowText, rowBoolean,
} from './database.js';
import { authRouter, ownerRouter, opsRouter } from './auth.js';
import './admin.js';
import './admin-extra.js';
import { publicRouter, deviceRouter } from './public-api.js';
import { profileRouter } from './profile.js';
import { hashToken, safeEqualHex, isIpAllowedByCidr, isTrustedPushEndpoint } from './http-utils.js';
import { hasCanonicalPublicUrl, notificationConfig, startNotificationWorker } from './notifications.js';
import { sendSms } from './providers.js';
import { createSmsUnsubscribeToken, hashSmsVerificationCode } from './security.js';

const app = express();
const port = Number(process.env.API_PORT || process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDirectory, '..');
const distDirectory = path.join(projectRoot, 'dist');
const apiLimiter = rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false });
const simulatorLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
const telemetryLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false });
const subscriptionLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false });
const smsRecipientLimiter = rateLimit({
  windowMs: 60 * 60_000, limit: 3, standardHeaders: 'draft-8', legacyHeaders: false,
  keyGenerator: (req) => {
    const phone = typeof req.body?.phone === 'string' ? req.body.phone : '';
    return phone ? `sms:${hashToken(phone)}` : `sms-invalid:${ipKeyGenerator(req.ip || 'unknown')}`;
  },
});

app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://res.cloudinary.com; connect-src 'self'; font-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: '16kb', strict: true }));
app.use('/api', apiLimiter);
app.use('/api/auth', authRouter);
app.use('/api/owner', ownerRouter);
app.use('/api/ops', opsRouter);
app.use('/api/profile', profileRouter);
app.use('/api/public', publicRouter);
app.use('/api/v1', deviceRouter);

const simulateSchema = z.object({
  action: z.enum(['rise', 'recede', 'sensor-fault', 'sensor-recovered', 'estop', 'estop-reset', 'reset']),
});
const telemetrySchema = z.object({
  deviceId: z.string().min(3).max(64),
  seq: z.number().int().nonnegative(),
  levelCm: z.number().finite().min(0).max(500),
  rainfallMm: z.number().finite().min(0).max(1000).optional(),
  rateOfRiseCmPerMin: z.number().finite().min(-100).max(100).optional(),
  sensorHealthy: z.boolean().optional().default(true),
  /** Legacy 'SAFE' is accepted and normalized to 'NORMAL' server-side. */
  state: z.enum(['SAFE', 'NORMAL', 'WATCH', 'WARNING', 'CRITICAL', 'RECOVERY', 'UNKNOWN', 'FAULT']).optional(),
  barrierState: z.enum(['DOWN', 'RAISING', 'RAISED', 'FAULT', 'HOLD']).optional(),
  limitSwitchState: z.enum(['OPEN', 'CLOSED', 'UNKNOWN', 'TRAVELING']).optional(),
  emergencyStopActive: z.boolean().optional().default(false),
  rssi: z.number().int().min(-120).max(20).optional(),
  uptimeS: z.number().int().nonnegative().max(4_000_000_000).optional(),
  firmwareVersion: z.string().min(1).max(40).optional(),
  faultState: z.string().max(60).optional(),
  timestamp: z.string().datetime({ offset: true }).optional(),
});

const pushSubscriptionSchema = z.object({
  consent: z.literal(true),
  subscription: z.object({
    endpoint: z.string().url().max(2048).refine(isTrustedPushEndpoint, 'Push endpoint must use HTTPS and a supported browser push service.'),
    keys: z.object({ p256dh: z.string().min(20).max(256), auth: z.string().min(16).max(128) }),
  }),
});
const pushUnsubscribeSchema = z.object({ endpoint: z.string().url().max(2048).refine((value) => value.startsWith('https://')) });
const emailSubscriptionSchema = z.object({ consent: z.literal(true), email: z.string().email().max(254).transform((value) => value.trim().toLowerCase()) });


function isReportedStateConsistent(state: string | undefined, levelCm: number, sensorHealthy: boolean, emergencyStopActive: boolean) {
  const normalized = state === undefined ? undefined : normalizeFloodState(state);
  if (emergencyStopActive) return normalized === 'FAULT';
  if (!sensorHealthy) return normalized === undefined || normalized === 'UNKNOWN';
  if (!normalized) return true;
  if (normalized === 'UNKNOWN' || normalized === 'FAULT') return false;
  // Hysteresis overlap bands: a device report must sit inside the documented overlap.
  const bands: Record<'NORMAL' | 'RECOVERY' | 'WATCH' | 'WARNING' | 'CRITICAL', (level: number) => boolean> = {
    NORMAL: (level) => level < 23,
    RECOVERY: (level) => level < 23,
    WATCH: (level) => level >= 18 && level < 37,
    WARNING: (level) => level >= 33 && level < 52,
    CRITICAL: (level) => level >= 48,
  };
  return bands[normalized as keyof typeof bands](levelCm);
}

function eventForState(state: FloodState, previous: FloodState): FloodEvent | null {
  if (state === previous) return null;
  const createdAt = new Date().toISOString();
  const messages: Record<FloodState, { title: string; message: string }> = {
    NORMAL: { title: 'Level returned to NORMAL', message: 'The simulated reading is below 20 cm. Keep monitoring local conditions.' },
    RECOVERY: { title: 'Recovery in progress', message: 'The simulated level is receding. NORMAL resumes after the recovery cooldown.' },
    WATCH: { title: 'WATCH threshold reached', message: 'Sample water level is 20–34 cm. The buzzer pattern is set to chirp in the demo.' },
    WARNING: { title: 'WARNING threshold reached', message: 'Sample water level is 35–49 cm. Barrier-raise logic is active in simulation.' },
    CRITICAL: { title: 'CRITICAL threshold reached', message: 'Sample water level is 50 cm or higher. The demo barrier remains latched raised.' },
    UNKNOWN: { title: 'Sensor reading UNKNOWN', message: 'A sensor fault was simulated. The barrier holds its last safe position.' },
    FAULT: { title: 'System entered FAULT', message: 'The emergency-stop simulation is active. Actuation is inhibited.' },
  };
  return { id: crypto.randomUUID(), title: messages[state].title, message: messages[state].message, state, createdAt };
}

function appendTelemetry(
  store: ReturnType<typeof readStore>,
  deviceId: string,
  seq: number,
  levelCm: number,
  sensorHealthy: boolean,
  rainfallMm?: number,
  previousStateOverride?: FloodState,
  forcedState?: FloodState,
) {
  const previousState = previousStateOverride ?? currentPreviewState(store);
  let nextState = forcedState ?? (store.emergencyStopActive ? 'FAULT' : sensorHealthy ? floodStateForLevel(levelCm) : 'UNKNOWN');
  // Demonstrate the RECOVERY workflow: receding from an alert state passes
  // through RECOVERY until the level is below the recovery threshold (15 cm).
  if (!forcedState && sensorHealthy && !store.emergencyStopActive && nextState === 'NORMAL'
    && ['WATCH', 'WARNING', 'CRITICAL', 'RECOVERY'].includes(previousState)) {
    nextState = levelCm > 15 ? 'RECOVERY' : 'NORMAL';
    if (previousState === 'RECOVERY' && levelCm > 15) nextState = 'RECOVERY';
  }
  const previousBarrier = store.barrier;

  store.sensorHealthy = sensorHealthy;
  store.levelCm = levelCm;
  if (rainfallMm !== undefined) store.rainfallMm = rainfallMm;
  store.barrier = store.emergencyStopActive
    ? 'FAULT'
    : barrierForInputs({ levelCm, sensorHealthy, emergencyStopActive: false }, previousBarrier, store.barrierLatched);

  if (nextState === 'WARNING' || nextState === 'CRITICAL') {
    store.barrier = 'RAISED';
    store.barrierLatched = true;
  }
  if (nextState === 'UNKNOWN' && previousBarrier === 'RAISED') store.barrier = 'HOLD';
  if (nextState === 'RECOVERY' && (previousBarrier === 'RAISED' || previousBarrier === 'HOLD')) { store.barrier = 'RAISED'; store.barrierLatched = true; }
  if (nextState === 'NORMAL' && previousState === 'RECOVERY') { store.barrier = 'DOWN'; store.barrierLatched = false; }

  const point = makeTelemetryPoint({
    deviceId,
    seq,
    levelCm,
    rainfallMm: rainfallMm ?? null,
    state: nextState,
    sensorHealthy,
  });
  store.history.push(point);
  store.history = store.history.slice(-1000);
  const device = store.devices.find((item) => item.id === deviceId);
  if (device) {
    device.lastSeq = seq;
    device.latestLevelCm = levelCm;
    device.state = nextState;
    device.lastSeenAt = point.createdAt;
  }
  const event = eventForState(nextState, previousState);
  if (event) {
    store.events.unshift(event);
    store.events = store.events.slice(0, 100);
    if (nextState === 'WARNING' || nextState === 'CRITICAL') {
      const notificationPayload = { title: event.title, body: event.message, zone: store.zone, levelCm, url: '/app' };
      for (const subscription of store.pushSubscriptions.filter((item) => item.zone === store.zone)) {
        const dedupeKey = `${deviceId}:${seq}:${nextState}:WEB_PUSH:${hashToken(subscription.endpoint)}`;
        store.outbox.unshift({ id: crypto.randomUUID(), dedupeKey, channel: 'WEB_PUSH', recipient: subscription.endpoint, payload: notificationPayload, status: 'PENDING', attempts: 0, nextAttemptAt: point.createdAt, createdAt: point.createdAt });
      }
      for (const subscription of store.emailSubscriptions.filter((item) => item.zone === store.zone && item.verifiedAt && !item.unsubscribedAt)) {
        const dedupeKey = `${deviceId}:${seq}:${nextState}:EMAIL:${hashToken(subscription.email)}`;
        store.outbox.unshift({ id: crypto.randomUUID(), dedupeKey, channel: 'EMAIL', recipient: subscription.email, payload: notificationPayload, status: 'PENDING', attempts: 0, nextAttemptAt: point.createdAt, createdAt: point.createdAt });
      }
    }
  }
  return { point, previousState, nextState, event };
}

let databaseReady = false;
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'floodguard-api', mode: isTursoConfigured ? 'turso' : 'simulation', databaseReady: databaseReady, now: new Date().toISOString() });
});

app.get('/api/health/ready', async (_req, res) => {
  if (!isTursoConfigured) {
    res.json({ ready: true, mode: 'simulation', note: 'Local simulation mode; no database required.' });
    return;
  }
  res.json({ ready: databaseReady, mode: 'turso', databaseReady });
});

app.get('/api/dashboard', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(isTursoConfigured ? await getTursoDashboard() : getPreviewDashboard(readStore()));
});

app.get('/api/history', async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 36));
  res.setHeader('Cache-Control', 'no-store');
  const history = isTursoConfigured ? await getTursoHistory(limit) : readStore().history.slice(-limit);
  res.json({ history, mode: isTursoConfigured ? 'turso' : 'simulation' });
});

app.get('/api/devices', async (_req, res) => {
  if (isTursoConfigured) { res.json({ devices: await getTursoDevices(), mode: 'turso' }); return; }
  const { devices } = getPreviewDashboard(readStore());
  res.json({ devices, mode: 'simulation' });
});

app.get('/api/devices/:deviceId', async (req, res) => {
  if (isTursoConfigured) {
    const detail = await getTursoDeviceDetail(req.params.deviceId);
    if (!detail) { res.status(404).json({ error: 'Device not found.' }); return; }
    res.json(detail); return;
  }
  const store = readStore();
  const device = store.devices.find((item) => item.id === req.params.deviceId);
  if (!device) { res.status(404).json({ error: 'Device not found.' }); return; }
  const dashboard = getPreviewDashboard(store);
  res.json({ device: dashboard.devices.find((item) => item.id === device.id), history: store.history.filter((point) => point.deviceId === device.id).slice(-80) });
});

app.post('/api/demo/simulate', simulatorLimiter, (req, res, next) => {
  if (isTursoConfigured) { res.status(409).json({ error: 'Simulation controls are disabled when Turso telemetry is active.' }); return; }
  const parsed = simulateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Choose a supported demo simulation action.' }); return; }
  try {
    const store = readStore();
    const currentDevice = store.devices.find((item) => item.id === 'fg-esp32-01');
    if (!currentDevice) { res.status(503).json({ error: 'Demo controller is unavailable.' }); return; }
    const action = parsed.data.action;
    const previousState = currentPreviewState(store);
    if (action === 'reset') {
      const fresh = createFreshPreviewStore();
      writeStore(fresh);
      res.json({ dashboard: getPreviewDashboard(fresh), message: 'The simulation has been reset. No hardware command was sent.' });
      return;
    }

    if (action === 'rise') store.levelCm = Math.min(500, store.levelCm + 5);
    if (action === 'recede') store.levelCm = Math.max(0, store.levelCm - 6);
    if (action === 'sensor-fault') store.sensorHealthy = false;
    if (action === 'sensor-recovered') store.sensorHealthy = true;
    if (action === 'estop') store.emergencyStopActive = true;
    if (action === 'estop-reset') store.emergencyStopActive = false;

    const nextSeq = currentDevice.lastSeq + 1;
    const pointHealthy = store.sensorHealthy;
    const result = appendTelemetry(
      store,
      currentDevice.id,
      nextSeq,
      store.levelCm,
      pointHealthy,
      store.rainfallMm,
      previousState,
      action === 'estop' ? 'FAULT' : undefined,
    );
    if (store.emergencyStopActive) store.barrier = 'FAULT';
    else if (store.barrier === 'FAULT') store.barrier = store.barrierLatched ? 'RAISED' : 'DOWN';
    writeStore(store);
    const message = action === 'estop'
      ? 'E-stop simulated: outputs are marked FAULT. This does not operate a physical switch.'
      : action === 'sensor-fault'
        ? 'Sensor fault simulated: state is UNKNOWN and the barrier holds position.'
        : `${result.nextState} sample stored. No physical barrier or buzzer was operated.`;
    res.json({ dashboard: getPreviewDashboard(store), message });
  } catch (error) { next(error); }
});

app.post('/api/v1/telemetry', telemetryLimiter, async (req, res, next) => {
  const parsed = telemetrySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid telemetry payload.' }); return; }
  const reportedState: FloodState = parsed.data.state
    ? normalizeFloodState(parsed.data.state)
    : (parsed.data.emergencyStopActive ? 'FAULT' : parsed.data.sensorHealthy ? floodStateForLevel(parsed.data.levelCm) : 'UNKNOWN');
  if (isTursoConfigured && !isIpAllowedByCidr(req.ip || req.socket.remoteAddress || '', process.env.DEVICE_CIDR_ALLOWLIST)) {
    res.status(403).json({ error: 'Device-ingest source IP is not in the configured CIDR allowlist.' }); return;
  }
  const authorization = req.header('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token || token.length < 16) { res.status(401).json({ error: 'A device bearer token is required.' }); return; }

  if (isTursoConfigured) {
    const device = await getTursoDeviceCredential(parsed.data.deviceId);
    if (!device || !rowBoolean(device, 'enabled') || !safeEqualHex(hashToken(token), rowText(device, 'api_key_hash'))) { res.status(401).json({ error: 'Device credentials are invalid.' }); return; }
    const isController = rowText(device, 'kind') === 'ESP32_CONTROLLER';
    if (!isController && (parsed.data.state || parsed.data.barrierState || parsed.data.emergencyStopActive)) { res.status(400).json({ error: 'Sender-only devices cannot report actuator or emergency-stop state.' }); return; }
    if (!isReportedStateConsistent(parsed.data.state, parsed.data.levelCm, parsed.data.sensorHealthy, parsed.data.emergencyStopActive)) { res.status(400).json({ error: 'Reported state conflicts with the sensor health or calibrated level.' }); return; }
    if (parsed.data.emergencyStopActive && parsed.data.barrierState && parsed.data.barrierState !== 'FAULT') { res.status(400).json({ error: 'An active E-stop must report actuator state FAULT.' }); return; }
    if (reportedState === 'UNKNOWN' && parsed.data.barrierState && parsed.data.barrierState !== 'HOLD') { res.status(400).json({ error: 'A sensor fault must hold the last actuator position.' }); return; }
    if ((reportedState === 'WARNING' || reportedState === 'CRITICAL') && parsed.data.barrierState && !['RAISED', 'RAISING'].includes(parsed.data.barrierState)) { res.status(400).json({ error: 'WARNING/CRITICAL telemetry cannot report a lowered barrier.' }); return; }
    const result = await ingestTursoTelemetry({
      deviceId: parsed.data.deviceId,
      seq: parsed.data.seq,
      levelCm: parsed.data.levelCm,
      rainfallMm: parsed.data.rainfallMm,
      sensorHealthy: parsed.data.sensorHealthy,
      deviceState: reportedState,
      reportedBarrier: parsed.data.barrierState,
      emergencyStopActive: parsed.data.emergencyStopActive,
      rateOfRiseCmPerMin: parsed.data.rateOfRiseCmPerMin ?? null,
      rssi: parsed.data.rssi ?? null,
      uptimeS: parsed.data.uptimeS ?? null,
      firmwareVersion: parsed.data.firmwareVersion ?? null,
      faultState: parsed.data.faultState ?? null,
      limitSwitchState: parsed.data.limitSwitchState ?? null,
      reportedAt: parsed.data.timestamp ?? null,
    });
    res.status(202).json({ accepted: true, ...result, note: 'Telemetry accepted and stored; barrier automation follows the configured policy with local fail-safe priority.' });
    return;
  }

  try {
    const store = readStore();
    const device = store.devices.find((item) => item.id === parsed.data.deviceId && item.enabled);
    if (!device || !safeEqualHex(hashToken(token), device.apiKeyHash)) { res.status(401).json({ error: 'Device credentials are invalid.' }); return; }
    if (parsed.data.seq <= device.lastSeq) { res.status(409).json({ error: 'Sequence number was already received or is out of order.' }); return; }
    const isController = device.kind === 'ESP32 controller';
    if (!isController && (parsed.data.state || parsed.data.barrierState || parsed.data.emergencyStopActive)) { res.status(400).json({ error: 'Sender-only devices cannot report actuator or emergency-stop state.' }); return; }
    if (!isReportedStateConsistent(parsed.data.state, parsed.data.levelCm, parsed.data.sensorHealthy, parsed.data.emergencyStopActive)) { res.status(400).json({ error: 'Reported state conflicts with the sensor health or calibrated level.' }); return; }
    if (parsed.data.emergencyStopActive && parsed.data.barrierState && parsed.data.barrierState !== 'FAULT') { res.status(400).json({ error: 'An active E-stop must report actuator state FAULT.' }); return; }
    if (reportedState === 'UNKNOWN' && parsed.data.barrierState && parsed.data.barrierState !== 'HOLD') { res.status(400).json({ error: 'A sensor fault must hold the last actuator position.' }); return; }
    if ((reportedState === 'WARNING' || reportedState === 'CRITICAL') && parsed.data.barrierState && !['RAISED', 'RAISING'].includes(parsed.data.barrierState)) { res.status(400).json({ error: 'WARNING/CRITICAL telemetry cannot report a lowered barrier.' }); return; }
    const previousState = currentPreviewState(store);
    store.emergencyStopActive = parsed.data.emergencyStopActive;
    const result = appendTelemetry(store, device.id, parsed.data.seq, parsed.data.levelCm, parsed.data.sensorHealthy, parsed.data.rainfallMm, previousState, reportedState);
    if (parsed.data.barrierState) store.barrier = parsed.data.barrierState;
    if (parsed.data.barrierState === 'DOWN') store.barrierLatched = false;
    if (store.emergencyStopActive) store.barrier = 'FAULT';
    if (result.nextState === 'WARNING' || result.nextState === 'CRITICAL' || parsed.data.barrierState === 'RAISED' || parsed.data.barrierState === 'RAISING') store.barrierLatched = true;
    writeStore(store);
    res.status(202).json({ accepted: true, seq: result.point.seq, state: result.nextState, barrier: store.barrier, note: 'Telemetry accepted. The server does not issue motor commands.' });
  } catch (error) { next(error); }
});

app.get('/api/notifications/config', async (_req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await notificationConfig());
  } catch (error) { next(error); }
});

app.post('/api/notifications/push', subscriptionLimiter, async (req, res, next) => {
  const parsed = pushSubscriptionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Explicit notification consent and a supported browser push subscription are required.' }); return; }
  try {
    const config = await notificationConfig();
    if (!config.webPushAvailable) { res.status(503).json({ error: 'Web Push is not configured for this deployment.' }); return; }
    const { endpoint, keys } = parsed.data.subscription;
    const consentAt = currentTimestamp();
    let zoneLabel = 'Ward 04 · North Bank';
    if (isTursoConfigured) {
      const deviceResult = await execute('SELECT tenant_id,zone_id FROM devices WHERE enabled=1 ORDER BY created_at LIMIT 1');
      if (!deviceResult.rows.length) { res.status(503).json({ error: 'No zone is configured for notification consent.' }); return; }
      const device = deviceResult.rows[0] as Record<string, unknown>;
      const existing = await execute('SELECT id FROM subscriptions WHERE push_endpoint=?', [endpoint]);
      const id = existing.rows.length ? String((existing.rows[0] as Record<string, unknown>).id) : randomId();
      await execute(`INSERT INTO subscriptions(id,tenant_id,zone_id,push_endpoint,push_p256dh,push_auth,consent_at,verified_at,unsubscribed_at)
        VALUES(?,?,?,?,?,?,?, ?,NULL) ON CONFLICT(push_endpoint) DO UPDATE SET push_p256dh=excluded.push_p256dh,push_auth=excluded.push_auth,zone_id=excluded.zone_id,tenant_id=excluded.tenant_id,consent_at=excluded.consent_at,verified_at=excluded.verified_at,unsubscribed_at=NULL`,
      [id, String(device.tenant_id), String(device.zone_id), endpoint, keys.p256dh, keys.auth, consentAt, consentAt]);
      const zone = await execute('SELECT name FROM zones WHERE id=?', [String(device.zone_id)]);
      if (zone.rows.length) zoneLabel = String((zone.rows[0] as Record<string, unknown>).name);
    } else {
      const store = readStore();
      zoneLabel = store.zone;
      store.pushSubscriptions = store.pushSubscriptions.filter((item) => item.endpoint !== endpoint);
      store.pushSubscriptions.push({ endpoint, p256dh: keys.p256dh, auth: keys.auth, zone: store.zone, consentAt });
      writeStore(store);
    }
    res.status(201).json({ saved: true, zone: zoneLabel, message: 'Browser push is enabled for this zone. You can unsubscribe in the browser or from this device.' });
  } catch (error) { next(error); }
});

app.delete('/api/notifications/push', subscriptionLimiter, async (req, res, next) => {
  const parsed = pushUnsubscribeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'A valid push endpoint is required.' }); return; }
  try {
    if (isTursoConfigured) await execute('UPDATE subscriptions SET unsubscribed_at=? WHERE push_endpoint=? AND unsubscribed_at IS NULL', [currentTimestamp(), parsed.data.endpoint]);
    else {
      const store = readStore();
      store.pushSubscriptions = store.pushSubscriptions.filter((item) => item.endpoint !== parsed.data.endpoint);
      writeStore(store);
    }
    res.json({ removed: true });
  } catch (error) { next(error); }
});

app.post('/api/notifications/email', subscriptionLimiter, async (req, res, next) => {
  const parsed = emailSubscriptionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'A valid email and explicit consent are required.' }); return; }
  try {
    const email = parsed.data.email;
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const verificationHash = hashToken(rawToken);
    const rawUnsubscribeToken = crypto.randomBytes(32).toString('base64url');
    const unsubscribeHash = hashToken(rawUnsubscribeToken);
    const now = currentTimestamp();
    const verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const config = await notificationConfig();
    if (isTursoConfigured && !hasCanonicalPublicUrl()) { res.status(503).json({ error: 'Set PUBLIC_APP_URL to a canonical public HTTPS origin before enabling email confirmation.' }); return; }
    const publicOrigin = process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`;
    const verifyUrl = new URL(`/api/notifications/verify?token=${encodeURIComponent(rawToken)}`, publicOrigin).toString();
    const unsubscribeUrl = new URL(`/api/notifications/unsubscribe?token=${encodeURIComponent(rawUnsubscribeToken)}`, publicOrigin).toString();
    const payload = { title: 'Confirm FloodGuard project updates', body: `Confirm your email for FloodGuard updates: ${verifyUrl}\n\nOpt out later: ${unsubscribeUrl}\n\nEducational prototype only; not an emergency alert service.` };
    if (isTursoConfigured) {
      const deviceResult = await execute('SELECT tenant_id,zone_id FROM devices WHERE enabled=1 ORDER BY created_at LIMIT 1');
      if (!deviceResult.rows.length) { res.status(503).json({ error: 'No zone is configured for email consent.' }); return; }
      const device = deviceResult.rows[0] as Record<string, unknown>;
      const existing = await execute('SELECT id FROM subscriptions WHERE email=? AND zone_id=? AND unsubscribed_at IS NULL LIMIT 1', [email, String(device.zone_id)]);
      const subscriptionId = existing.rows.length ? String((existing.rows[0] as Record<string, unknown>).id) : randomId();
      await execute(`INSERT INTO subscriptions(id,tenant_id,zone_id,email,consent_at,verification_token_hash,verification_expires_at,unsubscribe_token_hash,verified_at,unsubscribed_at)
        VALUES(?,?,?,?,?,?,?,?,NULL,NULL) ON CONFLICT(id) DO UPDATE SET consent_at=excluded.consent_at,verification_token_hash=excluded.verification_token_hash,verification_expires_at=excluded.verification_expires_at,unsubscribe_token_hash=excluded.unsubscribe_token_hash,verified_at=NULL,unsubscribed_at=NULL`,
      [subscriptionId, String(device.tenant_id), String(device.zone_id), email, now, verificationHash, verificationExpiresAt, unsubscribeHash]);
      if (config.emailAvailable) await execute(`INSERT OR IGNORE INTO outbox_events(id,dedupe_key,tenant_id,zone_id,channel,recipient,payload_json,status,attempts,next_attempt_at,created_at)
        VALUES(?,?,?,?,? ,?,?, 'PENDING',0,?,?)`, [randomId(), `email-opt-in:${subscriptionId}:${verificationHash}`, String(device.tenant_id), String(device.zone_id), 'EMAIL', email, JSON.stringify(payload), now, now]);
    } else {
      const store = readStore();
      const existing = store.emailSubscriptions.find((item) => item.email === email && item.zone === store.zone && !item.unsubscribedAt);
      if (existing) { existing.tokenHash = verificationHash; existing.unsubscribeTokenHash = unsubscribeHash; existing.consentAt = now; existing.verifiedAt = null; }
      else store.emailSubscriptions.push({ email, tokenHash: verificationHash, unsubscribeTokenHash: unsubscribeHash, zone: store.zone, consentAt: now, verifiedAt: null, unsubscribedAt: null });
      writeStore(store);
    }
    res.status(202).json({ pending: true, verificationEmailQueued: config.emailAvailable, message: config.emailAvailable ? 'Please check your email and confirm your subscription.' : 'Consent saved as pending. SMTP is not configured, so no confirmation message was sent.' });
  } catch (error) { next(error); }
});

app.post('/api/notifications/sms', subscriptionLimiter, smsRecipientLimiter, async (req, res, next) => {
  const parsed = z.object({ consent: z.literal(true), phone: z.string().regex(/^\+[1-9]\d{7,14}$/) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Explicit consent and an E.164 phone number, such as +8801XXXXXXXXX, are required.' }); return; }
  if (!isTursoConfigured) { res.status(503).json({ error: 'SMS opt-in requires the protected Turso-backed provider setup.' }); return; }
  try {
    const config = await notificationConfig();
    if (!config.smsAvailable) { res.status(503).json({ error: 'SMS opt-in requires an enabled gateway, canonical PUBLIC_APP_URL and a strong SESSION_SECRET.' }); return; }
    const deviceResult = await execute('SELECT tenant_id,zone_id FROM devices WHERE enabled=1 ORDER BY created_at LIMIT 1');
    if (!deviceResult.rows.length) { res.status(503).json({ error: 'No zone is configured for SMS consent.' }); return; }
    const device = deviceResult.rows[0] as Record<string, unknown>;
    const phone = parsed.data.phone;
    const publicAppUrl = process.env.PUBLIC_APP_URL;
    if (!publicAppUrl) { res.status(503).json({ error: 'Set PUBLIC_APP_URL to a canonical public HTTPS origin before enabling SMS opt-in.' }); return; }
    const now = currentTimestamp();
    const existing = await execute('SELECT id,phone_verified_at,phone_verification_token_hash,phone_verification_expires_at FROM subscriptions WHERE phone=? AND zone_id=? AND unsubscribed_at IS NULL LIMIT 1', [phone, String(device.zone_id)]);
    const existingRow = existing.rows.length ? existing.rows[0] as Record<string, unknown> : null;
    if (existingRow?.phone_verified_at) { res.json({ pending: false, verified: true, message: 'This number is already confirmed for this zone; no additional verification message was sent.' }); return; }
    if (existingRow?.phone_verification_token_hash && existingRow.phone_verification_expires_at && new Date(String(existingRow.phone_verification_expires_at)).getTime() - Date.now() > 8 * 60_000) {
      res.status(429).json({ error: 'A verification code was sent recently. Wait at least two minutes before requesting another.' }); return;
    }
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const codeHash = hashSmsVerificationCode(phone, code);
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const subscriptionId = existingRow ? String(existingRow.id) : randomId();
    const unsubscribeToken = createSmsUnsubscribeToken(subscriptionId);
    const unsubscribeHash = hashToken(unsubscribeToken);
    const unsubscribeLink = new URL('/api/notifications/unsubscribe', publicAppUrl);
    unsubscribeLink.searchParams.set('token', unsubscribeToken);
    await execute(`INSERT INTO subscriptions(id,tenant_id,zone_id,phone,consent_at,phone_verified_at,phone_verification_token_hash,phone_verification_expires_at,unsubscribe_token_hash,unsubscribed_at)
      VALUES(?,?,?,?,?,NULL,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET consent_at=excluded.consent_at,phone_verified_at=NULL,phone_verification_token_hash=excluded.phone_verification_token_hash,phone_verification_expires_at=excluded.phone_verification_expires_at,unsubscribe_token_hash=excluded.unsubscribe_token_hash,unsubscribed_at=NULL`,
    [subscriptionId, String(device.tenant_id), String(device.zone_id), phone, now, codeHash, expiresAt, unsubscribeHash]);
    await sendSms(phone, { title: 'FloodGuard opt-in code', body: `Your project-update code is ${code}. It expires in ten minutes. No emergency alert is active.`, unsubscribeUrl: unsubscribeLink.toString() });
    res.status(202).json({ pending: true, message: 'A one-time verification code was sent. Confirm it within ten minutes before any optional project SMS updates can be sent.' });
  } catch (error) { next(error); }
});

app.post('/api/notifications/sms/verify', subscriptionLimiter, async (req, res, next) => {
  const parsed = z.object({ phone: z.string().regex(/^\+[1-9]\d{7,14}$/), code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Enter the same E.164 phone number and the six-digit verification code.' }); return; }
  if (!isTursoConfigured) { res.status(503).json({ error: 'SMS verification requires the protected Turso-backed provider setup.' }); return; }
  try {
    const codeHash = hashSmsVerificationCode(parsed.data.phone, parsed.data.code);
    const result = await execute('UPDATE subscriptions SET phone_verified_at=?,phone_verification_token_hash=NULL,phone_verification_expires_at=NULL WHERE phone=? AND phone_verification_token_hash=? AND phone_verification_expires_at>? AND unsubscribed_at IS NULL', [currentTimestamp(), parsed.data.phone, codeHash, currentTimestamp()]);
    if (!result.rowsAffected) { res.status(400).json({ error: 'That code is invalid or expired. Request a new one.' }); return; }
    res.json({ verified: true, message: 'Phone opt-in verified. SMS updates remain optional; use the unsubscribe link included in each SMS to stop them.' });
  } catch (error) { next(error); }
});

app.get('/api/notifications/verify', async (req, res, next) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (token.length < 32 || token.length > 128) { res.status(400).type('text').send('Invalid or expired verification link.'); return; }
  try {
    const tokenHash = hashToken(token);
    if (isTursoConfigured) {
      const result = await execute('UPDATE subscriptions SET verified_at=?,verification_token_hash=NULL,verification_expires_at=NULL WHERE verification_token_hash=? AND verification_expires_at>? AND unsubscribed_at IS NULL', [currentTimestamp(), tokenHash, currentTimestamp()]);
      if (!result.rowsAffected) { res.status(400).type('text').send('Invalid or expired verification link.'); return; }
    } else {
      const store = readStore();
      const subscription = store.emailSubscriptions.find((item) => item.tokenHash === tokenHash && !item.unsubscribedAt);
      if (!subscription) { res.status(400).type('text').send('Invalid or expired verification link.'); return; }
      subscription.verifiedAt = currentTimestamp(); subscription.tokenHash = ''; writeStore(store);
    }
    res.status(200).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>FloodGuard email verified</title><main style="font-family:system-ui;padding:2rem;max-width:40rem;margin:auto"><h1>Email confirmed</h1><p>Your opt-in is verified for this project zone. FloodGuard is an educational prototype, not an emergency warning service.</p><a href="/app">Open the demo dashboard</a></main>');
  } catch (error) { next(error); }
});

app.get('/api/notifications/unsubscribe', async (req, res, next) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (token.length < 32 || token.length > 128) { res.status(400).type('text').send('Invalid unsubscribe link.'); return; }
  try {
    const tokenHash = hashToken(token);
    if (isTursoConfigured) {
      const result = await execute('UPDATE subscriptions SET unsubscribed_at=?,verification_token_hash=NULL,verification_expires_at=NULL,unsubscribe_token_hash=NULL,phone_verification_token_hash=NULL,phone_verification_expires_at=NULL WHERE unsubscribe_token_hash=? AND unsubscribed_at IS NULL', [currentTimestamp(), tokenHash]);
      if (!result.rowsAffected) { res.status(400).type('text').send('Invalid or already used unsubscribe link.'); return; }
    } else {
      const store = readStore();
      const subscription = store.emailSubscriptions.find((item) => item.unsubscribeTokenHash === tokenHash && !item.unsubscribedAt);
      if (!subscription) { res.status(400).type('text').send('Invalid or already used unsubscribe link.'); return; }
      subscription.unsubscribedAt = currentTimestamp(); subscription.tokenHash = ''; subscription.unsubscribeTokenHash = ''; writeStore(store);
    }
    res.status(200).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>FloodGuard updates stopped</title><main style="font-family:system-ui;padding:2rem;max-width:40rem;margin:auto"><h1>You are unsubscribed</h1><p>No more optional FloodGuard project updates will be sent through this subscription. Emergency alerts are not provided by this educational prototype.</p></main>');
  } catch (error) { next(error); }
});

app.get('/api/firmware/releases', (_req, res) => {
  res.json({ releases: [{ version: '0.1.0-demo', channel: 'demo', sha256: 'not-published', sizeBytes: 0, assetUrl: null, note: 'Firmware binaries are not hosted by this preview.' }] });
});

app.get('/api/owner/status', async (_req, res, next) => {
  try {
    const maintenanceMode = isTursoConfigured ? (await getTursoDashboard()).maintenanceMode : readStore().maintenanceMode;
    const owners = isTursoConfigured ? await execute("SELECT COUNT(*) AS count FROM users WHERE role='OWNER' AND disabled_at IS NULL") : null;
    res.json({ available: isTursoConfigured, databaseReady, ownerCount: owners ? Number((owners.rows[0] as Record<string, unknown>).count || 0) : 0, maintenanceMode, reason: isTursoConfigured ? 'Turso-backed role checks, CSRF sessions, IP allowlisting and authenticator MFA protect privileged routes.' : 'Set Turso credentials and the one-time OWNER_BOOTSTRAP_TOKEN to initialize protected admin access.' });
  } catch (error) { next(error); }
});

if (fs.existsSync(distDirectory)) {
  app.use(express.static(distDirectory, { index: false, maxAge: '1h', setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=3600') }));
  app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(distDirectory, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => res.status(503).type('text').send('Build the FloodGuard frontend with npm run build, or open the Vite dev server on port 5173.'));
}

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));

const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  const candidate = error as { status?: number; type?: string; code?: string; message?: string };
  if (candidate.type === 'entity.too.large') { res.status(413).json({ error: 'Request body exceeds the 16 KB limit.' }); return; }
  if (candidate.type === 'entity.parse.failed') { res.status(400).json({ error: 'Request body must be valid JSON.' }); return; }
  if (error instanceof DatabaseRequestError) { res.status(error.status).json({ error: error.message }); return; }
  if (candidate.code === 'P2002' || candidate.code?.startsWith('SQLITE_CONSTRAINT')) { res.status(409).json({ error: 'Duplicate, conflicting or replayed request.' }); return; }
  console.error('[FloodGuard API]', error);
  res.status(candidate.status && candidate.status < 500 ? candidate.status : 500).json({ error: 'The request could not be completed.' });
};
app.use(errorHandler);

async function startServer() {
  if (isTursoConfigured) {
    try {
      await connectDatabase();
      await migrateDatabase();
      databaseReady = true;
      console.log('Turso connected and schema migrations applied. Run npm run db:seed once to create the demo tenant and sensor nodes.');
    } catch (error) {
      console.error('[FloodGuard] Turso connection or schema migration failed. Check TURSO_DATABASE_URL, TURSO_AUTH_TOKEN and database permissions.', error);
      process.exitCode = 1;
      return;
    }
  }
  startNotificationWorker();
  const server = app.listen(port, host, () => {
    console.log(`FloodGuard API listening on http://${host}:${port}`);
    console.log(isTursoConfigured
      ? 'Turso mode: device telemetry only; remote actuator commands are not exposed.'
      : 'SIMULATION MODE: sample telemetry only; no physical actuator or emergency alert service is connected.');
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

if (process.env.NODE_ENV !== 'test') void startServer();

export { app, appendTelemetry, isIpAllowedByCidr, safeEqualHex, hashToken, isTrustedPushEndpoint };
