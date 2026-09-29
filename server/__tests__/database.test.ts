import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'floodguard-turso-test-'));
process.env.NODE_ENV = 'test';
process.env.TURSO_DATABASE_URL = `file:${path.join(temporaryDirectory, 'floodguard.db')}`;
process.env.TURSO_AUTH_TOKEN = '';
process.env.SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';
process.env.PUBLIC_APP_URL = 'https://floodguard.example.test';

const database = await import('../database.js');
const { createSmsUnsubscribeToken } = await import('../security.js');
const { hasCurrentConsent } = await import('../notifications.js');

test('Turso migrations are repeatable and SMS alerts require a verified phone', async (t) => {
  t.after(async () => {
    await database.requireTurso().close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  await database.migrateDatabase();
  await database.migrateDatabase();

  const versions = await database.execute('SELECT version FROM schema_migrations ORDER BY version');
  assert.deepEqual(versions.rows.map((row) => String((row as Record<string, unknown>).version)), [
    '0001_initial', '0002_sms_verification', '0003_email_verification_expiry', '0004_flood_engine', '0005_service_areas', '0006_product_core', '0007_sensor_measurements', '0008_disable_simulation_flag',
  ]);
  const columns = await database.execute('PRAGMA table_info(subscriptions)');
  const columnNames = new Set(columns.rows.map((row) => String((row as Record<string, unknown>).name)));
  assert.ok(columnNames.has('phone_verified_at'));
  assert.ok(columnNames.has('phone_verification_token_hash'));
  assert.ok(columnNames.has('verification_expires_at'));
  const productTables = await database.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('projects','device_status','alerts','alert_rules','automation_rules','command_logs','activity_logs')");
  assert.equal(productTables.rows.length, 7);

  const now = new Date().toISOString();
  await database.execute('INSERT INTO tenants(id,name,slug,created_at) VALUES(?,?,?,?)', ['tenant-test', 'Test tenant', 'test-tenant', now]);
  await database.execute('INSERT INTO cities(id,tenant_id,name,created_at) VALUES(?,?,?,?)', ['city-test', 'tenant-test', 'Test city', now]);
  await database.execute('INSERT INTO zones(id,city_id,name,created_at) VALUES(?,?,?,?)', ['zone-test', 'city-test', 'Test zone', now]);
  await database.execute(`INSERT INTO devices(id,tenant_id,city_id,zone_id,name,kind,api_key_hash,firmware_version,enabled,last_seq,current_state,barrier_state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?, ?,1,0,'UNKNOWN','DOWN',?,?)`, ['controller-test', 'tenant-test', 'city-test', 'zone-test', 'Test controller', 'ESP32_CONTROLLER', 'hash', 'test', now, now]);

  const subscriptions = [
    { id: 'phone-pending', phone: '+8801700000001', phoneVerifiedAt: null, email: null, verifiedAt: null },
    { id: 'phone-verified', phone: '+8801700000002', phoneVerifiedAt: now, email: null, verifiedAt: null },
    { id: 'email-pending', phone: null, phoneVerifiedAt: null, email: 'pending@example.test', verifiedAt: null },
    { id: 'email-verified', phone: null, phoneVerifiedAt: null, email: 'verified@example.test', verifiedAt: now },
  ];
  for (const subscription of subscriptions) {
    await database.execute(`INSERT INTO subscriptions(id,tenant_id,zone_id,email,phone,phone_verified_at,consent_at,verified_at,unsubscribe_token_hash,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, [subscription.id, 'tenant-test', 'zone-test', subscription.email, subscription.phone, subscription.phoneVerifiedAt, now, subscription.verifiedAt, subscription.id === 'phone-verified' ? database.randomId() : null, now]);
  }

  await database.ingestTursoTelemetry({ deviceId: 'controller-test', seq: 1, levelCm: 40, sensorHealthy: true, deviceState: 'WARNING', reportedBarrier: 'RAISED' });
  const queuedSms = await database.execute("SELECT recipient,payload_json FROM outbox_events WHERE channel='SMS'");
  assert.equal(queuedSms.rows.length, 1);
  assert.equal(String((queuedSms.rows[0] as Record<string, unknown>).recipient), '+8801700000002');
  const smsPayload = JSON.parse(String((queuedSms.rows[0] as Record<string, unknown>).payload_json));
  assert.match(smsPayload.unsubscribeUrl, /\/api\/notifications\/unsubscribe\?token=/);
  assert.equal(createSmsUnsubscribeToken('phone-verified').length, 43);
  assert.equal(await hasCurrentConsent('SMS', '+8801700000002', 'zone-test', 'controller-test:1:WARNING:SMS:phone-verified'), true);
  assert.equal(await hasCurrentConsent('SMS', '+8801700000001', 'zone-test', 'controller-test:1:WARNING:SMS:phone-pending'), false);
  await database.execute('UPDATE subscriptions SET unsubscribed_at=? WHERE id=?', [now, 'phone-verified']);
  assert.equal(await hasCurrentConsent('SMS', '+8801700000002', 'zone-test', 'controller-test:1:WARNING:SMS:phone-verified'), false);

  const queuedEmail = await database.execute("SELECT recipient FROM outbox_events WHERE channel='EMAIL'");
  assert.deepEqual(queuedEmail.rows.map((row) => String((row as Record<string, unknown>).recipient)), ['verified@example.test']);
  const verificationHash = 'current-verification-hash';
  const verificationExpiry = new Date(Date.now() + 60_000).toISOString();
  await database.execute('UPDATE subscriptions SET verification_token_hash=?,verification_expires_at=? WHERE id=?', [verificationHash, verificationExpiry, 'email-pending']);
  assert.equal(await hasCurrentConsent('EMAIL', 'pending@example.test', 'zone-test', `email-opt-in:email-pending:${verificationHash}`), true);
  assert.equal(await hasCurrentConsent('EMAIL', 'pending@example.test', 'zone-test', 'email-opt-in:email-pending:stale-hash'), false);
});
