import 'dotenv/config';
import crypto from 'node:crypto';
import {
  connectDatabase, currentTimestamp, execute, migrateDatabase, primaryTenantId, queryOne, randomId, turso,
} from '../server/database.js';
import { config } from '../server/config.js';
import { generateDeviceUid } from '../server/devices.js';

/**
 * Seed script.
 *
 * Creates only what the platform needs to be demonstrable end to end:
 *   - a clearly labelled SIMULATION device (never presented as real hardware)
 *   - its per-device credential (printed once, stored only as a SHA-256 hash)
 *
 * No users are seeded. The first super admin is created through the one-time
 * bootstrap flow (OWNER_BOOTSTRAP_TOKEN) so that no credential is ever committed.
 */

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

async function main() {
  await connectDatabase();
  await migrateDatabase();
  const tenantId = await primaryTenantId();

  const existing = await queryOne('SELECT id FROM devices WHERE tenant_id=? AND simulation=1 LIMIT 1', [tenantId]);
  let deviceId = existing ? String(existing.id) : randomId();
  let uid = generateDeviceUid('ESP32');

  if (!existing) {
    uid = `SIM${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const zone = await queryOne(
      'SELECT z.id, z.city_id FROM zones z JOIN cities c ON c.id=z.city_id WHERE c.tenant_id=? ORDER BY z.created_at LIMIT 1',
      [tenantId],
    );
    if (!zone) throw new Error('Run the migrations first: they create the tenant, service areas and monitored zones.');
    const now = currentTimestamp();
    await execute(
      `INSERT INTO devices(id,tenant_id,city_id,zone_id,name,kind,board,uid,api_key_hash,firmware_version,enabled,approval_state,approval_note,simulation,last_seq,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,'','simulation',1,'APPROVED','Seeded simulation node - not hardware',1,0,?,?)`,
      [deviceId, tenantId, String(zone.city_id), String(zone.id), 'SIMULATION NODE (not hardware)', 'ESP32_CONTROLLER', 'ESP32', uid, now, now],
    );
    console.log(`[floodgrid] created simulation device ${uid}`);
  } else {
    console.log(`[floodgrid] simulation device already exists`);
  }

  const activeCredential = await queryOne("SELECT id FROM device_credentials WHERE device_id=? AND status='ACTIVE' LIMIT 1", [deviceId]);
  if (!activeCredential) {
    const apiKey = `fgk_${crypto.randomBytes(24).toString('base64url')}`;
    await execute(
      'INSERT INTO device_credentials(id,device_id,key_hash,label,status,created_at) VALUES (?,?,?,?,?,?)',
      [randomId(), deviceId, hash(apiKey), 'seeded', 'ACTIVE', currentTimestamp()],
    );
    console.log('[floodgrid] simulation device key (store it safely, shown once):');
    console.log(`  SIMULATION_DEVICE_API_KEY=${apiKey}`);
  } else {
    console.log('[floodgrid] simulation device already has an active credential');
  }

  console.log('[floodgrid] seed complete. Next steps:');
  console.log('  1. Set OWNER_BOOTSTRAP_TOKEN and ADMIN_CIDR_ALLOWLIST, then POST /api/auth/bootstrap to create the first super admin.');
  console.log('  2. Register real devices from /admin and flash them from /devices.');
  console.log('  3. Use the labelled simulation controls to demonstrate the workflow.');
  console.log(`[floodgrid] database target: ${config.isLocalDatabase ? config.databaseUrl : 'Turso (managed libSQL)'}`);
}

main()
  .catch((error) => {
    console.error('[floodgrid] seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await turso.close(); } catch { /* already closed */ }
  });
