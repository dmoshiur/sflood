import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { config } from './config.js';
import {
  currentTimestamp, execute, getFeatureFlag, insertAudit, primaryTenantId, queryAll, queryOne, randomId,
  rowBoolean, rowJson, rowNullableNumber, rowNumber, rowText, turso,
} from './database.js';
import { hashToken, safeEqual } from './security.js';

/**
 * Device registry, provisioning and per-device credentials.
 *
 * Lifecycle:
 *   registered (PENDING) -> provisioned -> APPROVED/REJECTED -> online telemetry
 *
 * Credentials:
 *   - every device gets a unique UID and a one-time provisioning token
 *   - claiming the token returns a per-device API key exactly once
 *   - only SHA-256 hashes of keys and tokens are stored
 *   - keys can be rotated and revoked; rotation is audited
 *
 * No master backend secret is ever embedded in firmware: the firmware only holds
 * the one-time provisioning token entered by the operator, or reads it from
 * device-local storage that is never committed to the repository.
 */

export type Board = 'ESP32' | 'ESP8266';
export type ApprovalState = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface DeviceRecord {
  id: string;
  uid: string;
  tenantId: string;
  cityId: string;
  zoneId: string;
  name: string;
  kind: 'ESP32_CONTROLLER' | 'ESP8266_SENDER';
  board: Board;
  approvalState: ApprovalState;
  approvalNote: string;
  approvedBy: string | null;
  approvedAt: string | null;
  firmwareVersion: string;
  enabled: boolean;
  simulation: boolean;
  lastSeenAt: string | null;
  lastHeartbeatAt: string | null;
  lastSeq: number;
  currentState: string;
  barrierState: string;
  barrierLatched: boolean;
  emergencyStopActive: boolean;
  signalDbm: number | null;
  uptimeSeconds: number;
  faultState: string;
  limitSwitchLow: boolean;
  limitSwitchHigh: boolean;
  heartbeatIntervalSeconds: number;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function toDevice(row: Record<string, unknown>): DeviceRecord {
  return {
    id: rowText(row, 'id'),
    uid: rowText(row, 'uid'),
    tenantId: rowText(row, 'tenant_id'),
    cityId: rowText(row, 'city_id'),
    zoneId: rowText(row, 'zone_id'),
    name: rowText(row, 'name'),
    kind: (rowText(row, 'kind', 'ESP32_CONTROLLER') as DeviceRecord['kind']),
    board: (rowText(row, 'board', 'ESP32') as Board),
    approvalState: (rowText(row, 'approval_state', 'PENDING') as ApprovalState),
    approvalNote: rowText(row, 'approval_note'),
    approvedBy: rowText(row, 'approved_by') || null,
    approvedAt: rowText(row, 'approved_at') || null,
    firmwareVersion: rowText(row, 'firmware_version', 'unknown'),
    enabled: rowBoolean(row, 'enabled'),
    simulation: rowBoolean(row, 'simulation'),
    lastSeenAt: rowText(row, 'last_seen_at') || null,
    lastHeartbeatAt: rowText(row, 'last_heartbeat_at') || null,
    lastSeq: rowNumber(row, 'last_seq'),
    currentState: rowText(row, 'current_state', 'NORMAL'),
    barrierState: rowText(row, 'barrier_state', 'DOWN'),
    barrierLatched: rowBoolean(row, 'barrier_latched'),
    emergencyStopActive: rowBoolean(row, 'emergency_stop_active'),
    signalDbm: rowNullableNumber(row, 'signal_dbm'),
    uptimeSeconds: rowNumber(row, 'uptime_seconds'),
    faultState: rowText(row, 'fault_state', 'NONE'),
    limitSwitchLow: rowBoolean(row, 'limit_switch_low'),
    limitSwitchHigh: rowBoolean(row, 'limit_switch_high'),
    heartbeatIntervalSeconds: rowNumber(row, 'heartbeat_interval_seconds', 30),
    config: rowJson<Record<string, unknown>>(row, 'config_json', {}),
    createdAt: rowText(row, 'created_at'),
    updatedAt: rowText(row, 'updated_at'),
  };
}

export function generateDeviceUid(board: Board): string {
  const prefix = board === 'ESP32' ? 'FG32' : 'FG8266';
  return `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

export async function registerDevice(input: {
  tenantId: string; cityId: string; zoneId: string; name: string; board: Board;
  firmwareVersion?: string; actorId: string | null; simulation?: boolean;
}): Promise<{ device: DeviceRecord; provisioningToken: string; expiresAt: string }> {
  const approvalRequired = await getFeatureFlag('device_approval_required', true);
  const id = randomId();
  const uid = generateDeviceUid(input.board);
  const rawToken = crypto.randomBytes(24).toString('base64url');
  const now = currentTimestamp();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const tx = await turso.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO devices(id,tenant_id,city_id,zone_id,name,kind,board,uid,api_key_hash,firmware_version,enabled,approval_state,approval_note,simulation,last_seq,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,'',?,?,?,?,?,0,?,?)`,
      args: [
        id, input.tenantId, input.cityId, input.zoneId, input.name,
        input.board === 'ESP32' ? 'ESP32_CONTROLLER' : 'ESP8266_SENDER', input.board, uid,
        input.firmwareVersion || '1.0.0', 1,
        approvalRequired && !input.simulation ? 'PENDING' : 'APPROVED',
        approvalRequired && !input.simulation ? 'Awaiting administrator approval' : 'Auto-approved simulation node',
        input.simulation ? 1 : 0, now, now,
      ],
    });
    await tx.execute({
      sql: 'INSERT INTO device_provisioning(id,tenant_id,device_id,token_hash,board,created_by,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)',
      args: [randomId(), input.tenantId, id, hashToken(rawToken), input.board, input.actorId, expiresAt, now],
    });
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
  const device = await getDevice(id);
  if (!device) throw new Error('Device could not be read back after registration.');
  await insertAudit({
    tenantId: input.tenantId, actorId: input.actorId, action: 'DEVICE_REGISTERED', targetType: 'device', targetId: id,
    metadata: { uid, board: input.board, zoneId: input.zoneId, approval: device.approvalState }, 
  });
  return { device, provisioningToken: rawToken, expiresAt };
}

export async function getDevice(deviceId: string): Promise<DeviceRecord | null> {
  const row = await queryOne('SELECT * FROM devices WHERE id=?', [deviceId]);
  return row ? toDevice(row) : null;
}

export async function getDeviceByUid(uid: string): Promise<DeviceRecord | null> {
  const row = await queryOne('SELECT * FROM devices WHERE uid=?', [uid]);
  return row ? toDevice(row) : null;
}

export async function listDevices(filter: { tenantId?: string; cityId?: string; zoneId?: string; includeDisabled?: boolean } = {}): Promise<DeviceRecord[]> {
  const clauses: string[] = [];
  const args: (string | number)[] = [];
  if (filter.tenantId) { clauses.push('tenant_id=?'); args.push(filter.tenantId); }
  if (filter.cityId) { clauses.push('city_id=?'); args.push(filter.cityId); }
  if (filter.zoneId) { clauses.push('zone_id=?'); args.push(filter.zoneId); }
  if (!filter.includeDisabled) clauses.push('enabled=1');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await queryAll(`SELECT * FROM devices ${where} ORDER BY created_at ASC`, args);
  return rows.map(toDevice);
}

/** Authenticate a device bearer token against the active credential hash. */
export async function authenticateDeviceToken(token: string): Promise<DeviceRecord | null> {
  if (!token || token.length < 16 || token.length > 256) return null;
  const tokenHash = hashToken(token);
  const rows = await queryAll(
    `SELECT d.* FROM devices d JOIN device_credentials c ON c.device_id = d.id
     WHERE c.key_hash=? AND c.status='ACTIVE' LIMIT 1`,
    [tokenHash],
  );
  if (!rows.length) return null;
  const device = toDevice(rows[0]!);
  if (!device.enabled) return null;
  await execute("UPDATE device_credentials SET last_used_at=? WHERE key_hash=? AND status='ACTIVE'", [currentTimestamp(), tokenHash]);
  return device;
}

export async function claimProvisioningToken(input: {
  token: string; uid: string; board: Board; firmwareVersion?: string; ip?: string | null;
}): Promise<{ deviceId: string; apiKey: string; heartbeatIntervalSeconds: number; config: Record<string, unknown> } | { error: string; status: number }> {
  const tokenHash = hashToken(input.token);
  const row = await queryOne(
    'SELECT * FROM device_provisioning WHERE token_hash=? AND claimed_at IS NULL AND expires_at>? LIMIT 1',
    [tokenHash, currentTimestamp()],
  );
  if (!row) return { error: 'Provisioning token is invalid, expired or already claimed.', status: 401 };
  const device = await getDeviceByUid(input.uid);
  if (!device) return { error: 'No device is registered with that UID.', status: 404 };
  if (rowText(row, 'device_id') !== device.id) return { error: 'Provisioning token does not belong to that device.', status: 403 };
  if (device.board !== input.board) return { error: `That token was issued for ${device.board}, not ${input.board}.`, status: 403 };

  const apiKey = `fgk_${crypto.randomBytes(24).toString('base64url')}`;
  const now = currentTimestamp();
  const tx = await turso.transaction('write');
  try {
    await tx.execute({
      sql: 'INSERT INTO device_credentials(id,device_id,key_hash,label,status,created_at) VALUES (?,?,?,?,?,?)',
      args: [randomId(), device.id, hashToken(apiKey), 'provisioned', 'ACTIVE', now],
    });
    await tx.execute({
      sql: "UPDATE device_provisioning SET claimed_at=?,claimed_ip=? WHERE id=? AND claimed_at IS NULL",
      args: [now, input.ip || null, rowText(row, 'id')],
    });
    await tx.execute({
      sql: 'UPDATE devices SET firmware_version=?,updated_at=? WHERE id=?',
      args: [input.firmwareVersion || device.firmwareVersion, now, device.id],
    });
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
  await insertAudit({
    tenantId: device.tenantId, action: 'DEVICE_PROVISIONED', targetType: 'device', targetId: device.id,
    metadata: { uid: device.uid, board: device.board, firmwareVersion: input.firmwareVersion || device.firmwareVersion },
  });
  return {
    deviceId: device.id,
    apiKey,
    heartbeatIntervalSeconds: device.heartbeatIntervalSeconds,
    config: device.config,
  };
}

export async function rotateDeviceCredential(deviceId: string, actorId: string | null): Promise<{ apiKey: string } | null> {
  const device = await getDevice(deviceId);
  if (!device) return null;
  const apiKey = `fgk_${crypto.randomBytes(24).toString('base64url')}`;
  const now = currentTimestamp();
  const tx = await turso.transaction('write');
  try {
    await tx.execute({ sql: "UPDATE device_credentials SET status='REVOKED',revoked_at=? WHERE device_id=? AND status='ACTIVE'", args: [now, deviceId] });
    await tx.execute({ sql: 'INSERT INTO device_credentials(id,device_id,key_hash,label,status,created_by,created_at) VALUES (?,?,?,?,?,?,?)', args: [randomId(), deviceId, hashToken(apiKey), 'rotated', 'ACTIVE', actorId, now] });
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
  await insertAudit({
    tenantId: device.tenantId, actorId, action: 'DEVICE_CREDENTIAL_ROTATED', targetType: 'device', targetId: deviceId,
    metadata: { uid: device.uid },
  });
  return { apiKey };
}

export async function revokeDeviceCredentials(deviceId: string, actorId: string | null): Promise<void> {
  const device = await getDevice(deviceId);
  if (!device) return;
  await execute("UPDATE device_credentials SET status='REVOKED',revoked_at=? WHERE device_id=? AND status='ACTIVE'", [currentTimestamp(), deviceId]);
  await insertAudit({ tenantId: device.tenantId, actorId, action: 'DEVICE_CREDENTIAL_REVOKED', targetType: 'device', targetId: deviceId, metadata: { uid: device.uid } });
}

export async function setDeviceApproval(deviceId: string, approval: ApprovalState, note: string, actorId: string | null): Promise<DeviceRecord | null> {
  const device = await getDevice(deviceId);
  if (!device) return null;
  const now = currentTimestamp();
  await execute('UPDATE devices SET approval_state=?,approval_note=?,approved_by=?,approved_at=?,updated_at=? WHERE id=?', [
    approval, note.slice(0, 500), actorId, approval === 'APPROVED' ? now : null, now, deviceId,
  ]);
  await insertAudit({
    tenantId: device.tenantId, actorId, action: approval === 'APPROVED' ? 'DEVICE_APPROVED' : approval === 'REJECTED' ? 'DEVICE_REJECTED' : 'DEVICE_APPROVAL_RESET',
    targetType: 'device', targetId: deviceId, metadata: { uid: device.uid, note: note.slice(0, 200) },
  });
  return getDevice(deviceId);
}

export async function setDeviceEnabled(deviceId: string, enabled: boolean, actorId: string | null): Promise<DeviceRecord | null> {
  const device = await getDevice(deviceId);
  if (!device) return null;
  await execute('UPDATE devices SET enabled=?,updated_at=? WHERE id=?', [enabled ? 1 : 0, currentTimestamp(), deviceId]);
  await insertAudit({
    tenantId: device.tenantId, actorId, action: enabled ? 'DEVICE_ENABLED' : 'DEVICE_DISABLED', targetType: 'device', targetId: deviceId,
    metadata: { uid: device.uid },
  });
  return getDevice(deviceId);
}

export async function updateDeviceConfig(deviceId: string, patch: Record<string, unknown>, actorId: string | null): Promise<Record<string, unknown>> {
  const device = await getDevice(deviceId);
  if (!device) throw new Error('Device not found.');
  const merged = { ...device.config, ...patch };
  await execute('UPDATE devices SET config_json=?,updated_at=? WHERE id=?', [JSON.stringify(merged), currentTimestamp(), deviceId]);
  await insertAudit({ tenantId: device.tenantId, actorId, action: 'DEVICE_CONFIG_UPDATED', targetType: 'device', targetId: deviceId, metadata: { keys: Object.keys(patch) } });
  return merged;
}

export async function deleteDevice(deviceId: string, actorId: string): Promise<boolean> {
  const device = await getDevice(deviceId);
  if (!device) return false;
  await execute('DELETE FROM devices WHERE id=?', [deviceId]);
  await insertAudit({ tenantId: device.tenantId, actorId, action: 'DEVICE_DELETED', targetType: 'device', targetId: deviceId, metadata: { uid: device.uid } });
  return true;
}

/** Payload encoded into the setup QR code. Contains no secrets: the token is single-use. */
export function provisioningQrPayload(token: string, uid: string, board: Board): string {
  return JSON.stringify({
    v: 1,
    type: 'floodgrid-provision',
    uid,
    board,
    token,
    apiBase: config.publicAppUrl || null,
    telemetryPath: '/api/v1/telemetry',
    provisionPath: '/api/v1/provision',
  });
}

export async function provisioningQrDataUrl(token: string, uid: string, board: Board): Promise<string> {
  return QRCode.toDataURL(provisioningQrPayload(token, uid, board), { errorCorrectionLevel: 'M', margin: 1, width: 320 });
}

export async function activeProvisioningToken(deviceId: string): Promise<{ token: string; expiresAt: string } | null> {
  const row = await queryOne('SELECT * FROM device_provisioning WHERE device_id=? AND claimed_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1', [deviceId, currentTimestamp()]);
  if (!row) return null;
  return { token: 'reissue-required', expiresAt: rowText(row, 'expires_at') };
}

export async function issueProvisioningToken(deviceId: string, actorId: string): Promise<{ token: string; expiresAt: string } | null> {
  const device = await getDevice(deviceId);
  if (!device) return null;
  const rawToken = crypto.randomBytes(24).toString('base64url');
  const now = currentTimestamp();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  await execute(
    "UPDATE device_provisioning SET expires_at=? WHERE device_id=? AND claimed_at IS NULL",
    [now, deviceId],
  );
  await execute('INSERT INTO device_provisioning(id,tenant_id,device_id,token_hash,board,created_by,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)', [
    randomId(), device.tenantId, deviceId, hashToken(rawToken), device.board, actorId, expiresAt, now,
  ]);
  await insertAudit({ tenantId: device.tenantId, actorId, action: 'DEVICE_PROVISIONING_TOKEN_ISSUED', targetType: 'device', targetId: deviceId, metadata: { uid: device.uid } });
  return { token: rawToken, expiresAt };
}

export async function deviceHealth(device: DeviceRecord): Promise<'ONLINE' | 'STALE' | 'OFFLINE' | 'DISABLED'> {
  if (!device.enabled) return 'DISABLED';
  const lastSeen = device.lastHeartbeatAt || device.lastSeenAt;
  if (!lastSeen) return 'OFFLINE';
  const ageSeconds = (Date.now() - new Date(lastSeen).getTime()) / 1000;
  if (ageSeconds <= device.heartbeatIntervalSeconds * 3) return 'ONLINE';
  if (ageSeconds <= device.heartbeatIntervalSeconds * 12) return 'STALE';
  return 'OFFLINE';
}

export async function latestTelemetry(deviceId: string, limit = 60) {
  const rows = await queryAll('SELECT * FROM telemetry WHERE device_id=? ORDER BY seq DESC LIMIT ?', [deviceId, limit]);
  return [...rows].reverse().map((row) => ({
    id: rowText(row, 'id'),
    deviceId: rowText(row, 'device_id'),
    seq: rowNumber(row, 'seq'),
    levelCm: rowNullableNumber(row, 'level_cm'),
    rainfallMm: rowNullableNumber(row, 'rainfall_mm'),
    state: rowText(row, 'state', 'NORMAL'),
    barrierState: rowText(row, 'barrier_state', 'DOWN'),
    sensorHealthy: rowBoolean(row, 'sensor_healthy'),
    rssi: rowNullableNumber(row, 'rssi'),
    batteryMv: rowNullableNumber(row, 'battery_mv'),
    rateCmPerMin: rowNullableNumber(row, 'rate_cm_per_min'),
    simulated: rowBoolean(row, 'simulated'),
    createdAt: rowText(row, 'created_at'),
  }));
}

export async function deviceListWithScope(tenantId: string) {
  const rows = await queryAll(
    `SELECT d.*, z.name AS zone_name, c.name AS city_name,
      (SELECT COUNT(*) FROM device_credentials c WHERE c.device_id=d.id AND c.status='ACTIVE') AS active_credentials
     FROM devices d JOIN zones z ON z.id=d.zone_id JOIN cities c ON c.id=d.city_id
     WHERE d.tenant_id=? ORDER BY d.created_at ASC`,
    [tenantId],
  );
  return Promise.all(rows.map(async (row) => {
    const device = toDevice(row);
    return {
      ...device,
      zoneName: rowText(row, 'zone_name'),
      cityName: rowText(row, 'city_name'),
      activeCredentials: rowNumber(row, 'active_credentials'),
      health: await deviceHealth(device),
    };
  }));
}

export async function verifyDeviceTokenForDevice(deviceId: string, token: string): Promise<boolean> {
  const row = await queryOne("SELECT key_hash FROM device_credentials WHERE device_id=? AND status='ACTIVE'", [deviceId]);
  if (!row) return false;
  return safeEqual(hashToken(token), rowText(row, 'key_hash'));
}

export async function tenantIdForDevice(deviceId: string): Promise<string | null> {
  const device = await getDevice(deviceId);
  return device ? device.tenantId : null;
}

export async function defaultZoneForTenant(tenantId: string): Promise<string | null> {
  const row = await queryOne('SELECT z.id FROM zones z JOIN cities c ON c.id=z.city_id WHERE c.tenant_id=? ORDER BY z.created_at LIMIT 1', [tenantId]);
  return row ? rowText(row, 'id') : null;
}

export { primaryTenantId };
