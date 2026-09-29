/**
 * Public status, service-area and content APIs, plus the device-facing v1 API
 * (heartbeat, command polling and one-time command acknowledgement).
 *
 * Device routes authenticate with a per-device Bearer key (only its hash is
 * stored), are CIDR-restricted in production and use per-device sequence numbers
 * and command nonces for replay protection.
 */
import crypto from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { normalizeFloodState } from '../shared/flood-state.js';
import { rateOfRiseCmPerMin } from '../shared/flood-engine.js';
import {
  DatabaseRequestError, execute, getTursoDashboard, isTursoConfigured, randomId,
  rowBoolean, rowNumber, rowText, currentTimestamp,
} from './database.js';
import { getPreviewDashboard, readStore } from './data.js';
import { listServiceAreas } from './service-areas.js';
import { getPublishedPage } from './content.js';
import { acknowledgeCommand, pollPendingCommands } from './commands.js';
import { bearerToken, clientIp, hashToken, isIpAllowedByCidr, safeEqualHex } from './http-utils.js';

export const publicRouter = express.Router();
export const deviceRouter = express.Router();

const publicLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false });
const deviceLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false });

const DEFAULT_SAFETY_INSTRUCTIONS = [
  'This platform is an educational prototype. It is not a real flood-defence or emergency warning service.',
  'Always follow instructions from your local authorities and emergency services.',
  'Do not enter moving or rising water. Move to higher ground if you are in a low-lying area.',
  'Never rely on a dashboard, model barrier or push notification for life-safety decisions.',
];

function safetyInstructions(): string[] {
  try {
    const raw = process.env.SAFETY_INSTRUCTIONS;
    if (!raw) return DEFAULT_SAFETY_INSTRUCTIONS;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed.slice(0, 12);
  } catch { /* fall back to defaults */ }
  return DEFAULT_SAFETY_INSTRUCTIONS;
}

/** Public, read-only current status. Values are real or explicitly labeled SIMULATION. */
publicRouter.get('/status', publicLimiter, async (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (isTursoConfigured) {
      const dashboard = await getTursoDashboard();
      const latestPoints = dashboard.history.slice(-4);
      const prior = latestPoints.length >= 4 ? latestPoints[0] : latestPoints[0];
      const trendCm = dashboard.system.trendCm;
      const rate = prior && latestPoints.length
        ? rateOfRiseCmPerMin(prior.levelCm, new Date(prior.createdAt).getTime(), latestPoints[latestPoints.length - 1]!.levelCm, new Date(latestPoints[latestPoints.length - 1]!.createdAt).getTime())
        : 0;
      res.json({
        mode: 'turso',
        simulation: false,
        simulationNotice: null,
        project: dashboard.project,
        city: dashboard.city,
        zone: dashboard.zone,
        state: dashboard.system.state,
        stateLabel: dashboard.system.state,
        levelCm: dashboard.system.levelCm,
        trendCm,
        rateOfRiseCmPerMin: Math.round(rate * 100) / 100,
        barrier: dashboard.system.barrier,
        barrierLatched: dashboard.system.barrierLatched,
        sensorHealthy: dashboard.system.sensorHealthy,
        emergencyStopActive: dashboard.system.emergencyStopActive,
        lastUpdate: dashboard.updatedAt,
        lastSampleAt: dashboard.history.at(-1)?.createdAt ?? dashboard.updatedAt,
        devicesOnline: dashboard.stats.activeDevices,
        devicesTotal: dashboard.devices.length,
        maintenanceMode: dashboard.maintenanceMode,
        safetyInstructions: safetyInstructions(),
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    const store = readStore();
    const dashboard = getPreviewDashboard(store);
    const history = store.history.slice(-2);
    const rate = history.length === 2
      ? rateOfRiseCmPerMin(history[0]!.levelCm, new Date(history[0]!.createdAt).getTime(), history[1]!.levelCm, new Date(history[1]!.createdAt).getTime())
      : 0;
    res.json({
      mode: 'simulation',
      simulation: true,
      simulationNotice: 'SIMULATION MODE — these values come from the labeled local simulator, not from live sensors.',
      project: dashboard.project,
      city: dashboard.city,
      zone: dashboard.zone,
      state: dashboard.system.state,
      stateLabel: `SIMULATION · ${dashboard.system.state}`,
      levelCm: dashboard.system.levelCm,
      trendCm: dashboard.system.trendCm,
      rateOfRiseCmPerMin: Math.round(rate * 100) / 100,
      barrier: dashboard.system.barrier,
      barrierLatched: dashboard.system.barrierLatched,
      sensorHealthy: dashboard.system.sensorHealthy,
      emergencyStopActive: dashboard.system.emergencyStopActive,
      lastUpdate: dashboard.updatedAt,
      lastSampleAt: store.history.at(-1)?.createdAt ?? dashboard.updatedAt,
      devicesOnline: dashboard.stats.activeDevices,
      devicesTotal: dashboard.devices.length,
      maintenanceMode: dashboard.maintenanceMode,
      safetyInstructions: safetyInstructions(),
      updatedAt: new Date().toISOString(),
    });
  } catch (error) { next(error); }
});

publicRouter.get('/service-areas', publicLimiter, async (_req, res, next) => {
  try {
    res.json({ serviceAreas: await listServiceAreas(false) });
  } catch (error) { next(error); }
});

publicRouter.get('/content/:slug', publicLimiter, async (req, res, next) => {
  try {
    const locale = typeof req.query.locale === 'string' && req.query.locale === 'bn' ? 'bn' : 'en';
    const page = await getPublishedPage(String(req.params.slug), locale);
    if (!page) { res.status(404).json({ error: 'No published page with that slug.' }); return; }
    res.json({ page });
  } catch (error) { next(error); }
});

publicRouter.get('/flood-events', publicLimiter, async (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 12));
  try {
    if (isTursoConfigured) {
      const result = await execute(
        'SELECT id,event_key,state,severity,level_cm,reason,simulation,created_at FROM flood_events ORDER BY created_at DESC LIMIT ?',
        [limit],
      );
      res.json({
        mode: 'turso',
        simulation: false,
        events: result.rows.map((raw) => ({
          id: rowText(raw, 'id'),
          key: rowText(raw, 'event_key'),
          state: normalizeFloodState(rowText(raw, 'state')),
          severity: rowText(raw, 'severity'),
          levelCm: rowNumber(raw, 'level_cm', 0) || null,
          reason: rowText(raw, 'reason'),
          simulation: rowBoolean(raw, 'simulation'),
          createdAt: rowText(raw, 'created_at'),
        })),
      });
      return;
    }
    const store = readStore();
    res.json({
      mode: 'simulation',
      simulation: true,
      events: store.events.slice(0, limit).map((event) => ({
        id: event.id, key: event.title, state: event.state, severity: event.state === 'CRITICAL' ? 'CRITICAL' : event.state === 'INFO' ? 'INFO' : 'WARNING',
        levelCm: null, reason: event.message, simulation: true, createdAt: event.createdAt,
      })),
    });
  } catch (error) { next(error); }
});

// ---------------------------------------------------------------------------
// Device-facing v1 API (per-device key auth + CIDR allowlist + replay checks)
// ---------------------------------------------------------------------------

const provisionSchema = z.object({
  deviceId: z.string().min(3).max(64),
  provisioningToken: z.string().min(24).max(128),
  firmwareVersion: z.string().min(1).max(40),
  kind: z.enum(['ESP32_CONTROLLER', 'ESP8266_SENDER']).optional(),
});

/**
 * One-time provisioning exchange. The device presents the admin-issued
 * provisioning token; the response carries a freshly generated per-device API key
 * exactly once (only its hash is stored). No master backend secret is ever
 * shipped in firmware or returned more than once.
 */
deviceRouter.post('/provision', deviceLimiter, async (req, res, next) => {
  const parsed = provisionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid provisioning payload.' }); return; }
  if (!isTursoConfigured) { res.status(503).json({ error: 'Provisioning requires the database-backed deployment.' }); return; }
  try {
    const result = await execute('SELECT id,approval_state,provisioning_token_hash,provisioning_expires_at FROM devices WHERE id=?', [parsed.data.deviceId]);
    if (!result.rows.length) { res.status(404).json({ error: 'Unknown device UID. Register the device in the admin console first.' }); return; }
    const row = result.rows[0] as Record<string, unknown>;
    if (rowText(row, 'approval_state') !== 'APPROVED') { res.status(403).json({ error: 'Device must be approved before provisioning.' }); return; }
    const tokenHash = rowText(row, 'provisioning_token_hash');
    const expiresAt = rowText(row, 'provisioning_expires_at');
    if (!tokenHash || !expiresAt) { res.status(403).json({ error: 'No active provisioning token. Generate one in the admin console.' }); return; }
    if (new Date(expiresAt).getTime() <= Date.now()) {
      await execute('UPDATE devices SET provisioning_token_hash=NULL,provisioning_expires_at=NULL WHERE id=?', [parsed.data.deviceId]);
      res.status(403).json({ error: 'Provisioning token expired. Generate a new one.' });
      return;
    }
    if (!safeEqualHex(hashToken(parsed.data.provisioningToken), tokenHash)) {
      res.status(403).json({ error: 'Provisioning token is invalid.' });
      return;
    }
    const apiKey = crypto.randomBytes(32).toString('base64url');
    const now = currentTimestamp();
    await execute(
      'UPDATE devices SET api_key_hash=?,provisioning_token_hash=NULL,provisioning_expires_at=NULL,firmware_version=?,enabled=1,updated_at=? WHERE id=?',
      [hashToken(apiKey), parsed.data.firmwareVersion, now, parsed.data.deviceId],
    );
    await execute('INSERT INTO device_credentials(id,device_id,key_hash,label,created_at) VALUES(?,?,?,?,?)', [randomId(), parsed.data.deviceId, hashToken(apiKey), 'provisioned', now]);
    res.json({
      apiKey,
      deviceId: parsed.data.deviceId,
      serverTime: now,
      message: 'Store this API key in device NVS now — it is shown exactly once and never again.',
    });
  } catch (error) { next(error); }
});

const heartbeatSchema = z.object({
  deviceId: z.string().min(3).max(64),
  seq: z.number().int().nonnegative().optional(),
  uptimeS: z.number().int().nonnegative().max(4_000_000_000).optional(),
  firmwareVersion: z.string().min(1).max(40).optional(),
  rssi: z.number().int().min(-120).max(20).optional(),
  faultState: z.string().max(60).optional(),
});

const ackSchema = z.object({
  nonce: z.string().min(16).max(128),
  status: z.enum(['OK', 'FAILED']),
  limitSwitchState: z.enum(['OPEN', 'CLOSED', 'UNKNOWN', 'TRAVELING']).optional(),
  result: z.string().max(500).optional(),
  failureReason: z.string().max(500).optional(),
});

async function authenticateDevice(deviceId: string, req: express.Request): Promise<{ tenantId: string; zoneId: string; kind: string }> {
  const token = bearerToken(req);
  if (!token || token.length < 16) throw new DatabaseRequestError(401, 'A device bearer key is required.');
  if (isTursoConfigured && !isIpAllowedByCidr(clientIp(req), process.env.DEVICE_CIDR_ALLOWLIST)) {
    throw new DatabaseRequestError(403, 'Device source IP is not in the configured CIDR allowlist.');
  }
  if (isTursoConfigured) {
    const result = await execute('SELECT id,api_key_hash,enabled,approval_state,tenant_id,zone_id,kind FROM devices WHERE id=?', [deviceId]);
    if (!result.rows.length) throw new DatabaseRequestError(401, 'Device credentials are invalid.');
    const row = result.rows[0] as Record<string, unknown>;
    if (!safeEqualHex(hashToken(token), rowText(row, 'api_key_hash'))) throw new DatabaseRequestError(401, 'Device credentials are invalid.');
    if (!rowBoolean(row, 'enabled')) throw new DatabaseRequestError(403, 'Device is disabled.');
    if (rowText(row, 'approval_state') !== 'APPROVED') throw new DatabaseRequestError(403, 'Device is not approved.');
    return { tenantId: rowText(row, 'tenant_id'), zoneId: rowText(row, 'zone_id'), kind: rowText(row, 'kind') };
  }
  const store = readStore();
  const device = store.devices.find((item) => item.id === deviceId && item.enabled);
  if (!device || !safeEqualHex(hashToken(token), device.apiKeyHash)) throw new DatabaseRequestError(401, 'Device credentials are invalid.');
  return { tenantId: 'simulation', zoneId: store.zone, kind: device.kind === 'ESP32 controller' ? 'ESP32_CONTROLLER' : 'ESP8266_SENDER' };
}

deviceRouter.post('/heartbeat', deviceLimiter, async (req, res, next) => {
  const parsed = heartbeatSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid heartbeat payload.' }); return; }
  try {
    await authenticateDevice(parsed.data.deviceId, req);
    const now = currentTimestamp();
    if (isTursoConfigured) {
      await execute(
        'UPDATE devices SET last_seen_at=?,uptime_s=COALESCE(?,uptime_s),last_rssi=COALESCE(?,last_rssi),fault_state=?,firmware_version=COALESCE(?,firmware_version),updated_at=? WHERE id=?',
        [now, parsed.data.uptimeS ?? null, parsed.data.rssi ?? null, parsed.data.faultState ?? null, parsed.data.firmwareVersion ?? null, now, parsed.data.deviceId],
      );
    }
    res.json({ ok: true, serverTime: now, commandsAvailable: isTursoConfigured });
  } catch (error) { next(error); }
});

deviceRouter.get('/:deviceId/commands', deviceLimiter, async (req, res, next) => {
  try {
    const identity = await authenticateDevice(String(req.params.deviceId), req);
    if (!isTursoConfigured) {
      res.status(503).json({ error: 'Remote command delivery requires the database-backed deployment.', commands: [] });
      return;
    }
    if (identity.kind === 'ESP8266_SENDER') {
      res.json({ commands: [], note: 'Sender-only nodes have no actuator and never receive barrier commands.' });
      return;
    }
    const commands = await pollPendingCommands(String(req.params.deviceId));
    res.json({ commands, serverTime: currentTimestamp() });
  } catch (error) { next(error); }
});

deviceRouter.post('/:deviceId/commands/:commandId/ack', deviceLimiter, async (req, res, next) => {
  const parsed = ackSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid acknowledgement payload.' }); return; }
  try {
    const identity = await authenticateDevice(String(req.params.deviceId), req);
    const result = await acknowledgeCommand({
      deviceId: String(req.params.deviceId),
      commandId: String(req.params.commandId),
      nonce: parsed.data.nonce,
      status: parsed.data.status,
      limitSwitchState: parsed.data.limitSwitchState,
      result: parsed.data.result,
      failureReason: parsed.data.failureReason,
      tenantId: identity.tenantId,
    });
    res.json(result);
  } catch (error) { next(error); }
});
