import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'floodguard-api-test-'));
process.env.NODE_ENV = 'test';
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
const { app, isIpAllowedByCidr, isTrustedPushEndpoint, safeEqualHex, hashToken } = await import('../index.js');
const server = createServer(app);
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port.');
const baseUrl = `http://127.0.0.1:${address.port}`;

test('production API fails closed without Turso and never generates preview telemetry', async (t) => {
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 503);
  const healthBody = await health.json();
  assert.equal(healthBody.database, 'disconnected');
  assert.equal(healthBody.success, false);

  const status = await (await fetch(`${baseUrl}/api/public/status`)).json();
  assert.equal(status.online, false);
  assert.equal(status.levelCm, null);
  assert.equal(status.devicesOnline, 0);

  const telemetry = await fetch(`${baseUrl}/api/v1/telemetry`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer a-valid-length-device-token-123456789' },
    body: JSON.stringify({ deviceId: 'fg-device-1', seq: 1, levelCm: 34.5 }),
  });
  assert.equal(telemetry.status, 503);
  assert.equal((await telemetry.json()).error.code, 'DATABASE_NOT_CONFIGURED');

  const simulator = await fetch(`${baseUrl}/api/demo/simulate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'rise' }) });
  assert.equal(simulator.status, 404);

  assert.equal(isIpAllowedByCidr('127.0.0.1', '127.0.0.0/8'), true);
  assert.equal(isIpAllowedByCidr('127.0.0.1', ''), false);
  assert.equal(isTrustedPushEndpoint('https://fcm.googleapis.com/fcm/send/example'), true);
  assert.equal(isTrustedPushEndpoint('https://127.0.0.1/internal'), false);
  assert.equal(isTrustedPushEndpoint('https://attacker.example/push'), false);
  assert.equal(safeEqualHex(hashToken('one'), hashToken('one')), true);
  assert.equal(safeEqualHex(hashToken('one'), hashToken('two')), false);

});
