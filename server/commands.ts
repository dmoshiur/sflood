/**
 * Remote barrier command channel.
 *
 * Commands are created by authenticated, authorized operators, delivered to
 * devices over the device-key-authenticated API, and acknowledged exactly once.
 *
 * Replay protection:
 *  - every command carries a server-generated nonce (only its hash is stored);
 *  - commands expire after a short TTL and are marked EXPIRED by the sweeper;
 *  - acknowledgements must echo the nonce and are accepted only once;
 *  - a device never executes an expired command (local fail-safe, see docs/WIRING.md).
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import { execute, insertAudit, isTursoConfigured, randomId, rowText, DatabaseRequestError } from './database.js';
import { decryptSecret, encryptSecret, hashToken, safeEqual } from './security.js';

export const COMMAND_ACTIONS = ['BARRIER_RAISE', 'BARRIER_LOWER', 'BARRIER_HOLD', 'HEALTH_CHECK', 'SYNC_TIME'] as const;
export type CommandAction = (typeof COMMAND_ACTIONS)[number];

const COMMAND_TTL_SECONDS = 120;

export const createCommandSchema = z.object({
  action: z.enum(COMMAND_ACTIONS),
  /** Optional client-supplied idempotency key; the server still generates the nonce. */
  idempotencyKey: z.string().min(8).max(128).optional(),
});

export const ackCommandSchema = z.object({
  nonce: z.string().min(16).max(128),
  status: z.enum(['OK', 'FAILED']),
  limitSwitchState: z.enum(['OPEN', 'CLOSED', 'UNKNOWN', 'TRAVELING']).optional(),
  result: z.string().max(500).optional(),
  failureReason: z.string().max(500).optional(),
});

export interface CreatedCommand {
  id: string;
  deviceId: string;
  action: CommandAction;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  status: 'QUEUED';
}

/** Create a command. The plaintext nonce is returned once for delivery to the device. */
export async function createBarrierCommand(input: {
  deviceId: string;
  action: CommandAction;
  requestedBy: string | null;
  tenantId: string;
  simulation?: boolean;
}): Promise<CreatedCommand> {
  if (!isTursoConfigured) throw new DatabaseRequestError(503, 'Remote commands require the database-backed deployment.');
  const device = await execute('SELECT id,kind,enabled,approval_state FROM devices WHERE id=?', [input.deviceId]);
  if (!device.rows.length) throw new DatabaseRequestError(404, 'Device not found.');
  const row = device.rows[0] as Record<string, unknown>;
  if (!(row.enabled === true || Number(row.enabled) === 1)) throw new DatabaseRequestError(409, 'Device is disabled; enable it before sending commands.');
  if (rowText(row, 'approval_state') === 'PENDING') throw new DatabaseRequestError(409, 'Device is not approved yet; approve it before sending commands.');
  if (rowText(row, 'approval_state') === 'REVOKED') throw new DatabaseRequestError(409, 'Device credentials were revoked.');
  if (rowText(row, 'kind') === 'ESP8266_SENDER' && input.action.startsWith('BARRIER_')) {
    throw new DatabaseRequestError(409, 'Sender nodes have no actuator. Barrier commands can only target an ESP32 controller.');
  }
  const nonce = crypto.randomBytes(18).toString('base64url');
  const id = randomId();
  const now = Date.now();
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + COMMAND_TTL_SECONDS * 1000).toISOString();
  await execute(
    `INSERT INTO barrier_commands(id,device_id,action,nonce_hash,sealed_nonce,issued_at,expires_at,status,requested_by,created_at)
     VALUES(?,?,?,?,?,?,?, 'QUEUED',?,?)`,
    [id, input.deviceId, input.action, hashToken(nonce), encryptSecret(nonce), issuedAt, expiresAt, input.requestedBy, issuedAt],
  );
  await insertAudit({
    tenantId: input.tenantId,
    actorId: input.requestedBy,
    action: 'BARRIER_COMMAND_CREATED',
    targetType: 'device',
    targetId: input.deviceId,
    metadata: { commandId: id, action: input.action, expiresAt, simulation: Boolean(input.simulation) },
  });
  return { id, deviceId: input.deviceId, action: input.action, nonce, issuedAt, expiresAt, status: 'QUEUED' };
}

/** Commands waiting for a device, marked DELIVERED on read. */
export async function pollPendingCommands(deviceId: string, now = Date.now()): Promise<Array<{ id: string; action: CommandAction; nonce: string; issuedAt: string; expiresAt: string }>> {
  if (!isTursoConfigured) return [];
  const iso = new Date(now).toISOString();
  await execute("UPDATE barrier_commands SET status='EXPIRED' WHERE device_id=? AND status IN ('QUEUED','DELIVERED') AND expires_at<=?", [deviceId, iso]);
  const result = await execute(
    "SELECT id,action,sealed_nonce,issued_at,expires_at FROM barrier_commands WHERE device_id=? AND status='QUEUED' AND expires_at>? ORDER BY created_at ASC LIMIT 10",
    [deviceId, iso],
  );
  // Only the encrypted nonce is stored at rest (plus its SHA-256 hash for ack
  // verification). The plaintext nonce is returned to the device over the
  // device-key-authenticated channel so it can be echoed back exactly once.
  const commands: Array<{ id: string; action: CommandAction; nonce: string; issuedAt: string; expiresAt: string }> = [];
  for (const raw of result.rows) {
    const row = raw as Record<string, unknown>;
    let nonce = '';
    try { nonce = decryptSecret(rowText(row, 'sealed_nonce')); } catch { continue; }
    commands.push({
      id: rowText(row, 'id'),
      action: rowText(row, 'action') as CommandAction,
      nonce,
      issuedAt: rowText(row, 'issued_at'),
      expiresAt: rowText(row, 'expires_at'),
    });
  }
  await execute("UPDATE barrier_commands SET status='DELIVERED',delivered_at=? WHERE device_id=? AND status='QUEUED'", [iso, deviceId]);
  return commands;
}

/** One-time acknowledgement with nonce echo (replay protection) and limit-switch feedback. */
export async function acknowledgeCommand(input: {
  deviceId: string;
  commandId: string;
  nonce: string;
  status: 'OK' | 'FAILED';
  limitSwitchState?: string;
  result?: string;
  failureReason?: string;
  tenantId: string;
}): Promise<{ acknowledged: true; status: string }> {
  if (!isTursoConfigured) throw new DatabaseRequestError(503, 'Command acknowledgement requires the database-backed deployment.');
  const rows = await execute('SELECT id,nonce_hash,status,expires_at,device_id FROM barrier_commands WHERE id=?', [input.commandId]);
  if (!rows.rows.length) throw new DatabaseRequestError(404, 'Command not found.');
  const row = rows.rows[0] as Record<string, unknown>;
  if (rowText(row, 'device_id') !== input.deviceId) throw new DatabaseRequestError(403, 'Command belongs to a different device.');
  const status = rowText(row, 'status');
  if (status === 'ACKNOWLEDGED') throw new DatabaseRequestError(409, 'Command was already acknowledged (replay rejected).');
  if (status === 'EXPIRED' || status === 'CANCELED') throw new DatabaseRequestError(409, `Command is ${status.toLowerCase()} and cannot be acknowledged.`);
  if (new Date(rowText(row, 'expires_at')).getTime() <= Date.now()) {
    await execute("UPDATE barrier_commands SET status='EXPIRED',failure_reason='expired before acknowledgement' WHERE id=?", [input.commandId]);
    throw new DatabaseRequestError(409, 'Command expired before acknowledgement.');
  }
  if (!safeEqual(hashToken(input.nonce), rowText(row, 'nonce_hash'))) {
    throw new DatabaseRequestError(403, 'Command nonce mismatch; possible replay attempt.');
  }
  const nowIso = new Date().toISOString();
  await execute(
    `UPDATE barrier_commands SET status='ACKNOWLEDGED',acknowledged_at=?,ack_nonce_hash=?,result=?,limit_switch_state=?,failure_reason=? WHERE id=? AND status<>'ACKNOWLEDGED'`,
    [nowIso, hashToken(input.nonce), input.result || null, input.limitSwitchState || null, input.failureReason || null, input.commandId],
  );
  if (input.limitSwitchState) {
    await execute('UPDATE devices SET limit_switch_state=?,updated_at=? WHERE id=?', [input.limitSwitchState, nowIso, input.deviceId]);
  }
  await insertAudit({
    tenantId: input.tenantId,
    action: 'BARRIER_COMMAND_ACKNOWLEDGED',
    targetType: 'device',
    targetId: input.deviceId,
    metadata: { commandId: input.commandId, status: input.status, limitSwitchState: input.limitSwitchState || null },
  });
  return { acknowledged: true, status: input.status };
}

/** Expire stale commands; called by the background worker. */
export async function sweepExpiredCommands(now = Date.now()): Promise<void> {
  if (!isTursoConfigured) return;
  await execute("UPDATE barrier_commands SET status='EXPIRED',failure_reason='expired without acknowledgement' WHERE status IN ('QUEUED','DELIVERED') AND expires_at<=?", [new Date(now).toISOString()]);
}

export interface CommandView {
  id: string;
  deviceId: string;
  action: CommandAction;
  status: string;
  issuedAt: string;
  expiresAt: string;
  acknowledgedAt: string | null;
  result: string | null;
  limitSwitchState: string | null;
  failureReason: string | null;
  requestedBy: string | null;
}

export async function listDeviceCommands(deviceId: string, limit = 25): Promise<CommandView[]> {
  if (!isTursoConfigured) return [];
  const result = await execute('SELECT * FROM barrier_commands WHERE device_id=? ORDER BY created_at DESC LIMIT ?', [deviceId, limit]);
  return result.rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      id: rowText(row, 'id'),
      deviceId: rowText(row, 'device_id'),
      action: rowText(row, 'action') as CommandAction,
      status: rowText(row, 'status'),
      issuedAt: rowText(row, 'issued_at'),
      expiresAt: rowText(row, 'expires_at'),
      acknowledgedAt: rowText(row, 'acknowledged_at') || null,
      result: rowText(row, 'result') || null,
      limitSwitchState: rowText(row, 'limit_switch_state') || null,
      failureReason: rowText(row, 'failure_reason') || null,
      requestedBy: rowText(row, 'requested_by') || null,
    };
  });
}
