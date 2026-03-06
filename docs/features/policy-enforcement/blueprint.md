# Policy Enforcement Runtime: Implementation Blueprint

**Status:** BLUEPRINT
**Date:** 2026-03-06
**Design:** [design.md](design.md)

---

## 1. `server/policy-engine.js` (new)

Policy evaluation module. Stateless — takes a target phase and optional overrides, returns the policy mode.

### 1.1 DEFAULT_POLICIES

```js
// server/policy-engine.js:1-20
// explore_design is omitted — it's the entry phase, never a transition target.
// Policy applies to the phase being *entered*, not the phase being *left*.
export const DEFAULT_POLICIES = {
  prd:            'skip',
  architecture:   'skip',
  blueprint:      'gate',
  verification:   'gate',
  plan:           'gate',
  execute:        'flag',
  report:         'skip',
  docs:           'flag',
  ship:           'gate',
};
```

### 1.2 evaluatePolicy(targetPhase, overrides)

```js
// server/policy-engine.js:22-40
export function evaluatePolicy(targetPhase, overrides) {
  const ov = overrides || {};
  const mode = ov[targetPhase] ?? DEFAULT_POLICIES[targetPhase] ?? 'skip';
  if (!['gate', 'flag', 'skip'].includes(mode)) {
    throw new Error(`Invalid policy mode: ${mode}`);
  }
  return mode;
}
```

Arguments:
- `targetPhase` — the phase being entered (e.g. `'blueprint'`)
- `overrides` — optional map of `{ phase: mode }` that overrides defaults for specific phases. May be `null` or `undefined` — coerced to `{}` internally.

Returns: `'gate'` | `'flag'` | `'skip'`

### 1.3 VALID_GATE_OUTCOMES

```js
export const VALID_GATE_OUTCOMES = ['approved', 'revised', 'killed'];
```

---

## 2. `server/vision-store.js` (edit)

### 2.1 Add gates Map — constructor at line 26

After `this.connections = new Map();` (line 27), add:

```js
this.gates = new Map();
```

### 2.2 Load gates in `_load()` — after line 44

After the connections loading block (lines 43-45), add:

```js
if (Array.isArray(data.gates)) {
  for (const gate of data.gates) this.gates.set(gate.id, gate);
}
```

### 2.3 Include gates in `getState()` — line 69

Change the return value at lines 69-73 from:

```js
return {
  items: Array.from(this.items.values()),
  connections: Array.from(this.connections.values()),
};
```

To:

```js
return {
  items: Array.from(this.items.values()),
  connections: Array.from(this.connections.values()),
  gates: Array.from(this.gates.values()),
};
```

### 2.4 Gate CRUD methods — after `deleteConnection()` (after line 197)

```js
createGate(gate) {
  this.gates.set(gate.id, gate);
  this._save();
  return gate;
}

resolveGate(gateId, { outcome, comment }) {
  const gate = this.gates.get(gateId);
  if (!gate) throw new Error(`Gate not found: ${gateId}`);
  if (gate.status !== 'pending') throw new Error(`Gate ${gateId} is not pending (status: ${gate.status})`);
  gate.status = outcome;
  gate.outcome = outcome;
  gate.resolvedAt = new Date().toISOString();
  gate.resolvedBy = 'human';
  gate.comment = comment || null;
  this.gates.set(gateId, gate);
  this._save();
  return gate;
}

getPendingGates(itemId) {
  const pending = [];
  for (const gate of this.gates.values()) {
    if (gate.status !== 'pending') continue;
    if (itemId && gate.itemId !== itemId) continue;
    pending.push(gate);
  }
  return pending;
}

getGatesForItem(itemId) {
  const result = [];
  for (const gate of this.gates.values()) {
    if (gate.itemId === itemId) result.push(gate);
  }
  return result;
}
```

### 2.5 loadVisionState fallback — `server/compose-mcp-tools.js:27`

The `loadVisionState()` fallback (line 27) already returns `{ items: [], connections: [] }`. Update to also include `gates: []`:

```js
return { items: [], connections: [], gates: [] };
```

---

## 3. `server/lifecycle-manager.js` (edit)

### 3.1 New imports — after line 9

```js
import { v4 as uuidv4 } from 'uuid';
import { evaluatePolicy, VALID_GATE_OUTCOMES } from './policy-engine.js';
import { ArtifactManager, ARTIFACT_SCHEMAS } from './artifact-manager.js';
```

### 3.2 Constructor — add artifactManager at line 53

Extend constructor to create an ArtifactManager for gate artifact snapshots:

```js
constructor(store, featureRoot) {
  this.#store = store;
  this.#featureRoot = featureRoot;
  this.#artifactManager = new ArtifactManager(featureRoot);
}
```

Add `#artifactManager;` to the private field declarations after line 51.

### 3.3 Extract `_executeAdvance` — refactor from `advancePhase()` lines 84-122

Extract the transition logic (validation + state mutation) from `advancePhase()` into a private method `#executeAdvance(itemId, targetPhase, outcome)` that performs the transition without policy evaluation. This is the "bypass" path used by both policy-skip transitions and gate approval replays.

```js
#executeAdvance(itemId, targetPhase, outcome) {
  // Lines 85-121 of current advancePhase, unchanged
  const { item, lifecycle } = this.#getLifecycle(itemId);
  const from = lifecycle.currentPhase;

  if (TERMINAL.has(from)) {
    throw new Error(`Cannot advance from terminal state: ${from}`);
  }
  const valid = TRANSITIONS[from];
  if (!valid || !valid.includes(targetPhase)) {
    throw new Error(`Invalid transition: ${from} → ${targetPhase}`);
  }
  if (outcome !== 'approved' && outcome !== 'revised') {
    throw new Error(`Invalid outcome: ${outcome} (must be approved or revised)`);
  }
  if (outcome === 'revised') {
    const fromIdx = PHASES.indexOf(from);
    const toIdx = PHASES.indexOf(targetPhase);
    if (toIdx >= fromIdx) {
      throw new Error(`'revised' outcome requires backward transition, but ${from} → ${targetPhase} is forward`);
    }
  }

  const now = new Date().toISOString();
  this.#closeCurrentEntry(lifecycle, outcome, now);
  lifecycle.phaseHistory.push({ phase: targetPhase, enteredAt: now, exitedAt: null, outcome: null });
  lifecycle.currentPhase = targetPhase;

  const artifactName = PHASE_ARTIFACTS[targetPhase];
  if (artifactName) {
    lifecycle.artifacts[artifactName] = fs.existsSync(
      path.join(this.#featureRoot, lifecycle.featureCode, artifactName),
    );
  }

  lifecycle.reconcileWarning = null;
  this.#store.updateLifecycle(itemId, lifecycle);
  return { from, to: targetPhase, outcome };
}
```

### 3.4 Extract `#executeSkip` — refactor from `skipPhase()` lines 124-145

Same pattern — extract the transition logic without policy:

```js
#executeSkip(itemId, targetPhase, reason) {
  // Lines 125-144 of current skipPhase, unchanged
  const { item, lifecycle } = this.#getLifecycle(itemId);
  const from = lifecycle.currentPhase;

  if (TERMINAL.has(from)) {
    throw new Error(`Cannot skip from terminal state: ${from}`);
  }
  if (!SKIPPABLE.has(from)) {
    throw new Error(`Phase ${from} is not skippable`);
  }
  const valid = TRANSITIONS[from];
  if (!valid || !valid.includes(targetPhase)) {
    throw new Error(`Invalid transition: ${from} → ${targetPhase}`);
  }

  const now = new Date().toISOString();
  this.#closeCurrentEntry(lifecycle, 'skipped', now, reason);
  lifecycle.phaseHistory.push({ phase: targetPhase, enteredAt: now, exitedAt: null, outcome: null });
  lifecycle.currentPhase = targetPhase;
  this.#store.updateLifecycle(itemId, lifecycle);
  return { from, to: targetPhase, outcome: 'skipped', reason };
}
```

### 3.5 Rewrite `advancePhase()` — policy-aware wrapper

```js
advancePhase(itemId, targetPhase, outcome) {
  const { item, lifecycle } = this.#getLifecycle(itemId);
  const from = lifecycle.currentPhase;

  // Block ALL transitions while a gate is pending — not just gated ones
  if (lifecycle.pendingGate) {
    throw new Error(`Cannot advance: gate ${lifecycle.pendingGate} is pending for item ${itemId}`);
  }

  const policy = evaluatePolicy(targetPhase, lifecycle.policyOverrides);

  if (policy === 'gate') {
    return this.#createGate(itemId, 'advance', { targetPhase, outcome }, from, targetPhase);
  }

  const result = this.#executeAdvance(itemId, targetPhase, outcome);

  if (policy === 'flag') {
    const flagId = this.#recordPolicyEntry(itemId, 'flag', from, targetPhase);
    return { ...result, flagged: true, flagId };
  }

  // policy === 'skip'
  this.#recordPolicyEntry(itemId, 'skip', from, targetPhase);
  return result;
}
```

### 3.6 Rewrite `skipPhase()` — policy-aware wrapper

```js
skipPhase(itemId, targetPhase, reason) {
  const { item, lifecycle } = this.#getLifecycle(itemId);
  const from = lifecycle.currentPhase;

  // Block ALL transitions while a gate is pending
  if (lifecycle.pendingGate) {
    throw new Error(`Cannot skip: gate ${lifecycle.pendingGate} is pending for item ${itemId}`);
  }

  const policy = evaluatePolicy(targetPhase, lifecycle.policyOverrides);

  if (policy === 'gate') {
    return this.#createGate(itemId, 'skip', { targetPhase, reason }, from, targetPhase);
  }

  const result = this.#executeSkip(itemId, targetPhase, reason);

  if (policy === 'flag') {
    const flagId = this.#recordPolicyEntry(itemId, 'flag', from, targetPhase);
    return { ...result, flagged: true, flagId };
  }

  this.#recordPolicyEntry(itemId, 'skip', from, targetPhase);
  return result;
}
```

### 3.7 `#createGate` private method

```js
#createGate(itemId, operation, operationArgs, fromPhase, toPhase) {
  const { lifecycle } = this.#getLifecycle(itemId);

  // Reject if a gate is already pending — prevents orphaned gates
  if (lifecycle.pendingGate) {
    throw new Error(`Gate already pending for item ${itemId}: ${lifecycle.pendingGate}`);
  }

  const gateId = `gate-${uuidv4()}`;

  // Snapshot artifact assessment for the from-phase (the artifact that should be complete)
  let artifactAssessment = null;
  const artifactName = PHASE_ARTIFACTS[fromPhase];
  if (artifactName && ARTIFACT_SCHEMAS[artifactName]) {
    try {
      artifactAssessment = this.#artifactManager.assessOne(lifecycle.featureCode, artifactName);
    } catch {
      // Feature folder may not exist yet — assessment is best-effort
      artifactAssessment = null;
    }
  }

  const gate = {
    id: gateId,
    itemId,
    operation,
    operationArgs,
    fromPhase,
    toPhase,
    status: 'pending',
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    resolvedBy: null,
    outcome: null,
    comment: null,
    artifactAssessment,
  };

  this.#store.createGate(gate);

  // Set pendingGate on lifecycle
  lifecycle.pendingGate = gateId;
  this.#store.updateLifecycle(itemId, lifecycle);

  // Record in policy log
  this.#recordPolicyEntry(itemId, 'gate', fromPhase, toPhase, gateId);

  return { status: 'pending_approval', gateId, fromPhase, toPhase, operation };
}
```

### 3.8 `approveGate(gateId, { outcome, comment })`

New public method:

```js
approveGate(gateId, { outcome, comment }) {
  const gate = this.#store.gates.get(gateId);
  if (!gate) throw new Error(`Gate not found: ${gateId}`);
  if (gate.status !== 'pending') throw new Error(`Gate ${gateId} is not pending (status: ${gate.status})`);
  if (!VALID_GATE_OUTCOMES.includes(outcome)) {
    throw new Error(`Invalid gate outcome: ${outcome} (must be ${VALID_GATE_OUTCOMES.join(', ')})`);
  }

  // Verify this gate is the active blocker for the lifecycle
  const { lifecycle } = this.#getLifecycle(gate.itemId);
  if (lifecycle.pendingGate !== gateId) {
    throw new Error(`Gate ${gateId} is not the active gate for item ${gate.itemId} (active: ${lifecycle.pendingGate})`);
  }

  if (outcome === 'approved') {
    // Replay original operation with policy bypass
    let result;
    if (gate.operation === 'advance') {
      result = this.#executeAdvance(gate.itemId, gate.operationArgs.targetPhase, gate.operationArgs.outcome);
    } else if (gate.operation === 'skip') {
      result = this.#executeSkip(gate.itemId, gate.operationArgs.targetPhase, gate.operationArgs.reason);
    } else {
      throw new Error(`Unknown gate operation: ${gate.operation}`);
    }

    // Resolve gate and clear pendingGate
    this.#store.resolveGate(gateId, { outcome, comment });
    this.#resolveGatePolicyEntry(gate.itemId, gateId, outcome, comment);

    return { ...result, gateId, gateOutcome: outcome };
  }

  if (outcome === 'revised') {
    this.#store.resolveGate(gateId, { outcome, comment });
    this.#resolveGatePolicyEntry(gate.itemId, gateId, outcome, comment);
    return { gateId, gateOutcome: outcome, comment };
  }

  if (outcome === 'killed') {
    this.#store.resolveGate(gateId, { outcome, comment });
    this.#resolveGatePolicyEntry(gate.itemId, gateId, outcome, comment);
    const killResult = this.killFeature(gate.itemId, comment || 'Killed at gate');
    return { ...killResult, gateId, gateOutcome: outcome };
  }
}
```

### 3.9 `#recordPolicyEntry` private method

Appends to the lifecycle's `policyLog` array:

```js
#recordPolicyEntry(itemId, type, fromPhase, toPhase, gateId) {
  const { lifecycle } = this.#getLifecycle(itemId);
  if (!lifecycle.policyLog) lifecycle.policyLog = [];
  const entry = {
    type,
    id: gateId || uuidv4(),
    itemId,
    fromPhase,
    toPhase,
    createdAt: new Date().toISOString(),
  };
  lifecycle.policyLog.push(entry);
  this.#store.updateLifecycle(itemId, lifecycle);
  return entry.id;
}
```

### 3.10 `#resolveGatePolicyEntry` private method

Updates the gate's policyLog entry with resolution data and clears `pendingGate`:

```js
#resolveGatePolicyEntry(itemId, gateId, outcome, comment) {
  const { lifecycle } = this.#getLifecycle(itemId);
  if (lifecycle.policyLog) {
    const entry = lifecycle.policyLog.find(e => e.id === gateId && e.type === 'gate');
    if (entry) {
      entry.resolvedAt = new Date().toISOString();
      entry.outcome = outcome;
      entry.comment = comment || null;
    }
  }
  lifecycle.pendingGate = null;
  this.#store.updateLifecycle(itemId, lifecycle);
}
```

### 3.11 `startLifecycle` — initialize policyLog and pendingGate

At `startLifecycle()` line 66, add to the lifecycle object:

```js
policyLog: [],
pendingGate: null,
policyOverrides: null,
```

---

## 4. `server/vision-routes.js` (edit)

### 4.1 Update route comment header — lines 1-24

Add after line 23:

```
 *   GET    /api/vision/gates
 *   GET    /api/vision/gates/:id
 *   POST   /api/vision/gates/:id/resolve
```

### 4.2 Gate endpoints — after artifact endpoints (after line 262)

```js
// ── Gate endpoints ─────────────────────────────────────────────────
app.get('/api/vision/gates', (_req, res) => {
  try {
    const itemId = _req.query.itemId || undefined;
    const gates = store.getPendingGates(itemId);
    res.json({ gates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/vision/gates/:id', (req, res) => {
  try {
    const gate = store.gates.get(req.params.id);
    if (!gate) return res.status(404).json({ error: `Gate not found: ${req.params.id}` });
    res.json(gate);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vision/gates/:id/resolve', (req, res) => {
  try {
    const { outcome, comment } = req.body;
    if (!outcome) return res.status(400).json({ error: 'outcome is required' });
    const result = lifecycleManager.approveGate(req.params.id, { outcome, comment });
    scheduleBroadcast();
    broadcastMessage({
      type: 'gateResolved',
      gateId: req.params.id,
      outcome,
      timestamp: new Date().toISOString(),
    });
    res.json(result);
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});
```

### 4.3 Modify advance endpoint — line 152

Change the advance handler (lines 152-170) to return HTTP 202 when gated:

```js
app.post('/api/vision/items/:id/lifecycle/advance', (req, res) => {
  try {
    const { targetPhase, outcome } = req.body;
    const result = lifecycleManager.advancePhase(req.params.id, targetPhase, outcome);

    if (result.status === 'pending_approval') {
      broadcastMessage({
        type: 'gatePending',
        gateId: result.gateId,
        itemId: req.params.id,
        fromPhase: result.fromPhase,
        toPhase: result.toPhase,
        timestamp: new Date().toISOString(),
      });
      return res.status(202).json(result);
    }

    scheduleBroadcast();
    broadcastMessage({
      type: 'lifecycleTransition',
      itemId: req.params.id,
      from: result.from,
      to: result.to,
      outcome: result.outcome,
      timestamp: new Date().toISOString(),
    });
    res.json(result);
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});
```

### 4.4 Modify skip endpoint — line 172

Same pattern as advance — return 202 if gated:

```js
app.post('/api/vision/items/:id/lifecycle/skip', (req, res) => {
  try {
    const { targetPhase, reason } = req.body;
    const result = lifecycleManager.skipPhase(req.params.id, targetPhase, reason);

    if (result.status === 'pending_approval') {
      broadcastMessage({
        type: 'gatePending',
        gateId: result.gateId,
        itemId: req.params.id,
        fromPhase: result.fromPhase,
        toPhase: result.toPhase,
        timestamp: new Date().toISOString(),
      });
      return res.status(202).json(result);
    }

    scheduleBroadcast();
    broadcastMessage({
      type: 'lifecycleTransition',
      itemId: req.params.id,
      from: result.from,
      to: result.to,
      outcome: result.outcome,
      timestamp: new Date().toISOString(),
    });
    res.json(result);
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});
```

---

## 5. `server/compose-mcp-tools.js` (edit)

### 5.1 New gate tools — after `toolScaffoldFeature` (after line 248)

```js
// ---------------------------------------------------------------------------
// Gate tools — mutations delegate to Compose REST API
// ---------------------------------------------------------------------------

export async function toolApproveGate({ gateId, outcome, comment }) {
  return _postGate(gateId, 'resolve', { outcome, comment });
}

export function toolGetPendingGates({ itemId }) {
  const { gates } = loadVisionState();
  if (!gates) return { count: 0, gates: [] };
  const pending = gates.filter(g => g.status === 'pending' && (!itemId || g.itemId === itemId));
  return { count: pending.length, gates: pending };
}
```

### 5.2 `_postGate` helper — after `_postLifecycle` (after line 208)

```js
function _postGate(gateId, action, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(`${_getComposeApi()}/api/vision/gates/${gateId}/${action}`);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', (chunk) => buf += chunk);
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(buf); }
          catch { parsed = { error: buf }; }
          if (res.statusCode >= 400) {
            reject(new Error(parsed.error || `HTTP ${res.statusCode}: ${buf}`));
          } else {
            resolve(parsed);
          }
        });
      },
    );
    req.on('error', (err) => reject(new Error(`Compose server unreachable: ${err.message}`)));
    req.end(data);
  });
}
```

---

## 6. `server/compose-mcp.js` (edit)

### 6.1 Add imports — line 41

After `toolScaffoldFeature,` (line 41), add:

```js
  toolApproveGate,
  toolGetPendingGates,
```

### 6.2 Add tool definitions — after `scaffold_feature` definition (after line 207)

```js
{
  name: 'approve_gate',
  description: 'Resolve a pending policy gate. Outcomes: approved (proceed), revised (stay in phase), killed (abandon feature).',
  inputSchema: {
    type: 'object',
    properties: {
      gateId: { type: 'string', description: 'Gate ID' },
      outcome: { type: 'string', enum: ['approved', 'revised', 'killed'], description: 'Resolution outcome' },
      comment: { type: 'string', description: 'Optional human feedback' },
    },
    required: ['gateId', 'outcome'],
  },
},
{
  name: 'get_pending_gates',
  description: 'List pending policy gates. Optionally filter by item ID.',
  inputSchema: {
    type: 'object',
    properties: {
      itemId: { type: 'string', description: 'Filter to gates for a specific item (optional)' },
    },
  },
},
```

### 6.3 Add switch cases — after `scaffold_feature` case (after line 240)

```js
case 'approve_gate':          result = await toolApproveGate(args); break;
case 'get_pending_gates':     result = toolGetPendingGates(args); break;
```

---

## 7. Tests

### 7.1 `test/policy-engine.test.js` (new)

Unit tests for the policy engine module:

- `evaluatePolicy` returns correct default for each phase
- `evaluatePolicy` with override map overrides default
- `evaluatePolicy` returns `'skip'` for unknown phases (e.g. phases not in DEFAULT_POLICIES)
- `evaluatePolicy` throws on invalid mode in overrides
- `DEFAULT_POLICIES` has no `explore_design` key
- All values in DEFAULT_POLICIES are valid modes

### 7.2 `test/lifecycle-manager.test.js` (edit) — add gate lifecycle tests

Add a new `describe('policy enforcement')` block after the existing `describe('store integration')` block (after line 419). Tests:

- **Gate creation on advance:** advance to a gated phase (e.g. `blueprint`) returns `{ status: 'pending_approval', gateId }` and lifecycle stays in `explore_design`
- **Gate creation on skip into gated phase:** skip from `prd` to gated `blueprint` returns `{ status: 'pending_approval', gateId }`
- **Gate approval replays advance:** create gate, then `approveGate(gateId, { outcome: 'approved' })` advances the phase
- **Gate approval replays skip:** create gate for skip operation, approve, verify skip happened
- **Gate revised:** approve with `'revised'`, verify phase doesn't change, pendingGate cleared
- **Gate killed:** approve with `'killed'`, verify `killFeature` called, item status is `killed`
- **Flag mode:** advance to a flagged phase (e.g. `execute`) returns `{ flagged: true, flagId }` and transition completes
- **Skip mode:** advance to a skip-policy phase (e.g. `report` from `execute`) completes silently
- **policyLog populated:** after various transitions, `lifecycle.policyLog` contains entries
- **pendingGate blocks all transitions:** while a gate is pending, `advancePhase` to any target (gated or not) throws "gate ... is pending"
- **pendingGate blocks skip transitions:** while a gate is pending, `skipPhase` also throws
- **approveGate rejects stale gate:** approving a gate whose `id` doesn't match `lifecycle.pendingGate` throws
- **Double resolve rejected:** resolving an already-resolved gate throws
- **policyLog gate entry updated on resolution:** after approveGate, the matching policyLog entry has `resolvedAt`, `outcome`, `comment`

### 7.3 `test/lifecycle-routes.test.js` (edit) — add gate endpoint tests

Add a new `describe('gate REST endpoints')` block after the existing `describe('MCP tool schemas')` block (after line 307). Tests:

- **Advance returns 202 for gated phase:** POST advance to `blueprint` returns 202 with `{ status: 'pending_approval', gateId }`
- **GET /api/vision/gates returns pending gates:** after creating a gate, GET returns it
- **GET /api/vision/gates/:id returns single gate:** fetch the gate by ID
- **POST /api/vision/gates/:id/resolve approves and advances:** resolve with `approved`, verify phase advanced
- **POST /api/vision/gates/:id/resolve with revised:** verify phase stays
- **POST /api/vision/gates/:id/resolve with killed:** verify item killed
- **gatePending broadcast emitted:** verify broadcast shape on gated advance
- **gateResolved broadcast emitted:** verify broadcast shape on resolve

---

## 8. Corrections Table

| Blueprint Claim | Actual Code | Status |
|---|---|---|
| `this.connections = new Map()` at line 27 | Line 27 in vision-store.js | Verified |
| `_load()` connections block at lines 43-45 | Lines 43-44 | Verified |
| `getState()` at lines 69-73 | Lines 68-73 | Verified |
| `deleteConnection()` ends at line 197 | Line 197 | Verified |
| `advancePhase()` at line 84 | Line 84 | Verified |
| `skipPhase()` at line 124 | Line 124 | Verified |
| Constructor at line 53 | Line 53 | Verified |
| `#closeCurrentEntry` at line 287 | Line 287 | Verified |
| `startLifecycle` lifecycle object at line 66 | Line 66 | Verified |
| Private field declarations at lines 50-51 | Lines 50-51 | Verified |
| `_postLifecycle` ends at line 208 | Line 208 | Verified |
| `toolScaffoldFeature` ends at line 248 | Line 248 (end of last export) | Verified |
| `loadVisionState` fallback at line 27 | Line 28 — currently `{ items: [], connections: [] }`, will be updated to `{ items: [], connections: [], gates: [] }` per section 2.5 | Verified (pre-edit) |
| compose-mcp.js imports at lines 29-42 | Lines 29-42 | Verified |
| compose-mcp.js TOOLS array ends at line 208 | Line 208 | Verified |
| compose-mcp.js switch cases end at line 240 | Line 240 | Verified |
| vision-routes.js advance handler at line 152 | Line 152 | Verified |
| vision-routes.js skip handler at line 172 | Line 172 | Verified |
| vision-routes.js artifact endpoints end at line 262 | Line 262 | Verified |
| vision-routes.js route comment header lines 1-24 | Lines 1-24 | Verified |
| lifecycle-manager.test.js `describe('store integration')` ends at line 419 | Line 419 | Verified |
| lifecycle-routes.test.js `describe('MCP tool schemas')` ends at line 307 | Line 307 | Verified |
| PHASE_ARTIFACTS import used in lifecycle-manager.js at line 36 | Line 36 | Verified |
| uuid import needed — already used in vision-store.js line 6 | Line 6 | Verified |

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `server/policy-engine.js` | **Create** | DEFAULT_POLICIES, evaluatePolicy(), VALID_GATE_OUTCOMES |
| `server/lifecycle-manager.js` | **Edit** | Policy-aware advancePhase/skipPhase, #executeAdvance/#executeSkip, #createGate, approveGate, #recordPolicyEntry, policyLog/pendingGate init |
| `server/vision-store.js` | **Edit** | gates Map, createGate, resolveGate, getPendingGates, getGatesForItem, gates in load/save/getState |
| `server/vision-routes.js` | **Edit** | Gate endpoints (GET/POST), 202 responses for gated advance/skip |
| `server/compose-mcp-tools.js` | **Edit** | toolApproveGate, toolGetPendingGates, _postGate helper, gates in loadVisionState fallback |
| `server/compose-mcp.js` | **Edit** | approve_gate + get_pending_gates definitions and switch cases |
| `test/policy-engine.test.js` | **Create** | Policy evaluation unit tests |
| `test/lifecycle-manager.test.js` | **Edit** | Gate lifecycle integration tests |
| `test/lifecycle-routes.test.js` | **Edit** | Gate endpoint + broadcast tests |
