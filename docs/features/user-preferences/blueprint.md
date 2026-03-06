# L0 Blueprint: User Preferences System

## Related Documents

- `docs/features/user-preferences/design.md` — Design spec

## New Files

### `server/settings-store.js` (new)

SettingsStore class following VisionStore pattern (`server/vision-store.js:22-69`).

```
SettingsStore
  constructor(dataDir, contract)
    - dataDir defaults to path.resolve(import.meta.dirname, '..', 'data')
    - contract is the CONTRACT export from lifecycle-constants.js
    - this._file = path.join(dataDir, 'settings.json')
    - this._userSettings = {} (empty until first write)
    - this._contract = contract
    - call this._load()

  _load()
    - try readFileSync(this._file, 'utf8'), JSON.parse
    - on ENOENT: this._userSettings = {} (clean start, no file yet)
    - on other error: console.error, this._userSettings = {}

  _save()
    - mkdirSync(path.dirname(this._file), { recursive: true })
    - writeFileSync(this._file, JSON.stringify(this._userSettings, null, 2))

  _defaults()
    - returns {
        policies: Object.fromEntries(
          this._contract.phases.map(p => [p.id, p.defaultPolicy])
        ),
        iterations: this._contract.iterationDefaults,
        models: {
          interactive: 'claude-sonnet-4-6',
          agentRun: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
          summarizer: process.env.SUMMARIZER_MODEL || 'haiku',
        },
        ui: { theme: 'system', defaultView: 'attention' },
      }

  get()
    - deep-merge _defaults() with _userSettings
    - user values override defaults at leaf level
    - null user value = use default

  update(patch)
    - validate patch (see Validation section)
    - deep-merge patch into this._userSettings
    - this._save()
    - return this.get()

  reset(section?)
    - if section: delete this._userSettings[section]
    - else: this._userSettings = {}
    - this._save()
    - return this.get()
```

**Validation rules:**
- `patch.policies[phase]` must be in `CONTRACT.policyModes` or `null`
- `patch.iterations[type].maxIterations` must be integer >= 1 and <= 100
- `patch.models[key]` must be non-empty string
- `patch.ui.theme` must be one of `'light'`, `'dark'`, `'system'`
- `patch.ui.defaultView` must be one of the VIEWS keys
- Unknown top-level keys are rejected

### `server/settings-routes.js` (new)

Follows `server/vision-routes.js:45` pattern — `export function attachSettingsRoutes(app, { settingsStore, broadcastMessage })`.

| Method | Path | Handler |
|--------|------|---------|
| GET | `/api/settings` | `res.json(settingsStore.get())` |
| PATCH | `/api/settings` | `const updated = settingsStore.update(req.body); broadcastMessage({ type: 'settingsUpdated', settings: updated }); res.json(updated)` |
| POST | `/api/settings/reset` | `const updated = settingsStore.reset(req.body.section); broadcastMessage({ type: 'settingsUpdated', settings: updated }); res.json(updated)` |

Error handling: validation errors return 400 with `{ error: message }`.

### `src/components/vision/SettingsPanel.jsx` (new)

Sidebar panel component. Receives `settings` and `onSettingsChange(patch)` as props.

4 sections:
1. **Phase Policies** — 10 rows, each with phase label + dropdown (gate/flag/skip/null for explore_design)
2. **Iteration Limits** — 2 number inputs (review max, coverage max)
3. **Agent Models** — 3 text inputs or dropdowns (interactive, agentRun, summarizer)
4. **Appearance** — theme dropdown (light/dark/system), default view dropdown

Each field calls `onSettingsChange({ [section]: { [key]: value } })` on change. The parent (`VisionTracker.jsx` or `App.jsx`) calls `PATCH /api/settings` with the patch.

Uses existing UI primitives: `ScrollArea`, `Select`, `Input`, `Button`, `Separator` from the shadcn-style components already in the project.

### `test/settings-client.test.js` (new)

Tests for WS handler: `settingsState` and `settingsUpdated` message types call `setSettings`.

### `test/settings-store.test.js` (new)

Tests for SettingsStore: constructor defaults, get() merge, update() persist, reset(), validation errors.

### `test/settings-routes.test.js` (new)

Tests for REST API: GET defaults, PATCH validates, PATCH broadcasts, reset, 400 on invalid.

## Modified Files

### `server/vision-server.js`

**Line 33 (attach method) — add settingsStore construction:**
```js
// After this.store initialization, before route registration:
this.settingsStore = new SettingsStore(undefined, CONTRACT);
```

**Line ~114 (after stratum sync, before Haiku summary) — register settings routes:**
```js
attachSettingsRoutes(app, {
  settingsStore: this.settingsStore,
  broadcastMessage: (msg) => this.broadcastMessage(msg),
});
```

**Lines 127-135 (WS onconnection) — push initial settings:**
```js
// After line 132 (visionState push):
ws.send(JSON.stringify({ type: 'settingsState', settings: this.settingsStore.get() }));
```

**Pass settingsStore to attachVisionRoutes (where LifecycleManager is constructed):**
```js
// The existing attachVisionRoutes call must include settingsStore in deps:
attachVisionRoutes(app, { store, scheduleBroadcast, broadcastMessage, projectRoot, settingsStore: this.settingsStore });
```

**Imports to add:**
```js
import { SettingsStore } from './settings-store.js';
import { attachSettingsRoutes } from './settings-routes.js';
import { CONTRACT } from './lifecycle-constants.js';
```

### `server/policy-engine.js`

**Line 24-31 — add settingsStore parameter:**
```js
// Current signature:
export function evaluatePolicy(targetPhase, overrides)

// New signature:
export function evaluatePolicy(targetPhase, overrides, settingsPolicies)

// Line 26 — new fallback chain:
const mode = ov[targetPhase] ?? settingsPolicies?.[targetPhase] ?? DEFAULT_POLICIES[targetPhase] ?? 'skip';
```

No import changes — `settingsPolicies` is a plain object passed by callers.

### `server/vision-routes.js`

**Line 121 — wire settingsStore into LifecycleManager construction:**

This is the ONLY place LifecycleManager is instantiated. The constructor call must receive settingsStore.

```js
// Current (line 121):
const lifecycleManager = new LifecycleManager(store, path.join(projectRoot, 'docs', 'features'));

// New:
const lifecycleManager = new LifecycleManager(store, path.join(projectRoot, 'docs', 'features'), settingsStore);
```

`settingsStore` must be added to the deps object received by `attachVisionRoutes`:
```js
// Current signature:
export function attachVisionRoutes(app, { store, scheduleBroadcast, broadcastMessage, projectRoot })

// New:
export function attachVisionRoutes(app, { store, scheduleBroadcast, broadcastMessage, projectRoot, settingsStore })
```

### `server/lifecycle-manager.js`

**Constructor — accept settingsStore as third parameter:**
```js
// Current constructor:
constructor(store, featureRoot)

// New:
constructor(store, featureRoot, settingsStore)
// Add to private fields:
this.#settingsStore = settingsStore || null;
```

**Line 75 (advancePhase) — pass settings policies to evaluatePolicy:**
```js
const settingsPolicies = this.#settingsStore?.get()?.policies;
const policy = evaluatePolicy(targetPhase, lifecycle.policyOverrides, settingsPolicies);
```

**Line 104 (skipPhase) — same pattern:**
```js
const settingsPolicies = this.#settingsStore?.get()?.policies;
const policy = evaluatePolicy(targetPhase, lifecycle.policyOverrides, settingsPolicies);
```

**Line 233 (startIterationLoop) — settings iteration override:**
```js
const settingsIter = this.#settingsStore?.get()?.iterations?.[loopType];
maxIterations: maxIterations || settingsIter?.maxIterations || defaults.maxIterations,
```

### `server/agent-server.js`

**Process boundary:** agent-server.js runs as a separate supervised process (`node server/agent-server.js`). It cannot receive an in-memory settingsStore from vision-server.js.

**Solution:** Read `data/settings.json` directly from disk on each query. The file is small and reads are infrequent (one per agent session start). This matches how `lifecycle-constants.js` reads the contract file.

**Line 156 — replace hardcoded model with file-based settings read:**
```js
// Add at top of file (after line 23):
import { readFileSync } from 'node:fs';
const SETTINGS_FILE = path.join(PROJECT_ROOT, 'data', 'settings.json');

function _readModelSetting() {
  try {
    const settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    return settings.models?.interactive;
  } catch { return null; }
}

// Line 156 — replace:
model: 'claude-sonnet-4-6',
// With:
model: _readModelSetting() || 'claude-sonnet-4-6',
```

This reads fresh from disk on every query build, picking up settings changes without restart. The `try/catch` handles the file-not-found case (returns null → uses default).

### `server/agent-hooks.js`

**Line 12 — fix hardcoded port (bug fix):**
```js
// Current:
const API_SERVER = 'http://127.0.0.1:3001';

// Fixed:
const API_SERVER = `http://127.0.0.1:${process.env.PORT || 3001}`;
```

### `server/supervisor.js`

**Line 41 — add Vite port env escape (bug fix):**
```js
// Current:
{ name: 'vite', port: 5173, type: 'spawn' },

// Fixed:
{ name: 'vite', port: process.env.VITE_PORT || 5173, type: 'spawn' },
```

### `src/components/vision/AppSidebar.jsx`

**Line 2 (imports) — add Settings2 icon:**
```js
import { ..., Settings2 } from 'lucide-react';
```

**Line 19 (VIEWS array) — add settings entry:**
```js
{ key: 'settings', label: 'Settings', icon: Settings2 },
```

**Theme toggle section (~line 98-103) — remove direct theme manipulation. Theme is now controlled via settings API. The toggle button calls `onSettingsChange({ ui: { theme: nextTheme } })` instead of directly toggling classList.**

### `src/components/vision/VisionTracker.jsx`

**Line 13 (imports) — add SettingsPanel:**
```js
import SettingsPanel from './SettingsPanel.jsx';
```

**Lines 23-24 (useVisionStore destructuring) — add `settings` and `updateSettings`:**
```js
const { items, connections, gates, gateEvent, resolveGate, settings, updateSettings, ... } = useVisionStore();
```

**After line 223 (after gates view, before the closing `</div>`) — add settings view:**
```js
{activeView === 'settings' && (
  <SettingsPanel
    settings={settings}
    onSettingsChange={updateSettings}
  />
)}
```

This follows the exact same `{activeView === 'key' && <Component ... />}` pattern used by all other views (lines 156-223). The `settings` state and `updateSettings` function come from `useVisionStore`.

### `src/components/vision/useVisionStore.js`

**Line ~83 — add settings state:**
```js
const [settings, setSettings] = useState(null);
```

**Lines 112-114 — add setSettings to setters object passed to handleVisionMessage.**

**Return object (~line 254) — add `settings`.**

**Add a `updateSettings(patch)` helper alongside existing mutation helpers:**
```js
const updateSettings = useCallback(async (patch) => {
  const res = await fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error('Settings update failed');
  return res.json();
}, []);
```

### `src/components/vision/visionMessageHandler.js`

**Line 17 — add setSettings to destructured setters.**

**After the last else-if block (~line 189) — add settings handler:**
```js
} else if (msg.type === 'settingsState' || msg.type === 'settingsUpdated') {
  if (setSettings) setSettings(msg.settings || null);
}
```

### `src/App.jsx`

**No changes to App.jsx for settings integration.** Theme and fontSize are owned here (lines 127-144) and rendered in the top chrome bar (lines 197-229). App.jsx does NOT have access to `useVisionStore` — it lives above the Canvas/VisionTracker boundary.

Theme persistence is handled entirely within SettingsPanel (inside VisionTracker):
- SettingsPanel's theme dropdown calls `updateSettings({ ui: { theme: value } })` to persist
- SettingsPanel also applies theme directly to the DOM: `document.documentElement.classList.toggle('dark', value === 'dark')` and updates `localStorage.setItem('compose:theme', value)` — same mechanism App.jsx uses today
- The existing `toggleTheme` in App.jsx continues to work for the top-bar toggle button; it writes to localStorage and toggles the DOM class as it does now
- On page load, `loadTheme()` reads from the DOM class (which Tailwind sets from the `dark` class). Settings sync happens when the WS connects and SettingsPanel receives the initial `settingsState` message.

This avoids crossing the App/VisionTracker boundary. Both the top-bar toggle and the SettingsPanel dropdown produce the same result (DOM class + localStorage). The SettingsPanel additionally persists to the server.

## Corrections Table

| Blueprint Assumption | Actual Code | Status |
|---------------------|-------------|--------|
| VisionStore uses `import.meta.dirname` | Yes, `vision-store.js:15` | Confirmed |
| evaluatePolicy is stateless, no store access | Yes, `policy-engine.js:24-31` | Confirmed |
| LifecycleManager uses private fields (#store) | Yes, `lifecycle-manager.js:239` uses `#store` | Confirmed |
| Agent server model at line 156 | Yes, `agent-server.js:156` hardcodes `'claude-sonnet-4-6'` | Confirmed |
| Agent server is a separate supervised process | Yes, `agent-server.js:1-11` — standalone, no factory function | Confirmed — reads settings.json from disk |
| LifecycleManager constructed in vision-routes.js:121 | Yes, only construction site | Confirmed — settingsStore passed via deps |
| VIEWS array at AppSidebar.jsx:11-20 | Yes, exactly 8 entries | Confirmed |
| WS message handler is an if/else-if chain | Yes, `visionMessageHandler.js` uses if/else-if through line 189 | Confirmed |
| useVisionStore has setters object at lines 112-114 | Yes | Confirmed |
| broadcastMessage takes a plain object | Yes, `vision-server.js:182-193` | Confirmed |
| Initial WS push at onconnection handler | Yes, `vision-server.js:127-135` | Confirmed |
| agent-hooks.js hardcodes port 3001 | Yes, `agent-hooks.js:12` | Confirmed |
| supervisor.js Vite port has no env escape | Yes, `supervisor.js:41` hardcodes 5173 | Confirmed |
