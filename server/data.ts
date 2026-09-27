import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BarrierState, FloodState } from '../shared/flood-state.js';
import { buzzerForState, floodStateForLevel } from '../shared/flood-state.js';
import type { DashboardPayload, DeviceSummary, FloodEvent, TelemetryPoint } from '../shared/types.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultDataFile = path.resolve(moduleDirectory, '../data/preview-store.json');
const dataFile = process.env.DEMO_DATA_FILE || defaultDataFile;

export interface StoredDevice {
  id: string;
  name: string;
  kind: DeviceSummary['kind'];
  zone: string;
  firmwareVersion: string;
  apiKeyHash: string;
  enabled: boolean;
  lastSeenAt: string;
  lastSeq: number;
  latestLevelCm: number | null;
  state: FloodState;
  signal: number;
}

export interface PreviewStore {
  version: number;
  city: string;
  zone: string;
  levelCm: number;
  sensorHealthy: boolean;
  emergencyStopActive: boolean;
  barrier: BarrierState;
  barrierLatched: boolean;
  rainfallMm: number;
  devices: StoredDevice[];
  history: TelemetryPoint[];
  events: FloodEvent[];
  outbox: Array<Record<string, unknown>>;
  pushSubscriptions: Array<{ endpoint: string; p256dh: string; auth: string; zone: string; consentAt: string }>;
  emailSubscriptions: Array<{ email: string; tokenHash: string; unsubscribeTokenHash: string; zone: string; consentAt: string; verifiedAt: string | null; unsubscribedAt: string | null }>;
  maintenanceMode: boolean;
}

function pointId() {
  return crypto.randomUUID();
}

export function createFreshPreviewStore(): PreviewStore {
  const now = Date.now();
  const values = [9.5, 11.1, 13.8, 12.9, 16.4, 19.7, 21.2, 24.5, 26.8, 29.3, 31.8, 34.2];
  const history = values.map((levelCm, index) => ({
    id: `demo-${index + 1}`,
    deviceId: 'fg-esp32-01',
    seq: 4810 + index,
    levelCm,
    rainfallMm: Math.max(0, Math.round((index - 2) * 1.7)),
    state: floodStateForLevel(levelCm),
    sensorHealthy: true,
    createdAt: new Date(now - (values.length - index - 1) * 10 * 60_000).toISOString(),
  } satisfies TelemetryPoint));
  const lastSeenAt = new Date(now).toISOString();
  const defaultKeyHash = crypto.createHash('sha256').update(process.env.DEMO_DEVICE_API_KEY || 'demo-token-change-me').digest('hex');
  const secondKeyHash = crypto.createHash('sha256').update(process.env.DEMO_SENDER_API_KEY || 'demo-sender-change-me').digest('hex');

  return {
    version: 1,
    city: 'River Island City',
    zone: 'Ward 04 · North Bank',
    levelCm: values[values.length - 1],
    sensorHealthy: true,
    emergencyStopActive: false,
    barrier: 'DOWN',
    barrierLatched: false,
    rainfallMm: 24,
    devices: [
      {
        id: 'fg-esp32-01', name: 'Main control node', kind: 'ESP32 controller', zone: 'Ward 04 · North Bank',
        firmwareVersion: '0.1.0-demo', apiKeyHash: defaultKeyHash, enabled: true, lastSeenAt, lastSeq: 4821,
        latestLevelCm: values[values.length - 1], state: 'WATCH', signal: 93,
      },
      {
        id: 'fg-esp8266-01', name: 'North gauge sender', kind: 'ESP8266 sender', zone: 'Ward 04 · North Bank',
        firmwareVersion: '0.1.0-demo', apiKeyHash: secondKeyHash, enabled: true, lastSeenAt, lastSeq: 916,
        latestLevelCm: 29.6, state: 'WATCH', signal: 86,
      },
    ],
    history,
    events: [
      { id: 'event-1', title: 'Water level entered WATCH', message: 'Sample level crossed the 20 cm observation threshold.', state: 'WATCH', createdAt: new Date(now - 24 * 60_000).toISOString() },
      { id: 'event-2', title: 'North gauge sender reported in', message: 'ESP8266 sender · sequence 916 received.', state: 'INFO', createdAt: new Date(now - 8 * 60_000).toISOString() },
      { id: 'event-3', title: 'Demo system ready', message: 'Local simulation is active. No physical hardware is connected.', state: 'INFO', createdAt: new Date(now - 3 * 60_000).toISOString() },
    ],
    outbox: [],
    pushSubscriptions: [],
    emailSubscriptions: [],
    maintenanceMode: false,
  };
}

function ensureStoreFile() {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  if (!fs.existsSync(dataFile)) writeStore(createFreshPreviewStore());
}

export function readStore(): PreviewStore {
  ensureStoreFile();
  const value = JSON.parse(fs.readFileSync(dataFile, 'utf8')) as PreviewStore;
  if (!value || value.version !== 1 || !Array.isArray(value.history) || !Array.isArray(value.devices)) {
    throw new Error('The local preview store is invalid. Remove it and restart to reseed demo data.');
  }
  return value;
}

export function writeStore(store: PreviewStore) {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  const temporary = `${dataFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, dataFile);
}

export function currentPreviewState(store: PreviewStore): FloodState {
  if (store.emergencyStopActive) return 'FAULT';
  if (!store.sensorHealthy) return 'UNKNOWN';
  return store.history.at(-1)?.state || floodStateForLevel(store.levelCm);
}

export function getPreviewDashboard(store: PreviewStore, mode: DashboardPayload['mode'] = 'simulation'): DashboardPayload {
  const state = currentPreviewState(store);
  const history = store.history.slice(-36);
  const current = history.at(-1);
  const previous = history.at(-4) || history.at(-2);
  const trendCm = current && previous ? Math.round((current.levelCm - previous.levelCm) * 10) / 10 : 0;
  const devices: DeviceSummary[] = store.devices.map((device) => ({
    id: device.id,
    name: device.name,
    kind: device.kind,
    zone: device.zone,
    firmwareVersion: device.firmwareVersion,
    online: device.enabled,
    lastSeenAt: device.lastSeenAt,
    signal: device.signal,
    latestLevelCm: device.latestLevelCm,
    state: device.id === 'fg-esp32-01' ? state : device.state,
  }));
  const alertCount = ['WATCH', 'WARNING', 'CRITICAL'].includes(state) ? 1 : state === 'FAULT' ? 1 : 0;

  return {
    mode,
    project: 'FloodGuard — Smart Flood Control & Automation',
    city: store.city,
    zone: store.zone,
    updatedAt: new Date().toISOString(),
    system: {
      levelCm: store.sensorHealthy ? store.levelCm : null,
      state,
      barrier: store.emergencyStopActive ? 'FAULT' : store.barrier,
      buzzer: buzzerForState(state),
      sensorHealthy: store.sensorHealthy,
      emergencyStopActive: store.emergencyStopActive,
      barrierLatched: store.barrierLatched,
      trendCm,
      rainfallMm: store.rainfallMm,
      seq: store.devices[0]?.lastSeq ?? 0,
    },
    stats: {
      activeDevices: devices.filter((device) => device.online).length,
      zones: 1,
      alerts: alertCount,
      samplesToday: store.history.filter((point) => point.createdAt.slice(0, 10) === new Date().toISOString().slice(0, 10)).length,
    },
    devices,
    history,
    events: store.events.slice(0, 8),
    maintenanceMode: store.maintenanceMode,
  };
}

export function makeTelemetryPoint(input: Omit<TelemetryPoint, 'id' | 'createdAt'> & { createdAt?: string }): TelemetryPoint {
  return {
    id: pointId(),
    ...input,
    createdAt: input.createdAt || new Date().toISOString(),
  };
}
