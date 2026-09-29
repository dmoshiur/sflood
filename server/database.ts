import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type Client, type InValue, type ResultSet, type Transaction } from '@libsql/client';
import { config } from './config.js';

/**
 * libSQL database core.
 *
 * The same code path runs against a local file database (default, so the whole
 * platform works end-to-end on a laptop) and against Turso when
 * TURSO_DATABASE_URL is set. There is no in-memory mock mode: every value shown
 * in the UI comes from this database or from a real device.
 */

export const turso: Client = createClient({
  url: config.databaseUrl,
  authToken: config.databaseAuthToken,
});
export const isDatabaseConfigured = true;
export const isTursoConfigured = !config.isLocalDatabase;
export type Row = Record<string, unknown>;

export class DatabaseRequestError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function requireDatabase(): Client { return turso; }

export async function execute(sql: string, args: InValue[] = [], executor: Client | Transaction = turso): Promise<ResultSet> {
  return executor.execute({ sql, args });
}

export async function queryAll<T = Row>(sql: string, args: InValue[] = []): Promise<T[]> {
  const result = await execute(sql, args);
  return result.rows.map((row) => row as T);
}

export async function queryOne<T = Row>(sql: string, args: InValue[] = []): Promise<T | null> {
  const rows = await queryAll<T>(sql, args);
  return rows.length ? rows[0]! : null;
}

export async function connectDatabase(): Promise<boolean> {
  await turso.execute('SELECT 1 AS connected');
  return true;
}

export async function migrateDatabase(): Promise<string[]> {
  await turso.execute('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const migrationDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
  const migrationFiles = fs.readdirSync(migrationDirectory).filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file)).sort();
  const applied: string[] = [];
  for (const file of migrationFiles) {
    const version = file.slice(0, -4);
    const exists = await execute('SELECT version FROM schema_migrations WHERE version = ?', [version]);
    if (exists.rows.length) continue;
    const source = fs.readFileSync(path.join(migrationDirectory, file), 'utf8');
    const statements = source.split(';').map((statement) => statement.trim()).filter(Boolean);
    const tx = await turso.transaction('write');
    try {
      for (const statement of statements) {
        const addColumn = statement.match(/^ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)/i);
        if (addColumn) {
          const [, table, column] = addColumn;
          const columns = await tx.execute(`PRAGMA table_info(${table})`);
          if (columns.rows.some((row) => String((row as Row).name) === column)) continue;
        }
        await tx.execute(statement);
      }
      await tx.execute({ sql: 'INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)', args: [version, new Date().toISOString()] });
      await tx.commit();
      applied.push(version);
    } catch (error) {
      await tx.rollback();
      throw new Error(`Migration ${version} failed: ${(error as Error).message}`);
    }
  }
  return applied;
}

export function randomId(): string { return crypto.randomUUID(); }
export function currentTimestamp(): string { return new Date().toISOString(); }

export async function insertAudit(input: {
  tenantId: string; actorId?: string | null; action: string; targetType: string; targetId?: string | null;
  metadata?: unknown; ipAddress?: string | null;
}, executor: Client | Transaction = turso) {
  return execute(
    'INSERT INTO audit_logs(id,tenant_id,actor_id,action,target_type,target_id,metadata_json,ip_address,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [randomId(), input.tenantId, input.actorId ?? null, input.action, input.targetType, input.targetId ?? null, JSON.stringify(input.metadata ?? {}), input.ipAddress ?? null, currentTimestamp()],
    executor,
  );
}

export function rowText(value: unknown, key: string, fallback = ''): string {
  const raw = (value as Row | undefined)?.[key];
  return typeof raw === 'string' ? raw : raw === null || raw === undefined ? fallback : String(raw);
}
export function rowNumber(value: unknown, key: string, fallback = 0): number {
  const raw = (value as Row | undefined)?.[key];
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'bigint') return Number(raw);
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
export function rowNullableNumber(value: unknown, key: string): number | null {
  const raw = (value as Row | undefined)?.[key];
  if (raw === null || raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
export function rowBoolean(value: unknown, key: string): boolean {
  const raw = (value as Row | undefined)?.[key];
  return raw === true || raw === 1 || raw === 1n || raw === '1';
}

/**
 * True when a nullable *timestamp* or *credential* column holds a value.
 *
 * These columns store an ISO timestamp or an encrypted secret rather than 0/1,
 * so `rowBoolean` would report them as unset. Use this for `*_at` columns and
 * for encrypted credential columns such as `totp_secret_enc`.
 */
export function rowIsSet(value: unknown, key: string): boolean {
  const raw = (value as Row | undefined)?.[key];
  if (raw === null || raw === undefined) return false;
  if (typeof raw === 'string') return raw.trim().length > 0;
  return raw === true || raw === 1 || raw === 1n;
}
export function rowJson<T>(value: unknown, key: string, fallback: T): T {
  const raw = (value as Row | undefined)?.[key];
  if (typeof raw !== 'string' || !raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/** Tenant used by the single-tenant science-fair deployment. */
export async function primaryTenantId(): Promise<string> {
  const row = await queryOne("SELECT id FROM tenants ORDER BY created_at LIMIT 1");
  if (!row) throw new DatabaseRequestError(503, 'Run npm run db:seed to create the tenant and service areas.');
  return rowText(row, 'id');
}

export async function getSiteSetting(key: string, fallback: unknown = null): Promise<unknown> {
  const row = await queryOne('SELECT value_json FROM site_settings WHERE key=?', [key]);
  if (!row) return fallback;
  try { return JSON.parse(rowText(row, 'value_json', 'null')); } catch { return fallback; }
}

export async function setSiteSetting(key: string, value: unknown, actorId: string | null = null): Promise<void> {
  await execute(
    `INSERT INTO site_settings(key,value_json,updated_by,updated_at) VALUES (?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
    [key, JSON.stringify(value), actorId, currentTimestamp()],
  );
}

export async function getFeatureFlag(key: string, fallback = false): Promise<boolean> {
  const row = await queryOne('SELECT value_json FROM feature_flags WHERE key=?', [key]);
  if (!row) return fallback;
  try { return Boolean(JSON.parse(rowText(row, 'value_json', 'false'))); } catch { return fallback; }
}

export async function setFeatureFlag(key: string, value: boolean, description = '', actorId: string | null = null): Promise<void> {
  await execute(
    `INSERT INTO feature_flags(key,value_json,description,updated_by,updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,description=excluded.description,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
    [key, JSON.stringify(value), description, actorId, currentTimestamp()],
  );
}

export async function allFeatureFlags(): Promise<Record<string, boolean>> {
  const rows = await queryAll('SELECT key,value_json FROM feature_flags');
  const flags: Record<string, boolean> = {};
  for (const row of rows) {
    try { flags[rowText(row, 'key')] = Boolean(JSON.parse(rowText(row, 'value_json', 'false'))); } catch { /* ignore malformed flag */ }
  }
  return flags;
}

export async function isMaintenanceMode(): Promise<boolean> {
  return Boolean(await getSiteSetting('maintenance_mode', false));
}

export async function tableCounts(): Promise<Record<string, number>> {
  const tables = ['users', 'devices', 'telemetry', 'flood_events', 'notifications', 'barrier_commands', 'audit_logs', 'email_subscribers', 'push_subscriptions'];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const row = await queryOne(`SELECT COUNT(*) AS count FROM ${table}`);
    counts[table] = rowNumber(row, 'count');
  }
  return counts;
}
