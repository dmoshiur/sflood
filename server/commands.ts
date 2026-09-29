import crypto from 'node:crypto';
import type { Client, Transaction } from '@libsql/client';
import {
  currentTimestamp, execute, insertAudit, queryAll, queryOne, randomId, rowBoolean, rowText, turso,
} from './database.js';
import { createCommandNonce } from './security.js';

/**
 * Barrier command channel.
 *
 * Every command carries:
 *   - a unique command id (used for idempotency and acknowledgement)
 *   - a single-use nonce (replay protection)
 *   - an issue timestamp and a short expiry
 *
 * A device polls for pending commands, executes them locally and acknowledges
 * them. Commands are never executed by the cloud: the controller makes the final
 * safety decision and keeps a local fail-safe if the link is down.
 */

export type BarrierAction = 'RAISE' | 'LOWER' | 'HOLD' | 'EMERGENCY_STOP' | 'RESET_FAULT';
export type CommandStatus = 'QUEUED' | 'DELIVERED' | 'ACKNOWLEDGED' | 'FAILED' | 'EXPIRED' | 'CANCELLED' | 'REJECTED';

const COMMAND_TTL_SECONDS = 120;

export interface BarrierCommand {
  id: string;
  commandId: string;
  deviceId: string;
  action: BarrierAction;
  status: CommandStatus;
  requestedBy: string | null;
  requestedByKind: string;
  reason: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  acknowledgedAt: string | null;
  createdAt: string;
}

function toCommand(row: Record<string, unknown>): BarrierCommand {
  return {
    id: rowText(row, 'id'),
    commandId: rowText(row, 'command_id'),
    deviceId: rowText(row, 'device_id'),
    action: rowText(row, 'action') as BarrierAction,
    status: rowText(row, 'status') as CommandStatus,
    requestedBy: rowText(row, 'requested_by') || null,
    requestedByKind: rowText(row, 'requested_by_kind', 'USER'),
    reason: rowText(row, 'reason'),
    nonce: rowText(row, 'nonce'),
    issuedAt: rowText(row, 'issued_at'),
    expiresAt: rowText(row, 'expires_at'),
    acknowledgedAt: rowText(row, 'acknowledged_at') || null,
    createdAt: rowText(row, 'created_at'),
  };
}

export async function issueBarrierCommand(input: {
  tenantId: string; zoneId: string | null; deviceId: string; action: BarrierAction;
  requestedBy: string | null; requestedByKind?: string; reason?: string; ttlSeconds?: number;
}, executor: Client | Transaction = turso): Promise<BarrierCommand> {
  const id = randomId();
  const commandId = crypto.randomUUID();
  const nonce = createCommandNonce();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlSeconds ?? COMMAND_TTL_SECONDS) * 1000);
  await execute(
    `INSERT INTO barrier_commands(id,command_id,tenant_id,zone_id,device_id,action,requested_by,requested_by_kind,reason,nonce,issued_at,expires_at,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'QUEUED',?)`,
    [id, commandId, input.tenantId, input.zoneId, input.deviceId, input.action, input.requestedBy, input.requestedByKind || 'USER', (input.reason || '').slice(0, 500), nonce, now.toISOString(), expiresAt.toISOString(), currentTimestamp()],
    executor,
  );
  await insertAudit({
    tenantId: input.tenantId, actorId: input.requestedBy, action: 'BARRIER_COMMAND_ISSUED', targetType: 'device', targetId: input.deviceId,
    metadata: { commandId, action: input.action, nonce: `${nonce.slice(0, 6)}...`, expiresAt: expiresAt.toISOString() },
  }, executor);
  // The command is returned from the values that were written rather than read
  // back: when a transaction is passed the insert is not visible to the main
  // connection until it commits.
  return {
    id, commandId, deviceId: input.deviceId, action: input.action, status: 'QUEUED',
    requestedBy: input.requestedBy, requestedByKind: input.requestedByKind || 'USER',
    reason: (input.reason || '').slice(0, 500), nonce,
    issuedAt: now.toISOString(), expiresAt: expiresAt.toISOString(),
    acknowledgedAt: null, createdAt: currentTimestamp(),
  };
}

/** Commands waiting for a device. Marks them DELIVERED so they are not repeated. */
export async function pendingCommandsForDevice(deviceId: string): Promise<Array<Record<string, unknown>>> {
  const now = currentTimestamp();
  const rows = await queryAll(
    "SELECT * FROM barrier_commands WHERE device_id=? AND status='QUEUED' AND expires_at>? ORDER BY issued_at ASC LIMIT 5",
    [deviceId, now],
  );
  const commands: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const claimed = await execute(
      "UPDATE barrier_commands SET status='DELIVERED' WHERE id=? AND status='QUEUED'",
      [rowText(row, 'id')],
    );
    if (claimed.rowsAffected !== 1) continue;
    commands.push({
      commandId: rowText(row, 'command_id'),
      action: rowText(row, 'action'),
      nonce: rowText(row, 'nonce'),
      issuedAt: rowText(row, 'issued_at'),
      expiresAt: rowText(row, 'expires_at'),
      reason: rowText(row, 'reason'),
    });
  }
  return commands;
}

export async function acknowledgeCommand(input: {
  commandId: string; deviceId: string; status: 'ACKNOWLEDGED' | 'FAILED'; payload?: Record<string, unknown>;
}): Promise<BarrierCommand | null> {
  const row = await queryOne('SELECT * FROM barrier_commands WHERE command_id=? AND device_id=? LIMIT 1', [input.commandId, input.deviceId]);
  if (!row) return null;
  const now = currentTimestamp();
  if (new Date(rowText(row, 'expires_at')).getTime() <= Date.now()) {
    await execute("UPDATE barrier_commands SET status='EXPIRED' WHERE id=? AND status IN ('QUEUED','DELIVERED')", [rowText(row, 'id')]);
    return null;
  }
  if (rowText(row, 'status') === 'ACKNOWLEDGED' || rowText(row, 'status') === 'FAILED') {
    // Duplicate acknowledgement is ignored (idempotent) and never re-executes.
    return toCommand(row);
  }
  await execute(
    "UPDATE barrier_commands SET status=?,acknowledged_at=?,ack_payload_json=? WHERE id=? AND status IN ('QUEUED','DELIVERED')",
    [input.status, now, JSON.stringify(input.payload ?? {}), rowText(row, 'id')],
  );
  const device = await queryOne(
    'SELECT tenant_id,barrier_state,barrier_latched,emergency_stop_active,limit_switch_low,limit_switch_high FROM devices WHERE id=?',
    [input.deviceId],
  );
  if (device && input.status === 'ACKNOWLEDGED') {
    const action = rowText(row, 'action');
    const payload = input.payload ?? {};
    // The controller reports what it actually did; that wins over what was asked.
    const reportedBarrier = typeof payload.barrierState === 'string' ? payload.barrierState : null;
    const commandedBarrier = action === 'RAISE' ? 'RAISED'
      : action === 'LOWER' ? 'DOWN'
      : action === 'HOLD' ? 'HOLD'
      : action === 'EMERGENCY_STOP' ? 'FAULT'
      : action === 'RESET_FAULT' ? 'HOLD'
      : null;
    const barrierState = reportedBarrier || commandedBarrier || rowText(device, 'barrier_state', 'DOWN');
    const raised = barrierState === 'RAISED' || barrierState === 'RAISING';
    const latched = raised ? 1 : barrierState === 'DOWN' ? 0 : rowBoolean(device, 'barrier_latched') ? 1 : 0;
    const emergencyStop = typeof payload.emergencyStopActive === 'boolean'
      ? (payload.emergencyStopActive ? 1 : 0)
      : action === 'EMERGENCY_STOP' ? 1 : action === 'RESET_FAULT' ? 0 : rowBoolean(device, 'emergency_stop_active') ? 1 : 0;
    const limitLow = typeof payload.limitSwitchLow === 'boolean'
      ? (payload.limitSwitchLow ? 1 : 0)
      : rowBoolean(device, 'limit_switch_low') ? 1 : 0;
    const limitHigh = typeof payload.limitSwitchHigh === 'boolean'
      ? (payload.limitSwitchHigh ? 1 : 0)
      : rowBoolean(device, 'limit_switch_high') ? 1 : 0;
    await execute(
      'UPDATE devices SET barrier_state=?,barrier_latched=?,emergency_stop_active=?,limit_switch_low=?,limit_switch_high=?,updated_at=? WHERE id=?',
      [barrierState, latched, emergencyStop, limitLow, limitHigh, now, input.deviceId],
    );
  }
  await insertAudit({
    tenantId: device ? rowText(device, 'tenant_id') : 'unknown', action: input.status === 'ACKNOWLEDGED' ? 'BARRIER_COMMAND_ACKNOWLEDGED' : 'BARRIER_COMMAND_FAILED',
    targetType: 'device', targetId: input.deviceId, metadata: { commandId: input.commandId, action: rowText(row, 'action') },
  });
  const updated = await queryOne('SELECT * FROM barrier_commands WHERE id=?', [rowText(row, 'id')]);
  return updated ? toCommand(updated) : null;
}

export async function cancelCommand(commandId: string, actorId: string | null): Promise<BarrierCommand | null> {
  const row = await queryOne("SELECT * FROM barrier_commands WHERE command_id=? AND status IN ('QUEUED','DELIVERED') LIMIT 1", [commandId]);
  if (!row) return null;
  await execute("UPDATE barrier_commands SET status='CANCELLED' WHERE id=?", [rowText(row, 'id')]);
  await insertAudit({
    tenantId: rowText(row, 'tenant_id'), actorId, action: 'BARRIER_COMMAND_CANCELLED', targetType: 'device',
    targetId: rowText(row, 'device_id'), metadata: { commandId, action: rowText(row, 'action') },
  });
  const updated = await queryOne('SELECT * FROM barrier_commands WHERE id=?', [rowText(row, 'id')]);
  return updated ? toCommand(updated) : null;
}

export async function expireStaleCommands(): Promise<number> {
  const result = await execute(
    "UPDATE barrier_commands SET status='EXPIRED' WHERE status IN ('QUEUED','DELIVERED') AND expires_at<=?",
    [currentTimestamp()],
  );
  return result.rowsAffected;
}

export async function listCommands(filter: { deviceId?: string; zoneId?: string; limit?: number } = {}): Promise<BarrierCommand[]> {
  const clauses: string[] = [];
  const args: (string | number)[] = [];
  if (filter.deviceId) { clauses.push('device_id=?'); args.push(filter.deviceId); }
  if (filter.zoneId) { clauses.push('zone_id=?'); args.push(filter.zoneId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  args.push(filter.limit ?? 100);
  const rows = await queryAll(`SELECT * FROM barrier_commands ${where} ORDER BY issued_at DESC LIMIT ?`, args);
  return rows.map(toCommand);
}

export async function getCommand(commandId: string): Promise<BarrierCommand | null> {
  const row = await queryOne('SELECT * FROM barrier_commands WHERE command_id=?', [commandId]);
  return row ? toCommand(row) : null;
}

/** Replay protection helper: reject any acknowledgement whose nonce was already used. */
export async function wasNonceUsed(nonce: string): Promise<boolean> {
  const row = await queryOne("SELECT id FROM barrier_commands WHERE nonce=? AND status IN ('ACKNOWLEDGED','FAILED') LIMIT 1", [nonce]);
  return Boolean(row);
}

export async function commandStats() {
  const row = await queryOne(
    "SELECT SUM(CASE WHEN status='QUEUED' THEN 1 ELSE 0 END) AS queued, SUM(CASE WHEN status='ACKNOWLEDGED' THEN 1 ELSE 0 END) AS acknowledged, SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) AS failed FROM barrier_commands",
  );
  return { queued: Number(row?.queued || 0), acknowledged: Number(row?.acknowledged || 0), failed: Number(row?.failed || 0) };
}

export { COMMAND_TTL_SECONDS };
