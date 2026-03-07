# STRAT-COMP-2: Implementation Plan

**Design:** [design.md](./design.md)
**Approach:** Sequential — each task depends on the previous (import chains must remain valid at each step)

---

## Task 1: Inline constants into artifact-manager.js

**File:** `server/artifact-manager.js` (existing)
**What:** Replace `import { PHASE_ARTIFACTS } from './lifecycle-constants.js'` with an inline constant.

```js
// Replace line 12:
// import { PHASE_ARTIFACTS } from './lifecycle-constants.js';
// With:
const PHASE_ARTIFACTS = {
  explore_design: 'design.md',
  prd: 'prd.md',
  architecture: 'architecture.md',
  blueprint: 'blueprint.md',
  plan: 'plan.md',
  report: 'report.md',
};
```

- [ ] Remove the import
- [ ] Add inline constant with same values (from `contracts/lifecycle.json` phases with non-null artifact)
- [ ] Existing `ARTIFACT_SCHEMAS` startup check passes (keys match `PHASE_ARTIFACTS` values)
- [ ] Run `node --check server/artifact-manager.js`

**Test:** Existing artifact-manager tests pass unchanged.

---

## Task 2: Inline contract seed into vision-server.js

**File:** `server/vision-server.js` (existing)
**What:** Replace `import { CONTRACT } from './lifecycle-constants.js'` with an inline config object that provides what `SettingsStore` needs.

`SettingsStore` uses `contract.phases` (for `p.id` and `p.defaultPolicy`) and `contract.iterationDefaults`. Inline these:

```js
// Replace line 20:
// import { CONTRACT } from './lifecycle-constants.js';
// With:
const SETTINGS_DEFAULTS = {
  phases: [
    { id: 'explore_design', defaultPolicy: null },
    { id: 'prd', defaultPolicy: 'skip' },
    { id: 'architecture', defaultPolicy: 'skip' },
    { id: 'blueprint', defaultPolicy: 'gate' },
    { id: 'verification', defaultPolicy: 'gate' },
    { id: 'plan', defaultPolicy: 'gate' },
    { id: 'execute', defaultPolicy: 'flag' },
    { id: 'report', defaultPolicy: 'skip' },
    { id: 'docs', defaultPolicy: 'flag' },
    { id: 'ship', defaultPolicy: 'gate' },
  ],
  iterationDefaults: {
    review: { maxIterations: 10 },
    coverage: { maxIterations: 15 },
  },
  policyModes: ['gate', 'flag', 'skip'],
};
```

- [ ] Replace `CONTRACT` import with `SETTINGS_DEFAULTS`
- [ ] Change `new SettingsStore(undefined, CONTRACT)` → `new SettingsStore(undefined, SETTINGS_DEFAULTS)` at line 40
- [ ] Run `node --check server/vision-server.js`

**Test:** Settings store tests pass. Settings panel still renders policy dials.

---

## Task 3: Replace lifecycle routes in vision-routes.js

**File:** `server/vision-routes.js` (existing)
**What:** Remove the `LifecycleManager` import and all lifecycle route handlers. Replace with simplified handlers that write directly to the vision store.

- [ ] Remove `import { LifecycleManager } from './lifecycle-manager.js'`
- [ ] Remove `const lifecycleManager = new LifecycleManager(store, featuresPath, settingsStore)` (line 125)
- [ ] Keep `featuresPath` resolution (needed by artifact-manager)
- [ ] Keep artifact and gate list/get endpoints unchanged

**Replacement route handlers:**

### `GET .../lifecycle` — no change (already reads from store)

### `POST .../lifecycle/start`
Direct store write:
```js
app.post('/api/vision/items/:id/lifecycle/start', (req, res) => {
  const { featureCode } = req.body;
  if (!featureCode) return res.status(400).json({ error: 'featureCode is required' });
  const item = store.items.get(req.params.id);
  if (!item) return res.status(404).json({ error: `Item not found: ${req.params.id}` });
  if (item.lifecycle) return res.status(400).json({ error: `Item already has a lifecycle` });

  const lifecycle = {
    currentPhase: 'explore_design',
    featureCode,
    startedAt: new Date().toISOString(),
    completedAt: null,
    killedAt: null,
    killReason: null,
  };
  store.updateLifecycle(req.params.id, lifecycle);
  scheduleBroadcast();
  broadcastMessage({ type: 'lifecycleStarted', itemId: req.params.id, phase: 'explore_design', featureCode, timestamp: new Date().toISOString() });
  res.json(lifecycle);
});
```

### `POST .../lifecycle/advance`
Validate transition against a local transition map (inlined from contract), write phase:
```js
const TRANSITIONS = {
  explore_design: ['prd', 'architecture', 'blueprint'],
  prd: ['architecture', 'blueprint'],
  architecture: ['blueprint'],
  blueprint: ['verification'],
  verification: ['plan', 'blueprint'],
  plan: ['execute'],
  execute: ['report', 'docs'],
  report: ['docs'],
  docs: ['ship'],
  ship: [],
};

app.post('/api/vision/items/:id/lifecycle/advance', (req, res) => {
  const { targetPhase, outcome } = req.body;
  const item = store.items.get(req.params.id);
  if (!item?.lifecycle) return res.status(404).json({ error: 'No lifecycle' });
  const from = item.lifecycle.currentPhase;
  const valid = TRANSITIONS[from];
  if (!valid?.includes(targetPhase)) return res.status(400).json({ error: `Invalid transition: ${from} → ${targetPhase}` });

  item.lifecycle.currentPhase = targetPhase;
  store.updateLifecycle(req.params.id, item.lifecycle);
  scheduleBroadcast();
  broadcastMessage({ type: 'lifecycleTransition', itemId: req.params.id, from, to: targetPhase, outcome, timestamp: new Date().toISOString() });
  res.json({ from, to: targetPhase, outcome });
});
```

### `POST .../lifecycle/skip`
Same pattern with skippable phase validation:
```js
const SKIPPABLE = new Set(['prd', 'architecture', 'report']);
```

### `POST .../lifecycle/kill`
Write killed status:
```js
app.post('/api/vision/items/:id/lifecycle/kill', (req, res) => {
  const { reason } = req.body;
  const item = store.items.get(req.params.id);
  if (!item?.lifecycle) return res.status(404).json({ error: 'No lifecycle' });
  const from = item.lifecycle.currentPhase;
  if (from === 'complete' || from === 'killed') return res.status(400).json({ error: `Cannot kill from: ${from}` });
  item.lifecycle.currentPhase = 'killed';
  item.lifecycle.killedAt = new Date().toISOString();
  item.lifecycle.killReason = reason;
  store.updateLifecycle(req.params.id, item.lifecycle);
  store.updateItem(req.params.id, { status: 'killed' });
  scheduleBroadcast();
  broadcastMessage({ type: 'lifecycleTransition', itemId: req.params.id, from, to: 'killed', outcome: 'killed', timestamp: new Date().toISOString() });
  res.json({ phase: from, reason });
});
```

### `POST .../lifecycle/complete`
Same pattern, require `ship` phase.

### `POST .../gates/:id/resolve`
Resolve gate in store, advance phase directly:
```js
app.post('/api/vision/gates/:id/resolve', (req, res) => {
  const { outcome, comment } = req.body;
  if (!outcome) return res.status(400).json({ error: 'outcome is required' });
  const gate = store.gates.get(req.params.id);
  if (!gate) return res.status(404).json({ error: `Gate not found` });
  if (gate.status !== 'pending') return res.status(400).json({ error: `Gate not pending` });

  store.resolveGate(req.params.id, { outcome, comment });

  if (outcome === 'approved') {
    const item = store.items.get(gate.itemId);
    if (item?.lifecycle) {
      item.lifecycle.currentPhase = gate.toPhase;
      store.updateLifecycle(gate.itemId, item.lifecycle);
    }
  } else if (outcome === 'killed') {
    const item = store.items.get(gate.itemId);
    if (item?.lifecycle) {
      item.lifecycle.currentPhase = 'killed';
      item.lifecycle.killedAt = new Date().toISOString();
      item.lifecycle.killReason = comment || 'Killed at gate';
      store.updateLifecycle(gate.itemId, item.lifecycle);
      store.updateItem(gate.itemId, { status: 'killed' });
    }
  }

  scheduleBroadcast();
  broadcastMessage({ type: 'gateResolved', gateId: req.params.id, itemId: gate.itemId, outcome, timestamp: new Date().toISOString() });
  res.json({ gateId: req.params.id, gateOutcome: outcome });
});
```

### Delete iteration endpoints
- [ ] Remove `POST .../lifecycle/iteration/start` handler
- [ ] Remove `POST .../lifecycle/iteration/report` handler
- [ ] Remove `GET .../lifecycle/iteration` handler

**Test:** Write new `test/lifecycle-routes.test.js` covering:
- [ ] POST start creates lifecycle blob
- [ ] POST advance validates transitions
- [ ] POST advance rejects invalid transitions
- [ ] POST skip validates skippable phases
- [ ] POST kill from any phase
- [ ] POST kill rejects from terminal states
- [ ] POST complete requires ship phase
- [ ] POST gates/:id/resolve advances on approved
- [ ] POST gates/:id/resolve kills on killed outcome

---

## Task 4: Delete MCP tools for iteration/advance/skip

**Files:** `server/compose-mcp-tools.js` (existing), `server/compose-mcp.js` (existing)

### compose-mcp-tools.js
- [ ] Delete `toolAdvanceFeaturePhase` function (line 290-292)
- [ ] Delete `toolSkipFeaturePhase` function (line 294-296)
- [ ] Delete `toolStartIterationLoop` function (line 341-345)
- [ ] Delete `toolReportIterationResult` function (line 347-350)
- [ ] Delete `toolGetIterationStatus` function (line 352-358)
- [ ] Keep `toolKillFeature`, `toolCompleteFeature` (still proxy to REST)
- [ ] Keep `toolApproveGate`, `toolGetPendingGates` (still useful)
- [ ] Keep `toolGetFeatureLifecycle` (reads from disk)

### compose-mcp.js
- [ ] Remove imports: `toolAdvanceFeaturePhase`, `toolSkipFeaturePhase`, `toolStartIterationLoop`, `toolReportIterationResult`, `toolGetIterationStatus`
- [ ] Remove tool definitions from `TOOLS` array: `advance_feature_phase`, `skip_feature_phase`, `start_iteration_loop`, `report_iteration_result`, `get_iteration_status`
- [ ] Remove case branches from the switch statement (lines 318-319, 326-328)

**Test:** Run MCP tool tests (if any). Verify `compose-mcp.js` starts without error: `node --check server/compose-mcp.js`.

---

## Task 5: Delete bespoke lifecycle files

**Delete files:**
- [ ] `server/lifecycle-manager.js` (539 lines)
- [ ] `server/policy-engine.js` (33 lines)
- [ ] `server/lifecycle-constants.js` (41 lines)
- [ ] `contracts/lifecycle.json` (107 lines)

**Delete test files:**
- [ ] `test/lifecycle-manager.test.js` (675 lines)
- [ ] `test/policy-engine.test.js` (83 lines)
- [ ] `test/lifecycle-contract.test.js` (244 lines)
- [ ] `test/iteration-manager.test.js` (323 lines)
- [ ] `test/gate-logic.test.js` (182 lines)
- [ ] `test/iteration-routes.test.js` (250 lines)

**Verify:** `node --check server/vision-routes.js && node --check server/vision-server.js && node --check server/artifact-manager.js` — no broken imports.

---

## Task 6: Run full test suite and fix breakage

- [ ] Run `node --test test/*.test.js`
- [ ] Fix any test that imports from deleted modules
- [ ] Fix any test that depends on the old lifecycle blob shape (phaseHistory, policyLog, etc.)
- [ ] Verify all tests pass — expected count will drop by ~100 (deleted test files had ~100 tests)
- [ ] Verify `compose build` still works: `node --test test/build.test.js test/build-integration.test.js`

---

## Summary

| Task | Files | Action | Lines Removed | Lines Added |
|---|---|---|---|---|
| T1 | artifact-manager.js | Inline constant | ~1 | ~8 |
| T2 | vision-server.js | Inline settings seed | ~1 | ~20 |
| T3 | vision-routes.js | Replace lifecycle handlers | ~290 | ~120 |
| T4 | compose-mcp-tools.js, compose-mcp.js | Delete tools | ~80 | 0 |
| T5 | 10 files | Delete | ~2,477 | 0 |
| T6 | test/*.test.js | Fix breakage | TBD | TBD |
| | | **Net** | **~2,850** | **~150** |

**Execution order:** T1 → T2 → T3 → T4 → T5 → T6 (sequential — each task removes an import that the next deletion depends on)
