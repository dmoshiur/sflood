import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_FLOOD_ENGINE_CONFIG,
  advanceEngineContext,
  emptyEngineContext,
  evaluateFloodEngine,
  normalizeFloodState,
  rateOfRiseCmPerMin,
  type FloodEngineContext,
} from '../../shared/flood-engine.js';

const config = { ...DEFAULT_FLOOD_ENGINE_CONFIG, recoveryCooldownSeconds: 300, stateCooldownSeconds: 0 };
const now = 1_700_000_000_000;

function step(context: FloodEngineContext, levelCm: number | null, rate = 0, at = now, confirmations = 1) {
  const input = { levelCm, rateOfRiseCmPerMin: rate, sensorHealthy: levelCm !== null, confirmingSensors: confirmations, now: at };
  const result = evaluateFloodEngine(context, input, config);
  return { result, next: advanceEngineContext(context, result, input, config) };
}

test('flood engine walks NORMAL → WATCH → WARNING → CRITICAL with absolute thresholds', () => {
  let context = emptyEngineContext('NORMAL', now - 60_000);
  let outcome = step(context, 10);
  assert.equal(outcome.result.state, 'NORMAL');

  outcome = step(context, 21);
  context = outcome.next;
  assert.equal(outcome.result.state, 'WATCH');
  assert.equal(outcome.result.event?.severity, 'WARNING');

  outcome = step(context, 36);
  context = outcome.next;
  assert.equal(outcome.result.state, 'WARNING');
  assert.equal(outcome.result.barrierPolicy, 'RAISE');

  outcome = step(context, 52);
  assert.equal(outcome.result.state, 'CRITICAL');
  assert.equal(outcome.result.event?.severity, 'CRITICAL');
  assert.equal(outcome.result.barrierPolicy, 'RAISE');
});

test('rate of rise escalates independently of the absolute level', () => {
  const context = emptyEngineContext('WATCH', now - 60_000);
  const outcome = step(context, 22, 7);
  assert.equal(outcome.result.state, 'CRITICAL');
  assert.match(outcome.result.event?.reason ?? '', /Rate of rise/);

  const warnRate = step(emptyEngineContext('NORMAL', now - 60_000), 5, 3);
  assert.equal(warnRate.result.state, 'WARNING');
});

test('hysteresis prevents flapping around a threshold', () => {
  // Enter WARNING at 36 cm.
  let context = emptyEngineContext('WARNING', now - 60_000);
  // 34.5 is below 35 but within the 3 cm hysteresis margin — must stay WARNING.
  let outcome = step(context, 34.5);
  assert.equal(outcome.result.state, 'WARNING');
  // 31 is below warningCm - hysteresis — de-escalates through RECOVERY.
  outcome = step(context, 31);
  assert.equal(outcome.result.state, 'RECOVERY');
});

test('recovery state requires the recovery cooldown below the recovery threshold', () => {
  let context = emptyEngineContext('RECOVERY', now - 60_000);
  // Still above recoveryCm (15): stays RECOVERY.
  let outcome = step(context, 16, 0, now);
  assert.equal(outcome.result.state, 'RECOVERY');
  assert.equal(outcome.result.barrierPolicy, 'HOLD');

  // Below recoveryCm but cooldown not elapsed: still RECOVERY, barrier held.
  context = { ...context, recoveryEnteredAt: now - 10_000 };
  outcome = step(context, 10, 0, now);
  assert.equal(outcome.result.state, 'RECOVERY');
  assert.equal(outcome.result.barrierPolicy, 'HOLD');

  // Cooldown elapsed: NORMAL and the barrier may lower.
  context = { ...context, recoveryEnteredAt: now - 400_000 };
  outcome = step(context, 10, 0, now);
  assert.equal(outcome.result.state, 'NORMAL');
  assert.equal(outcome.result.changed, true);
  assert.equal(outcome.result.barrierPolicy, 'LOWER');
});

test('duplicate-event prevention suppresses repeated event keys inside the window', () => {
  let context = emptyEngineContext('NORMAL', now - 60_000);
  const first = step(context, 30, 0, now);
  assert.ok(first.result.event, 'first WATCH event is emitted');
  context = first.next;
  // Return to NORMAL quickly and rise again into the same band/key.
  const down = step(context, 5, 0, now + 5_000);
  context = down.next;
  const second = step(context, 30, 0, now + 10_000);
  assert.equal(second.result.state, 'WATCH');
  assert.equal(second.result.event, null, 'duplicate event key is suppressed');
  // Outside the duplicate window the same key emits again.
  const third = step(context, 30, 0, now + 2_000_000);
  assert.ok(third.result.event, 'event emits again after the duplicate window');
});

test('multi-sensor confirmation holds escalations until enough sensors agree', () => {
  const strictConfig = { ...config, multiSensorConfirmations: 2 };
  const context = emptyEngineContext('NORMAL', now - 60_000);
  const input = { levelCm: 40, rateOfRiseCmPerMin: 0, sensorHealthy: true, confirmingSensors: 1, now };
  const held = evaluateFloodEngine(context, input, strictConfig);
  assert.equal(held.state, 'NORMAL', 'escalation held with a single confirming sensor');
  const confirmed = evaluateFloodEngine(context, { ...input, confirmingSensors: 2 }, strictConfig);
  assert.equal(confirmed.state, 'WARNING', 'escalation accepted with two confirming sensors');
});

test('sensor faults never mutate the engine state and hold the barrier', () => {
  const context = emptyEngineContext('WARNING', now - 60_000);
  const outcome = step(context, null);
  assert.equal(outcome.result.changed, false);
  assert.equal(outcome.result.barrierPolicy, 'HOLD');
  assert.equal(outcome.next.state, 'WARNING');
});

test('rate-of-rise falls back to zero for stale or invalid samples', () => {
  assert.equal(rateOfRiseCmPerMin(10, now - 60_000, 12, now), 2);
  assert.equal(rateOfRiseCmPerMin(10, now - 60 * 60_000, 12, now), 0, 'stale gap does not drive escalation');
  assert.equal(rateOfRiseCmPerMin(null, 0, 12, now), 0);
  assert.equal(rateOfRiseCmPerMin(10, now + 1000, 12, now), 0);
});

test('legacy SAFE state normalizes to NORMAL', () => {
  assert.equal(normalizeFloodState('SAFE'), 'NORMAL');
  assert.equal(normalizeFloodState('RECOVERY'), 'RECOVERY');
  assert.equal(normalizeFloodState('garbage', 'UNKNOWN'), 'UNKNOWN');
});
