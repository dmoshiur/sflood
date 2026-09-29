/**
 * FloodGrid flood decision engine.
 *
 * Pure, dependency-free and deterministic so it can be unit tested without a
 * database, a device or a clock. The server feeds it calibrated telemetry and
 * policy; the engine returns the state that must be persisted, whether an event
 * must be written, whether the barrier must be commanded and whether
 * notifications must fan out.
 *
 * State machine: NORMAL -> WATCH -> WARNING -> CRITICAL, plus RECOVERY which
 * latches after a critical episode until the level stays below the recovery
 * threshold for the configured hold time.
 */

export const FLOOD_STATES = ['NORMAL', 'WATCH', 'WARNING', 'CRITICAL', 'RECOVERY'] as const;
export type FloodStateName = (typeof FLOOD_STATES)[number];

export const FAULT_CONDITIONS = ['SENSOR_FAULT', 'EMERGENCY_STOP', 'DEVICE_OFFLINE'] as const;
export type FaultCondition = (typeof FAULT_CONDITIONS)[number];

export interface FloodPolicy {
  normalBelowCm: number;
  watchCm: number;
  warningCm: number;
  criticalCm: number;
  rateOfRiseCmPerMin: number;
  hysteresisCm: number;
  recoveryCm: number;
  recoveryHoldSeconds: number;
  cooldownSeconds: number;
  confirmationSamples: number;
  confirmationWindowSeconds: number;
  autoBarrierStates: FloodStateName[];
  barrierRecoveryState: FloodStateName;
}

export interface FloodEvaluationInput {
  levelCm: number;
  rateCmPerMin: number;
  sensorHealthy: boolean;
  emergencyStopActive: boolean;
  policy: FloodPolicy;
  previousState: FloodStateName;
  previousLevelCm: number | null;
  lastTransitionAt: string | null;
  recoveryStartedAt: string | null;
  now: Date;
  consecutiveElevatedSamples: number;
  confirmingDevices: number;
}

export interface FloodEvaluation {
  state: FloodStateName;
  previousState: FloodStateName;
  changed: boolean;
  fault: FaultCondition | null;
  candidateState: FloodStateName;
  reason: string;
  severity: number;
  shouldCommandBarrier: boolean;
  barrierAction: 'RAISE' | 'LOWER' | 'HOLD';
  shouldNotify: boolean;
  isRecoveryTransition: boolean;
  suppressedByCooldown: boolean;
  suppressedByConfirmation: boolean;
  rateTriggered: boolean;
}

export const DEFAULT_POLICY: FloodPolicy = {
  normalBelowCm: 18,
  watchCm: 25,
  warningCm: 40,
  criticalCm: 55,
  rateOfRiseCmPerMin: 6,
  hysteresisCm: 4,
  recoveryCm: 20,
  recoveryHoldSeconds: 300,
  cooldownSeconds: 120,
  confirmationSamples: 1,
  confirmationWindowSeconds: 180,
  autoBarrierStates: ['WARNING', 'CRITICAL'],
  barrierRecoveryState: 'RECOVERY',
};

export const SEVERITY: Record<FloodStateName, number> = {
  NORMAL: 0,
  RECOVERY: 1,
  WATCH: 2,
  WARNING: 3,
  CRITICAL: 4,
};

export const STATE_LABELS: Record<FloodStateName, string> = {
  NORMAL: 'Normal',
  WATCH: 'Watch',
  WARNING: 'Warning',
  CRITICAL: 'Critical',
  RECOVERY: 'Recovery',
};

export const STATE_GUIDANCE: Record<FloodStateName, string> = {
  NORMAL: 'Water level is below the calibrated watch threshold. Monitoring continues automatically.',
  WATCH: 'Water level is above the watch threshold or rising quickly. Prepare and stay alert.',
  WARNING: 'Water level is above the warning threshold. The perimeter barrier is commanded up where policy allows.',
  CRITICAL: 'Water level is above the critical threshold. The barrier stays latched up and all alert channels are notified.',
  RECOVERY: 'The level has fallen below the recovery threshold. The barrier stays latched until the hold time elapses.',
};

export function thresholdForState(policy: FloodPolicy, state: FloodStateName): number {
  if (state === 'WATCH') return policy.watchCm;
  if (state === 'WARNING') return policy.warningCm;
  if (state === 'CRITICAL') return policy.criticalCm;
  return policy.normalBelowCm;
}

export function isFloodState(value: unknown): value is FloodStateName {
  return typeof value === 'string' && (FLOOD_STATES as readonly string[]).includes(value);
}

function normalizePolicy(policy: Partial<FloodPolicy> | undefined): FloodPolicy {
  const merged = { ...DEFAULT_POLICY, ...(policy || {}) };
  // Guard against inverted thresholds from manual configuration.
  if (!(merged.normalBelowCm < merged.watchCm)) merged.watchCm = merged.normalBelowCm + 1;
  if (!(merged.watchCm < merged.warningCm)) merged.warningCm = merged.watchCm + 1;
  if (!(merged.warningCm < merged.criticalCm)) merged.criticalCm = merged.warningCm + 1;
  if (merged.hysteresisCm < 0) merged.hysteresisCm = 0;
  if (merged.recoveryCm >= merged.watchCm) merged.recoveryCm = Math.max(0, merged.watchCm - 1);
  if (merged.confirmationSamples < 1) merged.confirmationSamples = 1;
  if (!merged.autoBarrierStates?.length) merged.autoBarrierStates = ['WARNING', 'CRITICAL'];
  return merged;
}

/** Threshold band that a raw level maps to, ignoring hysteresis and cooldown. */
export function candidateForLevel(levelCm: number, policy: FloodPolicy, rateCmPerMin: number, rising: boolean): { state: FloodStateName; rateTriggered: boolean } {
  if (levelCm >= policy.criticalCm) return { state: 'CRITICAL', rateTriggered: false };
  if (levelCm >= policy.warningCm) return { state: 'WARNING', rateTriggered: false };
  if (levelCm >= policy.watchCm) return { state: 'WATCH', rateTriggered: false };
  if (rising && rateCmPerMin >= policy.rateOfRiseCmPerMin) return { state: 'WATCH', rateTriggered: true };
  return { state: 'NORMAL', rateTriggered: false };
}

function secondsSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  return (now.getTime() - then) / 1000;
}

/**
 * Evaluate the next flood state for a single zone.
 *
 * Ordering matters and is intentional:
 *  1. faults latch the previous state (never auto-clear a barrier on bad data)
 *  2. multi-sensor confirmation can delay escalation
 *  3. hysteresis prevents flapping on the way down
 *  4. recovery latches until the hold time elapses
 *  5. cooldown suppresses duplicate transitions inside the window
 */
export function evaluateFlood(input: FloodEvaluationInput): FloodEvaluation {
  const policy = normalizePolicy(input.policy);
  const now = input.now;
  const previous = input.previousState;
  const rising = input.previousLevelCm === null ? false : input.levelCm > input.previousLevelCm;
  const candidate = candidateForLevel(input.levelCm, policy, input.rateCmPerMin, rising);
  const base = {
    previousState: previous,
    candidateState: candidate.state,
    rateTriggered: candidate.rateTriggered,
    severity: SEVERITY[previous],
  };

  if (!input.sensorHealthy) {
    return {
      ...base, state: previous, changed: false, fault: 'SENSOR_FAULT',
      reason: 'Sensor is reporting unhealthy data. Holding the previous state and barrier position.',
      shouldCommandBarrier: false, barrierAction: 'HOLD', shouldNotify: false,
      isRecoveryTransition: false, suppressedByCooldown: false, suppressedByConfirmation: false, severity: SEVERITY[previous],
    };
  }
  if (input.emergencyStopActive) {
    return {
      ...base, state: previous, changed: false, fault: 'EMERGENCY_STOP',
      reason: 'Emergency stop is latched on the controller. Actuation is inhibited.',
      shouldCommandBarrier: false, barrierAction: 'HOLD', shouldNotify: false,
      isRecoveryTransition: false, suppressedByCooldown: false, suppressedByConfirmation: false, severity: SEVERITY[previous],
    };
  }

  const elapsed = secondsSince(input.lastTransitionAt, now);
  const cooldownActive = elapsed !== null && elapsed < policy.cooldownSeconds;

  let state = candidate.state;
  let reason = `Level ${input.levelCm.toFixed(1)} cm`;
  let suppressedByConfirmation = false;

  // Multi-sensor / multi-sample confirmation for escalation. The current
  // sample counts as one confirmation, and each other device in the zone that
  // is also above the threshold counts as another.
  if (SEVERITY[candidate.state] > SEVERITY[previous] && policy.confirmationSamples > 1) {
    const evidence = input.consecutiveElevatedSamples + 1 + input.confirmingDevices;
    if (evidence < policy.confirmationSamples) {
      state = previous;
      suppressedByConfirmation = true;
      reason = `Escalation to ${candidate.state} is waiting for ${policy.confirmationSamples} confirming samples inside ${policy.confirmationWindowSeconds}s (have ${evidence}).`;
    }
  }

  // Hysteresis: only allow de-escalation once the level clears the margin.
  if (!suppressedByConfirmation && SEVERITY[candidate.state] < SEVERITY[previous] && previous !== 'RECOVERY') {
    const exitThreshold = thresholdForState(policy, previous) - policy.hysteresisCm;
    if (input.levelCm > exitThreshold) {
      state = previous;
      reason = `Holding ${previous}: level ${input.levelCm.toFixed(1)} cm has not fallen below the ${exitThreshold.toFixed(1)} cm hysteresis exit threshold.`;
    }
  }

  // Recovery latching.
  let isRecoveryTransition = false;
  if (previous === 'RECOVERY') {
    const held = secondsSince(input.recoveryStartedAt, now);
    if (input.levelCm > policy.recoveryCm) {
      state = candidate.state;
      reason = `Level rose back to ${input.levelCm.toFixed(1)} cm during recovery.`;
    } else if (held !== null && held >= policy.recoveryHoldSeconds) {
      state = 'NORMAL';
      reason = `Level stayed below ${policy.recoveryCm} cm for ${Math.round(policy.recoveryHoldSeconds)}s. Recovery complete.`;
      isRecoveryTransition = true;
    } else {
      state = 'RECOVERY';
      reason = `Recovery hold in progress. Barrier stays latched until ${Math.round(policy.recoveryHoldSeconds)}s below ${policy.recoveryCm} cm.`;
    }
  } else if (!suppressedByConfirmation && previous !== 'NORMAL' && SEVERITY[candidate.state] < SEVERITY[previous] && input.levelCm <= policy.recoveryCm) {
    state = policy.barrierRecoveryState === 'RECOVERY' ? 'RECOVERY' : 'NORMAL';
    isRecoveryTransition = state === 'RECOVERY';
    reason = `Level fell to ${input.levelCm.toFixed(1)} cm, below the ${policy.recoveryCm} cm recovery threshold.`;
  }

  const changed = state !== previous;
  const suppressedByCooldown = changed && cooldownActive;

  if (suppressedByCooldown) {
    return {
      ...base,
      state: previous,
      changed: false,
      fault: null,
      reason: `Transition to ${state} suppressed by the ${policy.cooldownSeconds}s cooldown window (${Math.round(elapsed as number)}s since the last transition).`,
      shouldCommandBarrier: false,
      barrierAction: 'HOLD',
      shouldNotify: false,
      isRecoveryTransition: false,
      suppressedByCooldown: true,
      suppressedByConfirmation,
      severity: SEVERITY[previous],
    };
  }

  const barrierAction: 'RAISE' | 'LOWER' | 'HOLD' = policy.autoBarrierStates.includes(state)
    ? 'RAISE'
    : state === 'NORMAL' ? 'LOWER' : 'HOLD';

  return {
    ...base,
    state,
    changed,
    fault: null,
    reason,
    severity: SEVERITY[state],
    shouldCommandBarrier: policy.autoBarrierStates.includes(state),
    barrierAction,
    shouldNotify: changed,
    isRecoveryTransition,
    suppressedByCooldown: false,
    suppressedByConfirmation,
  };
}

export function describeTransition(from: FloodStateName, to: FloodStateName): string {
  if (from === to) return `State held at ${STATE_LABELS[to]}.`;
  return `State changed from ${STATE_LABELS[from]} to ${STATE_LABELS[to]}.`;
}
