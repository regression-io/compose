/**
 * policy-engine.test.js — Unit tests for policy evaluation.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { DEFAULT_POLICIES, VALID_GATE_OUTCOMES, evaluatePolicy } =
  await import(`${REPO_ROOT}/server/policy-engine.js`);

describe('DEFAULT_POLICIES', () => {
  test('has no explore_design key', () => {
    assert.equal(DEFAULT_POLICIES.explore_design, undefined);
  });

  test('all values are valid modes', () => {
    const validModes = ['gate', 'flag', 'skip'];
    for (const [phase, mode] of Object.entries(DEFAULT_POLICIES)) {
      assert.ok(validModes.includes(mode), `${phase} has invalid mode: ${mode}`);
    }
  });

  test('has 9 entries', () => {
    assert.equal(Object.keys(DEFAULT_POLICIES).length, 9);
  });
});

describe('evaluatePolicy', () => {
  test('returns correct default for each phase', () => {
    assert.equal(evaluatePolicy('blueprint'), 'gate');
    assert.equal(evaluatePolicy('verification'), 'gate');
    assert.equal(evaluatePolicy('plan'), 'gate');
    assert.equal(evaluatePolicy('ship'), 'gate');
    assert.equal(evaluatePolicy('execute'), 'flag');
    assert.equal(evaluatePolicy('docs'), 'flag');
    assert.equal(evaluatePolicy('prd'), 'skip');
    assert.equal(evaluatePolicy('architecture'), 'skip');
    assert.equal(evaluatePolicy('report'), 'skip');
  });

  test('returns skip for unknown phases', () => {
    assert.equal(evaluatePolicy('nonexistent'), 'skip');
    assert.equal(evaluatePolicy('explore_design'), 'skip');
  });

  test('override map overrides default', () => {
    assert.equal(evaluatePolicy('blueprint', { blueprint: 'skip' }), 'skip');
    assert.equal(evaluatePolicy('prd', { prd: 'gate' }), 'gate');
  });

  test('throws on invalid mode in overrides', () => {
    assert.throws(
      () => evaluatePolicy('blueprint', { blueprint: 'bogus' }),
      /Invalid policy mode: bogus/,
    );
  });

  test('handles null overrides without crash', () => {
    assert.equal(evaluatePolicy('blueprint', null), 'gate');
  });

  test('handles undefined overrides without crash', () => {
    assert.equal(evaluatePolicy('blueprint', undefined), 'gate');
  });
});

describe('VALID_GATE_OUTCOMES', () => {
  test('contains approved, revised, killed', () => {
    assert.deepEqual(VALID_GATE_OUTCOMES, ['approved', 'revised', 'killed']);
  });
});
