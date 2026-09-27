import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'floodguard-api-test-'));
process.env.NODE_ENV = 'test';
process.env.DEMO_DATA_FILE = path.join(temporaryDirectory, 'preview.json');
process.env.DEMO_DEVICE_API_KEY = 'unit-test-device-key-01234567890123456789';
const { app, isIpAllowedByCidr, isTrustedPushEndpoint, safeEqualHex, hashToken } = await import('../index.js');
const server = createServer(app);
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port.');
const baseUrl = `http://127.0.0.1:${address.port}`;

test('FloodGuard API provides simulation states and protects device ingestion', async (t) => {
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');

  const initial = await (await fetch(`${baseUrl}/api/dashboard`)).json();
  assert.equal(initial.mode, 'simulation');
  assert.equal(initial.system.state, 'WATCH');
  assert.equal(initial.system.barrier, 'DOWN');
  assert.equal(initial.devices.length, 2);

  const warningResponse = await fetch(`${baseUrl}/api/demo/simulate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'rise' }),
  });
  assert.equal(warningResponse.status, 200);
  const warning = await warningResponse.json();
  assert.equal(warning.dashboard.system.state, 'WARNING');
  assert.equal(warning.dashboard.system.barrier, 'RAISED');
  assert.equal(warning.dashboard.system.barrierLatched, true);
  assert.match(warning.message, /No physical/);

  const faultResponse = await fetch(`${baseUrl}/api/demo/simulate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'sensor-fault' }),
  });
  const fault = await faultResponse.json();
  assert.equal(fault.dashboard.system.state, 'UNKNOWN');
  assert.equal(fault.dashboard.system.barrier, 'HOLD');

  const estopResponse = await fetch(`${baseUrl}/api/demo/simulate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'estop' }),
  });
  const estop = await estopResponse.json();
  assert.equal(estop.dashboard.system.state, 'FAULT');
  assert.equal(estop.dashboard.system.barrier, 'FAULT');

  const resetResponse = await fetch(`${baseUrl}/api/demo/simulate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'reset' }),
  });
  assert.equal((await resetResponse.json()).dashboard.system.state, 'WATCH');

  const body = { deviceId: 'fg-esp32-01', seq: 4822, levelCm: 34.5, rainfallMm: 25, sensorHealthy: true };
  const inconsistent = await fetch(`${baseUrl}/api/v1/telemetry`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.DEMO_DEVICE_API_KEY}` },
    body: JSON.stringify({ ...body, state: 'SAFE', barrierState: 'DOWN' }),
  });
  assert.equal(inconsistent.status, 400);

  const denied = await fetch(`${baseUrl}/api/v1/telemetry`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-device-key-012345678901234567' }, body: JSON.stringify(body),
  });
  assert.equal(denied.status, 401);

  const accepted = await fetch(`${baseUrl}/api/v1/telemetry`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.DEMO_DEVICE_API_KEY}` }, body: JSON.stringify({ ...body, state: 'WARNING', barrierState: 'RAISED' }),
  });
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).state, 'WARNING');
  const hysteresisDashboard = await (await fetch(`${baseUrl}/api/dashboard`)).json();
  assert.equal(hysteresisDashboard.system.state, 'WARNING');

  const replayed = await fetch(`${baseUrl}/api/v1/telemetry`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.DEMO_DEVICE_API_KEY}` }, body: JSON.stringify(body),
  });
  assert.equal(replayed.status, 409);

  const pushConfig = await (await fetch(`${baseUrl}/api/notifications/config`)).json();
  assert.equal(pushConfig.webPushAvailable, false);
  assert.equal(isIpAllowedByCidr('127.0.0.1', '127.0.0.0/8'), true);
  assert.equal(isIpAllowedByCidr('127.0.0.1', ''), false);
  assert.equal(isTrustedPushEndpoint('https://fcm.googleapis.com/fcm/send/example'), true);
  assert.equal(isTrustedPushEndpoint('https://127.0.0.1/internal'), false);
  assert.equal(isTrustedPushEndpoint('https://attacker.example/push'), false);
  assert.equal(safeEqualHex(hashToken('one'), hashToken('one')), true);
  assert.equal(safeEqualHex(hashToken('one'), hashToken('two')), false);

  assert.ok(fs.existsSync(process.env.DEMO_DATA_FILE!));
});
