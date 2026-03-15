/**
 * Tests for STRAT-PAR-1 compose-side stubs (now promoted to STRAT-PAR-3 implementation):
 *   Task 11 — parallel_dispatch branch in lib/build.js dispatch loop
 *   Task 12 — parallelDone() method in lib/stratum-mcp-client.js
 *
 * Updated for STRAT-PAR-3: the branch is now fully implemented (no longer a stub).
 * The "throws with actionable message" test is superseded by parallel-dispatch.test.js.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StratumMcpClient } from '../lib/stratum-mcp-client.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const LIB_DIR = join(__dirname, '..', 'lib');

// ---------------------------------------------------------------------------
// Task 11 — parallel_dispatch branch stub in build.js
// ---------------------------------------------------------------------------

describe('build.js — parallel_dispatch branch stub (Task 11)', () => {
  test('build.js dispatch loop contains parallel_dispatch branch before else fallback', () => {
    const src = readFileSync(join(LIB_DIR, 'build.js'), 'utf-8');

    // The branch must exist in the while loop
    assert.ok(
      src.includes("response.status === 'parallel_dispatch'"),
      "build.js must have a branch checking response.status === 'parallel_dispatch'"
    );
  });

  test('parallel_dispatch branch is implemented (does not throw "not yet implemented")', () => {
    // STRAT-PAR-3: stub replaced with Promise.allSettled fan-out.
    // See parallel-dispatch.test.js for full implementation assertions.
    const src = readFileSync(join(LIB_DIR, 'build.js'), 'utf-8');

    assert.ok(
      !src.includes('parallel_dispatch not yet implemented'),
      "build.js parallel_dispatch branch must be implemented — remove the stub throw"
    );
    assert.ok(
      src.includes('Promise.allSettled'),
      "build.js parallel_dispatch branch must use Promise.allSettled for fan-out"
    );
  });

  test('parallel_dispatch branch precedes the else fallback (ordering)', () => {
    const src = readFileSync(join(LIB_DIR, 'build.js'), 'utf-8');

    const parallelIdx = src.indexOf("response.status === 'parallel_dispatch'");
    const elseFallbackIdx = src.indexOf("Unknown dispatch status");

    assert.ok(parallelIdx !== -1, 'parallel_dispatch branch must exist');
    assert.ok(elseFallbackIdx !== -1, 'else fallback must exist');
    assert.ok(
      parallelIdx < elseFallbackIdx,
      'parallel_dispatch branch must come before else fallback in source order'
    );
  });

  test('existing dispatch branches are untouched', () => {
    const src = readFileSync(join(LIB_DIR, 'build.js'), 'utf-8');

    // All four existing branches must still exist
    assert.ok(src.includes("response.status === 'execute_step'"), "execute_step branch must exist");
    assert.ok(src.includes("response.status === 'await_gate'"), "await_gate branch must exist");
    assert.ok(src.includes("response.status === 'execute_flow'"), "execute_flow branch must exist");
    assert.ok(
      src.includes("response.status === 'ensure_failed'") ||
      src.includes("response.status === 'schema_failed'"),
      "ensure_failed/schema_failed branch must exist"
    );
  });
});

// ---------------------------------------------------------------------------
// Task 12 — parallelDone() method stub in stratum-mcp-client.js
// ---------------------------------------------------------------------------

describe('StratumMcpClient.parallelDone() stub (Task 12)', () => {
  test('StratumMcpClient has a parallelDone method', () => {
    const client = new StratumMcpClient();
    assert.strictEqual(
      typeof client.parallelDone,
      'function',
      'StratumMcpClient must have a parallelDone() method'
    );
  });

  test('parallelDone() throws "not connected" when called before connect()', async () => {
    const client = new StratumMcpClient();
    await assert.rejects(
      () => client.parallelDone('flow-id', 'step-id', [], 'clean'),
      /not connected/i,
      'parallelDone() must throw StratumMcpClient not connected before connect()'
    );
  });

  test('parallelDone() is documented with correct JSDoc parameter names', () => {
    const src = readFileSync(join(LIB_DIR, 'stratum-mcp-client.js'), 'utf-8');

    // Verify JSDoc exists for the method
    assert.ok(
      src.includes('parallelDone'),
      'stratum-mcp-client.js must contain parallelDone'
    );
    assert.ok(
      src.includes('stratum_parallel_done'),
      'parallelDone must call stratum_parallel_done tool'
    );
  });

  test('parallelDone() accepts flowId, stepId, taskResults, mergeStatus parameters', () => {
    const src = readFileSync(join(LIB_DIR, 'stratum-mcp-client.js'), 'utf-8');

    // Parameter names in JSDoc and/or implementation
    assert.ok(
      src.includes('taskResults') || src.includes('task_results'),
      'parallelDone must reference task_results/taskResults'
    );
    assert.ok(
      src.includes('mergeStatus') || src.includes('merge_status'),
      'parallelDone must reference merge_status/mergeStatus'
    );
  });

  test('existing StratumMcpClient methods are untouched', () => {
    const client = new StratumMcpClient();

    // All existing methods must still exist
    assert.strictEqual(typeof client.connect, 'function', 'connect() must exist');
    assert.strictEqual(typeof client.close, 'function', 'close() must exist');
    assert.strictEqual(typeof client.plan, 'function', 'plan() must exist');
    assert.strictEqual(typeof client.resume, 'function', 'resume() must exist');
    assert.strictEqual(typeof client.stepDone, 'function', 'stepDone() must exist');
    assert.strictEqual(typeof client.gateResolve, 'function', 'gateResolve() must exist');
    assert.strictEqual(typeof client.skipStep, 'function', 'skipStep() must exist');
    assert.strictEqual(typeof client.audit, 'function', 'audit() must exist');
    assert.strictEqual(typeof client.validate, 'function', 'validate() must exist');
    assert.strictEqual(typeof client.commit, 'function', 'commit() must exist');
    assert.strictEqual(typeof client.revert, 'function', 'revert() must exist');
  });
});
