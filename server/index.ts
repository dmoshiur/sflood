import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { floodStateForLevel, normalizeFloodState } from '../shared/flood-state.js';
import type { FloodState } from '../shared/flood-state.js';
import {
  connectDatabase, migrateDatabase, getTursoDashboard, getTursoDeviceCredential, getTursoDeviceDetail,
  getTursoDevices, getTursoHistory, getTursoDeviceReadings, ingestTursoTelemetry, isTursoConfigured,
  DatabaseRequestError, execute, randomId, currentTimestamp, rowText, rowBoolean, rowNumber,
} from './database.js';
import { authRouter, ownerRouter, opsRouter, requireSession, requireAdmin, requireCsrf, type AuthUser } from './auth.js';
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

const telemetrySchema = z.object({
  deviceId: z.string().min(3).max(64),
  seq: z.number().int().nonnegative(),
  levelCm: z.number().finite().min(0).max(500),
  distanceCm: z.number().finite().min(0).max(500).optional(),
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

let databaseReady = false;
app.get('/api/health', async (_req, res) => {
  let connected = false;
  if (isTursoConfigured) { try { await connectDatabase(); connected = true; } catch (error) { console.error('[health] Turso health check failed:', error); } }
  const status = connected ? 200 : 503;
  res.status(status).json({ success: connected, status: connected ? 'ok' : 'unavailable', database: connected ? 'connected' : 'disconnected', timestamp: new Date().toISOString() });
});

app.get('/api/health/ready', async (_req, res) => {
  let connected = false;
  if (isTursoConfigured) { try { connected = await connectDatabase(); } catch (error) { console.error('[health/ready] Turso query failed:', error); } }
  res.status(connected && databaseReady ? 200 : 503).json({ ready: connected && databaseReady, database: connected ? 'connected' : 'disconnected', timestamp: new Date().toISOString() });
});

const deviceRegistrationSchema = z.object({ id: z.string().min(3).max(64).regex(/^[a-z0-9][a-z0-9-]+$/), name: z.string().trim().min(2).max(80), kind: z.enum(['ESP32_CONTROLLER', 'ESP8266_SENDER']), zoneId: z.string().min(3).max(64) });
app.post('/api/v1/devices/register', requireSession, requireAdmin, requireCsrf, async (req, res, next) => {
  const parsed = deviceRegistrationSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: { code: 'INVALID_DEVICE', message: parsed.error.issues[0]?.message || 'Invalid device registration.' } }); return; }
  const user = res.locals.authUser as AuthUser;
  try {
    const zone = await execute('SELECT z.id,z.city_id FROM zones z JOIN cities c ON c.id=z.city_id WHERE z.id=? AND c.tenant_id=?', [parsed.data.zoneId, user.tenantId]);
    if (!zone.rows.length) { res.status(404).json({ error: { code: 'ZONE_NOT_FOUND', message: 'Select a zone in your project.' } }); return; }
    const cityId = rowText(zone.rows[0], 'city_id');
    if (user.role === 'ADMIN' && user.cityId && user.cityId !== cityId) { res.status(403).json({ error: 'This device is outside your assigned city.' }); return; }
    const now = currentTimestamp();
    await execute(`INSERT INTO devices(id,tenant_id,city_id,zone_id,name,kind,api_key_hash,firmware_version,enabled,approval_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'unprovisioned',0,'PENDING',?,?)`, [parsed.data.id,user.tenantId,cityId,parsed.data.zoneId,parsed.data.name,parsed.data.kind,'not-provisioned',now,now]);
    await execute('INSERT INTO activity_logs(id,tenant_id,actor_id,device_id,action,details_json,created_at) VALUES(?,?,?,?,?,?,?)', [randomId(),user.tenantId,user.id,parsed.data.id,'DEVICE_REGISTERED',JSON.stringify({kind:parsed.data.kind,zoneId:parsed.data.zoneId}),now]);
    res.status(201).json({ success: true, data: { deviceId: parsed.data.id, approvalState: 'PENDING' } });
  } catch (error) { next(error); }
});

app.get('/api/dashboard', requireSession, async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isTursoConfigured) { res.status(503).json({ error: { code: 'DATABASE_NOT_CONFIGURED', message: 'FloodGuard data is unavailable until Turso is configured.' } }); return; }
  const tenantId = String(res.locals.authUser?.tenantId || '');
  res.json(await getTursoDashboard(tenantId));
});

app.get('/api/history', requireSession, async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const from = typeof req.query.from === 'string' && Number.isFinite(Date.parse(req.query.from)) ? new Date(req.query.from).toISOString() : undefined;
  const to = typeof req.query.to === 'string' && Number.isFinite(Date.parse(req.query.to)) ? new Date(req.query.to).toISOString() : undefined;
  const deviceId = typeof req.query.deviceId === 'string' && req.query.deviceId.length <= 64 ? req.query.deviceId : undefined;
  res.setHeader('Cache-Control', 'no-store');
  if (!isTursoConfigured) { res.status(503).json({ error: { code: 'DATABASE_NOT_CONFIGURED', message: 'Historical telemetry requires a Turso connection.' } }); return; }
  if (from && to && from > to) { res.status(400).json({ error: { code: 'INVALID_DATE_RANGE', message: 'The start date must be before the end date.' } }); return; }
  const history = await getTursoHistory(limit, String(res.locals.authUser?.tenantId || ''), deviceId, from, to);
  res.json({ history });
});

app.get('/api/devices', requireSession, async (_req, res) => {
  if (!isTursoConfigured) { res.status(503).json({ error: { code: 'DATABASE_NOT_CONFIGURED', message: 'Device registry requires a Turso connection.' } }); return; }
  res.json({ devices: await getTursoDevices(String(res.locals.authUser?.tenantId || '')) });
});


app.get('/api/devices/:deviceId/status', requireSession, async (req, res, next) => {
  if (!isTursoConfigured) { res.status(503).json({ error: { code: 'DATABASE_NOT_CONFIGURED', message: 'Device status requires Turso.' } }); return; }
  try {
    const detail = await getTursoDeviceDetail(String(req.params.deviceId), String(res.locals.authUser?.tenantId || ''));
    if (!detail) { res.status(404).json({ error: { code: 'DEVICE_NOT_FOUND', message: 'The requested device does not exist.' } }); return; }
    res.json({ status: detail.device, latestReading: detail.history.at(-1) ?? null });
  } catch (error) { next(error); }
});

app.get('/api/devices/:deviceId/readings', requireSession, async (req, res, next) => {
  if (!isTursoConfigured) { res.status(503).json({ error: { code: 'DATABASE_NOT_CONFIGURED', message: 'Device readings require Turso.' } }); return; }
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const from = typeof req.query.from === 'string' && Number.isFinite(Date.parse(req.query.from)) ? new Date(req.query.from).toISOString() : undefined;
  const to = typeof req.query.to === 'string' && Number.isFinite(Date.parse(req.query.to)) ? new Date(req.query.to).toISOString() : undefined;
  if (from && to && from > to) { res.status(400).json({ error: { code: 'INVALID_DATE_RANGE', message: 'The start date must be before the end date.' } }); return; }
  try {
    const readings = await getTursoDeviceReadings(String(req.params.deviceId), String(res.locals.authUser?.tenantId || ''), limit, from, to);
    if (!readings) { res.status(404).json({ error: { code: 'DEVICE_NOT_FOUND', message: 'The requested device does not exist.' } }); return; }
    res.json({ readings });
  } catch (error) { next(error); }
});

app.get('/api/alerts', requireSession, async (_req, res, next) => {
  if (!isTursoConfigured) { res.status(503).json({ error: { code: 'DATABASE_NOT_CONFIGURED', message: 'Alerts require Turso.' } }); return; }
  try {
    const result = await execute('SELECT id,type,severity,message,device_id,water_level,threshold,acknowledged_at,created_at FROM alerts WHERE tenant_id=? ORDER BY created_at DESC LIMIT 200', [String(res.locals.authUser?.tenantId || '')]);
    res.json({ alerts: result.rows.map((raw) => ({ id: rowText(raw, 'id'), type: rowText(raw, 'type'), severity: rowText(raw, 'severity'), message: rowText(raw, 'message'), deviceId: rowText(raw, 'device_id') || null, waterLevel: rowNumber(raw, 'water_level', NaN), threshold: rowNumber(raw, 'threshold', NaN), acknowledgedAt: rowText(raw, 'acknowledged_at') || null, createdAt: rowText(raw, 'created_at') })) });
  } catch (error) { next(error); }
});

app.post('/api/alerts/:alertId/acknowledge', requireSession, async (req, res, next) => {
  if (!isTursoConfigured) { res.status(503).json({ error: { code: 'DATABASE_NOT_CONFIGURED', message: 'Alert acknowledgement requires Turso.' } }); return; }
  try {
    const user = res.locals.authUser;
    const now = currentTimestamp();
    const updated = await execute('UPDATE alerts SET acknowledged_at=?,acknowledged_by=?,updated_at=? WHERE id=? AND tenant_id=? AND acknowledged_at IS NULL', [now, user.id, now, String(req.params.alertId), user.tenantId]);
    if (!updated.rowsAffected) { res.status(404).json({ error: { code: 'ALERT_NOT_FOUND_OR_ACKNOWLEDGED', message: 'The alert was not found or has already been acknowledged.' } }); return; }
    await execute('INSERT INTO activity_logs(id,tenant_id,actor_id,action,details_json,created_at) VALUES(?,?,?,?,?,?)', [randomId(), user.tenantId, user.id, 'ALERT_ACKNOWLEDGED', JSON.stringify({ alertId: String(req.params.alertId) }), now]);
    res.json({ acknowledged: true, acknowledgedAt: now });
  } catch (error) { next(error); }
});

app.get('/api/devices/:deviceId', requireSession, async (req, res) => {
  if (!isTursoConfigured) { res.status(503).json({ error: { code: 'DATABASE_NOT_CONFIGURED', message: 'Device records require a Turso connection.' } }); return; }
  const detail = await getTursoDeviceDetail(String(req.params.deviceId), String(res.locals.authUser?.tenantId || ''));
  if (!detail) { res.status(404).json({ error: { code: 'DEVICE_NOT_FOUND', message: 'The requested device does not exist.' } }); return; }
  res.json(detail);
});

const telemetryHandler = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
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

  if (!isTursoConfigured) { res.status(503).json({ error: { code: 'DATABASE_NOT_CONFIGURED', message: 'Device telemetry ingestion is unavailable until Turso is configured.' } }); return; }
  try {
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
      distanceCm: parsed.data.distanceCm,
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
    res.status(202).json({ success: true, data: { accepted: true, serverTime: currentTimestamp(), ...result }, accepted: true, ...result, note: 'Telemetry accepted and stored; barrier automation follows the configured policy with local fail-safe priority.' });
    return;
  } catch (error) { next(error); }
};
app.post('/api/v1/telemetry', telemetryLimiter, telemetryHandler);
app.post('/api/v1/devices/:deviceId/telemetry', telemetryLimiter, (req, res, next) => {
  const body = req.body || {};
  const barrier = String(body.barrierState || '').toLowerCase();
  req.body = { ...body, deviceId: req.params.deviceId, levelCm: body.levelCm ?? body.waterLevel, distanceCm: body.distanceCm ?? body.distance, sensorHealthy: body.sensorHealthy ?? (String(body.sensorStatus || '').toLowerCase() === 'ok'), barrierState: ({ closed: 'DOWN', open: 'RAISED', opening: 'RAISING', fault: 'FAULT', hold: 'HOLD' } as Record<string,string>)[barrier] || body.barrierState };
  void telemetryHandler(req, res, next);
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
  if (!isTursoConfigured) { res.status(503).json({ error: 'Notifications require a configured Turso database.' }); return; }
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
    }
    res.status(201).json({ saved: true, zone: zoneLabel, message: 'Browser push is enabled for this zone. You can unsubscribe in the browser or from this device.' });
  } catch (error) { next(error); }
});

app.delete('/api/notifications/push', subscriptionLimiter, async (req, res, next) => {
  const parsed = pushUnsubscribeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'A valid push endpoint is required.' }); return; }
  if (!isTursoConfigured) { res.status(503).json({ error: 'Notifications require a configured Turso database.' }); return; }
  try {
    await execute('UPDATE subscriptions SET unsubscribed_at=? WHERE push_endpoint=? AND unsubscribed_at IS NULL', [currentTimestamp(), parsed.data.endpoint]);
    res.json({ removed: true });
  } catch (error) { next(error); }
});

app.post('/api/notifications/email', subscriptionLimiter, async (req, res, next) => {
  const parsed = emailSubscriptionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'A valid email and explicit consent are required.' }); return; }
  if (!isTursoConfigured) { res.status(503).json({ error: 'Email subscriptions require a configured Turso database.' }); return; }
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
  if (!isTursoConfigured) { res.status(503).type('text').send('Database-backed verification is unavailable.'); return; }
  try {
    const tokenHash = hashToken(token);
    if (isTursoConfigured) {
      const result = await execute('UPDATE subscriptions SET verified_at=?,verification_token_hash=NULL,verification_expires_at=NULL WHERE verification_token_hash=? AND verification_expires_at>? AND unsubscribed_at IS NULL', [currentTimestamp(), tokenHash, currentTimestamp()]);
      if (!result.rowsAffected) { res.status(400).type('text').send('Invalid or expired verification link.'); return; }
    }
    res.status(200).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>FloodGuard email verified</title><main style="font-family:system-ui;padding:2rem;max-width:40rem;margin:auto"><h1>Email confirmed</h1><p>Your opt-in is verified for this project zone. FloodGuard is an educational prototype, not an emergency warning service.</p><a href="/app">Open the dashboard</a></main>');
  } catch (error) { next(error); }
});

app.get('/api/notifications/unsubscribe', async (req, res, next) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (token.length < 32 || token.length > 128) { res.status(400).type('text').send('Invalid unsubscribe link.'); return; }
  if (!isTursoConfigured) { res.status(503).type('text').send('Database-backed unsubscribe is unavailable.'); return; }
  try {
    const tokenHash = hashToken(token);
    if (isTursoConfigured) {
      const result = await execute('UPDATE subscriptions SET unsubscribed_at=?,verification_token_hash=NULL,verification_expires_at=NULL,unsubscribe_token_hash=NULL,phone_verification_token_hash=NULL,phone_verification_expires_at=NULL WHERE unsubscribe_token_hash=? AND unsubscribed_at IS NULL', [currentTimestamp(), tokenHash]);
      if (!result.rowsAffected) { res.status(400).type('text').send('Invalid or already used unsubscribe link.'); return; }
    }
    res.status(200).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>FloodGuard updates stopped</title><main style="font-family:system-ui;padding:2rem;max-width:40rem;margin:auto"><h1>You are unsubscribed</h1><p>No more optional FloodGuard project updates will be sent through this subscription. Emergency alerts are not provided by this educational prototype.</p></main>');
  } catch (error) { next(error); }
});

app.get('/api/firmware/releases', async (_req, res, next) => {
  if (!isTursoConfigured) { res.status(503).json({ error: 'Firmware release metadata requires Turso.' }); return; }
  try { const result = await execute('SELECT version,sha256,size_bytes,asset_url,channel,notes,created_at FROM firmware_releases ORDER BY created_at DESC'); res.json({ releases: result.rows }); } catch (error) { next(error); }
});

app.get('/api/owner/status', async (_req, res, next) => {
  try {
    const maintenanceMode = isTursoConfigured ? (await getTursoDashboard()).maintenanceMode : false;
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
      console.log('Turso connected and schema migrations applied. Register an actual device before expecting telemetry.');
    } catch (error) {
      console.error('[FloodGuard] Turso connection or schema migration failed. Check TURSO_DATABASE_URL, TURSO_AUTH_TOKEN and database permissions.', error);
      process.exitCode = 1;
      return;
    }
  }
  startNotificationWorker();
  const server = app.listen(port, host, () => {
    console.log(`FloodGuard API listening on http://${host}:${port}`);
    console.log('Production data mode: Turso-backed records only; no generated telemetry is enabled.');
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

if (process.env.NODE_ENV !== 'test') void startServer();

export { app, isIpAllowedByCidr, safeEqualHex, hashToken, isTrustedPushEndpoint };
