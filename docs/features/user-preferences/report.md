# L0 Implementation Report: User Preferences System

## Related Documents

- `docs/features/user-preferences/design.md` — Design spec
- `docs/features/user-preferences/blueprint.md` — Blueprint with file:line references
- `docs/features/user-preferences/plan.md` — Implementation plan (8 tasks)

## 1. Summary

Full user preferences system implemented across server, client, and agent processes. Settings are persisted to `data/settings.json`, exposed via REST API, broadcast over WebSocket, and rendered in a new Settings panel in the sidebar. The policy engine and lifecycle manager now use user settings as a middle fallback layer between per-feature overrides and contract defaults.

## 2. Delivered vs Planned

All 8 planned tasks delivered. No tasks deferred or descoped.

| Task | Status | Notes |
|------|--------|-------|
| 1. SettingsStore + tests | Complete | 21 tests |
| 2. Settings REST API + tests | Complete | 10 tests |
| 3. Wire into VisionServer | Complete | WS settingsState on connect |
| 4. Policy/lifecycle integration | Complete | 3 new tests |
| 5. Agent server disk read | Complete | _readModelSetting() |
| 6. Bug fixes (agent-hooks port, vite port) | Complete | — |
| 7. Client WS handler + useVisionStore | Complete | 3 tests |
| 8. Settings panel UI | Complete | Build passes |
| — E2E smoke test | Complete | 6 tests |

## 3. Architecture Deviations

**None.** Implementation follows the design and blueprint exactly.

Key design decisions preserved:
- Agent server reads `data/settings.json` from disk (process boundary respected)
- Theme applies to DOM immediately + persists to server (not blocked on API response)
- `defaultView` uses one-time `useRef` guard with mount-time sessionStorage check
- Policy fallback chain: feature overrides > settings > contract defaults > 'skip'

## 4. Key Implementation Decisions

1. **Theme synchronization via MutationObserver**: App.jsx header toggle derives `isDark` from a MutationObserver on `document.documentElement.classList`, eliminating stale state when sidebar or settings panel changes theme independently.

2. **Controlled model inputs with local state**: SettingsPanel model fields use a `ModelInput` component with local state synced from props via `useEffect`, enabling proper controlled behavior while still committing on blur for UX.

3. **`hadSessionView` ref for defaultView**: Captures whether sessionStorage had a value at mount time before the persistence effect runs, preventing the eager write from blocking the defaultView application.

4. **Fire-and-forget PATCH from theme toggles**: Both App.jsx header and AppSidebar toggles apply DOM changes immediately and fire a non-blocking `fetch` to `/api/settings`. This keeps the UI responsive while ensuring server persistence and WS broadcast.

## 5. Test Coverage

| Test File | Tests | Coverage |
|-----------|-------|----------|
| settings-store.test.js | 21 | Store CRUD, validation, persistence, corrupt files |
| settings-routes.test.js | 10 | REST API (GET/PATCH/POST), validation errors, broadcasts |
| settings-client.test.js | 3 | WS message handling, null safety |
| settings-e2e.test.js | 6 | Full server round-trip: REST + WS + reset |
| policy-engine.test.js | +1 | Settings as middle fallback in policy chain |
| iteration-manager.test.js | +2 | Settings override for iteration limits |
| **Total new** | **43** | — |

Full suite: **375 tests, 0 failures**.

## 6. Files Changed

### New files
- `server/settings-store.js` — SettingsStore class
- `server/settings-routes.js` — REST API routes
- `src/components/vision/SettingsPanel.jsx` — Settings panel UI
- `test/settings-store.test.js` — Store unit tests
- `test/settings-routes.test.js` — Route tests
- `test/settings-client.test.js` — WS client tests
- `test/settings-e2e.test.js` — E2E smoke tests

### Modified files
- `server/vision-server.js` — SettingsStore construction, settings routes, WS settingsState
- `server/vision-routes.js` — Pass settingsStore to LifecycleManager
- `server/policy-engine.js` — Third param `settingsPolicies` in evaluatePolicy()
- `server/lifecycle-manager.js` — Accept settingsStore, use in policy eval + iteration limits
- `server/agent-server.js` — _readModelSetting() from disk
- `server/agent-hooks.js` — Fixed hardcoded port (bug fix)
- `server/supervisor.js` — Fixed Vite port env (bug fix)
- `src/components/vision/visionMessageHandler.js` — settingsState/settingsUpdated handlers
- `src/components/vision/useVisionStore.js` — settings state, updateSettings, resetSettings
- `src/components/vision/AppSidebar.jsx` — Settings view entry, theme toggle syncs to API
- `src/components/vision/VisionTracker.jsx` — SettingsPanel rendering, defaultView effect
- `src/App.jsx` — Theme toggle syncs to API, MutationObserver for cross-control sync

### Modified test files
- `test/policy-engine.test.js` — Settings fallback chain test
- `test/iteration-manager.test.js` — Settings iteration override tests

## 7. Known Issues & Tech Debt

1. **No file locking on settings.json**: Concurrent writes from multiple PATCH requests use last-write-wins. Low risk — single user, synchronous writes.

2. **Agent server reads disk on every query**: `_readModelSetting()` does a fresh `readFileSync` per agent spawn. Could cache with file watcher, but the overhead is negligible for the spawn frequency.

3. **VisionServer constructs SettingsStore with project default path**: In tests, this reads from the real `data/` directory. E2E test works around this with a reset-first pattern.

## 8. Lessons Learned

1. **Eager sessionStorage writes block deferred defaults**: Any `useEffect` that writes to storage on mount creates a race with async state that arrives later. Capturing the initial state in a `useRef` at construction time is the cleanest fix.

2. **Multiple theme controls need a shared truth**: Three independent theme toggles (header, sidebar, settings panel) each maintaining their own state creates synchronization bugs. Deriving from the DOM class via MutationObserver eliminates the problem.

3. **Process boundaries require file-based communication**: The agent server runs as a separate supervised process and cannot receive in-memory store injection. Reading the settings file from disk is the correct pattern for cross-process configuration.
