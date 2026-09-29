/**
 * Owner/admin API extensions: device registry + approval + provisioning, remote
 * barrier commands, flood-engine thresholds, automation policy, feature flags,
 * service areas, schema-driven site content, maintenance/emergency controls and
 * the rotating-credential operations console endpoints.
 */
import crypto from 'node:crypto';
import express from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { ownerRouter, opsRouter, requireCsrf, requireAdmin, requireSession, type AuthUser } from './auth.js';
import {
  DatabaseRequestError, execute, insertAudit, isTursoConfigured, randomId, currentTimestamp,
  rowBoolean, rowNumber, rowText,
} from './database.js';
import { COMMAND_ACTIONS, createBarrierCommand, createCommandSchema, listDeviceCommands } from './commands.js';
import { DEFAULT_FLOOD_ENGINE_CONFIG, type FloodEngineConfig } from '../shared/flood-engine.js';
import { DEFAULT_AUTOMATION_POLICY, resetEngineCaches, resolveAutomationPolicy, resolveEngineConfig } from './flood-engine.js';
import { addServiceArea, listServiceAreas, setServiceAreaEnabled } from './service-areas.js';
import { listRevisions, publishRevision, rollbackToRevision, saveDraft, type ContentRevision } from './content.js';
import {
  ensureCurrentOpsCredential, opsSecurityEmail, revokeOpsSession, readOpsCookie, verifyOpsCode,
  createOpsSession, opsUnlockLimiter, requireOps, setOpsCookie, clearOpsCookie,
} from './ops.js';
import { hashToken } from './http-utils.js';

function authUser(res: express.Response): AuthUser {
  return res.locals.authUser as AuthUser;
}

function jsonSettings(value: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? { ...fallback, ...(parsed as Record<string, unknown>) } : fallback;
  } catch { return fallback; }
}

async function readSetting(key: string, fallback: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!isTursoConfigured) return fallback;
  const result = await execute('SELECT value_json FROM site_settings WHERE key=?', [key]);
  return result.rows.length ? jsonSettings(rowText(result.rows[0], 'value_json'), fallback) : fallback;
}

async function writeSetting(key: string, value: Record<string, unknown>, actorId: string) {
  if (!isTursoConfigured) throw new DatabaseRequestError(503, 'Settings require the database-backed deployment.');
  await execute(
    `INSERT INTO site_settings(key,value_json,updated_by,updated_at) VALUES(?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
    [key, JSON.stringify(value), actorId, currentTimestamp()],
  );
  resetEngineCaches();
}

// ---------------------------------------------------------------------------
// Device registry, approval workflow, provisioning and commands
// ---------------------------------------------------------------------------

const deviceCreateSchema = z.object({
  id: z.string().min(3).max(64).regex(/^[a-z0-9][a-z0-9-]+$/, 'Device UID must be lowercase letters, digits and dashes.'),
  name: z.string().min(2).max(80),
  kind: z.enum(['ESP32_CONTROLLER', 'ESP8266_SENDER']),
  zoneId: z.string().min(3).max(64),
});

ownerRouter.get('/devices', requireAdmin, async (_req, res, next) => {
  try {
    const user = authUser(res);
    const result = await execute(`
      SELECT d.*, z.name AS zone_name, c.name AS city_name, c.id AS city_id,
        (SELECT t.level_cm FROM telemetry t WHERE t.device_id=d.id ORDER BY t.seq DESC LIMIT 1) AS latest_level_cm,
        (SELECT t.state FROM telemetry t WHERE t.device_id=d.id ORDER BY t.seq DESC LIMIT 1) AS latest_state,
        (SELECT t.rssi FROM telemetry t WHERE t.device_id=d.id ORDER BY t.seq DESC LIMIT 1) AS latest_rssi
      FROM devices d JOIN zones z ON z.id=d.zone_id JOIN cities c ON c.id=d.city_id
      WHERE d.tenant_id=? ORDER BY d.created_at ASC`, [user.tenantId]);
    const devices = result.rows
      .map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          id: rowText(row, 'id'),
          name: rowText(row, 'name'),
          kind: rowText(row, 'kind'),
          zoneId: rowText(row, 'zone_id'),
          zoneName: rowText(row, 'zone_name'),
          cityId: rowText(row, 'city_id'),
          cityName: rowText(row, 'city_name'),
          approvalState: rowText(row, 'approval_state', 'APPROVED'),
          enabled: rowBoolean(row, 'enabled'),
          online: rowBoolean(row, 'enabled') && Boolean(rowText(row, 'last_seen_at')) && Date.now() - new Date(rowText(row, 'last_seen_at')).getTime() < 120_000,
          state: rowText(row, 'latest_state', 'UNKNOWN'),
          zone: rowText(row, 'zone_name'),
          firmwareVersion: rowText(row, 'firmware_version'),
          lastSeenAt: rowText(row, 'last_seen_at') || null,
          limitSwitchState: rowText(row, 'limit_switch_state') || null,
          faultState: rowText(row, 'fault_state') || null,
          rateOfRiseCmPerMin: rowNumber(row, 'rate_of_rise_cm_min', 0),
          latestLevelCm: rowNumber(row, 'latest_level_cm', 0) || null,
          latestState: rowText(row, 'latest_state', 'UNKNOWN'),
          hasProvisioningToken: Boolean(rowText(row, 'provisioning_token_hash')),
          provisioningExpiresAt: rowText(row, 'provisioning_expires_at') || null,
        };
      })
      .filter((device) => user.role === 'OWNER' || !user.cityId || device.cityId === user.cityId);
    res.json({ devices });
  } catch (error) { next(error); }
});

ownerRouter.get('/zones', requireAdmin, async (_req, res, next) => {
  const user = authUser(res);
  try {
    const result = await execute('SELECT z.id,z.name,c.name AS city_name FROM zones z JOIN cities c ON c.id=z.city_id WHERE c.tenant_id=? ORDER BY c.name,z.name', [user.tenantId]);
    res.json({ zones: result.rows.map((row) => ({ id: rowText(row, 'id'), name: rowText(row, 'name'), cityName: rowText(row, 'city_name') })) });
  } catch (error) { next(error); }
});

ownerRouter.patch('/devices/:deviceId', requireAdmin, requireCsrf, async (req, res, next) => {
  const parsed = z.object({ name: z.string().trim().min(2).max(80) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Device name must contain 2 to 80 characters.' }); return; }
  const user = authUser(res);
  try {
    const result = await execute('UPDATE devices SET name=?,updated_at=? WHERE id=? AND tenant_id=?', [parsed.data.name, currentTimestamp(), String(req.params.deviceId), user.tenantId]);
    if (!result.rowsAffected) { res.status(404).json({ error: 'Device not found.' }); return; }
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'DEVICE_RENAMED', targetType: 'device', targetId: String(req.params.deviceId), metadata: { name: parsed.data.name }, ipAddress: req.ip });
    res.json({ saved: true, name: parsed.data.name });
  } catch (error) { next(error); }
});

ownerRouter.post('/devices', requireAdmin, requireCsrf, async (req, res, next) => {
  const parsed = deviceCreateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid device payload.' }); return; }
  const user = authUser(res);
  try {
    const zone = await execute('SELECT z.id,z.city_id FROM zones z JOIN cities c ON c.id=z.city_id WHERE z.id=? AND c.tenant_id=?', [parsed.data.zoneId, user.tenantId]);
    if (!zone.rows.length) { res.status(400).json({ error: 'Select an existing zone for the device.' }); return; }
    const cityId = rowText(zone.rows[0], 'city_id');
    if (user.role === 'ADMIN' && user.cityId && user.cityId !== cityId) {
      res.status(403).json({ error: 'Local admins can only register devices inside their assigned city.' });
      return;
    }
    const tenantId = user.tenantId;
    const now = currentTimestamp();
    await execute(
      `INSERT INTO devices(id,tenant_id,city_id,zone_id,name,kind,api_key_hash,firmware_version,enabled,approval_state,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?, 'unprovisioned', 0, 'PENDING', ?, ?)`,
      [parsed.data.id, tenantId, cityId, parsed.data.zoneId, parsed.data.name, parsed.data.kind, 'not-provisioned', now, now],
    );
    await insertAudit({ tenantId, actorId: user.id, action: 'DEVICE_REGISTERED', targetType: 'device', targetId: parsed.data.id, metadata: { kind: parsed.data.kind, zoneId: parsed.data.zoneId, approvalState: 'PENDING' }, ipAddress: req.ip });
    res.status(201).json({ device: { id: parsed.data.id, approvalState: 'PENDING' }, message: 'Device registered and pending approval.' });
  } catch (error) {
    if (String((error as { code?: string }).code || '').includes('SQLITE_CONSTRAINT')) {
      res.status(409).json({ error: 'A device with that UID already exists.' });
      return;
    }
    next(error);
  }
});

ownerRouter.post('/devices/:deviceId/approve', requireAdmin, requireCsrf, async (req, res, next) => {
  const user = authUser(res);
  try {
    const device = await execute('SELECT id,city_id,approval_state FROM devices WHERE id=? AND tenant_id=?', [String(req.params.deviceId), user.tenantId]);
    if (!device.rows.length) { res.status(404).json({ error: 'Device not found.' }); return; }
    const row = device.rows[0] as Record<string, unknown>;
    if (user.role === 'ADMIN' && user.cityId && user.cityId !== rowText(row, 'city_id')) {
      res.status(403).json({ error: 'Local admins can only approve devices inside their assigned city.' }); return;
    }
    await execute("UPDATE devices SET approval_state='APPROVED',approved_at=?,approved_by=?,enabled=1,updated_at=? WHERE id=?", [currentTimestamp(), user.id, currentTimestamp(), String(req.params.deviceId)]);
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'DEVICE_APPROVED', targetType: 'device', targetId: String(req.params.deviceId), ipAddress: req.ip });
    res.json({ approved: true });
  } catch (error) { next(error); }
});

ownerRouter.post('/devices/:deviceId/revoke', requireAdmin, requireCsrf, async (req, res, next) => {
  const user = authUser(res);
  try {
    const device = await execute('SELECT id,city_id FROM devices WHERE id=? AND tenant_id=?', [String(req.params.deviceId), user.tenantId]);
    if (!device.rows.length) { res.status(404).json({ error: 'Device not found.' }); return; }
    const row = device.rows[0] as Record<string, unknown>;
    if (user.role === 'ADMIN' && user.cityId && user.cityId !== rowText(row, 'city_id')) {
      res.status(403).json({ error: 'Local admins can only revoke devices inside their assigned city.' }); return;
    }
    const now = currentTimestamp();
    await execute("UPDATE devices SET approval_state='REVOKED',enabled=0,api_key_hash='revoked',provisioning_token_hash=NULL,provisioning_expires_at=NULL,updated_at=? WHERE id=?", [now, String(req.params.deviceId)]);
    await execute('UPDATE device_credentials SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL', [now, String(req.params.deviceId)]);
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'DEVICE_REVOKED', targetType: 'device', targetId: String(req.params.deviceId), ipAddress: req.ip });
    res.json({ revoked: true, message: 'Device credentials were revoked. Generate a new provisioning token to re-enroll.' });
  } catch (error) { next(error); }
});

ownerRouter.post('/devices/:deviceId/rotate-key', requireAdmin, requireCsrf, async (req, res, next) => {
  const user = authUser(res);
  try {
    const device = await execute('SELECT id,city_id,tenant_id FROM devices WHERE id=? AND tenant_id=?', [String(req.params.deviceId), user.tenantId]);
    if (!device.rows.length) { res.status(404).json({ error: 'Device not found.' }); return; }
    const row = device.rows[0] as Record<string, unknown>;
    if (user.role === 'ADMIN' && user.cityId && user.cityId !== rowText(row, 'city_id')) {
      res.status(403).json({ error: 'Local admins can only rotate keys inside their assigned city.' }); return;
    }
    const newKey = crypto.randomBytes(32).toString('base64url');
    const now = currentTimestamp();
    await execute('UPDATE device_credentials SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL', [now, String(req.params.deviceId)]);
    await execute('INSERT INTO device_credentials(id,device_id,key_hash,label,created_at,created_by) VALUES(?,?,?,?,?,?)', [randomId(), String(req.params.deviceId), hashToken(newKey), 'rotated', now, user.id]);
    await execute('UPDATE devices SET api_key_hash=?,updated_at=? WHERE id=?', [hashToken(newKey), now, String(req.params.deviceId)]);
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'DEVICE_KEY_ROTATED', targetType: 'device', targetId: String(req.params.deviceId), ipAddress: req.ip });
    res.json({ apiKey: newKey, message: 'Store this key now — it is shown only once and never again.' });
  } catch (error) { next(error); }
});

ownerRouter.post('/devices/:deviceId/provision-token', requireAdmin, requireCsrf, async (req, res, next) => {
  const user = authUser(res);
  try {
    const device = await execute('SELECT id,city_id,kind,approval_state FROM devices WHERE id=? AND tenant_id=?', [String(req.params.deviceId), user.tenantId]);
    if (!device.rows.length) { res.status(404).json({ error: 'Device not found.' }); return; }
    const row = device.rows[0] as Record<string, unknown>;
    if (user.role === 'ADMIN' && user.cityId && user.cityId !== rowText(row, 'city_id')) {
      res.status(403).json({ error: 'Local admins can only provision devices inside their assigned city.' }); return;
    }
    if (rowText(row, 'approval_state') !== 'APPROVED') {
      res.status(409).json({ error: 'Approve the device before generating a provisioning token.' }); return;
    }
    const token = crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    await execute('UPDATE devices SET provisioning_token_hash=?,provisioning_expires_at=?,updated_at=? WHERE id=?', [hashToken(token), expiresAt, currentTimestamp(), String(req.params.deviceId)]);
    const origin = (process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
    const payload = JSON.stringify({ v: 1, uid: String(req.params.deviceId), token, endpoint: `${origin}/api/v1` });
    const qrSvg = await QRCode.toString(payload, { type: 'svg', margin: 1, width: 220, errorCorrectionLevel: 'M' });
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'DEVICE_PROVISION_TOKEN_CREATED', targetType: 'device', targetId: String(req.params.deviceId), metadata: { expiresAt }, ipAddress: req.ip });
    res.json({
      provisioningToken: token,
      expiresAt,
      setupPayload: payload,
      qrSvg,
      message: 'This one-time provisioning token is shown only once. It expires in 24 hours and is single-use.',
    });
  } catch (error) { next(error); }
});

ownerRouter.post('/devices/:deviceId/commands', requireAdmin, requireCsrf, async (req, res, next) => {
  const parsed = createCommandSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid command payload.' }); return; }
  const user = authUser(res);
  try {
    const device = await execute('SELECT id,city_id,tenant_id FROM devices WHERE id=? AND tenant_id=?', [String(req.params.deviceId), user.tenantId]);
    if (!device.rows.length) { res.status(404).json({ error: 'Device not found.' }); return; }
    const row = device.rows[0] as Record<string, unknown>;
    if (user.role === 'ADMIN' && user.cityId && user.cityId !== rowText(row, 'city_id')) {
      res.status(403).json({ error: 'Local admins can only command devices inside their assigned city.' }); return;
    }
    if (user.role === 'OPERATOR' && parsed.data.action.startsWith('BARRIER_') && !['BARRIER_HOLD'].includes(parsed.data.action)) {
      res.status(403).json({ error: 'Operators may request HOLD only; barrier raise/lower requires an administrator.' }); return;
    }
    const command = await createBarrierCommand({
      deviceId: String(req.params.deviceId),
      action: parsed.data.action,
      requestedBy: user.id,
      tenantId: rowText(row, 'tenant_id'),
    });
    // The plaintext nonce is sealed for device polling; it is never logged.
    res.status(201).json({
      command: {
        id: command.id, action: command.action, issuedAt: command.issuedAt,
        expiresAt: command.expiresAt, status: command.status,
      },
      message: 'Command queued. Devices pick it up on their next poll and must acknowledge with the nonce before it expires.',
    });
  } catch (error) { next(error); }
});

ownerRouter.get('/devices/:deviceId/commands', requireAdmin, async (req, res, next) => {
  try {
    res.json({ commands: await listDeviceCommands(String(req.params.deviceId)) });
  } catch (error) { next(error); }
});

ownerRouter.get('/flood-events', requireAdmin, async (req, res, next) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  try {
    const user = authUser(res);
    const result = await execute('SELECT * FROM flood_events WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?', [user.tenantId, limit]);
    res.json({
      events: result.rows.map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          id: rowText(row, 'id'),
          deviceId: rowText(row, 'device_id'),
          zoneId: rowText(row, 'zone_id'),
          eventKey: rowText(row, 'event_key'),
          previousState: rowText(row, 'previous_state'),
          state: rowText(row, 'state'),
          severity: rowText(row, 'severity'),
          levelCm: rowNumber(row, 'level_cm', 0) || null,
          rateOfRiseCmPerMin: rowNumber(row, 'rate_of_rise_cm_min', 0),
          reason: rowText(row, 'reason'),
          duplicateSuppressed: rowBoolean(row, 'duplicate_suppressed'),
          simulation: rowBoolean(row, 'simulation'),
          createdAt: rowText(row, 'created_at'),
        };
      }),
    });
  } catch (error) { next(error); }
});

// ---------------------------------------------------------------------------
// Thresholds, automation policy, feature flags
// ---------------------------------------------------------------------------

const engineConfigSchema = z.object({
  watchCm: z.number().min(1).max(400),
  warningCm: z.number().min(1).max(450),
  criticalCm: z.number().min(1).max(500),
  recoveryCm: z.number().min(0).max(400),
  hysteresisCm: z.number().min(0).max(50),
  rateOfRiseWarningCmPerMin: z.number().min(0.1).max(50),
  rateOfRiseCriticalCmPerMin: z.number().min(0.1).max(100),
  recoveryCooldownSeconds: z.number().int().min(0).max(86_400),
  stateCooldownSeconds: z.number().int().min(0).max(3_600),
  duplicateEventWindowSeconds: z.number().int().min(0).max(86_400),
  multiSensorConfirmations: z.number().int().min(1).max(10),
  multiSensorWindowSeconds: z.number().int().min(5).max(3_600),
}).refine((value) => value.warningCm > value.watchCm && value.criticalCm > value.warningCm, {
  message: 'Thresholds must increase: watch < warning < critical.',
}).refine((value) => value.rateOfRiseCriticalCmPerMin > value.rateOfRiseWarningCmPerMin, {
  message: 'The critical rate-of-rise threshold must exceed the warning threshold.',
});

ownerRouter.get('/settings/thresholds', requireAdmin, async (_req, res, next) => {
  try { res.json({ config: await resolveEngineConfig() }); } catch (error) { next(error); }
});

ownerRouter.put('/settings/thresholds', requireAdmin, requireCsrf, async (req, res, next) => {
  const parsed = engineConfigSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid threshold settings.' }); return; }
  const user = authUser(res);
  try {
    await writeSetting('flood_engine_config', parsed.data as unknown as Record<string, unknown>, user.id);
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'FLOOD_THRESHOLDS_UPDATED', targetType: 'settings', targetId: 'flood_engine_config', metadata: parsed.data, ipAddress: req.ip });
    res.json({ saved: true, config: await resolveEngineConfig() });
  } catch (error) { next(error); }
});

const automationSchema = z.object({
  autoBarrierOnWarning: z.boolean(),
  autoBarrierOnCritical: z.boolean(),
  autoLowerOnRecovery: z.boolean(),
  notifyEmailOnCritical: z.boolean(),
  notifySmsOnCritical: z.boolean(),
  notifyPushOnWarning: z.boolean(),
  notifyOnRecovery: z.boolean(),
});

ownerRouter.get('/settings/automation', requireAdmin, async (_req, res, next) => {
  try { res.json({ policy: await resolveAutomationPolicy() }); } catch (error) { next(error); }
});

ownerRouter.put('/settings/automation', requireAdmin, requireCsrf, async (req, res, next) => {
  const parsed = automationSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid automation policy.' }); return; }
  const user = authUser(res);
  try {
    await writeSetting('automation_policy', parsed.data as unknown as Record<string, unknown>, user.id);
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'AUTOMATION_POLICY_UPDATED', targetType: 'settings', targetId: 'automation_policy', metadata: parsed.data, ipAddress: req.ip });
    res.json({ saved: true, policy: await resolveAutomationPolicy() });
  } catch (error) { next(error); }
});

ownerRouter.get('/settings/features', requireAdmin, async (_req, res, next) => {
  try {
    res.json({ flags: await readSetting('feature_flags', { publicStatusPage: true, emailSubscriptions: true, pushNotifications: true, siteEditor: true, deviceProvisioning: true, opsConsole: true }) });
  } catch (error) { next(error); }
});

ownerRouter.put('/settings/features', requireAdmin, requireCsrf, async (req, res, next) => {
  const parsed = z.record(z.string().max(40), z.boolean()).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Feature flags must be a boolean map.' }); return; }
  const user = authUser(res);
  try {
    await writeSetting('feature_flags', parsed.data, user.id);
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'FEATURE_FLAGS_UPDATED', targetType: 'settings', targetId: 'feature_flags', metadata: parsed.data, ipAddress: req.ip });
    res.json({ saved: true, flags: parsed.data });
  } catch (error) { next(error); }
});

// ---------------------------------------------------------------------------
// Maintenance mode + emergency site status
// ---------------------------------------------------------------------------

ownerRouter.post('/maintenance', requireAdmin, requireCsrf, async (req, res, next) => {
  const parsed = z.object({ enabled: z.boolean(), note: z.string().max(500).optional().default('') }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Provide maintenance enabled and an optional note.' }); return; }
  const user = authUser(res);
  try {
    await writeSetting('maintenance_mode', { enabled: parsed.data.enabled }, user.id);
    await execute('INSERT INTO maintenance_events(id,kind,note,created_by,created_at) VALUES(?,?,?,?,?)', [
      randomId(), parsed.data.enabled ? 'MAINTENANCE_ON' : 'MAINTENANCE_OFF', parsed.data.note, user.id, currentTimestamp(),
    ]);
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: parsed.data.enabled ? 'MAINTENANCE_ENABLED' : 'MAINTENANCE_DISABLED', targetType: 'site', targetId: 'maintenance_mode', metadata: { note: parsed.data.note }, ipAddress: req.ip });
    res.json({ saved: true, enabled: parsed.data.enabled });
  } catch (error) { next(error); }
});

ownerRouter.post('/emergency-status', requireAdmin, requireCsrf, async (req, res, next) => {
  const parsed = z.object({ emergency: z.boolean(), message: z.string().max(500).optional().default('') }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Provide emergency state and an optional message.' }); return; }
  const user = authUser(res);
  try {
    await writeSetting('site_status', { emergency: parsed.data.emergency, message: parsed.data.message }, user.id);
    await execute('INSERT INTO maintenance_events(id,kind,note,created_by,created_at) VALUES(?,?,?,?,?)', [
      randomId(), parsed.data.emergency ? 'EMERGENCY_ON' : 'EMERGENCY_OFF', parsed.data.message, user.id, currentTimestamp(),
    ]);
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: parsed.data.emergency ? 'EMERGENCY_STATUS_ON' : 'EMERGENCY_STATUS_OFF', targetType: 'site', targetId: 'site_status', metadata: { message: parsed.data.message }, ipAddress: req.ip });
    res.json({ saved: true, emergency: parsed.data.emergency });
  } catch (error) { next(error); }
});

// ---------------------------------------------------------------------------
// Service areas
// ---------------------------------------------------------------------------

ownerRouter.get('/service-areas', requireAdmin, async (_req, res, next) => {
  try { res.json({ serviceAreas: await listServiceAreas(true) }); } catch (error) { next(error); }
});

ownerRouter.post('/service-areas', requireAdmin, requireCsrf, async (req, res, next) => {
  const parsed = z.object({ countryCode: z.string().length(2), countryName: z.string().min(2).max(80), cityName: z.string().min(2).max(80) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Provide a two-letter country code, country name and city name.' }); return; }
  const user = authUser(res);
  try {
    const area = await addServiceArea(parsed.data);
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'SERVICE_AREA_ADDED', targetType: 'service_area', targetId: area.id, metadata: parsed.data, ipAddress: req.ip });
    res.status(201).json({ serviceArea: area });
  } catch (error) { next(error); }
});

ownerRouter.patch('/service-areas/:areaId', requireAdmin, requireCsrf, async (req, res, next) => {
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Provide enabled true or false.' }); return; }
  const user = authUser(res);
  try {
    await setServiceAreaEnabled(String(req.params.areaId), parsed.data.enabled);
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'SERVICE_AREA_UPDATED', targetType: 'service_area', targetId: String(req.params.areaId), metadata: parsed.data, ipAddress: req.ip });
    res.json({ saved: true });
  } catch (error) { next(error); }
});

// ---------------------------------------------------------------------------
// Schema-driven site content (versioned; publish + rollback)
// ---------------------------------------------------------------------------

function revisionView(revision: ContentRevision) {
  return revision;
}

ownerRouter.get('/content/:slug', requireAdmin, async (req, res, next) => {
  try {
    const locale = typeof req.query.locale === 'string' && req.query.locale === 'bn' ? 'bn' : 'en';
    res.json({ revisions: (await listRevisions(String(req.params.slug), locale)).map(revisionView) });
  } catch (error) { next(error); }
});

const draftSchema = z.object({
  title: z.string().min(1).max(200),
  locale: z.enum(['en', 'bn']).optional().default('en'),
  document: z.unknown(),
});

ownerRouter.post('/content/:slug/draft', requireAdmin, requireCsrf, async (req, res, next) => {
  const parsed = draftSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid draft payload.' }); return; }
  const user = authUser(res);
  try {
    const revision = await saveDraft({
      slug: String(req.params.slug), locale: parsed.data.locale, title: parsed.data.title,
      document: parsed.data.document, createdBy: user.id,
    });
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'CONTENT_DRAFT_SAVED', targetType: 'content', targetId: String(req.params.slug), metadata: { revisionId: revision.id }, ipAddress: req.ip });
    res.status(201).json({ revision: revisionView(revision) });
  } catch (error) { next(error); }
});

const revisionActionSchema = z.object({ revisionId: z.string().min(8).max(64) });

ownerRouter.post('/content/:slug/publish', requireAdmin, requireCsrf, async (req, res, next) => {
  const parsed = revisionActionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Provide the revisionId to publish.' }); return; }
  const user = authUser(res);
  try {
    const revision = await publishRevision(parsed.data.revisionId);
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'CONTENT_PUBLISHED', targetType: 'content', targetId: String(req.params.slug), metadata: { revisionId: revision.id }, ipAddress: req.ip });
    res.json({ revision: revisionView(revision) });
  } catch (error) { next(error); }
});

ownerRouter.post('/content/:slug/rollback', requireAdmin, requireCsrf, async (req, res, next) => {
  const parsed = revisionActionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Provide the revisionId to roll back to.' }); return; }
  const user = authUser(res);
  try {
    const revision = await rollbackToRevision(parsed.data.revisionId, user.id);
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'CONTENT_ROLLBACK', targetType: 'content', targetId: String(req.params.slug), metadata: { revisionId: revision.id, rolledBackTo: parsed.data.revisionId }, ipAddress: req.ip });
    res.json({ revision: revisionView(revision) });
  } catch (error) { next(error); }
});

// ---------------------------------------------------------------------------
// Operations console (rotating credential + deployment info)
// ---------------------------------------------------------------------------

opsRouter.use(requireSession);

opsRouter.get('/status', async (_req, res, next) => {
  try {
    const user = res.locals.authUser as AuthUser | undefined;
    const status = await ensureCurrentOpsCredential();
    res.json({
      opsConsoleAvailable: isTursoConfigured,
      securityMailboxConfigured: Boolean(opsSecurityEmail()),
      credentialRotationMinutes: 60,
      deliveredTo: status.deliveredTo ? `${status.deliveredTo.slice(0, 2)}***` : null,
      sessionActive: Boolean(res.locals.opsSession),
      role: user?.role ?? null,
    });
  } catch (error) { next(error); }
});

opsRouter.post('/unlock', opsUnlockLimiter, async (req, res, next) => {
  const parsed = z.object({ code: z.string().min(12).max(12).regex(/^[A-Z0-9]+$/i) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Enter the 12-character operations code from the security email.' }); return; }
  const user = res.locals.authUser as AuthUser;
  try {
    const result = await verifyOpsCode(parsed.data.code);
    if (!result.ok) {
      await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'OPS_UNLOCK_FAILED', targetType: 'ops', targetId: null, ipAddress: req.ip });
      res.status(401).json({ error: result.reason || 'The operations code is invalid or expired.' });
      return;
    }
    const session = await createOpsSession(user.id, req.ip || null);
    setOpsCookie(req, res, session.token, session.expiresAt);
    await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'OPS_UNLOCKED', targetType: 'ops', targetId: result.credentialId ?? null, ipAddress: req.ip });
    res.json({ unlocked: true, expiresAt: new Date(session.expiresAt).toISOString() });
  } catch (error) { next(error); }
});

opsRouter.post('/lock', requireCsrf, async (req, res, next) => {
  try {
    const token = readOpsCookie(req, res);
    await revokeOpsSession(token);
    clearOpsCookie(res);
    res.json({ locked: true });
  } catch (error) { next(error); }
});

opsRouter.get('/deployment', requireOps, async (_req, res, next) => {
  try {
    const pkg = await import('../package.json', { with: { type: 'json' } }).then((module) => module.default as { name?: string; version?: string }).catch(() => ({ name: 'floodguard', version: '0.0.0' }));
    const migrations = await execute('SELECT version,applied_at FROM schema_migrations ORDER BY version').catch(() => ({ rows: [] as unknown[] }));
    res.json({
      version: pkg.version || '0.0.0',
      name: pkg.name || 'floodguard',
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      mode: isTursoConfigured ? 'turso' : 'unconfigured',
      migrations: migrations.rows.map((raw) => ({ version: rowText(raw, 'version'), appliedAt: rowText(raw, 'applied_at') })),
      featureFlags: await readSetting('feature_flags', {}),
      maintenance: await readSetting('maintenance_mode', { enabled: false }),
      siteStatus: await readSetting('site_status', { emergency: false, message: '' }),
      rollbackNote: 'Roll back by deploying the previous Git revision; migrations are forward-only and additive.',
    });
  } catch (error) { next(error); }
});

opsRouter.get('/audit', requireOps, async (req, res, next) => {
  const limit = Math.min(300, Math.max(1, Number(req.query.limit) || 100));
  try {
    const result = await execute('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?', [limit]);
    res.json({
      audit: result.rows.map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          id: rowText(row, 'id'),
          actorId: rowText(row, 'actor_id') || null,
          action: rowText(row, 'action'),
          targetType: rowText(row, 'target_type'),
          targetId: rowText(row, 'target_id') || null,
          metadata: jsonSettings(rowText(row, 'metadata_json'), {}),
          ipAddress: rowText(row, 'ip_address') || null,
          createdAt: rowText(row, 'created_at'),
        };
      }),
    });
  } catch (error) { next(error); }
});

export { COMMAND_ACTIONS, DEFAULT_FLOOD_ENGINE_CONFIG, DEFAULT_AUTOMATION_POLICY };
export type { FloodEngineConfig };
