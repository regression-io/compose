# Blueprint: Build Visibility (STRAT-COMP-5)

**Feature:** Extend server file watcher to `.compose/data/active-build.json`, broadcast build state via WebSocket
**Status:** Blueprint
**Date:** 2026-03-12

---

## Related Documents

- Design: `docs/features/STRAT-COMP-5/design.md`
- Producer: `lib/build.js` (writes `active-build.json`)
- Consumer: `src/components/StratumPanel.jsx` (renders build state)
- Transport: `server/file-watcher.js`, `server/index.js`, `server/vision-server.js`
- Client dispatch: `src/components/vision/visionMessageHandler.js`, `src/components/vision/useVisionStore.js`

---

## Corrections Table

| ID | Severity | Design Claim | Actual Code | Required Fix |
|----|----------|-------------|-------------|--------------|
| C1 | P1 | Design message schema (line 155) shows only `featureCode`, `flowId`, `startedAt`, `currentStepId`, `specPath` | `startFresh()` at `build.js:490-496` writes exactly those five fields. Dashboard (STRAT-COMP-8) needs `stepNum`, `totalSteps`, `retries`, `violations` (count), `violationMessages` (string[]) | Extend `writeActiveBuild()` in `startFresh()` and `updateActiveBuildStep()` to include these fields. See Component Design for `lib/build.js` below |
| C2 | P1 | Design line 98: "add the filename check inside the callback" — assumes `watchDir()` will invoke the callback for `.json` files | `file-watcher.js:146`: `if (!filename \|\| !filename.endsWith('.md')) return;` is hardcoded inside `watchDir()` before the callback is ever invoked. A third `watchDir()` call for `.compose/data/` will silently drop `active-build.json` events | Refactor `watchDir()` to accept an optional file extension filter parameter (default `'.md'` for backward compatibility) |
| C3 | P2 | Design line 96: "watchDir() already guards with fs.existsSync(dir) — no change needed" | `file-watcher.js:140`: one-shot `fs.existsSync(dir)` check. `.compose/data/` is created lazily by `build.js:65` (`mkdirSync(dataDir, { recursive: true })`) on first build. If server starts before first build, watcher is never registered | Add lazy watcher: watch the parent `.compose/` directory for `data/` creation, then register the real watcher. Or poll for directory existence with a bounded retry |
| C4 | P2 | Design says "no new state in useVisionStore" (implicit — the store returns existing fields) | `useVisionStore.js` has no `activeBuild` state. The `handleVisionMessage` function has no `buildStateChanged` case | Add `activeBuild` state (`useState(null)`) to the store and expose `setActiveBuild` through the message handler. Call `setActiveBuild(null)` to clear |

---

## Architecture Decisions

### AD-1: Parameterize `watchDir()` filter instead of creating `watchFile()`

Creating a separate `watchFile()` method would duplicate the debounce logic, error handling, and watcher lifecycle management already in `watchDir()`. Instead, add an optional `fileFilter` parameter to `watchDir()` (default: `(f) => f.endsWith('.md')`). The two existing callers pass no filter and get the current `.md` behavior. The new `.compose/data/` caller passes `(f) => f === 'active-build.json'`.

### AD-2: Lazy directory watcher via parent directory watch

Rather than polling, watch `.compose/` (which exists at project init) with `{ recursive: false }`. When a `rename` event fires for `data`, check if `.compose/data/` now exists and register the real watcher. This is event-driven and avoids timers. Guard against double-registration with a boolean flag.

### AD-3: REST hydration endpoint in `vision-server.js`

Place `GET /api/build/state` alongside the existing Stratum and session routes in `vision-server.js` rather than creating a new `build-routes.js` file. The endpoint is a single file read — not enough to justify a new module. Wire it inside `VisionServer.attach()`.

### AD-4: Atomic write for `active-build.json`

`writeActiveBuild()` uses `writeFileSync()` directly. The file watcher can fire mid-write and read partial JSON. Use temp-file + rename (`writeFileSync(tmpPath, data)` then `renameSync(tmpPath, targetPath)`) to ensure the watcher always reads a complete file.

### AD-5: Extended message schema

The `buildStateChanged` WebSocket message must include the full state from `active-build.json`, which now includes `stepNum`, `totalSteps`, `retries`, `violations` (count), and `violationMessages` (detail strings). The schema becomes:

```json
{
  "type": "buildStateChanged",
  "state": {
    "featureCode": "STRAT-COMP-5",
    "flowId": "uuid",
    "startedAt": "ISO-8601",
    "currentStepId": "explore_design",
    "specPath": "pipelines/build.stratum.yaml",
    "stepNum": 3,
    "totalSteps": 12,
    "retries": 1,
    "violations": 1,
    "violationMessages": ["postcondition: file must exist"]
  },
  "timestamp": "ISO-8601"
}
```

Note on `stepNum` / `totalSteps`: These come from `response.step_number` and `response.total_steps` on the Stratum dispatch response. STRAT-COMP-7 cross-references these fields for progress tracking.

Note on `violations` / `violationMessages`: On an `ensure_failed` or `schema_failed` response, `response.violations` is an array of violation message strings (e.g., `["postcondition: file must exist"]`). Map as: `violations: (response.violations || []).length` and `violationMessages: response.violations || []`.

Two violation fields serve different consumers:
- `violations: number` — count of current violations (used by STRAT-COMP-8 numeric display)
- `violationMessages: string[]` — the actual violation strings (used for detail display)

---

## Component Designs

### 1. `lib/build.js` — Extend active build state (existing)

**Goal:** The producer must write all fields the dashboard needs.

#### 1a. `startFresh()` (line 486-498)

Current write at line 490-496:
```js
writeActiveBuild(dataDir, {
  featureCode,
  flowId: response.flow_id,
  startedAt: new Date().toISOString(),
  currentStepId: response.step_id,
  specPath: 'pipelines/build.stratum.yaml',
});
```

Add `stepNum`, `totalSteps`, `retries`, `violations`, `violationMessages`:
```js
writeActiveBuild(dataDir, {
  featureCode,
  flowId: response.flow_id,
  startedAt: new Date().toISOString(),
  currentStepId: response.step_id,
  specPath: 'pipelines/build.stratum.yaml',
  stepNum: response.step_number ?? 1,
  totalSteps: response.total_steps ?? null,
  retries: 0,
  violations: 0,
  violationMessages: [],
});
```

`response.step_number` and `response.total_steps` are already used at line 194-195 — they come from the Stratum dispatch response. Note: `stepNum` maps from `response.step_number` and `totalSteps` from `response.total_steps`. STRAT-COMP-7 cross-references these fields for progress tracking.

#### 1b. `updateActiveBuildStep()` (line 501-507)

Current implementation only writes `currentStepId`. Extend to accept and merge additional fields:

```js
function updateActiveBuildStep(dataDir, stepId, extra = {}) {
  const state = readActiveBuild(dataDir);
  if (state) {
    state.currentStepId = stepId;
    Object.assign(state, extra);
    writeActiveBuild(dataDir, state);
  }
}
```

Callers in the dispatch loop update accordingly:
- `execute_step` block (line 202): update existing call to pass `{ stepNum: response.step_number, totalSteps: response.total_steps }`
- `ensure_failed`/`schema_failed` block (line 269): ADD a new `updateActiveBuildStep()` call (none exists currently) to increment `retries`, set `violations` and `violationMessages` from the Stratum response. Source fields: `response.violations` is an array of violation message strings. Map as: `violations: (response.violations || []).length` (count) and `violationMessages: response.violations || []` (string array)

#### 1c. `writeActiveBuild()` (line 64-67) — Atomic write

Replace direct `writeFileSync` with temp + rename:

```js
function writeActiveBuild(dataDir, state) {
  mkdirSync(dataDir, { recursive: true });
  const target = activeBuildPath(dataDir);
  const tmp = target + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, target);
}
```

Add `renameSync` to the import at line 10.

### 2. `server/file-watcher.js` — Parameterized filter + lazy watcher (existing)

#### 2a. Refactor `watchDir()` signature (line 139)

Current:
```js
const watchDir = (dir, prefix, onChanged) => {
```

New:
```js
const watchDir = (dir, prefix, onChanged, fileFilter = (f) => f.endsWith('.md')) => {
```

Replace the hardcoded filter at line 146:
```js
// Before:
if (!filename || !filename.endsWith('.md')) return;
// After:
if (!filename || !fileFilter(filename)) return;
```

Existing callers (lines 168 and 180) pass no fourth argument — they get `.md` filtering by default.

#### 2b. Lazy watcher for `.compose/data/` (after line 192)

```js
// At the top of startWatching(), capture `this` for use in closures:
const self = this;

// Watch .compose/data/ for active-build.json changes
const dataDir = path.join(PROJECT_ROOT, '.compose', 'data');
let dataDirWatcherRegistered = false;

const registerDataWatcher = () => {
  if (dataDirWatcherRegistered) return;
  if (!fs.existsSync(dataDir)) return;
  dataDirWatcherRegistered = true;

  watchDir(dataDir, '.compose/data', (relativePath, fullPath) => {
    let state = null;
    try {
      if (fs.existsSync(fullPath)) {
        state = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
      }
    } catch { /* parse error or ENOENT — state stays null */ }

    if (typeof self.onBuildStateChanged === 'function') {
      self.onBuildStateChanged(state);
    }
  }, (f) => f === 'active-build.json');
};

// Try immediately
registerDataWatcher();

// If data dir doesn't exist yet, watch parent for its creation
if (!dataDirWatcherRegistered) {
  const composeDir = path.join(PROJECT_ROOT, '.compose');
  if (fs.existsSync(composeDir)) {
    try {
      const parentWatcher = fs.watch(composeDir, (eventType, filename) => {
        if (filename === 'data' && fs.existsSync(dataDir)) {
          registerDataWatcher();
          parentWatcher.close();
        }
      });
      self.watchers.push(parentWatcher);
    } catch (err) {
      console.warn(`[file-watcher] Cannot watch .compose/ for data dir creation: ${err.message}`);
    }
  }
}
```

Note: `startWatching()` is called from `attach()` (line 132), so `this` refers to the `FileWatcherServer` instance. Since `registerDataWatcher` and the parent watcher callback are closures (not arrow methods on the class), `this` is unbound inside them. Store `const self = this;` at the top of `startWatching()` and use `self.onBuildStateChanged` and `self.watchers` inside closures.

#### 2c. `onBuildStateChanged` callback property

No structural change needed — follows the same pattern as `onFeatureChanged` (line 189). It's set externally in `server/index.js`.

### 3. `server/index.js` — Wire callback (existing, line 76-84 pattern)

After the existing `fileWatcher.onFeatureChanged` block (line 76-84), add:

```js
// Wire build state changes → broadcast over /ws/vision
fileWatcher.onBuildStateChanged = (state) => {
  visionServer.broadcastMessage({
    type: 'buildStateChanged',
    state,
    timestamp: new Date().toISOString(),
  });
};
```

### 4. `server/vision-server.js` — REST hydration endpoint (existing)

Inside `attach()`, after the session routes block (line 93), add:

```js
// ── Build state hydration ─────────────────────────────────────────────
app.get('/api/build/state', (_req, res) => {
  const buildPath = path.join(DATA_DIR, 'active-build.json');
  try {
    if (fs.existsSync(buildPath)) {
      const state = JSON.parse(fs.readFileSync(buildPath, 'utf-8'));
      res.json({ state });
    } else {
      res.json({ state: null });
    }
  } catch {
    res.json({ state: null });
  }
});
```

Requires adding `fs` and `DATA_DIR` imports. `DATA_DIR` is NOT currently imported in `vision-server.js`. It is exported from `project-root.js` (imported at line 41 in `index.js` but not in `vision-server.js`). Add `import { DATA_DIR } from './project-root.js';` and `import fs from 'node:fs';` to the top of `vision-server.js`.

### 5. `src/components/vision/useVisionStore.js` — Add `activeBuild` state (existing)

#### 5a. New state (after line 85)

```js
const [activeBuild, setActiveBuild] = useState(null);
```

#### 5b. Pass setter to handler (line 113-116)

Add `setActiveBuild` to the setters object passed to `handleVisionMessage`:

```js
setItems, setConnections, setGates, setGateEvent,
setRecentChanges, setUICommand, setAgentActivity,
setAgentErrors, setSessionState, setSettings, setActiveBuild, EMPTY_CHANGES,
```

#### 5c. Hydrate on mount (after the session hydration block, line 141-159)

```js
// Hydrate active build state on mount
useEffect(() => {
  fetch('/api/build/state')
    .then(r => r.json())
    .then(data => {
      if (data.state) setActiveBuild(data.state);
    })
    .catch(() => {});
}, []);
```

#### 5d. Return `activeBuild` from hook (line 255-278)

Add `activeBuild` to the returned object.

### 6. `src/components/vision/visionMessageHandler.js` — Handle `buildStateChanged` (existing)

After the `settingsState`/`settingsUpdated` block (line 176-177), before the `snapshotRequest` block (line 179), add:

```js
} else if (msg.type === 'buildStateChanged') {
  const { setActiveBuild } = setters;
  if (setActiveBuild) {
    setActiveBuild(msg.state ?? null);  // null clears active build
  }
```

### 7. `src/components/StratumPanel.jsx` — Consume `activeBuild` (existing)

#### 7a. Import store

```js
import { useVisionStore } from './vision/useVisionStore.js';
```

#### 7b. In `StratumPanel` component (line 253-262)

Consume `activeBuild` from the store and render an active build indicator above the gate queue:

```jsx
export default function StratumPanel() {
  const { activeBuild } = useVisionStore();

  return (
    <div style={{ padding: '12px 14px', color: '#e4e4e7', fontSize: '0.9em', overflowY: 'auto', height: '100%' }}>
      {activeBuild && <ActiveBuildBanner build={activeBuild} />}
      <GateQueue />
      <div style={{ marginTop: 20 }}>
        <FlowList activeBuild={activeBuild} />
      </div>
    </div>
  );
}
```

#### 7c. `ActiveBuildBanner` sub-component (new, in same file)

Renders feature code, current step, step progress (stepNum/totalSteps), and retry count if > 0. Pulsing dot indicator for "in progress" state.

#### 7d. Trigger immediate refresh

When `activeBuild` changes (via `useEffect`), call `fetchFlows()` in `FlowList` to bridge the gap between active-build step granularity and Stratum flow completion state. This requires lifting `load()` out of `FlowList` or exposing a refresh trigger via a shared ref/callback.

Decision: prop drilling — `StratumPanel` already consumes `activeBuild` from the store (section 7b). Pass `activeBuild` as a prop to `FlowList`: `<FlowList activeBuild={activeBuild} />`. Inside `FlowList`, add a `useEffect` that watches the `activeBuild` prop and triggers an immediate `load()` when it changes. `FlowList` does NOT call `useVisionStore()` directly (consistent with risk table row 3: only `StratumPanel` and children via prop drilling should consume `activeBuild`).

---

## Build Sequence

| # | Task | File(s) | Depends On |
|---|------|---------|------------|
| 1 | Add `renameSync` import to `build.js` | `lib/build.js:10` | — |
| 2 | Make `writeActiveBuild()` atomic (temp + rename) | `lib/build.js:64-67` | 1 |
| 3 | Extend `startFresh()` to write `stepNum`, `totalSteps`, `retries`, `violations` (number), `violationMessages` (string[]) | `lib/build.js:490-496` | 2 |
| 4 | Extend `updateActiveBuildStep()` to accept and merge extra fields | `lib/build.js:501-507` | 2 |
| 5 | Update existing `updateActiveBuildStep()` call at line 202 (`execute_step` block) to pass `{ stepNum, totalSteps }`. ADD a new `updateActiveBuildStep()` call in the `ensure_failed`/`schema_failed` block (line 269-284) — none exists currently — to pass `{ retries, violations, violationMessages }` | `lib/build.js:202, 269-284` | 4 |
| 6 | Parameterize `watchDir()` file filter | `server/file-watcher.js:139, 146` | — |
| 7 | Add lazy `.compose/data/` watcher with parent-dir fallback | `server/file-watcher.js` (after line 192) | 6 |
| 8 | Wire `onBuildStateChanged` callback in `server/index.js` | `server/index.js` (after line 84) | 7 |
| 9 | Add `GET /api/build/state` endpoint | `server/vision-server.js` (in `attach()`) | — |
| 10a | Add `activeBuild` state to `useVisionStore.js` + hydration fetch | `src/components/vision/useVisionStore.js` | 9 |
| 10b | Add `activeBuild` to `useVisionStore` return object (section 5d) | `src/components/vision/useVisionStore.js` | 10a |
| 11 | Add `buildStateChanged` case to `visionMessageHandler.js` | `src/components/vision/visionMessageHandler.js` | 10b |
| 12 | OPTIONAL — skip if STRAT-COMP-8 will be implemented immediately after. Add `ActiveBuildBanner` component to `StratumPanel.jsx` | `src/components/StratumPanel.jsx` | 10b |
| 13 | OPTIONAL — skip if STRAT-COMP-8 will be implemented immediately after. Wire `activeBuild` into `StratumPanel` and `FlowList` for immediate refresh | `src/components/StratumPanel.jsx` | 11, 12 |

---

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|------------|
| `fs.watch` on `.compose/` fires spuriously on macOS (FSEvents coalescing) | Low — watcher callback filters on `filename === 'data'` | Medium | Guard with `dataDirWatcherRegistered` flag; parent watcher auto-closes after registration |
| Atomic write (`renameSync`) fails on Windows if file is locked | Medium — `active-build.json` could be stale | Low (macOS target) | Fallback: catch `renameSync` error, fall back to direct `writeFileSync` |
| `useVisionStore` is instantiated in multiple components — `activeBuild` state may diverge | High — each component gets its own hook instance with its own state | Medium | `useVisionStore` manages its own WebSocket per instance. Only `StratumPanel` (and children via prop drilling) should consume `activeBuild`. If divergence is observed, extract to a shared context in a follow-up |
| Large `violationMessages` array bloats `active-build.json` and WebSocket messages | Low — Stratum typically returns 1-5 violations per retry | Low | Cap `violationMessages` to last 10 entries in `updateActiveBuildStep()` |
| Server restart while build is running — lazy watcher re-registers but misses events during downtime | Low — client hydrates via `GET /api/build/state` on reconnect | Medium | Hydration endpoint reads file directly; no watcher needed for catch-up |

---

## Behavioral Test Checkpoints

### Golden Flow: Build start to completion broadcasts

1. Start compose server
2. Run `compose build FEAT-TEST` (writes `active-build.json`)
3. Assert: `/ws/vision` client receives `buildStateChanged` with `state.featureCode === 'FEAT-TEST'` within 500ms
4. Assert: `state.stepNum` and `state.totalSteps` are present and numeric
5. Build advances to next step
6. Assert: second `buildStateChanged` with updated `currentStepId` and `stepNum`
7. Build completes (file deleted)
8. Assert: `buildStateChanged` with `state: null`

### Error Path: Retry tracking

1. Trigger an `ensure_failed` response in the build loop
2. Assert: `active-build.json` contains `retries: 1`, `violations: 1` (count), and `violationMessages` array with failure strings
3. Assert: `buildStateChanged` broadcast includes both `violations` (number) and `violationMessages` (string[]) fields

### Lazy Watcher: Directory creation after server start

1. Start server when `.compose/data/` does not exist
2. Assert: no crash, warning logged
3. Run first build (creates `.compose/data/`)
4. Assert: watcher registers via parent-dir watch
5. Assert: subsequent `active-build.json` writes trigger `buildStateChanged` broadcasts

### Hydration: Client connects mid-build

1. Start build, wait for step 2+
2. Connect a new WebSocket client to `/ws/vision`
3. Client calls `GET /api/build/state`
4. Assert: response contains current `active-build.json` state with all fields

### Filter Isolation: Non-target files ignored

1. Write `vision-state.json` to `.compose/data/`
2. Assert: `onBuildStateChanged` is NOT called
3. Write `active-build.json` to `.compose/data/`
4. Assert: `onBuildStateChanged` IS called

### Parse Error Resilience

1. Write malformed JSON to `active-build.json`
2. Assert: `onBuildStateChanged` called with `state: null`
3. Assert: no server crash
