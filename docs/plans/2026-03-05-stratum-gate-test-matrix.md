# Stratum Gate — Acceptance Test Matrix

**Date:** 2026-03-05
**Status:** DRAFT

Each scenario specifies: flow spec, event sequence, expected response, and expected `stratum_audit` output.
Scenarios are ordered from simplest (golden path) to key failures and edge cases.

**Related:**
- `docs/plans/2026-03-05-stratum-ir-v0.2-spec.md` — field and error contracts
- `docs/plans/2026-03-05-stratum-gate-transitions.md` — transition table
- Tests will be written in `stratum-mcp/tests/` once these scenarios are agreed.

---

## Shared Flow Specs

### `GATED_FLOW` — single gate, revise loops back to work

```yaml
version: "0.2"
contracts:
  WorkOutput:
    result: {type: string}
flows:
  gated_flow:
    max_rounds: 5
    input: {text: {type: string}}
    steps:
      - id: work
        function: do_work
        inputs: {text: "$.input.text"}
      - id: gate
        function: approval_gate
        on_approve: ~
        on_revise: work
        on_kill: ~
functions:
  do_work:
    mode: infer
    intent: "Produce a result"
    input: {text: {type: string}}
    output: WorkOutput
  approval_gate:
    mode: gate
```

### `SKIP_FLOW` — optional step before gate

```yaml
version: "0.2"
contracts:
  WorkOutput:
    result: {type: string}
functions:
  do_work:
    mode: infer
    intent: "Produce a result"
    input: {text: {type: string}}
    output: WorkOutput
  approval_gate:
    mode: gate
flows:
  skip_flow:
    input: {text: {type: string}, skip: {type: boolean}}
    steps:
      - id: optional_work
        function: do_work
        inputs: {text: "$.input.text"}
        skip_if: "$.input.skip == True"
        skip_reason: "Caller opted out of optional_work"
      - id: gate
        function: approval_gate
        on_approve: ~
        on_revise: optional_work
        on_kill: ~
```

### `TWO_GATE_FLOW` — sequential gates, first can revise, second completes

```yaml
version: "0.2"
contracts:
  WorkOutput:
    result: {type: string}
functions:
  do_work:
    mode: infer
    intent: "Produce a result"
    input: {text: {type: string}}
    output: WorkOutput
  approval_gate:
    mode: gate
flows:
  two_gate_flow:
    max_rounds: 5
    input: {text: {type: string}}
    steps:
      - id: work
        function: do_work
        inputs: {text: "$.input.text"}
      - id: gate1
        function: approval_gate
        on_approve: work2
        on_revise: work
        on_kill: ~
      - id: work2
        function: do_work
        inputs: {text: "$.input.text"}
      - id: gate2
        function: approval_gate
        on_approve: ~
        on_revise: work2
        on_kill: ~
```

---

## Scenario 1 — Single gate, approved on first attempt

**Flow:** `GATED_FLOW`
**Input:** `{text: "hello"}`

| # | Call | Args |
|---|---|---|
| 1 | `stratum_plan` | `GATED_FLOW`, `gated_flow`, `{text: "hello"}` |
| 2 | `stratum_step_done` | `flow_id`, `"work"`, `{result: "done"}` |
| 3 | `stratum_gate_resolve` | `flow_id`, `"gate"`, `approve`, `"looks good"`, `human` |

**Event 3 response:**
```json
{"status": "complete", "flow_id": "<id>"}
```

**`stratum_audit` output:**
```json
{
  "status": "complete",
  "round": 0,
  "rounds": [],
  "trace": [
    {"step_id": "work",  "type": "step", "round": 0, "round_start_step_id": null, "attempts": 1},
    {"step_id": "gate",  "type": "gate", "round": 0, "round_start_step_id": null,
     "outcome": "approve", "rationale": "looks good", "resolved_by": "human"}
  ]
}
```

**Pass criteria:** `status=complete`, `rounds=[]`, trace has 2 entries, `round=0` on both.

---

## Scenario 2 — Gate revised once, then approved

**Flow:** `GATED_FLOW`

| # | Call | Args |
|---|---|---|
| 1 | `stratum_plan` | `GATED_FLOW`, `gated_flow`, `{text: "hello"}` |
| 2 | `stratum_step_done` | `flow_id`, `"work"`, `{result: "v1"}` — round 0 |
| 3 | `stratum_gate_resolve` | `flow_id`, `"gate"`, `revise`, `"needs rework"`, `human` |
| 4 | `stratum_step_done` | `flow_id`, `"work"`, `{result: "v2"}` — round 1 |
| 5 | `stratum_gate_resolve` | `flow_id`, `"gate"`, `approve`, `"looks good"`, `human` |

**Event 3 response:**
```json
{"status": "execute_step", "step_id": "work", "round": 1}
```

**`stratum_audit` after event 5:**
```json
{
  "status": "complete",
  "round": 1,
  "rounds": [
    {
      "round": 0,
      "steps": [
        {"step_id": "work", "type": "step",  "round": 0, "round_start_step_id": null, "attempts": 1},
        {"step_id": "gate", "type": "gate",  "round": 0, "round_start_step_id": null,
         "outcome": "revise", "rationale": "needs rework", "resolved_by": "human"}
      ]
    }
  ],
  "trace": [
    {"step_id": "work", "type": "step", "round": 1, "round_start_step_id": "work", "attempts": 1},
    {"step_id": "gate", "type": "gate", "round": 1, "round_start_step_id": "work",
     "outcome": "approve", "rationale": "looks good", "resolved_by": "human"}
  ]
}
```

**Pass criteria:**
- `rounds[0]` preserved with 2 entries (work + revise gate).
- Active `trace` shows round 1 entries only.
- `round_start_step_id: "work"` on all round-1 records.
- Full history = `rounds[0].steps + trace` = 4 entries total.

---

## Scenario 3 — max_rounds exceeded on second revise

**Flow:** `GATED_FLOW` with `max_rounds: 1`

| # | Call | Args |
|---|---|---|
| 1 | `stratum_plan` | `GATED_FLOW (max_rounds:1)`, `gated_flow`, `{text: "hello"}` |
| 2 | `stratum_step_done` | `flow_id`, `"work"`, `{result: "v1"}` |
| 3 | `stratum_gate_resolve` | `flow_id`, `"gate"`, `revise`, `"redo"`, `human` — round 0→1, **allowed** |
| 4 | `stratum_step_done` | `flow_id`, `"work"`, `{result: "v2"}` |
| 5 | `stratum_gate_resolve` | `flow_id`, `"gate"`, `revise`, `"still wrong"`, `human` — **rejected** |

**Event 5 response:**
```json
{
  "status": "error",
  "code": "max_rounds_exceeded",
  "message": "flow 'gated_flow' has reached max_rounds (1). Kill the flow or increase max_rounds."
}
```

**State after event 5:**
- `state.round` = 1 (unchanged — no increment on abort)
- `state.rounds[0]` intact (event 3 archive present)
- `state.step_outputs["work"]` = `{result: "v2"}` (not cleared)
- Active `state.records` has work (round 1) + the new GateRecord from event 5 attempt

**Pass criteria:**
- Error returned; flow state not rolled back; `rounds[0]` still accessible.
- `stratum_audit` still callable; shows round 0 archive + active round 1 records: the work StepRecord and the failed-attempt GateRecord (both remain in `state.records` since the abort fired before archiving).

---

## Scenario 4 — Gate killed (null on_kill)

**Flow:** `GATED_FLOW`

| # | Call | Args |
|---|---|---|
| 1 | `stratum_plan` | `GATED_FLOW`, `gated_flow`, `{text: "hello"}` |
| 2 | `stratum_step_done` | `flow_id`, `"work"`, `{result: "done"}` |
| 3 | `stratum_gate_resolve` | `flow_id`, `"gate"`, `kill`, `"not viable"`, `human` |

**Event 3 response:**
```json
{
  "status": "killed",
  "flow_id": "<id>",
  "step_id": "gate",
  "rationale": "not viable",
  "resolved_by": "human",
  "trace": [
    {"step_id": "work", "type": "step", "round": 0},
    {"step_id": "gate", "type": "gate", "round": 0, "outcome": "kill"}
  ]
}
```

**`stratum_audit` output:**
```json
{
  "status": "killed",
  "round": 0,
  "rounds": [],
  "trace": [
    {"step_id": "work", "type": "step",  "round": 0, "attempts": 1},
    {"step_id": "gate", "type": "gate",  "round": 0, "outcome": "kill",
     "rationale": "not viable", "resolved_by": "human"}
  ]
}
```

**Pass criteria:** `status=killed`, `rounds=[]`, trace complete with kill gate record.

---

## Scenario 5 — Skip preceding step, gate still reachable

**Flow:** `SKIP_FLOW`
**Input:** `{text: "hello", skip: true}`

| # | Call | Args |
|---|---|---|
| 1 | `stratum_plan` | `SKIP_FLOW`, `skip_flow`, `{text: "hello", skip: true}` |
| 2 | `stratum_gate_resolve` | `flow_id`, `"gate"`, `approve`, `"ok"`, `human` |

Note: `stratum_plan` fires `skip_if` for `optional_work` and advances `current_idx` to `gate`. The caller receives `gate` as the first step to act on.

**`stratum_audit` after event 2:**
```json
{
  "status": "complete",
  "round": 0,
  "rounds": [],
  "trace": [
    {"step_id": "optional_work", "type": "skip", "skip_reason": "Caller opted out of optional_work", "round": 0},
    {"step_id": "gate", "type": "gate", "round": 0, "outcome": "approve", "resolved_by": "human"}
  ]
}
```

**Pass criteria:** Skip entry appears in trace with `type: "skip"`; gate reachable without executing optional_work; flow completes.

---

## Scenario 6 — `stratum_step_done` rejected on gate step

**Flow:** `GATED_FLOW`

| # | Call | Args |
|---|---|---|
| 1 | `stratum_plan` | … |
| 2 | `stratum_step_done` | `flow_id`, `"work"`, `{result: "done"}` |
| 3 | `stratum_step_done` | `flow_id`, `"gate"`, `{outcome: "approve"}` ← **wrong API** |

**Event 3 response:**
```json
{
  "status": "error",
  "code": "gate_step_requires_gate_resolve",
  "message": "step 'gate' has mode: gate. Use stratum_gate_resolve to resolve gate steps."
}
```

**State after event 3:**
- `state.attempts["gate"]` = 0 (no increment)
- `state.records` contains only the work StepRecord (no gate record written)
- `state.current_idx` still points to gate

**Pass criteria:** Error returned; `stratum_audit` shows only work step in trace; gate still pending.

---

## Scenario 7 — `stratum_gate_resolve` rejected on infer step

**Flow:** `GATED_FLOW`

| # | Call | Args |
|---|---|---|
| 1 | `stratum_plan` | … |
| 2 | `stratum_gate_resolve` | `flow_id`, `"work"`, `approve`, `"wrong"`, `human` ← **wrong API** |

**Event 2 response:**
```json
{
  "status": "error",
  "code": "not_a_gate_step",
  "message": "step 'work' has mode: infer. stratum_gate_resolve only resolves gate steps."
}
```

**State after event 2:** unchanged. `work` still pending.

**Pass criteria:** Error returned; flow state unchanged; `stratum_step_done` still usable to complete work.

---

## Scenario 8 — `resolved_by` variants; execution identical, recording differs

**Flow:** `GATED_FLOW`
**Test:** Run scenario 1 three times with `resolved_by` = `human`, `agent`, `system`.

For each run:

**Pass criteria:**
- Response `status=complete` for all three.
- `trace[1].resolved_by` matches the input value.
- `trace[0]` (work step) and `trace[1]` (gate approve) are otherwise identical across runs.
- No behavioral difference between resolver types.

---

## Scenario 9 — Two gates in sequence; first revised, second approved

**Flow:** `TWO_GATE_FLOW`

| # | Call | Args |
|---|---|---|
| 1 | `stratum_plan` | … |
| 2 | `stratum_step_done` | `flow_id`, `"work"`, `{result: "v1"}` — round 0 |
| 3 | `stratum_gate_resolve` | `flow_id`, `"gate1"`, `revise`, `"redo"`, `human` |
| 4 | `stratum_step_done` | `flow_id`, `"work"`, `{result: "v2"}` — round 1 |
| 5 | `stratum_gate_resolve` | `flow_id`, `"gate1"`, `approve`, `"ok"`, `human` |
| 6 | `stratum_step_done` | `flow_id`, `"work2"`, `{result: "done"}` |
| 7 | `stratum_gate_resolve` | `flow_id`, `"gate2"`, `approve`, `"done"`, `human` |

**`stratum_audit` after event 7:**
```json
{
  "status": "complete",
  "round": 1,
  "rounds": [
    {
      "round": 0,
      "steps": [
        {"step_id": "work",  "type": "step", "round": 0, "round_start_step_id": null},
        {"step_id": "gate1", "type": "gate", "round": 0, "round_start_step_id": null,
         "outcome": "revise"}
      ]
    }
  ],
  "trace": [
    {"step_id": "work",  "type": "step", "round": 1, "round_start_step_id": "work"},
    {"step_id": "gate1", "type": "gate", "round": 1, "round_start_step_id": "work",  "outcome": "approve"},
    {"step_id": "work2", "type": "step", "round": 1, "round_start_step_id": "work"},
    {"step_id": "gate2", "type": "gate", "round": 1, "round_start_step_id": "work",  "outcome": "approve"}
  ]
}
```

**Pass criteria:**
- `rounds[0]` has 2 entries (work + gate1 revise).
- Active trace has 4 entries, all `round: 1`.
- `round_start_step_id: "work"` on all round-1 records (gate2 shares the same round as gate1-approve).
- Total entries across history: 2 archived + 4 active = 6.

---

## Scenario 10 — Revise archive is immutable across multiple revises

**Flow:** `GATED_FLOW` with `max_rounds: 5`

| # | Call | Args |
|---|---|---|
| 1–3 | Revise 1 (round 0→1) | same pattern as scenario 2 events 1–3 |
| 4–6 | Revise 2 (round 1→2) | work again, gate, revise |
| 7–8 | Approve (round 2) | work, gate approve |

**Pass criteria after event 8:**
- `state.rounds[0]` contains round-0 records (work + revise gate) — **unchanged** since round 1.
- `state.rounds[1]` contains round-1 records (work + revise gate).
- Active trace contains round-2 records (work + approve gate).
- `state.round == 2`.
- Full history = 2 + 2 + 2 = 6 entries.
- Modifying round 1 state does not affect `rounds[0]` (archive independence).
