# STRAT-ENG-2: Implementation Plan

**Date:** 2026-03-07
**Design:** [design.md](./design.md)
**Repo:** `stratum-mcp/` at `/Users/ruze/reg/my/forge/stratum/stratum-mcp/`
**Files:** `src/stratum_mcp/executor.py` (existing), `src/stratum_mcp/server.py` (existing)

## Task Order

Tasks are sequential — each builds on the prior. All changes are in the Stratum repo.

---

### Task 1: Add `_step_mode` helper

**File:** `src/stratum_mcp/executor.py` (existing)

**What:**
- [ ] Add `_step_mode(step: IRStepDef) -> str` after the `_topological_sort` function (L250)
- [ ] Returns `"function"` if `step.function`, `"inline"` if `step.intent`
- [ ] Raises `MCPExecutionError` if `step.flow_ref` (clear message: "flow composition not yet supported, requires STRAT-ENG-5")
- [ ] Raises `MCPExecutionError` if none set (defensive — validator prevents this)

**Test:**
- [ ] `test_step_mode_function` — function step returns `"function"`
- [ ] `test_step_mode_inline` — inline step returns `"inline"`
- [ ] `test_step_mode_flow_ref_raises` — flow_ref step raises MCPExecutionError with "STRAT-ENG-5"
- [ ] `test_step_mode_no_mode_raises` — step with no mode raises MCPExecutionError

---

### Task 2: Extend `StepRecord` with `agent` and `step_mode`

**File:** `src/stratum_mcp/executor.py` (existing)

**What:**
- [ ] Add `agent: str | None = None` field to `StepRecord` (L258–266)
- [ ] Add `step_mode: str = "function"` field to `StepRecord`
- [ ] Update `_record_from_dict` (L292–319) to read new fields with defaults:
  ```python
  agent=d.get("agent"),
  step_mode=d.get("step_mode", "function"),
  ```

**Test:**
- [ ] `test_step_record_defaults` — new fields default to `None` and `"function"`
- [ ] `test_record_from_dict_backward_compat` — dict without `agent`/`step_mode` reconstructs with defaults

---

### Task 3: Restructure `get_current_step_info` for function + inline

**File:** `src/stratum_mcp/executor.py` (existing), `get_current_step_info` (L508–578)

**Critical prerequisite:** The current code does `fn_def = state.spec.functions[step.function]` at L521, before skip_if evaluation. For inline steps (`function=""`), this causes a KeyError. The function lookup must move into the `mode == "function"` branch, AFTER skip_if evaluation.

**What:**

- [ ] Move `fn_def` lookup from L521 to inside the function-mode branch
- [ ] Add `mode = _step_mode(step)` call after skip_if evaluation
- [ ] Restructure skip_if to be mode-aware for the gate check:
  ```python
  step = state.ordered_steps[state.current_idx]

  # skip_if evaluation: mode-agnostic, runs before dispatch.
  # Gate check: only function steps can be gates, so check function first.
  is_gate = step.function and state.spec.functions[step.function].mode == "gate"
  if step.skip_if and not is_gate:
      # existing skip_if logic unchanged
      ...

  mode = _step_mode(step)  # after skip_if, before dispatch

  if is_gate:
      # existing gate path — add agent and step_mode to response
      ...
      return {
          ...existing fields...,
          "agent": step.agent,
          "step_mode": "function",
      }
  ```
- [ ] Function-mode branch (non-gate):
  ```python
  if mode == "function":
      fn_def = state.spec.functions[step.function]
      resolved = resolve_inputs(step.inputs, state.inputs, state.step_outputs)
      contract = state.spec.contracts.get(fn_def.output_contract)
      output_fields = {k: v.get("type", "any") for k, v in contract.fields.items()} if contract else {}
      return {
          "status": "execute_step",
          "flow_id": state.flow_id,
          "step_number": state.current_idx + 1,
          "total_steps": len(state.ordered_steps),
          "step_id": step.id,
          "step_mode": "function",
          "function": step.function,
          "agent": step.agent,
          "mode": fn_def.mode,
          "intent": fn_def.intent,
          "inputs": resolved,
          "output_contract": fn_def.output_contract,
          "output_fields": output_fields,
          "ensure": fn_def.ensure,
          "retries_remaining": fn_def.retries - state.attempts.get(step.id, 0),
      }
  ```
- [ ] Inline-mode branch:
  ```python
  elif mode == "inline":
      resolved = resolve_inputs(step.inputs, state.inputs, state.step_outputs)
      state.dispatched_at[step.id] = time.monotonic()
      attempts_so_far = state.attempts.get(step.id, 0)
      max_retries = step.step_retries or 1
      # Resolve output contract fields if output_contract references a known contract
      contract = state.spec.contracts.get(step.output_contract or "")
      output_fields = {k: v.get("type", "any") for k, v in contract.fields.items()} if contract else {}
      return {
          "status": "execute_step",
          "flow_id": state.flow_id,
          "step_number": state.current_idx + 1,
          "total_steps": len(state.ordered_steps),
          "step_id": step.id,
          "step_mode": "inline",
          "intent": step.intent,
          "agent": step.agent,
          "inputs": resolved,
          "output_contract": step.output_contract,
          "output_fields": output_fields,
          "ensure": step.step_ensure or [],
          "retries_remaining": max_retries - attempts_so_far,
          "model": step.step_model,
      }
  ```

**Test:**
- [ ] `test_inline_step_info_returns_intent` — inline step returns intent, agent, step_mode="inline"
- [ ] `test_inline_step_info_returns_step_ensure` — ensure comes from step, not function
- [ ] `test_inline_step_info_retries_default` — when step_retries is None, retries_remaining is 1
- [ ] `test_function_step_info_includes_agent` — function step response has agent field (None)
- [ ] `test_function_step_info_includes_step_mode` — function step response has step_mode="function"
- [ ] `test_gate_step_info_includes_agent_and_step_mode` — gate response has agent and step_mode
- [ ] `test_inline_step_skip_if_works` — inline step with skip_if=true is skipped (SkipRecord written)

---

### Task 4: Restructure `process_step_result` for function + inline

**File:** `src/stratum_mcp/executor.py` (existing), `process_step_result` (L581–660)

**Critical prerequisite:** Same as Task 3 — `fn_def = state.spec.functions[step.function]` at L603 KeyErrors on inline steps.

**What:**

- [ ] Replace the `fn_def` lookup with mode-branching:
  ```python
  step = state.ordered_steps[state.current_idx]
  mode = _step_mode(step)

  if mode == "function":
      fn_def = state.spec.functions[step.function]
      ensure_exprs = fn_def.ensure
      max_retries = fn_def.retries
      output_schema = step.output_schema
      fn_name = fn_def.name
  elif mode == "inline":
      ensure_exprs = step.step_ensure or []
      max_retries = step.step_retries or 1
      output_schema = None  # output_contract is informational at this stage
      fn_name = ""
  ```
- [ ] Update all `StepRecord(...)` creation sites (L614, L639, L651) to include new fields:
  ```python
  StepRecord(
      step_id=step_id,
      function_name=fn_name,
      attempts=attempt,
      duration_ms=duration_ms,
      round=state.round,
      round_start_step_id=state.round_start_step_id,
      agent=step.agent,
      step_mode=mode,
  )
  ```
- [ ] Replace `fn_def.retries` with `max_retries` in retry-exhaustion checks (L611, L638)
- [ ] Replace `fn_def.ensure` with `ensure_exprs` in the ensure loop (L626)
- [ ] Replace `fn_def.name` with `fn_name` in StepRecord construction

**Test:**
- [ ] `test_inline_step_done_success` — inline step completes, StepRecord has step_mode="inline"
- [ ] `test_inline_step_ensure_failure_retries` — step_retries governs retry count
- [ ] `test_inline_step_retries_exhausted` — terminates after step_retries attempts
- [ ] `test_inline_step_no_retries_exhausts_on_first_fail` — step_retries=None means 1 attempt

---

### Task 5: Update `stratum_step_done` gate-step check in server.py

**File:** `src/stratum_mcp/server.py` (existing), `stratum_step_done` (L86–168)

**What:**

- [ ] Update the gate-step guard (L105–116) to handle inline steps:
  ```python
  _cur = state.ordered_steps[state.current_idx]
  _fn = state.spec.functions.get(_cur.function) if _cur.function else None
  if _fn and _fn.mode == "gate":
      ...
  ```
  Currently `state.spec.functions.get(_cur.function)` returns None for `function=""`, which is safe — but only because `.get("")` returns None. Add `if _cur.function` guard for explicitness.

**Test:**
- [ ] `test_step_done_inline_step_not_rejected_as_gate` — inline step doesn't hit gate guard

---

### Task 6: Full roundtrip integration tests

**File:** `tests/integration/test_inline_steps.py` (new)

**What:** End-to-end tests using the MCP tool functions directly (same pattern as `test_roundtrip.py`).

- [ ] `test_roundtrip_inline_step_single` — plan with inline step, step_done with passing ensure, verify complete
- [ ] `test_roundtrip_inline_step_ensure_retry` — inline step fails ensure, retries, passes on second attempt
- [ ] `test_roundtrip_inline_step_retries_exhausted` — inline step exhausts retries, flow terminates
- [ ] `test_roundtrip_mixed_function_inline` — two-step flow: function step then inline step, both complete
- [ ] `test_roundtrip_inline_step_audit_trace` — audit trace includes agent and step_mode fields
- [ ] `test_roundtrip_inline_step_persistence` — inline step flow survives persist → cache eviction → restore

**Spec fixtures:**
```yaml
# Inline step spec
version: "0.2"
flows:
  main:
    input: {}
    steps:
      - id: s1
        intent: "Do the thing"
        agent: claude
        ensure:
          - "result.done == True"
        retries: 2
```

```yaml
# Mixed function + inline spec
version: "0.2"
contracts:
  Out:
    v: {type: string}
functions:
  work:
    mode: infer
    intent: "Produce output"
    input: {}
    output: Out
flows:
  main:
    input: {}
    steps:
      - id: s1
        function: work
        inputs: {}
      - id: s2
        intent: "Review the output"
        agent: codex
        ensure:
          - "result.ok == True"
        retries: 1
        depends_on: [s1]
```

---

### Task 7: Verify backward compatibility

**What:**
- [ ] Run full existing test suite (`pytest stratum-mcp/tests/`) — all 293 must pass
- [ ] Verify `_VALID_GATE_IR` test fixtures still work
- [ ] Verify v0.1 specs are unaffected
- [ ] Verify persisted flows from before ENG-2 restore correctly (covered by Task 2 test)

---

## Summary

| Task | File(s) | New tests |
|------|---------|-----------|
| 1. `_step_mode` helper | executor.py | 4 |
| 2. StepRecord fields + backward compat | executor.py | 2 |
| 3. `get_current_step_info` restructure | executor.py | 7 |
| 4. `process_step_result` restructure | executor.py | 4 |
| 5. server.py gate guard | server.py | 1 |
| 6. Full roundtrip integration | test_inline_steps.py (new) | 6 |
| 7. Backward compat | — | 0 (existing) |

**Total: 7 tasks, 24 new tests, 2 files modified, 1 file created.**
