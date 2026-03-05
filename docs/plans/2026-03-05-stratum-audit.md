# Stratum Audit: Primitives Inventory & Gaps for Compose

**Date:** 2026-03-05
**Status:** COMPLETE
**Purpose:** Determine what Stratum already supports and what needs to be added before Compose's
10-phase human-gated lifecycle can be expressed as a `.stratum.yaml` spec.

---

## What Stratum Has Today

### MCP Tools (what Claude Code can call)

| Tool | What it does |
|---|---|
| `stratum_plan` | Initialise a flow, return first step with resolved inputs |
| `stratum_step_done` | Report step complete, check ensures + schema, advance or retry |
| `stratum_audit` | Query trace for any flow (survives MCP restart) |
| `stratum_commit` | Snapshot flow state under a named label |
| `stratum_revert` | Roll back to a named checkpoint |
| `stratum_validate` | Offline YAML parse + schema check |
| `stratum_compile_speckit` | Compile task `.md` files → `.stratum.yaml` |
| `stratum_draft_pipeline` | Write pipeline draft for UI |

### IR Format (`.stratum.yaml` v0.1)

- `functions`: `mode: infer | compute`, `intent`, `input`, `output`, `ensure[]`, `retries`, `budget`
- `flows`: `steps[]` with `id`, `function`, `inputs` (`$` references), `depends_on`, `output_schema`
- `contracts`: named JSON Schema shapes
- `ensure` expressions: Python expressions with `result` variable, `file_exists()`, `file_contains()`, `len()`, `bool()`, `int()`, `str()`
- Topological sort enforces step ordering; no cycles

### Checkpoint / Rollback

`stratum_commit` + `stratum_revert` implement stateful rollback — deep copy of flow state at any
point, restorable later. This is the closest thing to "revise" today.

### Python Library (not MCP-accessible)

The Python library has `await_human()` — a gate primitive with typed `HumanDecision[T]`,
pluggable `ReviewSink`, rationale capture. The resolver could be human or agent; the type is
recorded but execution semantics are the same. **Not exposed in the MCP layer or `.stratum.yaml` IR.**

---

## Gaps for 10-Phase Human-Gated Workflows

### Gap 1 — No gate step type in the IR ❌

The `.stratum.yaml` format has no `gate` step type. Approval cannot be expressed in a spec —
whether the resolver is a human, an agent (e.g. clean review result), or a system condition.
Today gates are handled outside Stratum entirely (the Compose skill handles them in prose).

**What's needed:** A `mode: gate` function type that suspends the flow until an explicit
`stratum_gate_resolve` call is made. Resolver identity (`human | agent | system`) is recorded
in the trace but does not affect execution semantics. On approve → advance. On revise → roll back
to designated step with round counter incremented. On kill → route to terminal step.

### Gap 2 — No skip mechanism ❌

No way to mark a step as intentionally bypassed with a recorded reason. The skip event simply
doesn't appear in the trace.

**What's needed:** A `skip_if` condition or an explicit `stratum_skip_step` tool call that records
the skip reason in the audit trace.

### Gap 3 — No round tracking ❌

`attempts` tracks retries within a single step execution. If the flow reverts to a prior step via
`stratum_revert`, there is no global round counter — no way to know "this is the third time we've
run phase 4."

**What's needed:** A `round` field in `StepRecord`, incremented on each revert cycle. Flow-level
`max_rounds` to cap revision loops.

### Gap 4 — No conditional runtime branching ❌

Stratum already supports DAG execution ordering via `depends_on` and topological sort — flows are
not strictly linear. The true gap is *conditional runtime branching*: there is no way to route to
a different step based on the *output* of a prior step at runtime. Gate resolution
(approve/revise/kill) requires out-of-band orchestration logic because the IR has no
`on_approve`/`on_revise`/`on_kill` routing.

**What's needed:** Conditional routing on gate steps — `on_approve`, `on_revise`, `on_kill` —
so the flow can declaratively express "if revised, go back to step X; if killed, go to terminal."

---

## Recommended IR v0.2 Additions

These are the minimum additions to make Compose expressible as a pure Stratum spec:

```yaml
# 1. Gate step type
functions:
  approval_gate:
    mode: gate              # new mode — suspends until explicit resolution
    output: GateDecision    # { outcome: approve|revise|kill, rationale: string }
    timeout: 3600           # optional: auto-kill after N seconds

# 2. Gate routing on steps
steps:
  - id: design_gate
    function: approval_gate
    on_approve: prd          # next step if approved
    on_revise: explore       # roll back to this step id if revised
                             # rollback semantics: step_outputs, attempts, and trace entries
                             # for all steps from on_revise target onward are cleared;
                             # round counter increments; execution resumes from target step
    on_kill: killed          # terminal step if killed

# 3. Skip
steps:
  - id: prd
    function: write_prd
    skip_if: "$.input.skip_prd == true"
    skip_reason: "PRD not required for internal features"

# 4. Round tracking (flow-level)
flows:
  compose_feature:
    max_rounds: 10           # abort if revised more than 10 times
    steps: [...]
    # StepRecord gains: round, round_start_step_id
```

---

## What This Means for the Stratum Refactor

The refactor has two parts:

**Part A — IR v0.2 (schema + spec.py):**
- Add `mode: gate` to function modes
- Add `on_approve`, `on_revise`, `on_kill` to step schema
- Add `skip_if` / `skip_reason` to step schema
- Add `max_rounds` to flow schema
- Add `round` and `round_start_step_id` to `StepRecord`
- Add `rounds[]` archive to flow state (keyed by round index; holds archived trace entries per round)

**Part B — Executor (executor.py + server.py):**
- New tool: `stratum_gate_resolve(flow_id, step_id, outcome, rationale, resolved_by)` — the single
  canonical path for gate completion. `stratum_step_done` is NOT extended with gate outcomes;
  gate steps are resolved exclusively via `stratum_gate_resolve` to keep the two APIs distinct
  (step_done = agent reports work output; gate_resolve = any resolver approves/revises/kills)
- On `outcome: revise` — executor archives trace entries for all steps from `on_revise` target
  onward into `flow.rounds[flow.round]` before clearing active state (`step_outputs`, `attempts`,
  active trace entries); increments `flow.round`; returns next step info for target. Archiving
  before clearing is required — `stratum_audit` must be able to report per-round breakdown without
  losing prior-round execution history
- On `outcome: kill` — executor routes to `on_kill` terminal step; flow ends
- `stratum_audit` reports per-step breakdown by round
- `resolved_by`: `human | agent | system` — recorded in trace, no behavioural difference

---

## What Compose Gets After the Refactor

The full 10-phase lifecycle expressed as a single `.stratum.yaml`:

```yaml
flows:
  compose_feature:
    max_rounds: 10
    steps:
      - id: explore        # Phase 1: explore & design
        function: explore_design
      - id: design_gate
        function: approval_gate
        on_approve: prd
        on_revise: explore
        on_kill: killed

      - id: prd            # Phase 2: PRD (skippable)
        function: write_prd
        skip_if: "$.input.skip_prd == true"
      - id: prd_gate
        function: approval_gate
        on_approve: architecture
        on_revise: prd
        on_kill: killed

      # ... phases 3–10 follow same pattern
```

No bespoke lifecycle engine in Compose. Phase state lives in Stratum's flow state.
`phase-state.json` and `currentPhase` on Vision items are read from Stratum flow state,
not written by a separate Compose engine.

---

## Files Referenced

| File | Relevance |
|---|---|
| `stratum-mcp/src/stratum_mcp/spec.py` | IR schema — add v0.2 fields here |
| `stratum-mcp/src/stratum_mcp/executor.py` | Step execution — add gate handling, round tracking |
| `stratum-mcp/src/stratum_mcp/server.py` | MCP tools — add `stratum_gate_resolve` |
| `stratum/src/stratum/hitl.py` | Reference implementation for gate semantics |
| `stratum/SPEC.md` | Full specification |
| `stratum/ROADMAP.md` | Check if v0.2 is already planned |
