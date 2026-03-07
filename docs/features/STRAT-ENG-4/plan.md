# STRAT-ENG-4: Implementation Plan

**Date:** 2026-03-07
**Design:** [design.md](design.md)
**Repo:** `stratum-mcp/` at `/Users/ruze/reg/my/forge/stratum/stratum-mcp/`

## Tasks

### Task 1: IR Schema — add `max_iterations` and `exit_criterion`

**File:** `src/stratum_mcp/spec.py` (existing)

- [ ] Add `max_iterations: int | None = None` and `exit_criterion: str | None = None` to `IRStepDef` dataclass (after `step_budget` field, ~line 89)
- [ ] Add to `_IR_SCHEMA_V02` `StepDef.properties` (~line 322):
  ```
  "max_iterations": {"type": "integer", "minimum": 1}
  "exit_criterion": {"type": "string"}
  ```
- [ ] Add to `_build_step` (~line 480):
  ```python
  max_iterations=s.get("max_iterations"),
  exit_criterion=s.get("exit_criterion"),
  ```
- [ ] Semantic validation in `_validate_semantics`:
  - Gate steps: `max_iterations` forbidden (insert at ~line 639, before `skip_if` check)
  - Non-gate steps: `exit_criterion` requires `max_iterations`
  - Non-gate steps: `exit_criterion` dunder guard

### Task 2: FlowState — add iteration fields

**File:** `src/stratum_mcp/executor.py` (existing)

- [ ] Add to `FlowState` dataclass (after `terminal_status`, line 381):
  ```python
  iterations: dict[str, list[dict]] = field(default_factory=dict)
  archived_iterations: list[dict[str, list[dict]]] = field(default_factory=list)
  active_iteration: dict[str, Any] | None = None
  iteration_outcome: dict[str, str] = field(default_factory=dict)
  ```
- [ ] Add to `persist_flow` payload (after line 415)
- [ ] Add to `restore_flow` constructor (after line 464, with `.get()` fallbacks)
- [ ] Add to `commit_checkpoint` snapshot (after line 497, deep copy iterations/archived)
- [ ] Add to `revert_checkpoint` restore (after line 519, deep copy iterations/archived)

### Task 3: Executor — iteration core logic

**File:** `src/stratum_mcp/executor.py` (existing)

Three new functions after `apply_gate_policy` (~line 978):

- [ ] `start_iteration(state, step_id) -> dict`
  - Validate: step_id matches current, step has `max_iterations`, no active iteration, not gate
  - Set `state.active_iteration` dict: step_id, round, max_iterations, exit_criterion, count=0, started_at, status="active"
  - Return `{"status": "iteration_started", ...}`
- [ ] `report_iteration(state, step_id, result) -> dict`
  - Validate: active_iteration exists and matches step_id
  - Increment count, evaluate `exit_criterion` via `compile_ensure`
  - Append IterationReport to `state.iterations[step_id]`
  - On exit: write `iteration_outcome[step_id]`, clear `active_iteration`
  - Persist flow
  - Return response with outcome
- [ ] `abort_iteration(state, step_id, reason) -> dict`
  - Validate: active_iteration exists and matches step_id
  - Append final report with outcome "exit_abort"
  - Write `iteration_outcome[step_id] = "exit_abort"`, clear `active_iteration`
  - Persist flow

### Task 4: Revise reset — archive iteration data

**File:** `src/stratum_mcp/executor.py` (existing)

- [ ] In `resolve_gate` revise path, two insertion points:
  1. Before `state.rounds.append` (line 874) — archive and reset round-scoped data:
     ```python
     state.archived_iterations.append(state.iterations)
     state.iterations = {}
     state.active_iteration = None
     ```
  2. After `steps_to_clear` is built (line 877) — clear outcome for cleared steps:
     ```python
     for sid in steps_to_clear:
         state.iteration_outcome.pop(sid, None)
     ```

### Task 5: stratum_step_done — consume iteration_outcome

**File:** `src/stratum_mcp/server.py` (existing)

- [ ] After `process_step_result` returns "ok", before returning next step (~line 184):
  ```python
  state.iteration_outcome.pop(step_id, None)
  ```

### Task 6: MCP tools — three new tools

**File:** `src/stratum_mcp/server.py` (existing)

Follow `stratum_skip_step` pattern (lines 423-478):

- [ ] `stratum_iteration_start(flow_id, step_id, ctx)` — restore flow, call `start_iteration`, persist, return
- [ ] `stratum_iteration_report(flow_id, step_id, result, ctx)` — restore flow, call `report_iteration`, return
- [ ] `stratum_iteration_abort(flow_id, step_id, reason, ctx)` — restore flow, call `abort_iteration`, return
- [ ] Add imports from executor

### Task 7: stratum_audit — expose iteration data

**File:** `src/stratum_mcp/server.py` (existing)

- [ ] Add to `stratum_audit` response (after line 251):
  ```python
  "iterations": state.iterations,
  "archived_iterations": state.archived_iterations,
  ```

### Task 8: Contract tests

**File:** `tests/contracts/test_ir_v02_extensions.py` (existing)

- [ ] `test_max_iterations_parsed` — field appears on IRStepDef
- [ ] `test_exit_criterion_parsed` — field appears on IRStepDef
- [ ] `test_max_iterations_forbidden_on_gate_steps` — semantic validation rejects
- [ ] `test_exit_criterion_requires_max_iterations` — semantic validation rejects
- [ ] `test_exit_criterion_dunder_blocked` — dunder guard fires

### Task 9: Integration tests

**File:** `tests/integration/test_iterations.py` (new)

- [ ] `test_iteration_start_and_exit_success` — full happy path
- [ ] `test_iteration_exit_max` — report N times until max
- [ ] `test_iteration_abort` — start, abort, verify cleanup
- [ ] `test_iteration_audit_output` — iterations in stratum_audit
- [ ] `test_iteration_archived_on_revise` — history archived on gate revise
- [ ] `test_iteration_audit_shows_archived` — archived iterations in audit
- [ ] `test_iteration_persistence` — persist, restore, continue
- [ ] `test_iteration_checkpoint_revert` — checkpoint, revert, verify
- [ ] `test_iteration_outcome_persists_until_step_done` — outcome survives
- [ ] `test_iteration_outcome_cleared_on_revise` — cleared for revise-range steps

### Task 10: Error path tests

**File:** `tests/integration/test_iterations.py` (new, same file)

- [ ] `test_iteration_start_no_max_iterations` — step without max_iterations
- [ ] `test_iteration_start_already_active` — double start rejected
- [ ] `test_iteration_report_no_active` — report without active loop
- [ ] `test_iteration_start_gate_step` — gate step rejected
- [ ] `test_iteration_report_after_exit` — report after loop exited

## Task Order

```
Task 1 (IR) → Task 2 (FlowState) → Task 3 (core logic)
                                     ↓
                        Task 4 (revise reset)
                        Task 5 (step_done)
                        Task 6 (MCP tools)
                        Task 7 (audit)
                                     ↓
                        Task 8-10 (tests)
```

Tasks 1-3 sequential. Tasks 4-7 depend on 3, independent of each other.
Tests after all code.

## Verification

```bash
cd /Users/ruze/reg/my/forge/stratum/stratum-mcp
pytest tests/ -x -v
```

All 276 existing tests pass. ~20 new tests. Target: 296+.
