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

The Python library has `await_human()` — a full HITL gate with typed `HumanDecision[T]`,
pluggable `ReviewSink`, rationale capture. **Not exposed in the MCP layer or `.stratum.yaml` IR.**

---

## Gaps for 10-Phase Human-Gated Workflows

### Gap 1 — No HITL gate in the IR ❌

The `.stratum.yaml` format has no `gate` step type. Human approval cannot be expressed in a spec.
Today gates are handled outside Stratum entirely (the Compose skill handles them in prose).

**What's needed:** A `mode: gate` function type (or a `gate:` step field) that suspends the flow
until an explicit approval call is made. On approve → advance. On revise → revert to designated
step. On kill → terminate.

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

### Gap 4 — No conditional branching ❌

Flows are linear sequences. There is no `if/else` routing based on step output. Gate rejection
(revise vs kill vs approve) requires out-of-band orchestration logic.

**What's needed:** `on_approve` / `on_revise` / `on_kill` routing on gate steps, or a general
`condition:` branch construct in the flow.

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
    on_revise: explore       # revert target if revised (replaces manual stratum_revert)
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
- Add `round` to `StepRecord`

**Part B — Executor (executor.py + server.py):**
- `stratum_step_done` with `outcome: gate_approved | gate_revised | gate_killed` handling
- `stratum_revert` updated to increment round counter
- `stratum_audit` reports round breakdown per step
- New tool: `stratum_gate_resolve(flow_id, step_id, outcome, rationale)` — explicit gate resolution

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
