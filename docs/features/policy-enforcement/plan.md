# Policy Enforcement Runtime: Implementation Plan

**Blueprint:** [blueprint.md](blueprint.md)
**Date:** 2026-03-06

---

## Task Order

Tasks 1-2 are independent (new files, no cross-dependency). Task 3 depends on Tasks 1-2. Tasks 4-5 depend on Task 3. Task 6 depends on Tasks 4-5. Task 7 depends on all.

```
Task 1: policy-engine.js (new) ──────────┐
Task 2: vision-store.js gates (edit) ────┤
                                          ├──→ Task 3: lifecycle-manager.js (edit, depends 1+2)
                                          │
                                          │    Task 4: vision-routes.js (edit, depends 3)
                                          │    Task 5: MCP tools + MCP server (edit, depends 3)
                                          │          ├──→ Task 6: tests (depends 3+4+5)
                                          │          └──→ Task 7: verify all (depends 6)
```

---

## Task 1: Create `server/policy-engine.js` (new)

Per blueprint section 1.

- [ ] Create `server/policy-engine.js`
- [ ] Export `DEFAULT_POLICIES` map — 9 entries, no `explore_design` key
- [ ] Export `evaluatePolicy(targetPhase, overrides)` — coerces `null`/`undefined` overrides to `{}`, falls back to `DEFAULT_POLICIES`, then to `'skip'` for unknown phases, throws on invalid mode
- [ ] Export `VALID_GATE_OUTCOMES = ['approved', 'revised', 'killed']`
- [ ] `node --check server/policy-engine.js`

---

## Task 2: Edit `server/vision-store.js` — gates collection

Per blueprint section 2 (2.1-2.4).

- [ ] Add `this.gates = new Map();` after line 27
- [ ] Load gates in `_load()` after connections block (after line 44): `if (Array.isArray(data.gates))` loop
- [ ] Add `gates` array to `getState()` return value (line 69)
- [ ] Add `createGate(gate)` method after `deleteConnection()` (after line 197)
- [ ] Add `resolveGate(gateId, { outcome, comment })` — validates pending status, stamps `resolvedAt`, `resolvedBy`, `outcome`, `comment`
- [ ] Add `getPendingGates(itemId)` — filters `status === 'pending'`, optional itemId filter
- [ ] Add `getGatesForItem(itemId)` — returns all gates for an item regardless of status
- [ ] `node --check server/vision-store.js`

---

## Task 3: Edit `server/lifecycle-manager.js` — policy integration

Per blueprint sections 3.1-3.11. This is the largest task — the core policy engine integration.

- [ ] Add imports after line 9: `uuid`, `evaluatePolicy`/`VALID_GATE_OUTCOMES` from `policy-engine.js`, `ArtifactManager`/`ARTIFACT_SCHEMAS` from `artifact-manager.js`
- [ ] Add `#artifactManager;` private field declaration after line 51
- [ ] Extend constructor (line 53) to create `ArtifactManager` instance
- [ ] Extract `#executeAdvance(itemId, targetPhase, outcome)` — move current `advancePhase` body (lines 85-121) into private method
- [ ] Extract `#executeSkip(itemId, targetPhase, reason)` — move current `skipPhase` body (lines 125-144) into private method
- [ ] Rewrite `advancePhase()` as policy-aware wrapper: pendingGate guard → evaluatePolicy → gate/flag/skip branch
- [ ] Rewrite `skipPhase()` as policy-aware wrapper: same pattern as advancePhase
- [ ] Add `#createGate(itemId, operation, operationArgs, fromPhase, toPhase)` — pendingGate guard (defense-in-depth), artifact assessment snapshot, store gate, set `lifecycle.pendingGate`, record policyLog entry, return `{ status: 'pending_approval', gateId, ... }`
- [ ] Add `approveGate(gateId, { outcome, comment })` — validate gate exists/pending, verify `lifecycle.pendingGate === gateId`, replay original operation via `#executeAdvance`/`#executeSkip` on approve, call `killFeature` on killed, clear pendingGate via `#resolveGatePolicyEntry`
- [ ] Add `#recordPolicyEntry(itemId, type, fromPhase, toPhase, gateId)` — append to `lifecycle.policyLog`
- [ ] Add `#resolveGatePolicyEntry(itemId, gateId, outcome, comment)` — find gate entry in policyLog, stamp `resolvedAt`/`outcome`/`comment`, clear `pendingGate`
- [ ] Add `policyLog: []`, `pendingGate: null`, `policyOverrides: null` to `startLifecycle` lifecycle object (line 66)
- [ ] `node --check server/lifecycle-manager.js`

---

## Task 4: Edit `server/vision-routes.js` — gate endpoints + response shapes

Per blueprint section 4.

- [ ] Update route comment header (lines 1-24): add 3 gate route entries after line 23
- [ ] Replace advance endpoint (lines 152-170) with policy-aware version: check `result.status === 'pending_approval'` → 202 + `gatePending` broadcast, else existing 200 + `lifecycleTransition` broadcast
- [ ] Replace skip endpoint (lines 172-190) with same pattern: 202 for gated, 200 for non-gated
- [ ] Add `GET /api/vision/gates` after artifact endpoints (after line 262): calls `store.getPendingGates(itemId)`, always filters to pending
- [ ] Add `GET /api/vision/gates/:id`: returns single gate from `store.gates.get()`
- [ ] Add `POST /api/vision/gates/:id/resolve`: calls `lifecycleManager.approveGate()`, broadcasts `gateResolved`
- [ ] `node --check server/vision-routes.js`

---

## Task 5: Edit MCP tools + server — gate tools

Per blueprint sections 5 and 6.

### 5a: `server/compose-mcp-tools.js`

- [ ] Update `loadVisionState()` fallback (line 28) to include `gates: []`
- [ ] Add `_postGate(gateId, action, body)` helper after `_postLifecycle` (after line 208) — same pattern as `_postLifecycle`
- [ ] Add `toolApproveGate({ gateId, outcome, comment })` after `toolScaffoldFeature` (after line 248) — delegates to `_postGate(gateId, 'resolve', ...)`
- [ ] Add `toolGetPendingGates({ itemId })` — reads from `loadVisionState()`, filters `status === 'pending'`
- [ ] `node --check server/compose-mcp-tools.js`

### 5b: `server/compose-mcp.js`

- [ ] Add `toolApproveGate, toolGetPendingGates` to import block (after line 41)
- [ ] Add `approve_gate` tool definition after `scaffold_feature` (after line 207): `gateId` (required), `outcome` (required, enum), `comment` (optional)
- [ ] Add `get_pending_gates` tool definition: `itemId` (optional)
- [ ] Add 2 switch cases after `scaffold_feature` case (after line 240): `approve_gate` (async), `get_pending_gates` (sync)
- [ ] `node --check server/compose-mcp.js`

---

## Task 6: Tests

Per blueprint section 7. Three test files, two edited and one new.

### 6a: `test/policy-engine.test.js` (new)

- [ ] `evaluatePolicy` returns correct default for each of the 9 phases in DEFAULT_POLICIES
- [ ] `evaluatePolicy` with override map overrides the default
- [ ] `evaluatePolicy` returns `'skip'` for unknown phases not in DEFAULT_POLICIES
- [ ] `evaluatePolicy` throws on invalid mode string in overrides
- [ ] `evaluatePolicy` handles `null` overrides without crash
- [ ] `DEFAULT_POLICIES` has no `explore_design` key
- [ ] All values in `DEFAULT_POLICIES` are one of `'gate'`, `'flag'`, `'skip'`

### 6b: `test/lifecycle-manager.test.js` (edit) — `describe('policy enforcement')`

Add after `describe('store integration')` (after line 419):

- [ ] Gate creation on advance: advance to `blueprint` (gated) returns `{ status: 'pending_approval', gateId }`, lifecycle stays in `explore_design`
- [ ] Gate creation on skip into gated phase: advance to `prd`, then skip to `blueprint` returns `{ status: 'pending_approval' }`
- [ ] Gate approval replays advance: create gate for `blueprint`, approve, verify phase is now `blueprint`
- [ ] Gate approval replays skip: create gate for skip operation, approve, verify skip completed
- [ ] Gate revised: approve with `'revised'`, verify phase unchanged, `pendingGate` cleared
- [ ] Gate killed: approve with `'killed'`, verify item status is `killed`
- [ ] Flag mode: advance through gates to reach `execute` (flagged), verify `{ flagged: true, flagId }` and transition completed
- [ ] Skip-policy mode: advance through to `report` (skip-policy), verify transition completes silently without flag
- [ ] policyLog populated: after gate + flag + skip transitions, verify `lifecycle.policyLog` has entries of each type
- [ ] pendingGate blocks advance: create gate, then call `advancePhase` to a non-gated target, verify throws "gate ... is pending"
- [ ] pendingGate blocks skip: create gate, then call `skipPhase`, verify throws
- [ ] approveGate rejects stale gate: manually clear `lifecycle.pendingGate`, then try to approve the gate, verify throws "not the active gate"
- [ ] Double resolve rejected: approve gate, then try to approve again, verify throws "not pending"
- [ ] policyLog gate entry updated on resolution: after approveGate, verify the gate's policyLog entry has `resolvedAt`, `outcome`, `comment`
- [ ] approveGate with malformed gate operation: manually create a gate with `operation: 'bogus'` in the store, set `lifecycle.pendingGate`, approve — verify throws rather than returning undefined

### 6c: `test/lifecycle-routes.test.js` (edit) — `describe('gate REST endpoints')`

Add after `describe('MCP tool schemas')` (after line 307):

- [ ] Advance returns 202 for gated phase: POST advance to `blueprint`, assert status 202, body has `{ status: 'pending_approval', gateId }`
- [ ] GET /api/vision/gates returns pending gates: create gate via advance, GET `/api/vision/gates`, verify gate in response
- [ ] GET /api/vision/gates/:id returns single gate: fetch by gate ID, verify shape
- [ ] POST /api/vision/gates/:id/resolve approves and advances: resolve with `approved`, verify phase advanced to `blueprint`
- [ ] POST /api/vision/gates/:id/resolve with revised: resolve, verify phase unchanged
- [ ] POST /api/vision/gates/:id/resolve with killed: resolve, verify item status `killed`
- [ ] gatePending broadcast emitted: verify broadcast shape `{ type: 'gatePending', gateId, itemId, fromPhase, toPhase }`
- [ ] gateResolved broadcast emitted: verify broadcast shape `{ type: 'gateResolved', gateId, outcome }`

---

## Task 7: Verify all

- [ ] `node --test test/policy-engine.test.js` — all pass
- [ ] `node --test test/lifecycle-manager.test.js` — all pass (existing + new)
- [ ] `node --test test/lifecycle-routes.test.js` — all pass (existing + new)
- [ ] `node --test test/artifact-manager.test.js` — regression check (unchanged)
- [ ] Syntax check all edited server files: `node --check server/{policy-engine,lifecycle-manager,vision-store,vision-routes,compose-mcp-tools,compose-mcp}.js`

---

## Files Summary

| File | Action | Task |
|------|--------|------|
| `server/policy-engine.js` | **Create** | 1 |
| `server/vision-store.js` | **Edit** | 2 |
| `server/lifecycle-manager.js` | **Edit** | 3 |
| `server/vision-routes.js` | **Edit** | 4 |
| `server/compose-mcp-tools.js` | **Edit** | 5a |
| `server/compose-mcp.js` | **Edit** | 5b |
| `test/policy-engine.test.js` | **Create** | 6a |
| `test/lifecycle-manager.test.js` | **Edit** | 6b |
| `test/lifecycle-routes.test.js` | **Edit** | 6c |
