# Blueprint: Agent Stream Bridge (STRAT-COMP-7)

**Feature:** Bridge CLI build events to the web UI's agent stream via JSONL file transport
**Status:** Blueprint
**Date:** 2026-03-12

---

## Related Documents

- [STRAT-COMP-7 design](design.md) -- this blueprint's source design
- [STRAT-COMP-5 design](../STRAT-COMP-5/design.md) -- Build Visibility (prerequisite, file watcher infrastructure)
- [STRAT-COMP-8 design](../STRAT-COMP-8/design.md) -- Active Build Dashboard (downstream consumer of build events)

---

## Corrections Table

Verified all design claims against source code on 2026-03-12.

| # | Design claim | Actual source | Status | Impact |
|---|---|---|---|---|
| C1 | "broadcast(msg) sends JSON via SSE to all `_sseClients`" | `agent-server.js:55-64` -- `broadcast()` writes `data: ${JSON.stringify(msg)}\n\n` to each client in `_sseClients` Set | Correct | None |
| C2 | "`_consumeStream(q)` iterates SDK async iterator, captures `system/init` session_id" | `agent-server.js:184-203` -- `for await (const msg of q)`, captures `msg.session_id` when `msg.type === 'system' && msg.subtype === 'init'` at line 188-189 | Correct | None |
| C3 | "Single session model: `_session = { id, queryIter }`" | `agent-server.js:50` -- `let _session = { id: null, queryIter: null }` | Correct | None |
| C4 | "No awareness of build events or JSONL files" | `agent-server.js` -- no imports or references to build, JSONL, or `.compose/` | Correct | None |
| C5 | "AgentStream.jsx:141 captures session_id from system/init" | `AgentStream.jsx:141-144` -- `if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id)` sets `_state.sessionId` and writes to `sessionStorage` | Correct | None |
| C6 | "Module-level singleton `_state` survives HMR" | `AgentStream.jsx:42-60` -- `const _state = { es: null, ... }` at module scope | Correct | None |
| C7 | "processMessage() skips stream_event, tool_progress, tool_use_summary" | `AgentStream.jsx:147-149` -- `if (msg.type === 'stream_event' || msg.type === 'tool_progress' || msg.type === 'tool_use_summary') return;` | Correct | Design says build `tool_use` and `assistant` events pass through unchanged -- true, but `tool_progress` and `tool_use_summary` are dropped. Writer should skip these. |
| C8 | "deriveStatus() returns null for unknown system subtypes" | `AgentStream.jsx:66-84` -- function checks `msg.type === 'assistant'` and `msg.type === 'result'`, returns `null` for everything else | Correct | Build system subtypes (`build_step`, `build_end`) need explicit handling, as design proposes |
| C9 | "MessageCard.jsx has no handler for compact_boundary" | `MessageCard.jsx:183-231` -- dispatcher checks `system/init`, `system/connected`, `assistant`, `user`, `result`, `error`; all other types return `null` at line 230 | Correct | Confirms compact_boundary would be invisible; new subtypes needed |
| C10 | "isFirstMessage check (line 265) uses subtype === 'init' or 'connected'" | `AgentStream.jsx:265-267` -- `messages.every(m => m.type === 'system' && (m.subtype === 'init' \|\| m.subtype === 'connected'))` | Correct | Build events use different subtypes, so they count as "content" and `isFirstMessage` becomes false. This is the desired behavior. |
| C11 | Design says `result-normalizer.js` should "accept optional `streamWriter` in opts, forward tool_use, assistant, tool_progress, tool_use_summary events" | `result-normalizer.js:129` -- `runAndNormalize(connector, prompt, stepDispatch, opts = {})` -- `opts` currently has only `progress`. No `streamWriter` support exists. | Correct (gap) | Must add `streamWriter` to opts and forward events inside the `for await` loop at line 144 |
| C12 | Design says `build.js` dispatch loop uses `response.status === 'execute_step'` | `build.js:197` -- `if (response.status === 'execute_step')` | Correct | None |
| C13 | Design says connector events include `tool_use`, `assistant`, `tool_progress`, `tool_use_summary` | `claude-sdk-connector.js:94-132` -- `_normalizeAll()` yields events with types: `system`, `error`, `assistant` (text), `tool_use`, `result`, `tool_use_summary`, `tool_progress` | Correct | These are the events the writer needs to capture |
| C14 | Design says `build.js` has `await_gate` handling | `build.js:217-247` -- `else if (response.status === 'await_gate')` with gate prompt | Correct | None |
| C15 | Design says `build.js` has `ensure_failed`/`schema_failed` retry | `build.js:269-284` -- handles both statuses with `buildRetryPrompt` | Correct | None |
| C16 | Design says "encoding safety" issue with `buf.length` vs `Buffer.byteLength()` | Design section 8, open question 5 | Valid concern | `_readNewLines()` should use `Buffer` for cursor tracking instead of string `.length`. Implementation must address this. |
| C17 | Design references `cli-progress.js` for progress rendering | `cli-progress.js:78-379` -- `CliProgress` class with `toolUse()`, `toolSummary()`, `toolProgress()`, `stepStart()` methods | Correct | Writer hooks into same event points that progress uses |
| C18 | Design says `execute_flow` passes writer through `executeChildFlow` | `build.js:249-267` -- `executeChildFlow()` call exists but takes no writer arg currently | Correct (gap) | Must thread `streamWriter` through `executeChildFlow` parameters |

---

## Architecture Decisions

### AD1: JSONL file transport (not IPC, not shared memory)

The CLI and agent-server are separate OS processes with independent lifecycles. JSONL decouples them: the CLI writes regardless of whether the server is listening, and the server tails when running. This is the simplest transport that handles all four lifecycle permutations (build-first, server-first, build-only, server-only).

### AD2: New system subtypes (not reuse of existing types)

Build lifecycle events use `{ type: "system", subtype: "build_*" }` -- never `system/init` or `compact_boundary`. This avoids overwriting the interactive session ID in `AgentStream.jsx:141` and ensures MessageCard renders them (unknown subtypes currently return `null` at line 230).

### AD3: Pass-through for tool_use and assistant events

`tool_use` and `assistant` text events from the build are re-wrapped into the same `{ type: "assistant", message: { content: [...] } }` shape that `_consumeStream()` produces. This means `AssistantCard` and `ToolUseBlock` in `MessageCard.jsx:109-128` render them with zero changes.

### AD4: Skip tool_progress and tool_use_summary at the writer

These event types are dropped by `processMessage()` at `AgentStream.jsx:147`. Writing them to JSONL only to have the bridge forward them and the frontend discard them is wasteful. The writer skips them. If STRAT-COMP-8 needs them later, the writer can be updated.

### AD5: Directory watch (not file watch)

`fs.watch` on macOS is unreliable when watching a file that may not exist yet. Watching the parent `.compose/` directory and filtering by filename is more robust. If the directory itself does not exist at server startup, poll every 2 seconds until it appears.

### AD6: Byte cursor with Buffer (not string length)

The design's open question 5 identified an encoding bug: `buf.length` returns string character count, not byte count, which misaligns the cursor for multi-byte UTF-8 content. The bridge must read as `Buffer` and track `Buffer.byteLength` for the cursor. This is a P1 fix baked into the implementation.

### AD7: `_source: "build"` discriminator on all mapped events

Every SSE message produced by the bridge carries `_source: "build"`. This lets STRAT-COMP-8's dashboard filter build events from interactive events without inspecting subtypes. It also prevents the `isFirstMessage` check from treating build events as interactive session starts.

---

## Component Designs

### 1. `lib/build-stream-writer.js` (new)

**Purpose:** Append JSONL events to `.compose/build-stream.jsonl` with monotonic `_seq` and `_ts` envelope fields.

**Public API:**

```
class BuildStreamWriter {
  constructor(composeDir: string, featureCode: string)  // mkdirSync, truncate stale file
  write(event: object): void                            // appendFileSync, auto-increment _seq
  close(status?: 'complete'|'killed'|'aborted'): void   // write build_end sentinel with status (default: 'complete')
  get filePath(): string
}
```

**Key implementation details:**

- Constructor: `mkdirSync(composeDir, { recursive: true })`, unlinks existing file, sets `#path = join(composeDir, 'build-stream.jsonl')`.
- `write()`: `appendFileSync(this.#path, JSON.stringify({ ...event, _seq: this.#seq++, _ts: Date.now() }) + '\n')`.
- `close(status = 'complete')`: calls `this.write({ type: 'build_end', status, featureCode: this.#featureCode })`.
- Sync I/O is intentional -- JSONL lines are small and the CLI is already I/O-bound on agent calls.
- Skips `tool_progress` and `tool_use_summary` events (per AD4). The caller (`result-normalizer.js`) decides what to forward.

**Events written:**

| Event type | When | Source |
|---|---|---|
| `build_start` | Once at `runBuild()` start | `build.js` |
| `build_step_start` | Before connector dispatch | `build.js` |
| `tool_use` | Each tool call from connector | `result-normalizer.js` |
| `assistant` | Each text block from connector | `result-normalizer.js` |
| `build_step_done` | After `stratum.stepDone()` | `build.js` |
| `build_gate` | At `await_gate` dispatch | `build.js` |
| `build_gate_resolved` | After gate resolution | `build.js` |
| `build_error` | On error (two write points) | `result-normalizer.js` (before throw) AND `build.js` (try/catch around `runAndNormalize()` for errors bypassing normalizer) |
| `build_end` | At build completion/killed | `build.js` via `close()` |

### 2. `server/build-stream-bridge.js` (new)

**Purpose:** Tail `.compose/build-stream.jsonl`, map JSONL events to SSE-compatible shapes, call `broadcast()`.

**Public API:**

```
class BuildStreamBridge {
  constructor(composeDir: string, broadcast: (msg: object) => void)
  start(): void                         // begin tailing (catch up if file exists)
  stop(): void                          // close watcher
}
```

**Key implementation details:**

- **Byte cursor tracking with Buffer:** Read file as `Buffer` (not string). Track `#cursor` as byte offset. Slice new bytes from `#cursor` to `stat.size`. Convert slice to UTF-8 string, split on `\n`, parse each line.
- **Dedup:** Monotonic `#lastSeq` guard. If `event._seq <= this.#lastSeq`, skip.
- **Directory watch:** `fs.watch(dir, callback)` where `dir = path.dirname(this.#filePath)`. Filter for `filename === 'build-stream.jsonl'`.
- **Cursor reset on file replacement:** Primary detection: inode change (`stat.ino !== this.#lastIno`). Store `#lastIno` and check on every read. Reset `#cursor = 0` and `#lastSeq = -1` on inode change, even when the new file is larger than the old cursor. Secondary fallback: `stat.size < this.#cursor` (truncation without inode change).
- **Poll fallback:** If directory does not exist at `start()`, poll every 2s via `setInterval` with `.unref()`. Clear interval once directory appears. A `#polling` guard flag prevents `_pollForDirectory` → `start()` re-entrancy from creating unbounded interval accumulation.
- **Debounce:** 50ms debounce on `_readNewLines()` calls to reduce syscalls from coalesced `fs.watch` events on macOS.

**Event mapping (JSONL -> SSE):**

| JSONL type | SSE shape |
|---|---|
| `build_start` | `{ type: "system", subtype: "build_start", featureCode, flowId, _source: "build" }` |
| `build_step_start` | `{ type: "system", subtype: "build_step", stepId, stepNum, totalSteps, agent, _source: "build" }` |
| `tool_use` | `{ type: "assistant", message: { content: [{ type: "tool_use", name: event.tool, input: event.input }] }, _source: "build" }` |
| `assistant` | `{ type: "assistant", message: { content: [{ type: "text", text: event.content }] }, _source: "build" }` |
| `build_step_done` | `{ type: "system", subtype: "build_step_done", stepId, summary, _source: "build" }` |
| `build_gate` | `{ type: "system", subtype: "build_gate", stepId, gateType, _source: "build" }` |
| `build_gate_resolved` | `{ type: "system", subtype: "build_gate_resolved", stepId, outcome, rationale, _source: "build" }` |
| `build_error` | `{ type: "error", message: event.message, source: "build", _source: "build" }` |
| `build_end` | `{ type: "system", subtype: "build_end", status, featureCode, _source: "build" }` |

### 3. `server/agent-server.js` (existing, modify)

**Changes:**

1. **Import** `BuildStreamBridge` from `./build-stream-bridge.js` (after line 21).
2. **Instantiate** after `server.listen()` (after line 215):
   ```
   const bridge = new BuildStreamBridge(
     path.join(TARGET_ROOT, '.compose'),
     broadcast
   );
   bridge.start();
   ```
3. **Stop** in `shutdown()` (before `server.close()` at line 220):
   ```
   bridge.stop();
   ```

**Lines affected:** ~215 (after listen callback), ~218 (shutdown function). No changes to `_consumeStream`, `broadcast`, `_session`, or any SSE/session logic.

### 4. `lib/build.js` (existing, modify)

**Changes:**

1. **Import** `BuildStreamWriter` from `./build-stream-writer.js` (after line 20).
2. **Instantiate** writer at `runBuild()` start (after line 142, before stratum connect):
   ```
   const streamWriter = new BuildStreamWriter(composeDir, featureCode);
   ```
3. **Write `build_start`** after `startFresh()` or resume succeeds (around line 186):
   ```
   streamWriter.write({
     type: 'build_start',
     featureCode,
     flowId: response.flow_id,
     specPath: 'pipelines/build.stratum.yaml',
   });
   ```
4. **Write `build_step_start`** in `execute_step` branch (after line 198, before connector dispatch):
   ```
   streamWriter.write({
     type: 'build_step_start',
     stepId, stepNum, totalSteps,
     agent: agentType,
     flowId,
   });
   ```
5. **Pass `streamWriter` to `runAndNormalize()`** (line 208):
   ```
   const { result } = await runAndNormalize(connector, prompt, response, { progress, streamWriter });
   ```
6. **Write `build_step_done`** after `stratum.stepDone()` (after line 215):
   ```
   streamWriter.write({
     type: 'build_step_done',
     stepId,
     summary: stepResult.summary,
     flowId,
   });
   ```
7. **Write `build_gate`** in `await_gate` branch (after line 220):
   ```
   streamWriter.write({ type: 'build_gate', stepId, flowId, gateType: response.gate_type ?? 'approval' });
   ```
8. **Write `build_gate_resolved`** after `promptGate()` returns (after line 246):
   ```
   streamWriter.write({ type: 'build_gate_resolved', stepId, outcome, rationale });
   ```
9. **Thread `streamWriter`** through `executeChildFlow()` (line 259-262) -- add as parameter, use in child's `execute_step` and `await_gate` branches.
10. **Write `build_error`** in retry branches (lines 269-284) when `AgentError` is caught.
11. **Call `streamWriter.close(status)`** in the `finally` block (after line 352, before `progress.finish()`). Pass the appropriate status based on how the build ended:
    ```
    // Normal completion:
    streamWriter.close('complete');
    // In the kill handler (SIGINT/SIGTERM):
    streamWriter.close('killed');
    // In the abort/error path:
    streamWriter.close('aborted');
    ```

### 5. `lib/result-normalizer.js` (existing, modify)

**Changes:**

1. **Accept `streamWriter` in opts** (line 129-130):
   ```
   const streamWriter = opts.streamWriter;
   ```
2. **Forward `tool_use` events** inside the `for await` loop (after the existing `tool_use` handling at line 163-177):
   ```
   if (streamWriter && event.type === 'tool_use') {
     streamWriter.write({ type: 'tool_use', tool: event.tool, input: event.input });
   }
   ```
3. **Forward `assistant` text events** (after the existing `assistant` handling at line 153-155):
   ```
   if (streamWriter && event.type === 'assistant' && event.content) {
     streamWriter.write({ type: 'assistant', content: event.content });
   }
   ```
4. **Forward `error` events** (at the existing error handler, line 150-152, BEFORE the throw):
   ```
   if (streamWriter && event.type === 'error') {
     streamWriter.write({ type: 'build_error', message: event.message });
   }
   ```
   This is write point (a) for `build_error` -- it captures connector-level errors that the normalizer sees. Note: `stepId` is not included here because it is not in the normalizer's scope. Write point (b) in `build.js` (try/catch around `runAndNormalize()`) includes `stepId` since it is available there.

**Not forwarded:** `tool_progress`, `tool_use_summary`, `result`, `system` (per AD4).

**Note:** Write point (b) for `build_error` is in `build.js`, in a try/catch around `runAndNormalize()`. This catches errors that bypass the normalizer entirely (e.g., network failures, timeouts, connector instantiation errors):
```
try {
  const { result } = await runAndNormalize(connector, prompt, response, { progress, streamWriter });
} catch (err) {
  streamWriter.write({ type: 'build_error', message: err.message, stepId });
  throw err;
}
```

### 6. `src/components/AgentStream.jsx` (existing, modify)

**Changes to `deriveStatus()`** (after line 82, before `return null`):

```javascript
if (msg.type === 'system' && msg.subtype === 'build_step') {
  return { status: 'working', tool: null, category: 'thinking', _source: 'build' };
}
if (msg.type === 'system' && msg.subtype === 'build_end') {
  return { status: 'idle', tool: null, category: null, _source: 'build' };
}
// The status bar uses _source to avoid a build_end idle overriding
// an active interactive session's working state, and vice versa.
```

**Edge case: concurrent build + interactive session.** When both are active, `deriveStatus()` returns status objects with `_source: "build"` for build events and no `_source` (or `_source: "interactive"`) for interactive events. The status bar consumer should only transition to idle when the idle event's `_source` matches the currently active source. This prevents a `build_end` from clearing the status bar while an interactive session is still working.

**No other changes.** `processMessage()` already appends all non-skipped messages to `_state.messages` (line 151). Build events with `type: "system"` and build-specific subtypes pass through. The `isFirstMessage` check (line 265-267) correctly treats build events as content because their subtypes are not `init` or `connected`.

### 7. `src/components/agent/MessageCard.jsx` (existing, modify)

**Add six new rendering branches** after the `system/connected` handler (after line 206, before the `assistant` check at line 208):

```jsx
if (msg.type === 'system' && msg.subtype === 'build_start') {
  return (
    <div className="text-[10px] uppercase tracking-wider py-1"
      style={{ color: 'hsl(var(--accent))', opacity: 0.8 }}>
      build started -- {msg.featureCode}
    </div>
  );
}

if (msg.type === 'system' && msg.subtype === 'build_step') {
  return (
    <div className="text-[10px] uppercase tracking-wider py-1 flex gap-2"
      style={{ color: 'hsl(var(--muted-foreground))' }}>
      <span>step {msg.stepNum}/{msg.totalSteps}</span>
      <span className="font-mono">{msg.stepId}</span>
      <span style={{ opacity: 0.5 }}>{msg.agent}</span>
    </div>
  );
}

if (msg.type === 'system' && msg.subtype === 'build_step_done') {
  return (
    <div className="text-[10px] py-0.5"
      style={{ color: 'hsl(var(--success, 142 60% 50%))', opacity: 0.7 }}>
      step complete -- {msg.stepId}
    </div>
  );
}

if (msg.type === 'system' && msg.subtype === 'build_gate') {
  return (
    <div className="text-[10px] uppercase tracking-wider py-1"
      style={{ color: 'hsl(38 90% 60%)' }}>
      gate -- {msg.stepId}
    </div>
  );
}

if (msg.type === 'system' && msg.subtype === 'build_gate_resolved') {
  const color = msg.outcome === 'approved'
    ? 'hsl(var(--success, 142 60% 50%))'
    : 'hsl(var(--destructive))';
  return (
    <div className="text-[10px] py-0.5"
      style={{ color, opacity: 0.8 }}>
      gate {msg.outcome} -- {msg.stepId}
    </div>
  );
}

if (msg.type === 'system' && msg.subtype === 'build_end') {
  const color = msg.status === 'complete'
    ? 'hsl(var(--success, 142 60% 50%))'
    : 'hsl(var(--destructive))';
  return (
    <div className="text-[10px] uppercase tracking-wider py-1"
      style={{ color }}>
      build {msg.status} -- {msg.featureCode}
    </div>
  );
}
```

These are lightweight status indicators -- no new sub-components needed. They use the same styling patterns as the existing `system/init` and `system/connected` handlers.

---

## Event Schema

### JSONL envelope (all events)

```json
{
  "type": "<event_type>",
  "_seq": 0,
  "_ts": 1741747200000
}
```

`_seq` is monotonically increasing per build (reset on new build). `_ts` is `Date.now()` at write time.

### Event type definitions

| Event type | Additional fields | Emitted by |
|---|---|---|
| `build_start` | `featureCode: string`, `flowId: string`, `specPath: string` | `build.js` after plan/resume |
| `build_step_start` | `stepId: string`, `stepNum: number`, `totalSteps: number`, `agent: string`, `flowId: string` | `build.js` in `execute_step` |
| `tool_use` | `tool: string`, `input: object` | `result-normalizer.js` |
| `assistant` | `content: string` | `result-normalizer.js` |
| `build_step_done` | `stepId: string`, `summary: string`, `flowId: string` | `build.js` after `stepDone()` |
| `build_gate` | `stepId: string`, `flowId: string`, `gateType: string` | `build.js` in `await_gate` |
| `build_gate_resolved` | `stepId: string`, `outcome: string`, `rationale: string` | `build.js` after gate prompt |
| `build_error` | `message: string`, `stepId?: string` | `result-normalizer.js` (before throw, connector-level errors) AND `build.js` (try/catch around `runAndNormalize()`, errors bypassing normalizer) |
| `build_end` | `status: "complete"\|"killed"\|"aborted"`, `featureCode: string` | `build.js` via `close()` |

### SSE message shapes (after bridge mapping)

All mapped messages carry `_source: "build"`.

- **Lifecycle events** use `{ type: "system", subtype: "build_*", ...fields, _source: "build" }`.
- **Content events** (`tool_use`, `assistant`) are re-wrapped into `{ type: "assistant", message: { content: [...] }, _source: "build" }` to match SDK format expected by `AssistantCard`.
- **Error events** use `{ type: "error", message, source: "build", _source: "build" }`.

---

## Build Sequence

Ordered tasks with dependencies. Each task is a commit-worthy checkpoint.

- [ ] **T1: Create `lib/build-stream-writer.js`** -- BuildStreamWriter class with constructor, write(), close(), filePath getter. Truncates stale file on construction. Sync I/O. No external dependencies.

- [ ] **T2: Unit test for BuildStreamWriter** -- Verify: creates file, appends JSONL lines with `_seq` and `_ts`, truncates on re-construction, close() writes `build_end` sentinel. Use temp directory.

- [ ] **T3: Instrument `lib/result-normalizer.js`** -- Add `streamWriter` to opts. Forward `tool_use`, `assistant`, and `error` events. Skip `tool_progress`, `tool_use_summary`, `result`, `system`.

- [ ] **T4: Instrument `lib/build.js`** (main dispatch loop) -- Import writer. Instantiate in `runBuild()`. Write `build_start`, `build_step_start`, `build_step_done`, `build_gate`, `build_gate_resolved`, `build_error`, `build_end`. Pass `streamWriter` to `runAndNormalize()` at ALL main-loop call sites: (1) `execute_step` dispatch (line ~208), (2) `ensure_failed` retry (line ~275). Write `build_error` in the try/catch around `runAndNormalize()` for errors that bypass the normalizer. Call `close()` in finally block.

- [ ] **T5: Instrument `lib/build.js`** (child flows) -- Thread `streamWriter` through `executeChildFlow()`. Pass `streamWriter` to `runAndNormalize()` at ALL child-flow call sites: (1) child flow `execute_step` (line ~386), (2) child flow fix pass (line ~444), (3) child flow retry (line ~453). Write same step/gate events for child flow steps. Include `flowId` to distinguish parent from child.

- [ ] **T6: Integration test for JSONL output** -- Run a mock build (with `connectorFactory` override) that executes 2 steps and a gate. Verify JSONL file contains expected events in order with monotonic `_seq`.

- [ ] **T7: Create `server/build-stream-bridge.js`** -- BuildStreamBridge class with Buffer-based cursor tracking, directory watch, dedup guard, 50ms debounce, cursor reset on truncation, poll fallback for missing directory.

- [ ] **T8: Implement `_mapEvent()` in bridge** -- Event mapping function per the mapping table. `tool_use` and `assistant` re-wrapped to SDK shape. All events get `_source: "build"`.

- [ ] **T9: Unit test for BuildStreamBridge** -- Write JSONL lines to a temp file, verify bridge calls broadcast with correctly mapped SSE shapes. Test dedup, cursor reset, and debounce.

- [ ] **T10: Integrate bridge into `server/agent-server.js`** -- Import, instantiate after `server.listen()`, stop in `shutdown()`. Three lines of glue code.

- [ ] **T11: Extend `deriveStatus()` in `AgentStream.jsx`** -- Add `build_step` -> working and `build_end` -> idle branches.

- [ ] **T12: Add build event renderers to `MessageCard.jsx`** -- Six new `if` branches for `build_start`, `build_step`, `build_step_done`, `build_gate`, `build_gate_resolved`, `build_end`. Lightweight status indicators using existing style patterns.

- [ ] **T13: End-to-end smoke test** -- Start agent-server, write JSONL events manually to `.compose/build-stream.jsonl`, verify SSE messages arrive at `GET /api/agent/stream` with correct shapes.

- [ ] **T14: Edge case hardening** -- Test: build starts before server (catch-up), file truncation mid-tail (size-based cursor reset), file replacement where new file is larger (inode-based cursor reset), malformed JSON lines (skip), directory creation after server start (poll fallback), concurrent build + interactive session status bar isolation.

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `fs.watch` unreliable on macOS (coalesced events, spurious fires) | High | Low | `_readNewLines()` is idempotent via cursor; redundant calls are cheap. 50ms debounce reduces syscalls. Poll fallback as last resort. |
| Multi-byte UTF-8 in JSONL causes cursor misalignment | Medium | High | AD6: read as Buffer, track byte offset with `Buffer.byteLength()`, not string `.length`. |
| Large JSONL file from long build (many tool calls) | Low | Low | Cursor-based reads: memory proportional to new-lines-per-read, not total file. File truncated on next build. |
| Build crash leaves no `build_end` sentinel | Medium | Low | Frontend sees stream stop; status bar remains `working` until 2s idle debounce clears it. Next build truncates stale file. |
| Concurrent interactive session + build interleave in same stream | Expected | Low | Events interleave by design. `_source: "build"` lets STRAT-COMP-8 filter. Session ID is never overwritten (build never emits `system/init`). |
| `appendFileSync` blocks event loop on slow disk | Low | Medium | JSONL lines are small (<1KB typically). The CLI is already blocked on agent calls between writes. Acceptable for v1; switch to async if profiling shows problems. |

---

## Behavioral Test Checkpoints

These are the golden-flow verifications that confirm the bridge works end-to-end.

### Checkpoint 1: JSONL file lifecycle

**Given** a build runs with 2 steps and 1 gate
**Then** `.compose/build-stream.jsonl` contains events in this order:
`build_start` -> `build_step_start` -> N x (`tool_use` | `assistant`) -> `build_step_done` -> `build_gate` -> `build_gate_resolved` -> `build_step_start` -> N x (`tool_use` | `assistant`) -> `build_step_done` -> `build_end`
**And** every event has monotonically increasing `_seq`
**And** every event has `_ts` within the build duration window

### Checkpoint 2: Bridge catch-up

**Given** a JSONL file with 5 events already exists
**When** BuildStreamBridge.start() is called
**Then** broadcast() is called 5 times with correctly mapped events
**And** `#cursor` equals the file size in bytes

### Checkpoint 3: Live tailing

**Given** BuildStreamBridge is running
**When** a new line is appended to the JSONL file
**Then** broadcast() is called within 100ms with the mapped event

### Checkpoint 4: Cursor reset on file replacement

**Case 4a: New file smaller than cursor**
**Given** BuildStreamBridge has read 10 events (cursor at byte N)
**When** the JSONL file is deleted and a new one is created with 2 events (size < N)
**Then** bridge resets cursor to 0 and broadcasts the 2 new events
**And** `#lastSeq` is reset to -1

**Case 4b: New file larger than old cursor (inode-based detection)**
**Given** BuildStreamBridge has read 3 short events (cursor at byte N)
**When** the JSONL file is deleted and a new one is created with 10 events (size > N)
**Then** bridge detects the inode change (`stat.ino !== #lastIno`), resets cursor to 0 and `#lastSeq` to -1
**And** broadcasts all 10 new events from the beginning (not just bytes after old cursor)

### Checkpoint 5: Session ID isolation

**Given** an interactive session is active with session_id "abc123"
**When** build events stream through the bridge
**Then** `_state.sessionId` in AgentStream.jsx remains "abc123"
**And** `sessionStorage.getItem('compose-agent-session')` remains "abc123"

### Checkpoint 6: Frontend rendering

**Given** a `build_step` event arrives via SSE
**Then** MessageCard renders a step progress indicator with stepNum, totalSteps, stepId, agent
**And** the status bar shows "working" state
**When** a `build_end` event with `status: "complete"` arrives
**Then** MessageCard renders a green completion indicator
**And** the status bar returns to "idle" after 2s debounce

### Checkpoint 7: Error event flow

**Given** a connector throws `AgentError` during a build step
**Then** the writer emits a `build_error` JSONL event
**And** the bridge maps it to `{ type: "error", message, source: "build" }`
**And** MessageCard renders the existing error banner (line 220-227)
