# Implementation Plan: Agent Stream Bridge (STRAT-COMP-7)

**Feature:** Bridge CLI build events to the web UI's agent stream via JSONL file transport
**Status:** Plan
**Date:** 2026-03-13

---

## Related Documents

- [STRAT-COMP-7 design](design.md)
- [STRAT-COMP-7 blueprint](blueprint.md)

JSONL schema authority: STRAT-COMP-7 owns the `.compose/build-stream.jsonl` contract. Upstream plans should reference this schema instead of redefining it.

---

## Prerequisites (blocking -- must be done before implementation)

- [ ] **STRAT-COMP-4 reconciliation:** Update `docs/features/STRAT-COMP-4/design.md` lines 172-183 and 190-200 to reference this document (STRAT-COMP-7) as the authoritative source for the `.compose/build-stream.jsonl` schema. Remove or supersede the `event`-keyed schema definitions and the "frontend unchanged" claim. The authoritative schema uses `type`-keyed records with event names: `build_start`, `build_step_start`, `tool_use`, `assistant`, `build_step_done`, `build_gate`, `build_gate_resolved`, `build_error`, `build_end`.
- [ ] **Companion doc alignment:** Update `blueprint.md` and verify `plan.md` alignment to reflect the design changes made during review (build_error ownership in build.js only, expanded AgentStream.jsx surface, per-source status tracking, CATEGORY_LABELS addition, reconnect reset).

---

## Task 1: Create BuildStreamWriter

**Files:** `lib/build-stream-writer.js` (new)
**Depends on:** --

**Acceptance criteria:**

- [ ] Exports `BuildStreamWriter` class with `constructor(composeDir, featureCode)`, `write(event)`, `close(status)`, `get filePath()`
- [ ] Constructor calls `mkdirSync(composeDir, { recursive: true })` and unlinks any existing `build-stream.jsonl`
- [ ] `write()` appends a JSON line with auto-incremented `_seq` and `_ts: Date.now()` fields
- [ ] `close(status)` writes a `build_end` sentinel with `status` and `featureCode`, defaults to `'complete'`
- [ ] `close()` is idempotent -- tracks `#closed` flag, calling multiple times writes exactly one `build_end`
- [ ] Uses sync I/O (`appendFileSync`) -- intentional per design

---

## Task 2: Test BuildStreamWriter

**Files:** `test/build-stream-writer.test.js` (new)
**Depends on:** Task 1

**Acceptance criteria:**

- [ ] Test: creates `.compose/build-stream.jsonl` in a temp directory
- [ ] Test: appends JSONL lines with monotonically increasing `_seq` and valid `_ts`
- [ ] Test: re-constructing truncates the existing file (fresh start per build)
- [ ] Test: `close()` writes a `build_end` event with the correct `status` and `featureCode`
- [ ] Test: `close()` is idempotent -- calling twice writes exactly one `build_end`
- [ ] All tests pass with `node --test`

---

## Task 3: Instrument result-normalizer.js

**Files:** `lib/result-normalizer.js` (existing)
**Depends on:** Task 1

**Acceptance criteria:**

- [ ] `runAndNormalize()` accepts `streamWriter` in `opts`
- [ ] Forwards `tool_use` events to writer as `{ type: 'tool_use', tool, input }`
- [ ] Forwards `assistant` text events to writer as `{ type: 'assistant', content }`
- [ ] Does NOT forward `error` events (errors are written by `build.js` catch blocks, not by the normalizer -- per authoritative design)
- [ ] Does NOT forward `tool_progress`, `tool_use_summary`, `result`, or `system` events (per design: skip noisy events at writer)
- [ ] When `streamWriter` is not provided, behavior is unchanged (no regressions)

---

## Task 4: Instrument build.js -- main dispatch loop

**Files:** `lib/build.js` (existing), `lib/build-stream-writer.js` (existing)
**Depends on:** Task 1, Task 3
**Schema reference:** JSONL event fields per `design.md` Section 4 (Event Schema) table. Call site table per `design.md` Section 3.1.

**Acceptance criteria:**

- [ ] Imports `BuildStreamWriter` from `./build-stream-writer.js`
- [ ] Instantiates writer AFTER Stratum plan/resume succeeds (not at `runBuild()` entry), to prevent a rejected/duplicate invocation from truncating an active build's stream
- [ ] Writes `build_start` event immediately after writer creation (with `featureCode`, `flowId`, `specPath`)
- [ ] Registers SIGINT/SIGTERM handlers after writer creation: handlers set `buildStatus = 'killed'` and throw `BuildKilledError` to unwind the stack naturally
- [ ] Writes `build_step_start` before each connector dispatch (with `stepId`, `stepNum`, `totalSteps`, `agent`, `intent`, `flowId`) — `intent` from pipeline spec, needed by STRAT-COMP-8 AuditTrail; `null` for gate steps
- [ ] Passes `streamWriter` to `runAndNormalize()` in the main-loop `execute_step` call site
- [ ] Passes `streamWriter` to `runAndNormalize()` in the `ensure_failed`/`schema_failed` retry call site (shared branch at `build.js` line ~269)
- [ ] Writes `build_step_done` after `stratum.stepDone()` returns (with `stepId`, `summary`, `retries`, `violations`, `flowId`) — `retries` is the step's retry count; `violations` is `string[]` of violation messages accumulated during retries; needed by STRAT-COMP-8 AuditTrail per-step breakdown
- [ ] Writes `build_gate` in `await_gate` branch (with `stepId`, `flowId`, `gateType`)
- [ ] Writes `build_gate_resolved` after gate resolution (with `stepId`, `outcome`, `rationale`, `flowId`)
- [ ] Writes `build_error` at two catch points in `build.js`: (1) try/catch around `runAndNormalize()` for connector errors, and (2) try/catch around post-dispatch operations (`stratum.stepDone()`, `promptGate()`, `stratum.gateResolve()`) for infrastructure errors. Both include `message` and `stepId`.
- [ ] Calls `streamWriter.close(buildStatus)` in the `finally` block with appropriate status (`complete`/`killed`/`aborted`)
- [ ] `close()` is idempotent — signal-handler + finally double-calls write exactly one `build_end` event
- [ ] Removes signal listeners via `process.removeListener()` in the `finally` block
- [ ] **External abort limitation:** `compose build --abort` deletes Stratum state; the running build will fail on its next Stratum API call and produce `build_end(aborted)`. However, if the build hangs inside a long-running `runAndNormalize()` call, the abort is not observed until that call completes. `build_end(aborted)` is best-effort for the external abort path. For guaranteed termination, SIGINT/SIGTERM should be sent directly. This is a known limitation, not specific to this feature.

---

## Task 5: Instrument build.js -- child flows

**Files:** `lib/build.js` (existing)
**Depends on:** Task 4

**Acceptance criteria:**

- [ ] `executeChildFlow()` accepts `streamWriter` and `parentFlowId` parameters
- [ ] Passes `streamWriter` to `runAndNormalize()` in child flow `execute_step` call site
- [ ] Passes `streamWriter` to `runAndNormalize()` in child flow `ensure_failed`/`schema_failed` fix pass call site (line ~444)
- [ ] Passes `streamWriter` to `runAndNormalize()` in child flow `ensure_failed`/`schema_failed` retry call site (line ~453)
- [ ] Writes `build_step_start` for child flow steps with full field set: `stepId`, `stepNum`, `totalSteps`, `agent`, `flowId` (child's), `parentFlowId` (parent's)
- [ ] Writes `build_step_done` for child flow steps with: `stepId`, `summary`, `flowId` (child's), `parentFlowId` (parent's)
- [ ] Writes `build_gate` for child flow gates with: `stepId`, `gateType`, `flowId` (child's), `parentFlowId` (parent's)
- [ ] Writes `build_gate_resolved` for child flow gate resolutions with: `stepId`, `outcome`, `rationale`, `flowId` (child's), `parentFlowId` (parent's)
- [ ] Writes `build_error` in child flow catch points (connector and infrastructure errors) with `message` and `stepId`
- [ ] All callers of `executeChildFlow()` pass `streamWriter` and the parent's `flowId`

---

## Task 6: Integration test for JSONL output

**Files:** `test/build-stream-writer-integration.test.js` (new)
**Depends on:** Task 4, Task 5

**Acceptance criteria:**

- [ ] Runs a mock build (with `connectorFactory` override) executing 2 steps and 1 gate
- [ ] Verifies JSONL file contains events in correct order: `build_start` -> `build_step_start` -> tool/assistant events -> `build_step_done` -> `build_gate` -> `build_gate_resolved` -> `build_step_start` -> ... -> `build_step_done` -> `build_end`
- [ ] Verifies all events have monotonically increasing `_seq`
- [ ] Verifies all events have `_ts` within the build duration window
- [ ] Verifies SIGINT/SIGTERM produces `build_end(killed)` in the JSONL file and signal handlers are removed afterward
- [ ] Verifies duplicate/rejected build invocation (Stratum plan/resume fails) does not truncate an active JSONL file (writer created only after plan/resume succeeds)
- [ ] Verifies `build_error` is emitted from `build.js` catch points (connector error and infrastructure error) with `message` and `stepId` fields
- [ ] **Full-path coverage note:** This test verifies the `build.js` -> `BuildStreamWriter` -> JSONL file path. Combined with Task 13 (JSONL -> `BuildStreamBridge` -> SSE), these two tests together cover the complete `build.js` -> JSONL -> bridge -> SSE pipeline without requiring a monolithic end-to-end test.

---

## Task 7: Create BuildStreamBridge

**Files:** `server/build-stream-bridge.js` (new)
**Depends on:** --

**Acceptance criteria:**

- [ ] Exports `BuildStreamBridge` class with `constructor(composeDir, broadcast, opts?)`, `start()`, `stop()`
- [ ] Constructor accepts `opts.crashTimeoutMs` (default 300000 / 5 min) for configurable crash detection
- [ ] Reads file as `Buffer` and tracks `#cursor` as byte offset (per design)
- [ ] Uses `fs.watch` on parent directory, filters for `build-stream.jsonl` filename
- [ ] Deduplicates events using monotonic `#lastSeq` guard
- [ ] Detects file replacement via inode change (`stat.ino !== #lastIno`) and resets `#cursor` to 0 and `#lastSeq` to -1
- [ ] Implements size-based cursor reset as secondary fallback (`stat.size < #cursor` without inode change)
- [ ] Falls back to 2s polling via `setInterval().unref()` if directory does not exist, with `#polling` guard against re-entrancy
- [ ] Implements 50ms debounce on `_readNewLines()` calls via `_debouncedRead()`
- [ ] `_readNewLines()` buffers incomplete trailing lines (`#trailingFragment`) to prevent partial-write data loss
- [ ] Catches up from byte 0 on startup if file already exists AND is fresh (active build)
- [ ] **Stale-file detection on startup:** skips replay if last line is `build_end` (completed/killed/aborted), OR (last line is NOT `build_gate` AND file mtime exceeds crash timeout — crashed build with no sentinel), OR (last line is `build_gate` AND file mtime exceeds 24h — stale gate), OR (last line is malformed AND file mtime exceeds crash timeout). Gate-pending files are explicitly excluded from the generic crash-timeout check because gates have unbounded human wait times. Stale files set cursor to EOF.
- [ ] **Crash detection:** tracks `#buildActive` (between `build_start` and `build_end`) and `#inStep` (between `build_step_start` and `build_step_done`/`build_gate`). Crash timer runs ONLY when `#inStep` is true — not during gates or between steps.
- [ ] After configurable inactivity timeout during `#inStep`, emits synthetic `{ type: "system", subtype: "build_end", status: "crashed", _source: "build" }` and sets `#lastSeq = Infinity` to suppress late events from the dead build
- [ ] `stop()` clears all timers/intervals: `#watcher`, `#pollInterval`, `#debounceTimer`, `#crashTimer`

---

## Task 8: Implement event mapping in bridge

**Files:** `server/build-stream-bridge.js` (existing from Task 7)
**Depends on:** Task 7

**Schema reference:** Use JSONL event types and SSE message shapes from `design.md` Section 4 (Event Schema) and Section 3.3 (event mapping table). The shapes listed below are summaries for quick reference; the design doc is authoritative.

**Acceptance criteria:**

- [ ] `_mapEvent()` maps `build_start` to `{ type: "system", subtype: "build_start", featureCode, flowId, _source: "build" }`
- [ ] Maps `build_step_start` to `{ type: "system", subtype: "build_step", stepId, stepNum, totalSteps, agent, intent, flowId, parentFlowId?, _source: "build" }` (parentFlowId present only for child flow steps; `intent` from pipeline spec, null for gate steps)
- [ ] Maps `tool_use` to `{ type: "assistant", message: { content: [{ type: "tool_use", name, input }] }, _source: "build" }`
- [ ] Maps `assistant` to `{ type: "assistant", message: { content: [{ type: "text", text }] }, _source: "build" }`
- [ ] Maps `build_step_done` to `{ type: "system", subtype: "build_step_done", stepId, summary, retries, violations, flowId, parentFlowId?, _source: "build" }` (`retries`: number, `violations`: string[] — per-step counts for STRAT-COMP-8 AuditTrail)
- [ ] Maps `build_gate` to `{ type: "system", subtype: "build_gate", stepId, gateType, flowId, parentFlowId?, _source: "build" }`
- [ ] Maps `build_gate_resolved` to `{ type: "system", subtype: "build_gate_resolved", stepId, outcome, rationale, flowId, parentFlowId?, _source: "build" }`
- [ ] Maps `build_error` to `{ type: "error", message, source: "build", _source: "build" }`
- [ ] Maps `build_end` to `{ type: "system", subtype: "build_end", status, featureCode, _source: "build" }`
- [ ] `_mapEvent()` tracks build lifecycle state (`#buildActive`, `#inStep`) for crash timer management
- [ ] All mapped events carry `_source: "build"`
- [ ] All structural events (`build_start`, `build_step`, `build_step_done`, `build_gate`, `build_gate_resolved`) preserve `flowId` (and `parentFlowId` where present) for STRAT-COMP-8 hierarchy reconstruction

---

## Task 9: Test BuildStreamBridge

**Files:** `test/build-stream-bridge.test.js` (new)
**Depends on:** Task 7, Task 8

**Acceptance criteria:**

- [ ] Test: writes JSONL lines to a temp file, verifies `broadcast()` called with correctly mapped SSE shapes
- [ ] Test: dedup -- writing same `_seq` twice results in only one broadcast
- [ ] Test: cursor reset on file replacement (inode change) -- bridge reads all new events from byte 0
- [ ] Test: cursor reset on file truncation (size < cursor) -- secondary fallback
- [ ] Test: catch-up from existing file on `start()` (fresh/active file)
- [ ] Test: stale-file detection -- file with `build_end` last line is skipped on startup
- [ ] Test: `build_error` mapping -- bridge maps `build_error` to `{ type: "error", message, source: "build", _source: "build" }` correctly
- [ ] Test: incomplete-line buffering -- partial writes are held until newline arrives
- [ ] Test: malformed JSON lines are skipped without error
- [ ] Test: crash detection -- synthetic `build_end(crashed)` emitted after timeout during `#inStep`
- [ ] Test: crash timer reset -- ongoing `tool_use`/`assistant` events during an active step reset the inactivity timer, preventing false `build_end(crashed)`
- [ ] Test: crash suppression -- late events after synthetic crash are suppressed via `#lastSeq = Infinity`
- [ ] Test: no mapped event produces `type: "system", subtype: "init"` -- bridge never emits `system/init` (session-ID safety invariant from design Section 3.3)
- [ ] All tests pass with `node --test`

---

## Task 10: Integrate bridge into agent-server.js

**Files:** `server/agent-server.js` (existing)
**Depends on:** Task 7, Task 8

**Acceptance criteria:**

- [ ] Imports `BuildStreamBridge` from `./build-stream-bridge.js`
- [ ] Instantiates bridge after `server.listen()` with `path.join(TARGET_ROOT, '.compose')` and `broadcast`
- [ ] Calls `bridge.start()` after instantiation
- [ ] Calls `bridge.stop()` in `shutdown()` before `server.close()`
- [ ] No changes to `_consumeStream`, `broadcast`, `_session`, or SSE/session logic

---

## Task 11: Extend AgentStream.jsx -- deriveStatus() and per-source status tracking

**Files:** `src/components/AgentStream.jsx` (existing)
**Depends on:** --

**Acceptance criteria:**

**deriveStatus() additions:** (Note: `build_start` is intentionally omitted -- it is rendered by MessageCard but does not need a `deriveStatus` entry because `build_step` immediately follows and sets the working status.)
- [ ] Returns `{ status: 'working', tool: null, category: 'thinking', _source: 'build' }` for `build_step` subtype
- [ ] Returns `{ status: 'working', tool: null, category: 'thinking', _source: 'build' }` for `build_step_done` subtype (still working, next step coming)
- [ ] Returns `{ status: 'working', tool: null, category: 'waiting', _source: 'build' }` for `build_gate` subtype
- [ ] Returns `{ status: 'working', tool: null, category: 'thinking', _source: 'build' }` for `build_gate_resolved` subtype
- [ ] Returns `{ status: 'working', tool: null, category: 'thinking', _source: 'build' }` for `build_error` (`msg.type === 'error' && msg.source === 'build'`)
- [ ] Returns `{ status: 'idle', tool: null, category: null, _source: 'build' }` for `build_end` subtype
- [ ] Build content events (`msg._source === 'build' && msg.type === 'assistant'`) derive tool_use/thinking status with `_source: 'build'`
- [ ] Adds `waiting: "Waiting for gate approval"` to `CATEGORY_LABELS`

**Per-source status tracking in processMessage():**
- [ ] Adds `_state.sourceStatus = { build: null, interactive: null }` to module-level state
- [ ] `processMessage()` stores derived status per source in `_state.sourceStatus[source]`
- [ ] Status merge: shows `working` if ANY source is working (priority: interactive > build)
- [ ] Shows `idle` only when ALL sources are idle
- [ ] Preserves existing idle debounce (`IDLE_DEBOUNCE_MS`) in the merged logic
- [ ] Calls `setAgentStatus(status, tool, category)` with positional args (unchanged signature)

**Reconnect handling:**
- [ ] Resets `_state.sourceStatus.build` to `null` in `es.onopen` handler to clear stale build-working state after reconnect

---

## Task 12: Add build event renderers to MessageCard.jsx

**Files:** `src/components/agent/MessageCard.jsx` (existing)
**Depends on:** --

**Acceptance criteria:**

- [ ] Renders `build_start` as feature code header (accent color, uppercase, 10px)
- [ ] Renders `build_step` as step progress indicator with `stepNum/totalSteps`, `stepId`, `agent`
- [ ] Renders `build_step_done` as green step completion marker
- [ ] Renders `build_gate` as amber gate notification with `stepId`
- [ ] Renders `build_gate_resolved` as gate outcome indicator: `approve`=green, `revise`=amber, `kill`=red (matching gate-prompt.js vocabulary)
- [ ] Renders `build_end` as build status indicator: `complete`=green, `killed`/`aborted`/`crashed`=red
- [ ] All new branches inserted after `system/connected` handler, before `assistant` check
- [ ] Uses existing style patterns (text-[10px], uppercase, tracking-wider)

---

## Task 13: Bridge-to-SSE smoke test

**Files:** `test/build-stream-smoke.test.js` (new)
**Depends on:** Task 10

**Acceptance criteria:**

- [ ] Starts agent-server programmatically
- [ ] Connects to `GET /api/agent/stream` SSE endpoint FIRST (live-only v1 success path)
- [ ] THEN writes JSONL events to `.compose/build-stream.jsonl` (simulating BuildStreamWriter output)
- [ ] Verifies SSE messages arrive with correct shapes and `_source: "build"`
- [ ] Verifies `build_start`, `build_step`, `tool_use`, `build_step_done`, `build_end` all arrive in order
- [ ] Verifies live-only behavior: an SSE client connecting AFTER build events have been processed does NOT receive replayed history (feature provides live-only visibility per design)
- [ ] Verifies SSE reconnect behavior: disconnect and reconnect an SSE client during a build, verify that new events are received after reconnect and no stale events from before the disconnect are replayed
- [ ] Verifies reconnect status reset: after SSE reconnect, emit a `build_end` event and verify the client receives it correctly (validates the server-side path; client-side `_state.sourceStatus.build` reset in `es.onopen` is tested in Task 15 via the extracted helper's status-merge function being called with `null` build status after reconnect)
- [ ] Note: this is a bridge/SSE integration test, not a full end-to-end test through `build.js`. Full-path verification through `compose build` is covered by Task 6's integration test (writer side) combined with this test (bridge side).

---

## Task 14: Edge case hardening

**Files:** `test/build-stream-bridge.test.js` (existing from Task 9)
**Depends on:** Task 9, Task 13

**Acceptance criteria:**

- [ ] Test: build starts before server -- bridge catches up from byte 0
- [ ] Test: file replacement where new file is larger than old cursor -- inode-based detection resets correctly
- [ ] Test: directory creation after server start -- poll fallback detects directory and starts watching
- [ ] Test: concurrent build + interactive session -- `_source` field correctly discriminates events
- [ ] Test: build crash (no `build_end` sentinel) during active step -- bridge emits synthetic `build_end(crashed)` after crash timeout, then suppresses late events via `#lastSeq = Infinity`
- [ ] Test: crash timer does NOT fire during gate wait (only during `#inStep`)
- [ ] Test: stale file on startup -- last line is `build_end` sentinel, bridge skips replay
- [ ] Test: stale gate on startup -- `build_gate` last line with mtime > 24h, bridge skips replay
- [ ] Test: fresh gate on startup -- `build_gate` last line with mtime < 24h, bridge replays from byte 0
- [ ] Test: malformed last line on startup -- old file with malformed last line, bridge checks mtime and skips if stale
- [ ] Test: stale no-sentinel non-gate file on startup -- file with last event being `build_step_start` (or similar non-terminal, non-gate event) and mtime exceeding crash timeout is treated as stale and skipped
- [ ] Test: child-flow hierarchy metadata -- `build_step_start`, `build_step_done`, `build_gate`, and `build_gate_resolved` events from child flows carry `flowId` (child's) and `parentFlowId` (parent's) through JSONL write and bridge mapping

---

## Task 15: AgentStream build-status logic tests

**Files:** `src/components/agent-stream-helpers.js` (new), `test/agent-stream-build.test.js` (new), `src/components/AgentStream.jsx` (existing)
**Depends on:** Task 11

**Prerequisite:** The repo uses `node --test` with no JSX/jsdom harness. `deriveStatus()`, the per-source status merge logic, and the `CATEGORY_LABELS` map must be extracted from `AgentStream.jsx` into a pure `.js` module (`src/components/agent-stream-helpers.js`) so they can be tested without JSX. `AgentStream.jsx` re-imports them.

**Acceptance criteria:**

- [ ] Extract `deriveStatus()`, `CATEGORY_LABELS`, and the per-source status merge function into `src/components/agent-stream-helpers.js` (pure JS, no JSX)
- [ ] `AgentStream.jsx` imports and uses the extracted helpers (no behavior change)
- [ ] Test: per-source status merge -- build idle does not clear interactive working, interactive idle does not clear build working, both idle produces idle
- [ ] Test: `deriveStatus()` returns correct `_source: 'build'` and categories for all build subtypes (including `build_error` returning `working` status)
- [ ] Test: `deriveStatus()` never returns a result that would trigger `system/init` handling for any build event type (session-ID safety invariant)
- [ ] **Known test gap (requires jsdom harness):** Full component-level tests for `es.onopen` reconnect-reset of `_state.sourceStatus.build`, `handleSend()` create-vs-resume branching with build-only message lists, and `isFirstMessage` predicate behavior are deferred because the repo has no browser/jsdom test environment. The design's automated verification requirements for these behaviors (design.md lines 788, 792) cannot be satisfied without adding frontend test infrastructure. **Mitigation:** (a) The `system/init` safety invariant is verified at the bridge mapping level in Task 9 (no mapped build event produces `system/init`). (b) The extracted helper tests verify status-merge and deriveStatus logic. (c) Task 13's SSE reconnect test verifies server-side reconnect behavior. (d) The remaining gap is the single `es.onopen` assignment and `handleSend()` branching, which are verified by code review.
- [ ] Test: concurrent build + interactive session -- build events do not disrupt interactive session status (combined status merge path)
- [ ] All tests pass with `node --test`

**Reconnect-reset verification:**
- [ ] Test: reconnect status reset -- calling the extracted status-merge function with `sourceStatus.build = null` (simulating `es.onopen` reset) while `sourceStatus.interactive` is working returns working; with both null returns idle. This verifies the merge logic handles the reconnect reset correctly.
- [ ] The actual `es.onopen` handler that sets `sourceStatus.build = null` remains in `AgentStream.jsx`. It is verified by: (a) Task 13's SSE reconnect test (server-side behavior), (b) the merge-function test above (logic correctness), and (c) code review of the single-line assignment in `es.onopen`. Full component-level testing is deferred until a jsdom harness exists.

---

## Execution Order

```
Task 1 (BuildStreamWriter)
  |
  +-- Task 2 (unit test)
  |
  +-- Task 3 (result-normalizer instrumentation)
  |     |
  |     +-- Task 4 (build.js main loop)
  |           |
  |           +-- Task 5 (build.js child flows)
  |                 |
  |                 +-- Task 6 (integration test)
  |
Task 7 (BuildStreamBridge) ----+
  |                            |
  +-- Task 8 (event mapping)   |
        |                      |
        +-- Task 9 (unit test) |
        |                      |
        +-- Task 10 (agent-server integration)
              |
              +-- Task 13 (bridge/SSE smoke test)
                    |
                    +-- Task 14 (bridge edge case hardening)

Task 11 (AgentStream.jsx) -----+
  |                            |
  +-- Task 15 (AgentStream behavioral tests)

Task 12 (MessageCard.jsx) -----+
```

Tasks 1-6 (CLI side) and Tasks 7-12 (server/frontend side) can be executed in parallel. Tasks 11 and 12 have no backend dependencies and can start immediately. Task 15 depends on Task 11 (helper extraction must exist before tests can be written). Task 13 requires Task 10 (server integration). Task 14 extends Task 9's test file with bridge edge cases.
