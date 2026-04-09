# COMP-PLAN-VERIFY Implementation Plan

**Items:** 121-124
**Scope:** Stratum ensure function verifying plan acceptance criteria appear in the implementation diff.

## Architecture

New Stratum builtin `plan_completion(plan_items, files_changed)` registered alongside `no_file_conflicts`. Called as an ensure on the **ship step** (the execution step, not ship_gate which is a human approval gate). Receives precomputed data from the step result and validates completeness. Returns string violations for missing items.

**How it connects:**
1. `plan_completion` is a Python function in `spec.py` (like `no_file_conflicts`)
2. Registered in the `_eval_ensure` sandbox in `executor.py:433`
3. Used in `build.stratum.yaml` ship step's ensure clause
4. The step result must include `plan_items` (extracted from plan.md) and `files_changed`

**JS/Python boundary:** `plan-parser.js` is a helper included in the ship step's agent prompt to help the agent extract plan items from plan.md before calling `step_done`. It is NOT called by the ensure function. The ensure function is pure Python — it receives precomputed `plan_items` and `files_changed` arrays in the step `result` and just validates completeness. No file I/O, no LLM calls, no JS interop.

## Tasks

### Task 1: Plan parser utility (agent-side helper)

**File:** `compose/lib/plan-parser.js` (new)

This is a helper for the ship step's agent prompt. The agent uses it to extract plan items from plan.md before including them in the step result. It is NOT called by the ensure function.

- [ ] Export `parsePlanItems(planMarkdown)` -> `Array<{ text, file, critical }>`
  - Parse `- [ ]` and `- [x]` checkbox lines from plan.md
  - Extract file path references (backtick-quoted paths)
  - Heuristic for critical: items mentioning "MUST", "required", security paths, or test requirements
- [ ] Export `matchItemsToDiff(planItems, filesChanged)` -> `{ done: [], missing: [], extra: [] }`
  - DONE: plan item mentions a file that's in filesChanged
  - MISSING: plan item mentions a file NOT in filesChanged
  - EXTRA: files in filesChanged not mentioned in any plan item (scope creep)
  - Critical items get `critical: true` flag

### Task 2: Stratum ensure builtin (pure Python)

**File:** `stratum-mcp/src/stratum_mcp/spec.py` (existing)

- [ ] Add `plan_completion(plan_items, files_changed, threshold=90)` function:
  - `plan_items`: list of `{ text, file, critical }` dicts (from step result)
  - `files_changed`: list of file paths (from step result)
  - Guard: `if not plan_items: return True` (nothing to check, avoid division by zero)
  - Calculate completion percentage: `len(done) / len(plan_items) * 100`
  - If any critical item is MISSING: raise `EnsureViolation` with plain string violations, e.g. `f"Missing critical item: {item['text']} (expected in {item['file']})"`
  - If completion < threshold: raise `EnsureViolation` with plain string violations listing completion percentage and each missing item as a string
  - Violations are plain strings in the violations list — no structured dicts, no `conflicts` field (that would overload the existing EnsureViolation shape)
  - Return True if passes
- [ ] Add to `_V03_BUILTIN_FUNCTION_NAMES` set (~line 188)

**File:** `stratum-mcp/src/stratum_mcp/executor.py` (existing)

- [ ] Import `plan_completion` from spec.py
- [ ] Add to sandbox in `_eval_ensure` (~line 433): `'plan_completion': plan_completion`

### Task 3: Pipeline integration

**File:** `compose/pipelines/build.stratum.yaml` (existing)

- [ ] Add ensure clause to the **ship step** (not ship_gate — ship is the execution step, ship_gate is the human approval gate):
  ```yaml
  ensure:
    - "plan_completion(result.plan_items, result.files_changed)"
  ```
- [ ] Update the ship step's intent to include: "Extract acceptance criteria from plan.md as plan_items (array of {text, file, critical}). Include files_changed in your result."
- [ ] Reference `plan-parser.js` in the ship step's agent prompt so the agent can use it to extract plan items

### Task 4: Scope creep reporting

**File:** `compose/lib/plan-parser.js` (same as task 1)

- [ ] `matchItemsToDiff` EXTRA items are informational — not blocking by default
- [ ] The ship step agent receives the ensure violation and can present EXTRA items to the human at the ship_gate
- [ ] Policy can optionally gate on zero EXTRA items via a separate ensure: `"len(result.scope_creep) == 0"`

### Task 5: Tests

**File:** `stratum-mcp/tests/invariants/test_plan_completion.py` (new)

- [ ] Test: all items in diff -> passes (returns True)
- [ ] Test: critical item missing -> raises EnsureViolation with plain string violations
- [ ] Test: below threshold -> raises EnsureViolation with percentage in violation string
- [ ] Test: empty plan_items -> returns True immediately (division by zero guard)
- [ ] Test: threshold=100 requires all items
- [ ] Test: violations list contains only strings, no structured dicts

**File:** `compose/test/plan-parser.test.js` (new)

- [ ] Test: parsePlanItems extracts checkbox items with file paths
- [ ] Test: parsePlanItems marks critical items
- [ ] Test: matchItemsToDiff classifies done/missing/extra correctly
- [ ] Test: matchItemsToDiff handles items without file references
