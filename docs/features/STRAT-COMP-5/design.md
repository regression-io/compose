# Design: Build Visibility (STRAT-COMP-5)

**Feature:** Extend server file watcher to `.compose/` and `active-build.json`, broadcast build state via WebSocket
**Status:** Design
**Date:** 2026-03-12

---

## Problem

When a user runs `compose build <featureCode>`, the CLI writes real-time state to `.compose/data/active-build.json` (current step, flow ID, start time). The UI's `StratumPanel.jsx` has no awareness of this file — it only learns about builds by polling the Stratum MCP server (`GET /api/stratum/flows` every 15s, `GET /api/stratum/gates` every 10s).

This creates two gaps:

1. **Latency**: Build step transitions take up to 15 seconds to surface in the UI.
2. **Source of truth split**: The running build's current step lives in `active-build.json`, but the UI reads from Stratum's flow record, which only reflects completed steps.

**Goal:** The UI should know in near-real-time when a build starts, advances, or finishes — down to the current step ID — primarily via WebSocket push events. A lightweight 30s REST poll on `/api/build/state` (single file read) is added as a fallback for cases where `fs.watch` misses events. Existing Stratum polling intervals (15s flows, 10s gates) remain unchanged.

---

## Solution Overview

Extend `FileWatcherServer` to watch `.compose/data/active-build.json`. When the file is created or updated, broadcast a `buildState` WebSocket message over the existing `/ws/vision` channel (the semantic state channel). Wire the callback through `server/index.js` and handle it in the frontend message dispatcher. The message shape conforms to the STRAT-COMP-4 parent contract (see `docs/features/STRAT-COMP-4/design.md:161-163`).

---

## Architecture

### Current Flow (Polling)

```
lib/build.js
  writeActiveBuild() → .compose/data/active-build.json (file write, disk only)
  updateActiveBuildStep() → ditto

StratumPanel.jsx
  setInterval(15s) → GET /api/stratum/flows → renders flow list
  setInterval(10s) → GET /api/stratum/gates → renders gate queue
```

### Target Flow (Push + Polling)

```
lib/build.js
  writeActiveBuild() → .compose/data/active-build.json
                                     ↓
server/file-watcher.js
  fs.watch(.compose/data/) → debounce 100ms → onBuildStateChanged(state)
                                     ↓
server/index.js
  fileWatcher.onBuildStateChanged = (state) →
    visionServer.broadcastMessage({ type: 'buildState', ...state })
                                     ↓
ws://localhost:3001/ws/vision
                                     ↓
src/components/vision/visionMessageHandler.js
  'buildState' → setActiveBuild(state)
                                     ↓
StratumPanel.jsx / build state indicator
  renders current featureCode + currentStepId in real time
```

---

## Detailed Design

### 1. `server/file-watcher.js` — Watch `.compose/data/`

**Change:** Add a third `watchDir()` call in `startWatching()` targeting the data directory. Filter on `active-build.json` only (avoids noise from `vision-state.json` churn). On change, read and parse the file. Fire `this.onBuildStateChanged(state)` where `state` is the parsed object, or skip broadcast if the file cannot be parsed.

```
startWatching()
  const self = this;
  ...existing docs/ watcher...
  ...existing features/ watcher...

  // NEW: watch .compose/data/ for active-build.json changes
  watchDir(dataDir, '.compose/data', (relativePath, fullPath) => {
    if (path.basename(fullPath) !== 'active-build.json') return;

    let state = null;
    try {
      if (fs.existsSync(fullPath)) {
        state = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
      }
    } catch { /* parse error → state remains null */ }

    if (typeof self.onBuildStateChanged === 'function') {
      self.onBuildStateChanged(state);
    }
  });
```

**Debounce:** `active-build.json` is written in two stages — initial creation and step updates. Reuse the existing 100ms debounce map (the current default for all `watchDir()` calls). 100ms is chosen to coalesce rapid writes while keeping latency well under 500ms.

**Parameterized file filter:** The current `watchDir()` implementation at `file-watcher.js:146` hardcodes `if (!filename || !filename.endsWith('.md')) return;` *before* the callback is ever invoked. This means a third `watchDir()` call for `.compose/data/` would silently drop `active-build.json` events. To fix this, refactor `watchDir()` to accept an optional `fileFilter` parameter (default: `(f) => f.endsWith('.md')` for backward compatibility). Replace the hardcoded `.md` check with `!fileFilter(filename)`. The new `.compose/data/` caller passes `(f) => f === 'active-build.json'`.

**Directory creation in `startWatching()`:** `FileWatcherServer.attach()` is called at `server/index.js:54`, *before* `ensureDataDir()` at line 55, so `.compose/data/` may not exist when `startWatching()` runs. To handle this, `startWatching()` calls `ensureDataDir()` itself (imported from `./project-root.js`) to guarantee the directory tree exists before registering the watcher. This is idempotent (safe to call multiple times) and eliminates the timing gap. No lazy watcher or parent-directory watching is needed.

Guard against double-registration with a `dataDirWatcherRegistered` boolean flag.

**Atomic writes:** `writeActiveBuild()` in `lib/build.js` must use temp-file + rename (`writeFileSync(tmpPath, data)` then `renameSync(tmpPath, targetPath)`) to ensure the watcher always reads a complete file. Without atomic writes, the watcher can fire mid-write and read partial JSON — which would be broadcast as `state: null`, falsely signaling "build finished" and causing the UI to clear active state mid-build. With atomic writes, parse errors can safely be treated as `state: null` since they indicate genuine file corruption rather than a race condition.

### 1b. `lib/build.js` — Extended state field population

Per the STRAT-COMP-4 contract, the `active-build.json` state includes: `featureCode`, `flowId`, `pipeline` (workflow name, e.g., `"build"`), `currentStepId`, `stepNum`, `totalSteps`, `retries`, `violations: string[]` (violation messages), `status` (`"running"` | `"complete"` | `"failed"` | `"aborted"`), `startedAt`, and `completedAt?` (ISO-8601, set on terminal state). Note: the field is `currentStepId` (matching the existing `build.js` field name and the STRAT-COMP-4 contract), and `violations` is `string[]` (violation messages, not a count), per the STRAT-COMP-4 contract. The field `specPath` is retained from the existing payload.

The fields are populated as follows:

- **`startFresh()` (line 490-496):** The initial `writeActiveBuild()` call sets `pipeline: 'build'`, `currentStepId: response.step_id`, `stepNum: response.step_number ?? 1`, `totalSteps: response.total_steps ?? null`, `retries: 0`, `violations: []`, `status: 'running'`. The `step_number` and `total_steps` come from the Stratum dispatch response (already used at line 194-195).
- **`updateActiveBuildStep()` (line 501-507):** Extend signature to `updateActiveBuildStep(dataDir, stepId, extra = {})`. After setting `currentStepId`, merge `extra` via `Object.assign(state, extra)`. This preserves backward compatibility (existing callers pass no third argument).
- **Top-level `execute_step` block (line 202):** Update the existing call to `updateActiveBuildStep(dataDir, stepId, { stepNum: response.step_number, totalSteps: response.total_steps })`.
- **Top-level `ensure_failed`/`schema_failed` block (line 269-284):** Add a NEW `updateActiveBuildStep()` call (none exists currently) to pass `{ retries: (currentState.retries || 0) + 1, violations: response.violations || [] }`. Read current state via `readActiveBuild(dataDir)` to get the current retry count. Cap `violations` to last 10 entries.
- **Build completion (after the dispatch loop exits):** Write a final terminal state with `status: 'complete'` (or `'failed'`/`'aborted'` as appropriate) and `completedAt: new Date().toISOString()`. Per the STRAT-COMP-4 contract, the file remains on disk for audit — it is NOT deleted. It is overwritten on the next `compose build` start.
- **`compose build --abort` / SIGINT handler:** Write terminal state with `status: 'aborted'` and `completedAt`.
- **Stratum `killed` response:** Maps to `status: 'aborted'`.
- **Unrecoverable exceptions / exhausted retries:** Map to `status: 'failed'`.
- **Child flow failures** (inside `executeChildFlow`): The child flow completes with an error result propagated to the parent. The parent loop handles the failure status. The terminal state is only written once, at the top-level loop exit.
- **`--through` / partial build:** When `compose build --through <step>` is used, the build intentionally stops after a specific step/gate. This maps to `status: 'complete'` with `completedAt` set, since the build finished successfully through the requested phase. The `currentStepId` reflects the last executed step.
- **Resume/locking semantics:** Only `status: 'running'` blocks a new build. Terminal statuses (`complete`, `failed`, `aborted`) do not block — a new build start overwrites the file.

### 1c. `lib/build.js` — Nested flow step tracking

Currently, `updateActiveBuildStep(dataDir, stepId)` is only called in the top-level `execute_step` handler (line 202). The build pipeline uses sub-flows (`artifact-review`, `review-check`, `coverage-check`) dispatched via `execute_flow`, and those steps are handled by `executeChildFlow()` (line 366) which does NOT call `updateActiveBuildStep()`. This means the UI misses step transitions during child flow execution.

**Fix:** Add `updateActiveBuildStep()` calls inside `executeChildFlow()`:
- In the `execute_step` handler (line 375): call `updateActiveBuildStep(dataDir, resp.step_id)` after the vision writer update at line 381
- In the `ensure_failed`/`schema_failed` handler (line 428): add `updateActiveBuildStep(dataDir, resp.step_id, { retries: (currentState.retries || 0) + 1, violations: resp.violations || [] })` to track retries and violations during child flow execution, not just in the top-level loop
- In the `execute_flow` handler (line 464, nested recursion): the recursive call to `executeChildFlow` will handle its own tracking

Additionally, add `updateActiveBuildStep()` calls for gate transitions:
- In the top-level `await_gate` handler (line 217): call `updateActiveBuildStep(dataDir, stepId)` so the UI shows the current gate step
- In `executeChildFlow`'s `await_gate` handler (line 397): call `updateActiveBuildStep(dataDir, resp.step_id)` for child flow gate transitions

This ensures `currentStepId` in `active-build.json` reflects the currently executing step regardless of flow nesting depth, including gate steps, and retry/violation state is updated for both top-level and nested flow failures.

### 2. `server/index.js` — Wire the Callback

```javascript
fileWatcher.onBuildStateChanged = (state) => {
  if (state) {
    // Broadcast flat payload per STRAT-COMP-4 contract
    visionServer.broadcastMessage({ type: 'buildState', ...state });
  }
  // Per STRAT-COMP-4, the file is never deleted — it remains on disk with
  // terminal status. If state is null (parse error or unexpected deletion),
  // we simply don't broadcast. The 30s polling fallback handles recovery.
};
```

This follows the exact pattern of the existing `onFeatureChanged` wiring (lines 76–84).

### 3. `server/vision-server.js` — REST Endpoint for Initial State

Add `GET /api/build/state` so clients can hydrate on WebSocket reconnect:

```
GET /api/build/state
→ reads .compose/data/active-build.json
→ returns { state: <object> | null }
```

Place this endpoint directly in `vision-server.js` inside `VisionServer.attach()`, alongside the existing session and Stratum routes. The endpoint is a single file read — not enough to justify a new module. Import `fs` from `node:fs` and `DATA_DIR` from `./project-root.js` in `vision-server.js`.

### 4. `src/components/vision/visionMessageHandler.js` — Handle New Message Type

Add a case for `buildState`:

```javascript
case 'buildState':
  // Per STRAT-COMP-4: flat payload, status field determines active vs terminal
  actions.setActiveBuild(msg);
  break;
```

The UI interprets `activeBuild.status === 'running'` as an active build and renders the active-build indicator. Terminal statuses (`complete`, `failed`, `aborted`) render a completion banner: `complete` auto-dismisses after 5s, while `failed`/`aborted` remain visible until dismissed by the user or replaced by the next build.

**Banner suppression on hydration:** To prevent a dismissed terminal banner from reappearing on reconnect/page refresh/30s poll, `StratumPanel` tracks the last dismissed `flowId + completedAt` pair in component state. If the hydrated `activeBuild` matches a previously dismissed terminal state, it is suppressed. This state is ephemeral (lost on full page reload), which is acceptable since the user can re-dismiss.

`useVisionStore.js` adds `activeBuild` (initially `null`) and the `setActiveBuild` action. Call `setActiveBuild(null)` to clear.

**Client hydration:** On mount, `useVisionStore` adds a `useEffect` that fetches `GET /api/build/state` and calls `setActiveBuild(data.state ?? null)` — always updating the state, including setting it to `null` when no build is active. The endpoint returns `{ state: <flat object> | null }`. This runs once on initial render (after the existing session hydration `useEffect` at line 141).

**Reconnect hydration:** The current WebSocket `onopen` handler (line 104) only calls `setConnected(true)` — it does NOT perform session hydration (that happens in a separate mount `useEffect`). For reconnect, add `fetch('/api/build/state').then(r => r.json()).then(data => setActiveBuild(data.state ?? null)).catch(() => {})` inside the `onopen` handler so that on both initial connect and reconnect, the client re-syncs `activeBuild` state immediately.

### 5. `src/components/StratumPanel.jsx` — React to Push Events

`StratumPanel.jsx` currently polls on intervals. With the WebSocket event, it should:
1. **On `buildState`**: immediately trigger a flows refresh in `FlowList` rather than waiting for the interval. This bridges `active-build.json` (step granularity) with the Stratum flow record (completion state).
2. **Display active build indicator**: show a "build in progress" badge with `state.featureCode` and `state.currentStepId` using `activeBuild` from the shared vision store.

**Refresh plumbing:** `StratumPanel` consumes `activeBuild` from `useVisionStore()` and passes it as a prop to `FlowList`: `<FlowList activeBuild={activeBuild} />`. Inside `FlowList`, a `useEffect` watches the `activeBuild` prop and triggers an immediate `load()` (the existing internal fetch function) when it changes. `FlowList` does NOT call `useVisionStore()` directly — it receives `activeBuild` via props only.

**State ownership note:** `useVisionStore()` is currently a local hook — each component that calls it gets its own WebSocket connection and independent state. It is already used by both `VisionTracker.jsx` and will be used by `StratumPanel`. Each instance maintains its own `activeBuild` state, but both receive the same `buildState` WebSocket messages, so they stay in sync as long as both connections are active. `StratumPanel` passes `activeBuild` down to `FlowList` via props rather than having `FlowList` create yet another hook instance. If this per-instance model becomes problematic (e.g., connection count, state drift on reconnect), refactor to a shared React context provider in a follow-up.

**Polling fallback for step-level data:** The existing polling intervals (15s flows, 10s gates) only reflect completed steps from Stratum, NOT the `currentStepId` from `active-build.json`. If `fs.watch` misses a step-change event, the active-build indicator would show a stale step. To cover this gap, add a periodic `fetch('/api/build/state')` every 30s inside `useVisionStore` that re-syncs `activeBuild` from the REST endpoint. Placing this in `useVisionStore` (not `StratumPanel`) ensures all consumers of the hook benefit from the fallback. This is cheap (single file read) and ensures self-correction within 30s. Existing Stratum polling intervals remain unchanged.

---

## Message Schema

Per the STRAT-COMP-4 contract (`docs/features/STRAT-COMP-4/design.md:161-163`), the `buildState` message uses a flat payload:

```json
{
  "type": "buildState",
  "featureCode": "STRAT-COMP-5",
  "flowId": "7f9d436c-2968-40a1-863e-6d76987f9ca0",
  "pipeline": "build",
  "currentStepId": "explore_design",
  "specPath": "pipelines/build.stratum.yaml",
  "stepNum": 3,
  "totalSteps": 12,
  "retries": 0,
  "violations": [],
  "status": "running",
  "startedAt": "2026-03-12T04:41:42.337Z"
}
```

Terminal state (build completed — file remains on disk per STRAT-COMP-4, overwritten on next build):

```json
{
  "type": "buildState",
  "featureCode": "STRAT-COMP-5",
  "flowId": "7f9d436c-2968-40a1-863e-6d76987f9ca0",
  "pipeline": "build",
  "currentStepId": "ship_gate",
  "specPath": "pipelines/build.stratum.yaml",
  "stepNum": 24,
  "totalSteps": 24,
  "retries": 0,
  "violations": [],
  "status": "complete",
  "startedAt": "2026-03-12T04:41:42.337Z",
  "completedAt": "2026-03-12T05:12:33.000Z"
}
```

The file is never deleted — it remains on disk with the terminal status for audit. It is overwritten when the next build starts. The UI uses the `status` field to determine display: `running` shows the active-build indicator, terminal statuses (`complete`, `failed`, `aborted`) show a brief completion banner.

---

## Files Changed

| File | Change Type | Description |
|------|------------|-------------|
| `lib/build.js` | Modify | Atomic writes (temp + rename), extend state with `pipeline`, `stepNum`, `totalSteps`, `retries`, `violations: string[]`, `status`, `completedAt`, terminal state handling (file retained on disk per STRAT-COMP-4), nested flow + gate tracking in `executeChildFlow()`, status mapping for killed/failed/aborted |
| `server/file-watcher.js` | Modify | Parameterize `watchDir()` file filter, add lazy `.compose/data/` watcher with parent-dir fallback, `onBuildStateChanged` callback |
| `server/index.js` | Modify | Wire `fileWatcher.onBuildStateChanged` → `visionServer.broadcastMessage` |
| `server/vision-server.js` | Modify | Attach `GET /api/build/state` endpoint inline in `VisionServer.attach()` |
| `src/components/vision/visionMessageHandler.js` | Modify | Handle `buildState` message type |
| `src/components/vision/useVisionStore.js` | Modify | Add `activeBuild` state, `setActiveBuild` action, mount + reconnect hydration via `GET /api/build/state` |
| `src/components/StratumPanel.jsx` | Modify | Consume `activeBuild` from store, render `ActiveBuildBanner`, trigger immediate `FlowList` refresh on event |

---

## Data Flow for `.compose/` Directory Watch

The feature says "extend server file watcher to `.compose/`". We scope this narrowly to `.compose/data/active-build.json` for the following reasons:

| File | Why Not Watch |
|------|--------------|
| `.compose/data/vision-state.json` | Already managed by `VisionServer`; watching it here would double-broadcast |
| `.compose/data/settings.json` | `SettingsStore` already handles this; no real-time push needed |
| `.compose/breadcrumbs.log` | Log file; high-frequency write with no UI consumer |
| `.compose/compose.json` | Config; never changes at runtime |

If future features require watching other `.compose/` files (e.g., a live log stream), the `watchDir` infrastructure in `file-watcher.js` makes this straightforward to extend.

---

## Edge Cases

| Scenario | Handling |
|----------|---------|
| `.compose/data/` doesn't exist when `startWatching()` runs | `fileWatcher.attach()` runs before `ensureDataDir()` in `server/index.js`. `startWatching()` calls `ensureDataDir()` itself to guarantee the directory exists, then registers the watcher immediately. No lazy watcher needed — the directory is always created before registration. Protected by `dataDirWatcherRegistered` flag |
| Two rapid writes (create + step update) | 100ms debounce coalesces into one broadcast |
| `active-build.json` unexpectedly deleted | Per STRAT-COMP-4, the file is never intentionally deleted. If it disappears (manual deletion, crash), the watcher callback reads null and does not broadcast. The 30s polling fallback returns `{ state: null }` and the UI clears the indicator |
| Parse error in `active-build.json` | With atomic writes (temp + rename), parse errors indicate genuine corruption, not race conditions. Caught safely, no broadcast. The 30s polling fallback self-corrects on next read |
| Stale file from crashed build | The `status` field remains `running` but no updates arrive. The UI shows a stale indicator. The user can manually clear by deleting the file or starting a new build (which overwrites it) |
| Client connects mid-build | Fetches `GET /api/build/state` on connect for hydration |
| `fs.watch` misses events (macOS edge case) | 30s `/api/build/state` polling fallback self-corrects the active-build indicator |
| Build started before server starts | On first WebSocket connect, client calls `GET /api/build/state` to hydrate |
| Multiple concurrent server instances | Not a concern — supervisor enforces single API server via PID file |

---

## Why `/ws/vision` and Not `/ws/files`?

The existing `/ws/files` channel carries **document content** (`fileChanged`, `openFile`, `closeFile`, `scrollTo`). The `buildState` event is **application state** — the same category as `visionState`, `sessionStart`, `gatePending`. Broadcasting it on `/ws/vision` keeps the channels semantically clean and routes it through `visionMessageHandler.js` where all other state changes are handled.

The file-watching *mechanism* lives in `FileWatcherServer`, but the *channel* is chosen based on message semantics. This mirrors how `onFeatureChanged` works: the file watcher detects the change, but the vision server broadcasts it.

---

## Alternatives Considered

### Alternative A: New `/ws/build` WebSocket endpoint
- **Pro:** Cleanest separation; dedicated build channel
- **Con:** New infrastructure (third WebSocket server, third upgrade route, new client connection); complexity for a single message type
- **Decision:** Rejected

### Alternative B: Broadcast over `/ws/files`
- **Pro:** Zero new infrastructure; `FileWatcherServer` already owns the channel
- **Con:** Semantically wrong; Canvas.jsx consumers don't need build state; would require `StratumPanel` to open a second WebSocket
- **Decision:** Rejected in favor of `/ws/vision`

### Alternative C: REST polling only (no WebSocket)
- **Pro:** No server changes needed; just reduce polling interval
- **Con:** Higher server load; still ~5s latency at 5s interval; misses the step-level granularity
- **Decision:** Rejected

### Alternative D: Stratum MCP as source (current state)
- **Pro:** Already exists
- **Con:** 15s latency; doesn't expose `currentStepId`; Stratum only knows about completed steps
- **Decision:** Supplement with this feature rather than replace

---

## Testing Plan

1. **Unit**: `FileWatcherServer` — mock `fs.watch`, verify `onBuildStateChanged` fires on `active-build.json` write; verify other files in `.compose/data/` do not trigger callback.
2. **Integration**: Start server, write `active-build.json` via `writeActiveBuild()`, assert `/ws/vision` client receives `buildState` with flat payload within 500ms.
3. **Terminal state**: Verify build completion writes `status: 'complete'` and `completedAt` to the file (file NOT deleted). Verify the terminal state is broadcast. Verify a new build start overwrites the file.
4. **UI**: Open `StratumPanel`, run `compose build`, verify step badge updates without polling delay. Verify completion banner shows briefly on terminal status.
5. **Edge**: Write malformed JSON, verify no crash, no broadcast. Verify 30s polling fallback self-corrects.
6. **Reconnect**: Connect WS client mid-build, call `GET /api/build/state`, verify hydration with flat payload.
7. **Abort**: Send SIGINT during build, verify `status: 'aborted'` and `completedAt` written to file.
8. **Gate tracking**: Verify `currentStepId` updates when build enters a gate step.
9. **Locking**: Verify `status: 'running'` blocks a new build. Verify terminal statuses do not block.

---

## Acceptance Criteria

- [ ] **STRAT-COMP-4 contract compliance**: `active-build.json` and `buildState` WebSocket messages use the flat payload shape with fields: `featureCode`, `flowId`, `pipeline`, `currentStepId`, `specPath`, `stepNum`, `totalSteps`, `retries`, `violations: string[]`, `status` (`running`|`complete`|`failed`|`aborted`), `startedAt`, `completedAt?`. Field naming is identical between file and message.
- [ ] **File retention**: `active-build.json` is never deleted. On build completion/failure/abort, the file is updated with terminal `status` and `completedAt`. It is overwritten on next build start. Only `status: 'running'` blocks a new build.
- [ ] **Build-start visibility**: When a build starts (file created/overwritten with `status: 'running'`), the UI shows the active-build indicator within 1s (WebSocket push) or within 30s (polling fallback). Rapid writes within the 100ms debounce window coalesce into a single broadcast.
- [ ] **Step-change visibility**: When the build advances to a new step (file updated), the UI updates `currentStepId` within 1s (WebSocket push) or within 30s (polling fallback).
- [ ] **Gate transition tracking**: `updateActiveBuildStep()` is called in the `await_gate` handler (both top-level and inside `executeChildFlow`) so that gate steps are visible in the UI.
- [ ] **Build-finish visibility**: On terminal state, `lib/build.js` writes `status: 'complete'`/`'failed'`/`'aborted'` and `completedAt` to the file. The UI receives this via WebSocket and shows a completion banner. `ActiveBuildBanner` owns the dismiss behavior: `complete` auto-dismisses after 5s, `failed`/`aborted` remain until user dismissal or next build start.
- [ ] **Banner suppression**: `StratumPanel` tracks the last dismissed `flowId + completedAt` pair. Hydrated terminal states matching a dismissed pair are suppressed to prevent re-appearance on reconnect/poll.
- [ ] **Status mapping**: Stratum `complete` response maps to `status: 'complete'`. Stratum `killed` response maps to `status: 'aborted'`. Exhausted retries or thrown exceptions map to `status: 'failed'`. SIGINT / `compose build --abort` maps to `status: 'aborted'`.
- [ ] **Reconnect hydration**: `useVisionStore` automatically fetches `GET /api/build/state` on mount and on WebSocket reconnect (`onopen`), calling `setActiveBuild(data.state ?? null)`.
- [ ] **Filter isolation**: Changes to other files in `.compose/data/` (e.g., `vision-state.json`) do NOT trigger `onBuildStateChanged`.
- [ ] **Atomic writes**: `writeActiveBuild()` uses temp-file + rename to prevent partial reads.
- [ ] **Directory creation**: `startWatching()` calls `ensureDataDir()` to guarantee `.compose/data/` exists before registering the watcher. This eliminates the timing gap between `fileWatcher.attach()` and `ensureDataDir()` in `server/index.js` and works on fresh projects.
- [ ] **Parameterized filter**: `watchDir()` accepts a file filter parameter; existing `.md` callers are unaffected.
- [ ] **Parse error resilience**: Malformed JSON in `active-build.json` is silently ignored (no broadcast, no crash). The 30s polling fallback self-corrects.
- [ ] **UI rendering**: `StratumPanel` renders an active build indicator (feature code, current step ID, step progress) when `activeBuild.status === 'running'`.
- [ ] **Immediate FlowList refresh**: When `buildState` arrives via WebSocket, `FlowList` triggers an immediate `load()` to refresh flow data without waiting for the polling interval.
- [ ] **Nested flow tracking**: `updateActiveBuildStep()` is called inside `executeChildFlow()` for `execute_step`, `ensure_failed`/`schema_failed`, and `await_gate` handlers.
- [ ] **REST endpoint contract**: `GET /api/build/state` returns `{ state: <flat object> }` when `active-build.json` exists and parses, `{ state: null }` when the file does not exist or fails to parse.
- [ ] **Polling intervals unchanged**: Existing polling intervals in `StratumPanel` (15s for flows, 10s for gates) remain as-is.
- [ ] **Build state polling fallback**: `useVisionStore` adds a periodic `fetch('/api/build/state')` every 30s to re-sync `activeBuild`, covering cases where `fs.watch` misses events. This polling lives in `useVisionStore` (not `StratumPanel`) so all consumers benefit.
- [ ] **Test migration**: Update existing tests that assert `active-build.json` deletion on completion (e.g., `test/build-integration.test.js`, `test/proof-run.test.js`) to instead assert presence of a terminal-status snapshot with `status` and `completedAt` fields, per the STRAT-COMP-4 contract.

---

## Open Questions

1. **Should `StratumPanel.jsx` reduce polling intervals once it has WebSocket coverage?** Polling can be kept as-is for resilience (it's cheap), but it could be extended to 60s since the WebSocket now provides near-instant updates.
