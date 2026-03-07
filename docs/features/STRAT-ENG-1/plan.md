# STRAT-ENG-1: Implementation Plan

**Date:** 2026-03-07
**Design:** [design.md](./design.md)
**Repo:** `stratum-mcp/` at `/Users/ruze/reg/my/forge/stratum/stratum-mcp/`
**Files:** `src/stratum_mcp/spec.py` (existing), `src/stratum_mcp/server.py` (existing), `tests/contracts/test_ir_schema.py` (existing)

## Task Order

Tasks are sequential — each builds on the prior. All changes are in the Stratum repo.

---

### Task 1: Add `IRWorkflowDef` dataclass and extend `IRSpec`

**File:** `src/stratum_mcp/spec.py` (existing)

**What:**
- [ ] Add `IRWorkflowDef` dataclass after `IRSpec` (L83):
  ```python
  @dataclass(frozen=True)
  class IRWorkflowDef:
      name: str
      description: str
      input_schema: dict[str, Any]
  ```
- [ ] Add `workflow: IRWorkflowDef | None = None` field to `IRSpec` (L88)

**Test:**
- [ ] `test_spec_without_workflow_has_none` — parse existing v0.2 spec, assert `spec.workflow is None`

---

### Task 2: Extend `IRStepDef` with new fields

**File:** `src/stratum_mcp/spec.py` (existing)

**What:** Add fields to `IRStepDef` (L53–69):
- [ ] `agent: str | None = None`
- [ ] `intent: str | None = None`
- [ ] `on_fail: str | None = None`
- [ ] `next: str | None = None`
- [ ] `flow_ref: str | None = None`
- [ ] `policy: str | None = None` (Literal["gate", "flag", "skip"] semantically)
- [ ] `policy_fallback: str | None = None`
- [ ] Step-level execution fields for inline steps:
  - `ensure: list[str] | None = None`
  - `retries: int | None = None`
  - `output_contract: str | None = None`
  - `model: str | None = None`
  - `budget: IRBudgetDef | None = None`
- [ ] Change `function: str` default to `function: str = ""` (make optional)

**Test:**
- [ ] `test_step_fields_default_to_none` — parse existing spec, assert new fields are None/empty

---

### Task 3: Update v0.2 JSON schema

**File:** `src/stratum_mcp/spec.py` (existing), `_IR_SCHEMA_V02` (L177–268)

**What:**

- [ ] Add `workflow` to top-level properties:
  ```python
  "workflow": {
      "type": "object",
      "required": ["name", "description", "input"],
      "additionalProperties": False,
      "properties": {
          "name": {"type": "string", "pattern": "^[a-z][a-z0-9-]*$"},
          "description": {"type": "string", "minLength": 1},
          "input": {
              "type": "object",
              "additionalProperties": {
                  "type": "object",
                  "properties": {
                      "type": {"type": "string", "enum": ["string", "boolean", "integer", "number", "array", "object"]},
                      "required": {"type": "boolean"},
                      "default": {},
                  },
                  "required": ["type"],
              }
          },
      }
  }
  ```

- [ ] Update `StepDef` — remove `function` from `required`, add new fields:
  ```python
  "required": ["id"],  # was ["id", "function"]
  # Add to properties:
  "agent": {"type": "string"},
  "intent": {"type": "string"},
  "on_fail": {"type": "string"},
  "next": {"type": "string"},
  "flow": {"type": "string"},
  "policy": {"type": "string", "enum": ["gate", "flag", "skip"]},
  "policy_fallback": {"type": "string", "enum": ["gate", "flag", "skip"]},
  "ensure": {"type": "array", "items": {"type": "string"}},
  "retries": {"type": "integer", "minimum": 1},
  "output_contract": {"type": "string"},
  "model": {"type": "string"},
  "budget": {"$ref": "#/$defs/BudgetDef"},
  ```

**Test:**
- [ ] `test_v02_schema_accepts_inline_step` — YAML with `intent:` instead of `function:` parses
- [ ] `test_v02_schema_accepts_workflow_block` — YAML with `workflow:` parses
- [ ] `test_v02_schema_accepts_flow_ref_step` — YAML with `flow:` on step parses
- [ ] `test_v01_schema_rejects_new_fields` — v0.1 spec with `agent:` fails validation (additionalProperties: false)

---

### Task 4: Update `_build_spec` and `_build_flow` parsers

**File:** `src/stratum_mcp/spec.py` (existing)

**What:**

- [ ] Update `_build_spec` (L321–334) to parse `workflow:` block:
  ```python
  wf = doc.get("workflow")
  workflow = IRWorkflowDef(
      name=wf["name"],
      description=wf["description"],
      input_schema=wf.get("input", {}),
  ) if wf else None
  ```
  Pass `workflow=workflow` to `IRSpec` constructor.

- [ ] Update `_build_flow` step construction (L358–374) to read new fields:
  ```python
  IRStepDef(
      # existing fields...
      function=s.get("function", ""),
      agent=s.get("agent"),
      intent=s.get("intent"),
      on_fail=s.get("on_fail"),
      next=s.get("next"),
      flow_ref=s.get("flow"),  # YAML key "flow" → field "flow_ref"
      policy=s.get("policy"),
      policy_fallback=s.get("policy_fallback"),
      ensure=s.get("ensure"),
      retries=s.get("retries"),
      output_contract=s.get("output_contract"),
      model=s.get("model"),
      budget=IRBudgetDef(ms=sb.get("ms"), usd=sb.get("usd")) if (sb := s.get("budget")) else None,
  )
  ```

**Test:**
- [ ] `test_parse_inline_step_populates_fields` — intent, agent, ensure, retries all present on dataclass
- [ ] `test_parse_workflow_populates_irworkflowdef` — name, description, input_schema correct
- [ ] `test_parse_flow_ref_step` — flow_ref populated from `flow:` YAML key

---

### Task 5: Restructure semantic validation for new step modes

**File:** `src/stratum_mcp/spec.py` (existing), `_validate_semantics` (L411–535)

**Critical prerequisite:** The current validator (L453–458) unconditionally checks `step.function not in known_functions` for every step. Inline (`intent`) and composed (`flow_ref`) steps have `function=""`, so they'd fail immediately. The step validation loop must be restructured: **mode exclusion runs first**, then mode-specific validation branches.

**What:** Rewrite the per-step validation loop inside `_validate_semantics`:

```python
for step in flow.steps:
    # 1. Mode exclusion — FIRST, before any function/intent/flow-specific checks
    modes = [bool(step.function), bool(step.intent), bool(step.flow_ref)]
    if sum(modes) != 1:
        raise IRSemanticError(
            f"Step '{step.id}' must have exactly one of function, intent, or flow",
            path=f"flows.{flow_name}.steps.{step.id}"
        )

    # 2. Branch on mode
    if step.function:
        # Existing: function must exist in known_functions
        if step.function not in known_functions:
            raise IRSemanticError(...)
        # New: step-level execution fields forbidden on function steps
        for field in ("ensure", "retries", "output_contract", "model", "budget"):
            if getattr(step, field) is not None:
                raise IRSemanticError(...)
        # Existing gate/non-gate checks (L466–534) go here, unchanged

    elif step.intent:
        # Inline step: no function lookup needed
        # on_fail requires ensure to exist (otherwise it never triggers)
        if step.on_fail and not step.ensure:
            raise IRSemanticError(...)

    elif step.flow_ref:
        # Must reference a known flow
        if step.flow_ref not in spec.flows:
            raise IRSemanticError(...)
        # Must not self-reference (direct)
        if step.flow_ref == flow_name:
            raise IRSemanticError(...)
        # No recursive references (indirect: walk flow_ref graph)
        # Must NOT have agent, retries, model, budget
        # ensure IS allowed (checked against sub-flow output)

    # 3. Common checks (all modes)
    # depends_on targets exist (existing, L459–464)
    # on_fail target must exist in known_step_ids
    # next target must exist in known_step_ids
    # policy only on gate steps, policy_fallback requires policy
    #
    # Gate-routing fields on non-gate steps (ALL non-gate modes: function, intent, flow_ref):
    # on_approve, on_revise, on_kill must all be None — these are gate-only fields.
    # This preserves the existing invariant from L523–534, applied uniformly.
    if not is_gate_step:
        for field_name in ("on_approve", "on_revise", "on_kill"):
            if getattr(step, field_name) is not None:
                raise IRSemanticError(...)
```

- [ ] Restructure per-step loop: mode exclusion → mode branch → common checks
- [ ] Move existing `step.function not in known_functions` into the `if step.function:` branch
- [ ] Move existing gate/non-gate checks into the `if step.function:` branch (gates always use functions)

- [ ] **Flow ref restrictions:** if `step.flow_ref`:
  - Must reference a flow in `spec.flows`
  - Must NOT have `agent` set
  - Must NOT have `retries`, `model`, `budget` set
  - `ensure` IS allowed (checked against sub-flow output)
  - No recursive references (direct: flow_ref == flow_name; indirect: walk the graph)

- [ ] **on_fail validation:** only on non-gate steps, target must be valid step ID
- [ ] **on_fail + ensure coupling:** if `on_fail` is set and step has no `ensure`, raise error (on_fail can never trigger)
- [ ] **next validation:** only on non-gate steps, target must be valid step ID
- [ ] **policy validation:** only on gate steps, value must be gate|flag|skip
- [ ] **policy_fallback validation:** only valid if `policy` is set
- [ ] **Workflow entry flow:** if `spec.workflow`, must have a flow matching `workflow.name` OR exactly one flow. `workflow.input_schema` keys must match entry flow's `input_schema` keys.

**Tests:**
- [ ] `test_reject_step_with_function_and_intent` — semantic error
- [ ] `test_reject_step_with_no_mode` — semantic error (no function, no intent, no flow)
- [ ] `test_reject_function_step_with_step_ensure` — semantic error
- [ ] `test_reject_flow_ref_with_agent` — semantic error
- [ ] `test_reject_flow_ref_to_unknown_flow` — semantic error
- [ ] `test_reject_recursive_flow_ref` — semantic error (direct self-reference)
- [ ] `test_on_fail_target_must_exist` — semantic error for bad target
- [ ] `test_on_fail_without_ensure_raises` — semantic error (on_fail can never trigger)
- [ ] `test_on_fail_rejected_on_gate_step` — semantic error
- [ ] `test_next_target_must_exist` — semantic error for bad target
- [ ] `test_policy_rejected_on_non_gate_step` — semantic error
- [ ] `test_policy_fallback_without_policy_rejected` — semantic error
- [ ] `test_workflow_entry_flow_must_exist` — semantic error
- [ ] `test_workflow_input_mismatch_raises` — semantic error

---

### Task 6: Add `stratum_list_workflows` MCP tool

**File:** `src/stratum_mcp/server.py` (existing)

**What:**
- [ ] Add new tool after `stratum_draft_pipeline` (end of file):
  ```python
  @mcp.tool(description=(
      "List registered workflow specs from a directory. "
      "Scans for *.stratum.yaml files with a workflow: block. "
      "Returns {workflows: [{name, description, input, path}]}."
  ))
  async def stratum_list_workflows(
      workflows_dir: str = ".",
      ctx: Context = None,
  ) -> dict[str, Any]:
  ```
- [ ] Scan `workflows_dir` for `*.stratum.yaml` files
- [ ] Parse each, extract `workflow:` block if present
- [ ] Return `{ workflows: [{ name, description, input, path }] }`
- [ ] Skip files without `workflow:` (internal specs)
- [ ] Skip files that fail validation (include in `errors` list, don't crash)
- [ ] Check for duplicate `workflow.name` across discovered specs — include duplicates in `errors` list with both paths, keep the first occurrence in `workflows`

**Test file:** `tests/integration/test_list_workflows.py` (new)
- [ ] `test_list_workflows_finds_workflow_specs` — write temp spec with `workflow:`, verify returned
- [ ] `test_list_workflows_skips_internal_specs` — spec without `workflow:` not in results
- [ ] `test_list_workflows_skips_invalid_specs` — bad YAML not in results, no crash
- [ ] `test_list_workflows_detects_duplicate_names` — two specs with same `workflow.name`, first kept, duplicate in errors

---

### Task 7: Verify backward compatibility

**What:**
- [ ] Run full existing test suite (`pytest stratum-mcp/tests/`) — all must pass
- [ ] Verify `_VALID_GATE_IR` test fixture still works (L204–231 of test_ir_schema.py)
- [ ] Verify v0.1 specs are unaffected by new v0.2 fields

---

## Summary

| Task | File(s) | New tests |
|------|---------|-----------|
| 1. IRWorkflowDef + IRSpec | spec.py | 1 |
| 2. IRStepDef fields | spec.py | 1 |
| 3. v0.2 JSON schema | spec.py | 4 |
| 4. Parsers | spec.py | 3 |
| 5. Semantic validation | spec.py | 14 |
| 6. stratum_list_workflows | server.py | 4 |
| 7. Backward compat | — | 0 (existing) |

**Total: 7 tasks, 27 new tests, 2 files modified, 1 file created.**
