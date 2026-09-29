import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type Client, type InValue, type ResultSet, type Transaction } from '@libsql/client';
import { buzzerForState, normalizeFloodState, type BarrierState, type FloodState } from '../shared/flood-state.js';
import { rateOfRiseCmPerMin } from '../shared/flood-engine.js';
import type { DashboardPayload, DeviceSummary, FloodEvent, TelemetryPoint } from '../shared/types.js';

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
    rainfallMm: nullableNumber(row, 'rainfall_mm'), state: normalizeFloodState(text(row, 'state', 'UNKNOWN')),
    sensorHealthy: boolean(row, 'sensor_healthy'), barrierState: text(row, 'barrier_state') || null, distanceCm: nullableNumber(row, 'distance_cm'), temperatureC: nullableNumber(row, 'temperature_c'), createdAt: iso(row.created_at),
  };
}

function toDevice(raw: unknown): DeviceSummary {
  const row = asRow(raw);
  const lastSeenAt = text(row, 'last_seen_at');
  const seenMs = new Date(lastSeenAt).getTime();
  const rssi = nullableNumber(row, 'latest_rssi');
  return {
    id: text(row, 'id'), name: text(row, 'name'),
    kind: text(row, 'kind') === 'ESP32_CONTROLLER' ? 'ESP32 controller' : 'ESP8266 sender',
    zone: text(row, 'zone_name'), firmwareVersion: text(row, 'firmware_version'),
    online: boolean(row, 'enabled') && Number.isFinite(seenMs) && Date.now() - seenMs < 120_000,
    lastSeenAt, signal: rssi === null ? null : Math.max(0, Math.min(100, Math.round((rssi + 100) * 3))),
    latestLevelCm: nullableNumber(row, 'latest_level_cm'), state: normalizeFloodState(text(row, 'latest_state', 'UNKNOWN')),
    approvalState: text(row, 'approval_state', 'APPROVED'),
    limitSwitchState: text(row, 'limit_switch_state') || null,
    faultState: text(row, 'fault_state') || null,
  };
}

function eventTitle(state: string): [string, string] {
  return ({
    NORMAL: ['Level returned to NORMAL', 'The latest calibrated sample is below 20 cm.'],
    RECOVERY: ['Recovery in progress', 'The water level is receding; NORMAL resumes after the recovery cooldown.'],
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

export async function getTursoDashboard(tenantId?: string): Promise<DashboardPayload> {
  requireTurso();
  const rows = await getDashboardRows(tenantId);
  const rawDevices = await execute(`SELECT d.*, z.name AS zone_name, c.name AS city_name FROM devices d JOIN zones z ON z.id=d.zone_id JOIN cities c ON c.id=d.city_id WHERE d.tenant_id=COALESCE(?,(SELECT id FROM tenants ORDER BY created_at LIMIT 1)) ORDER BY d.created_at ASC`, [tenantId ?? null]);
  const controllerRaw = rawDevices.rows.map(asRow).find((row) => text(row, 'kind') === 'ESP32_CONTROLLER') || rawDevices.rows.map(asRow)[0];
  if (!controllerRaw) {
    const maintenanceResult = await execute("SELECT value_json FROM site_settings WHERE key='maintenance_mode'");
    const maintenanceMode = maintenanceResult.rows.length > 0 && text(asRow(maintenanceResult.rows[0]), 'value_json') === 'true';
    return { mode: 'turso', project: 'FloodGuard — Smart Flood Control & Automation', city: '—', zone: '—', updatedAt: new Date().toISOString(), system: { levelCm: null, distanceCm: null, state: 'UNKNOWN', barrier: 'HOLD', buzzer: false, sensorHealthy: false, emergencyStopActive: false, barrierLatched: false, trendCm: null, rainfallMm: null, seq: null }, stats: { activeDevices: 0, zones: 0, alerts: 0, samplesToday: 0 }, devices: rows, history: [], events: [], maintenanceMode };
  }
  const controller = controllerRaw;
  const points = await execute('SELECT * FROM telemetry WHERE device_id=? ORDER BY seq DESC LIMIT 40', [text(controller, 'id')]);
  const chronological = [...points.rows].reverse();
  const history = chronological.map(toPoint);
  const latest = chronological.length ? asRow(chronological[chronological.length - 1]) : null;
  const latestState = latest ? text(latest, 'state', 'UNKNOWN') as FloodState : text(controller, 'current_state', 'UNKNOWN') as FloodState;
  const prior = chronological.length >= 4 ? asRow(chronological[chronological.length - 4]) : chronological.length >= 2 ? asRow(chronological[chronological.length - 2]) : null;
  const trendCm = latest && prior ? Math.round((number(latest, 'level_cm') - number(prior, 'level_cm')) * 10) / 10 : null;
  const nowIso = new Date().toISOString();
  const countToday = await execute('SELECT COUNT(*) AS count FROM telemetry WHERE device_id=? AND created_at>=?', [text(controller, 'id'), new Date(new Date().setHours(0, 0, 0, 0)).toISOString()]);
  const zoneCount = await execute('SELECT COUNT(*) AS count FROM zones WHERE city_id=?', [text(controller, 'city_id')]);
  const maintenanceResult = await execute("SELECT value_json FROM site_settings WHERE key='maintenance_mode'");
  const maintenanceMode = maintenanceResult.rows.length > 0 && text(asRow(maintenanceResult.rows[0]), 'value_json') === 'true';
  const events: FloodEvent[] = [];
  const persisted = await execute('SELECT id,state,reason,created_at FROM flood_events WHERE device_id=? ORDER BY created_at DESC LIMIT 8', [text(controller, 'id')]);
  for (const raw of persisted.rows) {
    const row = asRow(raw);
    const [title, message] = eventTitle(text(row, 'state'));
    events.push({ id: text(row, 'id'), title, message: text(row, 'reason') || message, state: normalizeFloodState(text(row, 'state')), createdAt: iso(row.created_at) });
  }
  const state = boolean(controller, 'emergency_stop_active') ? 'FAULT' : latestState;
  const currentBarrier = latest ? text(controller, 'barrier_state', 'HOLD') as BarrierState : null;
  return {
    mode: 'turso', project: 'FloodGuard — Smart Flood Control & Automation',
    city: text(controller, 'city_name', 'Unconfigured city'), zone: text(controller, 'zone_name', 'Unconfigured zone'), updatedAt: nowIso,
    system: {
      levelCm: latest && !boolean(latest, 'sensor_healthy') ? null : latest ? number(latest, 'level_cm') : null,
      distanceCm: latest ? nullableNumber(latest, 'distance_cm') : null,
      state,
      barrier: currentBarrier,
      buzzer: buzzerForState(state), sensorHealthy: latest ? boolean(latest, 'sensor_healthy') : false,
      emergencyStopActive: boolean(controller, 'emergency_stop_active'), barrierLatched: boolean(controller, 'barrier_latched'),
      trendCm: latest ? trendCm : null, rainfallMm: latest ? nullableNumber(latest, 'rainfall_mm') : null, seq: latest ? number(latest, 'seq') : null,
    },
    stats: { activeDevices: rows.filter((item) => item.online).length, zones: number(asRow(zoneCount.rows[0] || {}), 'count'), alerts: ['WATCH', 'WARNING', 'CRITICAL', 'FAULT'].includes(state) ? 1 : 0, samplesToday: number(asRow(countToday.rows[0] || {}), 'count') },
    devices: rows, history, events: events.slice(-8).reverse(), maintenanceMode,
  };
}

export async function getTursoHistory(limit: number, tenantId?: string, requestedDeviceId?: string, from?: string, to?: string): Promise<TelemetryPoint[]> {
  if (requestedDeviceId) {
    const owned = await execute('SELECT id FROM devices WHERE id=? AND tenant_id=COALESCE(?,tenant_id)', [requestedDeviceId, tenantId ?? null]);
    if (!owned.rows.length) return [];
    const result = await execute('SELECT * FROM telemetry WHERE device_id=? AND (? IS NULL OR created_at>=?) AND (? IS NULL OR created_at<=?) ORDER BY seq DESC LIMIT ?', [requestedDeviceId, from ?? null, from ?? null, to ?? null, to ?? null, limit]);
    return [...result.rows].reverse().map(toPoint);
  }
  const result = await execute(`SELECT t.* FROM telemetry t JOIN devices d ON d.id=t.device_id WHERE d.tenant_id=COALESCE(?,(SELECT id FROM tenants ORDER BY created_at LIMIT 1)) AND (? IS NULL OR t.created_at>=?) AND (? IS NULL OR t.created_at<=?) ORDER BY t.created_at DESC LIMIT ?`, [tenantId ?? null, from ?? null, from ?? null, to ?? null, to ?? null, limit]);
  return [...result.rows].reverse().map(toPoint);
}

export async function getTursoDevices(tenantId?: string): Promise<DeviceSummary[]> { return getDashboardRows(tenantId); }

export async function getTursoDeviceReadings(deviceId: string, tenantId: string, limit: number, from?: string, to?: string): Promise<TelemetryPoint[] | null> {
  const owned = await execute('SELECT id FROM devices WHERE id=? AND tenant_id=?', [deviceId, tenantId]);
  if (!owned.rows.length) return null;
  const result = await execute('SELECT * FROM telemetry WHERE device_id=? AND (? IS NULL OR created_at>=?) AND (? IS NULL OR created_at<=?) ORDER BY seq DESC LIMIT ?', [deviceId, from ?? null, from ?? null, to ?? null, to ?? null, limit]);
  return [...result.rows].reverse().map(toPoint);
}


export async function getTursoDeviceDetail(deviceId: string, tenantId?: string) {
  const result = await execute(`SELECT d.*, z.name AS zone_name, c.name AS city_name FROM devices d JOIN zones z ON z.id=d.zone_id JOIN cities c ON c.id=d.city_id WHERE d.id=? AND d.tenant_id=COALESCE(?,d.tenant_id)`, [deviceId, tenantId ?? null]);
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
  deviceId: string; seq: number; levelCm: number; distanceCm?: number; rainfallMm?: number; sensorHealthy: boolean;
  deviceState?: FloodState; reportedBarrier?: BarrierState; emergencyStopActive?: boolean;
  rateOfRiseCmPerMin?: number | null; rssi?: number | null; uptimeS?: number | null;
  firmwareVersion?: string | null; faultState?: string | null; limitSwitchState?: string | null;
  reportedAt?: string | null;
}) {
  const client = requireTurso();
  const { evaluateAndRecord } = await import('./flood-engine.js');
  const deviceResult = await execute('SELECT * FROM devices WHERE id=?', [input.deviceId]);
  if (!deviceResult.rows.length || !boolean(asRow(deviceResult.rows[0]), 'enabled')) throw new DatabaseRequestError(401, 'Device credentials are invalid.');
  const device = asRow(deviceResult.rows[0]);
  if (text(device, 'approval_state', 'APPROVED') !== 'APPROVED') throw new DatabaseRequestError(403, 'Device is not approved for telemetry ingestion.');
  if (input.seq <= number(device, 'last_seq')) throw new DatabaseRequestError(409, 'Sequence number was already received or is out of order.');
  const emergencyStopActive = input.emergencyStopActive ?? false;
  const now = Date.now();
  const createdAt = new Date(now).toISOString();

  // Rate of rise: prefer the device-reported value, otherwise derive from the previous sample.
  const prior = await execute('SELECT level_cm,created_at FROM telemetry WHERE device_id=? ORDER BY seq DESC LIMIT 1', [input.deviceId]);
  const priorLevel = prior.rows.length ? nullableNumber(asRow(prior.rows[0]), 'level_cm') : null;
  const priorAt = prior.rows.length ? new Date(iso(asRow(prior.rows[0]).created_at)).getTime() : 0;
  const rate = Number.isFinite(input.rateOfRiseCmPerMin ?? NaN) && (input.rateOfRiseCmPerMin ?? null) !== null
    ? Number(input.rateOfRiseCmPerMin)
    : rateOfRiseCmPerMin(priorLevel, priorAt, input.levelCm, now);

  // Flood engine decides the persistent state (NORMAL … RECOVERY) with hysteresis,
  // rate-of-rise, cooldown and duplicate-event prevention; it also persists the
  // flood event, fans out notifications, applies barrier automation and audits.
  const evaluation = await evaluateAndRecord({
    tenantId: text(device, 'tenant_id'),
    zoneId: text(device, 'zone_id'),
    deviceId: input.deviceId,
    levelCm: input.levelCm,
    sensorHealthy: input.sensorHealthy,
    emergencyStopActive,
    reportedBarrier: input.reportedBarrier,
    reportedState: input.deviceState,
    now,
    simulation: false,
  });

  const nextState: FloodState = !input.sensorHealthy ? 'UNKNOWN' : emergencyStopActive ? 'FAULT' : evaluation.engineState;
  let barrier: BarrierState = input.sensorHealthy ? 'DOWN' : 'HOLD';
  let latched = input.reportedBarrier === 'DOWN' ? false : boolean(device, 'barrier_latched');
  if (emergencyStopActive) barrier = 'FAULT';
  else if (input.reportedBarrier) barrier = input.reportedBarrier;
  else if (nextState === 'WARNING' || nextState === 'CRITICAL') { barrier = 'RAISED'; latched = true; }
  else if (nextState === 'UNKNOWN') barrier = 'HOLD';
  else if (latched) barrier = 'RAISED';
  if (barrier === 'RAISED' || barrieringOrRaised(barrier)) latched = true;

  const pointId = id();
  const tx = await client.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO telemetry(id,device_id,seq,level_cm,distance_cm,rainfall_mm,rate_of_rise_cm_min,state,barrier_state,limit_switch_state,sensor_healthy,rssi,uptime_s,firmware_version,fault_state,reported_at,received_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        pointId, input.deviceId, input.seq, input.levelCm, input.distanceCm ?? null, input.rainfallMm ?? null, Math.round(rate * 100) / 100,
        nextState, barrier, input.limitSwitchState ?? null, input.sensorHealthy ? 1 : 0,
        input.rssi ?? null, input.uptimeS ?? null, input.firmwareVersion ?? null, input.faultState ?? null,
        input.reportedAt ?? null, createdAt, createdAt,
      ],
    });
    await tx.execute({
      sql: `INSERT INTO device_status(device_id,online,sensor_status,current_water_level,current_distance,barrier_state,last_heartbeat_at,updated_at)
        VALUES(?,1,?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET online=1,sensor_status=excluded.sensor_status,current_water_level=excluded.current_water_level,current_distance=excluded.current_distance,barrier_state=excluded.barrier_state,last_heartbeat_at=excluded.last_heartbeat_at,updated_at=excluded.updated_at`,
      args: [input.deviceId, input.sensorHealthy ? 'ok' : 'fault', input.sensorHealthy ? input.levelCm : null, input.distanceCm ?? null, barrier, createdAt, createdAt],
    });
    await tx.execute({
      sql: 'UPDATE devices SET last_seq=?,last_seen_at=?,current_state=?,barrier_state=?,barrier_latched=?,emergency_stop_active=?,rate_of_rise_cm_min=?,last_rssi=?,uptime_s=?,fault_state=?,limit_switch_state=?,firmware_version=COALESCE(?,firmware_version),updated_at=? WHERE id=?',
      args: [
        input.seq, createdAt, nextState, barrier, latched ? 1 : 0, emergencyStopActive ? 1 : 0,
        Math.round(rate * 100) / 100, input.rssi ?? null, input.uptimeS ?? null, input.faultState ?? null,
        input.limitSwitchState ?? null, input.firmwareVersion ?? null, createdAt, input.deviceId,
      ],
    });
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    if (String((error as { code?: string }).code || '').includes('SQLITE_CONSTRAINT')) throw new DatabaseRequestError(409, 'Duplicate or replayed telemetry.');
    throw error;
  }
  return {
    id: pointId, seq: input.seq, state: nextState, engineState: evaluation.engineState, barrier,
    rateOfRiseCmPerMin: Math.round(rate * 100) / 100,
    floodEventId: evaluation.floodEventId, commandId: evaluation.commandId,
    changed: evaluation.changed, duplicateSuppressed: evaluation.duplicateSuppressed,
    barrierPolicy: evaluation.barrierPolicy, barrierReason: evaluation.barrierReason,
  };
}

function barrieringOrRaised(barrier: BarrierState): boolean {
  return barrier === 'RAISED' || barrier === 'RAISING';
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

export async function insertAudit(input: { tenantId: string; actorId?: string | null; action: string; targetType: string; targetId?: string | null; metadata?: unknown; ipAddress?: string | null }, executor: Client | Transaction = requireTurso()) {
  return execute('INSERT INTO audit_logs(id,tenant_id,actor_id,action,target_type,target_id,metadata_json,ip_address,created_at) VALUES (?,?,?,?,?,?,?,?,?)', [id(), input.tenantId, input.actorId ?? null, input.action, input.targetType, input.targetId ?? null, JSON.stringify(input.metadata ?? {}), input.ipAddress ?? null, new Date().toISOString()], executor);
}

export function rowText(value: unknown, key: string, fallback = '') { return text(asRow(value), key, fallback); }
export function rowNumber(value: unknown, key: string, fallback = 0) { return number(asRow(value), key, fallback); }
export function rowBoolean(value: unknown, key: string) { return boolean(asRow(value), key); }
export function randomId() { return id(); }
export function currentTimestamp() { return new Date().toISOString(); }
