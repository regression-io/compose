# STRAT-ENG-1: IR v0.2 Schema

**Date:** 2026-03-07
**Status:** Design
**Parent:** [STRAT-1 Design](../STRAT-1/design.md)
**Repo:** stratum-mcp (`/Users/ruze/reg/my/forge/stratum/stratum-mcp/`)

## Problem

Stratum's IR can express sequential step execution with ensure postconditions, but cannot express:
- Which agent runs a step (always implicit — the caller)
- Steps with inline intent (must define a separate `function:` block)
- Non-gate routing (`on_fail`, `next` for cross-agent loops)
- Sub-workflow invocation (`flow:` composition)
- Policy enforcement (gate/flag/skip dials)
- Self-registering workflows (specs as named, discoverable commands)

These are all required for Compose to express its lifecycle as a Stratum spec.

## Scope

**Schema and validation only.** This feature adds fields to the IR dataclasses, extends the JSON schema, and adds semantic validation rules. It does NOT implement executor logic — that's STRAT-ENG-2 through STRAT-ENG-5.

One exception: `stratum_list_workflows` is a new MCP tool (read-only, no executor changes).

## Current State

**File:** `src/stratum_mcp/spec.py`

Existing IR dataclasses (line numbers from current code):
- `IRBudgetDef` (L25–27)
- `IRContractDef` (L31–33)
- `IRFunctionDef` (L37–50) — has `mode: gate`, `timeout`
- `IRStepDef` (L54–69) — has `on_approve/revise/kill`, `skip_if/skip_reason`
- `IRFlowDef` (L73–80) — has `max_rounds`
- `IRSpec` (L84–88) — top-level: `version`, `contracts`, `functions`, `flows`

v0.2 JSON schema (L177–268) already supports gates, skip, rounds. Semantic validation (L411–535) enforces gate constraints.

**What already exists and stays unchanged:**
- `mode: gate` on functions, `timeout`
- `on_approve`, `on_revise`, `on_kill` on gate steps
- `skip_if`, `skip_reason` on steps
- `max_rounds` on flows
- `round` on StepRecord/GateRecord/SkipRecord
- All existing gate semantic validation

## Changes

### 1. Workflow declaration — new `IRWorkflowDef` dataclass

```python
@dataclass(frozen=True)
class IRWorkflowDef:
    name: str                           # CLI command name
    description: str                    # shown in help/list
    input_schema: dict[str, Any]        # typed input with defaults
```

Added to `IRSpec`:
```python
@dataclass(frozen=True)
class IRSpec:
    version: str
    contracts: dict[str, IRContractDef]
    functions: dict[str, IRFunctionDef]
    flows: dict[str, IRFlowDef]
    workflow: IRWorkflowDef | None       # new — None for internal specs
```

**JSON schema addition:**
```yaml
workflow:
  type: object
  required: [name, description, input]
  properties:
    name: { type: string, pattern: "^[a-z][a-z0-9-]*$" }
    description: { type: string, minLength: 1 }
    input:
      type: object
      additionalProperties:
        type: object
        properties:
          type: { type: string, enum: [string, boolean, integer, number, array, object] }
          required: { type: boolean, default: true }
          default: {}
```

**Semantic validation:**
- `workflow.name` must be unique across registry (checked at discovery time, not parse time)
- If `workflow:` is present, spec must designate one entry flow (the flow whose name matches `workflow.name` or is the only top-level flow). Additional flows are allowed — they serve as sub-workflows for `flow:` composition.
- `workflow.input` field names must match the entry flow's `input_schema` keys

### 2. `agent` field on steps

```python
@dataclass(frozen=True)
class IRStepDef:
    # ... existing fields ...
    agent: str | None = None            # new — which agent executes
```

**JSON schema:** `agent: { type: string }` (nullable, optional)

**Semantic validation:**
- No validation on agent values — Compose (the caller) maps agent names to connectors
- Gate steps may have `agent: null` (gates are resolved by humans/systems, not agents)

### 3. `intent` on steps (inline steps)

Inline steps carry their own execution metadata — the fields that normally live on `IRFunctionDef`. This lets a step be self-contained without a separate `function:` block.

```python
@dataclass(frozen=True)
class IRStepDef:
    # ... existing fields ...
    function: str = ""                  # change: now optional (empty = inline)
    intent: str | None = None           # new — inline intent (prompt)
    ensure: list[str] | None = None     # new — postconditions (from IRFunctionDef)
    retries: int | None = None          # new — max retries on ensure failure
    output_contract: str | None = None  # new — contract name for output validation
    model: str | None = None            # new — model override
    budget: IRBudgetDef | None = None   # new — cost/time budget
```

**JSON schema:** Make `function` optional on steps. Add `intent`, `ensure`, `retries`, `output_contract`, `model`, `budget` as optional step-level fields.

**Semantic validation:**
- Step must have exactly one of `function`, `intent`, or `flow` — not multiple, not none
- If `function`: existing validation (function must exist in `functions:` block). Step-level `ensure`/`retries`/`output_contract`/`model`/`budget` must NOT be set (they come from the function).
- If `intent`: step is self-contained. `ensure`, `retries`, `output_contract`, `model`, `budget` are all valid at step level.
- If `flow`: see section 5. Step-level `ensure` is valid (checked against sub-flow output). Other execution fields (`retries`, `model`, `budget`) must NOT be set.
- Gate steps (`mode: gate` via function) cannot use inline `intent`

### 4. `on_fail` and `next` on non-gate steps

```python
@dataclass(frozen=True)
class IRStepDef:
    # ... existing fields ...
    on_fail: str | None = None          # new — route to step on ensure failure
    next: str | None = None             # new — explicit next step (loop-back)
```

**JSON schema:** `on_fail: { type: string }`, `next: { type: string }` (both nullable, optional)

**Semantic validation:**
- `on_fail` and `next` targets must be valid step IDs in the same flow
- `on_fail` only valid on non-gate steps (gate steps use `on_revise`)
- `next` only valid on non-gate steps
- `on_fail` and `next` may reference steps earlier in the DAG (loop-back allowed)
- A step with `on_fail` should have `ensure` (otherwise `on_fail` never triggers)
- Warn (not error) if `on_fail` target equals self (infinite loop risk)

### 5. `flow:` reference on steps

```python
@dataclass(frozen=True)
class IRStepDef:
    # ... existing fields ...
    flow_ref: str | None = None         # new — invoke sub-workflow
```

**JSON schema:** `flow: { type: string }` (maps to `flow_ref` in dataclass to avoid Python keyword collision)

**Semantic validation:**
- Step must have exactly one of: `function`, `intent`, or `flow` (mutually exclusive)
- `flow_ref` must reference a flow defined in `flows:` (not self-referencing)
- `flow_ref` steps may have `inputs` (mapped to sub-flow's input schema)
- `flow_ref` steps may have `ensure` (checked against sub-flow output)
- `flow_ref` steps must not have `agent` (the sub-flow's steps define their own agents)
- No recursive flow references (direct or indirect — check at validation time)

### 6. `policy` and `policy_fallback` on steps

```python
@dataclass(frozen=True)
class IRStepDef:
    # ... existing fields ...
    policy: str | None = None           # new — gate | flag | skip
    policy_fallback: str | None = None  # new — default if no runtime override
```

**JSON schema:**
```yaml
policy: { type: string, enum: [gate, flag, skip] }
policy_fallback: { type: string, enum: [gate, flag, skip] }
```

**Semantic validation:**
- `policy` only valid on gate steps (it governs how strictly the gate is enforced)
- `policy_fallback` only valid if `policy` is set
- If `policy: skip`, the gate step is effectively skipped at runtime (executor concern)
- If `policy: flag`, the gate step proceeds but records the decision (executor concern)

### 7. `stratum_list_workflows` MCP tool

New read-only tool in `server.py`:

```python
@mcp.tool()
async def stratum_list_workflows(
    workflows_dir: str = "."
) -> dict:
    """List registered workflow specs from a directory."""
```

**Behavior:**
- Scan `workflows_dir` for `*.stratum.yaml` files
- Parse each, extract `workflow:` block if present
- Return `{ workflows: [{ name, description, input, path }] }`
- Skip files without `workflow:` block (internal specs)
- Skip files that fail validation (log warning, don't crash)

## Backward Compatibility

- `functions:` block still supported and works as before
- Steps with `function:` reference still work unchanged
- Specs without `workflow:` are internal (not discoverable)
- v0.1 specs are unaffected — all new fields are v0.2 only
- `version: "0.2"` already exists in the schema — this extends it

## File Changes

All in `stratum-mcp/src/stratum_mcp/`:

| File | Change |
|------|--------|
| `spec.py` (existing) | Add `IRWorkflowDef` dataclass, extend `IRSpec`, `IRStepDef`, `IRFunctionDef`. Extend v0.2 JSON schema. Add semantic validation rules. |
| `server.py` (existing) | Add `stratum_list_workflows` tool. |

## Test Plan

| Test | What it validates |
|------|-------------------|
| Parse inline step (intent, no function, no flow) | Schema accepts, step-level ensure/retries/output_contract populated |
| Parse function step (no intent, no flow) | Existing behavior unchanged |
| Reject step with both function and intent | Semantic validation error |
| Reject step with function and flow | Semantic validation error |
| Reject step with none of function/intent/flow | Semantic validation error |
| Reject inline step with on_fail but no ensure | Semantic validation error (on_fail can never trigger) |
| Reject function step with step-level ensure | Semantic validation error (ensure belongs on function) |
| Parse workflow declaration | `IRWorkflowDef` populated, `IRSpec.workflow` set |
| Parse spec without workflow | `IRSpec.workflow` is None |
| Parse agent field on step | `IRStepDef.agent` populated |
| Parse on_fail/next on non-gate step | Fields populated, targets validated |
| Reject on_fail on gate step | Semantic validation error |
| Parse flow: reference on step | `IRStepDef.flow_ref` populated |
| Reject step with flow + agent | Semantic validation error |
| Reject recursive flow reference | Semantic validation error |
| Parse policy/policy_fallback on gate step | Fields populated |
| Reject policy on non-gate step | Semantic validation error |
| stratum_list_workflows returns workflow specs | Tool returns name, description, input |
| stratum_list_workflows skips non-workflow specs | Internal specs filtered out |
| v0.1 specs still parse correctly | Backward compat |
| All existing tests still pass | No regressions |

## Example Spec (post STRAT-ENG-1)

```yaml
version: "0.2"

workflow:
  name: build
  description: "Execute feature through full lifecycle"
  input:
    feature: { type: string, required: true }
    skip_prd: { type: boolean, default: false }

contracts:
  DesignResult:
    path: { type: string }
    word_count: { type: integer }
  ReviewResult:
    clean: { type: boolean }
    findings: { type: array }

flows:
  review_fix:
    input: { task: { type: string } }
    steps:
      - id: review
        agent: codex
        intent: "Review implementation. Return {clean, findings}."
        ensure:
          - "result.clean == true"
        on_fail: fix

      - id: fix
        agent: claude
        intent: "Fix all findings from review."
        inputs:
          findings: "$.steps.review.output.findings"
        next: review

  build:
    input: { feature: { type: string }, skip_prd: { type: boolean } }
    steps:
      - id: design
        agent: claude
        intent: "Explore codebase and write design.md."
        ensure:
          - "file_exists('docs/features/' + input.feature + '/design.md')"

      - id: design_gate
        function: design_approval
        policy: gate
        on_approve: implement
        on_revise: design
        on_kill: null

      - id: implement
        agent: claude
        intent: "Execute the implementation plan."
        depends_on: [design_gate]

      - id: review
        flow: review_fix
        inputs:
          task: "$.steps.implement.output.summary"
        depends_on: [implement]

functions:
  design_approval:
    mode: gate
    timeout: 3600
```

## Open Questions

None — this is a schema-only change. Executor behavior is deferred to STRAT-ENG-2 through STRAT-ENG-5.
