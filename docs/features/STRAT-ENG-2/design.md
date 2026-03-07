# STRAT-ENG-2: Executor — State Model + Agent Dispatch

**Date:** 2026-03-07
**Status:** Design
**Parent:** [STRAT-1 Design](../STRAT-1/design.md)
**Depends on:** STRAT-ENG-1 (IR v0.2 schema — COMPLETE)
**Repo:** stratum-mcp (`/Users/ruze/reg/my/forge/stratum/stratum-mcp/`)

## Problem

STRAT-ENG-1 added three step modes to the IR (function, inline, flow_ref) and agent/execution fields. The executor ignores all of them. `get_current_step_info` unconditionally does `spec.functions[step.function]` — inline steps (`function=""`) cause a `KeyError`. The caller has no way to know which agent should run a step or what the inline prompt is.

This is the foundation layer. STRAT-ENG-3 (gates/policy), STRAT-ENG-4 (loops/rounds), and STRAT-ENG-5 (routing/composition) all build on the state model established here.

## Scope

Make the executor handle function and inline step modes. Pass through agent info. Enrich audit records. Do NOT implement:
- flow_ref execution (STRAT-ENG-5 — requires parent-child flow orchestration contract)
- on_fail/next routing (STRAT-ENG-5)
- Policy evaluation (STRAT-ENG-3)

Flow_ref steps encountered at runtime raise a clear "not yet supported" error. The full flow_ref contract (starting child flows, tracking parent-child state, resuming parent on child completion) is defined and implemented in STRAT-ENG-5.

## Current State

**File:** `src/stratum_mcp/executor.py`

### What works (unchanged by this feature)

- `FlowState` with rounds[], round archiving on gate revise — already implemented
- Gate resolution via `resolve_gate()` — already implemented
- `GateRecord`, `SkipRecord` — already implemented
- Checkpoint commit/revert — already implemented
- Persistence to `~/.stratum/flows/{flow_id}.json` — already implemented
- `_topological_sort`, `resolve_ref`, `compile_ensure` — already implemented

### What breaks on v0.2 inline steps

1. **`get_current_step_info` (L508):** Does `fn_def = state.spec.functions[step.function]` — KeyError when `step.function == ""`
2. **`process_step_result` (L581):** Same lookup: `fn_def = state.spec.functions[step.function]` — KeyError
3. **Step info response:** No `agent`, `intent`, or `step_mode` fields — caller can't dispatch correctly
4. **StepRecord (L258):** Only records `function_name` — no agent, no step mode
5. **Audit trail:** No visibility into which agent ran a step or whether it was inline vs function

## Changes

### 1. Step mode detection helper

```python
def _step_mode(step: IRStepDef) -> str:
    """Return 'function' or 'inline'. Raise on flow_ref (not yet supported)."""
    if step.function:
        return "function"
    if step.intent:
        return "inline"
    if step.flow_ref:
        raise MCPExecutionError(
            f"Step '{step.id}' uses flow_ref '{step.flow_ref}' — "
            f"flow composition is not yet supported (requires STRAT-ENG-5)"
        )
    raise MCPExecutionError(f"Step '{step.id}' has no execution mode")
```

Used everywhere the executor needs to branch on step type. The semantic validator already guarantees exactly one of function/intent/flow_ref is set. Flow_ref steps fail fast with a clear error — the full orchestration contract is defined in STRAT-ENG-5.

### 2. Extend StepRecord

```python
@dataclass
class StepRecord:
    step_id: str
    function_name: str          # existing — empty string for non-function steps
    attempts: int
    duration_ms: int
    type: str = "step"
    round: int = 0
    round_start_step_id: str | None = None
    # New fields:
    agent: str | None = None    # which agent executed (passthrough from step)
    step_mode: str = "function" # "function" | "inline"
```

Backward compatible: new fields have defaults matching existing behavior. Persisted records from older flows reconstruct with `agent=None, step_mode="function"`.

### 3. Update `get_current_step_info`

Currently returns a dict with `status`, `step_id`, `function`, `inputs`, `output_fields`, `ensure`, `retries_remaining`. The function lookup is the problem.

**Restructured logic:**

```python
step = state.ordered_steps[state.current_idx]

# skip_if evaluation runs BEFORE mode dispatch (existing behavior, unchanged).
# It is already mode-agnostic — checks step.skip_if regardless of function/inline.
# If skip_if evaluates True: writes SkipRecord, sets step_outputs[step.id] = None,
# increments current_idx, and tail-recurses. This path is preserved as-is.

mode = _step_mode(step)

if mode == "function":
    fn_def = state.spec.functions[step.function]
    # Existing logic: resolve inputs, get ensure/retries from fn_def
    return {
        "status": "execute_step",
        "step_id": step.id,
        "step_mode": "function",
        "function": step.function,
        "agent": step.agent,          # NEW
        "inputs": resolved_inputs,
        "output_fields": [...],
        "ensure": fn_def.ensure,
        "retries_remaining": fn_def.retries - state.attempts.get(step.id, 0),
    }

elif mode == "inline":
    # No function lookup. Step carries its own execution config.
    return {
        "status": "execute_step",
        "step_id": step.id,
        "step_mode": "inline",
        "intent": step.intent,
        "agent": step.agent,
        "inputs": resolved_inputs,
        "ensure": step.step_ensure or [],
        "retries_remaining": (step.step_retries or 1) - state.attempts.get(step.id, 0),
        "output_contract": step.output_contract,
        "model": step.step_model,
    }

```

**Key decisions:**
- Inline steps: `retries` defaults to 1 (one attempt, no retry) when `step_retries` is None
- `agent` is always included. For function steps it's typically None (caller decides). For inline steps it's the agent name.
- Flow_ref steps hit the `_step_mode` error before reaching this code.

### 4. Update `process_step_result`

Currently does `fn_def = state.spec.functions[step.function]` to get ensure and retries. Must branch on mode.

```python
step = state.ordered_steps[state.current_idx]
mode = _step_mode(step)

if mode == "function":
    fn_def = state.spec.functions[step.function]
    ensure_exprs = fn_def.ensure
    max_retries = fn_def.retries
    output_schema = step.output_schema
elif mode == "inline":
    ensure_exprs = step.step_ensure or []
    max_retries = step.step_retries or 1
    output_schema = None  # output_contract is informational, not schema-validated
# flow_ref: _step_mode raises before reaching here

# Rest of the logic unchanged: schema check → ensure check → success/retry
```

StepRecord creation gains the new fields:
```python
StepRecord(
    step_id=step.id,
    function_name=step.function,  # "" for inline/flow_ref
    attempts=state.attempts[step.id],
    duration_ms=duration,
    round=state.round,
    round_start_step_id=state.round_start_step_id,
    agent=step.agent,             # NEW
    step_mode=mode,               # NEW
)
```

### 5. Update `stratum_step_done` in server.py

The server tool currently returns `function` in several response dicts. Add `step_mode` and `agent`:

- On ensure_failed/schema_failed: include `step_mode` and `agent` in the retry response
- On ok: next step info already includes these (from `get_current_step_info`)
- On retries_exhausted: include `step_mode` in the error response

### 6. Update `stratum_audit` response

Add `step_mode` and `agent` to the trace records. These come from StepRecord automatically via `dataclasses.asdict`. No code change needed — the new StepRecord fields serialize naturally.

### 7. Persistence backward compatibility

`restore_flow` reconstructs records via `_record_from_dict` (L292). Must handle missing fields gracefully:

```python
def _record_from_dict(d: dict) -> StepRecord | GateRecord | SkipRecord:
    if d["type"] == "step":
        return StepRecord(
            ...existing fields...,
            agent=d.get("agent"),           # None for old records
            step_mode=d.get("step_mode", "function"),  # default for old records
        )
    # GateRecord, SkipRecord unchanged
```

### 8. Gate steps: no change needed

Gate steps always use `step.function` referencing a `mode: gate` function. The existing gate path in `get_current_step_info` (L521-527) and `resolve_gate` are unchanged. They already correctly return `{status: "await_gate", ...}` and handle gate resolution.

The only addition: gate step info responses should also include `agent` (None for gates) and `step_mode: "function"` for consistency.

## Response Shape Summary

| Mode | status | Key fields |
|---|---|---|
| function | `execute_step` | function, agent, inputs, output_fields, ensure, retries_remaining |
| inline | `execute_step` | intent, agent, inputs, ensure, retries_remaining, output_contract, model |
| gate | `await_gate` | function, agent, gate_info (existing) |
| flow_ref | — | Raises MCPExecutionError (STRAT-ENG-5) |

## Backward Compatibility

- StepRecord new fields default to existing values (`agent=None`, `step_mode="function"`)
- Old persisted flows restore correctly (missing fields get defaults)
- Function-mode steps behave identically to current behavior
- All existing 293 tests must continue to pass
- New tests cover inline step mode and flow_ref rejection

## Test Plan

| Test | What it validates |
|---|---|
| Inline step plan → step_done roundtrip | get_current_step_info returns intent/agent, process_step_result checks step-level ensure |
| Inline step ensure failure + retry | step_retries governs retry count, not function retries |
| Inline step retries exhausted | Terminates correctly with step_mode in record |
| Inline step without retries defaults to 1 | No retry on first failure when step_retries is None |
| Agent passthrough on function step | agent field present in step info (even when None) |
| Agent passthrough on inline step | agent field present and set to step's agent value |
| StepRecord includes agent and step_mode | Audit trace contains new fields |
| Persistence round-trip with new fields | agent/step_mode survive persist → restore |
| Old flow restore backward compat | Flow persisted before ENG-2 restores with defaults |
| Mixed-mode flow (function + inline) | Multi-step flow with both modes executes correctly |
| Inline step with skip_if is skipped | skip_if evaluation works on inline steps (mode-agnostic, not regressed) |
| Flow_ref step raises not-supported error | _step_mode raises MCPExecutionError for flow_ref steps |
| step_mode helper no-mode error | Step with no mode raises MCPExecutionError |

## File Changes

All in `stratum-mcp/src/stratum_mcp/`:

| File | Change |
|------|--------|
| `executor.py` | `_step_mode` helper (function/inline, flow_ref raises), StepRecord new fields, `get_current_step_info` restructured for function+inline, `process_step_result` branches on mode, `_record_from_dict` backward compat |
| `server.py` | `stratum_step_done` response dicts include step_mode/agent |

## Open Questions

None — this is a focused extension of the existing executor to handle inline steps and agent passthrough. Flow_ref execution is deferred to STRAT-ENG-5 where the full parent-child orchestration contract can be defined coherently.
