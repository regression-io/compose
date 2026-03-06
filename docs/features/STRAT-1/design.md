# STRAT-1: Stratum Process Engine Completion

**Date:** 2026-03-06
**Status:** Design
**Related:** [Stratum Audit](../../plans/2026-03-05-stratum-audit.md), [Lifecycle Engine Roadmap](../../plans/2026-02-15-lifecycle-engine-roadmap.md)

## Problem

Compose built a full lifecycle engine (state machine, gates, policy, iterations, reconciliation) because Stratum didn't have the primitives. Now both systems exist, the separation of concerns is wrong, and the primitives aren't reusable.

The stated architecture is: "Stratum is the engine, Compose is the workflow spec." The reality is: Compose is both.

## Goal

Complete Stratum as a general-purpose process engine using Compose's working implementations as the reference spec. Then Compose expresses its lifecycle as a Stratum spec and delegates execution.

## Separation of Concerns

**Stratum owns the process** — how work gets done:

| Primitive | What it does | Compose reference |
|---|---|---|
| Step execution | Run steps, track state, verify postconditions | Already in Stratum |
| Gates | Suspend until decision, route on outcome | `lifecycle-manager.js:424-497` |
| Policy | Three-level enforcement (gate/flag/skip) | `policy-engine.js` (zero Compose knowledge) |
| Skip | Bypass a step with recorded reason | `lifecycle-manager.js:130-165` |
| Rounds | Track revision cycles, max limits | `lifecycle-manager.js` phaseHistory |
| Iteration loops | Count-tracked retry with exit criteria | `lifecycle-manager.js:218-288` |
| Deferred operations | Freeze intended action, replay on approval | `lifecycle-manager.js` gate operationArgs |
| Pending mutex | One gate per entity at a time | `lifecycle-manager.js:69` pendingGate |
| Reconciliation | Infer state from external signals | `lifecycle-manager.js` reconcile() |
| Audit trail | Full trace per round | `lifecycle-manager.js` policyLog |

**Compose owns the workspace** — what's going on and where things live:

| Concern | What it does |
|---|---|
| Lifecycle definition | The 10-phase spec expressed as `.stratum.yaml` |
| Phase names & artifacts | `explore_design`, `design.md`, etc. — Compose vocabulary |
| Feature folders | `docs/features/<code>/` structure and templates |
| Artifact assessment | Markdown quality checks, section validation |
| Vision Surface | Items, connections, graphs, views |
| Sessions | Working session tracking, feature binding |
| Project config | `.compose/compose.json`, paths, capabilities |
| Agent dispatch | Connectors to Claude, Codex |
| The UI | Terminal, sidebar, canvas, gate approval panel |

## What Stratum Gets (IR v0.2)

Four additions to the `.stratum.yaml` format, each informed by Compose's working code:

### 1. Gate step type

**Reference:** `lifecycle-manager.js` gate subsystem

```yaml
functions:
  approval_gate:
    mode: gate                    # new mode — suspends until resolution
    output: GateDecision          # { outcome, rationale, resolved_by }
    timeout: 3600                 # optional auto-kill

steps:
  - id: design_gate
    function: approval_gate
    on_approve: blueprint         # next step
    on_revise: explore            # roll back target
    on_kill: killed               # terminal step
```

New MCP tool: `stratum_gate_resolve(flow_id, step_id, outcome, rationale, resolved_by)`

The deferred-operation pattern from Compose becomes native: the gate freezes the flow, resolution routes it.

### 2. Policy layer

**Reference:** `policy-engine.js` — directly portable, zero Compose knowledge

```yaml
steps:
  - id: prd
    function: write_prd
    policy: gate                  # gate | flag | skip
    policy_fallback: skip         # if no runtime override
```

Three-level resolution: step-level override → flow-level settings → spec default.

`flag` mode is novel — Stratum has nothing like it today. Proceed but record the governance decision in the audit trail.

### 3. Skip

**Reference:** `lifecycle-manager.js` skipPhase()

```yaml
steps:
  - id: prd
    function: write_prd
    skip_if: "$.input.skip_prd == true"
    skip_reason: "PRD not required for internal features"
```

Or explicit: `stratum_skip_step(flow_id, step_id, reason)` — records the skip in the audit trace instead of silently omitting it.

### 4. Round tracking

**Reference:** `lifecycle-manager.js` phaseHistory, iteration loops

```yaml
flows:
  compose_feature:
    max_rounds: 10
```

- `round` field on `StepRecord`, incremented on each revise cycle
- `rounds[]` archive on flow state — prior round trace entries preserved
- Per-step iteration tracking: `max_iterations`, `exit_criterion`, `iteration_history[]`

## Implementation Phases

### Phase 1: IR v0.2 Schema (Stratum repo)

Add the new types to `spec.py`:
- `mode: gate` on functions
- `on_approve`, `on_revise`, `on_kill` on steps
- `policy`, `policy_fallback` on steps
- `skip_if`, `skip_reason` on steps
- `max_rounds` on flows
- `round`, `iterations` on StepRecord

**Reference:** `contracts/lifecycle.json` for the structural envelope pattern.
**Validation:** `stratum_validate` catches invalid specs.

### Phase 2: Gate Executor (Stratum repo)

Implement gate resolution in `executor.py`:
- `stratum_gate_resolve` MCP tool
- On approve → advance to `on_approve` step
- On revise → archive trace, clear state from `on_revise` target onward, increment round, resume
- On kill → route to `on_kill` terminal step
- Pending-gate mutex (one per flow)

**Reference:** `lifecycle-manager.js:424-497` (gate creation), `lifecycle-manager.js:174-215` (gate approval with deferred-op replay).

### Phase 3: Policy Engine (Stratum repo)

Implement three-level policy resolution in the executor:
- Read `policy` from step spec
- Accept runtime overrides via `stratum_set_policy(flow_id, step_id, mode)`
- Evaluate before step dispatch: gate → create gate step; flag → log and proceed; skip → skip with reason
- `flag` creates audit entry but does not suspend

**Reference:** `policy-engine.js` — can be ported almost line-for-line.

### Phase 4: Skip & Round Tracking (Stratum repo)

- `skip_if` evaluation in executor (Python expression, same as `ensure`)
- `stratum_skip_step` explicit tool
- Round counter increment on revise, `max_rounds` enforcement
- `rounds[]` archive with per-round trace entries
- `stratum_audit` reports per-round breakdown

**Reference:** `lifecycle-constants.js` SKIPPABLE set, `lifecycle-manager.js` phaseHistory round tracking.

### Phase 5: Compose Integration (Compose repo)

Replace Compose's bespoke lifecycle code with Stratum primitives while preserving the existing REST and WebSocket contracts that the UI and tests depend on.

**Gate API migration:**

The current gate transport contract:
- `GET /api/vision/gates` — list pending gates (filtered by itemId)
- `GET /api/vision/gates/:id` — get gate detail
- `POST /api/vision/gates/:id/resolve` — resolve with `{ outcome, comment }`
- WebSocket broadcast: `gateResolved { gateId, itemId, outcome, timestamp }`

These endpoints stay. The route handlers become a thin adapter layer:
- `POST .../resolve` calls `stratum_gate_resolve(flow_id, step_id, outcome, ...)` instead of `lifecycleManager.approveGate()`
- `GET .../gates` reads gate state from Stratum flow state instead of `store.gates`
- WebSocket broadcasts are triggered by Stratum gate events, not lifecycle-manager side effects
- Response shapes remain identical — no breaking change to the UI or MCP tools

**Iteration migration:**

Iteration loops (review/coverage within execute phase) are a **Stratum primitive**, not a Compose-local concern. The current transport contract:
- `POST /api/vision/items/:id/lifecycle/iteration/start` — `{ loopType, maxIterations }`
- `POST /api/vision/items/:id/lifecycle/iteration/report` — `{ clean, passing, summary, findings, failures }`
- `GET /api/vision/items/:id/lifecycle/iteration` — current iteration status (loopType, count, maxIterations, active)
- WebSocket broadcasts: `iterationStarted`, `iterationUpdate`, `iterationComplete { loopType, outcome, finalCount }`

These endpoints and events stay as an adapter layer. Stratum owns the loop execution:
- `iteration/start` calls a new `stratum_iteration_start(flow_id, step_id, loopType, maxIterations)` tool
- `iteration/report` calls `stratum_iteration_report(flow_id, step_id, result)` — Stratum evaluates exit criteria, increments count, enforces max
- `iteration` GET reads loop state from Stratum flow state instead of `lifecycleManager.getIterationStatus()`
- `iterationComplete` is broadcast when Stratum reports loop exit (clean completion or max_reached) — the client message handler and error detection depend on this signal
- The phase-exit mutex (cannot leave execute while loop active) moves to Stratum's executor
- Loop types and their exit criteria (`clean` for review, `passing` for coverage) are defined in the `.stratum.yaml` spec, not hardcoded in Compose

**What gets deleted from Compose:**
- `lifecycle-manager.js` state machine, gate subsystem, iteration subsystem (replaced by Stratum calls)
- `policy-engine.js` (ported to Stratum)
- Most of `lifecycle-constants.js` (phases still Compose-owned, but execution primitives gone)

**What becomes adapter code in Compose:**
- Gate route handlers → thin proxy to `stratum_gate_resolve`
- Iteration route handlers → thin proxy to `stratum_iteration_*`
- WebSocket broadcasts → triggered by Stratum events

**What stays unchanged in Compose:**
- Feature folder management, artifact assessment
- The `.stratum.yaml` lifecycle spec (Compose's opinion)
- Vision Surface, sessions, project config, UI
- Gate approval panel UI (same REST contract, different backend)
- All MCP tool signatures (same interface, Stratum backend)

### Phase 6: Validation

- Compose's 410 tests adapted to use Stratum primitives
- Stratum's own tests for gates, policy, skip, rounds
- E2E: run `/compose` lifecycle through Stratum with a real feature

## Open Questions

1. **Event model:** Should Stratum push events (WebSocket/SSE) or should Compose continue polling? Push would eliminate `stratum-sync.js` polling and enable real-time gate notifications.

2. ~~**Iteration loops vs. revision rounds:**~~ **Resolved.** Iteration loops are a Stratum primitive (see Phase 5: Compose Integration). Stratum owns loop execution, count tracking, exit criteria evaluation, and max enforcement. Compose retains the REST/WS adapter layer and the loop type definitions in its `.stratum.yaml` spec.

3. **Artifact awareness:** Reconciliation (infer phase from files on disk) is currently in Compose. Should Stratum have a generic "external signal reconciliation" primitive, or is this always workflow-specific?

4. **Contract format:** Should `lifecycle.json` become a `.stratum.yaml` spec directly, or should Stratum support a separate "workflow contract" format that sits above individual specs?
