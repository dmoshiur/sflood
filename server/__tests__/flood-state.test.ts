import assert from 'node:assert/strict';
import { test } from 'node:test';
import { barrierForInputs, buzzerForState, floodStateForLevel } from '../../shared/flood-state.js';

test('maps calibrated sample centimeters to documented flood states', () => {
  assert.equal(floodStateForLevel(0), 'NORMAL');
  assert.equal(floodStateForLevel(19.99), 'NORMAL');
  assert.equal(floodStateForLevel(20), 'WATCH');
  assert.equal(floodStateForLevel(34.99), 'WATCH');
  assert.equal(floodStateForLevel(35), 'WARNING');
  assert.equal(floodStateForLevel(49.99), 'WARNING');
  assert.equal(floodStateForLevel(50), 'CRITICAL');
  assert.equal(floodStateForLevel(null), 'UNKNOWN');
  assert.equal(floodStateForLevel(Number.NaN), 'UNKNOWN');
  assert.equal(floodStateForLevel(22, false), 'UNKNOWN');
});

test('keeps local actuator policy cautious on sensor faults and latches raised barrier', () => {
  assert.equal(buzzerForState('NORMAL'), false);
  assert.equal(buzzerForState('WATCH'), true);
  assert.equal(buzzerForState('CRITICAL'), true);
  assert.equal(barrierForInputs({ levelCm: 35, sensorHealthy: true, emergencyStopActive: false }), 'RAISED');
  assert.equal(barrierForInputs({ levelCm: null, sensorHealthy: false, emergencyStopActive: false }, 'RAISED', true), 'HOLD');
  assert.equal(barrierForInputs({ levelCm: 8, sensorHealthy: true, emergencyStopActive: false }, 'HOLD', true), 'RAISED');
  assert.equal(barrierForInputs({ levelCm: 8, sensorHealthy: true, emergencyStopActive: true }, 'RAISED', true), 'FAULT');
});
