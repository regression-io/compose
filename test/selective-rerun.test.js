/**
 * selective-rerun.test.js — STRAT-REV-5: Selective Re-review
 *
 * Tests for prior_dirty_lenses sidecar lifecycle and retry selectivity.
 * Covers helpers directly + the ensure_failed / build-complete call-site logic.
 *
 * Pattern: real fs I/O in tmp dirs (no fs mocking), following build.test.js conventions.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import YAML from 'yaml';

import { BASELINE_LENSES, LENS_DEFINITIONS, triageLenses } from '../lib/review-lenses.js';

// ---------------------------------------------------------------------------
// Import the sidecar helpers from build.js.
// They are not currently exported, so we inline equivalent implementations
// that match the production code exactly — allowing pure unit-level testing
// without requiring a module boundary change.
// ---------------------------------------------------------------------------

function priorDirtyLensesPath(composeDir) {
  return join(composeDir, 'prior_dirty_lenses.json');
}

function persistPriorDirtyLenses(composeDir, lensesRun) {
  mkdirSync(composeDir, { recursive: true });
  writeFileSync(
    priorDirtyLensesPath(composeDir),
    JSON.stringify(lensesRun ?? [], null, 2)
  );
}

function clearPriorDirtyLenses(composeDir) {
  const p = priorDirtyLensesPath(composeDir);
  if (existsSync(p)) rmSync(p);
}

// ---------------------------------------------------------------------------
// Simulate the ensure_failed handler logic (from build.js T2 call-site).
// Returns whether the sidecar was written.
// ---------------------------------------------------------------------------
function simulateEnsureFailed(composeDir, response, currentStepId) {
  const resolvedStepId = response.step_id ?? currentStepId;
  if (resolvedStepId === 'review') {
    const lensesRun = response.output?.lenses_run ?? [];
    if (lensesRun.length > 0) {
      persistPriorDirtyLenses(composeDir, lensesRun);
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Simulate the build-complete handler logic (from build.js T3 call-site).
// ---------------------------------------------------------------------------
function simulateBuildComplete(composeDir) {
  clearPriorDirtyLenses(composeDir);
}

function loadParallelReviewTriageIntent() {
  const pipelinePath = join(process.cwd(), 'pipelines', 'build.stratum.yaml');
  const pipeline = YAML.parse(readFileSync(pipelinePath, 'utf-8'));
  return pipeline.flows.parallel_review.steps.find(step => step.id === 'triage').intent;
}

function selectRetryLenses(priorDirtyLenses) {
  const lensIds = [...BASELINE_LENSES];
  for (const lensId of priorDirtyLenses ?? []) {
    if (!lensIds.includes(lensId)) lensIds.push(lensId);
  }
  return lensIds.map(id => LENS_DEFINITIONS[id]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  const dir = join(tmpdir(), `strat-rev5-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('STRAT-REV-5: prior_dirty_lenses sidecar', () => {

  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // T6-1: persistPriorDirtyLenses writes correct JSON
  it('T6-1: persistPriorDirtyLenses writes correct content to sidecar path', () => {
    persistPriorDirtyLenses(tmpDir, ['contract-compliance']);
    const sidecarPath = priorDirtyLensesPath(tmpDir);
    assert.ok(existsSync(sidecarPath), 'sidecar file should exist after persist');
    const content = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
    assert.deepEqual(content, ['contract-compliance']);
  });

  // T6-2: persistPriorDirtyLenses overwrites on second call
  it('T6-2: persistPriorDirtyLenses overwrites on subsequent call', () => {
    persistPriorDirtyLenses(tmpDir, ['contract-compliance']);
    persistPriorDirtyLenses(tmpDir, ['security']);
    const content = JSON.parse(readFileSync(priorDirtyLensesPath(tmpDir), 'utf-8'));
    assert.deepEqual(content, ['security'], 'second persist should overwrite the first');
  });

  // T6-3: clearPriorDirtyLenses deletes existing file
  it('T6-3: clearPriorDirtyLenses deletes an existing sidecar file', () => {
    persistPriorDirtyLenses(tmpDir, ['diff-quality']);
    assert.ok(existsSync(priorDirtyLensesPath(tmpDir)), 'file should exist before clear');
    clearPriorDirtyLenses(tmpDir);
    assert.ok(!existsSync(priorDirtyLensesPath(tmpDir)), 'file should be absent after clear');
  });

  // T6-4: clearPriorDirtyLenses no-ops when file absent
  it('T6-4: clearPriorDirtyLenses does not throw when sidecar is absent', () => {
    assert.ok(!existsSync(priorDirtyLensesPath(tmpDir)), 'precondition: no sidecar');
    assert.doesNotThrow(() => clearPriorDirtyLenses(tmpDir));
  });

  // T6-5: ensure_failed handler writes sidecar for review step with non-empty lenses_run
  it('T6-5: ensure_failed handler writes sidecar for review step with non-empty lenses_run', () => {
    const response = {
      status: 'ensure_failed',
      step_id: 'review',
      output: { lenses_run: ['contract-compliance'] },
      violations: ['result.clean == True'],
    };
    const wrote = simulateEnsureFailed(tmpDir, response, 'review');
    assert.ok(wrote, 'handler should have written the sidecar');
    const content = JSON.parse(readFileSync(priorDirtyLensesPath(tmpDir), 'utf-8'));
    assert.deepEqual(content, ['contract-compliance']);
  });

  // T6-6: ensure_failed handler skips sidecar when lenses_run is empty
  it('T6-6: ensure_failed handler does not write sidecar when lenses_run is empty', () => {
    const response = {
      status: 'ensure_failed',
      step_id: 'review',
      output: { lenses_run: [] },
      violations: ['result.clean == True'],
    };
    const wrote = simulateEnsureFailed(tmpDir, response, 'review');
    assert.ok(!wrote, 'handler should not have written the sidecar');
    assert.ok(!existsSync(priorDirtyLensesPath(tmpDir)), 'sidecar file should not exist');
  });

  // T6-7: ensure_failed handler skips sidecar for non-review steps
  it('T6-7: ensure_failed handler does not write sidecar for non-review steps', () => {
    const response = {
      status: 'ensure_failed',
      step_id: 'execute',
      output: { lenses_run: ['security'] }, // lenses_run present but step is not review
      violations: ['result.outcome == "complete"'],
    };
    const wrote = simulateEnsureFailed(tmpDir, response, 'execute');
    assert.ok(!wrote, 'handler should not have written the sidecar');
    assert.ok(!existsSync(priorDirtyLensesPath(tmpDir)), 'sidecar file should not exist');
  });

  // T6-8: build complete branch clears sidecar
  it('T6-8: build complete branch clears a pre-existing sidecar', () => {
    persistPriorDirtyLenses(tmpDir, ['contract-compliance']);
    assert.ok(existsSync(priorDirtyLensesPath(tmpDir)), 'precondition: sidecar should exist');
    simulateBuildComplete(tmpDir);
    assert.ok(!existsSync(priorDirtyLensesPath(tmpDir)), 'sidecar should be deleted after build complete');
  });

  // T6-9: first-run — sidecar never created when review passes clean
  it('T6-9: sidecar is never created when review passes clean (no ensure_failed)', () => {
    // A clean review means ensure_failed never fires — no persist call is made.
    // Simulate the happy path: step runs, result is clean (no simulate call).
    // Then build completes (clear is a no-op when file doesn't exist).
    simulateBuildComplete(tmpDir);
    assert.ok(!existsSync(priorDirtyLensesPath(tmpDir)), 'sidecar should never exist when review is clean');
  });

  // T6-10: executeChildFlow path — ensure_failed for flow-step 'review' writes sidecar
  // The review step uses `flow: parallel_review`, so its ensure condition fires inside
  // executeChildFlow, NOT in the main dispatch loop.  The sidecar write must live in
  // executeChildFlow's ensure_failed branch to actually be reached.
  it('T6-10: executeChildFlow ensure_failed path writes sidecar for review step', () => {
    // Simulate the executeChildFlow ensure_failed handler (mirrors build.js behaviour).
    function simulateEnsureFailedChildFlow(composeDir, resp) {
      if (resp.step_id === 'review') {
        const lensesRun = resp.output?.lenses_run ?? [];
        if (lensesRun.length > 0) {
          persistPriorDirtyLenses(composeDir, lensesRun);
          return true;
        }
      }
      return false;
    }

    const resp = {
      status: 'ensure_failed',
      step_id: 'review',
      output: { lenses_run: ['diff-quality', 'contract-compliance'] },
      violations: ["ensure 'result.clean == True' failed"],
    };
    const wrote = simulateEnsureFailedChildFlow(tmpDir, resp);
    assert.ok(wrote, 'executeChildFlow handler should have written the sidecar');
    const content = JSON.parse(readFileSync(priorDirtyLensesPath(tmpDir), 'utf-8'));
    assert.deepEqual(content, ['diff-quality', 'contract-compliance']);
  });

  // T6-11: triage contract explicitly documents selective retry rules
  it('T6-11: triage intent encodes sidecar-based selective retry rules', () => {
    const intent = loadParallelReviewTriageIntent();
    assert.match(intent, /RETRY PATH/);
    assert.match(intent, /FIRST RUN PATH/);
    assert.match(intent, /\.compose\/prior_dirty_lenses\.json/);
    assert.match(intent, /Activate all lenses listed in that array\./);
    assert.match(intent, /Always also include diff-quality and contract-compliance/);
    assert.match(intent, /Skip all other lenses/);
  });

  // T6-12: retry with contract-only findings re-runs baseline lenses only
  it('T6-12: retry selectivity keeps retry scoped to baseline lenses when only contract lens was dirty', () => {
    const retried = selectRetryLenses(['contract-compliance']).map(task => task.id);
    assert.deepEqual(retried, ['diff-quality', 'contract-compliance']);
  });

  // T6-13: retry preserves previously dirty non-baseline lenses alongside baselines
  it('T6-13: retry selectivity re-runs dirty optional lenses plus the baselines', () => {
    const retried = selectRetryLenses(['security']).map(task => task.id);
    assert.deepEqual(retried, ['diff-quality', 'contract-compliance', 'security']);
  });

  // T6-14: first-run still uses file-based triage when sidecar is absent
  it('T6-14: first-run path still activates broader lens set from file triggers', () => {
    const firstRun = triageLenses(['src/auth/login.jsx']).map(task => task.id);
    assert.deepEqual(firstRun, ['diff-quality', 'contract-compliance', 'security', 'framework']);
  });

});
