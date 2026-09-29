import 'dotenv/config';
import { execute, migrateDatabase, requireTurso, currentTimestamp } from '../server/database.js';

async function main() {
  await migrateDatabase();
  const tenantId = 'floodguard-project-tenant';
  const cityId = 'project-city';
  const zoneId = 'project-zone';
  const now = currentTimestamp();
  await execute('INSERT INTO tenants(id,name,slug,created_at) VALUES(?,?,?,?) ON CONFLICT(slug) DO UPDATE SET name=excluded.name', [tenantId, 'FloodGuard Project', 'floodguard-project', now]);
  await execute('INSERT INTO cities(id,tenant_id,name,created_at) VALUES(?,?,?,?) ON CONFLICT(tenant_id,name) DO NOTHING', [cityId, tenantId, 'Project City', now]);
  const actualCityId = cityId;
  await execute('INSERT INTO zones(id,city_id,name,created_at) VALUES(?,?,?,?) ON CONFLICT(city_id,name) DO NOTHING', [zoneId, actualCityId, 'Project Zone', now]);
  await execute('INSERT INTO projects(id,tenant_id,name,description,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(tenant_id) DO NOTHING', ['floodguard-project', tenantId, 'FloodGuard Project', 'ESP32-based flood monitoring and model barrier control.', now, now]);
  // Base project metadata only. Never create devices, users, or telemetry as seed data.
  await execute('INSERT INTO site_settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING', ['maintenance_mode', 'false', now]);
  console.log('FloodGuard Turso schema and base project metadata are ready. No users, devices, or telemetry were inserted.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { if (process.env.TURSO_DATABASE_URL) await requireTurso().close(); });
