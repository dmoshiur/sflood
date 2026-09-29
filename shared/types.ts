import type { BarrierState, FloodState } from './flood-state.js';

export interface TelemetryPoint {
  id: string;
  deviceId: string;
  seq: number;
  levelCm: number;
  rainfallMm: number | null;
  state: FloodState;
  sensorHealthy: boolean;
  createdAt: string;
}

export interface DeviceSummary {
  id: string;
  name: string;
  kind: 'ESP32 controller' | 'ESP8266 sender';
  zone: string;
  firmwareVersion: string;
  online: boolean;
  lastSeenAt: string;
  signal: number;
  latestLevelCm: number | null;
  state: FloodState;
  approvalState?: string;
  limitSwitchState?: string | null;
  faultState?: string | null;
}

export interface FloodEvent {
  id: string;
  title: string;
  message: string;
  state: FloodState | 'INFO';
  createdAt: string;
}

export interface DashboardPayload {
  mode: 'simulation' | 'turso';
  project: string;
  city: string;
  zone: string;
  updatedAt: string;
  system: {
    levelCm: number | null;
    state: FloodState;
    barrier: BarrierState;
    buzzer: boolean;
    sensorHealthy: boolean;
    emergencyStopActive: boolean;
    barrierLatched: boolean;
    trendCm: number;
    rainfallMm: number | null;
    seq: number;
    rateOfRiseCmPerMin?: number;
  };
  stats: {
    activeDevices: number;
    zones: number;
    alerts: number;
    samplesToday: number;
  };
  devices: DeviceSummary[];
  history: TelemetryPoint[];
  events: FloodEvent[];
  maintenanceMode: boolean;
}
