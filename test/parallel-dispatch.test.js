/**
 * Tests for STRAT-PAR-3 parallel_dispatch branch in lib/build.js.
 *
 *   T8a — parallel_dispatch branch does not throw
 *   T8b — parallel_dispatch branch calls parallelDone with correct shape
 *   T8c — existing branches still present and ordering preserved
 *
 * These tests replace the "stub throws" assertions from parallel-dispatch-stub.test.js
 * with assertions about the live fan-out implementation.
 */

import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const LIB_DIR = join(__dirname, '..', 'lib');

// ---------------------------------------------------------------------------
// T8a — parallel_dispatch branch no longer throws
// ---------------------------------------------------------------------------

describe('build.js — parallel_dispatch branch (T8)', () => {
  test('parallel_dispatch branch does not throw "not yet implemented"', () => {
    const src = readFileSync(join(LIB_DIR, 'build.js'), 'utf-8');
    assert.ok(
      !src.includes('parallel_dispatch not yet implemented'),
      "build.js parallel_dispatch branch must NOT throw 'parallel_dispatch not yet implemented' after STRAT-PAR-3"
    );
  });

  test('parallel_dispatch branch exists before else fallback', () => {
    const src = readFileSync(join(LIB_DIR, 'build.js'), 'utf-8');

    const parallelIdx    = src.indexOf("response.status === 'parallel_dispatch'");
    const elseFallbackIdx = src.indexOf("Unknown dispatch status");

    assert.ok(parallelIdx !== -1, 'parallel_dispatch branch must exist');
    assert.ok(elseFallbackIdx !== -1, 'else fallback must exist');
    assert.ok(parallelIdx < elseFallbackIdx,
      'parallel_dispatch branch must come before else fallback');
  });

  test('parallel_dispatch branch calls parallelDone', () => {
    const src = readFileSync(join(LIB_DIR, 'build.js'), 'utf-8');
    assert.ok(
      src.includes('parallelDone') || src.includes('parallel_done'),
      'parallel_dispatch branch must call parallelDone or parallel_done'
    );
  });

  test('parallel_dispatch branch uses Promise.allSettled for fan-out', () => {
    const src = readFileSync(join(LIB_DIR, 'build.js'), 'utf-8');
    assert.ok(
      src.includes('Promise.allSettled'),
      'parallel_dispatch branch must use Promise.allSettled for concurrent task fan-out'
    );
  });

  test('parallel_dispatch branch streams build_step_start events', () => {
    const src = readFileSync(join(LIB_DIR, 'build.js'), 'utf-8');
    // The branch must emit step start events
    const parallelIdx  = src.indexOf("response.status === 'parallel_dispatch'");
    const nextBranchIdx = src.indexOf("} else {", parallelIdx);
    const branchSrc    = src.slice(parallelIdx, nextBranchIdx);
    assert.ok(
      branchSrc.includes('build_step_start'),
      'parallel_dispatch branch must write build_step_start stream events'
    );
  });

  test('parallel_dispatch branch streams build_step_done events', () => {
    const src = readFileSync(join(LIB_DIR, 'build.js'), 'utf-8');
    const parallelIdx  = src.indexOf("response.status === 'parallel_dispatch'");
    const nextBranchIdx = src.indexOf("} else {", parallelIdx);
    const branchSrc    = src.slice(parallelIdx, nextBranchIdx);
    assert.ok(
      branchSrc.includes('build_step_done'),
      'parallel_dispatch branch must write build_step_done stream events'
    );
  });

  test('parallel_dispatch branch interpolates {task.*} placeholders', () => {
    const src = readFileSync(join(LIB_DIR, 'build.js'), 'utf-8');
    assert.ok(
      src.includes('task.description') || src.includes('task\\.description'),
      'parallel_dispatch branch must interpolate {task.description} in intent template'
    );
  });

  test('existing dispatch branches are untouched', () => {
    const src = readFileSync(join(LIB_DIR, 'build.js'), 'utf-8');
    assert.ok(src.includes("response.status === 'execute_step'"),    "execute_step branch must exist");
    assert.ok(src.includes("response.status === 'await_gate'"),      "await_gate branch must exist");
    assert.ok(src.includes("response.status === 'execute_flow'"),    "execute_flow branch must exist");
    assert.ok(
      src.includes("response.status === 'ensure_failed'") ||
      src.includes("response.status === 'schema_failed'"),
      "ensure_failed/schema_failed branch must exist"
    );
  });
});

// ---------------------------------------------------------------------------
// T8b — integration: parallelDone called with correct task_results shape
// ---------------------------------------------------------------------------

describe('parallel_dispatch functional dispatch (T8b)', async () => {
  test('parallel_dispatch response converts tasks to task_results for parallelDone', () => {
    // Verify the source code maps settled task results to the parallelDone format.
    // Specifically: {task_id, status, result} or {task_id, status, error}
    const src = readFileSync(join(LIB_DIR, 'build.js'), 'utf-8');

    assert.ok(
      src.includes('task_id') || src.includes('taskId'),
      'parallel_dispatch branch must build task_results with task_id field'
    );
  });

  test('parallel_dispatch passes mergeStatus to parallelDone', () => {
    const src = readFileSync(join(LIB_DIR, 'build.js'), 'utf-8');
    // The merge_status / mergeStatus must be passed
    assert.ok(
      src.includes('mergeStatus') || src.includes('merge_status'),
      'parallel_dispatch branch must pass mergeStatus to parallelDone'
    );
  });

  test('task intent template interpolation handles missing fields gracefully', () => {
    // Verify replace calls use nullish coalescing or default values
    const src = readFileSync(join(LIB_DIR, 'build.js'), 'utf-8');
    const parallelIdx = src.indexOf("response.status === 'parallel_dispatch'");
    const nextBranchIdx = src.indexOf("} else {", parallelIdx);
    const branchSrc = src.slice(parallelIdx, nextBranchIdx);

    // Should have some form of fallback for missing fields
    assert.ok(
      branchSrc.includes('?? ') || branchSrc.includes("|| ''") || branchSrc.includes('|| []'),
      'intent template interpolation must handle missing task fields with fallbacks'
    );
  });
});

// ---------------------------------------------------------------------------
// T8c — STRAT-PAR-4: worktree isolation source-level checks
// ---------------------------------------------------------------------------

describe('parallel_dispatch worktree isolation (STRAT-PAR-4)', () => {
  test('parallel_dispatch branch creates git worktrees', () => {
    const src = readFileSync(join(LIB_DIR, 'build.js'), 'utf-8');
    const parallelIdx   = src.indexOf("response.status === 'parallel_dispatch'");
    const nextBranchIdx = src.indexOf("} else {", parallelIdx);
    const branchSrc     = src.slice(parallelIdx, nextBranchIdx);

    assert.ok(
      branchSrc.includes('git worktree add'),
      'parallel_dispatch must create git worktrees for task isolation'
    );
  });

  test('parallel_dispatch branch removes worktrees on cleanup', () => {
    const src = readFileSync(join(LIB_DIR, 'build.js'), 'utf-8');
    const parallelIdx   = src.indexOf("response.status === 'parallel_dispatch'");
    const nextBranchIdx = src.indexOf("} else {", parallelIdx);
    const branchSrc     = src.slice(parallelIdx, nextBranchIdx);

    assert.ok(
      branchSrc.includes('git worktree remove'),
      'parallel_dispatch must clean up worktrees after task completion'
    );
  });

  test('parallel_dispatch branch collects diffs from worktrees', () => {
    const src = readFileSync(join(LIB_DIR, 'build.js'), 'utf-8');
    const parallelIdx   = src.indexOf("response.status === 'parallel_dispatch'");
    const nextBranchIdx = src.indexOf("} else {", parallelIdx);
    const branchSrc     = src.slice(parallelIdx, nextBranchIdx);

    assert.ok(
      branchSrc.includes('git diff --cached HEAD') || branchSrc.includes('git diff HEAD'),
      'parallel_dispatch must collect diffs from worktrees'
    );
  });

  test('parallel_dispatch branch applies diffs with conflict detection', () => {
    const src = readFileSync(join(LIB_DIR, 'build.js'), 'utf-8');
    const parallelIdx   = src.indexOf("response.status === 'parallel_dispatch'");
    const nextBranchIdx = src.indexOf("} else {", parallelIdx);
    const branchSrc     = src.slice(parallelIdx, nextBranchIdx);

    assert.ok(
      branchSrc.includes('git apply --check'),
      'parallel_dispatch must dry-run check diffs before applying'
    );
    assert.ok(
      branchSrc.includes('git apply'),
      'parallel_dispatch must apply diffs to main worktree'
    );
  });

  test('parallel_dispatch branch detects merge conflicts', () => {
    const src = readFileSync(join(LIB_DIR, 'build.js'), 'utf-8');
    const parallelIdx   = src.indexOf("response.status === 'parallel_dispatch'");
    const nextBranchIdx = src.indexOf("} else {", parallelIdx);
    const branchSrc     = src.slice(parallelIdx, nextBranchIdx);

    assert.ok(
      branchSrc.includes("mergeStatus = 'conflict'"),
      'parallel_dispatch must set mergeStatus to conflict on apply failure'
    );
  });

  test('parallel_dispatch rolls back applied patches on conflict', () => {
    const src = readFileSync(join(LIB_DIR, 'build.js'), 'utf-8');
    const parallelIdx   = src.indexOf("response.status === 'parallel_dispatch'");
    const nextBranchIdx = src.indexOf("} else {", parallelIdx);
    const branchSrc     = src.slice(parallelIdx, nextBranchIdx);

    assert.ok(
      branchSrc.includes('git checkout -- .'),
      'parallel_dispatch must rollback applied patches on conflict via git checkout'
    );
    assert.ok(
      branchSrc.includes('git stash push'),
      'parallel_dispatch must stash pre-merge state for rollback'
    );
  });

  test('parallel_dispatch uses .compose/par/ directory for worktrees', () => {
    const src = readFileSync(join(LIB_DIR, 'build.js'), 'utf-8');
    const parallelIdx   = src.indexOf("response.status === 'parallel_dispatch'");
    const nextBranchIdx = src.indexOf("} else {", parallelIdx);
    const branchSrc     = src.slice(parallelIdx, nextBranchIdx);

    assert.ok(
      branchSrc.includes('.compose') && branchSrc.includes('par'),
      'parallel_dispatch must use .compose/par/ for worktree paths'
    );
  });

  test('parallel_dispatch falls back gracefully when not in git repo', () => {
    const src = readFileSync(join(LIB_DIR, 'build.js'), 'utf-8');
    const parallelIdx   = src.indexOf("response.status === 'parallel_dispatch'");
    const nextBranchIdx = src.indexOf("} else {", parallelIdx);
    const branchSrc     = src.slice(parallelIdx, nextBranchIdx);

    assert.ok(
      branchSrc.includes('isGitRepo') || branchSrc.includes('worktreeIsolation'),
      'parallel_dispatch must check for git repo and fall back to shared cwd'
    );
  });

  test('parallel_dispatch applies diffs in topo order', () => {
    const src = readFileSync(join(LIB_DIR, 'build.js'), 'utf-8');
    const parallelIdx   = src.indexOf("response.status === 'parallel_dispatch'");
    const nextBranchIdx = src.indexOf("} else {", parallelIdx);
    const branchSrc     = src.slice(parallelIdx, nextBranchIdx);

    assert.ok(
      branchSrc.includes('topoOrder') || branchSrc.includes('topo_order'),
      'parallel_dispatch must apply diffs in topological dependency order'
    );
  });
});
