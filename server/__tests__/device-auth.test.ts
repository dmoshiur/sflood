import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { actorId, bootstrap, createOwner, registerTestDevice, resetDatabase, telemetryPayload } from './helpers.js';

/**
 * Device authentication, provisioning, replay protection and telemetry
 * validation — the device-facing surface of the API.
 */

beforeEach(async () => {
  await bootstrap();
  await resetDatabase();
  await createOwner();
});

describe('provisioning', () => {
  it('exchanges a one-time token for a per-device key', async () => {
    const devices = await import('../devices.js');
    const { device, provisioningToken } = await registerTestDevice();

    const result = await devices.claimProvisioningToken({
      token: provisioningToken, uid: device.uid, board: 'ESP32', firmwareVersion: '1.4.0', ip: '127.0.0.1',
    });
    assert.ok(!('error' in result), 'provisioning must succeed');
    const claimed = result as { deviceId: string; apiKey: string; heartbeatIntervalSeconds: number };
    assert.equal(claimed.deviceId, device.id);
    assert.match(claimed.apiKey, /^fgk_/);

    // The token cannot be replayed.
    const second = await devices.claimProvisioningToken({ token: provisioningToken, uid: device.uid, board: 'ESP32' });
    assert.ok('error' in second);
    assert.equal((second as { status: number }).status, 401);
  });

  it('rejects a token issued for a different board', async () => {
    const devices = await import('../devices.js');
    const { device, provisioningToken } = await registerTestDevice({ board: 'ESP8266' });
    const result = await devices.claimProvisioningToken({ token: provisioningToken, uid: device.uid, board: 'ESP32' });
    assert.ok('error' in result);
    assert.equal((result as { status: number }).status, 403);
  });

  it('rejects a token for a different device uid', async () => {
    const devices = await import('../devices.js');
    const first = await registerTestDevice();
    const second = await registerTestDevice();
    const result = await devices.claimProvisioningToken({ token: first.provisioningToken, uid: second.device.uid, board: 'ESP32' });
    assert.ok('error' in result);
    assert.equal((result as { status: number }).status, 403);
  });

  it('rejects an unknown provisioning token', async () => {
    const devices = await import('../devices.js');
    const { device } = await registerTestDevice();
    const result = await devices.claimProvisioningToken({ token: 'a'.repeat(32), uid: device.uid, board: 'ESP32' });
    assert.ok('error' in result);
    assert.equal((result as { status: number }).status, 401);
  });

  it('stores only a hash of the issued key', async () => {
    const devices = await import('../devices.js');
    const { queryAll } = await import('../database.js');
    const { device, provisioningToken } = await registerTestDevice();
    const result = await devices.claimProvisioningToken({ token: provisioningToken, uid: device.uid, board: 'ESP32' });
    const apiKey = (result as { apiKey: string }).apiKey;
    const rows = await queryAll('SELECT key_hash FROM device_credentials WHERE device_id=?', [device.id]);
    assert.equal(rows.length, 1);
    assert.notEqual(String(rows[0]!.key_hash), apiKey, 'the raw key must never be stored');
    assert.match(String(rows[0]!.key_hash), /^[a-f0-9]{64}$/);
  });
});

describe('device credential authentication', () => {
  it('authenticates a provisioned device and rejects a wrong key', async () => {
    const devices = await import('../devices.js');
    const { device, provisioningToken } = await registerTestDevice();
    const result = await devices.claimProvisioningToken({ token: provisioningToken, uid: device.uid, board: 'ESP32' });
    const apiKey = (result as { apiKey: string }).apiKey;

    const authenticated = await devices.authenticateDeviceToken(apiKey);
    assert.ok(authenticated);
    assert.equal(authenticated!.id, device.id);
    assert.equal(await devices.authenticateDeviceToken('fgk_wrong-key-value'), null);
    assert.equal(await devices.authenticateDeviceToken('short'), null);
    assert.equal(await devices.authenticateDeviceToken(''), null);
  });

  it('rejects a disabled device even with a valid key', async () => {
    const devices = await import('../devices.js');
    const { device, provisioningToken } = await registerTestDevice();
    const result = await devices.claimProvisioningToken({ token: provisioningToken, uid: device.uid, board: 'ESP32' });
    const apiKey = (result as { apiKey: string }).apiKey;
    await devices.setDeviceEnabled(device.id, false, await actorId());
    assert.equal(await devices.authenticateDeviceToken(apiKey), null);
  });

  it('rotates credentials and revokes the previous key', async () => {
    const devices = await import('../devices.js');
    const { device, provisioningToken } = await registerTestDevice();
    const first = (await devices.claimProvisioningToken({ token: provisioningToken, uid: device.uid, board: 'ESP32' })) as { apiKey: string };
    const rotated = await devices.rotateDeviceCredential(device.id, await actorId());
    assert.ok(rotated);
    assert.notEqual(rotated!.apiKey, first.apiKey);
    assert.equal(await devices.authenticateDeviceToken(first.apiKey), null);
    assert.ok(await devices.authenticateDeviceToken(rotated!.apiKey));
    await devices.revokeDeviceCredentials(device.id, await actorId());
    assert.equal(await devices.authenticateDeviceToken(rotated!.apiKey), null);
  });
});

describe('telemetry validation', () => {
  it('accepts a valid sample and rejects an out-of-order sequence', async () => {
    const devices = await import('../devices.js');
    const { ingestTelemetry, TelemetryError } = await import('../telemetry.js');
    const { device, provisioningToken } = await registerTestDevice();
    const claimed = (await devices.claimProvisioningToken({ token: provisioningToken, uid: device.uid, board: 'ESP32' })) as { apiKey: string };
    const authenticated = (await devices.authenticateDeviceToken(claimed.apiKey))!;

    const first = await ingestTelemetry(authenticated, await telemetryPayload(device.id, 1, 20));
    assert.equal(first.accepted, true);
    assert.equal(first.state, 'NORMAL');

    const replay = await telemetryPayload(device.id, 1, 25);
    const stale = await telemetryPayload(device.id, 0, 25);
    await assert.rejects(
      () => ingestTelemetry(authenticated, replay),
      (error: unknown) => error instanceof TelemetryError && error.status === 409,
    );
    await assert.rejects(
      () => ingestTelemetry(authenticated, stale),
      (error: unknown) => error instanceof TelemetryError && error.status === 409,
    );
  });

  it('rejects telemetry from an unapproved device', async () => {
    const devices = await import('../devices.js');
    const { ingestTelemetry, TelemetryError } = await import('../telemetry.js');
    const { execute } = await import('../database.js');
    const { device, provisioningToken } = await registerTestDevice();
    await execute('UPDATE devices SET approval_state=? WHERE id=?', ['PENDING', device.id]);
    const claimed = (await devices.claimProvisioningToken({ token: provisioningToken, uid: device.uid, board: 'ESP32' })) as { apiKey: string };
    const authenticated = (await devices.authenticateDeviceToken(claimed.apiKey))!;
    const unapproved = await telemetryPayload(device.id, 1, 20);
    await assert.rejects(
      () => ingestTelemetry(authenticated, unapproved),
      (error: unknown) => error instanceof TelemetryError && error.status === 403,
    );
  });

  it('rejects actuator state from an ESP8266 sender node', async () => {
    const devices = await import('../devices.js');
    const { ingestTelemetry, TelemetryError, telemetrySchema } = await import('../telemetry.js');
    const { device, provisioningToken } = await registerTestDevice({ board: 'ESP8266' });
    const claimed = (await devices.claimProvisioningToken({ token: provisioningToken, uid: device.uid, board: 'ESP8266' })) as { apiKey: string };
    const authenticated = (await devices.authenticateDeviceToken(claimed.apiKey))!;
    const payload = telemetrySchema.parse({ deviceId: device.id, seq: 1, levelCm: 20, barrierState: 'RAISED' });
    await assert.rejects(
      () => ingestTelemetry(authenticated, payload),
      (error: unknown) => error instanceof TelemetryError && error.status === 400,
    );
  });

  it('rejects malformed payloads through the schema', async () => {
    const { telemetrySchema } = await import('../telemetry.js');
    assert.equal(telemetrySchema.safeParse({ deviceId: 'abc', seq: 1, levelCm: 'high' }).success, false);
    assert.equal(telemetrySchema.safeParse({ deviceId: 'abc', seq: -1, levelCm: 10 }).success, false);
    assert.equal(telemetrySchema.safeParse({ deviceId: 'abc', seq: 1, levelCm: 10, state: 'SAFE' }).success, false);
    assert.equal(telemetrySchema.safeParse({ deviceId: 'abc', seq: 1, levelCm: 10, state: 'NORMAL' }).success, true);
  });
});

describe('heartbeat and device health', () => {
  it('records a heartbeat and reports device health', async () => {
    const devices = await import('../devices.js');
    const { recordHeartbeat } = await import('../telemetry.js');
    const { device, provisioningToken } = await registerTestDevice();
    const claimed = (await devices.claimProvisioningToken({ token: provisioningToken, uid: device.uid, board: 'ESP32' })) as { apiKey: string };
    const authenticated = (await devices.authenticateDeviceToken(claimed.apiKey))!;
    const result = await recordHeartbeat(authenticated, { uptimeSeconds: 120, rssi: -61, firmwareVersion: '1.4.0' });
    assert.equal(result.nextHeartbeatInSeconds, 30);
    // Health is derived from the stored heartbeat, so read the device back.
    const refreshed = (await devices.getDevice(device.id))!;
    assert.equal(await devices.deviceHealth(refreshed), 'ONLINE');
    assert.equal(refreshed.uptimeSeconds, 120);
    assert.equal(refreshed.signalDbm, -61);
  });
});
