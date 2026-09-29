import 'dotenv/config';
import crypto from 'node:crypto';
import { execute, migrateDatabase, requireTurso, randomId, currentTimestamp } from '../server/database.js';

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

async function main() {
  const esp32Key = process.env.FG_ESP32_API_KEY;
  const esp8266Key = process.env.FG_ESP8266_API_KEY;
  if (!esp32Key || esp32Key.length < 32 || !esp8266Key || esp8266Key.length < 32 || esp32Key === esp8266Key) {
    throw new Error('Set two different random FG_ESP32_API_KEY and FG_ESP8266_API_KEY values of at least 32 characters.');
  }
  await migrateDatabase();
  const tenantId = 'floodguard-demo-tenant';
  const cityId = 'river-island-city';
  const zoneId = 'ward-04-north-bank';
  const now = currentTimestamp();
  await execute('INSERT INTO tenants(id,name,slug,created_at) VALUES(?,?,?,?) ON CONFLICT(slug) DO UPDATE SET name=excluded.name', [tenantId, 'FloodGuard Demo Tenant', 'floodguard-demo', now]);
  await execute('INSERT INTO cities(id,tenant_id,name,created_at) VALUES(?,?,?,?) ON CONFLICT(tenant_id,name) DO NOTHING', [cityId, tenantId, 'River Island City', now]);
  const city = await execute('SELECT id FROM cities WHERE tenant_id=? AND name=?', [tenantId, 'River Island City']);
  const actualCityId = String(city.rows[0]?.id || cityId);
  await execute('INSERT INTO zones(id,city_id,name,created_at) VALUES(?,?,?,?) ON CONFLICT(city_id,name) DO NOTHING', [zoneId, actualCityId, 'Ward 04 · North Bank', now]);
  const zone = await execute('SELECT id FROM zones WHERE city_id=? AND name=?', [actualCityId, 'Ward 04 · North Bank']);
  const actualZoneId = String(zone.rows[0]?.id || zoneId);
  const devices = [
    { id: 'fg-esp32-01', name: 'Main control node', kind: 'ESP32_CONTROLLER', key: esp32Key },
    { id: 'fg-esp8266-01', name: 'North gauge sender', kind: 'ESP8266_SENDER', key: esp8266Key },
  ];
  for (const device of devices) {
    await execute(`INSERT INTO devices(id,tenant_id,city_id,zone_id,name,kind,api_key_hash,firmware_version,enabled,last_seq,current_state,barrier_state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'0.1.0-demo',1,0,'UNKNOWN','DOWN',?,?)
      ON CONFLICT(id) DO UPDATE SET api_key_hash=excluded.api_key_hash,enabled=1,updated_at=excluded.updated_at`,
    [device.id, tenantId, actualCityId, actualZoneId, device.name, device.kind, hash(device.key), now, now]);
  }
  const controllerCount = await execute('SELECT COUNT(*) AS count FROM telemetry WHERE device_id=?', ['fg-esp32-01']);
  if (Number(controllerCount.rows[0]?.count || 0) === 0) {
    const levels = [9.5, 11.1, 13.8, 12.9, 16.4, 19.7, 21.2, 24.5, 26.8, 29.3, 31.8, 34.2];
    for (let index = 0; index < levels.length; index += 1) {
      const levelCm = levels[index]!;
      const state = levelCm >= 50 ? 'CRITICAL' : levelCm >= 35 ? 'WARNING' : levelCm >= 20 ? 'WATCH' : 'NORMAL';
      const createdAt = new Date(Date.now() - (levels.length - index - 1) * 10 * 60_000).toISOString();
      await execute('INSERT INTO telemetry(id,device_id,seq,level_cm,rainfall_mm,state,barrier_state,sensor_healthy,created_at,received_at) VALUES(?,?,?,?,?,?,?,1,?,?)', [randomId(), 'fg-esp32-01', index + 1, levelCm, Math.max(0, Math.round((index - 2) * 1.7)), state, 'DOWN', createdAt, createdAt]);
    }
    await execute("UPDATE devices SET last_seq=12,last_seen_at=?,current_state='WATCH',barrier_state='DOWN',updated_at=? WHERE id='fg-esp32-01'", [now, now]);
  }
  const senderCount = await execute('SELECT COUNT(*) AS count FROM telemetry WHERE device_id=?', ['fg-esp8266-01']);
  if (Number(senderCount.rows[0]?.count || 0) === 0) {
    await execute('INSERT INTO telemetry(id,device_id,seq,level_cm,rainfall_mm,state,barrier_state,sensor_healthy,created_at,received_at) VALUES(?,?,1,29.6,24,\'WATCH\',\'DOWN\',1,?,?)', [randomId(), 'fg-esp8266-01', now, now]);
    await execute("UPDATE devices SET last_seq=1,last_seen_at=?,current_state='WATCH',updated_at=? WHERE id='fg-esp8266-01'", [now, now]);
  }
  await execute('INSERT INTO firmware_releases(id,version,sha256,size_bytes,asset_url,channel,notes,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(version) DO NOTHING', [randomId(), '0.1.0-demo', 'not-published', 0, '', 'demo', 'No firmware binary is published by this preview.', now]);
  await execute('INSERT INTO site_settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING', ['maintenance_mode', 'false', now]);
  console.log('FloodGuard Turso schema, demo tenant, devices and sample telemetry are ready.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { if (process.env.TURSO_DATABASE_URL) await requireTurso().close(); });
