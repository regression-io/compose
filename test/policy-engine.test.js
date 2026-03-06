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
  test('has explore_design key with gate policy', () => {
    assert.equal(DEFAULT_POLICIES.explore_design, 'gate');
  });

  test('all values are valid modes', () => {
    const validModes = ['gate', 'flag', 'skip'];
    for (const [phase, mode] of Object.entries(DEFAULT_POLICIES)) {
      assert.ok(validModes.includes(mode), `${phase} has invalid mode: ${mode}`);
    }
  });

  test('has 10 entries', () => {
    assert.equal(Object.keys(DEFAULT_POLICIES).length, 10);
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
  });

  test('returns gate for explore_design (entry phase)', () => {
    assert.equal(evaluatePolicy('explore_design'), 'gate');
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
