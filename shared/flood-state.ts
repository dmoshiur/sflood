export type FloodState = 'SAFE' | 'WATCH' | 'WARNING' | 'CRITICAL' | 'UNKNOWN' | 'FAULT';
export type BarrierState = 'DOWN' | 'RAISING' | 'RAISED' | 'FAULT' | 'HOLD';

export interface Inputs {
  levelCm: number | null;
  sensorHealthy: boolean;
  emergencyStopActive: boolean;
}

/** The four educational demo thresholds defined in the FloodGuard project brief. */
export function floodStateForLevel(levelCm: number | null, sensorHealthy = true): FloodState {
  if (!sensorHealthy || levelCm === null || !Number.isFinite(levelCm) || levelCm < 0) return 'UNKNOWN';
  if (levelCm >= 50) return 'CRITICAL';
  if (levelCm >= 35) return 'WARNING';
  if (levelCm >= 20) return 'WATCH';
  return 'SAFE';
}

export function buzzerForState(state: FloodState): boolean {
  return state === 'WATCH' || state === 'WARNING' || state === 'CRITICAL';
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
  safeMaximumExclusive: 20,
  watchMinimumInclusive: 20,
  warningMinimumInclusive: 35,
  criticalMinimumInclusive: 50,
} as const;
