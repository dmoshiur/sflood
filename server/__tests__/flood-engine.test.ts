import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_POLICY, evaluateFlood, candidateForLevel,
  type FloodEvaluationInput, type FloodPolicy,
} from '../../shared/flood-engine.js';

/**
 * Flood engine unit tests: thresholds, rate of rise, hysteresis, recovery,
 * cooldown, duplicate prevention and multi-sensor confirmation.
 */

const policy: FloodPolicy = {
  ...DEFAULT_POLICY,
  normalBelowCm: 18, watchCm: 25, warningCm: 40, criticalCm: 55,
  rateOfRiseCmPerMin: 6, hysteresisCm: 4, recoveryCm: 20, recoveryHoldSeconds: 300,
  cooldownSeconds: 120, confirmationSamples: 1,
};

const base: FloodEvaluationInput = {
  levelCm: 10, rateCmPerMin: 0, sensorHealthy: true, emergencyStopActive: false, policy,
  previousState: 'NORMAL', previousLevelCm: 10, lastTransitionAt: null, recoveryStartedAt: null,
  now: new Date('2026-01-01T00:00:00.000Z'), consecutiveElevatedSamples: 0, confirmingDevices: 0,
};

function evaluate(patch: Partial<FloodEvaluationInput>) {
  return evaluateFlood({ ...base, ...patch });
}

describe('candidate thresholds', () => {
  it('maps absolute levels to states', () => {
    assert.equal(candidateForLevel(10, policy, 0, false).state, 'NORMAL');
    assert.equal(candidateForLevel(25, policy, 0, false).state, 'WATCH');
    assert.equal(candidateForLevel(40, policy, 0, false).state, 'WARNING');
    assert.equal(candidateForLevel(55, policy, 0, false).state, 'CRITICAL');
    assert.equal(candidateForLevel(24.9, policy, 0, false).state, 'NORMAL');
  });

  it('escalates to WATCH on rate of rise alone', () => {
    const candidate = candidateForLevel(12, policy, 9, true);
    assert.equal(candidate.state, 'WATCH');
    assert.equal(candidate.rateTriggered, true);
  });

  it('does not escalate on rate when the level is falling', () => {
    assert.equal(candidateForLevel(12, policy, 9, false).state, 'NORMAL');
  });
});

describe('state transitions', () => {
  it('escalates NORMAL -> WATCH -> WARNING -> CRITICAL', () => {
    assert.equal(evaluate({ levelCm: 26, previousLevelCm: 10 }).state, 'WATCH');
    assert.equal(evaluate({ levelCm: 41, previousLevelCm: 26, previousState: 'WATCH' }).state, 'WARNING');
    assert.equal(evaluate({ levelCm: 60, previousLevelCm: 41, previousState: 'WARNING' }).state, 'CRITICAL');
  });

  it('reports a change only when the state actually changes', () => {
    const first = evaluate({ levelCm: 26 });
    assert.equal(first.changed, true);
    const second = evaluate({ levelCm: 30, previousState: 'WATCH', previousLevelCm: 26 });
    assert.equal(second.changed, false);
    assert.equal(second.state, 'WATCH');
  });

  it('commands the barrier only for the configured auto-barrier states', () => {
    assert.equal(evaluate({ levelCm: 30 }).shouldCommandBarrier, false);
    assert.equal(evaluate({ levelCm: 45, previousState: 'WATCH' }).shouldCommandBarrier, true);
    assert.equal(evaluate({ levelCm: 45, previousState: 'WATCH' }).barrierAction, 'RAISE');
    // 20.5 cm is below the WATCH hysteresis exit (21 cm) but above the recovery
    // threshold (20 cm), so the state clears to NORMAL and the barrier lowers.
    assert.equal(evaluate({ levelCm: 20.5, previousState: 'WATCH', previousLevelCm: 24 }).barrierAction, 'LOWER');
  });
});

describe('hysteresis', () => {
  it('holds WARNING until the level clears the exit margin', () => {
    const held = evaluate({ levelCm: 37, previousState: 'WARNING', previousLevelCm: 45 });
    assert.equal(held.state, 'WARNING');
    assert.match(held.reason, /hysteresis/);
  });

  it('allows de-escalation once the margin is cleared', () => {
    const released = evaluate({ levelCm: 35, previousState: 'WARNING', previousLevelCm: 45 });
    assert.equal(released.state, 'WATCH');
  });
});

describe('recovery', () => {
  it('latches RECOVERY after an elevated state drops below the recovery threshold', () => {
    const result = evaluate({ levelCm: 15, previousState: 'CRITICAL', previousLevelCm: 60 });
    assert.equal(result.state, 'RECOVERY');
    assert.equal(result.isRecoveryTransition, true);
  });

  it('stays in RECOVERY until the hold time elapses', () => {
    const held = evaluateFlood({
      ...base, levelCm: 12, previousState: 'RECOVERY', previousLevelCm: 15,
      recoveryStartedAt: '2026-01-01T00:00:00.000Z', now: new Date('2026-01-01T00:02:00.000Z'),
    });
    assert.equal(held.state, 'RECOVERY');
    const done = evaluateFlood({
      ...base, levelCm: 12, previousState: 'RECOVERY', previousLevelCm: 15,
      recoveryStartedAt: '2026-01-01T00:00:00.000Z', now: new Date('2026-01-01T00:06:00.000Z'),
    });
    assert.equal(done.state, 'NORMAL');
  });

  it('returns to the elevated state if the level rises during recovery', () => {
    const result = evaluateFlood({
      ...base, levelCm: 45, previousState: 'RECOVERY', previousLevelCm: 15,
      recoveryStartedAt: '2026-01-01T00:00:00.000Z', now: new Date('2026-01-01T00:01:00.000Z'),
    });
    assert.equal(result.state, 'WARNING');
  });
});

describe('cooldown and duplicate prevention', () => {
  it('suppresses a transition inside the cooldown window', () => {
    const result = evaluateFlood({
      ...base, levelCm: 60, previousLevelCm: 10,
      lastTransitionAt: '2026-01-01T00:00:30.000Z', now: new Date('2026-01-01T00:01:00.000Z'),
    });
    assert.equal(result.state, 'NORMAL');
    assert.equal(result.suppressedByCooldown, true);
    assert.equal(result.changed, false);
  });

  it('allows the transition once the cooldown has elapsed', () => {
    const result = evaluateFlood({
      ...base, levelCm: 60, previousLevelCm: 10,
      lastTransitionAt: '2026-01-01T00:00:00.000Z', now: new Date('2026-01-01T00:05:00.000Z'),
    });
    assert.equal(result.state, 'CRITICAL');
    assert.equal(result.changed, true);
  });

  it('never emits an event when the state is unchanged', () => {
    const result = evaluate({ levelCm: 30, previousState: 'WATCH', previousLevelCm: 30 });
    assert.equal(result.changed, false);
    assert.equal(result.shouldNotify, false);
  });
});

describe('faults', () => {
  it('holds the previous state and barrier on a sensor fault', () => {
    const result = evaluate({ sensorHealthy: false, levelCm: 60, previousState: 'CRITICAL', previousLevelCm: 50 });
    assert.equal(result.state, 'CRITICAL');
    assert.equal(result.fault, 'SENSOR_FAULT');
    assert.equal(result.barrierAction, 'HOLD');
  });

  it('inhibits actuation on an active emergency stop', () => {
    const result = evaluate({ emergencyStopActive: true, levelCm: 60, previousState: 'WARNING' });
    assert.equal(result.fault, 'EMERGENCY_STOP');
    assert.equal(result.barrierAction, 'HOLD');
  });
});

describe('multi-sensor confirmation', () => {
  const strict: FloodPolicy = { ...policy, confirmationSamples: 2 };

  it('waits for the configured number of confirming samples', () => {
    const first = evaluateFlood({ ...base, levelCm: 60, previousLevelCm: 10, policy: strict });
    assert.equal(first.state, 'NORMAL');
    assert.equal(first.suppressedByConfirmation, true);

    const second = evaluateFlood({ ...base, levelCm: 60, previousLevelCm: 55, policy: strict, consecutiveElevatedSamples: 1 });
    assert.equal(second.state, 'CRITICAL');
    assert.equal(second.changed, true);
  });

  it('accepts confirmation from a second device in the same zone', () => {
    const result = evaluateFlood({ ...base, levelCm: 60, previousLevelCm: 10, policy: strict, confirmingDevices: 2 });
    assert.equal(result.state, 'CRITICAL');
  });
});

describe('policy guards', () => {
  it('repairs inverted thresholds instead of trusting them', () => {
    const broken: FloodPolicy = { ...policy, watchCm: 5, warningCm: 3, criticalCm: 1 };
    // Normalised: normal 18 < watch 19 < warning 20 < critical 21.
    const low = evaluateFlood({ ...base, levelCm: 18.5, policy: broken });
    const high = evaluateFlood({ ...base, levelCm: 30, policy: broken });
    assert.equal(low.state, 'NORMAL');
    assert.equal(high.state, 'CRITICAL');
    const mid = evaluateFlood({ ...base, levelCm: 19.5, policy: broken });
    assert.equal(mid.state, 'WATCH');
  });

  it('keeps the recovery threshold below the watch threshold', () => {
    const broken: FloodPolicy = { ...policy, recoveryCm: 90 };
    const result = evaluateFlood({ ...base, levelCm: 10, previousState: 'CRITICAL', previousLevelCm: 60, policy: broken });
    assert.equal(result.state, 'RECOVERY');
  });
});

describe('legacy state normalisation', () => {
  it('maps old demo bands onto the engine states', async () => {
    const { normalizeState } = await import('../telemetry.js');
    assert.equal(normalizeState('SAFE'), 'NORMAL');
    assert.equal(normalizeState('UNKNOWN'), 'NORMAL');
    assert.equal(normalizeState('FAULT'), 'NORMAL');
    assert.equal(normalizeState('WARNING'), 'WARNING');
    assert.equal(normalizeState(''), 'NORMAL');
    assert.equal(normalizeState('nonsense'), 'NORMAL');
  });
});
