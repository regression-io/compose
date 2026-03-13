# Design: Agent Stream Bridge (STRAT-COMP-7)

**Feature:** Bridge CLI build events to the web UI's agent stream via JSONL file transport
**Status:** Design
**Date:** 2026-03-12

---

## Related Documents

- [STRAT-COMP-4 design](../STRAT-COMP-4/design.md) — parent milestone (Unified Interface)
- [STRAT-COMP-5 design](../STRAT-COMP-5/design.md) — Build Visibility (prerequisite, file watcher infrastructure)
- STRAT-COMP-8 design (downstream) — Active Build Dashboard, will consume build events

### Supersession Notes

This design document is the authoritative source for STRAT-COMP-7 behavior. Where the companion documents (`blueprint.md` and `plan.md`) describe different behavior — specifically around `build_error` emission (design specifies two `build.js` catch points for connector and infrastructure errors, blueprint/plan may reference normalizer error forwarding or describe a single write point) and the `AgentStream.jsx` change surface (design requires per-source status tracking, blueprint/plan may describe a simpler change) — this design document takes precedence. The blueprint and plan will be updated to align during their respective review steps.

### Schema Reconciliation with STRAT-COMP-4

The STRAT-COMP-4 parent design defined a preliminary JSONL schema using `event`-keyed fields (`step_start`, `assistant_text`, `step_done`, `gate_pending`) and stated "frontend unchanged." This design (STRAT-COMP-7) supersedes those preliminary definitions with the following changes:

1. **Key name:** JSONL events use `type` (not `event`) as the discriminator key, consistent with the existing SDK message format used throughout the codebase.
2. **Event names:** Renamed for clarity and namespace safety: `step_start` -> `build_step_start`, `step_done` -> `build_step_done`, `gate_pending` -> `build_gate`, `assistant_text` -> `assistant`, `step_boundary` removed (redundant with `build_step_start`/`build_step_done` pairs).
3. **Frontend changes required:** The STRAT-COMP-4 claim that the frontend is unchanged was incorrect. `MessageCard.jsx` needs six new rendering branches for build-specific subtypes, and `AgentStream.jsx` needs per-source status tracking. This was identified during detailed design.
4. **Envelope fields:** Added `_seq` (monotonic dedup counter) and `_ts` (timestamp as epoch ms, not ISO string) to the JSONL envelope.

**Action required:** STRAT-COMP-4's build-stream acceptance criteria (lines 172-183) must be updated to reference this document as the authoritative source for the JSONL event schema. Until that update is made, implementers should follow this document (STRAT-COMP-7) for all build-stream event shapes, field names, and frontend requirements. The STRAT-COMP-4 update is tracked as a prerequisite task before implementation begins.

---

## 1. Problem Statement

When `compose build` runs, the CLI dispatches steps to agents (Claude, Codex) via connectors that produce streaming events. These events — tool calls, assistant text, step boundaries, errors — are consumed by `result-normalizer.js` and rendered to the terminal via `CliProgress`. The web UI never sees them.

The web UI has an `AgentStream.jsx` component connected via SSE to `agent-server.js` (port 3002). The agent-server streams SDK messages from its own interactive sessions (`POST /api/agent/session`). It has no awareness of CLI builds. A user running `compose build` in one terminal and `compose start` in another sees nothing in the agent stream — the build is invisible.

**Goal:** Build events from `compose build` appear in `AgentStream.jsx` in real time for already-connected SSE clients, so users can watch what the build agent is doing without switching to the CLI terminal. Late-connecting clients (opening/refreshing the browser mid-build) see only events from the point of connection forward; full build history replay is deferred to STRAT-COMP-8.

### Goals

- Real-time build event visibility for already-connected SSE clients in the web UI
- Build lifecycle events (step start/done, gates, completion) rendered as lightweight status indicators
- Build tool/assistant content rendered via existing `AssistantCard` (no new content components)
- Decoupled file-based transport (JSONL) between CLI and agent-server processes
- Per-source status tracking to prevent build/interactive status bar races

### Non-Goals

- Historical build replay for late-connecting clients (deferred to STRAT-COMP-8)
- Separate build dashboard view (deferred to STRAT-COMP-8)
- Concurrent build support (one build per workspace)
- Build-specific source badges on content events (deferred — users distinguish by step boundary markers)
- `tool_progress` or `tool_use_summary` forwarding (filtered at writer for JSONL size)

### Why not direct integration?

The CLI and agent-server are separate processes. The CLI may start before the server, after the server, or without the server entirely. A file-based transport (JSONL) decouples them: the CLI writes regardless of whether anyone is listening, and the server tails when it is running.

---

## 2. Architecture

### Data Flow

```
compose build (CLI process)
    │
    ├── Connector.run(prompt) yields events
    │     │
    │     ├── result-normalizer.js (consumes events, extracts result)
    │     └── BuildStreamWriter (NEW) — appends events to JSONL
    │
    ▼
.compose/build-stream.jsonl
    │
    ▼
agent-server.js (port 3002)
    │
    ├── BuildStreamBridge (NEW) — tails JSONL, maps events to SSE shapes
    │     │
    │     └── broadcast(mappedEvent) → existing SSE endpoint
    │
    ▼
GET /api/agent/stream (SSE)
    │
    ▼
AgentStream.jsx
    │
    ├── processMessage(msg) — existing handler
    ├── MessageCard.jsx — renders build events via new subtypes
    └── deriveStatus(msg) — updates agent status indicator
```

### Process Lifecycle

```
Case 1: Build starts, then server starts
  CLI writes JSONL → server starts → BuildStreamBridge reads from beginning → checks if last event is `build_end` (stale build) or not (active build). If stale, skip replay. If active, catch up and continue tailing.

Case 2: Server running, then build starts
  Server watching → CLI creates JSONL → fs.watch fires → Bridge tails new lines

Case 3: Build runs without server
  CLI writes JSONL → nobody reads → file remains on disk until next build truncates it

Case 4: Server running, no build
  Bridge watches for file creation → nothing happens → idle
```

---

## 3. Detailed Design

### 3.1 BuildStreamWriter (CLI side)

A lightweight class instantiated in `build.js` that wraps `fs.appendFileSync` to a JSONL file. It hooks into the existing event stream from connectors.

**Location:** `lib/build-stream-writer.js` (new)

```javascript
import { appendFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export class BuildStreamWriter {
  #path;
  #seq = 0;
  #featureCode;
  #closed = false;

  constructor(composeDir, featureCode) {
    mkdirSync(composeDir, { recursive: true });
    this.#path = join(composeDir, 'build-stream.jsonl');
    this.#featureCode = featureCode;
    // Truncate any stale file from a previous build
    if (existsSync(this.#path)) unlinkSync(this.#path);
  }

  write(event) {
    const line = JSON.stringify({
      ...event,
      _seq: this.#seq++,
      _ts: Date.now(),
    });
    appendFileSync(this.#path, line + '\n');
  }

  close(status = 'complete') {
    if (this.#closed) return; // idempotent — exactly one build_end per build
    this.#closed = true;
    // Write sentinel so the bridge knows the build is done
    this.write({ type: 'build_end', status, featureCode: this.#featureCode });
  }

  get filePath() { return this.#path; }
}
```

**Integration point in `build.js`:**

The writer is created AFTER the Stratum plan/resume call succeeds (i.e., after the process has confirmed it owns the build). This prevents a rejected or duplicate invocation from truncating an active build's stream. Events are written at three points:

1. **Step start** — when `response.status === 'execute_step'`, write a `build_step_start` event before dispatching to the connector.
2. **Connector events** — inside `runAndNormalize()`, the caller passes a `streamWriter` option. The normalizer forwards `tool_use` and `assistant` events (not `tool_progress` or `tool_use_summary`, per design decision: skip noisy events at writer).
3. **Step complete** — after `stratum.stepDone()` returns, write a `build_step_done` event.

Additional events: `build_start` (once, after plan/resume), `build_gate` (at gate), `build_gate_resolved` (after gate resolution), `build_error` (on agent error), `build_end` (at completion/killed/aborted).

**Terminal event guarantees:** `streamWriter.close(status)` is called in the `finally` block of `runBuild()`, ensuring exactly one `build_end` event per build regardless of exit path:
- Normal completion: `close('complete')` — called in the finally block after the main dispatch loop exits normally
- SIGINT/SIGTERM: `close('killed')` — signal handlers are registered at `runBuild()` entry via `process.on('SIGINT', ...)` and `process.on('SIGTERM', ...)`. They set `buildStatus = 'killed'` and throw a `BuildKilledError` to unwind the stack naturally, allowing the `catch` and `finally` blocks to run. The `finally` block calls `streamWriter.close(buildStatus)` and removes the signal listeners via `process.removeListener()`.
- Unhandled error: `close('aborted')` — the catch block sets a `buildStatus = 'aborted'` variable, which the finally block passes to `close(buildStatus)`
- External `compose build --abort`: The existing `abortBuild()` function (build.js line ~523) deletes the Stratum flow state file and removes the `active-build.json` record. The running build process will fail on its next Stratum API call with an error. **Caveat:** If the build is inside a long-running `runAndNormalize()` call, it will not observe the abort until that call completes or fails. In the worst case, the build may hang indefinitely if the connector hangs. The `build_end(aborted)` event is therefore **best-effort** for the external abort path — it depends on the running process eventually reaching an error. For guaranteed abort termination, SIGINT/SIGTERM should be sent directly to the build process. This is a known limitation of the current abort mechanism, not specific to this feature.
- `close()` is idempotent, so signal-handler + finally double-calls are safe

**All `streamWriter` → `runAndNormalize()` call sites** (must pass `streamWriter` in every branch):

| Call site | Location | Context |
|---|---|---|
| Main loop `execute_step` | `build.js` line ~208 | Primary step dispatch |
| Main loop `ensure_failed` retry | `build.js` line ~275 | Retry after postcondition failure |
| Child flow `execute_step` | `build.js` line ~386 | `executeChildFlow()` step dispatch |
| Child flow fix pass | `build.js` line ~444 | Child flow postcondition fix |
| Child flow retry | `build.js` line ~453 | Child flow retry on failure |

### 3.2 BuildStreamBridge (server side)

A class in `agent-server.js` that tails the JSONL file and maps build events to SSE-compatible shapes for `broadcast()`.

**Location:** `server/build-stream-bridge.js` (new)

**Mechanism:**

```javascript
import { watch, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

export class BuildStreamBridge {
  #filePath;
  #cursor = 0;        // byte offset into the file
  #watcher = null;
  #broadcast;          // function(msg) — agent-server's broadcast()
  #lastSeq = -1;       // dedup guard
  #lastIno = null;     // inode of the file we're tailing
  #polling = false;          // guard against re-entrant _pollForDirectory
  #pollInterval = null;      // setInterval handle for directory polling
  #trailingFragment = '';    // incomplete line buffer for partial-write safety
  #debounceTimer = null;     // 50ms debounce for _readNewLines
  #crashTimer = null;        // inactivity timer for crash detection (default 300s)
  #buildActive = false;      // true between build_start and build_end
  #inStep = false;           // true between build_step_start and build_step_done/build_gate
  #crashTimeoutMs = 300000;  // 5 min default, configurable via constructor opts

  constructor(composeDir, broadcast, opts = {}) {
    this.#filePath = path.join(composeDir, 'build-stream.jsonl');
    if (opts.crashTimeoutMs) this.#crashTimeoutMs = opts.crashTimeoutMs;
    this.#broadcast = broadcast;
  }

  start() {
    // If the file already exists (build started before server), check freshness
    if (existsSync(this.#filePath)) {
      const stat = statSync(this.#filePath);
      const content = readFileSync(this.#filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.trim());
      const lastLine = lines[lines.length - 1];
      let isStale = false;
      try {
        const last = JSON.parse(lastLine);
        // Stale if: (a) build_end sentinel exists (completed/killed/aborted), or
        // (b) file hasn't been modified in > crashTimeoutMs AND last event is not a gate
        //     (gates can have unbounded human wait times, so age alone is not sufficient)
        if (last.type === 'build_end') {
          isStale = true;
        } else if (last.type === 'build_gate') {
          // Gate waiting — treat as active unless file is very old (> 24h)
          // Gates have unbounded human wait, but 24h is a reasonable upper bound
          const GATE_STALE_MS = 24 * 60 * 60 * 1000;
          isStale = Date.now() - stat.mtimeMs > GATE_STALE_MS;
        } else if (Date.now() - stat.mtimeMs > this.#crashTimeoutMs) {
          isStale = true; // old file from a crashed build
        }
      } catch {
        // Malformed last line — check age
        isStale = Date.now() - stat.mtimeMs > this.#crashTimeoutMs;
      }

      if (isStale) {
        // Skip replay, set cursor to EOF
        this.#cursor = Buffer.byteLength(content, 'utf-8');
        this.#lastIno = stat.ino;
      } else {
        // Active build — catch up from beginning
        this._readNewLines();
      }
    }

    // Watch the parent directory (more reliable on macOS than watching a
    // file that may not exist yet)
    const dir = path.dirname(this.#filePath);
    try {
      this.#watcher = watch(dir, (eventType, filename) => {
        if (filename === 'build-stream.jsonl') {
          this._debouncedRead();
        }
      });
    } catch {
      // Directory may not exist yet — retry on interval
      this._pollForDirectory(dir);
    }
  }

  stop() {
    if (this.#watcher) {
      this.#watcher.close();
      this.#watcher = null;
    }
    if (this.#pollInterval) {
      clearInterval(this.#pollInterval);
      this.#pollInterval = null;
      this.#polling = false;
    }
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
    if (this.#crashTimer) {
      clearTimeout(this.#crashTimer);
      this.#crashTimer = null;
    }
  }

  _readNewLines() {
    if (!existsSync(this.#filePath)) {
      this.#cursor = 0;
      return false;
    }

    const stat = statSync(this.#filePath);

    // Detect file replacement (new build) even if new file is larger
    if (this.#lastIno !== null && stat.ino !== this.#lastIno) {
      this.#cursor = 0;
      this.#lastSeq = -1;
    }
    this.#lastIno = stat.ino;

    // Secondary fallback: size-based truncation detection (no inode change)
    if (stat.size < this.#cursor) {
      this.#cursor = 0;
      this.#lastSeq = -1;
    }

    if (stat.size <= this.#cursor) return false; // no new data

    const buf = readFileSync(this.#filePath); // read as Buffer (no encoding)
    const newContent = buf.slice(this.#cursor).toString('utf-8');
    this.#cursor = buf.length; // Buffer.length is byte length, not UTF-16 code units

    // Buffer incomplete trailing line (no newline terminator)
    const combined = (this.#trailingFragment || '') + newContent;
    const parts = combined.split('\n');
    // Last element is either '' (line ended with \n) or an incomplete fragment
    this.#trailingFragment = parts.pop();
    const lines = parts.filter(l => l.trim());
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event._seq <= this.#lastSeq) continue; // dedup
        this.#lastSeq = event._seq;
        const mapped = this._mapEvent(event);
        if (mapped) this.#broadcast(mapped);
      } catch (err) {
        // Skip malformed lines with debug log
        if (process.env.DEBUG) console.debug('[BuildStreamBridge] Skipping malformed JSONL line:', err.message);
      }
    }
    return lines.length > 0;
  }

  _pollForDirectory(dir) {
    if (this.#polling) return; // prevent unbounded interval accumulation
    this.#polling = true;
    this.#pollInterval = setInterval(() => {
      if (existsSync(dir)) {
        clearInterval(this.#pollInterval);
        this.#pollInterval = null;
        this.#polling = false;
        this.start();
      }
    }, 2000);
    this.#pollInterval.unref(); // don't keep the process alive just for polling
  }

  // 50ms debounce wrapper for _readNewLines
  _debouncedRead() {
    if (this.#debounceTimer) return;
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      const hadNewData = this._readNewLines();
      // Only manage crash timer when actively executing a step (not during gates)
      if (hadNewData && this.#inStep) {
        this._resetCrashTimer();
      }
    }, 50);
  }

  _resetCrashTimer() {
    if (this.#crashTimer) clearTimeout(this.#crashTimer);
    if (!this.#inStep) return; // only crash-detect during active step execution
    this.#crashTimer = setTimeout(() => {
      if (!this.#inStep) return; // step ended or build ended while timer was pending
      // No new events within crash timeout — build likely crashed
      this.#buildActive = false;
      this.#inStep = false;
      this.#crashTimer = null;
      this.#broadcast({
        type: 'system', subtype: 'build_end',
        status: 'crashed', _source: 'build'
      });
      // After synthetic crash, suppress further events from the dead build.
      // Set #lastSeq to Infinity so all subsequent events with _seq values from this
      // build are deduped. If a new build_start arrives (new file with reset _seq=0),
      // the inode-based cursor reset also resets #lastSeq to -1, allowing the new build
      // through. This prevents late-arriving events from the crashed build from
      // broadcasting after the synthetic build_end.
      this.#lastSeq = Infinity;
    }, this.#crashTimeoutMs);
    this.#crashTimer.unref();
  }

  _mapEvent(event) {
    // Track build lifecycle for crash detection
    if (event.type === 'build_start') {
      this.#buildActive = true;
      this.#inStep = false;
    }
    if (event.type === 'build_step_start') {
      this.#inStep = true;
      this._resetCrashTimer(); // only time during active step execution
    }
    if (event.type === 'build_step_done' || event.type === 'build_gate') {
      this.#inStep = false;
      // Clear crash timer during gates (human waits) and between steps
      if (this.#crashTimer) { clearTimeout(this.#crashTimer); this.#crashTimer = null; }
    }
    if (event.type === 'build_gate_resolved') {
      // Gate resolved — next step will start soon, no crash timer yet
    }
    if (event.type === 'build_end') {
      this.#buildActive = false;
      this.#inStep = false;
      if (this.#crashTimer) { clearTimeout(this.#crashTimer); this.#crashTimer = null; }
    }
    // See Section 4 for the full mapping table
    return mapBuildEventToSSE(event);
  }
}
```

**Integration in `agent-server.js`:**

```javascript
import { BuildStreamBridge } from './build-stream-bridge.js';

// After server.listen():
const bridge = new BuildStreamBridge(
  path.join(TARGET_ROOT, '.compose'),
  broadcast
);
bridge.start();

// In shutdown():
bridge.stop();
```

### 3.3 Event Type Mapping — Correcting the P2 Issue

The STRAT-COMP-4 parent design proposed mapping build events directly to existing SDK message types (`system/init`, `compact_boundary`). This is wrong for two reasons:

1. **`system/init` is reserved.** `AgentStream.jsx:141` captures `session_id` from `system/init` messages and writes it to `sessionStorage`. A build event masquerading as `system/init` would overwrite the interactive session ID, breaking session resume.

2. **`compact_boundary` is unrendered.** `MessageCard.jsx` has no handler for subtype `compact_boundary` — it falls through to `return null`. Using it as a step separator would be invisible.

**Solution: New subtypes under existing types.**

Build events use the existing top-level types (`system`, `assistant`, `result`) but with new subtypes that `MessageCard.jsx` handles explicitly. This means the frontend IS affected — `MessageCard.jsx` needs new rendering branches for build-specific subtypes.

The mapping:

| Build JSONL event | SSE message shape | Rendered by |
|---|---|---|
| `build_start` | `{ type: "system", subtype: "build_start", featureCode, flowId, _source: "build" }` | New `BuildStartCard` in MessageCard |
| `build_step_start` | `{ type: "system", subtype: "build_step", stepId, stepNum, totalSteps, agent, flowId, parentFlowId?, _source: "build" }` | New `BuildStepCard` in MessageCard |
| `tool_use` | `{ type: "assistant", message: { content: [{ type: "tool_use", name, input }] }, _source: "build" }` | Existing `AssistantCard` (no change) |
| `assistant` (text) | `{ type: "assistant", message: { content: [{ type: "text", text }] }, _source: "build" }` | Existing `AssistantCard` (no change) |
| `build_step_done` | `{ type: "system", subtype: "build_step_done", stepId, summary, flowId, parentFlowId?, _source: "build" }` | New `BuildStepDoneCard` in MessageCard |
| `build_gate` | `{ type: "system", subtype: "build_gate", stepId, gateType, flowId, parentFlowId?, _source: "build" }` | New `BuildGateCard` in MessageCard |
| `build_gate_resolved` | `{ type: "system", subtype: "build_gate_resolved", stepId, outcome, rationale, flowId, parentFlowId?, _source: "build" }` | New `BuildGateResolvedCard` in MessageCard |
| `build_error` | `{ type: "error", message, source: "build", _source: "build" }` | Existing error handler (no change) |
| `build_end` | `{ type: "system", subtype: "build_end", status, featureCode, _source: "build" }` | New `BuildEndCard` in MessageCard |

**Key principle:** The JSONL file stores raw connector-style fields (`tool`/`input` for tool_use, `content` for assistant text). The bridge **remaps** these into the SDK-style SSE shapes that `_consumeStream()` produces for interactive sessions (`message.content[].type: "tool_use"/"text"`). After remapping, `AssistantCard` and `ToolUseBlock` render build content events identically to interactive ones. Only the structural events (step boundaries, build lifecycle) need new subtypes.

**Scope of streamed content:** Only connector events that pass through `runAndNormalize()` are forwarded to the JSONL stream. This includes the primary agent work (tool calls, text output) for each step. Gate helper interactions, internal Stratum API calls, and other non-connector agent activity are intentionally excluded — they are infrastructure, not user-visible build work.

**Visual attribution:** Build content events (`tool_use`, `assistant`) carry `_source: "build"` but are rendered by the same `AssistantCard` without a build badge in v1. Users distinguish build events from interactive events by context: build events appear between `build_step` and `build_step_done` markers. STRAT-COMP-8 may add explicit source badges if interleaving proves confusing in practice.

### 3.4 Frontend Changes

The P2 correction is acknowledged: **the frontend is affected.** Specifically:

#### MessageCard.jsx

Add handlers for the six new system subtypes. These are lightweight status indicators, not full message cards:

```jsx
// After the system/connected handler:

if (msg.type === 'system' && msg.subtype === 'build_start') {
  return (
    <div className="text-[10px] uppercase tracking-wider py-1"
      style={{ color: 'hsl(var(--accent))', opacity: 0.8 }}>
      build started · {msg.featureCode}
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
      step complete · {msg.stepId}
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
      build {msg.status} {msg.featureCode ? `· ${msg.featureCode}` : ''}
    </div>
  );
}

if (msg.type === 'system' && msg.subtype === 'build_gate') {
  return (
    <div className="text-[10px] uppercase tracking-wider py-1"
      style={{ color: 'hsl(38 90% 60%)' }}>
      gate · {msg.stepId}
    </div>
  );
}

if (msg.type === 'system' && msg.subtype === 'build_gate_resolved') {
  const color = msg.outcome === 'approve'
    ? 'hsl(var(--success, 142 60% 50%))'
    : msg.outcome === 'revise'
    ? 'hsl(38 90% 60%)'
    : 'hsl(var(--destructive))'; // 'kill'
  return (
    <div className="text-[10px] py-0.5"
      style={{ color, opacity: 0.8 }}>
      gate {msg.outcome} · {msg.stepId}
    </div>
  );
}
```

#### AgentStream.jsx — processMessage() and deriveStatus()

Two changes are needed in `processMessage()`:

1. **`deriveStatus()`** must recognize build-specific subtypes (new return values).
2. **Status application logic** must be replaced with per-source tracking to handle concurrent build + interactive sessions.

The existing message filtering (`skip stream_event, tool_progress, tool_use_summary`) and message appending (`_state.messages.push`) are unchanged and correct for build events.

**`deriveStatus()` additions:**

```javascript
// In deriveStatus():
if (msg.type === 'system' && msg.subtype === 'build_step') {
  return { status: 'working', tool: null, category: 'thinking', _source: 'build' };
}
if (msg.type === 'system' && msg.subtype === 'build_step_done') {
  // Step completed — still working (next step or gate is coming)
  return { status: 'working', tool: null, category: 'thinking', _source: 'build' };
}
if (msg.type === 'system' && msg.subtype === 'build_gate') {
  // Gate reached — show as waiting/paused state
  return { status: 'working', tool: null, category: 'waiting', _source: 'build' };
}
if (msg.type === 'system' && msg.subtype === 'build_gate_resolved') {
  // Gate resolved — back to working
  return { status: 'working', tool: null, category: 'thinking', _source: 'build' };
}
if (msg.type === 'error' && msg.source === 'build') {
  // Build error — still working (build may retry or continue)
  return { status: 'working', tool: null, category: 'thinking', _source: 'build' };
}
if (msg.type === 'system' && msg.subtype === 'build_end') {
  return { status: 'idle', tool: null, category: null, _source: 'build' };
}
// Build content events (tool_use, assistant) carry _source: "build" and go through
// the existing assistant/tool_use derivation path. Inject _source into the result:
if (msg._source === 'build' && msg.type === 'assistant') {
  const toolUse = msg.message?.content?.find(c => c.type === 'tool_use');
  if (toolUse) {
    return { status: 'working', tool: toolUse.name, category: 'tool_use', _source: 'build' };
  }
  return { status: 'working', tool: null, category: 'thinking', _source: 'build' };
}
```

#### AgentStream.jsx — Source-Aware Status Transition Logic

The current `setAgentStatus()` in `processMessage()` unconditionally sets the status bar state from `deriveStatus()`. With both build and interactive sources producing status updates, a naive implementation would cause race conditions — a `build_end` (idle) could clear the status bar while an interactive session is still working, or vice versa.

**Required change:** `processMessage()` must track status per source and only show idle when ALL sources are idle. The existing `setAgentStatus(status, tool, category)` takes positional arguments — the per-source tracking wraps the call but does not change its signature. The existing 2s idle debounce (currently in `processMessage()` at line 130-134) is preserved in the merged logic below. Implementation:

```javascript
// Module-level state addition:
_state.sourceStatus = { build: null, interactive: null }; // last derived status per source

// In processMessage(), replace the existing derived/setAgentStatus block:
const derived = deriveStatus(msg);
if (derived) {
  const source = derived._source || 'interactive';
  _state.sourceStatus[source] = derived;

  // Merge: show 'working' if ANY source is working.
  // Priority: interactive > build (interactive is user-facing).
  const iw = _state.sourceStatus.interactive;
  const bw = _state.sourceStatus.build;
  const workingEntry = (iw?.status === 'working' ? iw : null)
                    || (bw?.status === 'working' ? bw : null);

  if (workingEntry) {
    // Cancel any pending idle debounce timer
    if (_state._idleTimer) { clearTimeout(_state._idleTimer); _state._idleTimer = null; }
    // setAgentStatus takes positional args: (status, tool, category)
    setAgentStatus(workingEntry.status, workingEntry.tool, workingEntry.category);
  } else {
    // All sources idle — use existing idle debounce
    if (_state._idleTimer) clearTimeout(_state._idleTimer);
    _state._idleTimer = setTimeout(() => {
      _state._idleTimer = null;
      setAgentStatus('idle', null, null);
    }, IDLE_DEBOUNCE_MS);
  }
}
```

This correctly handles concurrent build + interactive sessions: a `build_end` (idle) does not clear the status bar while an interactive session is still working, and vice versa. Each source's status is tracked independently.

#### AgentStream.jsx — Build vs Interactive Discrimination

The `isFirstMessage` check (line 265) determines whether the next user input creates a new session or resumes. It returns `true` only when every message in `_state.messages` matches `m.type === 'system' && (m.subtype === 'init' || m.subtype === 'connected')`. Build events use different subtypes (`build_start`, `build_step`, etc.), so they FAIL this predicate. This means once any build event is in the message list, `isFirstMessage` becomes `false`.

**Edge case: build-only messages with stored sessionId.** `handleSend()` (line 309) checks `isFirstMessage || !_state.sessionId`. With build events present, `isFirstMessage` is `false`. The branching then depends solely on `_state.sessionId`:

- **`_state.sessionId` set** (from a prior `system/init` in this page session): `handleSend()` resumes that session. This is correct — the user had an interactive session, build events appeared, and now they continue their session.
- **`_state.sessionId` is null** (no prior interactive session, fresh page load): `!_state.sessionId` is true, so `handleSend()` creates a new session. Also correct.

Note: `sessionStorage` stores session IDs across page reloads. In `connectToSSE()` (line 167), `sessionStorage.getItem()` is read into a local variable but is currently unused (not sent to the server or assigned to `_state.sessionId`). `_state.sessionId` is set exclusively by the `system/init` handler (line 142). Build events never emit `system/init`, so they never set `_state.sessionId`. `handleSend()` (line 309) checks `_state.sessionId` directly, not `sessionStorage`. Both paths are safe.

#### AgentStream.jsx — Reconnect / Server Restart Handling

When the SSE connection drops and reconnects (`EventSource` fires `open` after an `error`), two things happen:

1. **Build status reset:** `_state.sourceStatus.build` is reset to `null` (idle). This prevents stale build-working state from persisting after a reconnect that missed the `build_end` event. The reset happens in the existing `es.onopen` handler.
2. **Duplicate message handling on server restart:** If the agent-server restarts, the bridge replays active JSONL from byte 0, which may include events the browser already received. The browser does not deduplicate these — it appends them to `_state.messages`, resulting in duplicate UI entries. This is acceptable for v1: the server restart is rare, the duplicate messages are harmless (same visual output), and the status bar state is correct because the replay re-establishes the current build state. If dedup is needed, STRAT-COMP-8 can add message-level `_seq` tracking on the client.

The interactive source status is not reset on reconnect because it is managed by the session lifecycle (`system/init`).

#### AgentStream.jsx — Late UI Client Visibility

**Scope:** This feature provides **live-only** visibility. Build events are broadcast to SSE clients connected at the time the bridge processes them. If a browser connects after the bridge has already replayed all JSONL events, those earlier events are not re-sent. This is acceptable for v1 — the goal is real-time build monitoring, not historical replay. STRAT-COMP-8 (Active Build Dashboard) may add replay/hydration via a REST endpoint (`GET /api/agent/build-stream`) if historical build visibility is needed.

---

## 4. Event Schema

### JSONL events (written by BuildStreamWriter)

All events share a common envelope:

```json
{
  "type": "<event_type>",
  "_seq": 0,
  "_ts": 1741747200000,
  ...event-specific fields
}
```

| Event type | Fields | When emitted |
|---|---|---|
| `build_start` | `featureCode`, `flowId`, `specPath` | Once after Stratum plan/resume succeeds |
| `build_step_start` | `stepId`, `stepNum`, `totalSteps`, `agent`, `flowId`, `parentFlowId?` | Before connector dispatch (parentFlowId present only for child flow steps) |
| `tool_use` | `tool`, `input` | Each tool call from connector stream |
| `assistant` | `content` | Each text block from connector stream |
| ~~`tool_use_summary`~~ | ~~`summary`~~ | ~~Tool completion summaries~~ (not written — filtered per design decision: skip noisy events at writer) |
| ~~`tool_progress`~~ | ~~`tool`, `elapsed`~~ | ~~Long-running tool ticks~~ (not written — filtered per design decision: skip noisy events at writer) |
| `build_step_done` | `stepId`, `summary`, `flowId`, `parentFlowId?` | After `stratum.stepDone()` returns |
| `build_gate` | `stepId`, `flowId`, `gateType`, `parentFlowId?` | At `await_gate` dispatch |
| `build_gate_resolved` | `stepId`, `outcome`, `rationale`, `flowId`, `parentFlowId?` | After gate resolution |
| `build_error` | `message`, `stepId?` | On error — written in `build.js` at two points: (1) try/catch around `runAndNormalize()` for connector/normalizer errors, and (2) try/catch around post-dispatch operations (`stratum.stepDone()`, `promptGate()`, `stratum.gateResolve()`) for infrastructure errors. Both write points include `stepId` since it is in scope. Errors not caught by these handlers surface only as `build_end(aborted)` via the top-level catch. |
| `build_end` | `status` (`complete`/`killed`/`aborted`), `featureCode` | At build completion (written to JSONL by `BuildStreamWriter.close()`). Note: the bridge may also emit a synthetic `build_end` SSE event with `status: "crashed"` after configurable inactivity timeout (default 300s) — this is bridge-only and never written to JSONL. |

### SSE messages (broadcast by BuildStreamBridge)

The bridge maps JSONL events to shapes compatible with `AgentStream.jsx` / `MessageCard.jsx`. See the mapping table in Section 3.3.

`tool_use` events are re-wrapped into the `assistant.message.content` shape that `AssistantCard` expects:

```json
{
  "type": "assistant",
  "message": {
    "content": [
      { "type": "tool_use", "name": "Edit", "input": { "file_path": "..." } }
    ]
  },
  "_source": "build"
}
```

The `_source: "build"` field is added to all mapped events so downstream consumers (STRAT-COMP-8 dashboard) can distinguish build events from interactive session events.

---

## 5. Files Changed

| File | Change | Description |
|---|---|---|
| `lib/build-stream-writer.js` | New | `BuildStreamWriter` class — JSONL event writer |
| `lib/build.js` | Modify | Instantiate `BuildStreamWriter`, emit lifecycle events (`build_start`, `build_step_start`, `build_step_done`, `build_gate`, `build_end`) |
| `lib/result-normalizer.js` | Modify | Accept optional `streamWriter` in opts, forward `tool_use` and `assistant` events (skip `tool_progress`, `tool_use_summary`, `error`, `result`, `system` per design decision: skip noisy events at writer; errors are handled by `build.js` catch block) |
| `server/build-stream-bridge.js` | New | `BuildStreamBridge` class — tails JSONL, maps events, calls `broadcast()` |
| `server/agent-server.js` | Modify | Import `BuildStreamBridge`, instantiate on startup, stop on shutdown |
| `src/components/agent/MessageCard.jsx` | Modify | Add rendering branches for `build_start`, `build_step`, `build_step_done`, `build_gate`, `build_gate_resolved`, `build_end` subtypes |
| `src/components/AgentStream.jsx` | Modify | Extend `deriveStatus()` to handle `build_step`, `build_step_done`, `build_gate`, `build_gate_resolved`, `build_error` (all working), and `build_end` (idle); add `waiting` to `CATEGORY_LABELS`; add per-source status tracking in `_state.sourceStatus`; replace `processMessage()` status application logic with source-aware merge; reset `_state.sourceStatus.build` on SSE reconnect |

---

## 6. Acceptance Criteria

### Prerequisites (blocking — must be done before implementation)

- [ ] **STRAT-COMP-4 reconciliation:** Update `compose/docs/features/STRAT-COMP-4/design.md` lines 172-183 and 190-200 to reference this document as the authoritative source for build-stream JSONL event schema. Remove or supersede the `event`-keyed schema definitions and the "frontend unchanged" claim. Record the schema change as an approved deviation.
- [ ] **Companion doc alignment:** Update `blueprint.md` and `plan.md` to reflect the design changes made during this review (build_error single write point, expanded AgentStream.jsx surface, per-source status tracking, CATEGORY_LABELS addition, reconnect reset).

### Implementation Criteria

- [ ] `BuildStreamWriter` creates `.compose/build-stream.jsonl` at build start
- [ ] `BuildStreamWriter` truncates stale JSONL from previous build on new build start
- [ ] `build.js` emits `build_start` event once after Stratum plan/resume succeeds (not at `runBuild()` entry) with `featureCode`, `flowId`, and `specPath` fields
- [ ] `build.js` emits `build_step_start` before each connector dispatch with `stepId`, `stepNum`, `totalSteps`, `agent`, `flowId`
- [ ] `result-normalizer.js` forwards `tool_use` and `assistant` events to writer when `streamWriter` option is provided (skips `tool_progress`, `tool_use_summary`, `error`, `result`, `system`; errors are written by `build.js` catch block only)
- [ ] `build.js` emits `build_step_done` after each successful `stratum.stepDone()` with `stepId`, result summary, and `flowId`
- [ ] `build.js` emits `build_gate` at each `await_gate` dispatch with `stepId`, `flowId`, and `gateType`
- [ ] `build.js` emits `build_gate_resolved` after gate resolution with `stepId`, `outcome`, `rationale`, and `flowId`
- [ ] `BuildStreamBridge` maps `build_gate_resolved` to `{ type: "system", subtype: "build_gate_resolved", stepId, outcome, rationale, flowId, _source: "build" }`
- [ ] `build.js` emits `build_end` at build completion with `status` (`complete`/`killed`/`aborted`) and `featureCode`
- [ ] `build_end` is emitted for all termination paths: normal completion (`complete`), SIGINT/SIGTERM (`killed`), unhandled errors (`aborted`). External `compose build --abort` produces `build_end(aborted)` on a best-effort basis (depends on the running process reaching an error after Stratum state deletion; see Section 3.1 terminal event guarantees for details).
- [ ] SIGINT/SIGTERM handlers are registered in `build.js` after writer creation, set `buildStatus = 'killed'`, throw `BuildKilledError` to unwind to finally block, and are cleaned up via `process.removeListener()` in finally
- [ ] `BuildStreamWriter.close()` writes a `build_end` sentinel and is called in the `finally` block
- [ ] `BuildStreamWriter.close()` is idempotent — calling it multiple times writes exactly one `build_end` event per build
- [ ] `BuildStreamWriter` is created AFTER Stratum plan/resume succeeds (not at `runBuild()` entry, to prevent truncating an active build's stream on rejected invocations)
- [ ] `executeChildFlow()` emits `build_step_start`, `build_step_done`, `build_gate`, and `build_gate_resolved` for child flow steps/gates with the child flow's `flowId` and `parentFlowId`
- [ ] `BuildStreamBridge` tails `.compose/build-stream.jsonl` using `fs.watch` on the parent directory
- [ ] `BuildStreamBridge` catches up from byte 0 on startup if the file already exists
- [ ] `BuildStreamBridge` detects file replacement via inode change (`stat.ino !== #lastIno`) and resets `#cursor` and `#lastSeq`, even when new file is larger than old cursor
- [ ] `BuildStreamBridge` deduplicates events using `_seq` monotonic counter
- [ ] `BuildStreamBridge` maps `tool_use` events to `{ type: "assistant", message: { content: [{ type: "tool_use", name, input }] }, _source: "build" }` shape matching SDK format
- [ ] `BuildStreamBridge` maps `assistant` text events to `{ type: "assistant", message: { content: [{ type: "text", text }] }, _source: "build" }` shape matching SDK format
- [ ] `BuildStreamBridge` maps lifecycle events to `system` type with build-specific subtypes (not `init`, not `compact_boundary`)
- [ ] `BuildStreamBridge` adds `_source: "build"` to all mapped events
- [ ] `BuildStreamBridge` preserves `flowId` on all mapped structural events (`build_start`, `build_step`, `build_step_done`, `build_gate`, `build_gate_resolved`) for STRAT-COMP-8 hierarchy reconstruction
- [ ] `agent-server.js` creates `BuildStreamBridge` on startup, stops it on shutdown
- [ ] `MessageCard.jsx` renders `build_start` as feature code header
- [ ] `MessageCard.jsx` renders `build_step` as step progress indicator
- [ ] `MessageCard.jsx` renders `build_step_done` as step completion marker
- [ ] `MessageCard.jsx` renders `build_gate` as gate notification
- [ ] `MessageCard.jsx` renders `build_gate_resolved` as gate outcome indicator (approve=green, revise=amber, kill=red) with stepId
- [ ] `MessageCard.jsx` renders `build_end` as build status indicator: green for `complete`, red for `killed`/`aborted`/`crashed`
- [ ] `AgentStream.jsx` `deriveStatus()` returns `working` for `build_step`, `build_step_done`, `build_gate`, `build_gate_resolved`, and `build_error` (all with `_source: "build"`)
- [ ] `AgentStream.jsx` `deriveStatus()` returns `idle` (with `_source: "build"`) for `build_end`
- [ ] `AgentStream.jsx` `deriveStatus()` returns `category: "waiting"` for `build_gate` (gate pending). Note: `CATEGORY_LABELS` in `AgentStream.jsx` must be extended to include a `waiting` entry (e.g., `waiting: "Waiting for gate approval"`) for the status bar to display this state meaningfully.
- [ ] `processMessage()` per-source status tracking prevents build idle from overriding interactive working state (and vice versa)
- [ ] `processMessage()` tracks per-source status in `_state.sourceStatus` and only shows idle when all sources are idle
- [ ] `BuildStreamBridge` polling interval uses `.unref()` so it does not keep the process alive
- [ ] `BuildStreamBridge.stop()` clears the poll interval if active
- [ ] `BuildStreamBridge._readNewLines()` implements size-based cursor reset as secondary fallback (when `stat.size < #cursor` without inode change)
- [ ] Build events do NOT interfere with interactive session ID (`system/init` is never emitted by bridge)
- [ ] Build events render alongside interactive session events in the same stream (no separate view)
- [ ] `BuildStreamBridge` maps `build_error` to `{ type: "error", message, source: "build", _source: "build" }` and existing error handler in `MessageCard.jsx` renders it
- [ ] `BuildStreamBridge` skips replay of stale builds on startup: stale if last line is `build_end` (completed/killed/aborted) OR file mtime exceeds crash timeout (default 300s, covers crashed builds with no sentinel and malformed-last-line cases)
- [ ] `BuildStreamBridge` emits synthetic `build_end` with `status: "crashed"` after configurable inactivity timeout (default 300s) only when `#inStep` is true (not during gates or between steps)
- [ ] After synthetic crash `build_end`, bridge suppresses late events from the dead build (sets `#lastSeq` to `Infinity`); a new build resets via inode-based cursor reset
- [ ] Crash timeout is configurable via constructor to accommodate workloads with long silent steps; false-positive crash detection is a known limitation documented in edge cases
- [ ] `BuildStreamBridge._readNewLines()` buffers incomplete trailing lines to prevent partial-write data loss
- [ ] Feature provides live-only visibility (no replay for late-connecting SSE clients after bridge has already processed events)
- [ ] **End-to-end:** A browser connected to `GET /api/agent/stream` sees real-time build lifecycle events (step start/done, gates, completion) and tool/assistant content while `compose build` runs, without disrupting any concurrent interactive session
- [ ] On SSE reconnect, `_state.sourceStatus.build` is reset to `null` to prevent stale build-working state

### Verification Criteria (automated tests required)

- [ ] **Bridge startup:** Test that stale files (with `build_end` last line) are skipped, active files are replayed, and gate-pending files are treated as active unless older than 24h (gates are exempt from the crash-timeout check but have their own 24h staleness limit per Section 3.2 pseudocode)
- [ ] **Crash timeout:** Test that synthetic `build_end(crashed)` fires after timeout during `#inStep`, does NOT fire during gates, and suppresses late events via `#lastSeq = Infinity`
- [ ] **SSE reconnect:** Test that `_state.sourceStatus.build` resets to `null` on `es.onopen`
- [ ] **Per-source status merge:** Test that build idle does not clear interactive working, interactive idle does not clear build working, and both idle produces idle
- [ ] **Signal termination:** Test that SIGINT/SIGTERM produces `build_end(killed)` in the JSONL file and handlers are cleaned up
- [ ] **Stale gate:** Test that bridge treats gate-pending files older than 24h as stale on startup
- [ ] Build-only messages in the stream do not alter session-creation behavior: `handleSend()` checks `_state.sessionId` (set only by `system/init`, never by build events). If `_state.sessionId` is set (from a prior interactive session in this page session), `handleSend()` resumes. If `_state.sessionId` is null, `handleSend()` creates a new session. Build events never emit `system/init` and never set or clear `_state.sessionId`.

---

## 7. Edge Cases

| Scenario | Handling |
|---|---|
| Build starts before agent-server | Bridge checks freshness: stale if last line is `build_end` OR file mtime exceeds crash timeout (default 300s). Stale files are skipped (cursor set to EOF). Active files are replayed from byte 0. |
| Agent-server starts, no build running | Bridge watches directory; no file = no events = idle |
| Build finishes, new build starts | Writer truncates JSONL on construction (`unlinkSync` + fresh file). Bridge detects file replacement via inode change (`stat.ino !== #lastIno`) and resets `#cursor` to 0 and `#lastSeq` to -1. This works even when the new file is larger than the old cursor position. Size-based reset (`stat.size < #cursor`) is a secondary fallback. |
| `.compose/` directory doesn't exist at server start | Bridge polls for directory creation every 2s, starts watching once it appears |
| JSONL file grows very large (long build with many tool calls) | Cursor-based reads mean memory usage includes the full file buffer on each read; however, parsed lines are processed incrementally and discarded. For very large build logs, consider switching to fd-based offset reads (`fs.open` + `fs.read` from cursor position) to avoid re-reading processed bytes. File is truncated on next build start |
| Partial write (fs.watch fires mid-line) | Unlikely but possible: `appendFileSync` writes a complete JSON line in a single syscall, but there is no atomicity guarantee for regular files (unlike pipes). If `fs.watch` fires while a write is in progress, the bridge handles it safely: `_readNewLines()` buffers incomplete trailing lines (those not terminated by `\n`) and holds them until the next read completes them. This ensures no events are lost even in the unlikely partial-read case. |
| Malformed JSON line in JSONL | `JSON.parse` wrapped in try/catch; malformed lines are skipped and logged via `console.debug` when `DEBUG` env var is set |
| Two rapid writes (e.g., step_done + step_start) | `fs.watch` may coalesce events, but `_readNewLines()` reads all bytes from cursor to EOF, so both lines are processed |
| Build crashes mid-step | No `build_end` sentinel is written. Bridge keeps tailing. On next build start, stale file is truncated. Frontend sees the stream stop. The bridge detects inactivity: the crash timer runs only when `#inStep` is true (between `build_step_start` and `build_step_done`/`build_gate`). During gates or between steps, the crash timer is not active — human wait times are unbounded and should not trigger false crashes. If no new JSONL events arrive within the configurable timeout (default 300s / 5 minutes) while `#inStep` is true, the bridge resets `#buildActive` and `#inStep` to false and broadcasts a synthetic `{ type: "system", subtype: "build_end", status: "crashed", _source: "build" }` event. The 5-minute default is conservative and configurable. During a step, `tool_use` and `assistant` events reset the timer (since `tool_progress` is filtered at the writer). A step that produces no `tool_use` or `assistant` events for 5 continuous minutes is assumed crashed. If this proves too aggressive for specific workloads, the timeout can be increased via constructor options without code changes. |
| `fs.watch` unreliable on macOS | Known issue. Mitigation: `_readNewLines()` is idempotent via cursor, so redundant `fs.watch` fires are cheap. A 50ms debounce reduces syscalls. If `fs.watch` proves too unreliable in practice, add a 1s poll fallback alongside the watcher |
| Concurrent interactive session + build | Both streams broadcast to the same SSE clients. Events interleave in the message list. `_source: "build"` field lets STRAT-COMP-8 filter if needed. Interactive session ID is not affected (build never emits `system/init`). **Status bar:** `processMessage()` tracks per-source status in `_state.sourceStatus = { build, interactive }`. The status bar shows `working` if ANY source is working, and `idle` only when ALL sources are idle. A `build_end` (idle) does not clear the status bar while an interactive session is still working, and vice versa. |
| Child flows / nested `execute_flow` | Writer is passed through `executeChildFlow`. Child flow step events (`build_step_start`, `build_step_done`, `build_gate`, `build_gate_resolved`) carry the child's `flowId` plus a `parentFlowId` field linking to the parent flow. This is sufficient for STRAT-COMP-8 to reconstruct the hierarchy without separate boundary events. All interleaved in the same JSONL stream. |
| Multiple SSE clients | `broadcast()` already iterates `_sseClients` Set — no change needed |
| `--through` partial stop or resume | When `compose build --through <step>` completes, the writer calls `close('complete')` normally. The JSONL file shows a complete build (from the bridge's perspective). On resume, the writer truncates the old file and starts fresh — previous partial build events are not preserved. This is consistent with the single-file design. |
| Concurrent builds in same workspace | Not supported. `compose build` is designed to run one build at a time per workspace. The `active-build.json` check in `build.js` (line ~149, ~176) prevents a second build from starting while one is active. If a second build is forced or the lock is stale, the writer truncates the existing JSONL file (replacing the first build's stream). Concurrent builds are outside the scope of this feature. |

---

## 8. Open Questions

1. ~~**Should the bridge debounce reads?**~~ Resolved. The bridge uses a 50ms debounce on `_readNewLines()` calls to reduce syscalls from coalesced `fs.watch` events on macOS.

2. **Should `tool_progress` events be forwarded to SSE?** They are currently skipped by `processMessage()` in `AgentStream.jsx` (line 147). Forwarding them would mean they are written to JSONL but silently dropped by the frontend. This is harmless but wasteful. The writer could skip them, or the bridge could filter them. Decision: skip at the writer level to keep the JSONL file smaller.

3. **File rotation strategy.** Current design truncates on new build. Should we keep a history of past build streams (e.g., `build-stream-{flowId}.jsonl`)? Pro: debugging. Con: disk usage, complexity. Recommendation: single file for now; add rotation when STRAT-COMP-8 dashboard needs historical replay.

4. **Should the bridge expose a REST endpoint for JSONL replay?** A `GET /api/agent/build-stream` endpoint could return the full JSONL for late-connecting clients. This overlaps with the bridge's catch-up-from-byte-0 behavior but would let the frontend request build history on page load. Defer to STRAT-COMP-8 if needed.

5. **~~Encoding safety.~~** Resolved. The `_readNewLines()` pseudocode now reads as `Buffer` (no encoding arg) and uses `buf.length` (which is byte length on Buffers). The slice is converted to UTF-8 string only after cursor advancement. This handles multi-byte characters correctly.
