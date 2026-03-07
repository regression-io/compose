# STRAT-COMP-2: Delete Bespoke Lifecycle Code

**Status:** Design
**Roadmap:** Item 45
**Parent:** STRAT-1 Milestone 2
**Related:** [STRAT-COMP-1](../STRAT-COMP-1/) (headless runner), [STRAT-1 design](../STRAT-1/design.md#strat-comp-2-delete-bespoke-code)

## Problem

Compose has two parallel lifecycle systems:

1. **Bespoke** (`server/lifecycle-manager.js`, 539 lines) — state machine with gate subsystem, iteration loops, policy evaluation, reconciliation, phase history. Drives the UI server's REST API.
2. **Stratum-based** (`lib/build.js`, 460 lines) — headless runner using `stratum_plan`/`step_done`/`gate_resolve`. Drives `compose build`.

Both write to `vision-state.json` but with different conventions (`item.lifecycle.featureCode` vs `item.featureCode = 'feature:X'`). Both track phase state. Both manage gates. The bespoke code is 700+ lines (lifecycle-manager + policy-engine + lifecycle-constants) that duplicates what Stratum now handles.

## Goal

Delete the bespoke lifecycle state machine. Replace the server's lifecycle REST endpoints with thin adapters that delegate to Stratum or read directly from vision state. No UI breaking changes.

## What Gets Deleted

| File | Lines | Reason |
|---|---|---|
| `server/lifecycle-manager.js` | 539 | State machine replaced by Stratum flows |
| `server/policy-engine.js` | 33 | Policy baked into `.stratum.yaml` spec |
| `server/lifecycle-constants.js` | 41 | Constants only needed by deleted code |
| `contracts/lifecycle.json` | 107 | Contract for deleted state machine |
| `test/lifecycle-manager.test.js` | ~200 | Tests for deleted code |
| `test/policy-engine.test.js` | ~100 | Tests for deleted code |
| `test/lifecycle-contract.test.js` | ~190 | Tests for deleted contract |
| `test/iteration-manager.test.js` | ~200 | Tests for deleted iteration code |
| `test/gate-logic.test.js` | ~200 | Tests for deleted gate code |

## What Gets Kept

| File | Why |
|---|---|
| `server/artifact-manager.js` | Imports `PHASE_ARTIFACTS` from lifecycle-constants. Needs a local constant or inline map instead. |
| `server/vision-server.js` | Imports `CONTRACT` for settings store seed. Needs the iteration defaults and policy modes inlined. |
| `server/settings-store.js` | Receives contract at construction. Needs adapted initialization. |
| `src/components/vision/constants.js` | Client-side phase labels — already a hardcoded copy. Stays as-is. |

## What the REST Endpoints Become

The STRAT-1 design specifies preserved transport contracts. The UI keeps working.

### Approach: Direct Vision State + Stratum Passthrough

The server's lifecycle routes currently do two things:
1. **Mutate lifecycle state** (advance, skip, kill, complete, gates, iterations) via `LifecycleManager`
2. **Read lifecycle state** (get phase, get history, get iteration) from `item.lifecycle` in the store

After deletion:
- **Read endpoints** continue reading `item.lifecycle` from the store — no change needed
- **Mutation endpoints** become thin wrappers that update `item.lifecycle` directly on the vision store item, without the heavyweight state machine

### Why Not Proxy to Stratum?

The original design (STRAT-1:458-489) proposed proxying to `stratum_gate_resolve` and `stratum_iteration_*`. This has a problem: the server would need a running Stratum flow to proxy to, but Stratum flows are ephemeral (created by `compose build`, deleted on completion). The UI server runs persistently — it can't depend on a flow existing.

Instead: the server manages its own lightweight lifecycle state on vision items. This is what `VisionWriter` (from STRAT-COMP-1) already does for the headless path. The server adopts the same pattern: read/write `item.lifecycle` directly.

### Simplified Lifecycle State

The current `item.lifecycle` blob has 14 fields. Most exist to support the state machine's internal bookkeeping. The simplified version:

```js
{
  currentPhase: string,       // Phase ID or 'complete'/'killed'
  featureCode: string,        // Feature code
  startedAt: string,          // ISO timestamp
  completedAt: string | null, // ISO timestamp
  killedAt: string | null,    // ISO timestamp
  killReason: string | null,
  // Removed: phaseHistory, artifacts, reconcileWarning, policyLog,
  //          pendingGate, policyOverrides, iterationState
}
```

Fields removed:
- **phaseHistory** — Stratum's audit trail subsumes this. Available in `audit.json`.
- **artifacts** — `artifact-manager.js` scans disk on demand. No need to cache in state.
- **reconcileWarning** — reconciliation was a workaround for manual phase tracking. Stratum handles this.
- **policyLog** — Stratum's audit trail records all step outcomes.
- **pendingGate** — Gates in the headless path use Stratum's gate mechanism. For the UI path, gates are managed by the store's existing `gates` Map.
- **policyOverrides** — Never used (always null). Policy is in the YAML spec.
- **iterationState** — Stratum's `on_fail`/`next` routing with `retries:` handles this.

### Route Transformations

| Endpoint | Current | After |
|---|---|---|
| `GET .../lifecycle` | Reads `item.lifecycle` | Same (no change) |
| `POST .../lifecycle/start` | `lifecycleManager.startLifecycle()` | Write minimal lifecycle blob to store |
| `POST .../lifecycle/advance` | State machine + policy eval | Write `currentPhase` directly, validate transition |
| `POST .../lifecycle/skip` | State machine + policy eval | Write `currentPhase` directly, validate skippable |
| `POST .../lifecycle/kill` | State machine + gate cleanup | Write `killed` status, update item |
| `POST .../lifecycle/complete` | State machine, requires `ship` phase | Write `complete` status, update item |
| `POST .../gates/:id/resolve` | `lifecycleManager.approveGate()` | Resolve gate in store, advance phase |
| `POST .../iteration/start` | `lifecycleManager.startIterationLoop()` | **Delete** — handled by Stratum sub-flows |
| `POST .../iteration/report` | `lifecycleManager.reportIterationResult()` | **Delete** — handled by Stratum sub-flows |
| `GET .../iteration` | `lifecycleManager.getIterationStatus()` | **Delete** — handled by Stratum sub-flows |

The iteration endpoints can be deleted because:
- In headless mode (`compose build`), iterations are Stratum sub-flows (`review_fix`, `coverage_sweep`)
- The UI never starts iterations directly — they were only triggered by MCP tools calling back to the REST API
- The MCP tools that called these endpoints (`toolStartIterationLoop`, `toolReportIterationResult`) are also deleted

### Gate Simplification

Current gates are created by the policy engine when a phase transition has `defaultPolicy: "gate"`. The gate blocks the transition until resolved.

After: Gates become simple records in the store. No policy engine involvement. Phase transitions that should be gated are handled by:
- **Headless path**: Stratum's `await_gate` dispatch + `gate-prompt.js`
- **UI path**: REST endpoint creates a gate record, UI shows approval panel, resolution advances the phase

The gate data shape stays the same for UI compatibility:
```js
{
  id: string,
  itemId: string,
  fromPhase: string,
  toPhase: string,
  status: 'pending' | 'approved' | 'revised' | 'killed',
  createdAt: string,
  resolvedAt: string | null,
  outcome: string | null,
  comment: string | null,
}
```

Removed fields: `operation`, `operationArgs`, `resolvedBy`, `artifactAssessment` (artifact assessment moves to the existing artifact endpoint).

## Dependency Rewiring

### `server/artifact-manager.js`

Currently imports `PHASE_ARTIFACTS` from `lifecycle-constants.js`. After deletion, inline the constant:

```js
const PHASE_ARTIFACTS = {
  explore_design: 'design.md',
  prd: 'prd.md',
  architecture: 'architecture.md',
  blueprint: 'blueprint.md',
  plan: 'plan.md',
  report: 'report.md',
};
```

### `server/vision-server.js`

Currently imports `CONTRACT` from `lifecycle-constants.js` to seed `SettingsStore`. The settings store uses `contract.policyModes`, `contract.phases[*].defaultPolicy`, and `contract.iterationDefaults`. After deletion, pass these as a simple config object instead of the full contract.

### MCP Tools (`server/compose-mcp-tools.js`)

Read operations (`toolGetFeatureLifecycle`, `toolGetPendingGates`, `toolGetIterationStatus`) read from disk — no change. Mutation operations that proxy to lifecycle REST endpoints are deleted:
- `toolAdvanceFeaturePhase` — delete (agents use `stratum_step_done`)
- `toolSkipFeaturePhase` — delete (agents use Stratum's `skip_if`)
- `toolKillFeature` — keep, rewire to direct store write
- `toolCompleteFeature` — keep, rewire to direct store write
- `toolApproveGate` — delete (headless uses `stratum_gate_resolve`, UI uses REST)
- `toolStartIterationLoop` — delete (Stratum sub-flows)
- `toolReportIterationResult` — delete (Stratum sub-flows)

### Test Files

All tests for deleted modules are deleted. New tests cover:
- Simplified lifecycle route handlers (start, advance, skip, kill, complete)
- Gate creation and resolution through REST endpoints
- Vision state correctness after operations

## Feature Code Convention Unification

Currently two conventions:
- Server: `item.lifecycle.featureCode = 'FEAT-1'` (no prefix)
- VisionWriter: `item.featureCode = 'feature:FEAT-1'` (top-level, prefixed)

After STRAT-COMP-2: standardize on the top-level `item.featureCode = 'feature:FEAT-1'` convention. The `item.lifecycle.featureCode` field stores the raw code (no prefix) for backward compatibility with existing data.

## Risk Assessment

| Risk | Mitigation |
|---|---|
| UI breaks from changed lifecycle state shape | Read endpoints return same shape; removed fields were internal bookkeeping the UI doesn't render |
| Existing vision-state.json has old lifecycle blobs | Read endpoints gracefully handle both old and new shapes |
| Settings panel references policy phases | Client-side constants.js is independent — no server dependency |
| MCP tool deletions break agent workflows | Agents using `compose build` never called these tools; agents using the old tools get clear errors |

## File Manifest (Predicted)

**Delete:**
- `server/lifecycle-manager.js`
- `server/policy-engine.js`
- `server/lifecycle-constants.js`
- `contracts/lifecycle.json`
- `test/lifecycle-manager.test.js`
- `test/policy-engine.test.js`
- `test/lifecycle-contract.test.js`
- `test/iteration-manager.test.js`
- `test/gate-logic.test.js`

**Modify:**
- `server/vision-routes.js` — replace LifecycleManager calls with direct store writes
- `server/artifact-manager.js` — inline PHASE_ARTIFACTS constant
- `server/vision-server.js` — remove CONTRACT import, inline settings seed
- `server/compose-mcp-tools.js` — delete iteration/advance/skip tools
- `server/compose-mcp.js` — remove deleted tool registrations

**New:**
- `test/lifecycle-routes.test.js` — tests for simplified route handlers

## Verified Assumptions

1. **The UI reads `phaseHistory` from `item.lifecycle`** at `ItemDetailPanel.jsx:509-522`. It renders a compact breadcrumb trail of phase transitions. The access is guarded by `lc?.phaseHistory?.length > 1` so absent data is handled gracefully — the section simply doesn't render. No code change needed in the UI. Similarly, `artifactAssessment` on gates uses optional chaining. `policyLog` and `iterationState` are never read by the UI.

2. **Iteration REST endpoints are only called by MCP tools** (`compose-mcp-tools.js:344,349`) which proxy via `_postLifecycle()`. No agent skill or external consumer calls them directly. The test file `test/iteration-routes.test.js` covers them but is deleted along with the endpoints.

## Open Questions

1. **Settings panel policy dials become decorative.** Currently they feed into `evaluatePolicy()`. After deletion, they have no effect unless we wire them into the YAML spec (out of scope for STRAT-COMP-2). The dials remain in the UI but are cosmetic.
