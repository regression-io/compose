/**
 * Unit tests for server/policy-evaluator.js
 *
 * Test case table from ITEM-23 plan:
 * | # | policies config           | stepId    | toPhase    | expected | reason               |
 * |---|--------------------------|-----------|------------|----------|----------------------|
 * | 1 | { blueprint: 'gate' }    | review    | blueprint  | gate     | toPhase lookup       |
 * | 2 | { execute: 'flag' }      | execute   | undefined  | flag     | stepId fallback      |
 * | 3 | { prd: 'skip' }          | prd       | prd        | skip     | explicit skip        |
 * | 4 | {} (empty)               | blueprint | blueprint  | gate     | null→gate default    |
 * | 5 | { ship: 'gate' }         | unknown   | undefined  | gate     | unknown→gate default |
 * | 6 | { execute: 'flag' }      | execute   | ship       | gate     | toPhase wins stepId  |
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePolicy } from '../server/policy-evaluator.js';

describe('evaluatePolicy', () => {
  test('case 1: toPhase lookup takes precedence', () => {
    const settings = { policies: { blueprint: 'gate' } };
    const result = evaluatePolicy(settings, 'review', { toPhase: 'blueprint' });
    assert.equal(result.mode, 'gate');
  });

  test('case 2: stepId fallback when toPhase undefined', () => {
    const settings = { policies: { execute: 'flag' } };
    const result = evaluatePolicy(settings, 'execute');
    assert.equal(result.mode, 'flag');
  });

  test('case 3: explicit skip', () => {
    const settings = { policies: { prd: 'skip' } };
    const result = evaluatePolicy(settings, 'prd', { toPhase: 'prd' });
    assert.equal(result.mode, 'skip');
  });

  test('case 4: empty policies → gate default', () => {
    const settings = { policies: {} };
    const result = evaluatePolicy(settings, 'blueprint', { toPhase: 'blueprint' });
    assert.equal(result.mode, 'gate');
    assert.ok(result.reason.includes('defaulting to gate'));
  });

  test('case 5: unknown phase → gate default', () => {
    const settings = { policies: { ship: 'gate' } };
    const result = evaluatePolicy(settings, 'unknown');
    assert.equal(result.mode, 'gate');
  });

  test('case 6: toPhase overrides stepId for lookup', () => {
    const settings = { policies: { execute: 'flag', ship: 'gate' } };
    const result = evaluatePolicy(settings, 'execute', { toPhase: 'ship' });
    assert.equal(result.mode, 'gate');
  });

  test('null settings → gate default', () => {
    const result = evaluatePolicy(null, 'blueprint');
    assert.equal(result.mode, 'gate');
  });

  test('undefined policies → gate default', () => {
    const result = evaluatePolicy({}, 'blueprint');
    assert.equal(result.mode, 'gate');
  });

  test('invalid policy mode → gate default', () => {
    const settings = { policies: { execute: 'invalid_mode' } };
    const result = evaluatePolicy(settings, 'execute');
    assert.equal(result.mode, 'gate');
    assert.ok(result.reason.includes('unknown policy'));
  });

  test('reason includes phase name', () => {
    const settings = { policies: { blueprint: 'flag' } };
    const result = evaluatePolicy(settings, 'blueprint');
    assert.ok(result.reason.includes('blueprint'));
    assert.ok(result.reason.includes('flag'));
  });
});
