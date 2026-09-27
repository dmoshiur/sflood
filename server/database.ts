import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type Client, type InValue, type ResultSet, type Transaction } from '@libsql/client';
import { buzzerForState, floodStateForLevel, type BarrierState, type FloodState } from '../shared/flood-state.js';
import type { DashboardPayload, DeviceSummary, FloodEvent, TelemetryPoint } from '../shared/types.js';
import { createSmsUnsubscribeToken } from './security.js';

const dbUrl = process.env.TURSO_DATABASE_URL || '';
export const turso: Client | null = dbUrl
  ? createClient({ url: dbUrl, authToken: process.env.TURSO_AUTH_TOKEN || undefined })
  : null;
export const isTursoConfigured = Boolean(turso);
export const isDatabaseConfigured = isTursoConfigured;
type Row = Record<string, unknown>;

export class DatabaseRequestError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function requireTurso(): Client {
  if (!turso) throw new Error('Turso is not configured. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.');
  return turso;
}

export async function execute(sql: string, args: InValue[] = [], executor: Client | Transaction = requireTurso()): Promise<ResultSet> {
  return executor.execute({ sql, args });
}

export async function connectDatabase() {
  if (!turso) return false;
  await turso.execute('SELECT 1 AS connected');
  return true;
}

export async function migrateDatabase() {
  const client = requireTurso();
  await client.execute('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const migrationDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
  const migrationFiles = fs.readdirSync(migrationDirectory).filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file)).sort();
  for (const file of migrationFiles) {
    const version = file.slice(0, -4);
    const exists = await client.execute({ sql: 'SELECT version FROM schema_migrations WHERE version = ?', args: [version] });
    if (exists.rows.length) continue;
    const source = fs.readFileSync(path.join(migrationDirectory, file), 'utf8');
    const statements = source.split(';').map((statement) => statement.trim()).filter(Boolean);
    const tx = await client.transaction('write');
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
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }
}

function asRow(value: unknown): Row { return value as Row; }
function text(row: Row, key: string, fallback = ''): string { const value = row[key]; return typeof value === 'string' ? value : fallback; }
function number(row: Row, key: string, fallback = 0): number { const value = row[key]; return typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : fallback; }
function nullableNumber(row: Row, key: string): number | null { const value = row[key]; return typeof value === 'number' ? value : value === null || value === undefined ? null : Number(value); }
function boolean(row: Row, key: string): boolean { return row[key] === true || row[key] === 1 || row[key] === 1n; }
function id() { return crypto.randomUUID(); }
function iso(value: unknown): string { return typeof value === 'string' ? value : new Date().toISOString(); }

function toPoint(raw: unknown): TelemetryPoint {
  const row = asRow(raw);
  return {
    id: text(row, 'id'), deviceId: text(row, 'device_id'), seq: number(row, 'seq'), levelCm: number(row, 'level_cm'),
    rainfallMm: nullableNumber(row, 'rainfall_mm'), state: text(row, 'state', 'UNKNOWN') as FloodState,
    sensorHealthy: boolean(row, 'sensor_healthy'), createdAt: iso(row.created_at),
  };
}

function toDevice(raw: unknown): DeviceSummary {
  const row = asRow(raw);
  const lastSeenAt = text(row, 'last_seen_at', iso(row.created_at));
  const seenMs = new Date(lastSeenAt).getTime();
  const rssi = nullableNumber(row, 'latest_rssi');
  return {
    id: text(row, 'id'), name: text(row, 'name'),
    kind: text(row, 'kind') === 'ESP32_CONTROLLER' ? 'ESP32 controller' : 'ESP8266 sender',
    zone: text(row, 'zone_name'), firmwareVersion: text(row, 'firmware_version'),
    online: boolean(row, 'enabled') && Number.isFinite(seenMs) && Date.now() - seenMs < 120_000,
    lastSeenAt, signal: rssi === null ? 82 : Math.max(0, Math.min(100, Math.round((rssi + 100) * 3))),
    latestLevelCm: nullableNumber(row, 'latest_level_cm'), state: text(row, 'latest_state', 'UNKNOWN') as FloodState,
  };
}

function eventTitle(state: string): [string, string] {
  return ({
    SAFE: ['Level returned to SAFE', 'The latest calibrated sample is below 20 cm.'],
    WATCH: ['WATCH threshold reached', 'Sample water level is 20–34 cm.'],
    WARNING: ['WARNING threshold reached', 'Barrier-raise logic is active on the local controller.'],
    CRITICAL: ['CRITICAL threshold reached', 'The barrier remains raised and latched.'],
    UNKNOWN: ['Sensor reading UNKNOWN', 'Sensor fault or stale reading; hold position.'],
    FAULT: ['System entered FAULT', 'Actuation is inhibited pending local inspection.'],
  } as Record<string, [string, string]>)[state] || ['Telemetry received', 'New device telemetry has been stored.'];
}

async function getDashboardRows(tenantId?: string) {
  const tenantFilter = tenantId ? 'WHERE d.tenant_id = ?' : "WHERE d.tenant_id = (SELECT id FROM tenants ORDER BY created_at LIMIT 1)";
  const args = tenantId ? [tenantId] : [];
  const result = await execute(`
    SELECT d.*, z.name AS zone_name, c.name AS city_name,
      (SELECT t.level_cm FROM telemetry t WHERE t.device_id=d.id ORDER BY t.seq DESC LIMIT 1) AS latest_level_cm,
      (SELECT t.state FROM telemetry t WHERE t.device_id=d.id ORDER BY t.seq DESC LIMIT 1) AS latest_state,
      (SELECT t.rssi FROM telemetry t WHERE t.device_id=d.id ORDER BY t.seq DESC LIMIT 1) AS latest_rssi
    FROM devices d JOIN zones z ON z.id=d.zone_id JOIN cities c ON c.id=d.city_id
    ${tenantFilter} ORDER BY d.created_at ASC`, args);
  return result.rows.map(toDevice);
}

export async function getTursoDashboard(): Promise<DashboardPayload> {
  requireTurso();
  const rows = await getDashboardRows();
  const rawDevices = await execute(`SELECT d.*, z.name AS zone_name, c.name AS city_name FROM devices d JOIN zones z ON z.id=d.zone_id JOIN cities c ON c.id=d.city_id WHERE d.tenant_id=(SELECT id FROM tenants ORDER BY created_at LIMIT 1) ORDER BY d.created_at ASC`);
  const controllerRaw = rawDevices.rows.map(asRow).find((row) => text(row, 'kind') === 'ESP32_CONTROLLER') || rawDevices.rows.map(asRow)[0];
  if (!controllerRaw) throw new Error('No FloodGuard device is configured in Turso. Run npm run db:seed.');
  const controller = controllerRaw;
  const points = await execute('SELECT * FROM telemetry WHERE device_id=? ORDER BY seq DESC LIMIT 40', [text(controller, 'id')]);
  const chronological = [...points.rows].reverse();
  const history = chronological.map(toPoint);
  const latest = chronological.length ? asRow(chronological[chronological.length - 1]) : null;
  const latestState = latest ? text(latest, 'state', 'UNKNOWN') as FloodState : text(controller, 'current_state', 'UNKNOWN') as FloodState;
  const prior = chronological.length >= 4 ? asRow(chronological[chronological.length - 4]) : chronological.length >= 2 ? asRow(chronological[chronological.length - 2]) : null;
  const trendCm = latest && prior ? Math.round((number(latest, 'level_cm') - number(prior, 'level_cm')) * 10) / 10 : 0;
  const nowIso = new Date().toISOString();
  const countToday = await execute('SELECT COUNT(*) AS count FROM telemetry WHERE device_id=? AND created_at>=?', [text(controller, 'id'), new Date(new Date().setHours(0, 0, 0, 0)).toISOString()]);
  const zoneCount = await execute('SELECT COUNT(*) AS count FROM zones WHERE city_id=?', [text(controller, 'city_id')]);
  const maintenanceResult = await execute("SELECT value_json FROM site_settings WHERE key='maintenance_mode'");
  const maintenanceMode = maintenanceResult.rows.length > 0 && text(asRow(maintenanceResult.rows[0]), 'value_json') === 'true';
  const events: FloodEvent[] = [];
  for (let i = 1; i < history.length; i += 1) {
    if (history[i].state !== history[i - 1].state && history[i].state !== 'SAFE') {
      const [title, message] = eventTitle(history[i].state);
      events.push({ id: `transition-${history[i].id}`, title, message, state: history[i].state, createdAt: history[i].createdAt });
    }
  }
  const state = boolean(controller, 'emergency_stop_active') ? 'FAULT' : latestState;
  return {
    mode: 'turso', project: 'FloodGuard — Smart Flood Control & Automation',
    city: text(controller, 'city_name', 'Unconfigured city'), zone: text(controller, 'zone_name', 'Unconfigured zone'), updatedAt: nowIso,
    system: {
      levelCm: latest && !boolean(latest, 'sensor_healthy') ? null : latest ? number(latest, 'level_cm') : null,
      state,
      barrier: text(controller, 'barrier_state', 'HOLD') as BarrierState,
      buzzer: buzzerForState(state), sensorHealthy: latest ? boolean(latest, 'sensor_healthy') : false,
      emergencyStopActive: boolean(controller, 'emergency_stop_active'), barrierLatched: boolean(controller, 'barrier_latched'),
      trendCm, rainfallMm: latest ? nullableNumber(latest, 'rainfall_mm') : null, seq: latest ? number(latest, 'seq') : number(controller, 'last_seq'),
    },
    stats: { activeDevices: rows.filter((item) => item.online).length, zones: number(asRow(zoneCount.rows[0] || {}), 'count'), alerts: ['WATCH', 'WARNING', 'CRITICAL', 'FAULT'].includes(state) ? 1 : 0, samplesToday: number(asRow(countToday.rows[0] || {}), 'count') },
    devices: rows, history, events: events.slice(-8).reverse(), maintenanceMode,
  };
}

export async function getTursoHistory(limit: number): Promise<TelemetryPoint[]> {
  const controller = await execute("SELECT id FROM devices WHERE kind='ESP32_CONTROLLER' ORDER BY created_at LIMIT 1");
  if (!controller.rows.length) return [];
  const deviceId = text(asRow(controller.rows[0]), 'id');
  const result = await execute('SELECT * FROM telemetry WHERE device_id=? ORDER BY seq DESC LIMIT ?', [deviceId, limit]);
  return [...result.rows].reverse().map(toPoint);
}

export async function getTursoDevices(): Promise<DeviceSummary[]> { return getDashboardRows(); }

export async function getTursoDeviceDetail(deviceId: string) {
  const result = await execute(`SELECT d.*, z.name AS zone_name, c.name AS city_name FROM devices d JOIN zones z ON z.id=d.zone_id JOIN cities c ON c.id=d.city_id WHERE d.id=?`, [deviceId]);
  if (!result.rows.length) return null;
  const row = asRow(result.rows[0]);
  const latest = await execute('SELECT * FROM telemetry WHERE device_id=? ORDER BY seq DESC LIMIT 80', [deviceId]);
  return { device: toDevice({ ...row, latest_level_cm: nullableNumber(asRow(latest.rows[0] || {}), 'level_cm'), latest_state: text(asRow(latest.rows[0] || {}), 'state', 'UNKNOWN'), latest_rssi: nullableNumber(asRow(latest.rows[0] || {}), 'rssi') }), history: [...latest.rows].reverse().map(toPoint) };
}

export async function getTursoDeviceCredential(deviceId: string) {
  const result = await execute('SELECT id,api_key_hash,enabled,last_seq,kind FROM devices WHERE id=?', [deviceId]);
  return result.rows.length ? asRow(result.rows[0]) : null;
}

export async function ingestTursoTelemetry(input: {
  deviceId: string; seq: number; levelCm: number; rainfallMm?: number; sensorHealthy: boolean;
  deviceState?: FloodState; reportedBarrier?: BarrierState; emergencyStopActive?: boolean;
}) {
  const client = requireTurso();
  const tx = await client.transaction('write');
  try {
    const deviceResult = await tx.execute({ sql: 'SELECT * FROM devices WHERE id=?', args: [input.deviceId] });
    if (!deviceResult.rows.length || !boolean(asRow(deviceResult.rows[0]), 'enabled')) throw new DatabaseRequestError(401, 'Device credentials are invalid.');
    const device = asRow(deviceResult.rows[0]);
    if (input.seq <= number(device, 'last_seq')) throw new DatabaseRequestError(409, 'Sequence number was already received or is out of order.');
    const previousState = text(device, 'current_state', 'UNKNOWN') as FloodState;
    const emergencyStopActive = input.emergencyStopActive ?? false;
    const nextState = input.deviceState ?? (emergencyStopActive ? 'FAULT' : input.sensorHealthy ? floodStateForLevel(input.levelCm) : 'UNKNOWN');
    let barrier: BarrierState = input.sensorHealthy ? 'DOWN' : 'HOLD';
    let latched = input.reportedBarrier === 'DOWN' ? false : boolean(device, 'barrier_latched');
    if (emergencyStopActive) barrier = 'FAULT';
    else if (input.reportedBarrier) barrier = input.reportedBarrier;
    else if (nextState === 'WARNING' || nextState === 'CRITICAL') { barrier = 'RAISED'; latched = true; }
    else if (nextState === 'UNKNOWN') barrier = 'HOLD';
    else if (latched) barrier = 'RAISED';
    if (barrier === 'RAISED' || barrier === 'RAISING') latched = true;
    const createdAt = new Date().toISOString();
    const pointId = id();
    await tx.execute({ sql: `INSERT INTO telemetry(id,device_id,seq,level_cm,rainfall_mm,state,barrier_state,sensor_healthy,created_at) VALUES (?,?,?,?,?,?,?,?,?)`, args: [pointId, input.deviceId, input.seq, input.levelCm, input.rainfallMm ?? null, nextState, barrier, input.sensorHealthy ? 1 : 0, createdAt] });
    await tx.execute({ sql: 'UPDATE devices SET last_seq=?,last_seen_at=?,current_state=?,barrier_state=?,barrier_latched=?,emergency_stop_active=?,updated_at=? WHERE id=?', args: [input.seq, createdAt, nextState, barrier, latched ? 1 : 0, emergencyStopActive ? 1 : 0, createdAt, input.deviceId] });
    if (nextState !== previousState) {
      await insertAudit({ tenantId: text(device, 'tenant_id'), action: 'TELEMETRY_STATE_CHANGE', targetType: 'device', targetId: input.deviceId, metadata: { from: previousState, to: nextState, seq: input.seq, levelCm: input.levelCm } }, tx);
      if (nextState === 'WARNING' || nextState === 'CRITICAL') await queueZoneAlerts({ device, pointId: input.seq, state: nextState, levelCm: input.levelCm, createdAt }, tx);
    }
    await tx.commit();
    return { id: pointId, seq: input.seq, state: nextState, barrier };
  } catch (error) {
    await tx.rollback();
    if (String((error as { code?: string }).code || '').includes('SQLITE_CONSTRAINT')) throw new DatabaseRequestError(409, 'Duplicate or replayed telemetry.');
    throw error;
  }
}

export function notificationTargetsForSubscription(recipient: Record<string, unknown>) {
  const targets: Array<{ channel: 'EMAIL' | 'SMS' | 'WEB_PUSH'; recipient: string }> = [];
  const subscriptionId = text(recipient, 'id');
  const email = text(recipient, 'email');
  const phone = text(recipient, 'phone');
  const pushEndpoint = text(recipient, 'push_endpoint');
  if (email && text(recipient, 'verified_at')) targets.push({ channel: 'EMAIL', recipient: email });
  if (phone && text(recipient, 'phone_verified_at')) targets.push({ channel: 'SMS', recipient: phone });
  if (pushEndpoint) targets.push({ channel: 'WEB_PUSH', recipient: subscriptionId });
  return targets;
}

function smsUnsubscribeUrl(subscriptionId: string) {
  const origin = process.env.PUBLIC_APP_URL;
  if (!origin) return null;
  try {
    const base = new URL(origin);
    if (base.protocol !== 'https:' && process.env.NODE_ENV === 'production') return null;
    const link = new URL('/api/notifications/unsubscribe', base);
    link.searchParams.set('token', createSmsUnsubscribeToken(subscriptionId));
    return link.toString();
  } catch { return null; }
}

async function queueZoneAlerts(input: { device: Row; pointId: number; state: FloodState; levelCm: number; createdAt: string }, executor: Transaction) {
  const device = input.device;
  const recipients = await executor.execute({ sql: 'SELECT * FROM subscriptions WHERE tenant_id=? AND zone_id=? AND unsubscribed_at IS NULL AND (verified_at IS NOT NULL OR phone_verified_at IS NOT NULL OR push_endpoint IS NOT NULL)', args: [text(device, 'tenant_id'), text(device, 'zone_id')] });
  const [title, body] = eventTitle(input.state);
  for (const raw of recipients.rows) {
    const recipient = asRow(raw);
    const subscriptionId = text(recipient, 'id');
    const targetRows = notificationTargetsForSubscription(recipient);
    for (const target of targetRows) {
      let payload: string;
      if (target.channel === 'SMS') {
        const unsubscribeUrl = smsUnsubscribeUrl(subscriptionId);
        if (!unsubscribeUrl) continue;
        payload = JSON.stringify({ title, body, zoneId: text(device, 'zone_id'), levelCm: input.levelCm, unsubscribeUrl });
      } else {
        payload = JSON.stringify({ title, body, zoneId: text(device, 'zone_id'), levelCm: input.levelCm, url: '/app' });
      }
      const dedupeKey = `${text(device, 'id')}:${input.pointId}:${input.state}:${target.channel}:${subscriptionId}`;
      await executor.execute({ sql: `INSERT OR IGNORE INTO outbox_events(id,dedupe_key,tenant_id,zone_id,channel,recipient,payload_json,status,attempts,next_attempt_at,created_at) VALUES (?,?,?,?,?,?,?,'PENDING',0,?,?)`, args: [id(), dedupeKey, text(device, 'tenant_id'), text(device, 'zone_id'), target.channel, target.recipient, payload, input.createdAt, input.createdAt] });
    }
  }
}

export async function insertAudit(input: { tenantId: string; actorId?: string | null; action: string; targetType: string; targetId?: string | null; metadata?: unknown; ipAddress?: string | null }, executor: Client | Transaction = requireTurso()) {
  return execute('INSERT INTO audit_logs(id,tenant_id,actor_id,action,target_type,target_id,metadata_json,ip_address,created_at) VALUES (?,?,?,?,?,?,?,?,?)', [id(), input.tenantId, input.actorId ?? null, input.action, input.targetType, input.targetId ?? null, JSON.stringify(input.metadata ?? {}), input.ipAddress ?? null, new Date().toISOString()], executor);
}

export function rowText(value: unknown, key: string, fallback = '') { return text(asRow(value), key, fallback); }
export function rowNumber(value: unknown, key: string, fallback = 0) { return number(asRow(value), key, fallback); }
export function rowBoolean(value: unknown, key: string) { return boolean(asRow(value), key); }
export function randomId() { return id(); }
export function currentTimestamp() { return new Date().toISOString(); }
