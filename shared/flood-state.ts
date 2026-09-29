import type { FloodState } from './flood-engine.js';

export type { FloodState } from './flood-engine.js';
export { normalizeFloodState } from './flood-engine.js';

export type BarrierState = 'DOWN' | 'RAISING' | 'RAISED' | 'FAULT' | 'HOLD';

export interface Inputs {
  levelCm: number | null;
  sensorHealthy: boolean;
  emergencyStopActive: boolean;
}

/**
 * Educational level bands for the tray prototype. The full engine with
 * hysteresis, rate-of-rise and recovery lives in ./flood-engine.js — this helper
 * is the simple absolute-threshold mapping used by firmware and the simulator.
 */
export function floodStateForLevel(levelCm: number | null, sensorHealthy = true): FloodState {
  if (!sensorHealthy || levelCm === null || !Number.isFinite(levelCm) || levelCm < 0) return 'UNKNOWN';
  if (levelCm >= 50) return 'CRITICAL';
  if (levelCm >= 35) return 'WARNING';
  if (levelCm >= 20) return 'WATCH';
  return 'NORMAL';
}

export function buzzerForState(state: FloodState): boolean {
  return state === 'WATCH' || state === 'WARNING' || state === 'CRITICAL' || state === 'RECOVERY';
}

export function barrierForInputs(
  inputs: Inputs,
  previous: BarrierState = 'DOWN',
  latched = false,
): BarrierState {
  if (inputs.emergencyStopActive) return 'FAULT';
  const state = floodStateForLevel(inputs.levelCm, inputs.sensorHealthy);
  if (state === 'UNKNOWN' || state === 'FAULT') return 'HOLD';
  if (state === 'WARNING' || state === 'CRITICAL') return 'RAISED';
  if ((previous === 'RAISED' || previous === 'HOLD') && latched) return 'RAISED';
  return 'DOWN';
}

export const THRESHOLDS_CM = {
  normalMaximumExclusive: 20,
  watchMinimumInclusive: 20,
  warningMinimumInclusive: 35,
  criticalMinimumInclusive: 50,
  recoveryCompleteMaximumInclusive: 15,
} as const;
