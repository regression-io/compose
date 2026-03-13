# Implementation Plan: Build Visibility (STRAT-COMP-5)

**Feature:** Extend server file watcher to `.compose/data/active-build.json`, broadcast build state via WebSocket
**Date:** 2026-03-13
**Blueprint:** `docs/features/STRAT-COMP-5/blueprint.md`
**Design:** `docs/features/STRAT-COMP-5/design.md`
**Contract:** STRAT-COMP-4 contract (`docs/features/STRAT-COMP-4/design.md:161-163`) — flat payload, `violations: string[]`, message type `buildState`. `src/components/StratumPanel.jsx` work here is transitional only and is explicitly deleted by STRAT-COMP-8.

---

## Task 1: Make `writeActiveBuild()` atomic (temp + rename)

**Files:** `lib/build.js` (existing)
**Depends on:** --

**Acceptance criteria:**
- [ ] `renameSync` added to the import at line 11 (`import { ..., renameSync } from 'node:fs'`)
- [ ] `writeActiveBuild()` writes to `active-build.json.tmp` first, then calls `renameSync(tmp, target)` to atomically replace the target file
- [ ] No behavioral change to callers — function signature unchanged

---

## Task 2: Extend `startFresh()` to write additional state fields

**Files:** `lib/build.js` (existing)
**Depends on:** Task 1

**Acceptance criteria:**
- [ ] `writeActiveBuild()` call in `startFresh()` (line 490-496) includes `stepNum: response.step_number ?? 1`
- [ ] Includes `totalSteps: response.total_steps ?? null`
- [ ] Includes `retries: 0`
- [ ] Includes `violations: []` (string[] — violation messages per STRAT-COMP-4 contract)
- [ ] Includes `status: 'running'`
- [ ] Includes `pipeline: 'build'`
- [ ] Field names match STRAT-COMP-4 contract exactly: `featureCode`, `flowId`, `pipeline`, `currentStepId`, `specPath`, `stepNum`, `totalSteps`, `retries`, `violations`, `status`, `startedAt`

---

## Task 3: Extend `updateActiveBuildStep()` to accept and merge extra fields

**Files:** `lib/build.js` (existing)
**Depends on:** Task 1

**Acceptance criteria:**
- [ ] `updateActiveBuildStep(dataDir, stepId)` becomes `updateActiveBuildStep(dataDir, stepId, extra = {})`
- [ ] After setting `state.currentStepId = stepId`, calls `Object.assign(state, extra)` to merge additional fields
- [ ] Existing callers that pass only two arguments continue to work (default `extra = {}`)

---

## Task 4: Update dispatch loop callers of `updateActiveBuildStep()`

**Files:** `lib/build.js` (existing)
**Depends on:** Task 3

**Acceptance criteria:**
- [ ] `execute_step` block (line 202): existing `updateActiveBuildStep(dataDir, stepId)` call extended to `updateActiveBuildStep(dataDir, stepId, { stepNum: response.step_number, totalSteps: response.total_steps })`
- [ ] `ensure_failed`/`schema_failed` block (line 269-284): NEW `updateActiveBuildStep()` call added to pass `{ retries: (currentState.retries || 0) + 1, violations: response.violations || [] }`
- [ ] `violations` capped to last 10 entries to prevent unbounded growth
- [ ] `await_gate` handler (line 217): NEW `updateActiveBuildStep(dataDir, stepId)` call added so gate steps are visible in the UI

---

## Task 4b: Add `updateActiveBuildStep()` calls in `executeChildFlow()`

**Files:** `lib/build.js` (existing)
**Depends on:** Task 3

**Acceptance criteria:**
- [ ] `execute_step` handler inside `executeChildFlow()` (line 375): call `updateActiveBuildStep(dataDir, resp.step_id)` after the vision writer update at line 381
- [ ] `ensure_failed`/`schema_failed` handler inside `executeChildFlow()` (line 428): add `updateActiveBuildStep(dataDir, resp.step_id, { retries: (currentState.retries || 0) + 1, violations: resp.violations || [] })`
- [ ] `await_gate` handler inside `executeChildFlow()` (line 397): call `updateActiveBuildStep(dataDir, resp.step_id)` for child flow gate transitions
- [ ] `currentStepId` in `active-build.json` reflects the currently executing step regardless of flow nesting depth

---

## Task 4c: Write terminal state on build completion / abort / failure

**Files:** `lib/build.js` (existing)
**Depends on:** Task 1

**Acceptance criteria:**
- [ ] After the dispatch loop exits successfully: `writeActiveBuild()` called with `status: 'complete'` and `completedAt: new Date().toISOString()`
- [ ] On SIGINT / `compose build --abort`: `writeActiveBuild()` called with `status: 'aborted'` and `completedAt`
- [ ] On Stratum `killed` response: maps to `status: 'aborted'` with `completedAt`
- [ ] On unrecoverable exceptions / exhausted retries: maps to `status: 'failed'` with `completedAt`
- [ ] On `--through` partial build: maps to `status: 'complete'` with `completedAt` (build finished through requested phase)
- [ ] File is NOT deleted on completion — retained on disk per STRAT-COMP-4 contract, overwritten on next build start
- [ ] Only `status: 'running'` blocks a new build; terminal statuses do not block

---

## Task 5: Parameterize `watchDir()` file filter

**Files:** `server/file-watcher.js` (existing)
**Depends on:** --

**Acceptance criteria:**
- [ ] `watchDir()` signature at line 139 becomes `watchDir(dir, prefix, onChanged, fileFilter = (f) => f.endsWith('.md'))`
- [ ] Hardcoded `.md` check at line 146 (`!filename.endsWith('.md')`) replaced with `!fileFilter(filename)`
- [ ] Existing callers (lines 168, 180) pass no fourth argument and retain `.md` filtering by default

---

## Task 6: Add `.compose/data/` watcher with `ensureDataDir()` guarantee

**Files:** `server/file-watcher.js` (existing)
**Depends on:** Task 5

Per the design doc (section 1), `startWatching()` calls `ensureDataDir()` itself to guarantee `.compose/data/` exists before registering the watcher, eliminating the timing gap. No lazy watcher or parent-directory watching is needed.

**Acceptance criteria:**
- [ ] `const self = this;` captured at the top of `startWatching()` for use in closures
- [ ] `ensureDataDir()` imported from `./project-root.js` and called at the start of `startWatching()` to guarantee `.compose/data/` exists
- [ ] After the features watcher (after line 192), `watchDir(dataDir, '.compose/data', callback, (f) => f === 'active-build.json')` is registered
- [ ] The callback reads `active-build.json`, parses it (or sets `state = null` on ENOENT/parse error), and calls `self.onBuildStateChanged(state)`
- [ ] `dataDirWatcherRegistered` boolean flag prevents double-registration

---

## Task 7: Wire `onBuildStateChanged` callback in server/index.js

**Files:** `server/index.js` (existing)
**Depends on:** Task 6

Per the STRAT-COMP-4 contract, the WebSocket message uses a flat payload with `type: 'buildState'` (not nested `state` wrapper).

**Acceptance criteria:**
- [ ] After the `fileWatcher.onFeatureChanged` block (line 76-84), `fileWatcher.onBuildStateChanged` is set to a function
- [ ] When `state` is non-null: broadcasts `visionServer.broadcastMessage({ type: 'buildState', ...state })` (flat payload per STRAT-COMP-4)
- [ ] When `state` is null: no broadcast (30s polling fallback handles recovery)
- [ ] Follows the exact same pattern as the `onFeatureChanged` wiring

---

## Task 8: Add `GET /api/build/state` REST hydration endpoint

**Files:** `server/vision-server.js` (existing)
**Depends on:** --

**Acceptance criteria:**
- [ ] `import fs from 'node:fs';` added to vision-server.js imports
- [ ] `DATA_DIR` imported from `./project-root.js` (NOT currently imported in vision-server.js — add new import)
- [ ] `app.get('/api/build/state', ...)` added inside `attach()` after session routes (line 93)
- [ ] Endpoint reads `.compose/data/active-build.json` via `path.join(DATA_DIR, 'active-build.json')`
- [ ] Returns `{ state: <parsed object> }` if file exists and parses, `{ state: null }` otherwise
- [ ] Parse errors caught silently, return `{ state: null }`

---

## Task 9: Add `activeBuild` state to `useVisionStore.js`

**Files:** `src/components/vision/useVisionStore.js` (existing)
**Depends on:** Task 8

**Acceptance criteria:**
- [ ] `const [activeBuild, setActiveBuild] = useState(null);` added after the `settings` state declaration (line 85)
- [ ] `setActiveBuild` added to the setters object passed to `handleVisionMessage` (line 113-116)
- [ ] Mount hydration `useEffect` added after the session hydration block (after line 159): fetches `GET /api/build/state`, calls `setActiveBuild(data.state ?? null)` — always updates, including setting null when no build is active
- [ ] Reconnect hydration added inside the WebSocket `onopen` handler (line 104): `fetch('/api/build/state').then(r => r.json()).then(data => setActiveBuild(data.state ?? null)).catch(() => {})`
- [ ] 30s polling fallback added via `setInterval` that fetches `GET /api/build/state` and calls `setActiveBuild(data.state ?? null)` — covers `fs.watch` missed events; interval cleaned up on unmount
- [ ] Both `activeBuild` and `setActiveBuild` added to the returned object (line 255-278) — `setActiveBuild` is needed by STRAT-COMP-8 BuildDashboard for hydration on mount/reconnect

---

## Task 10: Handle `buildState` in `visionMessageHandler.js`

**Files:** `src/components/vision/visionMessageHandler.js` (existing)
**Depends on:** Task 9

Per the STRAT-COMP-4 contract, the message type is `buildState` with a flat payload (the message itself IS the state object).

**Acceptance criteria:**
- [ ] `setActiveBuild` destructured from `setters` in `handleVisionMessage`
- [ ] New `else if (msg.type === 'buildState')` block added after the `settingsState`/`settingsUpdated` block (line 176-177)
- [ ] Calls `setActiveBuild(msg)` — the flat message payload IS the active build state per STRAT-COMP-4
- [ ] When `msg.status` is a terminal status (`complete`, `failed`, `aborted`), the state is still set (UI handles display/dismiss logic)

---

## Task 11: Add `ActiveBuildBanner` and wire `activeBuild` into `StratumPanel.jsx`

**Files:** `src/components/StratumPanel.jsx` (existing)
**Depends on:** Task 9, Task 10
**Note:** StratumPanel changes are transitional — STRAT-COMP-8 deletes StratumPanel.jsx entirely. Minimize investment here.

**Acceptance criteria:**
- [ ] `import { useVisionStore } from './vision/useVisionStore.js';` added
- [ ] `StratumPanel` component consumes `activeBuild` from `useVisionStore()`
- [ ] `ActiveBuildBanner` sub-component renders feature code, current step ID, step progress (`stepNum`/`totalSteps`), and retry count (if > 0)
- [ ] Banner shows active-build indicator when `activeBuild.status === 'running'`
- [ ] Banner includes a pulsing dot CSS animation for "in progress" visual
- [ ] Terminal statuses render a completion banner: `complete` auto-dismisses after 5s, `failed`/`aborted` remain visible until user dismissal or next build start
- [ ] Banner suppression: tracks last dismissed `flowId + completedAt` pair in component state; suppresses hydrated terminal states matching a dismissed pair
- [ ] `ActiveBuildBanner` rendered above `GateQueue` when `activeBuild` is non-null
- [ ] `activeBuild` passed as prop to `FlowList`: `<FlowList activeBuild={activeBuild} />`
- [ ] `FlowList` adds a `useEffect` that watches the `activeBuild` prop and triggers an immediate `load()` when it changes (bridges step-level granularity with flow completion state)
- [ ] `FlowList` does NOT call `useVisionStore()` directly — only consumes `activeBuild` via prop
- [ ] Task notes and follow-on work explicitly mark this panel wiring as transitional because STRAT-COMP-8 replaces and deletes `src/components/StratumPanel.jsx`

---

## Dependency Graph

```
Task 1 (atomic write)
  ├─ Task 2 (startFresh fields + status)
  ├─ Task 3 (updateActiveBuildStep signature)
  │    ├─ Task 4 (dispatch loop callers + gate tracking)
  │    └─ Task 4b (nested flow tracking in executeChildFlow)
  └─ Task 4c (terminal state on completion/abort/failure)

Task 5 (parameterize watchDir)
  └─ Task 6 (data dir watcher with ensureDataDir)
       └─ Task 7 (wire callback in index.js — flat payload)

Task 8 (REST endpoint)
  └─ Task 9 (useVisionStore activeBuild + hydration + 30s poll)
       ├─ Task 10 (message handler — buildState flat payload)
       └─ Task 11 (StratumPanel UI + banner + dismiss logic)
```

Three independent tracks: producer (Tasks 1-4c), transport (Tasks 5-7), consumer (Tasks 8-11). Can be implemented in parallel, integrated at the end.

---

## Build Order (sequential)

| # | Task | Track |
|---|------|-------|
| 1 | Atomic write | Producer |
| 2 | startFresh fields + status + pipeline | Producer |
| 3 | updateActiveBuildStep signature | Producer |
| 4 | Dispatch loop callers + gate tracking | Producer |
| 4b | Nested flow tracking in executeChildFlow | Producer |
| 4c | Terminal state on completion/abort/failure | Producer |
| 5 | Parameterize watchDir | Transport |
| 6 | Data dir watcher with ensureDataDir | Transport |
| 7 | Wire callback (flat payload per STRAT-COMP-4) | Transport |
| 8 | REST endpoint | Consumer |
| 9 | useVisionStore state + hydration + 30s poll | Consumer |
| 10 | Message handler (buildState flat payload) | Consumer |
| 11 | StratumPanel UI + banner + dismiss logic | Consumer |
