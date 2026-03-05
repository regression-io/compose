/**
 * stratum-client.js — Single adapter for all stratum-mcp subprocess calls.
 *
 * This is the ONLY module in compose that spawns stratum-mcp processes.
 * All query and mutation calls go through the exported functions below.
 * No other file may call execFile/spawn with 'stratum-mcp' as the command.
 *
 * Contract:
 *   - Query calls:   5s timeout, 1 retry on timeout, no retry on error
 *   - Mutation calls: 10s timeout, no retry (mutations are not idempotent to retry)
 *   - Exit 0  → parse stdout as JSON, return result
 *   - Exit 2  → conflict (idempotency), return { conflict: true, ... }
 *   - Non-zero → log stderr internally, return { error: { code, message, detail } }
 *   - stderr is NEVER forwarded to callers
 */

import { execFile as _execFileDefault } from 'node:child_process';

const STRATUM_BIN = 'stratum-mcp';

// Injected executor — replaced by tests only. Production code never calls this setter.
let _execFile = _execFileDefault;
export function _testOnly_setExecFile(fn) { _execFile = fn; }
const QUERY_TIMEOUT_MS = 5_000;
const MUTATION_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Core subprocess runner
// ---------------------------------------------------------------------------

/**
 * Spawn stratum-mcp with args. Returns a Promise resolving to { stdout, code }.
 * Rejects only on spawn failure (binary not found).
 *
 * @param {string[]} args
 * @param {number}   timeoutMs
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
function spawnStratum(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const proc = _execFile(STRATUM_BIN, args, { timeout: timeoutMs }, (err, out, err2) => {
      stdout = out || '';
      stderr = err2 || '';
      const code = err?.code === 'ETIMEDOUT' ? -1
        : (typeof err?.code === 'number' ? err.code : 0);
      resolve({ stdout, stderr, code });
    });

    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error(`stratum-mcp not found. Install with: pip install stratum-mcp`));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Run a query command (read-only). Retries once on timeout.
 *
 * @returns {Promise<any>} parsed JSON result, or throws StratumError
 */
async function runQuery(args) {
  let result = await spawnStratum(args, QUERY_TIMEOUT_MS);

  if (result.code === -1) {
    // Retry once on timeout
    result = await spawnStratum(args, QUERY_TIMEOUT_MS);
    if (result.code === -1) {
      return { error: { code: 'TIMEOUT', message: 'stratum-mcp query timed out', detail: '' } };
    }
  }

  if (result.code !== 0) {
    console.error('[stratum-client] query error stderr:', result.stderr);
    try {
      return JSON.parse(result.stdout);
    } catch {
      return { error: { code: 'UNKNOWN', message: 'stratum-mcp query failed', detail: '' } };
    }
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    return { error: { code: 'PARSE_ERROR', message: 'stratum-mcp returned invalid JSON', detail: '' } };
  }
}

/**
 * Run a mutation command (gate approve/reject/revise). No retry.
 *
 * @returns {Promise<any>} parsed JSON result, or { conflict }, or { error }
 */
async function runMutation(args) {
  const result = await spawnStratum(args, MUTATION_TIMEOUT_MS);

  if (result.code === -1) {
    return { error: { code: 'TIMEOUT', message: 'stratum-mcp gate timed out', detail: '' } };
  }

  if (result.code === 2) {
    try {
      return JSON.parse(result.stdout);   // { conflict: true, ... }
    } catch {
      return { conflict: true, detail: '' };
    }
  }

  if (result.code !== 0) {
    console.error('[stratum-client] mutation error stderr:', result.stderr);
    try {
      return JSON.parse(result.stdout);
    } catch {
      return { error: { code: 'UNKNOWN', message: 'stratum-mcp gate failed', detail: '' } };
    }
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    return { error: { code: 'PARSE_ERROR', message: 'stratum-mcp returned invalid JSON', detail: '' } };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** List all persisted flows. @returns {Promise<FlowSummary[]|ErrorResult>} */
export async function queryFlows() {
  return runQuery(['query', 'flows']);
}

/** Full state for a single flow. @returns {Promise<FlowState|ErrorResult>} */
export async function queryFlow(flowId) {
  return runQuery(['query', 'flow', flowId]);
}

/** List all pending gate steps. @returns {Promise<PendingGate[]|ErrorResult>} */
export async function queryGates() {
  return runQuery(['query', 'gates']);
}

/**
 * Approve a gate step. Stratum is the mutation authority.
 * @param {string} flowId
 * @param {string} stepId
 * @param {string} [note]
 * @param {'human'|'agent'|'system'} [resolvedBy]
 * @returns {Promise<GateMutationResult|ConflictResult|ErrorResult>}
 */
export async function gateApprove(flowId, stepId, note = '', resolvedBy = 'human') {
  const args = ['gate', 'approve', flowId, stepId];
  if (note) args.push('--note', note);
  if (resolvedBy !== 'human') args.push('--resolved-by', resolvedBy);
  return runMutation(args);
}

/**
 * Reject (kill) a gate step.
 * @param {string} flowId
 * @param {string} stepId
 * @param {string} [note]
 * @param {'human'|'agent'|'system'} [resolvedBy]
 * @returns {Promise<GateMutationResult|ConflictResult|ErrorResult>}
 */
export async function gateReject(flowId, stepId, note = '', resolvedBy = 'human') {
  const args = ['gate', 'reject', flowId, stepId];
  if (note) args.push('--note', note);
  if (resolvedBy !== 'human') args.push('--resolved-by', resolvedBy);
  return runMutation(args);
}

/**
 * Send a gate step back for revision.
 * @param {string} flowId
 * @param {string} stepId
 * @param {string} [note]
 * @param {'human'|'agent'|'system'} [resolvedBy]
 * @returns {Promise<GateMutationResult|ConflictResult|ErrorResult>}
 */
export async function gateRevise(flowId, stepId, note = '', resolvedBy = 'human') {
  const args = ['gate', 'revise', flowId, stepId];
  if (note) args.push('--note', note);
  if (resolvedBy !== 'human') args.push('--resolved-by', resolvedBy);
  return runMutation(args);
}
