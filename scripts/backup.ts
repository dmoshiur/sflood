import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../server/config.js';
import { connectDatabase, currentTimestamp, execute, primaryTenantId, randomId, turso } from '../server/database.js';

/**
 * Database backup.
 *
 * Local libSQL file: copy the database file (after a WAL checkpoint) next to a
 * SHA-256 checksum so a restore can be verified.
 * Turso: the managed service provides point-in-time backups; this script records
 * a backup marker so the operations console and audit trail stay accurate.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backupDirectory = path.join(projectRoot, 'backups');

async function main() {
  await connectDatabase();
  const tenantId = await primaryTenantId();
  fs.mkdirSync(backupDirectory, { recursive: true });

  let target = 'turso (managed)';
  let sizeBytes = 0;
  let sha256: string | null = null;

  if (config.isLocalDatabase) {
    await execute('PRAGMA wal_checkpoint(TRUNCATE)');
    const source = config.databaseUrl.replace(/^file:/, '');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = path.join(backupDirectory, `floodgrid-${stamp}.db`);
    fs.copyFileSync(source, destination);
    const buffer = fs.readFileSync(destination);
    sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    sizeBytes = buffer.length;
    target = destination;
    fs.writeFileSync(`${destination}.sha256`, `${sha256}  ${path.basename(destination)}\n`);
    console.log(`[floodgrid] backup written: ${destination}`);
    console.log(`[floodgrid] sha256: ${sha256}`);
  } else {
    console.log('[floodgrid] Turso mode: use the Turso dashboard or CLI to create a point-in-time backup, then record it here.');
  }

  await execute(
    'INSERT INTO backups(id,tenant_id,kind,target,size_bytes,sha256,status,note,created_by,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [randomId(), tenantId, 'SCHEDULED', target, sizeBytes, sha256, 'COMPLETED', 'Created by scripts/backup.ts', null, currentTimestamp(), currentTimestamp()],
  );
  console.log('[floodgrid] backup marker recorded in the database.');
}

main()
  .catch((error) => { console.error('[floodgrid] backup failed:', error); process.exitCode = 1; })
  .finally(async () => { try { await turso.close(); } catch { /* already closed */ } });
