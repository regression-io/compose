# STRAT-ENG-3: Implementation Plan

**Date:** 2026-03-07
**Design:** [design.md](./design.md)
**Repo:** `stratum-mcp/` at `/Users/ruze/reg/my/forge/stratum/stratum-mcp/`
**Files:** `src/stratum_mcp/executor.py` (existing), `src/stratum_mcp/server.py` (existing)

## Task Order

Tasks are sequential — each builds on the prior. All changes are in the Stratum repo.

---

### Task 1: Add PolicyRecord dataclass and _record_from_dict support

**File:** `src/stratum_mcp/executor.py` (existing)

**What:**
- [ ] Add `PolicyRecord` dataclass after `SkipRecord` (L305):
  ```python
  @dataclass
  class PolicyRecord:
      """Trace entry written when a gate step is auto-resolved by policy (flag or skip)."""
      step_id: str
      effective_policy: str    # "flag" or "skip"
      resolved_outcome: str    # always "approve"
      rationale: str
      type: str = "policy"     # noqa: A003
      round: int = 0
      round_start_step_id: str | None = None
  ```
- [ ] Update `_record_from_dict` (L308–337) to handle `type == "policy"`:
  ```python
  if rec_type == "policy":
      return PolicyRecord(
          step_id=r["step_id"],
          effective_policy=r["effective_policy"],
          resolved_outcome=r["resolved_outcome"],
          rationale=r["rationale"],
          round=r.get("round", 0),
          round_start_step_id=r.get("round_start_step_id"),
      )
  ```
- [ ] Update the `_record_from_dict` return type annotation to include `PolicyRecord`

**Test:**
- [ ] `test_policy_record_defaults` — type is "policy", round defaults to 0
- [ ] `test_policy_record_from_dict` — round-trip through dict → _record_from_dict
- [ ] `test_policy_record_from_dict_backward_compat` — old persisted flows without policy records still restore

---

### Task 2: Add `apply_gate_policy` function in executor.py

**File:** `src/stratum_mcp/executor.py` (existing)

**What:**
- [ ] Add `apply_gate_policy(state: FlowState, step_id: str) -> dict | None` after `resolve_gate` (~L849):
  ```python
  def apply_gate_policy(
      state: FlowState,
      step_id: str,
  ) -> dict[str, Any] | None:
      """
      Check policy on the current gate step and auto-resolve if flag or skip.

      Returns:
        None              — policy is "gate"; caller should return await_gate as-is
        {"status": ...}   — auto-resolved; dict is complete/execute_step/await_gate
      """
  ```
- [ ] Read step from `state.ordered_steps[state.current_idx]`
- [ ] Verify `step.id == step_id` (defensive)
- [ ] Resolve effective policy: `step.policy or "gate"`
- [ ] If `"gate"` → return None
- [ ] If `"flag"` or `"skip"` → auto-approve:
  - Write PolicyRecord to `state.records`
  - Handle on_approve routing:
    - `on_approve is None` → set `current_idx = len(state.ordered_steps)`, return `{"status": "complete", "flow_id": state.flow_id, ...}` with trace and output
    - `on_approve` names a step → find target index, set `current_idx`, call `get_current_step_info(state)` and return it
  - Do NOT call `resolve_gate()` (avoids GateRecord)

**Test:**
- [ ] `test_apply_gate_policy_gate_returns_none` — policy=gate returns None, no records written
- [ ] `test_apply_gate_policy_skip_auto_approves` — policy=skip writes PolicyRecord, advances to next step
- [ ] `test_apply_gate_policy_flag_auto_approves` — policy=flag writes PolicyRecord with effective_policy="flag"
- [ ] `test_apply_gate_policy_skip_completes_flow` — policy=skip with on_approve=None completes flow
- [ ] `test_apply_gate_policy_no_policy_defaults_gate` — step with no policy field returns None
- [ ] `test_apply_gate_policy_routes_on_approve` — policy=flag with on_approve=target advances to target step

---

### Task 3: Add `skip_step` helper in executor.py

**File:** `src/stratum_mcp/executor.py` (existing)

**What:**
- [ ] Extract skip logic from `get_current_step_info` (L548–557) into a helper:
  ```python
  def skip_step(state: FlowState, step_id: str, reason: str) -> None:
      """Skip the current step: write SkipRecord, set output to None, advance."""
      step = state.ordered_steps[state.current_idx]
      if step.id != step_id:
          raise MCPExecutionError(f"Expected step '{step.id}', got '{step_id}'")
      state.step_outputs[step.id] = None
      state.records.append(SkipRecord(
          step_id=step.id,
          skip_reason=reason,
          round=state.round,
          round_start_step_id=state.round_start_step_id,
      ))
      state.current_idx += 1
  ```
- [ ] Update `get_current_step_info` skip_if path (L548–557) to call `skip_step` instead of inlining
- [ ] Add gate-step guard: raise MCPExecutionError if step is a gate step

**Test:**
- [ ] `test_skip_step_writes_record` — SkipRecord written, output set to None, idx advanced
- [ ] `test_skip_step_wrong_step_id_raises` — mismatched step_id raises MCPExecutionError
- [ ] `test_skip_step_gate_step_raises` — gate step raises MCPExecutionError
- [ ] `test_skip_if_still_works` — existing skip_if behavior unchanged after refactor (regression)

---

### Task 4: Wire policy loop into `stratum_plan` and `stratum_step_done`

**File:** `src/stratum_mcp/server.py` (existing)

**What:**
- [ ] Add a shared helper `_apply_policy_loop(state, step_info)` in server.py to avoid
  duplicating the loop in 3 places:
  ```python
  def _apply_policy_loop(
      state: FlowState,
      step_info: dict[str, Any] | None,
  ) -> dict[str, Any] | None:
      """Apply gate policy in a loop until a non-auto-resolvable state is reached.

      Handles chained flag/skip gates. Bounded by visited-set to prevent
      on_approve routing cycles from hanging.
      """
      visited: set[str] = set()
      while step_info is not None and step_info.get("status") == "await_gate":
          gate_step_id = step_info["step_id"]
          if gate_step_id in visited:
              # Cycle detected — treat as gate (require manual resolution)
              break
          visited.add(gate_step_id)
          policy_result = apply_gate_policy(state, gate_step_id)
          if policy_result is None:
              break  # policy is "gate" — return await_gate to caller
          step_info = policy_result
      return step_info
  ```
- [ ] In `stratum_plan` (L58–80), after `get_current_step_info`:
  ```python
  step_info = get_current_step_info(state)
  step_info = _apply_policy_loop(state, step_info)
  ```
- [ ] In `stratum_step_done` (L156–180), "ok" path after `next_step = get_current_step_info(state)` (L158):
  ```python
  next_step = _apply_policy_loop(state, next_step)
  ```
- [ ] In `stratum_step_done` ensure_failed path (L145–154): no policy loop needed — the current step hasn't changed
- [ ] In `stratum_gate_resolve` (L307): after `next_step = get_current_step_info(state)`:
  ```python
  next_step = _apply_policy_loop(state, next_step)
  ```
- [ ] Handle `step_info` being a complete response from `apply_gate_policy` — if `status == "complete"`, clean up persistence (delete_persisted_flow) before returning
- [ ] Import `apply_gate_policy` from executor

**Test:**
- [ ] `test_plan_gate_policy_skip_returns_next_step` — plan with first step gate+policy:skip returns second step
- [ ] `test_plan_gate_policy_skip_completes_flow` — single gate step with policy:skip and on_approve:~ returns complete
- [ ] `test_plan_gate_policy_gate_returns_await` — policy:gate (or no policy) returns await_gate as before
- [ ] `test_step_done_advances_through_policy_gate` — step_done advancing to a flag gate auto-resolves it
- [ ] `test_policy_loop_cycle_falls_back_to_gate` — on_approve cycle with policy:skip breaks loop, returns await_gate

---

### Task 5: Add `stratum_skip_step` MCP tool

**File:** `src/stratum_mcp/server.py` (existing)

**What:**
- [ ] Add new MCP tool after `stratum_gate_resolve` (~L310):
  ```python
  @mcp.tool(description=(
      "Explicitly skip the current step in a flow. "
      "Inputs: flow_id (str), step_id (str, must be the current step), "
      "reason (str, recorded in audit trail). "
      "Cannot skip gate steps — use stratum_gate_resolve instead. "
      "Returns next step to execute or flow completion."
  ))
  async def stratum_skip_step(
      flow_id: str,
      step_id: str,
      reason: str,
      ctx: Context,
  ) -> dict[str, Any]:
  ```
- [ ] Flow lookup pattern (same as other tools): check `_flows`, try `restore_flow`
- [ ] Call `skip_step(state, step_id, reason)` — catches MCPExecutionError for wrong step / gate step
- [ ] Call `get_current_step_info(state)` for next step
- [ ] Policy loop on result (same pattern as Task 4)
- [ ] If next_step is None → flow complete response (same pattern as stratum_step_done L161–177)
- [ ] Persist and return

**Test:**
- [ ] `test_skip_step_tool_skips_and_advances` — skips current step, returns next step info
- [ ] `test_skip_step_tool_completes_flow` — skipping last step returns complete
- [ ] `test_skip_step_tool_gate_rejected` — gate step returns error
- [ ] `test_skip_step_tool_wrong_step_rejected` — wrong step_id returns error
- [ ] `test_skip_step_tool_flow_not_found` — unknown flow_id returns error

---

### Task 6: Integration tests — full roundtrip

**File:** `tests/integration/test_policy_skip.py` (new)

**What:** End-to-end tests using MCP tool functions directly (same pattern as `test_roundtrip.py`).

- [ ] `test_roundtrip_policy_skip_gate` — gate with policy:skip auto-approves, flow completes
- [ ] `test_roundtrip_policy_flag_gate` — gate with policy:flag auto-approves, PolicyRecord in trace
- [ ] `test_roundtrip_chained_policy_gates` — gate A (skip) → gate B (flag) → step C, both auto-resolve
- [ ] `test_roundtrip_mixed_gate_policy` — gate A (gate) → manual resolve → gate B (skip) → auto-resolve
- [ ] `test_roundtrip_explicit_skip` — stratum_skip_step on non-gate step, SkipRecord in trace
- [ ] `test_roundtrip_policy_record_persistence` — policy gate flow survives persist → restore → audit

**Spec fixtures:**
```yaml
# Single gate with policy — work step then gate
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
  review:
    mode: gate
flows:
  main:
    input: {}
    output: Out
    steps:
      - id: s1
        function: work
        inputs: {}
      - id: gate
        function: review
        policy: skip
        on_approve: ~
        on_revise: s1
        on_kill: ~
        depends_on: [s1]
```

```yaml
# Chained policy gates — work then two gates then more work
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
  gate_a:
    mode: gate
  gate_b:
    mode: gate
flows:
  main:
    input: {}
    output: Out
    steps:
      - id: s1
        function: work
        inputs: {}
      - id: g1
        function: gate_a
        policy: skip
        on_approve: g2
        on_revise: s1
        on_kill: ~
        depends_on: [s1]
      - id: g2
        function: gate_b
        policy: flag
        on_approve: s2
        on_revise: s1
        on_kill: ~
        depends_on: [g1]
      - id: s2
        function: work
        inputs: {}
        depends_on: [g2]
```

---

### Task 7: Verify backward compatibility

**What:**
- [ ] Run full existing test suite (`pytest stratum-mcp/tests/`) — all 321 must pass
- [ ] Verify `_VALID_GATE_IR` test fixtures still work unchanged
- [ ] Verify persisted flows from before ENG-3 restore correctly (covered by Task 1 test)

---

## Summary

| Task | File(s) | New tests |
|------|---------|-----------|
| 1. PolicyRecord + _record_from_dict | executor.py | 3 |
| 2. apply_gate_policy | executor.py | 6 |
| 3. skip_step helper | executor.py | 4 |
| 4. Wire policy loop into server | server.py | 5 |
| 5. stratum_skip_step tool | server.py | 5 |
| 6. Full roundtrip integration | test_policy_skip.py (new) | 6 |
| 7. Backward compat | — | 0 (existing) |

**Total: 7 tasks, 29 new tests, 2 files modified, 1 file created.**
