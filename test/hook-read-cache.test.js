/**
 * Functional tests for the HOOK-CACHE Python hooks.
 *
 * Invokes the Python scripts directly via execSync with crafted JSON stdin.
 * Uses node:test — run with:  node --test test/hook-read-cache.test.js
 *
 * Prerequisites:
 *  - python3 available in PATH
 *  - ~/.claude/hooks/read-cache.py et al. exist
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// ─── helpers ────────────────────────────────────────────────────────────────

const HOOKS_DIR = join(homedir(), ".claude", "hooks");
const CACHE_ROOT = join(homedir(), ".claude", "read-cache");

const READ_HOOK = join(HOOKS_DIR, "read-cache.py");
const INVALIDATE_HOOK = join(HOOKS_DIR, "read-cache-invalidate.py");
const COMPACT_HOOK = join(HOOKS_DIR, "read-cache-compact.py");

/**
 * Run a hook with the given JSON payload.
 * Returns { exitCode, stdout, stderr }.
 */
function runHook(scriptPath, payload) {
  const result = spawnSync("python3", [scriptPath], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * Parse JSON from stdout (block responses carry a JSON body).
 */
function parseOutput(stdout) {
  if (!stdout || !stdout.trim()) return null;
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

// ─── test state ─────────────────────────────────────────────────────────────

let tmpFile;
let sessionId;
let agentId;
let sessionCacheDir;

function makePayload(overrides = {}) {
  return {
    tool_name: "Read",
    tool_input: { file_path: tmpFile },
    session_id: sessionId,
    agent_id: agentId,
    ...overrides,
  };
}

function clearSessionCache() {
  if (existsSync(sessionCacheDir)) {
    rmSync(sessionCacheDir, { recursive: true, force: true });
  }
}

// Use a unique session per test run so tests don't cross-contaminate
const RUN_ID = Date.now().toString(36);

// ─── setup / teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  // Fresh temp file and session for every test
  sessionId = `test-session-${RUN_ID}-${Math.random().toString(36).slice(2)}`;
  agentId = "test-agent";
  sessionCacheDir = join(CACHE_ROOT, sessionId, agentId);

  tmpFile = join(tmpdir(), `hook-cache-test-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(tmpFile, "line1\nline2\nline3\n");
});

after(() => {
  // Clean up all test sessions created during this run
  try {
    rmSync(join(CACHE_ROOT, `test-session-${RUN_ID}`), { recursive: true, force: true });
  } catch {}
  try {
    rmSync(tmpFile, { force: true });
  } catch {}
});

// ─── tests ───────────────────────────────────────────────────────────────────

describe("read-cache.py — PreToolUse hook", () => {
  test("first read of a file is allowed (exit 0)", () => {
    const result = runHook(READ_HOOK, makePayload());
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });

  test("second read of unchanged file with same range is blocked (exit 2)", () => {
    runHook(READ_HOOK, makePayload()); // prime cache
    const result = runHook(READ_HOOK, makePayload());
    assert.equal(result.exitCode, 2, `stdout: ${result.stdout}`);
    const body = parseOutput(result.stdout);
    assert.ok(body, "expected JSON on stdout");
    assert.equal(body.decision, "block");
    assert.ok(body.reason.includes("already in context"), `reason: ${body.reason}`);
  });

  test("second read of a file whose mtime changed is allowed", (t) => {
    runHook(READ_HOOK, makePayload()); // prime cache

    // Touch the file to change mtime (sleep 10ms so mtime differs)
    // On macOS stat has 1-second granularity by default; we force it via touch -t
    const future = new Date(Date.now() + 2000);
    const ts = future.toISOString().replace(/[-:T]/g, "").slice(0, 12) + ".00";
    try {
      execSync(`touch -t ${ts} "${tmpFile}"`);
    } catch {
      t.skip("could not change mtime");
      return;
    }

    const result = runHook(READ_HOOK, makePayload());
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });

  test("partial read then full read is allowed (uncovered range)", () => {
    // First: read lines 0-10 (partial)
    runHook(READ_HOOK, makePayload({ tool_input: { file_path: tmpFile, offset: 0, limit: 10 } }));
    // Second: full read — not covered
    const result = runHook(READ_HOOK, makePayload());
    assert.equal(result.exitCode, 0);
  });

  test("full read then partial read within range is blocked", () => {
    // Full read primes [0, MAX]
    runHook(READ_HOOK, makePayload());
    // Partial read within that range must be blocked
    const result = runHook(READ_HOOK, makePayload({ tool_input: { file_path: tmpFile, offset: 5, limit: 10 } }));
    assert.equal(result.exitCode, 2);
  });

  test("non-Read tool is always allowed", () => {
    const result = runHook(READ_HOOK, { tool_name: "Write", tool_input: {}, session_id: sessionId, agent_id: agentId });
    assert.equal(result.exitCode, 0);
  });

  test("missing file is always allowed", () => {
    const result = runHook(READ_HOOK, makePayload({ tool_input: { file_path: "/tmp/does-not-exist-hook-cache-test.txt" } }));
    assert.equal(result.exitCode, 0);
  });

  test("range merge — overlapping intervals are collapsed before storage", () => {
    // Read [0, 50]
    runHook(READ_HOOK, makePayload({ tool_input: { file_path: tmpFile, offset: 0, limit: 50 } }));
    // Read [30, 80] — partially overlapping, should be merged to [0, 80]
    runHook(READ_HOOK, makePayload({ tool_input: { file_path: tmpFile, offset: 30, limit: 50 } }));

    // Now [0, 80] is cached. A read fully within [0, 80] must be blocked.
    const result = runHook(READ_HOOK, makePayload({ tool_input: { file_path: tmpFile, offset: 10, limit: 20 } }));
    assert.equal(result.exitCode, 2, "read within merged range should be blocked");
  });
});

describe("read-cache-invalidate.py — PostToolUse hook", () => {
  test("Edit invalidation clears the cache entry, next read is allowed", () => {
    // Prime cache
    runHook(READ_HOOK, makePayload());
    // Verify it's cached (second read is blocked)
    assert.equal(runHook(READ_HOOK, makePayload()).exitCode, 2);

    // Invalidate via Edit
    const inv = runHook(INVALIDATE_HOOK, {
      tool_name: "Edit",
      tool_input: { file_path: tmpFile },
      session_id: sessionId,
      agent_id: agentId,
    });
    assert.equal(inv.exitCode, 0);

    // Cache cleared — next read must be allowed
    assert.equal(runHook(READ_HOOK, makePayload()).exitCode, 0);
  });

  test("Write invalidation works the same way", () => {
    runHook(READ_HOOK, makePayload());
    assert.equal(runHook(READ_HOOK, makePayload()).exitCode, 2);

    runHook(INVALIDATE_HOOK, {
      tool_name: "Write",
      tool_input: { file_path: tmpFile },
      session_id: sessionId,
      agent_id: agentId,
    });

    assert.equal(runHook(READ_HOOK, makePayload()).exitCode, 0);
  });

  test("MultiEdit invalidation works the same way", () => {
    runHook(READ_HOOK, makePayload());
    assert.equal(runHook(READ_HOOK, makePayload()).exitCode, 2);

    runHook(INVALIDATE_HOOK, {
      tool_name: "MultiEdit",
      tool_input: { file_path: tmpFile },
      session_id: sessionId,
      agent_id: agentId,
    });

    assert.equal(runHook(READ_HOOK, makePayload()).exitCode, 0);
  });

  test("invalidation always exits 0 regardless of whether file is cached", () => {
    const result = runHook(INVALIDATE_HOOK, {
      tool_name: "Write",
      tool_input: { file_path: "/tmp/never-cached-file.txt" },
      session_id: sessionId,
      agent_id: agentId,
    });
    assert.equal(result.exitCode, 0);
  });
});

describe("read-cache-compact.py — PreCompact hook", () => {
  test("PreCompact clears the entire session cache directory", () => {
    // Prime a cache entry
    runHook(READ_HOOK, makePayload());
    assert.ok(existsSync(sessionCacheDir), "session cache dir should exist after read");

    // Compact
    const result = runHook(COMPACT_HOOK, { session_id: sessionId });
    assert.equal(result.exitCode, 0);

    // Session dir should be gone
    assert.ok(!existsSync(join(CACHE_ROOT, sessionId)), "session cache dir should be deleted after compact");
  });

  test("PreCompact is idempotent — exits 0 even when session dir does not exist", () => {
    const result = runHook(COMPACT_HOOK, { session_id: "nonexistent-session-xyz-" + RUN_ID });
    assert.equal(result.exitCode, 0);
  });

  test("after PreCompact, subsequent reads are allowed again", () => {
    runHook(READ_HOOK, makePayload());
    assert.equal(runHook(READ_HOOK, makePayload()).exitCode, 2); // cached

    runHook(COMPACT_HOOK, { session_id: sessionId });

    // Cache gone — must allow
    assert.equal(runHook(READ_HOOK, makePayload()).exitCode, 0);
  });
});
