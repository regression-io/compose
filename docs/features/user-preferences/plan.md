# L0 Implementation Plan: User Preferences System

## Related Documents

- `docs/features/user-preferences/design.md` — Design spec
- `docs/features/user-preferences/blueprint.md` — Blueprint with file:line references

## Task Order

Tasks are sequential — each builds on the previous. Tests are written alongside implementation (TDD).

---

### Task 1: SettingsStore + tests

**Files:** `server/settings-store.js` (new), `test/settings-store.test.js` (new)

- [x]Create `server/settings-store.js` following VisionStore pattern (`server/vision-store.js:22-69`)
- [x]Constructor takes `(dataDir, contract)`, builds `_file = path.join(dataDir, 'settings.json')`
- [x]`_load()`: readFileSync with ENOENT fallback to empty object
- [x]`_save()`: mkdirSync + writeFileSync (JSON, 2-space indent)
- [x]`_defaults()`: builds defaults from contract phases + hardcoded model/ui defaults
- [x]`get()`: deep-merges `_defaults()` with `_userSettings`, returns merged result
- [x]`update(patch)`: validates, deep-merges into `_userSettings`, saves, returns `get()`
- [x]`reset(section?)`: clears section or all, saves, returns `get()`
- [x]Validation: policies against `CONTRACT.policyModes`, iterations 1-100, models non-empty string, theme in light/dark/system, defaultView in allowed view keys (`attention`, `gates`, `roadmap`, `list`, `board`, `tree`, `graph`, `docs`, `settings`)

**Tests (`test/settings-store.test.js`):**
- [x]`get()` returns contract defaults when no settings file
- [x]`update({ policies: { prd: 'gate' } })` persists and returns merged
- [x]`update()` with invalid policy mode throws
- [x]`update()` with invalid iteration count throws
- [x]`reset()` clears all user settings, returns defaults
- [x]`reset('policies')` clears only policies section
- [x]File round-trip: update, construct new store from same dir, verify persisted
- [x]Unknown top-level keys rejected

**Pattern:** `server/vision-store.js:22-69` (constructor, _load, _save, getState)

---

### Task 2: Settings REST API + tests

**Files:** `server/settings-routes.js` (new), `test/settings-routes.test.js` (new)

**Depends on:** Task 1

- [x]Create `server/settings-routes.js` with `attachSettingsRoutes(app, { settingsStore, broadcastMessage })`
- [x]`GET /api/settings` → `res.json(settingsStore.get())`
- [x]`PATCH /api/settings` → validate, update, broadcast `{ type: 'settingsUpdated', settings }`, return updated
- [x]`POST /api/settings/reset` → reset(section), broadcast, return updated
- [x]400 on validation errors with `{ error: message }`

**Tests (`test/settings-routes.test.js`):**
- [x]GET returns defaults when no user settings
- [x]PATCH updates and returns merged settings
- [x]PATCH broadcasts `settingsUpdated` message
- [x]PATCH with invalid policy returns 400
- [x]PATCH with invalid iteration returns 400
- [x]POST reset clears settings, broadcasts, returns defaults
- [x]POST reset with section clears only that section

**Pattern:** `server/vision-routes.js:45` (attachXRoutes signature, error handling)

---

### Task 3: Wire SettingsStore into VisionServer

**Files:** `server/vision-server.js` (existing)

**Depends on:** Task 2

- [x]Import `SettingsStore` from `./settings-store.js`
- [x]Import `attachSettingsRoutes` from `./settings-routes.js`
- [x]Import `CONTRACT` from `./lifecycle-constants.js`
- [x]Construct `this.settingsStore = new SettingsStore(undefined, CONTRACT)` in `attach()` before route registration
- [x]Call `attachSettingsRoutes(app, { settingsStore, broadcastMessage })` after existing route registrations
- [x]Pass `settingsStore: this.settingsStore` in the deps object to `attachVisionRoutes()`
- [x]In WS `onconnection` handler (line 132), send `settingsState` message after `visionState`:
  ```js
  ws.send(JSON.stringify({ type: 'settingsState', settings: this.settingsStore.get() }));
  ```

**Verify:** Run existing tests — no regressions. `GET /api/settings` returns defaults from a running server.

---

### Task 4: Wire SettingsStore into policy engine + lifecycle manager

**Files:** `server/policy-engine.js` (existing), `server/lifecycle-manager.js` (existing), `server/vision-routes.js` (existing), `test/policy-engine.test.js` (existing), `test/lifecycle-manager.test.js` (existing)

**Depends on:** Task 3

- [x]`server/policy-engine.js`: Add third parameter `settingsPolicies` to `evaluatePolicy(targetPhase, overrides, settingsPolicies)`. Insert in fallback chain: `ov[targetPhase] ?? settingsPolicies?.[targetPhase] ?? DEFAULT_POLICIES[targetPhase] ?? 'skip'`
- [x]`server/lifecycle-manager.js`: Accept `settingsStore` as third constructor parameter, store as `#settingsStore`
- [x]`advancePhase` (line 75): pass `this.#settingsStore?.get()?.policies` as third arg to `evaluatePolicy`
- [x]`skipPhase` (line 104): same
- [x]`startIterationLoop` (line 233): read `this.#settingsStore?.get()?.iterations?.[loopType]?.maxIterations` as middle fallback
- [x]`server/vision-routes.js` (line 121): pass `settingsStore` to `new LifecycleManager(store, featureRoot, settingsStore)`

**Tests:**
- [x]`test/policy-engine.test.js`: add test for settings override in fallback chain (feature override > settings > contract)
- [x]`test/lifecycle-manager.test.js`: verify iteration limits respect settings override
- [x]All existing policy/lifecycle tests still pass (settingsPolicies=undefined preserves old behavior)

---

### Task 5: Agent server reads settings from disk

**Files:** `server/agent-server.js` (existing)

**Depends on:** Task 1 (settings.json format)

- [x]Add `import { readFileSync } from 'node:fs'` at top
- [x]Add `SETTINGS_FILE = path.join(PROJECT_ROOT, 'data', 'settings.json')`
- [x]Add `_readModelSetting()` function: try/catch readFileSync + JSON.parse, return `settings.models?.interactive` or null
- [x]Replace line 156 `model: 'claude-sonnet-4-6'` with `model: _readModelSetting() || 'claude-sonnet-4-6'`

**Verify:** No test changes needed — agent-server tests don't mock the model. Manual verification: write a `data/settings.json` with `models.interactive: 'claude-haiku-4-5-20251001'`, restart agent server, verify it uses that model.

---

### Task 6: Bug fixes (agent-hooks port, Vite port env)

**Files:** `server/agent-hooks.js` (existing), `server/supervisor.js` (existing)

**Depends on:** Nothing (independent)

- [x]`server/agent-hooks.js` line 12: change `'http://127.0.0.1:3001'` to `` `http://127.0.0.1:${process.env.PORT || 3001}` ``
- [x]`server/supervisor.js` line 41: change `port: 5173` to `port: process.env.VITE_PORT || 5173`

**Verify:** Run existing tests. No new tests needed — these are env-var wiring fixes.

---

### Task 7: Client WS handler + useVisionStore settings state

**Files:** `src/components/vision/visionMessageHandler.js` (existing), `src/components/vision/useVisionStore.js` (existing), `test/settings-client.test.js` (new)

**Depends on:** Task 3 (server sends settingsState/settingsUpdated)

- [x]`visionMessageHandler.js` line 17: add `setSettings` to destructured setters
- [x]After last else-if block (~line 189): add handler for `settingsState` and `settingsUpdated` → `setSettings(msg.settings || null)`
- [x]`useVisionStore.js` line ~83: add `const [settings, setSettings] = useState(null)`
- [x]Lines 112-114: add `setSettings` to setters object
- [x]Add `updateSettings(patch)` useCallback: PATCH `/api/settings`, return json
- [x]Add `resetSettings(section?)` useCallback: POST `/api/settings/reset` with `{ section }`, return json
- [x]Return object: add `settings`, `updateSettings`, `resetSettings`

**Tests (`test/settings-client.test.js`):**
- [x]`settingsState` message calls `setSettings` with settings payload
- [x]`settingsUpdated` message calls `setSettings` with updated payload
- [x]Missing `setSettings` in setters does not crash (guard with `if (setSettings)`)

---

### Task 8: Settings sidebar entry + SettingsPanel UI

**Files:** `src/components/vision/AppSidebar.jsx` (existing), `src/components/vision/SettingsPanel.jsx` (new), `src/components/vision/VisionTracker.jsx` (existing)

**Depends on:** Task 7

- [x]`AppSidebar.jsx` line 2: add `Settings2` to lucide-react imports
- [x]`AppSidebar.jsx` line 19: add `{ key: 'settings', label: 'Settings', icon: Settings2 }` to VIEWS
- [x]Create `SettingsPanel.jsx`:
  - Props: `settings`, `onSettingsChange(patch)`, `onReset(section?)`
  - Section 1: Phase Policies — 10 rows, dropdown per phase (gate/flag/skip; null only for explore_design)
  - Section 2: Iteration Limits — 2 number inputs (review max, coverage max) with min=1 max=100
  - Section 3: Agent Models — 3 text inputs (interactive, agentRun, summarizer)
  - Section 4: Appearance — theme dropdown (light/dark/system), default view dropdown
  - Each field calls `onSettingsChange({ [section]: { [key]: value } })` immediately on change
  - Theme dropdown additionally applies DOM class and localStorage (same mechanism as App.jsx toggleTheme)
  - Reset to Defaults button at bottom: calls `onReset()` (no section = full reset) with confirmation dialog
- [x]`VisionTracker.jsx` line 1: add `useRef` to the React import (`import { useState, useCallback, useMemo, useEffect, useRef, createContext } from 'react'`)
- [x]`VisionTracker.jsx` line 13: import `SettingsPanel`
- [x]`VisionTracker.jsx` lines 23-24: destructure `settings`, `updateSettings`, `resetSettings` from `useVisionStore()`
- [x]After line 223 (after gates view): add `{activeView === 'settings' && <SettingsPanel settings={settings} onSettingsChange={updateSettings} onReset={resetSettings} />}`
- [x]`VisionTracker.jsx` line 27 (activeView init): read `settings?.ui?.defaultView` as fallback when no sessionStorage value:
  ```js
  const [activeView, setActiveView] = useState(() =>
    sessionStorage.getItem('vision-activeView') || 'roadmap'
  );
  ```
  Add a one-time `useEffect` that applies `defaultView` from settings on first WS connect:
  ```js
  const defaultViewApplied = useRef(false);
  useEffect(() => {
    if (settings?.ui?.defaultView && !defaultViewApplied.current && !sessionStorage.getItem('vision-activeView')) {
      setActiveView(settings.ui.defaultView);
      defaultViewApplied.current = true;
    }
  }, [settings]);
  ```
  This respects sessionStorage (user's in-session choice) over settings, and only applies the default on fresh sessions where sessionStorage is empty.

**Verify:** Run `npm run build` to confirm no JSX errors. Visual check in browser.

---

## Parallelization

Tasks 5 and 6 are independent of each other and of Tasks 7-8. They could run in parallel with Tasks 3-4. However, since they're small, sequential execution is fine.

```
Task 1 → Task 2 → Task 3 → Task 4 → Task 7 → Task 8
                                  ↗
Task 5 (independent) ────────────
Task 6 (independent) ────────────
```

## Exit Criteria

- [x] `GET /api/settings` returns merged defaults + user overrides
- [x] `PATCH /api/settings` persists, validates, broadcasts
- [x] Policy engine uses settings as middle fallback layer
- [x] Iteration limits respect settings override
- [x] Agent server reads model from `data/settings.json`
- [x] Settings panel renders in sidebar with all 4 sections
- [x] WS broadcasts settings changes to all clients
- [x] Agent hooks port bug fixed
- [x] Vite port env escape added
- [x] All existing tests pass + new tests for store, routes, client, policy chain
