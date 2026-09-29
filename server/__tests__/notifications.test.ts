import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { bootstrap, createOwner, registerTestDevice, resetDatabase, telemetryPayload } from './helpers.js';
import { rowText } from '../database.js';

/**
 * Notification pipeline: queueing, deduplication, retry bookkeeping, provider
 * availability handling and the flood-event fan-out audience.
 */

beforeEach(async () => {
  await bootstrap();
  await resetDatabase();
  await createOwner();
});

describe('delivery queue', () => {
  it('queues a delivery and ignores exact duplicates', async () => {
    const { queueDelivery } = await import('../notifications.js');
    const { queryAll } = await import('../database.js');
    const first = await queueDelivery({
      tenantId: 'tenant-floodgrid', channel: 'EMAIL', recipient: 'user@example.org',
      payload: { title: 'Test', body: 'Body' }, eventId: 'event-1',
    });
    assert.equal(first, true);
    const second = await queueDelivery({
      tenantId: 'tenant-floodgrid', channel: 'EMAIL', recipient: 'user@example.org',
      payload: { title: 'Test', body: 'Body' }, eventId: 'event-1',
    });
    assert.equal(second, false, 'the unique (channel, recipient, event) index must dedupe');
    const rows = await queryAll('SELECT * FROM notification_deliveries');
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0]!.status), 'PENDING');
  });

  it('queues a separate delivery per channel and recipient', async () => {
    const { queueDelivery } = await import('../notifications.js');
    const { queryAll } = await import('../database.js');
    await queueDelivery({ tenantId: 'tenant-floodgrid', channel: 'EMAIL', recipient: 'a@example.org', payload: { title: 'T', body: 'B' }, eventId: 'e1' });
    await queueDelivery({ tenantId: 'tenant-floodgrid', channel: 'WEB_PUSH', recipient: 'a@example.org', payload: { title: 'T', body: 'B' }, eventId: 'e1' });
    await queueDelivery({ tenantId: 'tenant-floodgrid', channel: 'EMAIL', recipient: 'b@example.org', payload: { title: 'T', body: 'B' }, eventId: 'e1' });
    const rows = await queryAll('SELECT * FROM notification_deliveries');
    assert.equal(rows.length, 3);
  });

  it('marks deliveries SKIPPED when the channel is not configured', async () => {
    const { queueDelivery, processDeliveryQueue } = await import('../notifications.js');
    const { queryAll } = await import('../database.js');
    await queueDelivery({ tenantId: 'tenant-floodgrid', channel: 'SMS', recipient: '+8801000000000', payload: { title: 'T', body: 'B' } });
    const result = await processDeliveryQueue(10);
    assert.equal(result.skipped, 1);
    const rows = await queryAll('SELECT status,failure_reason FROM notification_deliveries');
    assert.equal(String(rows[0]!.status), 'SKIPPED');
    assert.match(String(rows[0]!.failure_reason), /not configured/);
  });

  it('records retry bookkeeping when a provider fails', async () => {
    const { queueDelivery } = await import('../notifications.js');
    const { queryAll, execute } = await import('../database.js');
    await queueDelivery({ tenantId: 'tenant-floodgrid', channel: 'EMAIL', recipient: 'user@example.org', payload: { title: 'T', body: 'B' } });
    // Pretend the SMTP provider is configured, then fail the delivery.
    await execute("INSERT INTO provider_configs(provider,config_cipher,enabled,updated_at) VALUES ('SMTP',?, 1, ?)", [
      (await import('../security.js')).encryptSecret(JSON.stringify({ host: 'smtp.invalid', port: 587, secure: false, fromAddress: 'a@b.co', fromName: 'x' })),
      new Date().toISOString(),
    ]);
    const { processDeliveryQueue } = await import('../notifications.js');
    const result = await processDeliveryQueue(10);
    assert.equal(result.retried + result.deadLettered, 1);
    const rows = await queryAll('SELECT status,attempts,retry_count,failure_reason,next_attempt_at FROM notification_deliveries');
    assert.ok(Number(rows[0]!.attempts) >= 1);
    assert.ok(String(rows[0]!.failure_reason).length > 0);
    assert.ok(String(rows[0]!.next_attempt_at).length > 0);
  });

  it('creates an in-app notification row for the IN_APP channel', async () => {
    const { queueDelivery, processDeliveryQueue } = await import('../notifications.js');
    const { queryAll, queryOne } = await import('../database.js');
    // notifications.user_id is a foreign key, so deliver to a real account.
    const owner = await queryOne('SELECT id FROM users LIMIT 1');
    assert.ok(owner, 'the bootstrap owner exists');
    const userId = rowText(owner!, 'id');
    await queueDelivery({
      tenantId: 'tenant-floodgrid', channel: 'IN_APP', recipient: userId,
      payload: { title: 'Critical level', body: 'Water level 60 cm', url: '/app/alerts' },
    });
    const result = await processDeliveryQueue(10);
    assert.equal(result.sent, 1);
    const rows = await queryAll('SELECT * FROM notifications WHERE user_id=?', [userId]);
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0]!.title), 'Critical level');
    assert.equal(String(rows[0]!.severity), 'INFO');
  });
});

describe('flood event fan-out', () => {
  it('queues email, push and in-app notifications for eligible recipients', async () => {
    const { fanOutFloodEvent } = await import('../notifications.js');
    const { queryAll } = await import('../database.js');
    const { execute, randomId, currentTimestamp } = await import('../database.js');
    const userId = randomId();
    await execute(
      `INSERT INTO users(id,tenant_id,email,display_name,password_hash,role,email_verified_at,phone_verified_at,zone_id,created_at,updated_at)
       VALUES (?,?,?,?,?,'MEMBER',?,?,'zone-north-bank',?,?)`,
      [userId, 'tenant-floodgrid', 'member@example.org', 'Member', 'x', currentTimestamp(), currentTimestamp(), currentTimestamp(), currentTimestamp()],
    );
    await execute(
      `INSERT INTO notification_preferences(user_id,email_enabled,sms_enabled,push_enabled,in_app_enabled,min_severity,recovery_enabled,updated_at)
       VALUES (?,1,0,1,1,'WATCH',1,?)`,
      [userId, currentTimestamp()],
    );
    await execute(
      `INSERT INTO push_subscriptions(id,tenant_id,zone_id,endpoint,p256dh,auth,consent_at,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [randomId(), 'tenant-floodgrid', 'zone-north-bank', 'https://fcm.googleapis.com/push/test', 'k'.repeat(40), 'a'.repeat(24), currentTimestamp(), currentTimestamp()],
    );
    await execute(
      `INSERT INTO email_subscribers(id,tenant_id,zone_id,email,consent_at,verified_at,unsubscribe_token_hash,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [randomId(), 'tenant-floodgrid', 'zone-north-bank', 'public@example.org', currentTimestamp(), currentTimestamp(), 'h'.repeat(64), currentTimestamp()],
    );

    const result = await fanOutFloodEvent({
      tenantId: 'tenant-floodgrid', zoneId: 'zone-north-bank', eventId: 'event-fanout-1',
      state: 'CRITICAL', previousState: 'WARNING', levelCm: 62, deviceId: 'device-1', deviceName: 'Node 1',
      zoneName: 'Ward 04', reason: 'Level 62.0 cm', simulated: false,
      channels: ['IN_APP', 'EMAIL', 'WEB_PUSH'], notifyRecovery: true,
    });

    assert.equal(result.inApp, 2, 'the member and the platform owner both receive an in-app notification');
    assert.ok(result.queued >= 3, 'member email, member push and public email are queued');

    const deliveries = await queryAll('SELECT channel,recipient,priority FROM notification_deliveries ORDER BY priority');
    const channels = deliveries.map((row: Record<string, unknown>) => String(row.channel));
    assert.ok(channels.includes('EMAIL'));
    assert.ok(channels.includes('WEB_PUSH'));
    const criticalEmail = deliveries.find((row: Record<string, unknown>) => String(row.channel) === 'EMAIL' && String(row.recipient) === 'member@example.org');
    assert.equal(Number(criticalEmail!.priority), 1, 'critical email gets the highest priority');

    const inApp = await queryAll('SELECT * FROM notifications WHERE user_id=?', [userId]);
    assert.equal(inApp.length, 1);
    assert.equal(String(inApp[0]!.severity), 'CRITICAL');
  });

  it('skips the fan-out entirely when recovery notifications are disabled', async () => {
    const { fanOutFloodEvent } = await import('../notifications.js');
    const { queryAll } = await import('../database.js');
    const result = await fanOutFloodEvent({
      tenantId: 'tenant-floodgrid', zoneId: 'zone-north-bank', eventId: 'event-recovery-1',
      state: 'RECOVERY', previousState: 'CRITICAL', levelCm: 12, deviceId: 'device-1', deviceName: 'Node 1',
      zoneName: 'Ward 04', reason: 'Level fell below the recovery threshold', simulated: false,
      channels: ['IN_APP', 'EMAIL'], notifyRecovery: false,
    });
    assert.deepEqual(result, { queued: 0, inApp: 0 });
    assert.equal((await queryAll('SELECT * FROM notification_deliveries')).length, 0);
  });

  it('respects the member minimum severity preference', async () => {
    const { fanOutFloodEvent } = await import('../notifications.js');
    const { queryAll } = await import('../database.js');
    const { execute, randomId, currentTimestamp } = await import('../database.js');
    const userId = randomId();
    await execute(
      `INSERT INTO users(id,tenant_id,email,display_name,password_hash,role,email_verified_at,zone_id,created_at,updated_at)
       VALUES (?,?,?,?,'x','MEMBER',?,'zone-north-bank',?,?)`,
      [userId, 'tenant-floodgrid', 'strict@example.org', 'Strict', currentTimestamp(), currentTimestamp(), currentTimestamp()],
    );
    await execute(
      `INSERT INTO notification_preferences(user_id,email_enabled,sms_enabled,push_enabled,in_app_enabled,min_severity,recovery_enabled,updated_at)
       VALUES (?,1,0,1,1,'CRITICAL',1,?)`,
      [userId, currentTimestamp()],
    );
    await fanOutFloodEvent({
      tenantId: 'tenant-floodgrid', zoneId: 'zone-north-bank', eventId: 'event-severity-1',
      state: 'WATCH', previousState: 'NORMAL', levelCm: 30, deviceId: 'device-1', deviceName: 'Node 1',
      zoneName: 'Ward 04', reason: 'Level 30 cm', simulated: false,
      channels: ['IN_APP', 'EMAIL'], notifyRecovery: true,
    });
    const deliveries = await queryAll("SELECT * FROM notification_deliveries WHERE recipient='strict@example.org'");
    assert.equal(deliveries.length, 0, 'a WATCH event must not reach a member who only wants CRITICAL');
    const inApp = await queryAll('SELECT * FROM notifications WHERE user_id=?', [userId]);
    assert.equal(inApp.length, 1, 'in-app notifications are always delivered');
  });
});

describe('telemetry does not block on notification delivery', () => {
  it('ingests telemetry with no providers configured at all', async () => {
    const devices = await import('../devices.js');
    const { ingestTelemetry } = await import('../telemetry.js');
    const { execute } = await import('../database.js');
    // The seeded zone policy asks for two confirming samples; use one here.
    await execute('UPDATE flood_policies SET confirmation_samples=1');
    const registered = await registerTestDevice({ name: 'No provider node' });
    const claimed = (await devices.claimProvisioningToken({
      token: registered.provisioningToken, uid: registered.device.uid, board: 'ESP32',
    })) as { apiKey: string };
    const device = (await devices.authenticateDeviceToken(claimed.apiKey))!;
    const started = Date.now();
    const result = await ingestTelemetry(device, await telemetryPayload(registered.device.id, 1, 60));
    assert.equal(result.state, 'CRITICAL');
    assert.ok(Date.now() - started < 2000, 'ingestion must not wait on delivery');
  });
});
