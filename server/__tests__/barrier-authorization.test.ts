import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { bootstrap, createOwner, registerTestDevice, resetDatabase } from './helpers.js';

/**
 * Barrier command authorization, nonce/timestamp replay protection, expiry and
 * acknowledgement idempotency.
 */

let deviceId = '';
let tenantId = '';
let otherDeviceId = '';

beforeEach(async () => {
  await bootstrap();
  await resetDatabase();
  await createOwner();
  const registered = await registerTestDevice({ name: 'Barrier node' });
  const other = await registerTestDevice({ name: 'Other barrier node' });
  deviceId = registered.device.id;
  otherDeviceId = other.device.id;
  tenantId = registered.device.tenantId;
});

describe('barrier command issuance', () => {
  it('issues a command with a unique id, nonce and short expiry', async () => {
    const { issueBarrierCommand, COMMAND_TTL_SECONDS } = await import('../commands.js');
    const command = await issueBarrierCommand({
      tenantId, zoneId: null, deviceId, action: 'RAISE', requestedBy: null, requestedByKind: 'USER', reason: 'test',
    });
    assert.match(command.commandId, /^[0-9a-f-]{36}$/);
    assert.equal(command.status, 'QUEUED');
    assert.equal(command.action, 'RAISE');
    assert.ok(command.nonce.length >= 16);
    const lifetime = (new Date(command.expiresAt).getTime() - new Date(command.issuedAt).getTime()) / 1000;
    assert.equal(lifetime, COMMAND_TTL_SECONDS);
  });

  it('uses a unique nonce for every command', async () => {
    const { issueBarrierCommand } = await import('../commands.js');
    const nonces = new Set<string>();
    for (let index = 0; index < 5; index += 1) {
      const command = await issueBarrierCommand({ tenantId, zoneId: null, deviceId, action: 'HOLD', requestedBy: null, requestedByKind: 'POLICY' });
      nonces.add(command.nonce);
    }
    assert.equal(nonces.size, 5);
  });

  it('audits every issued command', async () => {
    const { issueBarrierCommand } = await import('../commands.js');
    await issueBarrierCommand({ tenantId, zoneId: null, deviceId, action: 'LOWER', requestedBy: null, requestedByKind: 'USER' });
    const { queryAll } = await import('../database.js');
    const audit = await queryAll("SELECT * FROM audit_logs WHERE action='BARRIER_COMMAND_ISSUED'");
    assert.equal(audit.length, 1);
    const metadata = JSON.parse(String(audit[0]!.metadata_json));
    assert.equal(metadata.action, 'LOWER');
    assert.ok(String(metadata.nonce).endsWith('...'), 'the nonce must be truncated in the audit record');
  });
});

describe('command delivery and acknowledgement', () => {
  it('delivers each queued command exactly once', async () => {
    const { issueBarrierCommand, pendingCommandsForDevice } = await import('../commands.js');
    await issueBarrierCommand({ tenantId, zoneId: null, deviceId, action: 'RAISE', requestedBy: null, requestedByKind: 'POLICY' });
    const first = await pendingCommandsForDevice(deviceId);
    assert.equal(first.length, 1);
    assert.equal(first[0]!.action, 'RAISE');
    const second = await pendingCommandsForDevice(deviceId);
    assert.equal(second.length, 0, 'a delivered command must not be delivered again');
  });

  it('updates the device barrier state on acknowledgement', async () => {
    const { issueBarrierCommand, pendingCommandsForDevice, acknowledgeCommand } = await import('../commands.js');
    await issueBarrierCommand({ tenantId, zoneId: null, deviceId, action: 'RAISE', requestedBy: null, requestedByKind: 'POLICY' });
    const [command] = await pendingCommandsForDevice(deviceId);
    const acknowledged = await acknowledgeCommand({
      commandId: String(command!.commandId), deviceId, status: 'ACKNOWLEDGED',
      payload: { barrierState: 'RAISED', limitSwitchHigh: true },
    });
    assert.ok(acknowledged);
    assert.equal(acknowledged!.status, 'ACKNOWLEDGED');
    const { queryOne } = await import('../database.js');
    const device = await queryOne('SELECT barrier_state,barrier_latched,limit_switch_high FROM devices WHERE id=?', [deviceId]);
    assert.equal(String(device!.barrier_state), 'RAISED');
    assert.equal(Number(device!.barrier_latched), 1);
    assert.equal(Number(device!.limit_switch_high), 1);
  });

  it('ignores a duplicate acknowledgement (idempotent, no replay)', async () => {
    const { issueBarrierCommand, pendingCommandsForDevice, acknowledgeCommand } = await import('../commands.js');
    await issueBarrierCommand({ tenantId, zoneId: null, deviceId, action: 'RAISE', requestedBy: null, requestedByKind: 'POLICY' });
    const [command] = await pendingCommandsForDevice(deviceId);
    await acknowledgeCommand({ commandId: String(command!.commandId), deviceId, status: 'ACKNOWLEDGED' });
    const again = await acknowledgeCommand({ commandId: String(command!.commandId), deviceId, status: 'ACKNOWLEDGED' });
    assert.ok(again);
    assert.equal(again!.status, 'ACKNOWLEDGED');
    const { queryAll } = await import('../database.js');
    const commands = await queryAll('SELECT * FROM barrier_commands WHERE device_id=?', [deviceId]);
    assert.equal(commands.length, 1);
  });

  it('rejects an acknowledgement for an unknown command', async () => {
    const { acknowledgeCommand } = await import('../commands.js');
    const result = await acknowledgeCommand({ commandId: '00000000-0000-0000-0000-000000000000', deviceId, status: 'ACKNOWLEDGED' });
    assert.equal(result, null);
  });

  it('rejects an acknowledgement for another device', async () => {
    const { issueBarrierCommand, pendingCommandsForDevice, acknowledgeCommand } = await import('../commands.js');
    await issueBarrierCommand({ tenantId, zoneId: null, deviceId, action: 'RAISE', requestedBy: null, requestedByKind: 'POLICY' });
    const [command] = await pendingCommandsForDevice(deviceId);
    const result = await acknowledgeCommand({ commandId: String(command!.commandId), deviceId: otherDeviceId, status: 'ACKNOWLEDGED' });
    assert.equal(result, null);
  });

  it('expires stale commands automatically', async () => {
    const { issueBarrierCommand, expireStaleCommands } = await import('../commands.js');
    const { queryOne, execute } = await import('../database.js');
    await issueBarrierCommand({ tenantId, zoneId: null, deviceId, action: 'RAISE', requestedBy: null, requestedByKind: 'POLICY' });
    await execute('UPDATE barrier_commands SET expires_at=? WHERE device_id=?', ['2020-01-01T00:00:00.000Z', deviceId]);
    const expired = await expireStaleCommands();
    assert.equal(expired, 1);
    const command = await queryOne('SELECT status FROM barrier_commands WHERE device_id=?', [deviceId]);
    assert.equal(String(command!.status), 'EXPIRED');
  });

  it('cancels a queued command before delivery', async () => {
    const { issueBarrierCommand, cancelCommand } = await import('../commands.js');
    const command = await issueBarrierCommand({ tenantId, zoneId: null, deviceId, action: 'RAISE', requestedBy: null, requestedByKind: 'USER' });
    const cancelled = await cancelCommand(command.commandId, null);
    assert.ok(cancelled);
    assert.equal(cancelled!.status, 'CANCELLED');
  });
});

function user(patch: Partial<import('../rbac.js').AuthUser>): import('../rbac.js').AuthUser {
  return {
    id: 'u', email: 'u@example.org', displayName: 'User', role: 'MEMBER', tenantId: 'tenant-floodgrid',
    cityId: null, zoneId: null, serviceAreaId: null, emailVerified: true, phoneVerified: false,
    totpEnrolled: true, mfaVerified: true, sessionId: 's', disabled: false, ...patch,
  };
}

describe('authorization rules', () => {
  it('allows operators and admins in scope and denies members', async () => {
    const { canCommandBarrier } = await import('../rbac.js');
    const member = user({ id: 'u1' });
    const operator = user({ id: 'u2', role: 'OPERATOR' });
    const localAdmin = user({ id: 'u3', role: 'ADMIN', zoneId: 'zone-north-bank' });
    const otherAdmin = user({ id: 'u4', role: 'ADMIN', zoneId: 'zone-thames' });
    const owner = user({ id: 'u5', role: 'OWNER' });
    const scope = { zoneId: 'zone-north-bank', cityId: 'city-dhaka' };
    assert.equal(canCommandBarrier(member, scope), false);
    assert.equal(canCommandBarrier(operator, scope), false);
    assert.equal(canCommandBarrier(localAdmin, scope), true);
    assert.equal(canCommandBarrier(otherAdmin, scope), false);
    assert.equal(canCommandBarrier(owner, scope), true);
  });

  it('scopes local admins to their own city or site', async () => {
    const { inAdminScope } = await import('../rbac.js');
    const localAdmin = user({ id: 'u3', role: 'ADMIN', cityId: 'city-dhaka', zoneId: 'zone-north-bank' });
    assert.equal(inAdminScope(localAdmin, { zoneId: 'zone-north-bank' }), true);
    assert.equal(inAdminScope(localAdmin, { zoneId: 'zone-riverside' }), false);
    assert.equal(inAdminScope(localAdmin, { cityId: 'city-dhaka' }), true);
    assert.equal(inAdminScope(localAdmin, { cityId: 'city-london' }), false);
    const owner = user({ id: 'u5', role: 'OWNER' });
    assert.equal(inAdminScope(owner, { cityId: 'city-london' }), true);
  });
});
