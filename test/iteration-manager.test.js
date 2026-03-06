/**
 * iteration-manager.test.js — Unit tests for lifecycle manager iteration methods.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { VisionStore } = await import(`${REPO_ROOT}/server/vision-store.js`);
const { LifecycleManager, ITERATION_DEFAULTS } = await import(`${REPO_ROOT}/server/lifecycle-manager.js`);

const ALL_SKIP = {
  prd: 'skip', architecture: 'skip', blueprint: 'skip',
  verification: 'skip', plan: 'skip', execute: 'skip',
  report: 'skip', docs: 'skip', ship: 'skip',
};

function setup() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'iter-test-'));
  const dataDir = join(tmpDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const featureRoot = join(tmpDir, 'docs', 'features');
  mkdirSync(join(featureRoot, 'TEST-1'), { recursive: true });

  const store = new VisionStore(dataDir);
  const item = store.createItem({ type: 'feature', title: 'Iter Test Feature' });
  const mgr = new LifecycleManager(store, featureRoot);
  mgr.startLifecycle(item.id, 'TEST-1');

  return { store, item, mgr, tmpDir };
}

function advanceToExecute(store, mgr, itemId) {
  const item = store.items.get(itemId);
  item.lifecycle.policyOverrides = ALL_SKIP;
  store.updateLifecycle(itemId, item.lifecycle);
  mgr.advancePhase(itemId, 'blueprint', 'approved');
  mgr.advancePhase(itemId, 'verification', 'approved');
  mgr.advancePhase(itemId, 'plan', 'approved');
  mgr.advancePhase(itemId, 'execute', 'approved');
}

// ---------------------------------------------------------------------------

describe('ITERATION_DEFAULTS', () => {
  test('review defaults to 10', () => {
    assert.equal(ITERATION_DEFAULTS.review.maxIterations, 10);
  });

  test('coverage defaults to 15', () => {
    assert.equal(ITERATION_DEFAULTS.coverage.maxIterations, 15);
  });
});

describe('startIterationLoop', () => {
  test('creates iterationState with correct defaults for review', () => {
    const { store, item, mgr } = setup();
    advanceToExecute(store, mgr, item.id);
    const result = mgr.startIterationLoop(item.id, 'review');

    assert.ok(result.loopId.startsWith('iter-'));
    assert.equal(result.loopType, 'review');
    assert.equal(result.maxIterations, 10);

    const state = mgr.getIterationStatus(item.id);
    assert.equal(state.count, 0);
    assert.equal(state.outcome, null);
    assert.deepEqual(state.iterations, []);
  });

  test('creates iterationState with correct defaults for coverage', () => {
    const { store, item, mgr } = setup();
    advanceToExecute(store, mgr, item.id);
    const result = mgr.startIterationLoop(item.id, 'coverage');

    assert.equal(result.loopType, 'coverage');
    assert.equal(result.maxIterations, 15);
  });

  test('rejects outside execute phase', () => {
    const { item, mgr } = setup();
    assert.throws(
      () => mgr.startIterationLoop(item.id, 'review'),
      /Cannot start iteration loop outside execute phase/,
    );
  });

  test('rejects when loop already active', () => {
    const { store, item, mgr } = setup();
    advanceToExecute(store, mgr, item.id);
    mgr.startIterationLoop(item.id, 'review');

    assert.throws(
      () => mgr.startIterationLoop(item.id, 'coverage'),
      /Iteration loop already active/,
    );
  });

  test('accepts maxIterations override', () => {
    const { store, item, mgr } = setup();
    advanceToExecute(store, mgr, item.id);
    const result = mgr.startIterationLoop(item.id, 'review', { maxIterations: 5 });
    assert.equal(result.maxIterations, 5);
  });

  test('rejects unknown loop type', () => {
    const { store, item, mgr } = setup();
    advanceToExecute(store, mgr, item.id);
    assert.throws(
      () => mgr.startIterationLoop(item.id, 'bogus'),
      /Unknown loop type/,
    );
  });
});

describe('reportIterationResult', () => {
  test('increments count', () => {
    const { store, item, mgr } = setup();
    advanceToExecute(store, mgr, item.id);
    mgr.startIterationLoop(item.id, 'review');

    const r1 = mgr.reportIterationResult(item.id, { clean: false, summary: 'found issues' });
    assert.equal(r1.count, 1);
    assert.equal(r1.continueLoop, true);

    const r2 = mgr.reportIterationResult(item.id, { clean: false, summary: 'still issues' });
    assert.equal(r2.count, 2);
    assert.equal(r2.continueLoop, true);
  });

  test('clean: true completes review loop', () => {
    const { store, item, mgr } = setup();
    advanceToExecute(store, mgr, item.id);
    mgr.startIterationLoop(item.id, 'review');

    const result = mgr.reportIterationResult(item.id, { clean: true, summary: 'all clean' });
    assert.equal(result.exitCriteriaMet, true);
    assert.equal(result.continueLoop, false);
    assert.equal(result.outcome, 'clean');

    const state = mgr.getIterationStatus(item.id);
    assert.ok(state.completedAt);
  });

  test('passing: true completes coverage loop', () => {
    const { store, item, mgr } = setup();
    advanceToExecute(store, mgr, item.id);
    mgr.startIterationLoop(item.id, 'coverage');

    const result = mgr.reportIterationResult(item.id, { passing: true, summary: 'all pass' });
    assert.equal(result.exitCriteriaMet, true);
    assert.equal(result.continueLoop, false);
    assert.equal(result.outcome, 'clean');
  });

  test('at max iterations returns max_reached', () => {
    const { store, item, mgr } = setup();
    advanceToExecute(store, mgr, item.id);
    mgr.startIterationLoop(item.id, 'review', { maxIterations: 2 });

    mgr.reportIterationResult(item.id, { clean: false });
    const r2 = mgr.reportIterationResult(item.id, { clean: false });

    assert.equal(r2.outcome, 'max_reached');
    assert.equal(r2.continueLoop, false);
    assert.equal(r2.exitCriteriaMet, false);
  });

  test('rejects when no active loop', () => {
    const { store, item, mgr } = setup();
    advanceToExecute(store, mgr, item.id);
    assert.throws(
      () => mgr.reportIterationResult(item.id, { clean: true }),
      /No active iteration loop/,
    );
  });

  test('rejects when loop already completed', () => {
    const { store, item, mgr } = setup();
    advanceToExecute(store, mgr, item.id);
    mgr.startIterationLoop(item.id, 'review');
    mgr.reportIterationResult(item.id, { clean: true });

    assert.throws(
      () => mgr.reportIterationResult(item.id, { clean: false }),
      /No active iteration loop/,
    );
  });

  test('returns loopType in result', () => {
    const { store, item, mgr } = setup();
    advanceToExecute(store, mgr, item.id);
    mgr.startIterationLoop(item.id, 'review');
    const result = mgr.reportIterationResult(item.id, { clean: false });
    assert.equal(result.loopType, 'review');
  });
});

describe('getIterationStatus', () => {
  test('returns null when no iteration', () => {
    const { store, item, mgr } = setup();
    advanceToExecute(store, mgr, item.id);
    assert.equal(mgr.getIterationStatus(item.id), null);
  });

  test('returns active state during loop', () => {
    const { store, item, mgr } = setup();
    advanceToExecute(store, mgr, item.id);
    mgr.startIterationLoop(item.id, 'review');
    mgr.reportIterationResult(item.id, { clean: false, summary: 'issue found' });

    const state = mgr.getIterationStatus(item.id);
    assert.equal(state.loopType, 'review');
    assert.equal(state.count, 1);
    assert.equal(state.completedAt, null);
    assert.equal(state.iterations.length, 1);
    assert.equal(state.iterations[0].result.clean, false);
  });

  test('blocks advancePhase out of execute while loop active', () => {
    const { store, item, mgr } = setup();
    advanceToExecute(store, mgr, item.id);
    mgr.startIterationLoop(item.id, 'review');

    assert.throws(
      () => mgr.advancePhase(item.id, 'report', 'approved'),
      /Cannot leave execute phase.*still active/,
    );
  });

  test('blocks skipPhase out of execute while loop active', () => {
    const { store, item, mgr } = setup();
    advanceToExecute(store, mgr, item.id);
    mgr.startIterationLoop(item.id, 'review');

    assert.throws(
      () => mgr.skipPhase(item.id, 'report', 'skip reason'),
      /Cannot leave execute phase.*still active/,
    );
  });

  test('allows advancePhase after loop completes', () => {
    const { store, item, mgr } = setup();
    advanceToExecute(store, mgr, item.id);
    mgr.startIterationLoop(item.id, 'review');
    mgr.reportIterationResult(item.id, { clean: true, summary: 'done' });

    // Should not throw — loop is completed
    const result = mgr.advancePhase(item.id, 'report', 'approved');
    assert.ok(result);
  });

  test('allows starting new loop after previous completed', () => {
    const { store, item, mgr } = setup();
    advanceToExecute(store, mgr, item.id);
    mgr.startIterationLoop(item.id, 'review');
    mgr.reportIterationResult(item.id, { clean: true });

    // Should not throw — previous loop is completed
    const result = mgr.startIterationLoop(item.id, 'coverage');
    assert.equal(result.loopType, 'coverage');
  });
});
