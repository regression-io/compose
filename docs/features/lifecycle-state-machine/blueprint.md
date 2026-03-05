# Feature Lifecycle State Machine: Implementation Blueprint

**Status:** BLUEPRINT
**Date:** 2026-03-05
**Design:** [design.md](./design.md)

---

## File Plan

| File | Action | Lines |
|------|--------|-------|
| `server/lifecycle-manager.js` | **Create** | ~200 |
| `server/vision-store.js` | **Edit** | ~10 lines changed |
| `server/compose-mcp-tools.js` | **Edit** | ~80 lines added |
| `server/compose-mcp.js` | **Edit** | ~60 lines added |
| `server/vision-routes.js` | **Edit** | ~40 lines added |
| `server/vision-server.js` | **No change** | — |
| `test/lifecycle-manager.test.js` | **Create** | ~300 |

---

## 1. `server/lifecycle-manager.js` (new)

### Constants

```js
// Phase ordering — index determines forward direction
const PHASES = [
  'explore_design', 'prd', 'architecture', 'blueprint',
  'verification', 'plan', 'execute', 'report', 'docs', 'ship',
];

const TERMINAL = new Set(['complete', 'killed']);
const SKIPPABLE = new Set(['prd', 'architecture', 'report']);

// Transition graph — each phase maps to its valid successors
const TRANSITIONS = {
  explore_design: ['prd', 'architecture', 'blueprint'],
  prd:            ['architecture', 'blueprint'],
  architecture:   ['blueprint'],
  blueprint:      ['verification'],
  verification:   ['plan', 'blueprint'],  // blueprint = revision loop
  plan:           ['execute'],
  execute:        ['report', 'docs'],
  report:         ['docs'],
  docs:           ['ship'],
  ship:           [],  // terminal via completeFeature()
};

// Artifact file names per phase (only phases that produce feature-folder files)
const PHASE_ARTIFACTS = {
  explore_design: 'design.md',
  prd:            'prd.md',
  architecture:   'architecture.md',
  blueprint:      'blueprint.md',
  plan:           'plan.md',
  report:         'report.md',
};
```

### Class

```js
export class LifecycleManager {
  #store;        // VisionStore instance
  #featureRoot;  // path to docs/features/

  constructor(store, featureRoot) { ... }
```

### `startLifecycle(itemId, featureCode)`

1. Get item from `this.#store.items.get(itemId)` — throw if not found
2. Build initial artifacts map by scanning `${this.#featureRoot}/${featureCode}/` for each key in `PHASE_ARTIFACTS`
3. Create lifecycle object with an open history entry for the first phase:
   ```js
   const now = new Date().toISOString();
   {
     currentPhase: 'explore_design',
     featureCode,
     phaseHistory: [
       { phase: 'explore_design', enteredAt: now, exitedAt: null, outcome: null },
     ],
     artifacts: { /* scanned */ },
     startedAt: now,
     completedAt: null,
     killedAt: null,
     killReason: null,
     reconcileWarning: null,
   }
   ```

   The seeded entry ensures `advancePhase`/`skipPhase`/`killFeature` always have
   an open entry to close on first transition.
4. Call `this.#store.updateLifecycle(itemId, lifecycle)` (new store method)
5. Return lifecycle

### `advancePhase(itemId, targetPhase, outcome)`

1. Get item, get `lifecycle` from item — throw if no lifecycle
2. Validate: `currentPhase` not in `TERMINAL`
3. Validate: `targetPhase` is in `TRANSITIONS[currentPhase]`
4. Validate: `outcome` is `'approved'` or `'revised'`
5. If `outcome === 'revised'`, validate that `targetPhase` is a backward transition
   (i.e., `PHASES.indexOf(targetPhase) < PHASES.indexOf(currentPhase)`). The only
   defined revision edge is verification → blueprint, but the rule is general:
   `revised` means going back.
5. Close current phase history entry: set `exitedAt`, `outcome`
6. Push new history entry: `{ phase: targetPhase, enteredAt: now, exitedAt: null, outcome: null }`
7. Set `currentPhase = targetPhase`
8. Update artifacts map (scan disk for the new phase's artifact)
9. Clear `reconcileWarning` if present
10. Call `this.#store.updateLifecycle(itemId, lifecycle)`
11. Return `{ from, to: targetPhase, outcome }`

### `skipPhase(itemId, targetPhase, reason)`

1. Get item, get lifecycle — throw if no lifecycle
2. Validate: `currentPhase` not in `TERMINAL`
3. Validate: `currentPhase` is in `SKIPPABLE`
4. Validate: `targetPhase` is in `TRANSITIONS[currentPhase]`
5. Close current phase: `exitedAt`, `outcome: 'skipped'`, `reason`
6. Push new history entry for `targetPhase`
7. Set `currentPhase = targetPhase`
8. Call `this.#store.updateLifecycle(itemId, lifecycle)`
9. Return `{ from, to: targetPhase, outcome: 'skipped', reason }`

### `killFeature(itemId, reason)`

1. Get item, get lifecycle — throw if no lifecycle or already terminal
2. Close current phase: `exitedAt`, `outcome: 'killed'`
3. Set `currentPhase = 'killed'`, `killedAt = now`, `killReason = reason`
4. Call `this.#store.updateLifecycle(itemId, lifecycle)`
5. Call `this.#store.updateItem(itemId, { status: 'killed' })`
6. Return `{ phase: previousPhase, reason }`

### `completeFeature(itemId)`

1. Get item, get lifecycle — throw if no lifecycle
2. Validate: `currentPhase === 'ship'` — throw otherwise
3. Close ship phase: `exitedAt`, `outcome: 'approved'`
4. Set `currentPhase = 'complete'`, `completedAt = now`
5. Call `this.#store.updateLifecycle(itemId, lifecycle)`
6. Call `this.#store.updateItem(itemId, { status: 'complete' })`
7. Return `{ completedAt }`

### `getPhase(itemId)` / `getHistory(itemId)`

Simple lookups from the item's `lifecycle` field. Throw if no lifecycle.

### `reconcile(itemId)`

1. Get item, get lifecycle — throw if no lifecycle
2. Scan `${this.#featureRoot}/${lifecycle.featureCode}/` for all `PHASE_ARTIFACTS`
3. Update `lifecycle.artifacts` to match disk
4. Infer phase from artifacts: find the latest phase whose artifact exists
5. **If inferred > current** (forward): advance through intermediate phases recording `outcome: 'reconciled'`; set `currentPhase` to inferred phase
6. **If inferred < current** (backward): do NOT move backward; set `reconcileWarning` with details
7. **If equal**: clear `reconcileWarning` if present
8. Call `this.#store.updateLifecycle(itemId, lifecycle)`
9. Return `{ currentPhase, artifacts, reconcileWarning }`

Phase comparison uses `PHASES.indexOf()`.

---

## 2. `server/vision-store.js` (existing, edit)

### `updateItem` — strip lifecycle (line 122)

Current allowed list at `vision-store.js:122`:
```js
const allowed = ['type', 'title', 'description', 'confidence', 'status', 'phase', 'position', 'parentId', 'summary', 'files', 'speckitKey', 'stratumFlowId', 'evidence'];
```

**No change needed** — `lifecycle` is already excluded from this allowlist. The allowlist pattern already acts as a write-protection mechanism. Generic PATCH cannot set `lifecycle` because it's not in the list.

### Add `updateLifecycle` method — after `updateItem` (after line 141)

```js
/** Update the lifecycle field on an item — bypasses the generic allowlist.
 *  Only callable by LifecycleManager. */
updateLifecycle(id, lifecycle) {
  const item = this.items.get(id);
  if (!item) throw new Error(`Item not found: ${id}`);
  item.lifecycle = lifecycle;
  item.updatedAt = new Date().toISOString();
  this.items.set(id, item);
  this._save();
  return item;
}
```

### Corrections

| Spec assumption | Reality | Action |
|---|---|---|
| "Need to strip lifecycle from PATCH" | The allowlist at line 122 already excludes any field not listed — `lifecycle` is never in the list | No strip logic needed; just don't add `lifecycle` to the allowlist |
| "updateLifecycle needs to bypass strip" | Correct — new method writes `lifecycle` directly on the item object | Add method after line 141 |

---

## 3. `server/compose-mcp-tools.js` (existing, edit)

Add five new tool implementations after `toolGetCurrentSession` (after line 171).

The MCP tools read from disk (same pattern as existing tools — `loadVisionState()` returns parsed JSON, no live store). But lifecycle mutations need to go through LifecycleManager which needs a live VisionStore instance.

**Problem:** `compose-mcp-tools.js` reads from disk files directly (`loadVisionState()`), not from a running VisionStore. The lifecycle mutation tools (`advance_feature_phase`, etc.) need a live store + LifecycleManager. Instantiating a fresh VisionStore per MCP call risks clobbering state — the Compose server's in-memory store and the MCP process would be independent writers to the same JSON file.

**Solution:** The read tool (`get_feature_lifecycle`) reads from disk like the others. The mutation tools delegate to the Compose server's REST endpoints (`POST /api/vision/items/:id/lifecycle/advance`, etc.) via `http.request` to `localhost:3001`. This ensures all writes go through the single live VisionStore instance and avoids multi-process write conflicts.

```js
import http from 'node:http';

const COMPOSE_API = `http://127.0.0.1:${process.env.PORT || 3001}`;

function _postLifecycle(itemId, action, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      `${COMPOSE_API}/api/vision/items/${itemId}/lifecycle/${action}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } },
      (res) => {
        let buf = '';
        res.on('data', (chunk) => buf += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); }
          catch { resolve({ error: buf }); }
        });
      },
    );
    req.on('error', (err) => reject(new Error(`Compose server unreachable: ${err.message}`)));
    req.end(data);
  });
}
```

If the Compose server is not running, mutation tools return a clear error. Read-only tools still work from disk.

### `toolGetFeatureLifecycle({ id })`

1. `loadVisionState()` → find item by id/slug
2. Return `item.lifecycle` or `{ error: 'No lifecycle on this item' }`

### `toolAdvanceFeaturePhase({ id, targetPhase, outcome })`

1. `await _postLifecycle(id, 'advance', { targetPhase, outcome })`
2. Return result (or error if server unreachable)

### `toolSkipFeaturePhase({ id, targetPhase, reason })`

1. `await _postLifecycle(id, 'skip', { targetPhase, reason })`
2. Return result

### `toolKillFeature({ id, reason })`

1. `await _postLifecycle(id, 'kill', { reason })`
2. Return result

### `toolCompleteFeature({ id })`

1. `await _postLifecycle(id, 'complete', {})`
2. Return result

---

## 4. `server/compose-mcp.js` (existing, edit)

### Import new tools (after line 35)

```js
import {
  toolGetFeatureLifecycle,
  toolAdvanceFeaturePhase,
  toolSkipFeaturePhase,
  toolKillFeature,
  toolCompleteFeature,
} from './compose-mcp-tools.js';
```

### Add tool definitions to `TOOLS` array (after line 113)

```js
{
  name: 'get_feature_lifecycle',
  description: 'Get the lifecycle state of a feature: current phase, phase history, artifacts, warnings.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Item ID (UUID) or slug' },
    },
    required: ['id'],
  },
},
{
  name: 'advance_feature_phase',
  description: 'Advance a feature to the next lifecycle phase. Validates the transition is allowed.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Item ID' },
      targetPhase: { type: 'string', description: 'Phase to advance to' },
      outcome: { type: 'string', enum: ['approved', 'revised'], description: 'Gate outcome' },
    },
    required: ['id', 'targetPhase', 'outcome'],
  },
},
{
  name: 'skip_feature_phase',
  description: 'Skip the current phase (only prd, architecture, report are skippable).',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Item ID' },
      targetPhase: { type: 'string', description: 'Phase to skip to' },
      reason: { type: 'string', description: 'Why this phase is being skipped' },
    },
    required: ['id', 'targetPhase', 'reason'],
  },
},
{
  name: 'kill_feature',
  description: 'Kill a feature from any phase. Records reason and sets status to killed.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Item ID' },
      reason: { type: 'string', description: 'Why the feature is being killed' },
    },
    required: ['id', 'reason'],
  },
},
{
  name: 'complete_feature',
  description: 'Mark a feature as complete. Only callable from the ship phase.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Item ID' },
    },
    required: ['id'],
  },
},
```

### Add cases to switch statement (after line 139)

```js
case 'get_feature_lifecycle':    result = toolGetFeatureLifecycle(args); break;
case 'advance_feature_phase':    result = await toolAdvanceFeaturePhase(args); break;
case 'skip_feature_phase':       result = await toolSkipFeaturePhase(args); break;
case 'kill_feature':             result = await toolKillFeature(args); break;
case 'complete_feature':         result = await toolCompleteFeature(args); break;
```

---

## 5. `server/vision-routes.js` (existing, edit)

Add lifecycle REST endpoints inside `attachVisionRoutes`. These are for the UI (gate approval, phase display).

Add import at the top of the file (after line 21, with the other imports):

```js
import { LifecycleManager } from './lifecycle-manager.js';
```

Add inside `attachVisionRoutes`, after the `GET /api/vision/items/:id` route (after line 105):

```js
// ── Lifecycle endpoints ────────────────────────────────────────────────
const lifecycleManager = new LifecycleManager(store, path.join(projectRoot, 'docs', 'features'));

// GET /api/vision/items/:id/lifecycle
app.get('/api/vision/items/:id/lifecycle', (req, res) => { ... });

// POST /api/vision/items/:id/lifecycle/start
app.post('/api/vision/items/:id/lifecycle/start', (req, res) => { ... });

// POST /api/vision/items/:id/lifecycle/advance
app.post('/api/vision/items/:id/lifecycle/advance', (req, res) => { ... });

// POST /api/vision/items/:id/lifecycle/skip
app.post('/api/vision/items/:id/lifecycle/skip', (req, res) => { ... });

// POST /api/vision/items/:id/lifecycle/kill
app.post('/api/vision/items/:id/lifecycle/kill', (req, res) => { ... });

// POST /api/vision/items/:id/lifecycle/complete
app.post('/api/vision/items/:id/lifecycle/complete', (req, res) => { ... });
```

Each POST route:
1. Extract params from `req.body`
2. Call the corresponding LifecycleManager method
3. Call `scheduleBroadcast()` after mutation
4. Broadcast `lifecycleTransition` event via `broadcastMessage()`
5. Return result or error

**Note:** The `LifecycleManager` here is instantiated with the live `store` passed to `attachVisionRoutes`, so it shares the same in-memory state as the running server. MCP mutation tools delegate to these REST endpoints rather than writing directly.

---

## 6. `server/vision-server.js` (existing, edit)

The `LifecycleManager` import and `attachVisionRoutes` deps are already wired — the routes receive `store` and broadcast functions. The only change is updating the route comment at the top of `vision-server.js` to document the new lifecycle endpoints, and passing `broadcastMessage` to vision routes (already passed at line 38).

Actually, checking `vision-server.js:35-40`: `attachVisionRoutes` already receives `store`, `scheduleBroadcast`, and `broadcastMessage`. The lifecycle routes in `vision-routes.js` will have access to all three. **No code change needed in vision-server.js** beyond the route comment.

Wait — the lifecycle routes need `broadcastMessage` to emit `lifecycleTransition` events. Checking `attachVisionRoutes` signature at `vision-routes.js:32`:

```js
export function attachVisionRoutes(app, { store, scheduleBroadcast, broadcastMessage, projectRoot = PROJECT_ROOT })
```

`broadcastMessage` is already in the deps. **No change needed in vision-server.js.**

---

## 7. `test/lifecycle-manager.test.js` (new)

### Test structure (table-driven where possible)

**Happy path tests:**
- `startLifecycle` creates lifecycle with correct initial state
- `advancePhase` through full happy path: explore_design → blueprint → verification → plan → execute → docs → ship
- `completeFeature` from ship → complete
- `skipPhase` for prd, architecture, report
- `advancePhase` verification → blueprint (revision loop)

**Error path tests (table-driven harness):**
- Invalid transition (e.g., explore_design → execute) → throws
- Advance from terminal state → throws
- Skip non-skippable phase → throws
- Complete from non-ship phase → throws
- Kill from terminal state → throws
- advancePhase with invalid outcome → throws
- No lifecycle on item → throws

**Reconciliation tests:**
- Forward: artifacts ahead → advances, records `reconciled`
- Backward: artifacts behind → sets `reconcileWarning`, does not regress
- Equal: clears warning if present

**Integration tests:**
- `updateItem` PATCH cannot set lifecycle (allowlist protection)
- `updateLifecycle` can set lifecycle

### Test helpers

```js
function makeStore() {
  // Create a VisionStore pointing at a temp directory
  // Pre-populate with a test feature item
}

function makeManager(store, featureDir) {
  return new LifecycleManager(store, featureDir);
}
```

---

## Corrections Table

| Spec assumption | Reality | Impact |
|---|---|---|
| "Need to add lifecycle stripping to updateItem" | Allowlist at `vision-store.js:122` already excludes unlisted fields — lifecycle is never in the list | No strip logic needed; zero-change in updateItem |
| "vision-server.js needs edit for broadcast" | `attachVisionRoutes` already receives `broadcastMessage` at `vision-server.js:38` | No change needed in vision-server.js |
| "MCP tools can mutate via live store" | `compose-mcp-tools.js` runs in a separate stdio process; fresh VisionStore would conflict with the server's in-memory store | Mutation tools delegate to Compose REST API; reads stay disk-based |
| "compose-mcp.js token budget ~519 for 5 tools" | Adding 5 more tools (~300 tokens) brings total to ~819, well under 2000 soft cap | No concern |
