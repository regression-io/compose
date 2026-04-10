/**
 * Tests for COMP-OBS-GATES: gate-tiers.js
 *
 * Covers:
 *   - evaluateTiers: all tiers passing → no short-circuit
 *   - evaluateTiers: T2 failing → T3/T4 skipped, cost saved
 *   - evaluateTiers: T0 failing → all others skipped
 *   - evaluateTiers: null tiers are not counted as run or skipped
 *   - classifyStepAsTier: known steps map to correct tiers
 *   - estimateTierCost: returns non-negative number for known tiers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { evaluateTiers, classifyStepAsTier, estimateTierCost, GATE_TIERS } =
  await import(`${REPO_ROOT}/lib/gate-tiers.js`);

// ---------------------------------------------------------------------------
// GATE_TIERS definition
// ---------------------------------------------------------------------------

test('GATE_TIERS: exports 5 tiers in order T0 → T4', () => {
  assert.equal(GATE_TIERS.length, 5);
  assert.equal(GATE_TIERS[0].id, 'T0');
  assert.equal(GATE_TIERS[4].id, 'T4');
  for (const tier of GATE_TIERS) {
    assert.ok(typeof tier.id === 'string', `tier.id should be string`);
    assert.ok(typeof tier.name === 'string', `tier.name should be string`);
    assert.ok(typeof tier.cost === 'string', `tier.cost should be string`);
    assert.ok(typeof tier.description === 'string', `tier.description should be string`);
  }
});

// ---------------------------------------------------------------------------
// evaluateTiers: all passing
// ---------------------------------------------------------------------------

test('evaluateTiers: all tiers passing → passed=true, no failure, nothing skipped', () => {
  const result = evaluateTiers({ T0: true, T1: true, T2: true, T3: true, T4: true });
  assert.equal(result.passed, true);
  assert.equal(result.tierThatFailed, null);
  assert.deepEqual(result.tiersRun, ['T0', 'T1', 'T2', 'T3', 'T4']);
  assert.deepEqual(result.tiersSkipped, []);
  assert.equal(result.costSaved, 0);
});

// ---------------------------------------------------------------------------
// evaluateTiers: T2 failing → T3 and T4 skipped
// ---------------------------------------------------------------------------

test('evaluateTiers: T2 failing → T3 and T4 skipped', () => {
  const result = evaluateTiers({ T0: true, T1: true, T2: false, T3: null, T4: null });
  assert.equal(result.passed, false);
  assert.equal(result.tierThatFailed, 'T2');
  assert.deepEqual(result.tiersRun, ['T0', 'T1', 'T2']);
  assert.deepEqual(result.tiersSkipped, ['T3', 'T4']);
  // Cost saved should include T3 ($0.50) + T4 ($0.30)
  assert.ok(result.costSaved > 0, 'should have positive cost saved');
  assert.ok(Math.abs(result.costSaved - 0.80) < 0.001, `expected ~$0.80, got ${result.costSaved}`);
});

test('evaluateTiers: T2 failing with explicit false values for T3/T4', () => {
  // Simulates case where T3/T4 were planned but short-circuited before running
  const result = evaluateTiers({ T0: true, T1: true, T2: false, T3: false, T4: false });
  // Short-circuit stops at T2; T3 and T4 are "skipped" even if they show false
  assert.equal(result.tierThatFailed, 'T2');
  assert.deepEqual(result.tiersSkipped, ['T3', 'T4']);
});

// ---------------------------------------------------------------------------
// evaluateTiers: T0 failing → all subsequent skipped
// ---------------------------------------------------------------------------

test('evaluateTiers: T0 failing → T1/T2/T3/T4 all skipped', () => {
  const result = evaluateTiers({ T0: false, T1: null, T2: null, T3: null, T4: null });
  assert.equal(result.passed, false);
  assert.equal(result.tierThatFailed, 'T0');
  assert.deepEqual(result.tiersRun, ['T0']);
  assert.deepEqual(result.tiersSkipped, ['T1', 'T2', 'T3', 'T4']);
  // T0 is free, T1 is free, T2=$0.05, T3=$0.50, T4=$0.30 → $0.85
  assert.ok(Math.abs(result.costSaved - 0.85) < 0.001, `expected ~$0.85, got ${result.costSaved}`);
});

// ---------------------------------------------------------------------------
// evaluateTiers: null tiers not counted
// ---------------------------------------------------------------------------

test('evaluateTiers: tiers with null are not counted as run or skipped when no failure', () => {
  // Only T0 and T1 have results; T2-T4 were not configured
  const result = evaluateTiers({ T0: true, T1: true });
  assert.equal(result.passed, true);
  assert.deepEqual(result.tiersRun, ['T0', 'T1']);
  assert.deepEqual(result.tiersSkipped, []);
  assert.equal(result.costSaved, 0);
});

test('evaluateTiers: empty tierResults → passed with nothing run', () => {
  const result = evaluateTiers({});
  assert.equal(result.passed, true);
  assert.equal(result.tierThatFailed, null);
  assert.deepEqual(result.tiersRun, []);
  assert.deepEqual(result.tiersSkipped, []);
  assert.equal(result.costSaved, 0);
});

// ---------------------------------------------------------------------------
// classifyStepAsTier: known steps
// ---------------------------------------------------------------------------

test('classifyStepAsTier: maps known steps correctly', () => {
  const cases = [
    ['review', 'T3'],
    ['parallel_review', 'T3'],
    ['codex_review', 'T4'],
    ['run_tests', 'T2'],
    ['coverage_check', 'T2'],
    ['lint', 'T1'],
    ['validate', 'T0'],
    ['schema_check', 'T0'],
  ];
  for (const [stepId, expectedTier] of cases) {
    const actual = classifyStepAsTier(stepId);
    assert.equal(actual, expectedTier, `classifyStepAsTier('${stepId}') expected '${expectedTier}', got '${actual}'`);
  }
});

test('classifyStepAsTier: unknown step returns null', () => {
  assert.equal(classifyStepAsTier('execute'), null);
  assert.equal(classifyStepAsTier('scope'), null);
  assert.equal(classifyStepAsTier('ship'), null);
  assert.equal(classifyStepAsTier(''), null);
  assert.equal(classifyStepAsTier(null), null);
  assert.equal(classifyStepAsTier(undefined), null);
});

// ---------------------------------------------------------------------------
// estimateTierCost
// ---------------------------------------------------------------------------

test('estimateTierCost: returns non-negative number for all known tiers', () => {
  for (const tier of GATE_TIERS) {
    const cost = estimateTierCost(tier.id);
    assert.ok(typeof cost === 'number', `cost for ${tier.id} should be a number`);
    assert.ok(cost >= 0, `cost for ${tier.id} should be non-negative, got ${cost}`);
  }
});

test('estimateTierCost: T3 scales with lensCount', () => {
  const baseCost = estimateTierCost('T3');
  const multiLensCost = estimateTierCost('T3', { lensCount: 3 });
  assert.ok(multiLensCost > baseCost, 'multi-lens T3 should cost more than single-lens');
});

test('estimateTierCost: T0 and T1 are free (zero cost)', () => {
  assert.equal(estimateTierCost('T0'), 0);
  assert.equal(estimateTierCost('T1'), 0);
});

test('estimateTierCost: T3 and T4 have positive base cost', () => {
  assert.ok(estimateTierCost('T3') > 0, 'T3 should have positive base cost');
  assert.ok(estimateTierCost('T4') > 0, 'T4 should have positive base cost');
});

test('estimateTierCost: unknown tier returns 0', () => {
  assert.equal(estimateTierCost('T99'), 0);
  assert.equal(estimateTierCost(''), 0);
});
