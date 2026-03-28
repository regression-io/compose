# STRAT-REV: Parallel Multi-Lens Review — Blueprint

**Created:** 2026-03-28
**Depends on:** STRAT-PAR (complete), design at `/docs/features/STRAT-REV/design.md`

---

## Overview

Replace the single `review_check` sub-flow (codex, 5 retries) with a parallel multi-lens review: triage → parallel lens dispatch → merge/dedup → fix loop. Six implementation items (STRAT-REV-1 through STRAT-REV-6).

**Two repos touched:**
- `stratum-mcp/` — add `isolation: "none"` to IR v0.3 schema
- `compose/` — lens library, triage, merge, pipeline integration, build.js dispatch

---

## STRAT-REV-1: Triage Step

**What:** A lightweight Claude step that reads the file list from git diff and decides which review lenses to activate.

**Implementation:**
- Add a `triage` inline step to the new `parallel_review` sub-flow in `pipelines/build.stratum.yaml`
- Agent: `claude`
- Inputs: `$.input.diff` (file list from context.filesChanged), `$.input.prior_dirty_lenses` (optional, from retry)
- Output contract: `{ tasks: LensTask[] }` — full task objects with `id`, `lens_name`, `lens_focus`, `confidence_gate`, `exclusions`
- Always includes: `diff-quality`, `contract-compliance`
- Conditionally adds: `security` (if files touch auth, crypto, SQL, HTTP handlers), `framework` (if detected framework files)
- On retry: if `prior_dirty_lenses` input is present, activates those lenses plus the two baseline lenses (`diff-quality`, `contract-compliance`) to catch fix-introduced regressions (skips file-list re-triage)

**Triage output shape** (consumed by `parallel_dispatch` source):
```json
{
  "tasks": [
    {"id": "diff-quality", "lens_name": "diff-quality", "lens_focus": "Code style, test gaps, dead code, naming, duplication", "confidence_gate": 6, "exclusions": "Style-only nits without functional impact"},
    {"id": "security", "lens_name": "security", "lens_focus": "OWASP top 10, injection, secrets, insecure defaults", "confidence_gate": 8, "exclusions": "DoS/rate-limiting, memory safety in memory-safe langs"}
  ]
}
```

**Key file:** `pipelines/build.stratum.yaml` — new `parallel_review` sub-flow, triage step. `compose/lib/review-lenses.js` — lens definitions used by triage.

---

## STRAT-REV-2: Lens Library

**What:** 4 review prompt templates, each producing `LensFinding[]` output.

### LensFinding Contract

Add to `pipelines/build.stratum.yaml` contracts section (after line 31):

```yaml
LensFinding:
  lens:       {type: string}
  file:       {type: string}
  line:       {type: number}
  severity:   {type: string, values: [must-fix, should-fix, nit]}
  finding:    {type: string}
  confidence: {type: number}

LensTask:
  id:              {type: string}
  lens_name:       {type: string}
  lens_focus:      {type: string}
  confidence_gate: {type: number}
  exclusions:      {type: string}

LensResult:
  clean:    {type: boolean}
  findings: {type: array, items: LensFinding}

MergedReviewResult:
  clean:      {type: boolean}
  summary:    {type: string}
  findings:   {type: array, items: LensFinding}
  lenses_run: {type: array}
  auto_fixes: {type: array, items: LensFinding}
  asks:       {type: array, items: LensFinding}
```

### Lens Prompts

Store as `intent_template` interpolation in the parallel_dispatch step. Each lens task in the TaskGraph includes a `lens_name` and `lens_focus` field that gets interpolated.

| Lens | Focus | Confidence gate | False-positive exclusions |
|------|-------|-----------------|--------------------------|
| `diff-quality` | Code style, test gaps, dead code, naming, duplication | 6/10 | Style-only nits without functional impact |
| `contract-compliance` | Blueprint match, missing acceptance criteria, wrong paths | 7/10 | Items explicitly deferred in plan |
| `security` | OWASP top 10, injection, secrets, insecure defaults | 8/10 | DoS/rate-limiting, memory safety in memory-safe langs, theoretical without concrete risk |
| `framework` | Framework anti-patterns, deprecated APIs, perf pitfalls | 6/10 | Opinions without measurable impact |

**Key file:** New file `compose/lib/review-lenses.js` (exports lens definitions + triage logic)

---

## STRAT-REV-3: Parallel Review Dispatch

**What:** Run activated lenses in parallel via `parallel_dispatch` with `isolation: none` (read-only).

### Stratum Schema Change

**File:** `stratum-mcp/src/stratum_mcp/spec.py`
- **Line 490:** Change `"enum": ["worktree", "branch"]` → `"enum": ["worktree", "branch", "none"]`
- **Line 103:** `isolation` field already nullable, no change needed
- **Line 974** (executor.py): `"isolation": step.isolation or "worktree"` — no change needed (compose handles "none")

### Compose Build.js Change

**File:** `compose/lib/build.js`
- **Line 689:** `const useWorktrees = (dispatchResponse.isolation ?? 'worktree') === 'worktree';`
- This already handles `isolation: "none"` correctly — `useWorktrees` will be `false`, so no worktree creation
- Need to verify the non-worktree path works for read-only tasks (tasks run in shared `agentCwd`)

### Spec Shape

In `pipelines/build.stratum.yaml`, the `parallel_review` sub-flow:

```yaml
- id: review_lenses
  type: parallel_dispatch
  source: "$.steps.triage.output.tasks"
  max_concurrent: 4
  isolation: none
  intent_template: >
    You are a {lens_name} reviewer. Review ONLY through the {lens_name} lens.
    Focus: {lens_focus}
    Confidence gate: only report findings with confidence >= {confidence_gate}.
    False-positive exclusions: {exclusions}
    Return JSON: { "clean": boolean, "findings": LensFinding[] }
  require: all
```

**Key files:**
- `stratum-mcp/src/stratum_mcp/spec.py:490` (schema enum)
- `compose/lib/build.js:689` (isolation check)
- `compose/pipelines/build.stratum.yaml` (new sub-flow)

---

## STRAT-REV-4: Merge + Dedup

**What:** Collect parallel lens results, deduplicate by file+issue, assign severity, classify as AUTO-FIX or ASK.

**Implementation:**
- Add a `merge` inline step after `review_lenses` in the `parallel_review` sub-flow
- Agent: `claude`
- Input: `$.steps.review_lenses.output` (aggregate from `stratum_parallel_done` — contains `tasks[]` with all per-lens results, `completed[]`, `failed[]`)
- Dedup logic: same file + same issue description (fuzzy match) = one finding, highest confidence wins
- Severity assignment: `must-fix` (blocks ship), `should-fix` (next iteration), `nit` (logged only)
- Classification: `AUTO-FIX` (mechanical: formatting, simple tests, obvious typos) vs `ASK` (requires judgment)
- Output: `MergedReviewResult` with `clean`, `summary`, `findings`, `lenses_run`, `auto_fixes`, `asks`
- Ensure: `result.clean == True or len([f for f in result.findings if f.severity in ('must-fix', 'should-fix')]) > 0`

**Key file:** `pipelines/build.stratum.yaml` (merge step in parallel_review sub-flow)

---

## STRAT-REV-5: Selective Re-review

**What:** On retry after fix, only re-run lenses that had actionable findings.

**Implementation approach:**
- The `merge` step output includes `lenses_run` — IDs of lenses that produced `must-fix` or `should-fix` findings (excludes lenses that returned clean or only `nit` findings)
- On `ensure_failed`, the fix loop in `build.js` (`executeChildFlow`, line 1345) dispatches a claude fix
- After fix, the retry re-invokes the `parallel_review` sub-flow
- **State handoff:** The parent flow's `ensure_failed` handler in build.js extracts `lenses_run` from the failed merge result and passes it as `prior_dirty_lenses` input to the sub-flow on retry
- The triage step checks for `prior_dirty_lenses`: if present, builds `LensTask[]` for those lenses plus the two baseline lenses (`diff-quality`, `contract-compliance`) which always re-run to catch fix-introduced regressions. If absent (first run), triages from the file list.

**Build.js change required:** In `executeChildFlow` (line 1345), when `ensure_failed` fires for a `parallel_review` sub-flow, extract `lenses_run` from the step result and inject it into the sub-flow inputs for the retry invocation.

**Key files:**
- `compose/lib/build.js:1345` (ensure_failed handler — inject prior_dirty_lenses)
- `pipelines/build.stratum.yaml` (triage step reads optional prior_dirty_lenses input)
- No Stratum executor changes needed

---

## STRAT-REV-6: Pipeline Integration

**What:** Replace `review_check` with `parallel_review` in `build.stratum.yaml`.

### Main Flow Change

**File:** `pipelines/build.stratum.yaml`
- **Lines 269-276:** Change:
  ```yaml
  - id: review
    flow: review_check
    inputs:
      task: "$.steps.execute.output.outcome"
      blueprint: "$.input.description"
  ```
  to:
  ```yaml
  - id: review
    flow: parallel_review
    inputs:
      task: "$.steps.execute.output.outcome"
      blueprint: "$.steps.write_blueprint.output.path"  # actual blueprint artifact, not description
      diff: "$.steps.execute.output.files_changed"       # file list for triage
  ```
- Keep same `depends_on: [execute]` and `ensure: result.clean == True`
- **Note:** The current `review_check` receives `$.input.description` as `blueprint` — this is a pre-existing bug where the contract-compliance review checks against the feature description rather than the actual blueprint file. STRAT-REV fixes this by wiring to the real blueprint artifact path.

### Backward Compatibility

- Keep `review_check` sub-flow in the file (not deleted) for fallback
- If `isolation: "none"` is not recognized (old Stratum without schema update), the flow fails at the `review_lenses` parallel_dispatch step during schema validation. The user can switch back to `review_check` by editing the main flow's review step.

### Timeout Adjustment

**File:** `compose/lib/build.js:81`
- Current: `review: 10 * 60_000` (10 min for single codex pass)
- New: increase to `review: 15 * 60_000` (15 min — triage + parallel lenses + merge)
- Add `triage: 2 * 60_000` and `merge: 3 * 60_000` for sub-flow steps

---

## File Manifest

### New files
- `compose/lib/review-lenses.js` (new) — lens definitions, triage logic, confidence gates, exclusion lists

### Modified files — Stratum
- `stratum-mcp/src/stratum_mcp/spec.py:490` (existing) — add `"none"` to isolation enum
- `stratum-mcp/tests/integration/test_parallel_schema.py` (existing) — add test for `isolation: "none"`
- `stratum-mcp/tests/integration/test_parallel_executor.py` (existing) — add test for none-isolation dispatch

### Modified files — Compose
- `compose/pipelines/build.stratum.yaml` (existing) — add contracts (LensFinding, LensResult, MergedReviewResult), add `parallel_review` sub-flow, change main flow review step
- `compose/lib/build.js:81` (existing) — adjust review timeout, add triage/merge timeouts
- `compose/lib/build.js:689+` (existing) — verify non-worktree path handles read-only tasks correctly
- `compose/lib/step-prompt.js` (existing) — may need lens-specific context injection (TBD during implementation)

### Test files
- `compose/test/review-lenses.test.js` (new) — triage logic, lens selection, confidence gating
- `stratum-mcp/tests/integration/test_parallel_schema.py` (existing) — isolation: none validation
- `stratum-mcp/tests/integration/test_parallel_executor.py` (existing) — none-isolation dispatch object

---

## Corrections Table

| Design assumption | Reality | Action |
|-------------------|---------|--------|
| `isolation: none` exists | Schema only allows `["worktree", "branch"]` (spec.py:490) | Add "none" to enum — STRAT-REV-3 |
| `tasks_from` field in parallel_dispatch | Field is called `source`, not `tasks_from` (spec.py:487) | Use `source` in spec |
| LensFinding contract exists | Only `ReviewResult` exists (build.stratum.yaml:28-31) | Define new contracts — STRAT-REV-2 |
| build.js always creates worktrees | Line 689 checks `useWorktrees` flag — `isolation: "none"` will set it false | Verify non-worktree code path works for read-only tasks |
| Selective re-review needs Stratum changes | Triage step can handle this by reading prior merge output | No Stratum changes needed — STRAT-REV-5 |
| Review timeout is 10 min | Correct (build.js:81) — needs increase for multi-lens | Bump to 15 min — STRAT-REV-6 |

---

## Verification

- [ ] `isolation: "none"` accepted by Stratum schema validation
- [ ] `parallel_dispatch` with `isolation: "none"` returns dispatch without worktree flag
- [ ] Triage step returns correct lens list for different file sets
- [ ] Each lens produces valid `LensFinding[]` output
- [ ] Merge step deduplicates correctly (same file+issue → one finding)
- [ ] `parallel_review` sub-flow runs end-to-end in pipeline
- [ ] Selective re-review skips clean lenses on retry
- [ ] All existing tests still pass after changes
