# STRAT-ENG-3: Executor — Gates, Policy, Skip

**Date:** 2026-03-07
**Status:** Complete
**Related:** [STRAT-1 design](../STRAT-1/design.md), [STRAT-ENG-2 design](../STRAT-ENG-2/design.md)
**Repo:** `stratum-mcp/` at `/Users/ruze/reg/my/forge/stratum/stratum-mcp/`

## Problem

The STRAT-1 design scopes ENG-3 as "gates, policy, skip." But most of this is already implemented:

| Primitive | Status | Where |
|---|---|---|
| Gate resolution (`resolve_gate`) | COMPLETE | executor.py:724–849 |
| `stratum_gate_resolve` MCP tool | COMPLETE | server.py:234 |
| `stratum_check_timeouts` MCP tool | COMPLETE | server.py:321 |
| GateRecord + audit | COMPLETE | executor.py:280–290 |
| on_approve/on_revise/on_kill routing | COMPLETE | executor.py:785–848 |
| skip_if evaluation (`evaluate_skip_if`) | COMPLETE | executor.py:183–214 |
| SkipRecord + skip_if in get_current_step_info | COMPLETE | executor.py:544–557 |
| Rounds (round tracking, max_rounds, rounds[] archive) | COMPLETE | executor.py:803–848 |
| `policy`/`policy_fallback` fields on IRStepDef | COMPLETE (parsed, validated) | spec.py:80–82 |

**What's NOT implemented:**

1. **Policy evaluation** — `policy` and `policy_fallback` are parsed and validated but never read by the executor. Every gate step always returns `await_gate`, regardless of policy setting.
2. **`stratum_skip_step` MCP tool** — explicit step skipping by the caller (vs conditional skip_if).

## Scope

Two features, both small:

### 1. Policy evaluation on gate steps

**Reference:** Compose's `policy-engine.js` — 33 lines, stateless three-level fallback.

When a gate step is reached, evaluate the effective policy to decide whether to
suspend for external resolution or auto-approve:

```
effective_policy = step.policy ?? "gate"
```

Three behaviors:

| Policy | Behavior |
|---|---|
| `gate` (default) | Suspend for external resolution (current behavior) — returns `await_gate` |
| `flag` | Auto-approve, record PolicyRecord in audit trail, advance to next step |
| `skip` | Auto-approve, record PolicyRecord in audit trail, advance to next step |

`flag` and `skip` differ only in intent signaling — `flag` means "proceed but this
decision should be reviewed," `skip` means "this gate is not relevant." Both write a
PolicyRecord. Neither writes a GateRecord.

#### policy_fallback is infrastructure for ENG-6

The validator requires `policy` when `policy_fallback` is set, so under current rules
`policy_fallback` is never the first non-None value. It exists as infrastructure for
ENG-6's `stratum_set_policy` runtime override mechanism. The intended resolution after
ENG-6:

```
runtime_override ?? step.policy ?? step.policy_fallback ?? "gate"
```

For ENG-3, `policy_fallback` is parsed and validated but not evaluated. The resolution
is simply `step.policy ?? "gate"`.

#### PolicyRecord — new audit trace entry

```python
@dataclass
class PolicyRecord:
    step_id: str
    effective_policy: str        # "flag" or "skip"
    resolved_outcome: str        # always "approve" for auto-resolution
    rationale: str               # "policy: flag — auto-approved" or similar
    round: int
    round_start_step_id: str | None
```

#### Gate routing on auto-approve

When policy is `flag` or `skip`, the gate is auto-approved with `on_approve` routing:
- If `on_approve` names a step → advance to that step
- If `on_approve` is None → flow completes

This routing logic is implemented directly in the policy evaluation function — it does
NOT call `resolve_gate()`. Reason: `resolve_gate` always appends a GateRecord, which
would either double-log (PolicyRecord + GateRecord for flag) or contradict the "no
GateRecord" contract for skip. The on_approve routing is simple enough to inline:
advance `current_idx` to the target step (or to end-of-flow for null on_approve).

#### Where it plugs in — server layer, not get_current_step_info

Policy evaluation happens in the **server layer** (`stratum_plan` and
`stratum_step_done`), not inside `get_current_step_info`.

**Why not in get_current_step_info?** If policy auto-resolution happened inside that
helper and the first step was a gate with `policy: skip` and `on_approve: ~`, the helper
would complete the flow and return None. `stratum_plan` (server.py:80) has an invariant:
`return step_info  # always non-None: schema enforces minItems: 1`. Breaking this
invariant would make plan creation return an invalid empty response for a valid flow.

**Implementation pattern:** A new `apply_gate_policy(state) -> dict | None` function
in executor.py. The server calls it in a loop after `get_current_step_info` returns
`await_gate`, handling chained auto-approved gates:

```python
# In stratum_plan (server.py) and stratum_step_done:
step_info = get_current_step_info(state)
while step_info is not None and step_info["status"] == "await_gate":
    policy_result = apply_gate_policy(state, step_info["step_id"])
    if policy_result is None:
        break  # policy is "gate" — return await_gate to caller
    step_info = policy_result  # auto-resolved; loop to handle chained gates
```

**Why a loop?** Gate A with `policy: skip` and `on_approve: gate_B` auto-approves into
gate B. If gate B also has `policy: flag`, a single-shot check would incorrectly return
`await_gate` for B. The loop continues applying policy until it hits a `gate`-policy
step (needs human resolution), a non-gate step (`execute_step`), or flow completion
(`complete`).

`apply_gate_policy` returns:
- `None` if policy is `gate` (caller breaks the loop, returns `await_gate` as-is)
- `{"status": "complete", ...}` if auto-approved and flow is done (loop exits naturally)
- Next step info from `get_current_step_info(state)` if auto-approved and flow continues
  (may be `execute_step` or another `await_gate` — loop handles it)

The loop uses a visited-set of gate step IDs to detect on_approve routing cycles.
If a gate is visited twice, the loop breaks and returns `await_gate` — falling back
to manual resolution. This prevents hanging on specs where gate A approves to gate B
which approves back to gate A (both with `policy: skip`). The loop is also bounded by
the number of steps in the flow.

### 2. `stratum_skip_step` MCP tool

Lets the caller explicitly skip the current step with a reason. Unlike `skip_if`
(conditional, evaluated automatically), this is an imperative action.

```
stratum_skip_step(flow_id, step_id, reason) → next step info or flow complete
```

**Constraints:**
- Can only skip the current step (step_id must match)
- Cannot skip gate steps (gates must be resolved via `stratum_gate_resolve`)
- Records a SkipRecord (same as skip_if)
- Advances to next step and returns its info (or flow complete)

**Where it plugs in:** New MCP tool in server.py. The skip logic (write SkipRecord,
set output to None, advance current_idx) is extracted from `get_current_step_info`
(L548–557) into a shared helper `skip_step(state, step_id, reason)` in executor.py.

## What does NOT change

- `resolve_gate` function — unchanged, NOT called for policy auto-approve
- `stratum_gate_resolve` MCP tool — unchanged, still used for `policy: gate` steps
- `stratum_check_timeouts` — unchanged
- `evaluate_skip_if` — unchanged
- `get_current_step_info` — unchanged (still returns `await_gate` for all gate steps)
- Round tracking — unchanged
- All existing gate/skip tests — must continue passing

## IR impact

None. All fields (`policy`, `policy_fallback`, `skip_if`, `skip_reason`) already exist
on IRStepDef and are parsed/validated by the v0.2 schema. No schema changes needed.

## Test strategy

Unit tests for policy resolution logic, integration tests for the full MCP roundtrip.
~15 new tests total.
