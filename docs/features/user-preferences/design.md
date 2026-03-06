# L0 Design: User Preferences System

## Related Documents

- `ROADMAP.md` — Item 21 (L0 — User Preferences Inventory)
- `contracts/lifecycle.json` — Current source of truth for policy defaults and iteration limits
- `docs/plans/2026-02-15-lifecycle-engine-roadmap.md` — Original L0 scoping

## Problem

Compose has ~15 configurable values hardcoded across server files, the lifecycle contract, and client components. Users cannot change policy defaults, iteration limits, agent models, or UI behavior without editing source code or knowing env var names. L1–L6 are complete — the lifecycle engine works — but the engine has no dials.

## Goals

- **MUST:** Persistent, project-level configuration file that the server reads at startup
- **MUST:** REST API to read and update settings at runtime
- **MUST:** Settings panel in the Vision Surface sidebar for visual configuration
- **MUST:** WebSocket broadcast on settings change so all clients stay in sync
- **SHOULD:** Settings take effect without server restart where possible
- **SHOULD:** Validate settings against the lifecycle contract schema
- **MAY:** Per-user settings (deferred — project-level is sufficient for V1)

## Non-Goals

- Per-user preferences (all settings are project-level)
- Settings migration tooling (V1 is the first version — nothing to migrate)
- Remote/cloud settings sync

## Design

### Settings File

`data/settings.json` — co-located with `vision-state.json` in the existing `data/` directory. Follows the same synchronous read/write pattern as `VisionStore`.

```json
{
  "$schema": "./settings-schema.json",
  "version": "1.0.0",
  "policies": {
    "explore_design": null,
    "prd": "skip",
    "architecture": "skip",
    "blueprint": "gate",
    "verification": "gate",
    "plan": "gate",
    "execute": "flag",
    "report": "skip",
    "docs": "flag",
    "ship": "gate"
  },
  "iterations": {
    "review": { "maxIterations": 10 },
    "coverage": { "maxIterations": 15 }
  },
  "models": {
    "interactive": "claude-sonnet-4-6",
    "agentRun": "claude-sonnet-4-6",
    "summarizer": "haiku"
  },
  "ui": {
    "theme": "system",
    "defaultView": "attention"
  }
}
```

When the file doesn't exist, the server uses contract defaults. The file is only written when the user explicitly saves a preference — no file = all defaults.

### Settings Store

`server/settings-store.js` — a minimal class following the `VisionStore` pattern:

```
SettingsStore
  constructor(dataDir)   — readFileSync or fall back to defaults
  get()                  — returns merged { ...contractDefaults, ...userOverrides }
  update(patch)          — deep-merge patch into stored settings, _save(), return merged
  reset(section?)        — remove user overrides (full or per-section), _save()
  _save()                — writeFileSync to data/settings.json
```

**Merge strategy:** Contract defaults are always the base layer. User settings overlay them. A `null` value in user settings means "use contract default." Deleting a key from `settings.json` reverts to default.

**Validation:** On `update()`, validate policy values against `CONTRACT.policyModes`, iteration limits against `>= 1 && <= 100`, model strings against a known set (or allow any string for future models).

### Integration Points

#### Policy Engine

`server/policy-engine.js` currently:
```js
const mode = ov[targetPhase] ?? DEFAULT_POLICIES[targetPhase] ?? 'skip';
```

With settings, the lookup chain becomes:
```js
const mode = ov[targetPhase] ?? settingsStore.get().policies[targetPhase] ?? DEFAULT_POLICIES[targetPhase] ?? 'skip';
```

The per-feature `policyOverrides` (on the lifecycle object) still wins. Settings provides the global default layer between feature overrides and contract defaults.

**Priority:** feature policyOverrides > settings.policies > contract defaultPolicy > 'skip'

#### Iteration Defaults

`server/lifecycle-manager.js` currently:
```js
const defaults = ITERATION_DEFAULTS[loopType];
maxIterations: maxIterations || defaults.maxIterations,
```

With settings:
```js
const settingsDefaults = settingsStore.get().iterations[loopType];
const contractDefaults = ITERATION_DEFAULTS[loopType];
maxIterations: maxIterations || settingsDefaults?.maxIterations || contractDefaults.maxIterations,
```

#### Agent Model

`server/agent-server.js` currently hardcodes `'claude-sonnet-4-6'`. With settings:
```js
model: settingsStore.get().models.interactive,
```

Same for `claude-sdk-connector.js` (reads `settingsStore.get().models.agentRun`).

#### UI Theme

The client currently has a broken theme persistence (writes to localStorage but doesn't read on startup). The settings system replaces this:
- Server stores `ui.theme` in settings.json
- Client reads from settings on connect (initial state via WS `visionState` or dedicated `settings` message)
- Theme toggle in sidebar writes via REST API, receives confirmation via WS broadcast
- All clients sync — no more localStorage-only theme that differs per tab

### REST API

`server/settings-routes.js` — follows the `attachXRoutes(app, deps)` pattern.

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | `/api/settings` | — | Full merged settings |
| PATCH | `/api/settings` | `{ policies?: {}, iterations?: {}, models?: {}, ui?: {} }` | Updated merged settings |
| POST | `/api/settings/reset` | `{ section?: string }` | Reset to defaults (full or per-section) |

PATCH does a deep merge — you can send `{ policies: { prd: "gate" } }` without touching other fields.

### WebSocket

On any settings change, broadcast:
```json
{ "type": "settingsUpdated", "settings": { ...mergedSettings } }
```

The initial `visionState` message on connect will include a `settings` field so the client has settings on first render.

### Settings Panel UI

`src/components/vision/SettingsPanel.jsx` — a new sidebar view.

**Layout:**
```
┌─ Settings ──────────────────────┐
│                                 │
│ Phase Policies                  │
│ ┌─────────────┬───────────────┐ │
│ │ explore     │ [null]        │ │
│ │ prd         │ [skip ▾]      │ │
│ │ architecture│ [skip ▾]      │ │
│ │ blueprint   │ [gate ▾]      │ │
│ │ ...         │ ...           │ │
│ └─────────────┴───────────────┘ │
│                                 │
│ Iteration Limits                │
│ ┌─────────────┬───────────────┐ │
│ │ Review max  │ [10    ]      │ │
│ │ Coverage max│ [15    ]      │ │
│ └─────────────┴───────────────┘ │
│                                 │
│ Agent Models                    │
│ ┌─────────────┬───────────────┐ │
│ │ Interactive │ [sonnet-4-6 ▾]│ │
│ │ Agent run   │ [sonnet-4-6 ▾]│ │
│ │ Summarizer  │ [haiku ▾]     │ │
│ └─────────────┴───────────────┘ │
│                                 │
│ Appearance                      │
│ ┌─────────────┬───────────────┐ │
│ │ Theme       │ [system ▾]    │ │
│ │ Default view│ [attention ▾] │ │
│ └─────────────┴───────────────┘ │
│                                 │
│ [Reset to Defaults]             │
└─────────────────────────────────┘
```

**Behavior:**
- Each field writes immediately on change (no Save button) via PATCH `/api/settings`
- Optimistic UI — update local state immediately, revert on error
- Policy dropdowns show `gate`, `flag`, `skip` (and `null` for explore_design only)
- Model dropdowns show known models; allow free-text input for custom model IDs
- "Reset to Defaults" button calls POST `/api/settings/reset` with confirmation dialog

**Integration into sidebar:**
- Add `{ key: 'settings', label: 'Settings', icon: Settings }` to the `VIEWS` array in `AppSidebar.jsx`
- Render `<SettingsPanel>` when `activeView === 'settings'`
- SettingsPanel is its own component (isolated re-renders, same pattern as AgentPanel)

### Bug Fixes (shipped with L0)

1. **Theme persistence** — Remove the broken localStorage theme code from `App.jsx` and `AppSidebar.jsx`. Theme is now server-authoritative via settings.
2. **Agent hooks port** — `agent-hooks.js` hardcodes `http://127.0.0.1:3001`. Fix to use `process.env.PORT || 3001`.
3. **Vite port env** — `supervisor.js` hardcodes Vite on 5173 with no env escape. Add `process.env.VITE_PORT || 5173`.

### What L0 Does NOT Configure

These remain hardcoded — not worth the complexity:
- Feature folder root (`docs/features/`) — project convention, not a preference
- Artifact word count minimums — quality gates, not preferences
- WebSocket reconnect timing, broadcast debounce — implementation details
- Session end banner duration, activity log caps — minor UI internals
- Supervisor backoff constants — operational, not user-facing

## Approach: 2 Approaches

### A: Settings as separate overlay file

Settings live in `data/settings.json`, completely separate from `contracts/lifecycle.json`. The contract remains immutable. Settings overlay contract defaults at runtime.

**Pro:** Clean separation. Contract is the spec, settings are the instance.
**Con:** Two files define "what policy does blueprint use" — mental model requires understanding the merge.

### B: Settings extend the contract

Settings are written back into a copy of the contract (e.g., `data/lifecycle-local.json`) that takes precedence over the base contract.

**Pro:** Single file to check for "what are my policies."
**Con:** Couples user preferences to the contract schema. Contract updates require migration. Violates the contract-as-immutable-spec principle.

**Recommendation: A.** The contract is the spec. Settings are the instance overlay. This matches how CSS works (defaults + overrides), how package.json + .npmrc work, and how the existing `policyOverrides` per-feature mechanism already works.

## Acceptance Criteria

- [ ] `data/settings.json` created on first preference change, not on server start
- [ ] `GET /api/settings` returns merged defaults + overrides
- [ ] `PATCH /api/settings` validates and persists, broadcasts `settingsUpdated`
- [ ] `POST /api/settings/reset` clears overrides (full or per-section)
- [ ] Policy engine uses settings as middle layer: feature override > settings > contract
- [ ] Iteration limits use settings as middle layer: per-call > settings > contract
- [ ] Agent model reads from settings (interactive + agentRun)
- [ ] Settings panel renders in sidebar with all 4 sections
- [ ] Policy dropdowns validate against `CONTRACT.policyModes`
- [ ] Theme persisted server-side, synced via WS, broken localStorage code removed
- [ ] Agent hooks port bug fixed
- [ ] Vite port env escape added
- [ ] Settings broadcast on WS connect (initial state)
- [ ] All existing tests still pass
- [ ] New tests: settings store (CRUD, merge, validation), settings routes, settings WS broadcast
