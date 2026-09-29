import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { bootstrap, createOwner, registerTestDevice, resetDatabase, telemetryPayload } from './helpers.js';
import { rowText } from '../database.js';

/**
 * End-to-end flood pipeline: telemetry -> policy evaluation -> persisted event
 * -> policy barrier command -> notification fan-out -> audit trail.
 */

let deviceId = '';
let apiKey = '';

async function ingest(seq: number, levelCm: number, extra: Record<string, unknown> = {}) {
  const { ingestTelemetry } = await import('../telemetry.js');
  const { authenticateDeviceToken } = await import('../devices.js');
  const device = (await authenticateDeviceToken(apiKey))!;
  return ingestTelemetry(device, await telemetryPayload(deviceId, seq, levelCm, extra));
}

beforeEach(async () => {
  const db = await bootstrap();
  await resetDatabase();
  await createOwner();
  // Single-sample confirmation and no cooldown so a fast scenario can be
  // observed inside one test. The seeded zone policy asks for two confirming
  // samples, which the dedicated confirmation tests exercise.
  await db.execute('UPDATE flood_policies SET confirmation_samples=1, cooldown_seconds=0');
  const devices = await import('../devices.js');
  const registered = await registerTestDevice({ name: 'Pipeline node' });
  const claimed = (await devices.claimProvisioningToken({
    token: registered.provisioningToken, uid: registered.device.uid, board: 'ESP32',
  })) as { apiKey: string };
  deviceId = registered.device.id;
  apiKey = claimed.apiKey;
});

describe('flood pipeline', () => {
  it('persists telemetry and escalates through every state', async () => {
    const sequence = [10, 26, 41, 60, 41, 30, 15];
    const states: string[] = [];
    for (const [index, level] of sequence.entries()) {
      const result = await ingest(index + 1, level);
      states.push(result.state);
    }
    assert.deepEqual(states, ['NORMAL', 'WATCH', 'WARNING', 'CRITICAL', 'WARNING', 'WATCH', 'RECOVERY']);

    const { queryAll } = await import('../database.js');
    const telemetryRows = await queryAll('SELECT * FROM telemetry WHERE device_id=? ORDER BY seq', [deviceId]);
    assert.equal(telemetryRows.length, sequence.length);
    const events = await queryAll('SELECT * FROM flood_events WHERE device_id=? ORDER BY created_at', [deviceId]);
    assert.equal(events.length, 6, 'six transitions must be recorded');
    assert.equal(String(events[0]!.to_state), 'WATCH');
    assert.equal(String(events[2]!.to_state), 'CRITICAL');
    assert.equal(String(events[5]!.to_state), 'RECOVERY');
  });

  it('writes an audit record for every transition', async () => {
    await ingest(1, 10);
    await ingest(2, 60);
    const { queryAll } = await import('../database.js');
    const audit = await queryAll("SELECT * FROM audit_logs WHERE action='FLOOD_STATE_TRANSITION' AND target_id=?", [deviceId]);
    assert.equal(audit.length, 1);
    const metadata = JSON.parse(String(audit[0]!.metadata_json));
    assert.equal(metadata.from, 'NORMAL');
    assert.equal(metadata.to, 'CRITICAL');
  });

  it('issues a policy barrier command with a nonce and expiry on WARNING and CRITICAL', async () => {
    await ingest(1, 10);
    const escalated = await ingest(2, 60);
    assert.ok(escalated.commandId, 'a command id must be returned');
    const { queryOne } = await import('../database.js');
    const command = await queryOne('SELECT * FROM barrier_commands WHERE command_id=?', [escalated.commandId!]);
    assert.ok(command);
    assert.equal(String(command!.action), 'RAISE');
    assert.equal(String(command!.requested_by_kind), 'POLICY');
    assert.equal(String(command!.status), 'QUEUED');
    assert.match(String(command!.nonce), /^[A-Za-z0-9_-]{16,}$/);
    assert.ok(new Date(String(command!.expires_at)).getTime() > Date.now());
  });

  it('does not issue a command for WATCH', async () => {
    await ingest(1, 10);
    const watch = await ingest(2, 30);
    assert.equal(watch.state, 'WATCH');
    assert.equal(watch.commandId, null);
  });

  it('prevents duplicate flood events for the same sample and state', async () => {
    const { queryAll, queryOne, execute } = await import('../database.js');
    await ingest(1, 10);
    await ingest(2, 60);
    const before = (await queryAll('SELECT * FROM flood_events WHERE device_id=?', [deviceId])).length;
    assert.ok(before >= 1, 'the escalation produced an event');
    // The event key is `<device>:<seq>:<state>`, so replaying the same sample
    // and state must be rejected by the unique constraint instead of counted
    // twice.
    const existing = await queryOne('SELECT event_key FROM flood_events WHERE device_id=? LIMIT 1', [deviceId]);
    assert.ok(existing, 'an event key exists');
    const violation = await execute(
      `INSERT INTO flood_events(id,tenant_id,zone_id,device_id,event_key,from_state,to_state,level_cm,trigger,reason,simulated,created_at)
       VALUES ('dup-test','tenant-floodgrid',NULL,?,?,'NORMAL','NORMAL',1,'THRESHOLD','',0,'2026-01-01T00:00:00.000Z')`,
      [deviceId, rowText(existing!, 'event_key')],
    ).then(() => null).catch((error: { code?: string }) => error.code);
    assert.ok(violation && String(violation).includes('SQLITE_CONSTRAINT'), 'duplicate event keys must be rejected');
    const after = (await queryAll('SELECT * FROM flood_events WHERE device_id=?', [deviceId])).length;
    assert.equal(after, before, 'no duplicate event was added');
  });

  it('records the rate of rise and stores it with the sample', async () => {
    await ingest(1, 10);
    const second = await ingest(2, 40);
    assert.notEqual(second.rateCmPerMin, null);
    const { queryOne } = await import('../database.js');
    const row = await queryOne('SELECT rate_cm_per_min FROM telemetry WHERE device_id=? AND seq=2', [deviceId]);
    assert.ok(row);
    assert.ok(Number(row.rate_cm_per_min) !== 0);
  });

  it('labels simulation telemetry, events and commands', async () => {
    const result = await ingest(1, 60, { simulated: true });
    assert.equal(result.simulated, true);
    const { queryAll } = await import('../database.js');
    const telemetryRow = await queryAll('SELECT simulated FROM telemetry WHERE device_id=?', [deviceId]);
    assert.equal(Number(telemetryRow[0]!.simulated), 1);
    const events = await queryAll('SELECT simulated FROM flood_events WHERE device_id=?', [deviceId]);
    assert.equal(Number(events[0]!.simulated), 1);
  });

  it('holds the barrier position on a sensor fault', async () => {
    await ingest(1, 60);
    const fault = await ingest(2, 62, { sensorHealthy: false });
    assert.equal(fault.state, 'CRITICAL', 'the previous state is latched while the sensor is unhealthy');
    assert.equal(fault.barrier, 'HOLD', 'the barrier holds its position instead of moving on bad data');
    const { queryOne } = await import('../database.js');
    const device = await queryOne('SELECT fault_state, barrier_state, barrier_latched FROM devices WHERE id=?', [deviceId]);
    assert.equal(String(device!.fault_state), 'SENSOR_FAULT');
    assert.equal(Number(device!.barrier_latched), 1, 'the raised barrier stays latched through the fault');
  });

  it('marks the barrier FAULT on an emergency stop', async () => {
    const result = await ingest(1, 30, { emergencyStopActive: true, barrierState: 'FAULT' });
    assert.equal(result.barrier, 'FAULT');
    const { queryOne } = await import('../database.js');
    const device = await queryOne('SELECT emergency_stop_active FROM devices WHERE id=?', [deviceId]);
    assert.equal(Number(device!.emergency_stop_active), 1);
  });

  it('waits for the configured number of confirming samples before escalating', async () => {
    const { execute, queryAll } = await import('../database.js');
    await execute('UPDATE flood_policies SET confirmation_samples=2, cooldown_seconds=0');
    const sequence = [10, 30, 45, 45];
    const states: string[] = [];
    for (const [index, level] of sequence.entries()) {
      const result = await ingest(index + 1, level);
      states.push(result.state);
    }
    // 30 cm and 45 cm are each above the 22 cm watch threshold, but a single
    // sample is not enough; the second 45 cm sample confirms the escalation.
    assert.deepEqual(states, ['NORMAL', 'NORMAL', 'NORMAL', 'WARNING']);
    const events = await queryAll('SELECT to_state FROM flood_events WHERE device_id=?', [deviceId]);
    assert.equal(events.length, 1, 'only the confirmed escalation is recorded');
    assert.equal(String(events[0]!.to_state), 'WARNING');
  });

  it('accepts confirmation from a second device in the same zone', async () => {
    const { execute } = await import('../database.js');
    const devices = await import('../devices.js');
    await execute('UPDATE flood_policies SET confirmation_samples=2, cooldown_seconds=0');
    const second = await registerTestDevice({ name: 'Second node' });
    const claimed = (await devices.claimProvisioningToken({
      token: second.provisioningToken, uid: second.device.uid, board: 'ESP32',
    })) as { apiKey: string };
    const secondDevice = (await devices.authenticateDeviceToken(claimed.apiKey))!;
    const { ingestTelemetry } = await import('../telemetry.js');
    await ingestTelemetry(secondDevice, await telemetryPayload(second.device.id, 1, 44));
    const result = await ingest(1, 44);
    assert.equal(result.state, 'WARNING', 'a second device reporting above the threshold confirms the escalation');
  });
});
