import 'dotenv/config';
import { connectDatabase, migrateDatabase, turso } from '../server/database.js';
import { config } from '../server/config.js';

/**
 * Apply every pending SQL migration.
 *
 * Works against the local libSQL file database and against Turso. Safe to run on
 * every deploy: already-applied migrations are skipped.
 */

async function main() {
  await connectDatabase();
  const applied = await migrateDatabase();
  if (applied.length) console.log(`[floodgrid] applied migrations: ${applied.join(', ')}`);
  else console.log('[floodgrid] database schema is already up to date.');
  console.log(`[floodgrid] database target: ${config.isLocalDatabase ? config.databaseUrl : 'Turso (managed libSQL)'}`);
}

main()
  .catch((error) => {
    console.error('[floodgrid] migration failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await turso.close(); } catch { /* already closed */ }
  });
