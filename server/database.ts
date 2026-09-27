import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { buzzerForState, floodStateForLevel, type BarrierState, type FloodState } from '../shared/flood-state.js';
import type { DashboardPayload, DeviceSummary, FloodEvent, TelemetryPoint } from '../shared/types.js';

export const prisma = process.env.DATABASE_URL ? new PrismaClient() : null;
export const isPostgresConfigured = Boolean(prisma);

export class DatabaseRequestError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function toPoint(row: { id: string; deviceId: string; seq: number; levelCm: number; rainfallMm: number | null; state: string; sensorHealthy: boolean; createdAt: Date }): TelemetryPoint {
  return { id: row.id, deviceId: row.deviceId, seq: row.seq, levelCm: row.levelCm, rainfallMm: row.rainfallMm, state: row.state as FloodState, sensorHealthy: row.sensorHealthy, createdAt: row.createdAt.toISOString() };
}

function toDevice(row: {
  id: string; name: string; kind: string; firmwareVersion: string; enabled: boolean; lastSeenAt: Date | null;
  zone: { name: string }; barrierState: string; telemetry: Array<{ levelCm: number; state: string; createdAt: Date; rssi: number | null }>;
}): DeviceSummary {
  const latest = row.telemetry[0];
  const lastSeenAt = row.lastSeenAt?.toISOString() || latest?.createdAt.toISOString() || new Date(0).toISOString();
  const rssi = latest?.rssi;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === 'ESP32_CONTROLLER' ? 'ESP32 controller' : 'ESP8266 sender',
    zone: row.zone.name,
    firmwareVersion: row.firmwareVersion,
    online: Boolean(row.enabled && row.lastSeenAt && Date.now() - row.lastSeenAt.getTime() < 120_000),
    lastSeenAt,
    signal: rssi === null || rssi === undefined ? 82 : Math.max(0, Math.min(100, Math.round((rssi + 100) * 3))),
    latestLevelCm: latest?.levelCm ?? null,
    state: (latest?.state || 'UNKNOWN') as FloodState,
  };
}

function eventTitle(state: string) {
  return {
    SAFE: ['Level returned to SAFE', 'The latest calibrated sample is below 20 cm.'],
    WATCH: ['WATCH threshold reached', 'Sample water level is 20–34 cm.'],
    WARNING: ['WARNING threshold reached', 'Barrier-raise logic is active on the local controller.'],
    CRITICAL: ['CRITICAL threshold reached', 'The barrier remains raised and latched.'],
    UNKNOWN: ['Sensor reading UNKNOWN', 'Sensor fault or stale reading; hold position.'],
    FAULT: ['System entered FAULT', 'Actuation is inhibited pending local inspection.'],
  }[state] || ['Telemetry received', 'New device telemetry has been stored.'];
}

export async function connectDatabase() {
  if (!prisma) return false;
  await prisma.$connect();
  return true;
}

export async function getPostgresDashboard(): Promise<DashboardPayload> {
  if (!prisma) throw new Error('PostgreSQL is not configured.');
  const rows = await prisma.device.findMany({
    include: {
      city: { include: { zones: true } },
      zone: true,
      telemetry: { orderBy: { createdAt: 'desc' }, take: 40 },
    },
    orderBy: { createdAt: 'asc' },
  });
  const mapped = rows.map(toDevice);
  const controller = rows.find((row: any) => row.kind === 'ESP32_CONTROLLER') || rows[0];
  const latest = controller?.telemetry[0];
  const historyRows = controller ? [...controller.telemetry].reverse() : [];
  const history = historyRows.map(toPoint);
  const currentState = (latest?.state || controller?.currentState || 'UNKNOWN') as FloodState;
  const prior = controller?.telemetry[3] || controller?.telemetry[1];
  const trendCm = latest && prior ? Math.round((latest.levelCm - prior.levelCm) * 10) / 10 : 0;
  const now = Date.now();
  const activeDevices = rows.filter((row: any) => row.enabled && row.lastSeenAt && now - row.lastSeenAt.getTime() < 120_000).length;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const samplesToday = controller ? await prisma.telemetry.count({ where: { deviceId: controller.id, createdAt: { gte: today } } }) : 0;
  const events: FloodEvent[] = [];
  for (let index = 1; index < historyRows.length; index += 1) {
    const current = historyRows[index];
    const previous = historyRows[index - 1];
    if (current.state !== previous.state && current.state !== 'SAFE') {
      const [title, message] = eventTitle(current.state);
      events.push({ id: `transition-${current.id}`, title, message, state: current.state as FloodState, createdAt: current.createdAt.toISOString() });
    }
  }
  const latestSetting = await prisma.siteSetting.findUnique({ where: { key: 'maintenance_mode' } });
  const maintenanceMode = latestSetting?.value === true;
  return {
    mode: 'postgres',
    project: 'FloodGuard — Smart Flood Control & Automation',
    city: controller?.city.name || rows[0]?.city.name || 'Unconfigured city',
    zone: controller?.zone.name || rows[0]?.zone.name || 'Unconfigured zone',
    updatedAt: new Date().toISOString(),
    system: {
      levelCm: latest?.sensorHealthy === false ? null : latest?.levelCm ?? null,
      state: controller?.emergencyStopActive ? 'FAULT' : currentState,
      barrier: (controller?.barrierState || 'HOLD') as BarrierState,
      buzzer: buzzerForState(currentState),
      sensorHealthy: latest?.sensorHealthy ?? false,
      emergencyStopActive: controller?.emergencyStopActive ?? false,
      barrierLatched: controller?.barrierLatched ?? false,
      trendCm,
      rainfallMm: latest?.rainfallMm ?? null,
      seq: latest?.seq ?? controller?.lastSeq ?? 0,
    },
    stats: {
      activeDevices,
      zones: controller?.city.zones.length || 0,
      alerts: ['WATCH', 'WARNING', 'CRITICAL', 'FAULT'].includes(currentState) ? 1 : 0,
      samplesToday,
    },
    devices: mapped,
    history,
    events: events.slice(-8).reverse(),
    maintenanceMode,
  };
}

export async function getPostgresHistory(limit: number): Promise<TelemetryPoint[]> {
  if (!prisma) return [];
  const rows = await prisma.telemetry.findMany({ where: { deviceId: 'fg-esp32-01' }, orderBy: { createdAt: 'desc' }, take: limit });
  return rows.reverse().map(toPoint);
}

export async function getPostgresDevices(): Promise<DeviceSummary[]> {
  if (!prisma) return [];
  const rows = await prisma.device.findMany({ include: { zone: true, telemetry: { orderBy: { createdAt: 'desc' }, take: 1 } }, orderBy: { createdAt: 'asc' } });
  return rows.map(toDevice);
}

export async function getPostgresDeviceDetail(deviceId: string) {
  if (!prisma) return null;
  const row = await prisma.device.findUnique({ where: { id: deviceId }, include: { zone: true, telemetry: { orderBy: { createdAt: 'desc' }, take: 80 } } });
  if (!row) return null;
  return { device: toDevice(row), history: row.telemetry.reverse().map(toPoint) };
}

export async function getPostgresDeviceCredential(deviceId: string) {
  if (!prisma) return null;
  return prisma.device.findUnique({ where: { id: deviceId }, select: { id: true, apiKeyHash: true, enabled: true, lastSeq: true, kind: true } });
}

export async function ingestPostgresTelemetry(input: {
  deviceId: string; seq: number; levelCm: number; rainfallMm?: number; sensorHealthy: boolean;
  deviceState?: FloodState; reportedBarrier?: BarrierState; emergencyStopActive?: boolean;
}) {
  if (!prisma) throw new Error('PostgreSQL is not configured.');
  return prisma.$transaction(async (tx: any) => {
    const device = await tx.device.findUnique({ where: { id: input.deviceId }, include: { telemetry: { orderBy: { createdAt: 'desc' }, take: 1 } } });
    if (!device || !device.enabled) throw new DatabaseRequestError(401, 'Device credentials are invalid.');
    if (input.seq <= device.lastSeq) throw new DatabaseRequestError(409, 'Sequence number was already received or is out of order.');

    const previousState = device.currentState;
    const emergencyStopActive = input.emergencyStopActive ?? false;
    const nextState = input.deviceState ?? (emergencyStopActive ? 'FAULT' : input.sensorHealthy ? floodStateForLevel(input.levelCm) : 'UNKNOWN');
    let barrier: BarrierState = input.sensorHealthy ? 'DOWN' : 'HOLD';
    let latched = input.reportedBarrier === 'DOWN' ? false : device.barrierLatched;
    if (emergencyStopActive) barrier = 'FAULT';
    else if (input.reportedBarrier) barrier = input.reportedBarrier;
    else if (nextState === 'WARNING' || nextState === 'CRITICAL') { barrier = 'RAISED'; latched = true; }
    else if (nextState === 'UNKNOWN') barrier = 'HOLD';
    else if (latched) barrier = 'RAISED';
    if (barrier === 'RAISED' || barrier === 'RAISING') latched = true;

    const point = await tx.telemetry.create({ data: {
      deviceId: input.deviceId, seq: input.seq, levelCm: input.levelCm,
      rainfallMm: input.rainfallMm, sensorHealthy: input.sensorHealthy,
      state: nextState, barrierState: barrier,
    } });
    await tx.device.update({ where: { id: input.deviceId }, data: {
      lastSeq: input.seq, lastSeenAt: point.createdAt, currentState: nextState,
      barrierState: barrier, barrierLatched: latched, emergencyStopActive,
    } });

    if (nextState !== previousState) {
      await tx.auditLog.create({ data: {
        tenantId: device.tenantId, action: 'TELEMETRY_STATE_CHANGE', targetType: 'device', targetId: device.id,
        metadata: { from: previousState, to: nextState, seq: input.seq, levelCm: input.levelCm },
      } });
      if (nextState === 'WARNING' || nextState === 'CRITICAL') {
        const recipients = await tx.subscription.findMany({
          where: { tenantId: device.tenantId, zoneId: device.zoneId, verifiedAt: { not: null }, unsubscribedAt: null },
        });
        const outboxRows: any[] = [];
        const eventCopy = eventTitle(nextState);
        for (const recipient of recipients) {
          const payload = { title: eventCopy[0], body: eventCopy[1], zoneId: device.zoneId, levelCm: input.levelCm, url: '/app' };
          if (recipient.email) outboxRows.push({
            dedupeKey: `${device.id}:${input.seq}:${nextState}:EMAIL:${recipient.id}`,
            tenantId: device.tenantId, zoneId: device.zoneId, channel: 'EMAIL', recipient: recipient.email,
            payload, status: 'PENDING',
          });
          if (recipient.phone) outboxRows.push({
            dedupeKey: `${device.id}:${input.seq}:${nextState}:SMS:${recipient.id}`,
            tenantId: device.tenantId, zoneId: device.zoneId, channel: 'SMS', recipient: recipient.phone,
            payload, status: 'PENDING',
          });
          if (recipient.pushEndpoint) outboxRows.push({
            dedupeKey: `${device.id}:${input.seq}:${nextState}:WEB_PUSH:${recipient.id}`,
            tenantId: device.tenantId, zoneId: device.zoneId, channel: 'WEB_PUSH', recipient: recipient.id,
            payload, status: 'PENDING',
          });
        }
        if (outboxRows.length) await tx.outboxEvent.createMany({ data: outboxRows, skipDuplicates: true });
      }
    }
    return { id: point.id, seq: point.seq, state: point.state, barrier: point.barrierState };
  });
}
