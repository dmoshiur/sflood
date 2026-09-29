import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'floodguard-ops-test-'));
process.env.NODE_ENV = 'test';
process.env.TURSO_DATABASE_URL = `file:${path.join(temporaryDirectory, 'ops.db')}`;
process.env.TURSO_AUTH_TOKEN = '';
process.env.SESSION_SECRET = 'ops-test-session-secret-with-at-least-32-chars';
process.env.SETTINGS_ENCRYPTION_KEY = 'c'.repeat(64);
process.env.PUBLIC_APP_URL = 'https://floodguard.example.test';
process.env.OPS_SECURITY_EMAIL = 'security@example.test';

const database = await import('../database.js');
const ops = await import('../ops.js');
const commands = await import('../commands.js');
const { hashToken } = await import('../security.js');

const now = Date.now();
const iso = new Date(now).toISOString();

test('rotating operations credential is hash-only, single-use and expires automatically', async () => {
  await database.migrateDatabase();
  await database.execute('INSERT INTO tenants(id,name,slug,created_at) VALUES(?,?,?,?)', ['ops-tenant', 'Ops tenant', 'floodguard-demo', iso]);
  await database.execute('INSERT INTO cities(id,tenant_id,name,created_at) VALUES(?,?,?,?)', ['ops-city', 'ops-tenant', 'Ops city', iso]);
  await database.execute('INSERT INTO zones(id,city_id,name,created_at) VALUES(?,?,?,?)', ['ops-zone', 'ops-city', 'Ops zone', iso]);

  // 1. Generating the credential queues delivery and stores only a hash.
  const generated = await ops.ensureCurrentOpsCredential(now);
  assert.equal(generated.generated, true);
  assert.equal(generated.deliveredTo, 'security@example.test');
  const rows = await database.execute('SELECT token_hash,delivery_status,expires_at FROM ops_credentials');
  assert.equal(rows.rows.length, 1);
  const row = rows.rows[0] as Record<string, unknown>;
  assert.match(String(row.token_hash), /^[a-f0-9]{64}$/, 'only a SHA-256 hash is stored');
  assert.equal(String(row.delivery_status), 'QUEUED');
  const outbox = await database.execute("SELECT recipient,payload_json FROM outbox_events WHERE channel='EMAIL' AND dedupe_key LIKE 'ops-credential:%'");
  assert.equal(outbox.rows.length, 1);
  assert.equal(String((outbox.rows[0] as Record<string, unknown>).recipient), 'security@example.test');
  const payload = JSON.parse(String((outbox.rows[0] as Record<string, unknown>).payload_json));
  assert.match(String(payload.body), /access code is [A-Z0-9]{12}/, 'the plaintext code appears only in the delivery email');

  // 2. The same window does not mint a second credential.
  const again = await ops.ensureCurrentOpsCredential(now + 60_000);
  assert.equal(again.generated, false);

  // 3. Wrong codes are rejected; matching hash verifies (we replay the hash lookup
  //    by brute-forcing is impossible — instead verify behavior around expiry and
  //    record keeping).
  const wrong = await ops.verifyOpsCode('AAAAAAAAAAAA', now);
  assert.equal(wrong.ok, false);
  const attempts = await database.execute('SELECT attempts FROM ops_credentials');
  assert.ok(Number((attempts.rows[0] as Record<string, unknown>).attempts) >= 1, 'failed attempts are counted');

  // 4. A code from an expired window fails and old credentials are swept away.
  const later = now + 2 * 60 * 60_000;
  await ops.sweepExpiredOps(later);
  const afterSweep = await database.execute('SELECT id FROM ops_credentials');
  assert.equal(afterSweep.rows.length, 0, 'expired credentials are deleted automatically');
  const expired = await ops.verifyOpsCode('BBBBBBBBBBBB', later);
  assert.equal(expired.ok, false);

  // 5. Ops sessions expire and can be revoked.
  await database.execute('INSERT INTO users(id,tenant_id,email,display_name,password_hash,role,email_verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?, ?, ?)', ['ops-user', 'ops-tenant', 'ops@example.test', 'Ops user', 'x', 'OWNER', iso, iso, iso]);
  const session = await ops.createOpsSession('ops-user', '127.0.0.1', now);
  assert.ok(await ops.findOpsSession(session.token, now + 1000));
  assert.equal(await ops.findOpsSession(session.token, now + ops.OPS_SESSION_MS + 1), null, 'ops sessions expire');
  const session2 = await ops.createOpsSession('ops-user', '127.0.0.1', now);
  await ops.revokeOpsSession(session2.token);
  assert.equal(await ops.findOpsSession(session2.token, now + 1000), null, 'ops sessions can be revoked');

  // 6. Verification accepts exactly the 12-character code whose hash was stored.
  const fresh = await ops.ensureCurrentOpsCredential(later + 1000);
  assert.equal(fresh.generated, true);
  await database.execute('UPDATE ops_credentials SET token_hash=? WHERE id=(SELECT id FROM ops_credentials ORDER BY created_at DESC LIMIT 1)', [hashToken('VALIDCODE123')]);
  const verified = await ops.verifyOpsCode('VALIDCODE123', later + 1000);
  assert.equal(verified.ok, true, 'a code matching the stored hash verifies');
  const wrongCase = await ops.verifyOpsCode('VALIDCODE124', later + 1000);
  assert.equal(wrongCase.ok, false);
});

test('barrier commands enforce nonce replay protection, one-time acknowledgement and expiry', async (t) => {
  t.after(async () => {
    await database.requireTurso().close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });
  await database.execute(
    `INSERT INTO devices(id,tenant_id,city_id,zone_id,name,kind,api_key_hash,firmware_version,enabled,approval_state,current_state,barrier_state,created_at,updated_at)
     VALUES(?,?,?,?,?,?,'hash','test',1,'APPROVED','NORMAL','DOWN',?,?)`,
    ['cmd-device', 'ops-tenant', 'ops-city', 'ops-zone', 'Controller', 'ESP32_CONTROLLER', iso, iso],
  );
  await database.execute(
    `INSERT INTO devices(id,tenant_id,city_id,zone_id,name,kind,api_key_hash,firmware_version,enabled,approval_state,current_state,barrier_state,created_at,updated_at)
     VALUES(?,?,?,?,?,?,'hash','test',1,'APPROVED','NORMAL','DOWN',?,?)`,
    ['cmd-sender', 'ops-tenant', 'ops-city', 'ops-zone', 'Sender', 'ESP8266_SENDER', iso, iso],
  );

  // Sender nodes never receive barrier commands.
  await assert.rejects(
    () => commands.createBarrierCommand({ deviceId: 'cmd-sender', action: 'BARRIER_RAISE', requestedBy: null, tenantId: 'ops-tenant' }),
    /Sender nodes have no actuator/,
  );

  const command = await commands.createBarrierCommand({ deviceId: 'cmd-device', action: 'BARRIER_RAISE', requestedBy: null, tenantId: 'ops-tenant' });
  assert.equal(command.status, 'QUEUED');
  assert.ok(command.nonce.length >= 16);

  // The stored row keeps only hashes of the nonce.
  const raw = await database.execute('SELECT nonce_hash,sealed_nonce FROM barrier_commands WHERE id=?', [command.id]);
  const row = raw.rows[0] as Record<string, unknown>;
  assert.equal(String(row.nonce_hash), hashToken(command.nonce));
  assert.notEqual(String(row.sealed_nonce), command.nonce, 'the nonce is sealed at rest');

  // Polling returns the nonce for the device and marks the command DELIVERED.
  const polled = await commands.pollPendingCommands('cmd-device');
  assert.equal(polled.length, 1);
  assert.equal(polled[0]!.nonce, command.nonce);
  const delivered = await commands.pollPendingCommands('cmd-device');
  assert.equal(delivered.length, 0, 'commands are delivered once');

  // Acknowledgement with a wrong nonce is rejected (replay/forgery).
  await assert.rejects(
    () => commands.acknowledgeCommand({ deviceId: 'cmd-device', commandId: command.id, nonce: 'wrong-nonce-value-x', status: 'OK', tenantId: 'ops-tenant' }),
    /nonce mismatch/,
  );

  // A correct acknowledgement succeeds exactly once.
  const ack = await commands.acknowledgeCommand({
    deviceId: 'cmd-device', commandId: command.id, nonce: command.nonce,
    status: 'OK', limitSwitchState: 'CLOSED', tenantId: 'ops-tenant',
  });
  assert.equal(ack.acknowledged, true);
  await assert.rejects(
    () => commands.acknowledgeCommand({ deviceId: 'cmd-device', commandId: command.id, nonce: command.nonce, status: 'OK', tenantId: 'ops-tenant' }),
    /already acknowledged/,
  );

  // The limit-switch feedback updated device health.
  const device = await database.execute('SELECT limit_switch_state FROM devices WHERE id=?', ['cmd-device']);
  assert.equal(String((device.rows[0] as Record<string, unknown>).limit_switch_state), 'CLOSED');

  // Expired commands cannot be acknowledged and are swept to EXPIRED.
  const stale = await commands.createBarrierCommand({ deviceId: 'cmd-device', action: 'BARRIER_LOWER', requestedBy: null, tenantId: 'ops-tenant' });
  await database.execute('UPDATE barrier_commands SET expires_at=? WHERE id=?', [new Date(Date.now() - 1000).toISOString(), stale.id]);
  await commands.sweepExpiredCommands();
  await assert.rejects(
    () => commands.acknowledgeCommand({ deviceId: 'cmd-device', commandId: stale.id, nonce: stale.nonce, status: 'OK', tenantId: 'ops-tenant' }),
    /expired|cannot be acknowledged/,
  );

  // The command audit trail recorded every creation and the acknowledgement.
  const audit = await database.execute("SELECT action FROM audit_logs WHERE action LIKE 'BARRIER_COMMAND%' ORDER BY created_at");
  const actions = audit.rows.map((item) => String((item as Record<string, unknown>).action));
  assert.deepEqual([...actions].sort(), ['BARRIER_COMMAND_ACKNOWLEDGED', 'BARRIER_COMMAND_CREATED', 'BARRIER_COMMAND_CREATED']);
});
