import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'floodguard-registration-test-'));
process.env.NODE_ENV = 'test';
process.env.TURSO_DATABASE_URL = `file:${path.join(temporaryDirectory, 'registration.db')}`;
process.env.TURSO_AUTH_TOKEN = '';
process.env.SESSION_SECRET = 'registration-test-session-secret-32-bytes';
process.env.SETTINGS_ENCRYPTION_KEY = 'd'.repeat(64);
process.env.PUBLIC_APP_URL = 'https://floodguard.example.test';
process.env.DEVICE_CIDR_ALLOWLIST = '127.0.0.1/32';
process.env.ADMIN_CIDR_ALLOWLIST = '';

const database = await import('../database.js');
await database.migrateDatabase();
const iso = new Date().toISOString();
await database.execute('INSERT INTO tenants(id,name,slug,created_at) VALUES(?,?,?,?)', ['reg-tenant', 'Reg tenant', 'floodguard-demo', iso]);
await database.execute('INSERT INTO cities(id,tenant_id,name,created_at) VALUES(?,?,?,?)', ['reg-city', 'reg-tenant', 'Dhaka', iso]);
await database.execute('INSERT INTO zones(id,city_id,name,created_at) VALUES(?,?,?,?)', ['reg-zone', 'reg-city', 'Ward 04', iso]);
await database.execute(
  `INSERT INTO devices(id,tenant_id,city_id,zone_id,name,kind,api_key_hash,firmware_version,enabled,approval_state,current_state,barrier_state,created_at,updated_at)
   VALUES(?,?,?,?,?,?,'pending','test',1,'APPROVED','NORMAL','DOWN',?,?)`,
  ['reg-device', 'reg-tenant', 'reg-city', 'reg-zone', 'Controller', 'ESP32_CONTROLLER', iso, iso],
);
const { app, hashToken } = await import('../index.js');
const server = createServer(app);
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port.');
const baseUrl = `http://127.0.0.1:${address.port}`;
const origin = baseUrl;

test('registration enforces the service-area allowlist and email verification', async () => {
  // The migration seeds Dhaka (BD) as an enabled service area.
  const areas = await (await fetch(`${baseUrl}/api/public/service-areas`)).json();
  assert.ok(areas.serviceAreas.some((area: { cityName: string }) => area.cityName === 'Dhaka'));

  // Out-of-area registration is rejected server-side.
  const outside = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ name: 'Out Area', email: 'outside@example.test', password: 'a-long-registration-password', countryCode: 'BD', cityName: 'Atlantis', consent: true }),
  });
  assert.equal(outside.status, 403);
  assert.match((await outside.json()).error, /service-area/i);

  // In-area registration succeeds and queues a verification email with the token link.
  const register = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ name: 'Dhaka Resident', email: 'resident@example.test', password: 'a-long-registration-password', countryCode: 'BD', cityName: 'Dhaka', consent: true }),
  });
  assert.equal(register.status, 201);
  const registerBody = await register.json();
  assert.equal(registerBody.created, true);
  const queued = await database.execute("SELECT payload_json FROM outbox_events WHERE dedupe_key LIKE 'email-verify:%'");
  assert.equal(queued.rows.length, 1);
  const payload = JSON.parse(String((queued.rows[0] as Record<string, unknown>).payload_json));
  const verifyUrl = new URL(String(payload.url));
  const token = verifyUrl.searchParams.get('token');
  assert.ok(token && token.length >= 32);

  // Login before verification is rejected.
  const earlyLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ email: 'resident@example.test', password: 'a-long-registration-password' }),
  });
  assert.equal(earlyLogin.status, 401);

  // The emailed link verifies the account, then login succeeds.
  const verify = await fetch(`${baseUrl}/api/auth/verify-email?token=${encodeURIComponent(token!)}`);
  assert.equal(verify.status, 200);
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ email: 'resident@example.test', password: 'a-long-registration-password' }),
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  assert.equal(loginBody.user.role, 'MEMBER');

  // Members cannot reach owner administration routes (server-side RBAC).
  const cookies = (login.headers.get('set-cookie') || '').split(/, (?=[^;,]+=)/).map((item) => item.split(';', 1)[0]).filter(Boolean).join('; ');
  const csrf = loginBody.csrfToken as string;
  const forbidden = await fetch(`${baseUrl}/api/owner/devices`, {
    headers: { Origin: origin, Cookie: cookies, 'X-CSRF-Token': csrf },
  });
  assert.equal(forbidden.status, 403);

  // The profile API reflects the registered account and accepts preference updates.
  const profile = await (await fetch(`${baseUrl}/api/profile`, { headers: { Cookie: cookies } })).json();
  assert.equal(profile.profile.email, 'resident@example.test');
  const prefs = await fetch(`${baseUrl}/api/profile`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookies, 'X-CSRF-Token': csrf },
    body: JSON.stringify({ notificationPrefs: { floodAlerts: true, email: false, push: true, sms: false } }),
  });
  assert.equal(prefs.status, 200);
});

test('device API validates credentials, sequence replay and reported-state consistency', async (t) => {
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.requireTurso().close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  // Unknown device + wrong key are rejected.
  const badKey = await fetch(`${baseUrl}/api/v1/telemetry`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-device-key-000000000' },
    body: JSON.stringify({ deviceId: 'reg-device', seq: 1, levelCm: 30 }),
  });
  assert.equal(badKey.status, 401);

  // Store a known device key hash, then ingest valid telemetry with new fields.
  await database.execute('UPDATE devices SET api_key_hash=? WHERE id=?', [hashToken('device-key-for-registration-tests-00'), 'reg-device']);
  const good = await fetch(`${baseUrl}/api/v1/telemetry`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer device-key-for-registration-tests-00' },
    body: JSON.stringify({
      deviceId: 'reg-device', seq: 1, levelCm: 12, rainfallMm: 3, rssi: -61, uptimeS: 3600,
      firmwareVersion: '0.2.0', limitSwitchState: 'CLOSED', timestamp: new Date().toISOString(),
    }),
  });
  assert.equal(good.status, 202);
  const goodBody = await good.json();
  assert.equal(goodBody.accepted, true);
  assert.equal(goodBody.state, 'NORMAL');

  // Replayed/out-of-order sequence numbers are rejected (replay protection).
  const replay = await fetch(`${baseUrl}/api/v1/telemetry`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer device-key-for-registration-tests-00' },
    body: JSON.stringify({ deviceId: 'reg-device', seq: 1, levelCm: 12 }),
  });
  assert.equal(replay.status, 409);

  // A reported state conflicting with the level is rejected.
  const inconsistent = await fetch(`${baseUrl}/api/v1/telemetry`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer device-key-for-registration-tests-00' },
    body: JSON.stringify({ deviceId: 'reg-device', seq: 2, levelCm: 5, state: 'CRITICAL' }),
  });
  assert.equal(inconsistent.status, 400);

  // Escalating telemetry persists a flood event through the engine.
  const critical = await fetch(`${baseUrl}/api/v1/telemetry`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer device-key-for-registration-tests-00' },
    body: JSON.stringify({ deviceId: 'reg-device', seq: 2, levelCm: 55 }),
  });
  assert.equal(critical.status, 202);
  const criticalBody = await critical.json();
  assert.equal(criticalBody.state, 'CRITICAL');
  const events = await database.execute('SELECT state,reason,duplicate_suppressed FROM flood_events');
  assert.ok(events.rows.length >= 1, 'state transitions are persisted as flood events');
  const states = events.rows.map((row) => String((row as Record<string, unknown>).state));
  assert.ok(states.includes('CRITICAL'));

  // Heartbeats update device health without touching telemetry.
  const heartbeat = await fetch(`${baseUrl}/api/v1/heartbeat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer device-key-for-registration-tests-00' },
    body: JSON.stringify({ deviceId: 'reg-device', uptimeS: 7200, firmwareVersion: '0.2.0', rssi: -55 }),
  });
  assert.equal(heartbeat.status, 200);

  // Sender-only nodes cannot report actuator state (validated before ingest).
  await database.execute(
    `INSERT INTO devices(id,tenant_id,city_id,zone_id,name,kind,api_key_hash,firmware_version,enabled,approval_state,current_state,barrier_state,created_at,updated_at)
     VALUES(?,?,?,?,?,?,'pending','test',1,'APPROVED','NORMAL','DOWN',?,?)`,
    ['reg-sender', 'reg-tenant', 'reg-city', 'reg-zone', 'Sender', 'ESP8266_SENDER', iso, iso],
  );
  await database.execute('UPDATE devices SET api_key_hash=? WHERE id=?', [hashToken('sender-key-for-registration-tests-000'), 'reg-sender']);
  const senderActuator = await fetch(`${baseUrl}/api/v1/telemetry`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sender-key-for-registration-tests-000' },
    body: JSON.stringify({ deviceId: 'reg-sender', seq: 1, levelCm: 12, barrierState: 'RAISED' }),
  });
  assert.equal(senderActuator.status, 400);

  // The public status endpoint exposes real stored values.
  const status = await (await fetch(`${baseUrl}/api/public/status`)).json();
  assert.equal(status.mode, 'turso');
  assert.equal(status.simulation, false);
  assert.equal(status.state, 'CRITICAL');
  assert.ok(Array.isArray(status.safetyInstructions) && status.safetyInstructions.length > 0);
});
