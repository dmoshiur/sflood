import express, { type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import ipaddr from 'ipaddr.js';
import { z } from 'zod';
import { config } from '../config.js';
import { currentTimestamp, execute, getFeatureFlag, insertAudit, primaryTenantId, queryAll, queryOne, rowText } from '../database.js';
import { requireCsrf, requireSession } from '../auth.js';
import { canCommandBarrier, inAdminScope, isLocalAdmin, type AuthUser } from '../rbac.js';
import {
  authenticateDeviceToken, claimProvisioningToken, deviceListWithScope, getDevice, getDeviceByUid, issueProvisioningToken,
  latestTelemetry, provisioningQrDataUrl, provisioningQrPayload, registerDevice, revokeDeviceCredentials,
  rotateDeviceCredential, setDeviceApproval, setDeviceEnabled, updateDeviceConfig, type Board,
} from '../devices.js';
import type { DeviceRecord } from '../devices.js';
import { ingestTelemetry, recordHeartbeat, telemetrySchema, TelemetryError } from '../telemetry.js';
import {
  acknowledgeCommand, cancelCommand, issueBarrierCommand, listCommands, pendingCommandsForDevice, COMMAND_TTL_SECONDS,
  type BarrierAction,
} from '../commands.js';
import { asyncHandler, clientIp, fail, forbidden, unauthorized } from '../http.js';

/**
 * Device surface.
 *
 * Two very different audiences share this router:
 *   - humans (session + CSRF) who manage the registry and issue commands
 *   - devices (per-device bearer key) that provision, stream telemetry, send
 *     heartbeats and poll for barrier commands
 *
 * Device ingress is additionally restricted to DEVICE_CIDR_ALLOWLIST when one is
 * configured, and fails closed in production.
 */

export const devicesRouter = express.Router();

const telemetryLimiter = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false });
const provisionLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
const commandLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });

function ipInCidrs(address: string, cidrs: string[]): boolean {
  if (!cidrs.length) return !config.isProduction;
  try {
    const client = ipaddr.process(address);
    return cidrs.some((cidr) => {
      try { const [range, prefix] = ipaddr.parseCIDR(cidr); return client.kind() === range.kind() && client.match(range, prefix); }
      catch { return false; }
    });
  } catch { return false; }
}

function deviceIngressAllowed(req: Request, res: Response): boolean {
  if (!config.deviceCidrAllowlist.length) {
    if (config.isProduction) { fail(res, 403, 'DEVICE_CIDR_ALLOWLIST must be configured in production.'); return false; }
    return true;
  }
  if (!ipInCidrs(clientIp(req), config.deviceCidrAllowlist)) {
    fail(res, 403, 'Device ingress source IP is not in the configured CIDR allowlist.');
    return false;
  }
  return true;
}

async function requireDevice(req: Request, res: Response): Promise<DeviceRecord | null> {
  const authorization = req.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token) { unauthorized(res, 'A device bearer key is required.'); return null; }
  const device = await authenticateDeviceToken(token);
  if (!device) { unauthorized(res, 'Device credentials are invalid, revoked or disabled.'); return null; }
  return device;
}

/* ------------------------------------------------------------------ *
 * Human-facing device management
 * ------------------------------------------------------------------ */

devicesRouter.get('/', requireSession, asyncHandler(async (_req, res) => {
  const user = res.locals.authUser as AuthUser;
  let devices = await deviceListWithScope(user.tenantId);
  if (!isLocalAdmin(user)) {
    devices = devices.filter((device) => !user.zoneId || device.zoneId === user.zoneId);
  } else if (!inAdminScope(user, { cityId: null, zoneId: null })) {
    devices = devices.filter((device) => inAdminScope(user, { cityId: device.cityId, zoneId: device.zoneId }));
  }
  res.json({
    mode: config.isLocalDatabase ? 'local-database' : 'turso',
    devices: devices.map((device) => ({
      id: device.id, uid: device.uid, name: device.name, board: device.board, kind: device.kind,
      approvalState: device.approvalState, approvalNote: device.approvalNote, enabled: device.enabled,
      simulation: device.simulation, firmwareVersion: device.firmwareVersion, health: device.health,
      zoneId: device.zoneId, zoneName: device.zoneName, cityId: device.cityId, cityName: device.cityName,
      lastSeenAt: device.lastSeenAt, lastHeartbeatAt: device.lastHeartbeatAt, lastSeq: device.lastSeq,
      currentState: device.currentState, barrierState: device.barrierState, barrierLatched: device.barrierLatched,
      emergencyStopActive: device.emergencyStopActive, signalDbm: device.signalDbm, uptimeSeconds: device.uptimeSeconds,
      faultState: device.faultState, limitSwitchLow: device.limitSwitchLow, limitSwitchHigh: device.limitSwitchHigh,
      activeCredentials: device.activeCredentials, config: device.config, createdAt: device.createdAt,
    })),
  });
}));

devicesRouter.get('/:deviceId', requireSession, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const device = await getDevice(String(req.params.deviceId));
  if (!device) { fail(res, 404, 'Device not found.'); return; }
  if (!isLocalAdmin(user) && user.zoneId && device.zoneId !== user.zoneId) { forbidden(res, 'That device is outside your area.'); return; }
  const history = await latestTelemetry(device.id, 80);
  const commands = await listCommands({ deviceId: device.id, limit: 20 });
  res.json({
    device: {
      id: device.id, uid: device.uid, name: device.name, board: device.board, kind: device.kind,
      approvalState: device.approvalState, enabled: device.enabled, simulation: device.simulation,
      firmwareVersion: device.firmwareVersion, currentState: device.currentState, barrierState: device.barrierState,
      barrierLatched: device.barrierLatched, emergencyStopActive: device.emergencyStopActive,
      signalDbm: device.signalDbm, uptimeSeconds: device.uptimeSeconds, faultState: device.faultState,
      limitSwitchLow: device.limitSwitchLow, limitSwitchHigh: device.limitSwitchHigh,
      lastSeenAt: device.lastSeenAt, lastHeartbeatAt: device.lastHeartbeatAt, lastSeq: device.lastSeq,
      heartbeatIntervalSeconds: device.heartbeatIntervalSeconds, config: device.config, createdAt: device.createdAt,
    },
    history,
    commands: commands.map((command) => ({
      commandId: command.commandId, action: command.action, status: command.status, reason: command.reason,
      requestedByKind: command.requestedByKind, issuedAt: command.issuedAt, expiresAt: command.expiresAt, acknowledgedAt: command.acknowledgedAt,
    })),
  });
}));

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  board: z.enum(['ESP32', 'ESP8266']),
  zoneId: z.string().min(3).max(64),
  firmwareVersion: z.string().max(40).optional(),
  simulation: z.boolean().optional(),
});

devicesRouter.post('/', requireSession, requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  if (!isLocalAdmin(user)) { forbidden(res, 'Only administrators can register devices.'); return; }
  if (!user.mfaVerified) { fail(res, 403, 'Verify your authenticator code before registering devices.'); return; }
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Enter a device name, board and monitored zone.'); return; }
  const zone = await queryOne('SELECT id,city_id FROM zones WHERE id=?', [parsed.data.zoneId]);
  if (!zone) { fail(res, 404, 'That monitored zone does not exist.'); return; }
  if (!inAdminScope(user, { cityId: rowText(zone, 'city_id'), zoneId: parsed.data.zoneId })) {
    forbidden(res, 'That zone is outside your assigned area.'); return;
  }
  const { device, provisioningToken, expiresAt } = await registerDevice({
    tenantId: user.tenantId, cityId: rowText(zone, 'city_id'), zoneId: parsed.data.zoneId,
    name: parsed.data.name, board: parsed.data.board as Board,
    firmwareVersion: parsed.data.firmwareVersion, actorId: user.id, simulation: parsed.data.simulation,
  });
  const qr = await provisioningQrDataUrl(provisioningToken, device.uid, device.board);
  res.status(201).json({
    device: { id: device.id, uid: device.uid, name: device.name, board: device.board, approvalState: device.approvalState },
    provisioning: {
      token: provisioningToken, expiresAt, qrDataUrl: qr, qrPayload: provisioningQrPayload(provisioningToken, device.uid, device.board),
    },
    message: 'Device registered. Show this QR code (or the token) to the device once. The token expires in 24 hours and cannot be reused.',
  });
}));

devicesRouter.post('/:deviceId/provisioning-token', requireSession, requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const device = await getDevice(String(req.params.deviceId));
  if (!device) { fail(res, 404, 'Device not found.'); return; }
  if (!isLocalAdmin(user) || !inAdminScope(user, { cityId: device.cityId, zoneId: device.zoneId })) {
    forbidden(res, 'That device is outside your assigned area.'); return;
  }
  const issued = await issueProvisioningToken(device.id, user.id);
  if (!issued) { fail(res, 404, 'Device not found.'); return; }
  const qr = await provisioningQrDataUrl(issued.token, device.uid, device.board);
  res.json({ provisioning: { token: issued.token, expiresAt: issued.expiresAt, qrDataUrl: qr, qrPayload: provisioningQrPayload(issued.token, device.uid, device.board) } });
}));

devicesRouter.post('/:deviceId/approve', requireSession, requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const device = await getDevice(String(req.params.deviceId));
  if (!device) { fail(res, 404, 'Device not found.'); return; }
  if (!isLocalAdmin(user) || !inAdminScope(user, { cityId: device.cityId, zoneId: device.zoneId })) {
    forbidden(res, 'That device is outside your assigned area.'); return;
  }
  const parsed = z.object({ note: z.string().max(300).optional() }).safeParse(req.body || {});
  const updated = await setDeviceApproval(device.id, 'APPROVED', parsed.data?.note || 'Approved by administrator', user.id);
  res.json({ device: updated && { id: updated.id, approvalState: updated.approvalState }, message: 'Device approved. It can now stream telemetry.' });
}));

devicesRouter.post('/:deviceId/reject', requireSession, requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const device = await getDevice(String(req.params.deviceId));
  if (!device) { fail(res, 404, 'Device not found.'); return; }
  if (!isLocalAdmin(user) || !inAdminScope(user, { cityId: device.cityId, zoneId: device.zoneId })) {
    forbidden(res, 'That device is outside your assigned area.'); return;
  }
  const parsed = z.object({ note: z.string().max(300).optional() }).safeParse(req.body || {});
  await revokeDeviceCredentials(device.id, user.id);
  const updated = await setDeviceApproval(device.id, 'REJECTED', parsed.data?.note || 'Rejected by administrator', user.id);
  res.json({ device: updated && { id: updated.id, approvalState: updated.approvalState }, message: 'Device rejected and its credentials revoked.' });
}));

devicesRouter.post('/:deviceId/enabled', requireSession, requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const device = await getDevice(String(req.params.deviceId));
  if (!device) { fail(res, 404, 'Device not found.'); return; }
  if (!isLocalAdmin(user) || !inAdminScope(user, { cityId: device.cityId, zoneId: device.zoneId })) {
    forbidden(res, 'That device is outside your assigned area.'); return;
  }
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Specify enabled as true or false.'); return; }
  const updated = await setDeviceEnabled(device.id, parsed.data.enabled, user.id);
  res.json({ enabled: updated?.enabled, message: updated?.enabled ? 'Device enabled.' : 'Device disabled.' });
}));

devicesRouter.post('/:deviceId/rotate-credentials', requireSession, requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const device = await getDevice(String(req.params.deviceId));
  if (!device) { fail(res, 404, 'Device not found.'); return; }
  if (!isLocalAdmin(user) || !inAdminScope(user, { cityId: device.cityId, zoneId: device.zoneId })) {
    forbidden(res, 'That device is outside your assigned area.'); return;
  }
  if (!user.mfaVerified) { fail(res, 403, 'Verify your authenticator code before rotating device credentials.'); return; }
  const rotated = await rotateDeviceCredential(device.id, user.id);
  res.json({ apiKey: rotated?.apiKey, message: 'New device key issued. The previous key is revoked immediately. Update the device now; the key is shown only once.' });
}));

devicesRouter.post('/:deviceId/revoke-credentials', requireSession, requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const device = await getDevice(String(req.params.deviceId));
  if (!device) { fail(res, 404, 'Device not found.'); return; }
  if (!isLocalAdmin(user) || !inAdminScope(user, { cityId: device.cityId, zoneId: device.zoneId })) {
    forbidden(res, 'That device is outside your assigned area.'); return;
  }
  await revokeDeviceCredentials(device.id, user.id);
  res.json({ revoked: true, message: 'All device credentials revoked. The device must be provisioned again.' });
}));

devicesRouter.put('/:deviceId/config', requireSession, requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const device = await getDevice(String(req.params.deviceId));
  if (!device) { fail(res, 404, 'Device not found.'); return; }
  if (!isLocalAdmin(user) || !inAdminScope(user, { cityId: device.cityId, zoneId: device.zoneId })) {
    forbidden(res, 'That device is outside your assigned area.'); return;
  }
  const parsed = z.object({
    sampleIntervalSeconds: z.number().int().min(1).max(3600).optional(),
    sensorZeroCm: z.number().min(-100).max(100).optional(),
    barrierTravelSeconds: z.number().int().min(1).max(120).optional(),
    localWatchCm: z.number().min(0).max(1000).optional(),
    localWarningCm: z.number().min(0).max(1000).optional(),
    localCriticalCm: z.number().min(0).max(1000).optional(),
    buzzerEnabled: z.boolean().optional(),
    ledEnabled: z.boolean().optional(),
  }).safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Check the remote configuration values.'); return; }
  const merged = await updateDeviceConfig(device.id, parsed.data, user.id);
  res.json({ config: merged, message: 'Remote configuration saved. The device picks it up on its next poll.' });
}));

devicesRouter.delete('/:deviceId', requireSession, requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const device = await getDevice(String(req.params.deviceId));
  if (!device) { fail(res, 404, 'Device not found.'); return; }
  if (!isLocalAdmin(user) || !inAdminScope(user, { cityId: device.cityId, zoneId: device.zoneId })) {
    forbidden(res, 'That device is outside your assigned area.'); return;
  }
  if (!user.mfaVerified) { fail(res, 403, 'Verify your authenticator code before deleting a device.'); return; }
  await execute('DELETE FROM devices WHERE id=?', [device.id]);
  await insertAudit({ tenantId: user.tenantId, actorId: user.id, action: 'DEVICE_DELETED', targetType: 'device', targetId: device.id, metadata: { uid: device.uid }, ipAddress: req.ip });
  res.json({ deleted: true });
}));

/* ------------------------------------------------------------------ *
 * Device-facing endpoints (per-device bearer key)
 * ------------------------------------------------------------------ */

const provisionSchema = z.object({
  token: z.string().min(16).max(256),
  uid: z.string().min(3).max(64),
  board: z.enum(['ESP32', 'ESP8266']),
  firmwareVersion: z.string().max(40).optional(),
  hardwareRevision: z.string().max(40).optional(),
});

devicesRouter.post('/v1/provision', provisionLimiter, asyncHandler(async (req, res) => {
  if (!deviceIngressAllowed(req, res)) return;
  const parsed = provisionSchema.safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'A valid provisioning token, device UID and board are required.'); return; }
  const result = await claimProvisioningToken({ ...parsed.data, ip: clientIp(req) });
  if ('error' in result) { fail(res, result.status, result.error); return; }
  res.status(201).json({
    deviceId: result.deviceId,
    apiKey: result.apiKey,
    heartbeatIntervalSeconds: result.heartbeatIntervalSeconds,
    endpoints: {
      telemetry: '/api/v1/telemetry',
      heartbeat: '/api/v1/heartbeat',
      commands: '/api/v1/commands',
      acknowledge: '/api/v1/commands/ack',
      config: '/api/devices/config',
    },
    config: result.config,
    message: 'Provisioned. Store this key in device flash. It is shown only once.',
  });
}));

devicesRouter.post('/v1/telemetry', telemetryLimiter, asyncHandler(async (req, res) => {
  if (!deviceIngressAllowed(req, res)) return;
  const parsed = telemetrySchema.safeParse(req.body);
  if (!parsed.success) { fail(res, 400, parsed.error.issues[0]?.message || 'Invalid telemetry payload.'); return; }
  const device = await requireDevice(req, res);
  if (!device) return;
  if (device.id !== parsed.data.deviceId && device.uid !== parsed.data.deviceId) {
    forbidden(res, 'This key belongs to a different device.'); return;
  }
  try {
    const result = await ingestTelemetry(device, parsed.data);
    res.status(202).json({
      accepted: true, seq: result.seq, state: result.state, previousState: result.previousState, changed: result.changed,
      barrier: result.barrier, levelCm: result.levelCm, rateCmPerMin: result.rateCmPerMin, eventId: result.eventId,
      commandId: result.commandId, simulated: result.simulated,
      note: 'Telemetry accepted. Barrier commands are delivered through the command poll endpoint.',
    });
  } catch (error) {
    if (error instanceof TelemetryError) { fail(res, error.status, error.message); return; }
    throw error;
  }
}));

const heartbeatSchema = z.object({
  uptimeSeconds: z.number().int().nonnegative().max(2_000_000_000).optional(),
  rssi: z.number().int().min(-120).max(0).optional(),
  batteryMv: z.number().int().min(0).max(20000).optional(),
  firmwareVersion: z.string().max(40).optional(),
  faultState: z.enum(['NONE', 'SENSOR_FAULT', 'ACTUATOR_FAULT', 'LIMIT_SWITCH_FAULT', 'COMMS_FAULT', 'POWER_FAULT']).optional(),
  freeHeapBytes: z.number().int().nonnegative().optional(),
});

devicesRouter.post('/v1/heartbeat', telemetryLimiter, asyncHandler(async (req, res) => {
  if (!deviceIngressAllowed(req, res)) return;
  const parsed = heartbeatSchema.safeParse(req.body || {});
  if (!parsed.success) { fail(res, 400, 'Invalid heartbeat payload.'); return; }
  const device = await requireDevice(req, res);
  if (!device) return;
  const result = await recordHeartbeat(device, parsed.data);
  res.json({ heartbeat: result });
}));

devicesRouter.get('/v1/commands', telemetryLimiter, asyncHandler(async (req, res) => {
  if (!deviceIngressAllowed(req, res)) return;
  const device = await requireDevice(req, res);
  if (!device) return;
  const commands = await pendingCommandsForDevice(device.id);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ commands, pollAfterSeconds: 5, serverTime: currentTimestamp() });
}));

const ackSchema = z.object({
  commandId: z.string().uuid(),
  status: z.enum(['ACKNOWLEDGED', 'FAILED']),
  barrierState: z.enum(['DOWN', 'RAISING', 'RAISED', 'FAULT', 'HOLD']).optional(),
  limitSwitchLow: z.boolean().optional(),
  limitSwitchHigh: z.boolean().optional(),
  error: z.string().max(200).optional(),
});

devicesRouter.post('/v1/commands/ack', commandLimiter, asyncHandler(async (req, res) => {
  if (!deviceIngressAllowed(req, res)) return;
  const parsed = ackSchema.safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'A command id, status and optional actuator feedback are required.'); return; }
  const device = await requireDevice(req, res);
  if (!device) return;
  const acknowledged = await acknowledgeCommand({
    commandId: parsed.data.commandId, deviceId: device.id, status: parsed.data.status,
    payload: {
      barrierState: parsed.data.barrierState, limitSwitchLow: parsed.data.limitSwitchLow,
      limitSwitchHigh: parsed.data.limitSwitchHigh, error: parsed.data.error, ackAt: currentTimestamp(),
    },
  });
  if (!acknowledged) { fail(res, 404, 'That command is unknown, expired or already finalised.'); return; }
  if (parsed.data.barrierState) {
    await execute('UPDATE devices SET barrier_state=?,updated_at=? WHERE id=?', [parsed.data.barrierState, currentTimestamp(), device.id]);
  }
  if (parsed.data.limitSwitchLow !== undefined || parsed.data.limitSwitchHigh !== undefined) {
    await execute('UPDATE devices SET limit_switch_low=COALESCE(?,limit_switch_low),limit_switch_high=COALESCE(?,limit_switch_high) WHERE id=?', [
      parsed.data.limitSwitchLow === undefined ? null : parsed.data.limitSwitchLow ? 1 : 0,
      parsed.data.limitSwitchHigh === undefined ? null : parsed.data.limitSwitchHigh ? 1 : 0,
      device.id,
    ]);
  }
  res.json({ commandId: acknowledged.commandId, status: acknowledged.status, message: 'Command acknowledgement recorded.' });
}));

devicesRouter.get('/config', asyncHandler(async (req, res) => {
  const device = await requireDevice(req, res);
  if (!device) return;
  res.json({
    deviceId: device.id, uid: device.uid, heartbeatIntervalSeconds: device.heartbeatIntervalSeconds,
    approvalState: device.approvalState, enabled: device.enabled, config: device.config,
    serverTime: currentTimestamp(),
  });
}));

/* ------------------------------------------------------------------ *
 * Barrier commands issued by people
 * ------------------------------------------------------------------ */

const barrierCommandSchema = z.object({
  deviceId: z.string().min(3).max(64),
  action: z.enum(['RAISE', 'LOWER', 'HOLD', 'EMERGENCY_STOP', 'RESET_FAULT']),
  reason: z.string().max(300).optional(),
});

devicesRouter.post('/barrier/commands', requireSession, requireCsrf, commandLimiter, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const parsed = barrierCommandSchema.safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Choose a device and a barrier action.'); return; }
  const device = await getDevice(parsed.data.deviceId) || await getDeviceByUid(parsed.data.deviceId);
  if (!device) { fail(res, 404, 'Device not found.'); return; }
  if (!canCommandBarrier(user, { zoneId: device.zoneId, cityId: device.cityId })) {
    forbidden(res, 'Your role and site scope do not allow barrier commands.'); return;
  }
  if (device.simulation) { fail(res, 409, 'Simulation nodes cannot receive physical barrier commands.'); return; }
  const command = await issueBarrierCommand({
    tenantId: user.tenantId, zoneId: device.zoneId, deviceId: device.id, action: parsed.data.action as BarrierAction,
    requestedBy: user.id, requestedByKind: 'USER', reason: parsed.data.reason || 'Manual command from the dashboard',
  });
  res.status(201).json({
    command: {
      commandId: command.commandId, action: command.action, status: command.status, nonce: command.nonce,
      issuedAt: command.issuedAt, expiresAt: command.expiresAt, expiresInSeconds: COMMAND_TTL_SECONDS,
    },
    message: 'Command queued. It is delivered to the device on its next poll and expires automatically if unacknowledged.',
  });
}));

devicesRouter.get('/barrier/commands', requireSession, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const filter: { deviceId?: string; zoneId?: string; limit?: number } = { limit: 60 };
  if (typeof req.query.deviceId === 'string') filter.deviceId = req.query.deviceId;
  if (typeof req.query.zoneId === 'string') filter.zoneId = req.query.zoneId;
  if (!isLocalAdmin(user) && user.zoneId) filter.zoneId = user.zoneId;
  const commands = await listCommands(filter);
  res.json({
    commands: commands.map((command) => ({
      commandId: command.commandId, deviceId: command.deviceId, action: command.action, status: command.status,
      requestedBy: command.requestedBy, requestedByKind: command.requestedByKind, reason: command.reason,
      issuedAt: command.issuedAt, expiresAt: command.expiresAt, acknowledgedAt: command.acknowledgedAt,
    })),
  });
}));

devicesRouter.post('/barrier/commands/:commandId/cancel', requireSession, requireCsrf, asyncHandler(async (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const existing = await queryOne('SELECT * FROM barrier_commands WHERE command_id=?', [String(req.params.commandId)]);
  if (!existing) { fail(res, 404, 'Command not found.'); return; }
  if (!canCommandBarrier(user, { zoneId: rowText(existing, 'zone_id') || null, cityId: null })) {
    forbidden(res, 'You cannot cancel that command.'); return;
  }
  const cancelled = await cancelCommand(String(req.params.commandId), user.id);
  res.json({ cancelled: Boolean(cancelled), message: cancelled ? 'Command cancelled before delivery.' : 'That command already reached a final state.' });
}));

/* ------------------------------------------------------------------ *
 * Firmware metadata
 * ------------------------------------------------------------------ */

devicesRouter.get('/firmware/releases', asyncHandler(async (_req, res) => {
  const rows = await queryAll('SELECT * FROM firmware_releases WHERE published=1 ORDER BY created_at DESC LIMIT 20');
  res.json({
    releases: rows.map((row) => ({
      id: rowText(row, 'id'), version: rowText(row, 'version'), board: rowText(row, 'board', 'ESP32'),
      channel: rowText(row, 'channel', 'stable'), sha256: rowText(row, 'sha256'),
      notes: rowText(row, 'notes'), minHardwareRevision: rowText(row, 'min_hardware_revision'),
      downloadUrl: rowText(row, 'download_url') || config.githubEsp32Url || config.githubEsp8266Url || null,
      githubUrl: rowText(row, 'github_url') || config.githubEsp32Url || null,
      githubReleaseUrl: rowText(row, 'github_release_url') || config.githubReleasesUrl || null,
      createdAt: rowText(row, 'created_at'),
    })),
    links: {
      esp32: config.githubEsp32Url || null,
      esp8266: config.githubEsp8266Url || null,
      releases: config.githubReleasesUrl || null,
    },
    note: 'Firmware binaries are distributed through the configured GitHub release links. No firmware secret is stored in this database.',
  });
}));

export { getFeatureFlag, primaryTenantId };
