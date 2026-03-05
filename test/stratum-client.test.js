/**
 * Tests for stratum-client.js — single stratum-mcp adapter.
 *
 * Covers:
 *   - Single spawn module rule (static analysis)
 *   - Exit code → result mapping (0, 2, non-zero, timeout)
 *   - Query retry on timeout
 *   - Gate: approve, reject, revise, conflict, error
 *   - stderr never forwarded to callers
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = `${REPO_ROOT}/server`;

// ---------------------------------------------------------------------------
// Static guard: only stratum-client.js may spawn stratum-mcp
// ---------------------------------------------------------------------------

test('only stratum-client.js references execFile/spawn with stratum-mcp', () => {
  const files = readdirSync(SERVER_DIR).filter(f => f.endsWith('.js'));
  const violations = [];

  for (const file of files) {
    if (file === 'stratum-client.js') continue;
    const src = readFileSync(`${SERVER_DIR}/${file}`, 'utf-8');
    // Match execFile/spawn calls where stratum-mcp is the command (first arg), not just mentioned
    if (/(?:execFile|execFileSync|spawnSync|spawn)\s*\(\s*['"`]stratum-mcp['"`]/.test(src)) {
      violations.push(file);
    }
  }

  assert.deepEqual(violations, [],
    `These files spawn stratum-mcp directly (must go through stratum-client.js): ${violations.join(', ')}`
  );
});

// ---------------------------------------------------------------------------
// Import stratum-client with injection support
// ---------------------------------------------------------------------------

const {
  _testOnly_setExecFile,
  queryFlows, queryFlow, queryGates,
  gateApprove, gateReject, gateRevise,
} = await import(`${SERVER_DIR}/stratum-client.js`);

/**
 * Build a mock execFile that replays the given response sequence.
 * Returns { exec, callCount, lastArgs } where exec is the injected function.
 */
function makeMock(responses) {
  let callCount = 0;
  let lastArgs = [];

  function exec(_bin, args, _opts, callback) {
    const resp = responses[Math.min(callCount, responses.length - 1)];
    callCount++;
    lastArgs = args;

    if (!resp || resp.timeout) {
      const err = new Error('ETIMEDOUT');
      err.code = 'ETIMEDOUT';
      callback(err, '', '');
    } else if (resp.exitCode !== 0) {
      const err = new Error(`exit ${resp.exitCode}`);
      err.code = resp.exitCode;
      callback(err, resp.stdout ?? '', resp.stderr ?? '');
    } else {
      callback(null, resp.stdout ?? '', resp.stderr ?? '');
    }

    return { on: () => {} };
  }

  return { exec, get callCount() { return callCount; }, get lastArgs() { return lastArgs; } };
}

// ---------------------------------------------------------------------------
// Exit code 0 → parsed JSON result
// ---------------------------------------------------------------------------

test('queryFlows: exit 0 returns parsed JSON array', async () => {
  const flows = [{ _schema_version: '1', flow_id: 'abc' }];
  const m = makeMock([{ exitCode: 0, stdout: JSON.stringify(flows) }]);
  _testOnly_setExecFile(m.exec);
  const result = await queryFlows();
  assert.ok(Array.isArray(result));
  assert.equal(result[0].flow_id, 'abc');
});

// ---------------------------------------------------------------------------
// Exit code 2 → conflict result, no error field
// ---------------------------------------------------------------------------

test('gateApprove: exit 2 returns conflict object', async () => {
  const payload = { conflict: true, flow_id: 'abc', step_id: 's1', detail: 'already resolved' };
  const m = makeMock([{ exitCode: 2, stdout: JSON.stringify(payload) }]);
  _testOnly_setExecFile(m.exec);
  const result = await gateApprove('abc', 's1', 'LGTM');
  assert.equal(result.conflict, true);
  assert.ok(!result.error, 'must not have error field on conflict');
});

// ---------------------------------------------------------------------------
// Non-zero exit → structured error, stderr NOT in result
// ---------------------------------------------------------------------------

test('queryFlow: non-zero exit returns error without stderr', async () => {
  const errPayload = { error: { code: 'NOT_FOUND', message: 'Flow not found', detail: '' } };
  const m = makeMock([{ exitCode: 1, stdout: JSON.stringify(errPayload), stderr: 'Traceback (most recent call last)...' }]);
  _testOnly_setExecFile(m.exec);
  const result = await queryFlow('nonexistent');
  assert.equal(result.error.code, 'NOT_FOUND');
  assert.ok(!JSON.stringify(result).includes('Traceback'), 'stderr must not appear in result');
});

// ---------------------------------------------------------------------------
// Timeout: query retries once, mutation does not
// ---------------------------------------------------------------------------

test('queryFlows: retries once on timeout, returns TIMEOUT on second timeout', async () => {
  const m = makeMock([{ timeout: true }, { timeout: true }]);
  _testOnly_setExecFile(m.exec);
  const result = await queryFlows();
  assert.equal(result.error.code, 'TIMEOUT');
  assert.equal(m.callCount, 2, 'query must retry exactly once');
});

test('queryFlows: succeeds on retry after first timeout', async () => {
  const flows = [{ _schema_version: '1', flow_id: 'x' }];
  const m = makeMock([{ timeout: true }, { exitCode: 0, stdout: JSON.stringify(flows) }]);
  _testOnly_setExecFile(m.exec);
  const result = await queryFlows();
  assert.ok(Array.isArray(result));
  assert.equal(result[0].flow_id, 'x');
  assert.equal(m.callCount, 2, 'must have called twice');
});

test('gateApprove: no retry on timeout — exactly one call', async () => {
  const m = makeMock([{ timeout: true }]);
  _testOnly_setExecFile(m.exec);
  const result = await gateApprove('abc', 'step1');
  assert.equal(result.error.code, 'TIMEOUT');
  assert.equal(m.callCount, 1, 'mutation must NOT retry');
});

// ---------------------------------------------------------------------------
// Invalid JSON on success path → PARSE_ERROR (not a throw)
// ---------------------------------------------------------------------------

test('queryFlows: exit 0 with invalid JSON returns PARSE_ERROR', async () => {
  const m = makeMock([{ exitCode: 0, stdout: 'not json' }]);
  _testOnly_setExecFile(m.exec);
  const result = await queryFlows();
  assert.equal(result.error.code, 'PARSE_ERROR');
});

test('gateApprove: exit 0 with invalid JSON returns PARSE_ERROR', async () => {
  const m = makeMock([{ exitCode: 0, stdout: 'bad output' }]);
  _testOnly_setExecFile(m.exec);
  const result = await gateApprove('f1', 's1');
  assert.equal(result.error.code, 'PARSE_ERROR');
});

// ---------------------------------------------------------------------------
// Gate commands pass correct CLI args
// ---------------------------------------------------------------------------

test('gateReject passes correct args including --note', async () => {
  const payload = { _schema_version: '1', ok: true, flow_id: 'f1', step_id: 's1', outcome: 'kill', result: 'killed' };
  const m = makeMock([{ exitCode: 0, stdout: JSON.stringify(payload) }]);
  _testOnly_setExecFile(m.exec);
  await gateReject('f1', 's1', 'not ready');
  assert.deepEqual(m.lastArgs, ['gate', 'reject', 'f1', 's1', '--note', 'not ready']);
});

test('gateRevise passes --resolved-by agent', async () => {
  const payload = { _schema_version: '1', ok: true, flow_id: 'f1', step_id: 's1', outcome: 'revise', result: 'execute_step' };
  const m = makeMock([{ exitCode: 0, stdout: JSON.stringify(payload) }]);
  _testOnly_setExecFile(m.exec);
  await gateRevise('f1', 's1', '', 'agent');
  assert.ok(m.lastArgs.includes('--resolved-by'));
  assert.ok(m.lastArgs.includes('agent'));
});

test('gateApprove omits --resolved-by when default human', async () => {
  const m = makeMock([{ exitCode: 0, stdout: JSON.stringify({ ok: true }) }]);
  _testOnly_setExecFile(m.exec);
  await gateApprove('f1', 's1');
  assert.ok(!m.lastArgs.includes('--resolved-by'), 'must not pass --resolved-by for default human');
});
