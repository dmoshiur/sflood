import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import ipaddr from 'ipaddr.js';
import { z } from 'zod';
import { barrierForInputs, floodStateForLevel } from '../shared/flood-state.js';
import type { FloodState } from '../shared/flood-state.js';
import type { FloodEvent } from '../shared/types.js';
import { createFreshPreviewStore, currentPreviewState, getPreviewDashboard, makeTelemetryPoint, readStore, writeStore } from './data.js';
import {
  connectDatabase, getPostgresDashboard, getPostgresDeviceCredential, getPostgresDeviceDetail,
  getPostgresDevices, getPostgresHistory, ingestPostgresTelemetry, isPostgresConfigured,
  DatabaseRequestError, prisma,
} from './database.js';
import { notificationConfig, startNotificationWorker } from './notifications.js';

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

const simulateSchema = z.object({
  action: z.enum(['rise', 'recede', 'sensor-fault', 'sensor-recovered', 'estop', 'estop-reset', 'reset']),
});
const telemetrySchema = z.object({
  deviceId: z.string().min(3).max(64),
  seq: z.number().int().nonnegative(),
  levelCm: z.number().finite().min(0).max(500),
  rainfallMm: z.number().finite().min(0).max(1000).optional(),
  sensorHealthy: z.boolean().optional().default(true),
  state: z.enum(['SAFE', 'WATCH', 'WARNING', 'CRITICAL', 'UNKNOWN', 'FAULT']).optional(),
  barrierState: z.enum(['DOWN', 'RAISING', 'RAISED', 'FAULT', 'HOLD']).optional(),
  emergencyStopActive: z.boolean().optional().default(false),
});
export function isTrustedPushEndpoint(value: string) {
  try {
    const endpoint = new URL(value);
    const host = endpoint.hostname.toLowerCase().replace(/\.$/, '');
    if (endpoint.protocol !== 'https:' || (endpoint.port && endpoint.port !== '443') || ipaddr.isValid(host)) return false;
    return host === 'fcm.googleapis.com'
      || host === 'android.googleapis.com'
      || host === 'web.push.apple.com'
      || host.endsWith('.push.apple.com')
      || host === 'push.services.mozilla.com'
      || host.endsWith('.push.services.mozilla.com');
  } catch { return false; }
}

const pushSubscriptionSchema = z.object({
  consent: z.literal(true),
  subscription: z.object({
    endpoint: z.string().url().max(2048).refine(isTrustedPushEndpoint, 'Push endpoint must use HTTPS and a supported browser push service.'),
    keys: z.object({ p256dh: z.string().min(20).max(256), auth: z.string().min(16).max(128) }),
  }),
});
const pushUnsubscribeSchema = z.object({ endpoint: z.string().url().max(2048).refine((value) => value.startsWith('https://')) });
const emailSubscriptionSchema = z.object({ consent: z.literal(true), email: z.string().email().max(254).transform((value) => value.trim().toLowerCase()) });

function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function safeEqualHex(a: string, b: string) {
  if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function isIpAllowedByCidr(address: string, list: string | undefined) {
  const cidrs = (list || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!cidrs.length) return false;
  try {
    const client = ipaddr.process(address);
    return cidrs.some((cidr) => {
      try {
        const [range, prefix] = ipaddr.parseCIDR(cidr);
        return client.kind() === range.kind() && client.match(range, prefix);
      } catch { return false; }
    });
  } catch { return false; }
}

function isReportedStateConsistent(state: FloodState | undefined, levelCm: number, sensorHealthy: boolean, emergencyStopActive: boolean) {
  if (emergencyStopActive) return state === 'FAULT';
  if (!sensorHealthy) return state === undefined || state === 'UNKNOWN';
  if (!state) return true;
  if (state === 'UNKNOWN' || state === 'FAULT') return false;
  const bands: Record<'SAFE' | 'WATCH' | 'WARNING' | 'CRITICAL', (level: number) => boolean> = {
    SAFE: (level) => level < 22,
    WATCH: (level) => level >= 18 && level < 37,
    WARNING: (level) => level >= 33 && level < 52,
    CRITICAL: (level) => level >= 48,
  };
  return bands[state](levelCm);
}

function eventForState(state: FloodState, previous: FloodState): FloodEvent | null {
  if (state === previous) return null;
  const createdAt = new Date().toISOString();
  const messages: Record<FloodState, { title: string; message: string }> = {
    SAFE: { title: 'Level returned to SAFE', message: 'The simulated reading is below 20 cm. Keep monitoring local conditions.' },
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
  const nextState = forcedState ?? (store.emergencyStopActive ? 'FAULT' : sensorHealthy ? floodStateForLevel(levelCm) : 'UNKNOWN');
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

let postgresReady = false;
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'floodguard-api', mode: isPostgresConfigured ? 'postgres' : 'simulation', databaseReady: postgresReady, now: new Date().toISOString() });
});

app.get('/api/dashboard', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(isPostgresConfigured ? await getPostgresDashboard() : getPreviewDashboard(readStore()));
});

app.get('/api/history', async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 36));
  res.setHeader('Cache-Control', 'no-store');
  const history = isPostgresConfigured ? await getPostgresHistory(limit) : readStore().history.slice(-limit);
  res.json({ history, mode: isPostgresConfigured ? 'postgres' : 'simulation' });
});

app.get('/api/devices', async (_req, res) => {
  if (isPostgresConfigured) { res.json({ devices: await getPostgresDevices(), mode: 'postgres' }); return; }
  const { devices } = getPreviewDashboard(readStore());
  res.json({ devices, mode: 'simulation' });
});

app.get('/api/devices/:deviceId', async (req, res) => {
  if (isPostgresConfigured) {
    const detail = await getPostgresDeviceDetail(req.params.deviceId);
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
  if (isPostgresConfigured) { res.status(409).json({ error: 'Simulation controls are disabled when PostgreSQL telemetry is active.' }); return; }
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
  const reportedState = parsed.data.state ?? (parsed.data.emergencyStopActive ? 'FAULT' : parsed.data.sensorHealthy ? floodStateForLevel(parsed.data.levelCm) : 'UNKNOWN');
  if (isPostgresConfigured && !isIpAllowedByCidr(req.ip || req.socket.remoteAddress || '', process.env.DEVICE_CIDR_ALLOWLIST)) {
    res.status(403).json({ error: 'Device-ingest source IP is not in the configured CIDR allowlist.' }); return;
  }
  const authorization = req.header('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token || token.length < 16) { res.status(401).json({ error: 'A device bearer token is required.' }); return; }

  if (isPostgresConfigured) {
    const device = await getPostgresDeviceCredential(parsed.data.deviceId);
    if (!device || !device.enabled || !safeEqualHex(hashToken(token), device.apiKeyHash)) { res.status(401).json({ error: 'Device credentials are invalid.' }); return; }
    const isController = device.kind === 'ESP32_CONTROLLER';
    if (!isController && (parsed.data.state || parsed.data.barrierState || parsed.data.emergencyStopActive)) { res.status(400).json({ error: 'Sender-only devices cannot report actuator or emergency-stop state.' }); return; }
    if (!isReportedStateConsistent(parsed.data.state, parsed.data.levelCm, parsed.data.sensorHealthy, parsed.data.emergencyStopActive)) { res.status(400).json({ error: 'Reported state conflicts with the sensor health or calibrated level.' }); return; }
    if (parsed.data.emergencyStopActive && parsed.data.barrierState && parsed.data.barrierState !== 'FAULT') { res.status(400).json({ error: 'An active E-stop must report actuator state FAULT.' }); return; }
    if (reportedState === 'UNKNOWN' && parsed.data.barrierState && parsed.data.barrierState !== 'HOLD') { res.status(400).json({ error: 'A sensor fault must hold the last actuator position.' }); return; }
    if ((reportedState === 'WARNING' || reportedState === 'CRITICAL') && parsed.data.barrierState && !['RAISED', 'RAISING'].includes(parsed.data.barrierState)) { res.status(400).json({ error: 'WARNING/CRITICAL telemetry cannot report a lowered barrier.' }); return; }
    const result = await ingestPostgresTelemetry({ ...parsed.data, deviceState: reportedState, reportedBarrier: parsed.data.barrierState });
    res.status(202).json({ accepted: true, ...result, note: 'Telemetry accepted. The server does not issue motor commands.' });
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

app.get('/api/notifications/config', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(notificationConfig());
});

app.post('/api/notifications/push', subscriptionLimiter, async (req, res) => {
  const parsed = pushSubscriptionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Explicit notification consent and a valid browser subscription are required.' }); return; }
  if (!notificationConfig().webPushAvailable) { res.status(503).json({ error: 'Web Push is not configured for this deployment.' }); return; }
  const { endpoint, keys } = parsed.data.subscription;
  const consentAt = new Date();
  if (isPostgresConfigured && prisma) {
    const device = await prisma.device.findFirst({ where: { enabled: true }, orderBy: { createdAt: 'asc' } });
    if (!device) { res.status(503).json({ error: 'No city zone is configured for notification consent.' }); return; }
    await prisma.subscription.upsert({
      where: { pushEndpoint: endpoint },
      update: { pushP256dh: keys.p256dh, pushAuth: keys.auth, zoneId: device.zoneId, tenantId: device.tenantId, consentAt, verifiedAt: consentAt, unsubscribedAt: null },
      create: { pushEndpoint: endpoint, pushP256dh: keys.p256dh, pushAuth: keys.auth, zoneId: device.zoneId, tenantId: device.tenantId, consentAt, verifiedAt: consentAt },
    });
  } else {
    const store = readStore();
    store.pushSubscriptions = store.pushSubscriptions.filter((item) => item.endpoint !== endpoint);
    store.pushSubscriptions.push({ endpoint, p256dh: keys.p256dh, auth: keys.auth, zone: store.zone, consentAt: consentAt.toISOString() });
    writeStore(store);
  }
  res.status(201).json({ saved: true, zone: isPostgresConfigured ? 'configured zone' : readStore().zone, message: 'Browser push is enabled for this zone. You can unsubscribe in the browser or from this device.' });
});

app.delete('/api/notifications/push', subscriptionLimiter, async (req, res) => {
  const parsed = pushUnsubscribeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'A valid push endpoint is required.' }); return; }
  if (isPostgresConfigured && prisma) {
    await prisma.subscription.updateMany({ where: { pushEndpoint: parsed.data.endpoint, unsubscribedAt: null }, data: { unsubscribedAt: new Date() } });
  } else {
    const store = readStore();
    store.pushSubscriptions = store.pushSubscriptions.filter((item) => item.endpoint !== parsed.data.endpoint);
    writeStore(store);
  }
  res.json({ removed: true });
});

app.post('/api/notifications/email', subscriptionLimiter, async (req, res) => {
  const parsed = emailSubscriptionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'A valid email and explicit consent are required.' }); return; }
  const email = parsed.data.email;
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(rawToken);
  const rawUnsubscribeToken = crypto.randomBytes(32).toString('base64url');
  const unsubscribeTokenHash = hashToken(rawUnsubscribeToken);
  const consentAt = new Date();
  const publicOrigin = process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`;
  const verifyUrl = new URL(`/api/notifications/verify?token=${encodeURIComponent(rawToken)}`, publicOrigin).toString();
  const unsubscribeUrl = new URL(`/api/notifications/unsubscribe?token=${encodeURIComponent(rawUnsubscribeToken)}`, publicOrigin).toString();
  const payload = {
    title: 'Confirm FloodGuard project updates',
    body: `Confirm your email for FloodGuard updates by opening this link: ${verifyUrl}\n\nYou can opt out later: ${unsubscribeUrl}\n\nThis is an educational science-fair prototype, not an emergency alert service. If you did not request this, ignore this message.`,
  };
  if (isPostgresConfigured && prisma) {
    const device = await prisma.device.findFirst({ where: { enabled: true }, orderBy: { createdAt: 'asc' } });
    if (!device) { res.status(503).json({ error: 'No city zone is configured for email consent.' }); return; }
    const existing = await prisma.subscription.findFirst({ where: { email, zoneId: device.zoneId, unsubscribedAt: null } });
    const subscription = existing
      ? await prisma.subscription.update({ where: { id: existing.id }, data: { consentAt, verificationTokenHash: tokenHash, unsubscribeTokenHash, verifiedAt: null, unsubscribedAt: null } })
      : await prisma.subscription.create({ data: { email, tenantId: device.tenantId, zoneId: device.zoneId, consentAt, verificationTokenHash: tokenHash, unsubscribeTokenHash } });
    if (notificationConfig().emailAvailable) {
      await prisma.outboxEvent.create({ data: { dedupeKey: `email-opt-in:${subscription.id}:${tokenHash}`, tenantId: device.tenantId, zoneId: device.zoneId, channel: 'EMAIL', recipient: email, payload, status: 'PENDING' } });
    }
  } else {
    const store = readStore();
    const existing = store.emailSubscriptions.find((item) => item.email === email && item.zone === store.zone && !item.unsubscribedAt);
    if (existing) { existing.tokenHash = tokenHash; existing.unsubscribeTokenHash = unsubscribeTokenHash; existing.consentAt = consentAt.toISOString(); existing.verifiedAt = null; }
    else store.emailSubscriptions.push({ email, tokenHash, unsubscribeTokenHash, zone: store.zone, consentAt: consentAt.toISOString(), verifiedAt: null, unsubscribedAt: null });
    if (notificationConfig().emailAvailable) {
      store.outbox.unshift({ id: crypto.randomUUID(), dedupeKey: `email-opt-in:${hashToken(email)}:${tokenHash}`, channel: 'EMAIL', recipient: email, payload, status: 'PENDING', attempts: 0, nextAttemptAt: consentAt.toISOString(), createdAt: consentAt.toISOString() });
    }
    writeStore(store);
  }
  res.status(202).json({ pending: true, verificationEmailQueued: notificationConfig().emailAvailable, message: notificationConfig().emailAvailable ? 'Please check your email and confirm your subscription.' : 'Consent saved as pending. Email delivery is not configured, so no confirmation was sent.' });
});

app.get('/api/notifications/verify', async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (token.length < 32 || token.length > 128) { res.status(400).type('text').send('Invalid or expired verification link.'); return; }
  const tokenHash = hashToken(token);
  if (isPostgresConfigured && prisma) {
    const subscription = await prisma.subscription.findFirst({ where: { verificationTokenHash: tokenHash, unsubscribedAt: null } });
    if (!subscription) { res.status(400).type('text').send('Invalid or expired verification link.'); return; }
    await prisma.subscription.update({ where: { id: subscription.id }, data: { verifiedAt: new Date(), verificationTokenHash: null } });
  } else {
    const store = readStore();
    const subscription = store.emailSubscriptions.find((item) => item.tokenHash === tokenHash && !item.unsubscribedAt);
    if (!subscription) { res.status(400).type('text').send('Invalid or expired verification link.'); return; }
    subscription.verifiedAt = new Date().toISOString();
    subscription.tokenHash = '';
    writeStore(store);
  }
  res.status(200).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>FloodGuard email verified</title><main style="font-family:system-ui;padding:2rem;max-width:40rem;margin:auto"><h1>Email confirmed</h1><p>Your opt-in is verified for this project zone. FloodGuard is an educational prototype, not an emergency warning service.</p><a href="/app">Open the demo dashboard</a></main>');
});

app.get('/api/notifications/unsubscribe', async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (token.length < 32 || token.length > 128) { res.status(400).type('text').send('Invalid unsubscribe link.'); return; }
  const tokenHash = hashToken(token);
  if (isPostgresConfigured && prisma) {
    const subscription = await prisma.subscription.findFirst({ where: { unsubscribeTokenHash: tokenHash, unsubscribedAt: null } });
    if (!subscription) { res.status(400).type('text').send('Invalid or already used unsubscribe link.'); return; }
    await prisma.subscription.update({ where: { id: subscription.id }, data: { unsubscribedAt: new Date(), verificationTokenHash: null, unsubscribeTokenHash: null } });
  } else {
    const store = readStore();
    const subscription = store.emailSubscriptions.find((item) => item.unsubscribeTokenHash === tokenHash && !item.unsubscribedAt);
    if (!subscription) { res.status(400).type('text').send('Invalid or already used unsubscribe link.'); return; }
    subscription.unsubscribedAt = new Date().toISOString();
    subscription.tokenHash = '';
    subscription.unsubscribeTokenHash = '';
    writeStore(store);
  }
  res.status(200).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>FloodGuard updates stopped</title><main style="font-family:system-ui;padding:2rem;max-width:40rem;margin:auto"><h1>You are unsubscribed</h1><p>No more optional project-update email will be sent to this address. Emergency alerts are not provided by this educational prototype.</p></main>');
});

app.get('/api/firmware/releases', (_req, res) => {
  res.json({ releases: [{ version: '0.1.0-demo', channel: 'demo', sha256: 'not-published', sizeBytes: 0, assetUrl: null, note: 'Firmware binaries are not hosted by this preview.' }] });
});

app.get('/api/owner/status', async (_req, res) => {
  const maintenanceMode = isPostgresConfigured ? (await getPostgresDashboard()).maintenanceMode : readStore().maintenanceMode;
  res.json({ available: false, maintenanceMode, reason: 'OWNER access requires deployment credentials, a verified owner account, and passkey/MFA enrollment. This preview exposes no admin controls.' });
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
  if (candidate.code === 'P2002') { res.status(409).json({ error: 'Duplicate or replayed request.' }); return; }
  console.error('[FloodGuard API]', error);
  res.status(candidate.status && candidate.status < 500 ? candidate.status : 500).json({ error: 'The request could not be completed.' });
};
app.use(errorHandler);

async function startServer() {
  if (isPostgresConfigured) {
    try {
      await connectDatabase();
      postgresReady = true;
      console.log('PostgreSQL connected. Ensure prisma db push and prisma db seed have been run.');
    } catch (error) {
      console.error('[FloodGuard] PostgreSQL connection failed. Check DATABASE_URL.', error);
      process.exitCode = 1;
      return;
    }
  }
  startNotificationWorker();
  const server = app.listen(port, host, () => {
    console.log(`FloodGuard API listening on http://${host}:${port}`);
    console.log(isPostgresConfigured
      ? 'PostgreSQL mode: device telemetry only; remote actuator commands are not exposed.'
      : 'SIMULATION MODE: sample telemetry only; no physical actuator or emergency alert service is connected.');
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

if (process.env.NODE_ENV !== 'test') void startServer();

export { app, appendTelemetry, isIpAllowedByCidr, safeEqualHex, hashToken };
