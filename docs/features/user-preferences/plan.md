# L0 Implementation Plan: User Preferences System

## Related Documents

- `docs/features/user-preferences/design.md` — Design spec
- `docs/features/user-preferences/blueprint.md` — Blueprint with file:line references

## Task Order

Tasks are sequential — each builds on the previous. Tests are written alongside implementation (TDD).

---

### Task 1: SettingsStore + tests

**Files:** `server/settings-store.js` (new), `test/settings-store.test.js` (new)

- [ ] Create `server/settings-store.js` following VisionStore pattern (`server/vision-store.js:22-69`)
- [ ] Constructor takes `(dataDir, contract)`, builds `_file = path.join(dataDir, 'settings.json')`
- [ ] `_load()`: readFileSync with ENOENT fallback to empty object
- [ ] `_save()`: mkdirSync + writeFileSync (JSON, 2-space indent)
- [ ] `_defaults()`: builds defaults from contract phases + hardcoded model/ui defaults
- [ ] `get()`: deep-merges `_defaults()` with `_userSettings`, returns merged result
- [ ] `update(patch)`: validates, deep-merges into `_userSettings`, saves, returns `get()`
- [ ] `reset(section?)`: clears section or all, saves, returns `get()`
- [ ] Validation: policies against `CONTRACT.policyModes`, iterations 1-100, models non-empty string, theme in light/dark/system

**Tests (`test/settings-store.test.js`):**
- [ ] `get()` returns contract defaults when no settings file
- [ ] `update({ policies: { prd: 'gate' } })` persists and returns merged
- [ ] `update()` with invalid policy mode throws
- [ ] `update()` with invalid iteration count throws
- [ ] `reset()` clears all user settings, returns defaults
- [ ] `reset('policies')` clears only policies section
- [ ] File round-trip: update, construct new store from same dir, verify persisted
- [ ] Unknown top-level keys rejected

**Pattern:** `server/vision-store.js:22-69` (constructor, _load, _save, getState)

---

### Task 2: Settings REST API + tests

**Files:** `server/settings-routes.js` (new), `test/settings-routes.test.js` (new)

**Depends on:** Task 1

- [ ] Create `server/settings-routes.js` with `attachSettingsRoutes(app, { settingsStore, broadcastMessage })`
- [ ] `GET /api/settings` → `res.json(settingsStore.get())`
- [ ] `PATCH /api/settings` → validate, update, broadcast `{ type: 'settingsUpdated', settings }`, return updated
- [ ] `POST /api/settings/reset` → reset(section), broadcast, return updated
- [ ] 400 on validation errors with `{ error: message }`

**Tests (`test/settings-routes.test.js`):**
- [ ] GET returns defaults when no user settings
- [ ] PATCH updates and returns merged settings
- [ ] PATCH broadcasts `settingsUpdated` message
- [ ] PATCH with invalid policy returns 400
- [ ] PATCH with invalid iteration returns 400
- [ ] POST reset clears settings, broadcasts, returns defaults
- [ ] POST reset with section clears only that section

**Pattern:** `server/vision-routes.js:45` (attachXRoutes signature, error handling)

---

### Task 3: Wire SettingsStore into VisionServer

**Files:** `server/vision-server.js` (existing)

**Depends on:** Task 2

- [ ] Import `SettingsStore` from `./settings-store.js`
- [ ] Import `attachSettingsRoutes` from `./settings-routes.js`
- [ ] Import `CONTRACT` from `./lifecycle-constants.js`
- [ ] Construct `this.settingsStore = new SettingsStore(undefined, CONTRACT)` in `attach()` before route registration
- [ ] Call `attachSettingsRoutes(app, { settingsStore, broadcastMessage })` after existing route registrations
- [ ] Pass `settingsStore: this.settingsStore` in the deps object to `attachVisionRoutes()`
- [ ] In WS `onconnection` handler (line 132), send `settingsState` message after `visionState`:
  ```js
  ws.send(JSON.stringify({ type: 'settingsState', settings: this.settingsStore.get() }));
  ```

**Verify:** Run existing tests — no regressions. `GET /api/settings` returns defaults from a running server.

---

### Task 4: Wire SettingsStore into policy engine + lifecycle manager

**Files:** `server/policy-engine.js` (existing), `server/lifecycle-manager.js` (existing), `server/vision-routes.js` (existing), `test/policy-engine.test.js` (existing), `test/lifecycle-manager.test.js` (existing)

**Depends on:** Task 3

- [ ] `server/policy-engine.js`: Add third parameter `settingsPolicies` to `evaluatePolicy(targetPhase, overrides, settingsPolicies)`. Insert in fallback chain: `ov[targetPhase] ?? settingsPolicies?.[targetPhase] ?? DEFAULT_POLICIES[targetPhase] ?? 'skip'`
- [ ] `server/lifecycle-manager.js`: Accept `settingsStore` as third constructor parameter, store as `#settingsStore`
- [ ] `advancePhase` (line 75): pass `this.#settingsStore?.get()?.policies` as third arg to `evaluatePolicy`
- [ ] `skipPhase` (line 104): same
- [ ] `startIterationLoop` (line 233): read `this.#settingsStore?.get()?.iterations?.[loopType]?.maxIterations` as middle fallback
- [ ] `server/vision-routes.js` (line 121): pass `settingsStore` to `new LifecycleManager(store, featureRoot, settingsStore)`

**Tests:**
- [ ] `test/policy-engine.test.js`: add test for settings override in fallback chain (feature override > settings > contract)
- [ ] `test/lifecycle-manager.test.js`: verify iteration limits respect settings override
- [ ] All existing policy/lifecycle tests still pass (settingsPolicies=undefined preserves old behavior)

---

### Task 5: Agent server reads settings from disk

**Files:** `server/agent-server.js` (existing)

**Depends on:** Task 1 (settings.json format)

- [ ] Add `import { readFileSync } from 'node:fs'` at top
- [ ] Add `SETTINGS_FILE = path.join(PROJECT_ROOT, 'data', 'settings.json')`
- [ ] Add `_readModelSetting()` function: try/catch readFileSync + JSON.parse, return `settings.models?.interactive` or null
- [ ] Replace line 156 `model: 'claude-sonnet-4-6'` with `model: _readModelSetting() || 'claude-sonnet-4-6'`

**Verify:** No test changes needed — agent-server tests don't mock the model. Manual verification: write a `data/settings.json` with `models.interactive: 'claude-haiku-4-5-20251001'`, restart agent server, verify it uses that model.

---

### Task 6: Bug fixes (agent-hooks port, Vite port env)

**Files:** `server/agent-hooks.js` (existing), `server/supervisor.js` (existing)

**Depends on:** Nothing (independent)

- [ ] `server/agent-hooks.js` line 12: change `'http://127.0.0.1:3001'` to `` `http://127.0.0.1:${process.env.PORT || 3001}` ``
- [ ] `server/supervisor.js` line 41: change `port: 5173` to `port: process.env.VITE_PORT || 5173`

**Verify:** Run existing tests. No new tests needed — these are env-var wiring fixes.

---

### Task 7: Client WS handler + useVisionStore settings state

**Files:** `src/components/vision/visionMessageHandler.js` (existing), `src/components/vision/useVisionStore.js` (existing), `test/settings-client.test.js` (new)

**Depends on:** Task 3 (server sends settingsState/settingsUpdated)

- [ ] `visionMessageHandler.js` line 17: add `setSettings` to destructured setters
- [ ] After last else-if block (~line 189): add handler for `settingsState` and `settingsUpdated` → `setSettings(msg.settings || null)`
- [ ] `useVisionStore.js` line ~83: add `const [settings, setSettings] = useState(null)`
- [ ] Lines 112-114: add `setSettings` to setters object
- [ ] Add `updateSettings(patch)` useCallback: PATCH `/api/settings`, return json
- [ ] Add `resetSettings(section?)` useCallback: POST `/api/settings/reset` with `{ section }`, return json
- [ ] Return object: add `settings`, `updateSettings`, `resetSettings`

**Tests (`test/settings-client.test.js`):**
- [ ] `settingsState` message calls `setSettings` with settings payload
- [ ] `settingsUpdated` message calls `setSettings` with updated payload
- [ ] Missing `setSettings` in setters does not crash (guard with `if (setSettings)`)

---

### Task 8: Settings sidebar entry + SettingsPanel UI

**Files:** `src/components/vision/AppSidebar.jsx` (existing), `src/components/vision/SettingsPanel.jsx` (new), `src/components/vision/VisionTracker.jsx` (existing)

**Depends on:** Task 7

- [ ] `AppSidebar.jsx` line 2: add `Settings2` to lucide-react imports
- [ ] `AppSidebar.jsx` line 19: add `{ key: 'settings', label: 'Settings', icon: Settings2 }` to VIEWS
- [ ] Create `SettingsPanel.jsx`:
  - Props: `settings`, `onSettingsChange(patch)`, `onReset(section?)`
  - Section 1: Phase Policies — 10 rows, dropdown per phase (gate/flag/skip; null only for explore_design)
  - Section 2: Iteration Limits — 2 number inputs (review max, coverage max) with min=1 max=100
  - Section 3: Agent Models — 3 text inputs (interactive, agentRun, summarizer)
  - Section 4: Appearance — theme dropdown (light/dark/system), default view dropdown
  - Each field calls `onSettingsChange({ [section]: { [key]: value } })` immediately on change
  - Theme dropdown additionally applies DOM class and localStorage (same mechanism as App.jsx toggleTheme)
  - Reset to Defaults button at bottom: calls `onReset()` (no section = full reset) with confirmation dialog
- [ ] `VisionTracker.jsx` line 13: import `SettingsPanel`
- [ ] `VisionTracker.jsx` lines 23-24: destructure `settings`, `updateSettings`, `resetSettings` from `useVisionStore()`
- [ ] After line 223 (after gates view): add `{activeView === 'settings' && <SettingsPanel settings={settings} onSettingsChange={updateSettings} onReset={resetSettings} />}`
- [ ] `VisionTracker.jsx` line 27 (activeView init): read `settings?.ui?.defaultView` as fallback when no sessionStorage value:
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

- [ ] `GET /api/settings` returns merged defaults + user overrides
- [ ] `PATCH /api/settings` persists, validates, broadcasts
- [ ] Policy engine uses settings as middle fallback layer
- [ ] Iteration limits respect settings override
- [ ] Agent server reads model from `data/settings.json`
- [ ] Settings panel renders in sidebar with all 4 sections
- [ ] WS broadcasts settings changes to all clients
- [ ] Agent hooks port bug fixed
- [ ] Vite port env escape added
- [ ] All existing tests pass + new tests for store, routes, client, policy chain
