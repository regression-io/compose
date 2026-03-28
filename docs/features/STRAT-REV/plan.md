# STRAT-REV: Implementation Plan

**Created:** 2026-03-28

## Tasks

### Task 1: Stratum schema — add `isolation: "none"` (stratum-mcp)
- [ ] `src/stratum_mcp/spec.py:490` — add `"none"` to isolation enum: `["worktree", "branch", "none"]`
- [ ] `tests/integration/test_parallel_schema.py` — add test: `isolation: "none"` parses and validates
- [ ] `tests/integration/test_parallel_executor.py` — add test: dispatch with `isolation: "none"` returns `isolation: "none"` in dispatch object
- [ ] Run `pytest` — all existing + new tests pass

### Task 2: Lens library (compose)
- [ ] Create `lib/review-lenses.js` (new) with:
  - `LENS_DEFINITIONS` — 4 lens objects with id, name, focus, confidence_gate, exclusions
  - `triageLenses(fileList, priorDirtyLenses)` — returns `LensTask[]`
  - `BASELINE_LENSES` — `['diff-quality', 'contract-compliance']` (always re-run on retry)
- [ ] Create `test/review-lenses.test.js` (new) with:
  - Triage returns baseline lenses for any file list
  - Triage adds security lens when auth/crypto/SQL files present
  - Triage adds framework lens when React/Express/Next files present
  - Retry mode with prior_dirty_lenses returns dirty + baseline lenses
  - Confidence gates and exclusions are populated on each LensTask

### Task 3: Pipeline spec — `parallel_review` sub-flow (compose)
- [ ] `pipelines/build.stratum.yaml` — add contracts: `LensFinding`, `LensTask`, `LensResult`, `MergedReviewResult`
- [ ] `pipelines/build.stratum.yaml` — add `parallel_review` sub-flow with 3 steps: triage, review_lenses (parallel_dispatch), merge
- [ ] `pipelines/build.stratum.yaml` — change main flow review step: `flow: parallel_review` with corrected inputs (blueprint path, diff, prior_dirty_lenses)
- [ ] Keep `review_check` sub-flow as manual fallback

### Task 4: Build.js integration (compose)
- [ ] `lib/build.js:81` — add timeout entries: `triage: 2 * 60_000`, `merge: 3 * 60_000`, bump `review: 15 * 60_000`
- [ ] `lib/build.js` — verify non-worktree code path works for `isolation: "none"` tasks (line 689+ already checks `useWorktrees`)
- [ ] `lib/build.js` executeChildFlow — on `ensure_failed` for parallel_review, extract `lenses_run` from result and inject as `prior_dirty_lenses` input on retry

### Task 5: Verify
- [ ] `pytest` in stratum-mcp — all tests pass
- [ ] `node --test test/*.test.js` in compose — all tests pass
- [ ] `npx vite build` in compose — build passes

## Execution Order

```
Task 1 (stratum schema)  ──→  Task 3 (pipeline spec)  ──→  Task 5 (verify)
Task 2 (lens library)    ──→  Task 4 (build.js)       ──→  Task 5 (verify)
```

Tasks 1+2 are parallel (different repos/files). Tasks 3+4 depend on 1+2 respectively but can run in parallel with each other.
