/**
 * FloodGuard flood engine — shared, pure state machine.
 *
 * States: NORMAL, WATCH, WARNING, CRITICAL, RECOVERY.
 * (UNKNOWN / FAULT are device-health states handled alongside this engine.)
 *
 * The engine supports:
 *  - absolute water-level thresholds (watch / warning / critical),
 *  - rate-of-rise thresholds (cm per minute) that escalate independently of level,
 *  - hysteresis bands so a reading hovering on a threshold cannot flap states,
 *  - a recovery state with cooldown before returning to NORMAL,
 *  - a cooldown between state re-entries,
 *  - duplicate-event prevention (same event key within a window is suppressed),
 *  - optional multi-sensor confirmation before escalating (N of M within a window).
 *
 * This module is intentionally pure (no I/O) so it can be unit-tested and shared
 * by the server and firmware design documents.
 */

export type FloodEngineState = 'NORMAL' | 'WATCH' | 'WARNING' | 'CRITICAL' | 'RECOVERY';
export type FloodHealthState = 'UNKNOWN' | 'FAULT';
export type FloodState = FloodEngineState | FloodHealthState;

export const ENGINE_STATES: FloodEngineState[] = ['NORMAL', 'WATCH', 'WARNING', 'CRITICAL', 'RECOVERY'];

export interface FloodEngineConfig {
  /** Level (cm) at or above which the state enters WATCH. */
  watchCm: number;
  /** Level (cm) at or above which the state enters WARNING. */
  warningCm: number;
  /** Level (cm) at or above which the state enters CRITICAL. */
  criticalCm: number;
  /** Level (cm) at or below which RECOVERY may complete into NORMAL. */
  recoveryCm: number;
  /** Hysteresis (cm): a level must fall this far below a threshold before de-escalating through it. */
  hysteresisCm: number;
  /** Rate of rise (cm/min) at or above which the state escalates to at least WARNING. */
  rateOfRiseWarningCmPerMin: number;
  /** Rate of rise (cm/min) at or above which the state escalates to CRITICAL. */
  rateOfRiseCriticalCmPerMin: number;
  /** Minimum seconds the engine must remain in RECOVERY below recoveryCm before returning to NORMAL. */
  recoveryCooldownSeconds: number;
  /** Minimum seconds between two re-entries into the same state (cooldown). */
  stateCooldownSeconds: number;
  /** Seconds within which a duplicate event key is suppressed. */
  duplicateEventWindowSeconds: number;
  /** Independent sensors that must agree before an escalation is accepted (1 disables the check). */
  multiSensorConfirmations: number;
  /** Seconds within which confirming sensor reports count toward multi-sensor confirmation. */
  multiSensorWindowSeconds: number;
}

export const DEFAULT_FLOOD_ENGINE_CONFIG: FloodEngineConfig = {
  watchCm: 20,
  warningCm: 35,
  criticalCm: 50,
  recoveryCm: 15,
  hysteresisCm: 3,
  rateOfRiseWarningCmPerMin: 2.5,
  rateOfRiseCriticalCmPerMin: 6,
  recoveryCooldownSeconds: 300,
  stateCooldownSeconds: 60,
  duplicateEventWindowSeconds: 900,
  multiSensorConfirmations: 1,
  multiSensorWindowSeconds: 120,
};

export interface FloodEngineContext {
  /** Current engine state. */
  state: FloodEngineState;
  /** Epoch ms of the last state transition. */
  lastTransitionAt: number;
  /** Epoch ms when RECOVERY was entered (0 if never). */
  recoveryEnteredAt: number;
  /** Epoch ms of the last accepted level sample (for rate-of-rise fallback). */
  lastSampleAt: number;
  /** Last accepted level in cm (for rate-of-rise fallback). */
  lastLevelCm: number | null;
  /** eventKey -> epoch ms of last emitted event (duplicate prevention). */
  recentEventKeys: Record<string, number>;
}

export interface FloodEngineInput {
  /** Calibrated water level in cm, or null when the sensor is unhealthy. */
  levelCm: number | null;
  /** Rate of rise in cm/min (positive = rising). May be computed from the previous sample. */
  rateOfRiseCmPerMin?: number | null;
  /** False when the level sensor reports a fault. */
  sensorHealthy: boolean;
  /** Number of independent sensors currently confirming this level band (including this one). */
  confirmingSensors?: number;
  /** Epoch ms of the sample. */
  now: number;
}

export interface FloodEngineEvent {
  /** Stable key used for duplicate-event prevention, e.g. "WARNING:35-40". */
  key: string;
  state: FloodEngineState;
  /** Human-readable reason for the transition. */
  reason: string;
  /** Severity used for notification fan-out. */
  severity: 'INFO' | 'WARNING' | 'CRITICAL' | 'RECOVERY';
  levelCm: number | null;
  rateOfRiseCmPerMin: number;
  at: number;
}

export interface FloodEngineResult {
  state: FloodEngineState;
  /** True when the state changed on this evaluation. */
  changed: boolean;
  /** Non-null when an event should be persisted / notified (null when suppressed as duplicate or cooldown). */
  event: FloodEngineEvent | null;
  /** Suggested barrier policy for the automation layer. Devices must also apply local fail-safe rules. */
  barrierPolicy: 'RAISE' | 'LOWER' | 'HOLD';
  /** Reason the barrier policy was chosen. */
  barrierReason: string;
}

export function emptyEngineContext(state: FloodEngineState = 'NORMAL', now = Date.now()): FloodEngineContext {
  return {
    state,
    lastTransitionAt: now,
    recoveryEnteredAt: 0,
    lastSampleAt: 0,
    lastLevelCm: null,
    recentEventKeys: {},
  };
}

export function normalizeFloodState(value: string | null | undefined, fallback: FloodState = 'UNKNOWN'): FloodState {
  if (value === 'SAFE') return 'NORMAL'; // legacy naming from early firmware
  const known: FloodState[] = ['NORMAL', 'WATCH', 'WARNING', 'CRITICAL', 'RECOVERY', 'UNKNOWN', 'FAULT'];
  return known.includes(value as FloodState) ? (value as FloodState) : fallback;
}

function bandForLevel(levelCm: number, config: FloodEngineConfig): FloodEngineState {
  if (levelCm >= config.criticalCm) return 'CRITICAL';
  if (levelCm >= config.warningCm) return 'WARNING';
  if (levelCm >= config.watchCm) return 'WATCH';
  return 'NORMAL';
}

function severityFor(state: FloodEngineState): FloodEngineEvent['severity'] {
  if (state === 'CRITICAL') return 'CRITICAL';
  if (state === 'WARNING' || state === 'WATCH') return 'WARNING';
  if (state === 'RECOVERY') return 'RECOVERY';
  return 'INFO';
}

function eventBand(levelCm: number | null): string {
  if (levelCm === null) return 'n/a';
  return `${Math.floor(levelCm / 5) * 5}-${Math.floor(levelCm / 5) * 5 + 4}`;
}

function stateRank(state: FloodEngineState): number {
  return { NORMAL: 0, RECOVERY: 1, WATCH: 2, WARNING: 3, CRITICAL: 4 }[state];
}

/**
 * Evaluate one sample against the flood engine.
 *
 * Escalations (to a higher-risk state) are applied immediately unless multi-sensor
 * confirmation is configured and not satisfied. De-escalations require the level to
 * fall `hysteresisCm` below each threshold. Leaving WATCH always passes through
 * RECOVERY, and RECOVERY only completes to NORMAL after `recoveryCooldownSeconds`
 * with the level at or below `recoveryCm`.
 */
export function evaluateFloodEngine(
  context: FloodEngineContext,
  input: FloodEngineInput,
  config: FloodEngineConfig = DEFAULT_FLOOD_ENGINE_CONFIG,
): FloodEngineResult {
  const confirmations = Math.max(1, input.confirmingSensors ?? 1);
  const rate = Number.isFinite(input.rateOfRiseCmPerMin ?? 0) ? Math.max(0, input.rateOfRiseCmPerMin ?? 0) : 0;

  // Device-health states never mutate the engine context; the caller stores them separately.
  if (!input.sensorHealthy || input.levelCm === null || !Number.isFinite(input.levelCm)) {
    return {
      state: context.state,
      changed: false,
      event: null,
      barrierPolicy: 'HOLD',
      barrierReason: 'Sensor reading unavailable; hold the last safe barrier position (local fail-safe).',
    };
  }
  const levelCm = input.levelCm;

  const current = context.state;
  let next: FloodEngineState = current;
  let reason = 'Level held steady inside the current band.';

  const escalateConfirmed = config.multiSensorConfirmations <= 1 || confirmations >= config.multiSensorConfirmations;

  // 1. Rate-of-rise escalation (independent of absolute level).
  let rateBand: FloodEngineState | null = null;
  if (rate >= config.rateOfRiseCriticalCmPerMin) rateBand = 'CRITICAL';
  else if (rate >= config.rateOfRiseWarningCmPerMin) rateBand = 'WARNING';

  // 2. Absolute level band.
  const levelBand = bandForLevel(levelCm, config);

  // 3. Choose the target band (whichever is more severe), applying hysteresis on the way down.
  const target = rateBand && stateRank(rateBand) > stateRank(levelBand) ? rateBand : levelBand;
  const rising = stateRank(target) > stateRank(current);
  const falling = stateRank(target) < stateRank(current);

  if (rising) {
    if (!escalateConfirmed) {
      reason = `Escalation to ${target} held pending ${config.multiSensorConfirmations}-sensor confirmation.`;
      next = current;
    } else {
      next = target;
      reason = rateBand && stateRank(rateBand) > stateRank(levelBand)
        ? `Rate of rise ${rate.toFixed(1)} cm/min reached the ${target} rate threshold.`
        : `Water level ${levelCm.toFixed(1)} cm reached the ${target} threshold.`;
    }
  } else if (falling) {
    // Hysteresis: the level must fall config.hysteresisCm below each boundary before
    // the engine steps down through it. RECOVERY is always entered when leaving WATCH.
    const deEscalated = passesHysteresis(current, levelCm, rate, config);
    if (deEscalated) {
      if (current === 'WATCH' || (stateRank(current) > stateRank('WATCH') && stateRank(target) <= stateRank('WATCH'))) {
        next = 'RECOVERY';
        reason = `Level ${levelCm.toFixed(1)} cm fell below the watch band with hysteresis; entering RECOVERY.`;
      } else if (current === 'RECOVERY') {
        // Completion to NORMAL requires the level at/below recoveryCm AND the cooldown elapsed.
        if (levelCm <= config.recoveryCm && input.now - context.recoveryEnteredAt >= config.recoveryCooldownSeconds * 1000) {
          next = 'NORMAL';
          reason = `Level ${levelCm.toFixed(1)} cm stayed below the recovery threshold for the cooldown; returning to NORMAL.`;
        } else {
          next = 'RECOVERY';
          reason = 'Still recovering; waiting for the recovery cooldown below the recovery threshold.';
        }
      } else {
        next = target === 'NORMAL' ? 'RECOVERY' : target;
        reason = `Level ${levelCm.toFixed(1)} cm de-escalated to ${next} after hysteresis.`;
      }
    } else {
      reason = 'Level is below the next band but has not cleared the hysteresis margin yet.';
    }
  } else if (current === 'RECOVERY') {
    if (levelCm <= config.recoveryCm && input.now - context.recoveryEnteredAt >= config.recoveryCooldownSeconds * 1000) {
      next = 'NORMAL';
      reason = `Level ${levelCm.toFixed(1)} cm stayed below the recovery threshold for the cooldown; returning to NORMAL.`;
    } else if (levelCm > config.recoveryCm) {
      reason = 'Recovering, but the level is still above the recovery threshold.';
    } else {
      reason = 'Recovering; recovery cooldown still in progress.';
    }
  } else {
    // Same band; inside NORMAL/WATCH/WARNING/CRITICAL nothing to do.
    if (current === 'NORMAL') reason = `Level ${levelCm.toFixed(1)} cm is below the watch threshold.`;
  }

  // 4. Cooldown: avoid flapping straight back into a state that was just left
  //    (escalations to WARNING/CRITICAL always bypass the cooldown for safety).
  const bypassCooldown = stateRank(next) >= stateRank('WARNING') || next === current;
  if (next !== current && !bypassCooldown && input.now - context.lastTransitionAt < config.stateCooldownSeconds * 1000) {
    reason = `State change to ${next} deferred by the ${config.stateCooldownSeconds}s cooldown.`;
    next = current;
  }

  const changed = next !== current;

  // 5. Duplicate-event prevention: only emit an event on a real transition, and
  //    suppress when the same key was emitted within the duplicate window.
  let event: FloodEngineEvent | null = null;
  if (changed) {
    const key = `${next}:${eventBand(levelCm)}`;
    const lastForKey = context.recentEventKeys[key] ?? 0;
    if (input.now - lastForKey < config.duplicateEventWindowSeconds * 1000) {
      event = null; // duplicate suppressed — the transition is still recorded by the caller
    } else {
      event = {
        key,
        state: next,
        reason,
        severity: severityFor(next),
        levelCm,
        rateOfRiseCmPerMin: rate,
        at: input.now,
      };
    }
  }

  // 6. Barrier policy. The physical controller must still fail safe locally.
  let barrierPolicy: FloodEngineResult['barrierPolicy'] = 'HOLD';
  let barrierReason = 'No barrier change recommended.';
  if (next === 'WARNING' || next === 'CRITICAL') {
    barrierPolicy = 'RAISE';
    barrierReason = 'Flood state is WARNING or CRITICAL; raise and latch the perimeter barrier.';
  } else if (next === 'RECOVERY') {
    barrierPolicy = 'HOLD';
    barrierReason = 'Recovery in progress; keep the barrier latched until NORMAL is confirmed.';
  } else if (next === 'NORMAL') {
    if (levelCm <= config.recoveryCm && input.now - context.recoveryEnteredAt >= config.recoveryCooldownSeconds * 1000) {
      barrierPolicy = 'LOWER';
      barrierReason = 'Level is below the recovery threshold and the recovery cooldown elapsed; safe to lower.';
    } else {
      barrierPolicy = 'HOLD';
      barrierReason = 'Hold the barrier until the recovery cooldown completes.';
    }
  } else if (next === 'WATCH') {
    barrierPolicy = 'HOLD';
    barrierReason = 'WATCH state; keep the barrier ready but down unless the local policy raises it.';
  }

  return { state: next, changed, event, barrierPolicy, barrierReason };
}

function passesHysteresis(
  current: FloodEngineState,
  levelCm: number,
  rate: number,
  config: FloodEngineConfig,
): boolean {
  // To step down out of a state, the level must be `hysteresisCm` below the
  // threshold that originally triggered it, and the rate must be below the
  // rate-of-rise thresholds (a still-rising water body must not de-escalate).
  if (rate >= config.rateOfRiseWarningCmPerMin) return false;
  switch (current) {
    case 'CRITICAL':
      return levelCm < config.criticalCm - config.hysteresisCm;
    case 'WARNING':
      return levelCm < config.warningCm - config.hysteresisCm;
    case 'WATCH':
      return levelCm < config.watchCm - config.hysteresisCm;
    case 'RECOVERY':
      return levelCm < config.recoveryCm - config.hysteresisCm || levelCm <= config.recoveryCm;
    default:
      return true;
  }
}

/**
 * Compute the rate of rise (cm/min) between two samples. Returns 0 when the
 * timestamps are unusable or the interval is longer than `maxGapMs` (stale data
 * must not drive rate-based escalation).
 */
export function rateOfRiseCmPerMin(
  previousLevelCm: number | null,
  previousAtMs: number,
  levelCm: number,
  atMs: number,
  maxGapMs = 15 * 60_000,
): number {
  if (previousLevelCm === null || !Number.isFinite(previousLevelCm)) return 0;
  const gapMs = atMs - previousAtMs;
  if (!Number.isFinite(gapMs) || gapMs <= 0 || gapMs > maxGapMs) return 0;
  return (levelCm - previousLevelCm) / (gapMs / 60_000);
}

/** Advance the engine context after a sample has been accepted. */
export function advanceEngineContext(
  context: FloodEngineContext,
  result: FloodEngineResult,
  input: FloodEngineInput,
  config: FloodEngineConfig = DEFAULT_FLOOD_ENGINE_CONFIG,
): FloodEngineContext {
  const next: FloodEngineContext = {
    state: result.state,
    lastTransitionAt: result.changed ? input.now : context.lastTransitionAt,
    recoveryEnteredAt: result.changed && result.state === 'RECOVERY'
      ? input.now
      : result.state === 'RECOVERY'
        ? (context.recoveryEnteredAt || input.now)
        : 0,
    lastSampleAt: input.now,
    lastLevelCm: input.levelCm,
    recentEventKeys: { ...context.recentEventKeys },
  };
  if (result.event) next.recentEventKeys[result.event.key] = input.now;
  // Prune stale duplicate-prevention keys.
  const cutoff = input.now - config.duplicateEventWindowSeconds * 1000 * 2;
  for (const [key, at] of Object.entries(next.recentEventKeys)) {
    if (at < cutoff) delete next.recentEventKeys[key];
  }
  return next;
}

/** Suggested default thresholds, documented in docs/API.md and editable by super admins. */
export const THRESHOLD_PRESETS = {
  classroomTray: DEFAULT_FLOOD_ENGINE_CONFIG,
  riverGauge: {
    ...DEFAULT_FLOOD_ENGINE_CONFIG,
    watchCm: 40,
    warningCm: 70,
    criticalCm: 100,
    recoveryCm: 30,
  },
} as const;
