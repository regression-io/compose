# STRAT-ENG-4: Executor — Loops and Rounds

**Date:** 2026-03-07
**Status:** Design
**Related:** [STRAT-1 design](../STRAT-1/design.md), [STRAT-ENG-3 design](../STRAT-ENG-3/design.md)
**Repo:** `stratum-mcp/` at `/Users/ruze/reg/my/forge/stratum/stratum-mcp/`

## Problem

The STRAT-1 design commits to per-step iteration tracking (`max_iterations`,
`exit_criterion`, `iteration_history[]`) and frozen `stratum_iteration_*` tool
signatures, but never defines the IR fields, persistence shape, or MCP payloads.
The only loop primitive Stratum currently has is flow-level `max_rounds` on gate
revise cycles. Per-step iteration — the counted retry loop with exit criteria —
does not exist.

Compose's `lifecycle-manager.js` has a working reference: `startIterationLoop()`
and `reportIterationResult()` manage loop state with count tracking, max
enforcement, and exit criteria evaluation. This needs to become a Stratum
primitive.

## What Already Exists (Round Tracking)

Round tracking is **fully implemented** and not in scope:

| Primitive | Location | Status |
|---|---|---|
| `FlowState.round` counter | `executor.py:377` | COMPLETE |
| `FlowState.rounds[]` archive | `executor.py:378` | COMPLETE |
| `FlowState.round_start_step_id` | `executor.py:379` | COMPLETE |
| Round increment + archive on revise | `executor.py:873-888` | COMPLETE |
| `max_rounds` enforcement | `executor.py:850-855` | COMPLETE |
| All records carry `round` field | `executor.py:279,294,304,316` | COMPLETE |
| Persistence includes round state | `executor.py:412-414` | COMPLETE |

### `max_rounds` semantics (clarification)

The current executor starts at `round = 0` (initial pass). On revise, the
check `state.round >= flow_def.max_rounds` fires *before* incrementing
(`executor.py:850`). If it passes, the round is archived, state is cleared,
and *then* `state.round` increments (`executor.py:886`). So `max_rounds: 3`
allows revise transitions that produce rounds 1, 2, 3. The fourth revise
attempt hits `3 >= 3` and returns `max_rounds_exceeded`.

**Contract:** `max_rounds` means "maximum number of revise transitions allowed."
The initial pass is round 0 and does not count against the limit. This matches
the current implementation and is now explicitly documented.

## Scope: Per-Step Iteration

A counted sub-loop attached to a step. The caller (agent or orchestrator) starts
an iteration loop on a step, reports results after each attempt, and the executor
tracks count, enforces max, evaluates exit criteria, and records history.

### Design rules

1. **Iteration does not own routing.** ENG-4 defines iteration state and result
   recording. Iteration produces a normalized outcome (`continue`, `exit_success`,
   `exit_max`, `exit_abort`). Only ENG-5 maps outcomes onto `next`/`on_fail`
   routing behavior.

2. **Iteration is flow-level runtime state, not StepRecord state.** `StepRecord`
   is an immutable audit artifact for one completed attempt. Iteration is live
   controller state: count, active status, exit criterion, per-iteration reports.

3. **Iteration history is a separate audit structure.** Not retrofitted into
   trace entries. `stratum_audit` returns iteration history alongside `trace`
   and `rounds[]` as its own append-only log.

## IR Schema Changes

### New fields on `IRStepDef`

```python
@dataclass(frozen=True)
class IRStepDef:
    # ... existing fields ...
    # v0.2 STRAT-ENG-4: per-step iteration
    max_iterations: int | None = None     # max loop count (None = no iteration)
    exit_criterion: str | None = None     # ensure-style expression evaluated on each report
```

### New fields on JSON Schema (`_IR_SCHEMA_V02`)

Added to `StepDef.properties`:

```yaml
max_iterations:
  type: integer
  minimum: 1
exit_criterion:
  type: string
```

### Semantic validation

- `max_iterations` forbidden on gate steps (gates have their own revise cycle)
- `exit_criterion` requires `max_iterations` (otherwise it never evaluates)
- `exit_criterion` must not contain dunder attributes (same guard as `ensure`)

### YAML example

```yaml
steps:
  - id: review
    agent: codex
    intent: "Review implementation. Return {clean: boolean, findings: []}."
    max_iterations: 10
    exit_criterion: "result.clean == true"
    ensure:
      - "result.clean is not None"

  - id: coverage
    agent: claude
    intent: "Write tests for uncovered paths. Return {passing: boolean, count: int}."
    max_iterations: 15
    exit_criterion: "result.passing == true"
```

## Flow State Changes

### New fields on `FlowState`

```python
@dataclass
class FlowState:
    # ... existing fields ...
    # v0.2 STRAT-ENG-4: per-step iteration tracking
    iterations: dict[str, list[dict]] = field(default_factory=dict)
    # step_id → list of IterationReport dicts for the CURRENT round (cleared on revise)
    archived_iterations: list[dict[str, list[dict]]] = field(default_factory=list)
    # Parallel to rounds[] — one entry per archived round, each is step_id → reports
    active_iteration: dict[str, Any] | None = None
    # Currently running iteration loop (None when no loop active)
    iteration_outcome: dict[str, str] = field(default_factory=dict)
    # step_id → outcome string, written on iteration exit, consumed by stratum_step_done
    # ENG-5 handoff: persists between iteration exit and step completion
```

### `active_iteration` shape

```python
{
    "step_id": str,           # which step this loop is on
    "round": int,             # which flow-level round this iteration started in
    "max_iterations": int,    # from step def
    "exit_criterion": str,    # from step def
    "count": 0,               # iterations completed so far
    "started_at": float,      # monotonic timestamp
    "status": "active",       # "active" | "exit_success" | "exit_max" | "exit_abort"
}
```

### `iterations[step_id]` entry shape (IterationReport)

Each report appended after `stratum_iteration_report`:

```python
{
    "iteration": int,         # 1-based index
    "round": int,             # flow-level round when this iteration ran
    "result": dict,           # the result dict from the caller
    "exit_criterion_met": bool,
    "outcome": str,           # "continue" | "exit_success" | "exit_max"
    "timestamp": float,
}
```

### Persistence

`persist_flow` and `restore_flow` serialize/deserialize `iterations`,
`archived_iterations`, `active_iteration`, and `iteration_outcome` alongside
existing fields. Shape is JSON-native (dicts and lists), no dataclass
conversion needed.

### Checkpoints

`commit_checkpoint` and `revert_checkpoint` include `iterations` (deep copy),
`archived_iterations` (deep copy), `active_iteration`, and
`iteration_outcome` (shallow copy) in the snapshot.

## MCP Tools

### `stratum_iteration_start`

Starts an iteration loop on the current step. The step must have
`max_iterations` defined in the spec.

```
stratum_iteration_start(flow_id, step_id) → {
    status: "iteration_started",
    flow_id, step_id,
    max_iterations, exit_criterion,
    iteration: 0
}
```

**Constraints:**
- `step_id` must match current step
- Step must have `max_iterations` defined
- No active iteration loop already running
- Cannot start iteration on gate steps
- Records `active_iteration` on flow state

**Why explicit start?** The caller (agent) decides when to enter iteration
mode. Some steps with `max_iterations` defined might succeed on the first
try and never need an iteration loop. The iteration start is a signal that
the caller is entering a retry cycle.

### `stratum_iteration_report`

Reports one iteration result. Evaluates `exit_criterion`, increments count,
checks max, returns outcome.

```
stratum_iteration_report(flow_id, step_id, result: dict) → {
    status: "iteration_continue" | "iteration_exit",
    flow_id, step_id,
    iteration: int,           # current count (1-based)
    max_iterations: int,
    exit_criterion_met: bool,
    outcome: str,             # "continue" | "exit_success" | "exit_max"
    # When outcome != "continue", also includes:
    # final_result: dict      # the result that triggered exit
}
```

**Behavior:**

1. Increment `active_iteration.count`
2. Evaluate `exit_criterion` against `result` (same engine as `compile_ensure`)
3. Append `IterationReport` to `iterations[step_id]`
4. If exit criterion met → outcome `exit_success`, clear `active_iteration`
5. If count >= max_iterations → outcome `exit_max`, clear `active_iteration`
6. Otherwise → outcome `continue`

**On exit:** `active_iteration` is set to None. The outcome is written to
`FlowState.iteration_outcome[step_id]` (e.g., `"exit_success"`, `"exit_max"`,
`"exit_abort"`). This field persists until `stratum_step_done` completes the
step, at which point it is consumed and cleared. The step remains current —
the caller must then call `stratum_step_done` with the final result to advance
the flow. This keeps iteration separate from step completion.

**Why `iteration_outcome`?** ENG-5 needs to route on iteration results (e.g.,
`on_fail` when `exit_max`). Without a persisted outcome, `active_iteration`
is already None by the time `stratum_step_done` runs, and the historical log
is too indirect for routing decisions. `iteration_outcome[step_id]` is the
explicit handoff: ENG-4 writes it, ENG-5 reads it.

### `stratum_iteration_abort`

Aborts an active iteration loop before completion.

```
stratum_iteration_abort(flow_id, step_id, reason: str) → {
    status: "iteration_aborted",
    flow_id, step_id,
    iteration: int,
    reason: str
}
```

Appends a final report with `outcome: "exit_abort"`, writes
`iteration_outcome[step_id] = "exit_abort"`, clears `active_iteration`.
The step remains current.

## Interaction with Existing Primitives

### Iteration vs. retries

`retries` (on function/inline steps) is the *ensure postcondition* retry
budget managed by `process_step_result`. Iteration is a *caller-driven* loop
managed by the iteration tools. They are independent:

- A step can have `retries: 3` and `max_iterations: 10`
- Each iteration report is a caller-level loop cycle
- Each `stratum_step_done` call consumes a retry if ensure fails
- Iteration runs *before* the final `stratum_step_done`

### Iteration vs. rounds

Rounds are flow-level revise cycles triggered by gate resolution. Iterations
are step-level sub-loops. An iteration loop runs within a single round. If a
revise resets the flow back to a step with `max_iterations`, the iteration
state for that step is cleared (fresh start in the new round).

### Iteration and revise reset

Iteration history is append-only audit data. On revise, it must be archived,
not deleted. However, `rounds[]` is `list[list[dict]]` in the current executor
(`executor.py:378`), persistence (`executor.py:412`), checkpoint restore
(`executor.py:495`), and audit wrapper (`server.py:251`). Redefining that
shape would break persisted flows and all code that assumes elements are raw
record lists.

**Solution:** A parallel `FlowState.archived_iterations` list, indexed by
round, holds iteration history from prior rounds. Same length as `rounds[]`,
each entry is a `dict[str, list[dict]]` (step_id → iteration reports).

When `resolve_gate` archives a round and clears active state:

1. **Archive all iteration data for the round** into `archived_iterations`:
   ```python
   # Existing: archive ALL active records (unchanged)
   state.rounds.append([dataclasses.asdict(r) for r in state.records])

   # New: archive ALL current-round iteration data (parallel list)
   state.archived_iterations.append(state.iterations)
   state.iterations = {}
   ```
   This mirrors the existing pattern: `state.records` archives the whole
   round then resets to `[]`, so `state.iterations` archives the whole round
   then resets to `{}`. The archive is round-scoped, not clear-range-scoped.

2. **Clear active:** If `active_iteration` is not None, set it to None (the
   loop is abandoned by the revise — it necessarily belongs to a step that
   will be re-executed).

3. **Clear outcome:** Remove `iteration_outcome[step_id]` for all cleared
   steps.

`rounds[]` shape is untouched — still `list[list[dict]]`. Iteration history
from prior rounds lives in `archived_iterations[round_index]` and surfaces in
`stratum_audit`. Active-round iteration history stays in `iterations[step_id]`.

### Iteration and skip

If a step with `max_iterations` is skipped (via `skip_if` or
`stratum_skip_step`), no iteration state is created. Skipped steps have no
iteration history.

### Iteration and policy

Iteration fields are only valid on non-gate steps (semantic validation
enforces this). Policy evaluation (`apply_gate_policy`) is unaffected.

## Audit Output

`stratum_audit` response gains a new top-level field:

```python
{
    "flow_id": ...,
    "status": ...,
    "trace": [...],           # existing — active round records
    "rounds": [...],          # existing — archived round records
    "round": ...,             # existing — current round number
    # NEW:
    "iterations": {
        "step_id_1": [
            {
                "iteration": 1,
                "round": 0,
                "exit_criterion_met": false,
                "outcome": "continue",
                "timestamp": 1709827200.0
            },
            {
                "iteration": 2,
                "round": 0,
                "exit_criterion_met": true,
                "outcome": "exit_success",
                "timestamp": 1709827260.0
            }
        ],
        "step_id_2": [...]
    }
}
```

The `result` dict from each report is intentionally excluded from audit output
to keep the trace compact. Full results are available via `FlowState.iterations`
during execution if needed.

Archived round iteration data surfaces alongside `rounds[]` without changing
its shape:

```python
{
    # existing (unchanged shape):
    "rounds": [
        {"round": 0, "steps": [...]},   # server.py wraps at read time
        {"round": 1, "steps": [...]},
    ],
    # NEW — parallel list, same indexing as rounds[]:
    "archived_iterations": [
        {   # round 0 iterations
            "review": [
                {"iteration": 1, "round": 0, "outcome": "continue", ...},
                {"iteration": 2, "round": 0, "outcome": "exit_max", ...}
            ]
        },
        {}  # round 1 had no iteration loops
    ],
}
```

## What Changes in Existing Code

- `resolve_gate` — revise path archives `iterations` wholesale into
  `archived_iterations` (parallel to `rounds[]`) then resets to `{}`, clears
  `active_iteration` unconditionally, clears `iteration_outcome` for cleared
  steps
- `stratum_step_done` — consumes `iteration_outcome[step_id]` on step
  completion (pop from dict). Does not act on it in ENG-4 — just clears it.
  ENG-5 will add routing logic that reads the outcome before clearing.
- `stratum_audit` — returns new `iterations` (current round) and
  `archived_iterations` (prior rounds) fields
- `persist_flow` / `restore_flow` — serialize `iterations`,
  `archived_iterations`, `active_iteration`, `iteration_outcome`
- `commit_checkpoint` / `revert_checkpoint` — include all four new fields

## What Does NOT Change

- `rounds[]` shape — still `list[list[dict]]`, no migration needed
- `process_step_result` — unchanged (retries are independent)
- `get_current_step_info` — unchanged (iteration doesn't affect dispatch)
- `apply_gate_policy` — unchanged (iteration not on gates)
- `stratum_plan` — unchanged
- `stratum_gate_resolve` — unchanged (resolve_gate helper changes, not the tool)
- `stratum_check_timeouts` — unchanged
- `stratum_skip_step` — unchanged
- All existing tests — must continue passing

## Test Strategy

### Integration tests (~12 tests)

Golden flow: start iteration → report results → exit on criterion met → step_done
- `test_iteration_start_and_exit_success` — start, report with criterion met, verify outcome
- `test_iteration_exit_max` — report until max_iterations, verify exit_max outcome
- `test_iteration_abort` — start, abort, verify cleanup
- `test_iteration_audit_output` — verify iterations appear in stratum_audit
- `test_iteration_archived_on_revise` — iteration history moves to round archive on revise, not deleted
- `test_iteration_audit_shows_archived_iterations` — archived round iterations appear in audit output
- `test_iteration_persistence` — start iteration, persist, restore, continue
- `test_iteration_checkpoint_revert` — checkpoint during iteration, revert, verify state

### Contract tests (~5 tests)

- `test_iteration_fields_on_ir_schema` — max_iterations, exit_criterion parsed correctly
- `test_iteration_forbidden_on_gate_steps` — semantic validation rejects
- `test_exit_criterion_requires_max_iterations` — semantic validation rejects
- `test_exit_criterion_dunder_blocked` — dunder guard on exit_criterion
- `test_iteration_start_wrong_step` — error when step_id doesn't match current

### Error path tests (~5 tests)

- `test_iteration_start_no_max_iterations` — step without max_iterations
- `test_iteration_start_already_active` — double start rejected
- `test_iteration_report_no_active` — report without start rejected
- `test_iteration_start_gate_step` — rejected for gate steps
- `test_iteration_report_after_exit` — report after loop exited rejected
- `test_iteration_outcome_persists_until_step_done` — outcome survives in iteration_outcome until consumed
- `test_iteration_outcome_cleared_on_revise` — cleared for steps in revise range
