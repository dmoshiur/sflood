import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Test harness.
 *
 * Every test file runs in its own process, so each one gets a private, file-based
 * libSQL database created from the real migrations. Nothing is mocked: the tests
 * exercise the same code paths the server uses.
 */

const databaseFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'floodgrid-test-')), 'test.db');
process.env.NODE_ENV = 'test';
process.env.LIBSQL_FILE = databaseFile;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-value-0123456789abcdef';
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || 'https://floodgrid.example.org';

export const TEST_DB_FILE = databaseFile;

export async function bootstrap() {
  const database = await import('../database.js');
  const { migrateDatabase, primaryTenantId, queryOne, queryAll } = database;
  await migrateDatabase();
  const tenantId = await primaryTenantId();
  return { ...database, tenantId, queryOne, queryAll };
}

/**
 * Clear the transactional tables so each test starts from a known state.
 * Reference data (tenant, service areas, cities, zones, policies, settings,
 * firmware releases) comes from the migrations and is left in place, with the
 * mutable columns restored to their seeded values.
 */
export async function resetDatabase() {
  const { execute } = await import('../database.js');
  const tables = [
    'ops_attempts', 'ops_sessions', 'ops_credentials', 'backups', 'deployment_info',
    'manual_records', 'notification_deliveries', 'notifications', 'push_subscriptions',
    'email_subscribers', 'notification_preferences', 'notification_templates',
    'barrier_commands', 'flood_events', 'telemetry', 'device_provisioning', 'device_credentials',
    'devices', 'site_page_versions', 'site_pages', 'maintenance_events', 'audit_logs',
    'sessions', 'admin_invites', 'users', 'subscriptions', 'outbox_events', 'provider_configs',
  ];
  for (const table of tables) {
    await execute(`DELETE FROM ${table}`);
  }
  await execute('UPDATE site_settings SET updated_by=NULL');
  await execute('UPDATE feature_flags SET updated_by=NULL');
  await execute('UPDATE service_areas SET enabled=1, requires_review=0');
  await execute('UPDATE flood_policies SET cooldown_seconds=120, enabled=1');
  await execute("UPDATE site_settings SET value_json='false' WHERE key='maintenance_mode'");
  await execute("UPDATE site_settings SET value_json='false' WHERE key='simulation_running'");
}

export async function createOwner(email = 'owner@example.org', password = 'Str0ngPassw0rd') {
  const { execute, randomId, currentTimestamp, primaryTenantId } = await import('../database.js');
  const { hashPassword } = await import('../security.js');
  const tenantId = await primaryTenantId();
  const id = randomId();
  const now = currentTimestamp();
  await execute(
    `INSERT INTO users(id,tenant_id,email,display_name,password_hash,role,email_verified_at,created_at,updated_at,password_updated_at)
     VALUES (?,?,?,?,?,'OWNER',?,?,?,?)`,
    [id, tenantId, email, 'Test Owner', await hashPassword(password), now, now, now, now],
  );
  return { id, email, tenantId };
}

export async function createZone() {
  const { queryOne, primaryTenantId } = await import('../database.js');
  const tenantId = await primaryTenantId();
  return queryOne('SELECT z.id, z.city_id FROM zones z JOIN cities c ON c.id=z.city_id WHERE c.tenant_id=? ORDER BY z.created_at LIMIT 1', [tenantId]);
}

export async function registerTestDevice(input: { board?: 'ESP32' | 'ESP8266'; name?: string; simulation?: boolean } = {}) {
  const devices = await import('../devices.js');
  const { queryOne } = await import('../database.js');
  const zone = await createZone();
  if (!zone) throw new Error('seed data missing');
  // Audit and approval columns reference users(id), so use a real account.
  const actor = await queryOne('SELECT id FROM users LIMIT 1');
  const actorId = actor ? String(actor.id) : null;
  const result = await devices.registerDevice({
    tenantId: 'tenant-floodgrid',
    cityId: String((zone as { city_id: string }).city_id),
    zoneId: String((zone as { id: string }).id),
    name: input.name || 'Test node',
    board: input.board || 'ESP32',
    firmwareVersion: '1.4.0',
    actorId,
    simulation: input.simulation ?? false,
  });
  await devices.setDeviceApproval(result.device.id, 'APPROVED', 'test', actorId);
  return result;
}

/** Id of an existing account, for columns that reference users(id). */
export async function actorId(): Promise<string | null> {
  const { queryOne } = await import('../database.js');
  const row = await queryOne('SELECT id FROM users LIMIT 1');
  return row ? String(row.id) : null;
}

export async function telemetryPayload(deviceId: string, seq: number, levelCm: number, extra: Record<string, unknown> = {}) {
  const { telemetrySchema } = await import('../telemetry.js');
  return telemetrySchema.parse({ deviceId, seq, levelCm, sensorHealthy: true, ...extra });
}

export function assertIso(value: unknown, label = 'timestamp') {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  assert.ok(!Number.isNaN(new Date(String(value)).getTime()), `${label} must be a valid ISO timestamp`);
}
