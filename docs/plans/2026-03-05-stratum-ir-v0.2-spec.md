# Stratum IR v0.2 — Normative Spec Delta

**Date:** 2026-03-05
**Status:** DRAFT
**Scope:** Schema fields, defaults, invariants, and error contracts for gate/round/skip additions.
This is the source of truth for the stratum-mcp IR v0.2 refactor.

**Related:**
- `docs/plans/2026-03-05-stratum-audit.md` — gaps analysis that motivated these additions
- `docs/plans/2026-03-05-stratum-gate-transitions.md` — state machine / transition table
- `docs/plans/2026-03-05-stratum-gate-test-matrix.md` — acceptance test scenarios

---

## 1. Function Modes — `mode: gate`

### 1.1 Schema

```yaml
functions:
  approval_gate:
    mode: gate              # new — suspends execution until stratum_gate_resolve is called
    output: GateDecision    # contract ref; defaults to built-in GateDecision if omitted
    timeout: 3600           # optional: integer seconds; omit for no timeout
```

| Field | Type | Default | Invariant |
|---|---|---|---|
| `mode` | `"gate"` | — | Required to activate gate semantics |
| `output` | contract name or inline schema | `GateDecision` | Must resolve to a contract with `outcome` and `rationale` fields |
| `timeout` | integer (seconds) | `null` | Must be ≥ 1 if set; auto-kills with `resolved_by: system` on expiry |

### 1.2 Built-in contract `GateDecision`

```yaml
GateDecision:
  outcome:
    type: string
    enum: [approve, revise, kill]
  rationale:
    type: string
```

Both `outcome` and `rationale` are required. The contract is available to all flows without explicit declaration.

### 1.3 Restrictions on gate functions

| Condition | Error |
|---|---|
| `ensure` defined on a gate function | `IRSemanticError: gate functions may not have ensure expressions` |
| `retries` defined on a gate function | `IRSemanticError: gate functions may not have retries` |
| `budget` defined on a gate function | `IRSemanticError: gate functions may not have budget` |
| `input` defined on a gate function | Allowed — passed to the resolver as context but not used by the executor |

---

## 2. Step Fields — Gate Routing

These fields are valid **only** on steps whose function has `mode: gate`. They are not valid on infer or compute steps.

```yaml
steps:
  - id: design_gate
    function: approval_gate
    on_approve: prd        # step id or null (flow completes)
    on_revise: explore     # step id (must be a prior step)
    on_kill: killed        # step id or null (flow terminates with killed status)
```

| Field | Type | Default | Invariant |
|---|---|---|---|
| `on_approve` | step id or `null` | — | Required on gate steps. `null` = flow completes successfully with `status: complete` |
| `on_revise` | step id | — | Required on gate steps. Must reference a step that is topologically prior to the gate |
| `on_kill` | step id or `null` | — | Required on gate steps. `null` = flow terminates with `status: killed` |

### 2.1 Routing invariants

- All three routing fields (`on_approve`, `on_revise`, `on_kill`) are **required** on gate steps. A gate step with any field missing is a semantic error.
- `on_revise` must not reference the gate step itself.
- `on_revise` must not reference a step that is topologically after the gate (no forward rollback targets).
- `on_approve` and `on_kill`, if not null, must reference a valid step id in the same flow.
- Routing fields on non-gate steps are a semantic error.

### 2.2 Routing error cases

| Condition | Error |
|---|---|
| `on_approve`/`on_revise`/`on_kill` defined on non-gate step | `IRSemanticError: on_approve/on_revise/on_kill are only valid on gate steps` |
| Gate step missing `on_approve` | `IRSemanticError: gate step '<id>' must declare on_approve, on_revise, and on_kill` |
| Gate step missing `on_revise` | `IRSemanticError: gate step '<id>' must declare on_approve, on_revise, and on_kill` |
| Gate step missing `on_kill` | `IRSemanticError: gate step '<id>' must declare on_approve, on_revise, and on_kill` |
| `on_revise` references non-existent step | `IRSemanticError: on_revise target '<id>' not found in flow '<flow>'` |
| `on_revise` references the gate step itself | `IRSemanticError: on_revise target must not be the gate step itself` |
| `on_approve` references non-existent step | `IRSemanticError: on_approve target '<id>' not found in flow '<flow>'` |
| `on_kill` references non-existent step | `IRSemanticError: on_kill target '<id>' not found in flow '<flow>'` |

---

## 3. Step Fields — Skip

Valid on **any non-gate** step.

```yaml
steps:
  - id: prd
    function: write_prd
    skip_if: "$.input.skip_prd == true"
    skip_reason: "PRD not required for internal features"
```

| Field | Type | Default | Invariant |
|---|---|---|---|
| `skip_if` | string (Python expression) | `null` | Evaluated against flow inputs before the step is dispatched. No `result` variable available. Same sandbox as `ensure`. |
| `skip_reason` | string | `""` | Recorded in the trace skip entry when `skip_if` fires. May be defined without `skip_if` (treated as annotation only). |

### 3.1 Skip semantics

- `skip_if` is evaluated **once**, before the step is dispatched, against `$.input.*` references only.
- If truthy: step is marked `skipped` in the trace; execution advances to the next step; no output is produced.
- If a downstream step references a skipped step's output via `$.steps.<id>.output`, that reference resolves to `null`. The downstream step is responsible for handling null output; no automatic error is raised.
- Skip bypasses `retries`, `ensure`, and `budget` — the step is never executed.
- `skip_if` uses the same restricted-builtins sandbox as `ensure` expressions (no dunder access, no I/O).

### 3.2 Skip error cases

| Condition | Error |
|---|---|
| `skip_if` defined on a gate step | `IRSemanticError: gate steps may not have skip_if` |
| `skip_if` expression fails to compile | `IRSemanticError: skip_if expression failed to compile in step '<id>': <reason>` |
| `skip_if` expression raises at runtime | Treat as `false` (do not skip); record warning in trace |

---

## 4. Flow Fields — Round Tracking

```yaml
flows:
  compose_feature:
    max_rounds: 10
    steps: [...]
```

| Field | Type | Default | Invariant |
|---|---|---|---|
| `max_rounds` | integer | `null` (unlimited) | Must be ≥ 1 if set. If omitted, revise cycles are unlimited. |

### 4.1 `max_rounds` error cases

| Condition | Error |
|---|---|
| `max_rounds: 0` | `IRValidationError: max_rounds must be >= 1` |
| `max_rounds` is not an integer | `IRValidationError: max_rounds must be an integer` |
| `max_rounds` defined on a flow with no gate steps | Allowed — treated as a no-op (no revise cycles possible) |

---

## 5. FlowState Runtime Extensions

These fields are added to `FlowState` and persisted to disk as part of flow state JSON. They survive MCP server restarts.

| Field | Type | Default | Description |
|---|---|---|---|
| `round` | `int` | `0` | Current round counter. Incremented by 1 on each revise outcome. |
| `rounds` | `list[list[dict]]` | `[]` | Archive. `rounds[N]` = list of record dicts for all steps and gates that ran in round N, in execution order. Written before active state is cleared on revise. |

### 5.1 `rounds[]` archive invariants

- `len(state.rounds)` equals the number of completed revise cycles (equal to `state.round` after all revises).
- `state.rounds[N]` is written once and never modified. A subsequent revise in round N+1 must not alter `rounds[N]`.
- The complete execution history across all rounds is reconstructible as: `state.rounds[0] + state.rounds[1] + ... + state.records` (active round).
- The `GateRecord` for the revise outcome is appended to `state.records` **before** `state.records` is archived and cleared. The revise gate record therefore appears in `rounds[N]`, not in the active round.

---

## 6. StepRecord Extensions

Two new fields are added to `StepRecord`. Both fields are also present on `GateRecord` (see §7).

| Field | Type | Default | Description |
|---|---|---|---|
| `round` | `int` | — | Round index in which this step executed. Equal to `state.round` at time of record creation. |
| `round_start_step_id` | `str \| None` | `None` | For round 0: `None`. For round N > 0: the step id that was the `on_revise` target that started this round. Identical for all records within the same round. |

### 6.1 StepRecord invariants

- All `StepRecord`s in `state.records` (active round) have `round == state.round`.
- All archived `StepRecord`s in `state.rounds[N]` have `round == N`.
- `round_start_step_id` is `None` for all round-0 records.
- `round_start_step_id` is the same value for every record within a given round N > 0.

---

## 7. GateRecord (new trace entry type)

Gate steps produce a `GateRecord` rather than a `StepRecord`. A `GateRecord` is written to `state.records` when `stratum_gate_resolve` is called.

| Field | Type | Required | Description |
|---|---|---|---|
| `step_id` | `str` | yes | Gate step id |
| `type` | `"gate"` | yes | Distinguishes from `StepRecord` (which has `type: "step"`) |
| `outcome` | `"approve" \| "revise" \| "kill"` | yes | Gate resolution outcome |
| `rationale` | `str` | yes | Resolver-provided rationale |
| `resolved_by` | `"human" \| "agent" \| "system"` | yes | Resolver identity — recorded only, no execution effect |
| `round` | `int` | yes | Round in which this gate was resolved |
| `round_start_step_id` | `str \| None` | yes | Same semantics as StepRecord (see §6) |
| `duration_ms` | `int` | yes | Wall time from gate step being reached to resolution |

### 7.1 GateRecord invariants

- A `GateRecord` is always appended to `state.records` before any rollback clears `state.records`. This ensures the gate outcome is included in the archive for that round.
- `resolved_by` must be one of `"human"`, `"agent"`, `"system"`. No other values are accepted.
- `outcome` must be one of `"approve"`, `"revise"`, `"kill"`. No other values are accepted.
- On a revise outcome, the `GateRecord` appears in `rounds[N]` (archived), not in the active `state.records` after rollback.

---

## 8. Tool API Contracts

### 8.1 `stratum_step_done` — Gate Step Rejection

When the current step has `mode: gate`, `stratum_step_done` **must** return an error without modifying flow state (no attempt increment, no record written, `current_idx` unchanged):

```json
{
  "status": "error",
  "code": "gate_step_requires_gate_resolve",
  "message": "step '<step_id>' has mode: gate. Use stratum_gate_resolve to resolve gate steps."
}
```

### 8.2 `stratum_gate_resolve` — Non-Gate Step Rejection

When called on a step whose function does **not** have `mode: gate`, `stratum_gate_resolve` **must** return an error without modifying flow state:

```json
{
  "status": "error",
  "code": "not_a_gate_step",
  "message": "step '<step_id>' has mode: <mode>. stratum_gate_resolve only resolves gate steps."
}
```

### 8.3 `stratum_gate_resolve` — Approve

```
stratum_gate_resolve(flow_id, step_id, outcome="approve", rationale, resolved_by) → dict
```

1. Validate `resolved_by` and `outcome` values.
2. Write `GateRecord` to `state.records`.
3. If `on_approve` is `null`: persist state; return flow-complete response (same shape as `stratum_step_done` complete).
4. If `on_approve` is a step id: set `current_idx` to that step; persist state; return next-step response.

### 8.4 `stratum_gate_resolve` — Revise

```
stratum_gate_resolve(flow_id, step_id, outcome="revise", rationale, resolved_by) → dict
```

Two-phase operation. Steps 1–3 form an early-exit path; steps 4–10 are the rollback path that only executes when the limit check passes:

1. Validate `resolved_by` and `outcome` values.
2. Write `GateRecord` to `state.records` (with `outcome: revise`). **This write is not rolled back on early exit** — see step 3.
3. Check max_rounds: if `state.round >= flow_def.max_rounds`, return `max_rounds_exceeded` error. The GateRecord from step 2 remains in `state.records`; active state is otherwise not modified. Steps 4–10 do not execute.
4. Archive: `state.rounds.append([r.to_dict() for r in state.records])`.
5. For each step S from `on_revise` target onward in topological order: `state.step_outputs.pop(S.id, None)`, `state.attempts.pop(S.id, None)`.
6. Reset: `state.records = []`.
7. Increment: `state.round += 1`.
8. Set `state.current_idx` to the index of the `on_revise` target in `ordered_steps`.
9. Persist state to disk.
10. Return next-step response for `on_revise` target with `round: state.round`.

**max_rounds exceeded response (flow remains `running`):**

```json
{
  "status": "error",
  "code": "max_rounds_exceeded",
  "message": "flow '<flow_id>' has reached max_rounds (<N>). Kill the flow or increase max_rounds."
}
```

Note: The `GateRecord` from step 2 is written to `state.records` before the check in step 3. If the limit is hit, `state.records` still contains this record but is not archived and active state is not cleared. The flow remains in `running` state — it is stuck but not terminated. The gate can still be resolved with `outcome: kill` to exit. There is no separate `aborted` flow state.

### 8.5 `stratum_gate_resolve` — Kill

```
stratum_gate_resolve(flow_id, step_id, outcome="kill", rationale, resolved_by) → dict
```

1. Validate `resolved_by` and `outcome` values.
2. Write `GateRecord` to `state.records`.
3. If `on_kill` is `null`: persist state; return killed response.
4. If `on_kill` is a step id: set `current_idx` to that terminal step; persist state; return next-step response.

**Kill response (null `on_kill`):**

```json
{
  "status": "killed",
  "flow_id": "<flow_id>",
  "step_id": "<gate_step_id>",
  "rationale": "<rationale>",
  "resolved_by": "<resolved_by>",
  "trace": [...]
}
```

---

## 9. `stratum_audit` Extensions

`stratum_audit` always includes a `rounds` field. It is an empty array when no revise has occurred and a non-empty array otherwise. Clients must not check for field presence — `rounds` is unconditionally present:

```json
{
  "flow_id": "...",
  "status": "...",
  "round": 1,
  "rounds": [
    {
      "round": 0,
      "steps": [
        {"step_id": "work", "type": "step", "attempts": 1, "duration_ms": 120, "round": 0, "round_start_step_id": null},
        {"step_id": "gate", "type": "gate", "outcome": "revise", "rationale": "...", "resolved_by": "human", "round": 0}
      ]
    }
  ],
  "trace": [
    {"step_id": "work", "type": "step", "attempts": 1, "duration_ms": 95, "round": 1, "round_start_step_id": "work"},
    {"step_id": "gate", "type": "gate", "outcome": "approve", "rationale": "...", "resolved_by": "human", "round": 1}
  ]
}
```

- `rounds` is an empty array if no revise has occurred.
- `trace` contains only the active round's records.
- Full history = `rounds[0].steps + rounds[1].steps + ... + trace`.
- `round` at the top level reflects `state.round` at audit time.
