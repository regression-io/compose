/**
 * lifecycle-manager.test.js — State machine tests.
 *
 * Covers: startLifecycle, advancePhase, skipPhase, killFeature,
 *         completeFeature, getPhase, getHistory, reconcile,
 *         store allowlist protection, and updateLifecycle.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { LifecycleManager, PHASES, TERMINAL, SKIPPABLE, TRANSITIONS, PHASE_ARTIFACTS } =
  await import(`${REPO_ROOT}/server/lifecycle-manager.js`);
const { VisionStore } = await import(`${REPO_ROOT}/server/vision-store.js`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setup() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lm-test-'));
  const dataDir = join(tmpDir, 'data');
  mkdirSync(dataDir, { recursive: true });

  const featureRoot = join(tmpDir, 'features');
  mkdirSync(join(featureRoot, 'TEST-1'), { recursive: true });

  const store = new VisionStore(dataDir);
  const item = store.createItem({ type: 'feature', title: 'Test Feature' });

  const manager = new LifecycleManager(store, featureRoot);
  return { tmpDir, featureRoot, store, item, manager };
}

function cleanup(tmpDir) {
  rmSync(tmpDir, { recursive: true, force: true });
}

/** Advance a lifecycle through a sequence of phases, skipping skippable ones. */
function advanceThrough(manager, itemId, phases) {
  for (const phase of phases) {
    const { lifecycle } = getLifecycleFromStore(manager, itemId);
    const current = lifecycle.currentPhase;
    if (SKIPPABLE.has(current) && current !== phase) {
      // Need to skip current to reach target
      const successors = TRANSITIONS[current];
      const target = successors.find(s => s === phase) || successors[successors.length - 1];
      manager.skipPhase(itemId, target, `skip ${current}`);
      if (target === phase) continue;
    }
    if (getLifecycleFromStore(manager, itemId).lifecycle.currentPhase === phase) continue;
    manager.advancePhase(itemId, phase, 'approved');
  }
}

function getLifecycleFromStore(manager, itemId) {
  // Access via getPhase to confirm it works, but return the full lifecycle
  const phase = manager.getPhase(itemId);
  const history = manager.getHistory(itemId);
  return { lifecycle: { currentPhase: phase, phaseHistory: history } };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('startLifecycle', () => {
  let ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => cleanup(ctx.tmpDir));

  test('creates lifecycle with correct initial state', () => {
    const lc = ctx.manager.startLifecycle(ctx.item.id, 'TEST-1');
    assert.equal(lc.currentPhase, 'explore_design');
    assert.equal(lc.featureCode, 'TEST-1');
    assert.equal(lc.phaseHistory.length, 1);
    assert.equal(lc.phaseHistory[0].phase, 'explore_design');
    assert.equal(lc.phaseHistory[0].exitedAt, null);
    assert.equal(lc.phaseHistory[0].outcome, null);
    assert.ok(lc.startedAt);
    assert.equal(lc.completedAt, null);
    assert.equal(lc.killedAt, null);
  });

  test('scans existing artifacts on start', () => {
    writeFileSync(join(ctx.featureRoot, 'TEST-1', 'design.md'), '# Design');
    const lc = ctx.manager.startLifecycle(ctx.item.id, 'TEST-1');
    assert.equal(lc.artifacts['design.md'], true);
    assert.equal(lc.artifacts['prd.md'], false);
  });

  test('throws if lifecycle already exists', () => {
    ctx.manager.startLifecycle(ctx.item.id, 'TEST-1');
    assert.throws(
      () => ctx.manager.startLifecycle(ctx.item.id, 'TEST-1'),
      /already has a lifecycle/,
    );
  });
});

describe('advancePhase — full happy path', () => {
  let ctx;
  beforeEach(() => {
    ctx = setup();
    ctx.manager.startLifecycle(ctx.item.id, 'TEST-1');
  });
  afterEach(() => cleanup(ctx.tmpDir));

  test('explore_design → blueprint (skipping prd, architecture)', () => {
    const r = ctx.manager.advancePhase(ctx.item.id, 'blueprint', 'approved');
    assert.equal(r.from, 'explore_design');
    assert.equal(r.to, 'blueprint');
    assert.equal(ctx.manager.getPhase(ctx.item.id), 'blueprint');
  });

  test('full path to complete', () => {
    ctx.manager.advancePhase(ctx.item.id, 'blueprint', 'approved');
    ctx.manager.advancePhase(ctx.item.id, 'verification', 'approved');
    ctx.manager.advancePhase(ctx.item.id, 'plan', 'approved');
    ctx.manager.advancePhase(ctx.item.id, 'execute', 'approved');
    ctx.manager.advancePhase(ctx.item.id, 'docs', 'approved');
    ctx.manager.advancePhase(ctx.item.id, 'ship', 'approved');

    const result = ctx.manager.completeFeature(ctx.item.id);
    assert.ok(result.completedAt);
    assert.equal(ctx.manager.getPhase(ctx.item.id), 'complete');

    const item = ctx.store.items.get(ctx.item.id);
    assert.equal(item.status, 'complete');
  });
});

describe('skipPhase', () => {
  let ctx;
  beforeEach(() => {
    ctx = setup();
    ctx.manager.startLifecycle(ctx.item.id, 'TEST-1');
  });
  afterEach(() => cleanup(ctx.tmpDir));

  test('skip prd from explore_design', () => {
    ctx.manager.advancePhase(ctx.item.id, 'prd', 'approved');
    const r = ctx.manager.skipPhase(ctx.item.id, 'blueprint', 'Internal feature');
    assert.equal(r.outcome, 'skipped');
    assert.equal(r.reason, 'Internal feature');
    assert.equal(ctx.manager.getPhase(ctx.item.id), 'blueprint');
  });

  test('skip architecture from prd', () => {
    ctx.manager.advancePhase(ctx.item.id, 'prd', 'approved');
    ctx.manager.skipPhase(ctx.item.id, 'architecture', 'Too small');
    const r = ctx.manager.skipPhase(ctx.item.id, 'blueprint', 'Single module');
    assert.equal(r.from, 'architecture');
    assert.equal(ctx.manager.getPhase(ctx.item.id), 'blueprint');
  });

  test('skip report from execute', () => {
    ctx.manager.advancePhase(ctx.item.id, 'blueprint', 'approved');
    ctx.manager.advancePhase(ctx.item.id, 'verification', 'approved');
    ctx.manager.advancePhase(ctx.item.id, 'plan', 'approved');
    ctx.manager.advancePhase(ctx.item.id, 'execute', 'approved');
    ctx.manager.advancePhase(ctx.item.id, 'report', 'approved');
    const r = ctx.manager.skipPhase(ctx.item.id, 'docs', 'No PRD');
    assert.equal(r.outcome, 'skipped');
    assert.equal(ctx.manager.getPhase(ctx.item.id), 'docs');
  });
});

describe('revision loop', () => {
  let ctx;
  beforeEach(() => {
    ctx = setup();
    ctx.manager.startLifecycle(ctx.item.id, 'TEST-1');
    ctx.manager.advancePhase(ctx.item.id, 'blueprint', 'approved');
    ctx.manager.advancePhase(ctx.item.id, 'verification', 'approved');
  });
  afterEach(() => cleanup(ctx.tmpDir));

  test('verification → blueprint with revised', () => {
    const r = ctx.manager.advancePhase(ctx.item.id, 'blueprint', 'revised');
    assert.equal(r.from, 'verification');
    assert.equal(r.to, 'blueprint');
    assert.equal(r.outcome, 'revised');
    assert.equal(ctx.manager.getPhase(ctx.item.id), 'blueprint');
  });
});

describe('killFeature', () => {
  let ctx;
  beforeEach(() => {
    ctx = setup();
    ctx.manager.startLifecycle(ctx.item.id, 'TEST-1');
  });
  afterEach(() => cleanup(ctx.tmpDir));

  test('kill from mid-phase', () => {
    ctx.manager.advancePhase(ctx.item.id, 'blueprint', 'approved');
    const r = ctx.manager.killFeature(ctx.item.id, 'Requirements changed');
    assert.equal(r.phase, 'blueprint');
    assert.equal(r.reason, 'Requirements changed');
    assert.equal(ctx.manager.getPhase(ctx.item.id), 'killed');

    const item = ctx.store.items.get(ctx.item.id);
    assert.equal(item.status, 'killed');
    assert.ok(item.lifecycle.killedAt);
    assert.equal(item.lifecycle.killReason, 'Requirements changed');
  });
});

// ---------------------------------------------------------------------------
// Error paths (table-driven)
// ---------------------------------------------------------------------------

describe('error paths', () => {
  let ctx;
  beforeEach(() => {
    ctx = setup();
    ctx.manager.startLifecycle(ctx.item.id, 'TEST-1');
  });
  afterEach(() => cleanup(ctx.tmpDir));

  const errorCases = [
    {
      name: 'invalid transition: explore_design → execute',
      fn: (m, id) => m.advancePhase(id, 'execute', 'approved'),
      match: /Invalid transition/,
    },
    {
      name: 'invalid outcome',
      fn: (m, id) => m.advancePhase(id, 'blueprint', 'foo'),
      match: /Invalid outcome/,
    },
    {
      name: 'revised on forward edge',
      fn: (m, id) => m.advancePhase(id, 'blueprint', 'revised'),
      match: /backward transition/,
    },
    {
      name: 'skip non-skippable phase (explore_design)',
      fn: (m, id) => m.skipPhase(id, 'blueprint', 'reason'),
      match: /not skippable/,
    },
    {
      name: 'complete from non-ship phase',
      fn: (m, id) => m.completeFeature(id),
      match: /only complete from ship/,
    },
  ];

  for (const { name, fn, match } of errorCases) {
    test(name, () => {
      assert.throws(() => fn(ctx.manager, ctx.item.id), match);
    });
  }

  test('advance from terminal (complete)', () => {
    // Advance to ship then complete
    ctx.manager.advancePhase(ctx.item.id, 'blueprint', 'approved');
    ctx.manager.advancePhase(ctx.item.id, 'verification', 'approved');
    ctx.manager.advancePhase(ctx.item.id, 'plan', 'approved');
    ctx.manager.advancePhase(ctx.item.id, 'execute', 'approved');
    ctx.manager.advancePhase(ctx.item.id, 'docs', 'approved');
    ctx.manager.advancePhase(ctx.item.id, 'ship', 'approved');
    ctx.manager.completeFeature(ctx.item.id);

    assert.throws(
      () => ctx.manager.advancePhase(ctx.item.id, 'explore_design', 'approved'),
      /terminal state/,
    );
  });

  test('advance from terminal (killed)', () => {
    ctx.manager.killFeature(ctx.item.id, 'done');
    assert.throws(
      () => ctx.manager.advancePhase(ctx.item.id, 'blueprint', 'approved'),
      /terminal state/,
    );
  });

  test('kill from terminal state', () => {
    ctx.manager.killFeature(ctx.item.id, 'first');
    assert.throws(
      () => ctx.manager.killFeature(ctx.item.id, 'second'),
      /terminal state/,
    );
  });

  test('no lifecycle on item', () => {
    const item2 = ctx.store.createItem({ type: 'feature', title: 'No Lifecycle' });
    assert.throws(
      () => ctx.manager.advancePhase(item2.id, 'blueprint', 'approved'),
      /No lifecycle/,
    );
  });

  test('item not found', () => {
    assert.throws(
      () => ctx.manager.advancePhase('nonexistent-id', 'blueprint', 'approved'),
      /Item not found/,
    );
  });
});

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

describe('reconcile', () => {
  let ctx;
  beforeEach(() => {
    ctx = setup();
    ctx.manager.startLifecycle(ctx.item.id, 'TEST-1');
  });
  afterEach(() => cleanup(ctx.tmpDir));

  test('forward: artifacts ahead → advances with reconciled entries', () => {
    // Put blueprint.md on disk while still in explore_design
    writeFileSync(join(ctx.featureRoot, 'TEST-1', 'design.md'), '# Design');
    writeFileSync(join(ctx.featureRoot, 'TEST-1', 'blueprint.md'), '# Blueprint');

    const result = ctx.manager.reconcile(ctx.item.id);
    assert.equal(result.currentPhase, 'blueprint');
    assert.equal(result.reconcileWarning, null);

    const history = ctx.manager.getHistory(ctx.item.id);
    // Should have reconciled entries for intermediate phases
    const reconciled = history.filter(e => e.outcome === 'reconciled');
    assert.ok(reconciled.length > 0);
  });

  test('backward: artifacts behind → sets warning, does not regress', () => {
    // Advance to plan
    ctx.manager.advancePhase(ctx.item.id, 'blueprint', 'approved');
    ctx.manager.advancePhase(ctx.item.id, 'verification', 'approved');
    ctx.manager.advancePhase(ctx.item.id, 'plan', 'approved');

    // Put design.md on disk but NOT blueprint.md (simulating blueprint deletion)
    writeFileSync(join(ctx.featureRoot, 'TEST-1', 'design.md'), '# Design');
    const result = ctx.manager.reconcile(ctx.item.id);
    assert.equal(result.currentPhase, 'plan');  // did NOT regress
    assert.ok(result.reconcileWarning);
    assert.equal(result.reconcileWarning.currentPhase, 'plan');
    assert.ok(result.reconcileWarning.missingArtifacts.includes('blueprint.md'));
  });

  test('equal: clears existing warning', () => {
    // Set up a warning first
    ctx.manager.advancePhase(ctx.item.id, 'blueprint', 'approved');
    ctx.manager.reconcile(ctx.item.id);  // no design.md → warning

    // Now put the artifact on disk and reconcile again
    writeFileSync(join(ctx.featureRoot, 'TEST-1', 'design.md'), '# Design');
    writeFileSync(join(ctx.featureRoot, 'TEST-1', 'blueprint.md'), '# Blueprint');
    const result = ctx.manager.reconcile(ctx.item.id);
    assert.equal(result.reconcileWarning, null);
  });

  test('terminal state (complete): reconcile does not transition out', () => {
    ctx.manager.advancePhase(ctx.item.id, 'blueprint', 'approved');
    ctx.manager.advancePhase(ctx.item.id, 'verification', 'approved');
    ctx.manager.advancePhase(ctx.item.id, 'plan', 'approved');
    ctx.manager.advancePhase(ctx.item.id, 'execute', 'approved');
    ctx.manager.advancePhase(ctx.item.id, 'docs', 'approved');
    ctx.manager.advancePhase(ctx.item.id, 'ship', 'approved');
    ctx.manager.completeFeature(ctx.item.id);

    // Put artifacts on disk — reconcile must NOT leave terminal state
    writeFileSync(join(ctx.featureRoot, 'TEST-1', 'design.md'), '# Design');
    const result = ctx.manager.reconcile(ctx.item.id);
    assert.equal(result.currentPhase, 'complete');
  });

  test('terminal state (killed): reconcile does not transition out', () => {
    ctx.manager.killFeature(ctx.item.id, 'cancelled');

    writeFileSync(join(ctx.featureRoot, 'TEST-1', 'design.md'), '# Design');
    const result = ctx.manager.reconcile(ctx.item.id);
    assert.equal(result.currentPhase, 'killed');
  });

  test('no artifacts at all: flags warning when current phase is non-initial', () => {
    ctx.manager.advancePhase(ctx.item.id, 'blueprint', 'approved');
    // No artifacts on disk at all
    const result = ctx.manager.reconcile(ctx.item.id);
    assert.equal(result.currentPhase, 'blueprint');  // did NOT regress
    assert.ok(result.reconcileWarning);
    assert.equal(result.reconcileWarning.inferredPhase, 'none');
  });
});

// ---------------------------------------------------------------------------
// Store integration
// ---------------------------------------------------------------------------

describe('store integration', () => {
  let ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => cleanup(ctx.tmpDir));

  test('updateItem PATCH cannot set lifecycle (allowlist protection)', () => {
    const fakeLifecycle = { currentPhase: 'hacked' };
    ctx.store.updateItem(ctx.item.id, { lifecycle: fakeLifecycle, title: 'Updated' });
    const item = ctx.store.items.get(ctx.item.id);
    assert.equal(item.title, 'Updated');
    assert.equal(item.lifecycle, undefined);
  });

  test('updateLifecycle can set lifecycle', () => {
    const lifecycle = { currentPhase: 'explore_design', test: true };
    ctx.store.updateLifecycle(ctx.item.id, lifecycle);
    const item = ctx.store.items.get(ctx.item.id);
    assert.deepEqual(item.lifecycle, lifecycle);
  });
});
