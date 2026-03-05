# Stratum Gate — State Transitions Reference

**Date:** 2026-03-05
**Status:** DRAFT

**Related:**
- `docs/plans/2026-03-05-stratum-ir-v0.2-spec.md` — field definitions and error contracts
- `docs/plans/2026-03-05-stratum-gate-test-matrix.md` — acceptance test scenarios

---

## Step States

| State | Meaning |
|---|---|
| `pending` | Step not yet reached in topological execution order |
| `dispatched` | Infer/compute step sent to executor; awaiting `stratum_step_done` |
| `gate_pending` | Gate step reached; awaiting `stratum_gate_resolve` |
| `done` | Infer/compute step completed; `StepRecord` written to `state.records` |
| `skipped` | `skip_if` evaluated truthy before dispatch; step bypassed; skip entry written to trace |
| `failed` | Retries exhausted; step could not satisfy ensures or schema; flow is stuck |
| `gate_resolved` | Gate step resolved via `stratum_gate_resolve`; `GateRecord` written |
| `reverted` | Step cleared by a revise rollback; will re-execute in the next round |

## Flow States

| State | Meaning |
|---|---|
| `running` | Flow active; at least one step remains. Also the state when `max_rounds_exceeded` blocks a revise — the flow is stuck but not terminated; the gate must be killed to exit. |
| `complete` | All steps done or skipped; `on_approve: null` reached or last step done |
| `killed` | Kill outcome reached (`on_kill: null`, or after routing to and completing a terminal step) |
| `failed` | Step retries exhausted; flow cannot proceed without external intervention |

---

## Transition Table

| Current step mode | Event | Precondition | Next step state | Flow state | Side effects |
|---|---|---|---|---|---|
| `infer` / `compute` | `stratum_step_done(ok)` | ensures pass, schema valid | `done` | `running` (next step) or `complete` | StepRecord appended; `current_idx++`; state persisted |
| `infer` / `compute` | `stratum_step_done(ok)` | ensures fail, retries remain | `dispatched` (retry) | `running` | `attempts[step_id]++` |
| `infer` / `compute` | `stratum_step_done(ok)` | ensures fail, retries exhausted | `failed` | `failed` | StepRecord appended with violations; state persisted |
| `infer` / `compute` | `stratum_gate_resolve(any)` | — | no change | `running` | **Error returned:** `not_a_gate_step`; state unchanged |
| `gate` | `stratum_step_done(any)` | — | no change | `running` | **Error returned:** `gate_step_requires_gate_resolve`; state unchanged |
| `gate` | `stratum_gate_resolve(approve)` | `on_approve: null` | `gate_resolved` | `complete` | GateRecord appended; state persisted |
| `gate` | `stratum_gate_resolve(approve)` | `on_approve: <step_id>` | `gate_resolved` → next step `dispatched` | `running` | GateRecord appended; `current_idx` → on_approve target; state persisted |
| `gate` | `stratum_gate_resolve(revise)` | `round < max_rounds` (or no limit) | `gate_resolved` → on_revise target: `reverted` → `dispatched` | `running` (on_revise target) | GateRecord appended; `state.records` archived to `rounds[round]`; `step_outputs`/`attempts`/`records` cleared from on_revise target onward; `round++`; `current_idx` → on_revise target; state persisted |
| `gate` | `stratum_gate_resolve(revise)` | `round >= max_rounds` | no change | `running` (stuck) | **Error returned:** `max_rounds_exceeded`; GateRecord written but active state not cleared |
| `gate` | `stratum_gate_resolve(kill)` | `on_kill: null` | `gate_resolved` | `killed` | GateRecord appended; state persisted |
| `gate` | `stratum_gate_resolve(kill)` | `on_kill: <step_id>` | `gate_resolved` → terminal step `dispatched` | `running` | GateRecord appended; `current_idx` → on_kill target; state persisted |
| `gate` | timeout fires | `timeout` configured; elapsed ≥ timeout; `on_kill: null` | `gate_resolved` | `killed` | GateRecord appended with `outcome: kill`, `resolved_by: system`; state persisted |
| `gate` | timeout fires | `timeout` configured; elapsed ≥ timeout; `on_kill: <step_id>` | `gate_resolved` → terminal step `dispatched` | `running` | GateRecord appended with `outcome: kill`, `resolved_by: system`; `current_idx` → on_kill target; state persisted |
| `infer` / `compute` | `skip_if` → truthy | evaluated before dispatch | `skipped` | `running` (next step) | Skip entry written to trace with `skip_reason`; no output produced; downstream `$.steps.<id>.output` → `null` |
| `gate` | `skip_if` defined | parse time | — | — | **Error:** `IRSemanticError: gate steps may not have skip_if` |

---

## API Boundary Rules

These rules are enforced at the tool call layer, not at the IR parse layer.

| Rule | Enforcement point |
|---|---|
| `stratum_step_done` called on gate step | Executor checks `fn_def.mode == "gate"` before processing; returns error immediately |
| `stratum_gate_resolve` called on non-gate step | Executor checks `fn_def.mode != "gate"`; returns error immediately |
| `stratum_gate_resolve` called on a step that is not current | Error: step is not the current pending step |
| `resolved_by` not in `{"human", "agent", "system"}` | Error returned before any state modification |
| `outcome` not in `{"approve", "revise", "kill"}` | Error returned before any state modification |

In all error cases: **state is unchanged**. No partial writes. No attempt increments. No records written.

Exception: the `max_rounds_exceeded` case during revise — a `GateRecord` is written to `state.records` before the check fires (see spec §8.4, step 3). The state is otherwise unchanged (no archive, no clear, no round increment).

---

## Atomic Revise Rollback — Step Order

On `stratum_gate_resolve(revise)` for gate step `G` with `on_revise: T`:

```
1. Validate resolved_by, outcome
2. Write GateRecord to state.records              ← gate decision is recorded first
3. Check: state.round >= flow_def.max_rounds      ← abort here if limit reached
4. Archive: state.rounds.append([r.to_dict() for r in state.records])
5. Clear outputs: state.step_outputs.pop(S.id) for each S from T onward
6. Clear attempts: state.attempts.pop(S.id) for each S from T onward
7. Clear records: state.records = []
8. Increment: state.round += 1
9. Reposition: state.current_idx = index_of(T) in ordered_steps
10. Persist state to disk
11. Return {"status": "execute_step", "step_id": T.id, "round": state.round, ...}
```

**Why this order matters:**
- Step 2 before step 4: the revise GateRecord is included in the archive for round N.
- Step 3 after step 2: if max_rounds aborts, the GateRecord is written but not archived (acceptable — the flow is stuck). Active state is not cleared so the flow state remains inspectable.
- Step 4 before steps 5–7: the archive captures the full round N state before any deletion.
- Step 8 before step 10: the persisted state reflects the incremented round, so a restart after step 10 sees the correct round value.

---

## State Machine (text)

```
[pending]
    │
    ├── skip_if=true ────────────────────────────────► [skipped] ── next step
    │   (evaluated before dispatch; step never reaches [dispatched])
    │
    │ (skip_if false or absent; step dispatched)
    ▼
[dispatched]
    │
    ├── stratum_step_done(ok) ──────────────────────► [done] ── next step or complete
    │                                                   (via current_idx++)
    ├── stratum_step_done(ok, ensures fail, retry) ──► [dispatched] (retry)
    │
    ├── stratum_step_done(ok, retries exhausted) ────► [failed] ── flow: failed
    │
    └── (if mode: gate) [gate_pending]
              │
              ├── gate_resolve(approve) ──────────────► [gate_resolved] ── on_approve target or complete
              │
              ├── gate_resolve(revise, round ok) ──────► [gate_resolved] + on_revise target: [reverted → dispatched]
              │
              ├── gate_resolve(revise, max_rounds) ────► error: max_rounds_exceeded (GateRecord written; rollback does not execute)
              │
              ├── gate_resolve(kill) ─────────────────► [gate_resolved] ── on_kill target (running) or killed
              │
              └── timeout fires ───────────────────────► [gate_resolved] ── on_kill target (running) or killed
                                                          (resolved_by: system; follows same on_kill branch as kill)
```
