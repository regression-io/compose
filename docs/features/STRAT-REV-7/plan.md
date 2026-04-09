# STRAT-REV-7: Cross-Model Adversarial Synthesis

**Item:** 85 (STRAT-REV-7)
**Scope:** For large diffs, run Codex review after Claude lenses and synthesize findings across models.

## Architecture

**Key insight from Codex review:** The pipeline can't branch on triage output (triage is inside `parallel_review` sub-flow). And Codex returns `string[]` findings (ReviewResult contract), not structured `LensFinding[]`. So cross-model synthesis happens in **build.js**, not in the pipeline YAML.

**Flow:**
1. `parallel_review` runs as today (Claude lenses: triage → dispatch → merge)
2. build.js checks diff size from `files_changed` list
3. If large (≥9 files or explicitly flagged): dispatch Codex via `agent_run` with the diff
4. Run a synthesis Claude agent that receives both Claude `MergedReviewResult` and Codex `string[]` findings
5. Synthesis output replaces the original review result for the ensure check

**Why sequential, not parallel:** Sub-flow parallelism would require Stratum executor changes (STRAT-PAR is for task-level, not flow-level parallelism). The Codex pass adds ~2-3 minutes. Acceptable for large diffs that already take 10+ minutes in review.

**Contracts:** No pipeline YAML changes needed. The Codex `ReviewResult` stays as `string[]`. Synthesis happens in build.js using a Claude agent that produces `MergedReviewResult` (the contract the ensure already checks).

## Tasks

### Task 1: Diff-size classification

**File:** `compose/lib/review-lenses.js` (existing)

- [ ] Export `classifyDiffSize(filesChanged)` → `'small' | 'medium' | 'large'`
  - Small: ≤2 files
  - Medium: 3-8 files
  - Large: ≥9 files
- [ ] Export `shouldRunCrossModel(filesChanged)` → boolean (true for large)

### Task 2: Cross-model dispatch in build.js

**File:** `compose/lib/build.js` (existing)

The review ensure/retry loop is in the `executeChildFlow` handler around line 1279-1342. After `parallel_review` returns with `ensure_failed` or succeeds:

- [ ] After the review child flow completes successfully (ensure passes, `result.clean === true`):
  - Call `shouldRunCrossModel(filesChanged)` — if false, skip (current behavior)
  - If true: log to stream writer `{ type: 'cross_model_review', status: 'started' }`
  - Dispatch Codex review via connector: create CodexConnector, run with prompt including the diff file list + "Review these changes. Output findings as a JSON array of strings."
  - Parse Codex response as `string[]` findings
  - If Codex returns clean (empty findings): done, no synthesis needed
  - If Codex has findings: dispatch synthesis agent (Task 3)

- [ ] Also trigger cross-model when `parallel_review` returns `ensure_failed` with `result.clean === false` AND diff is large:
  - Run Codex in parallel with the fix loop (Codex reviews the original diff while Claude fixes)
  - Synthesis happens after the fix loop completes, before re-running review

### Task 3: Synthesis agent

**File:** `compose/lib/build.js` (existing, inline in Task 2)

- [ ] Create a synthesis prompt that receives:
  - Claude findings: `MergedReviewResult.findings` (array of `LensFinding` objects with file, line, severity, finding, confidence)
  - Codex findings: `string[]` (unstructured text findings)
- [ ] Prompt asks Claude to classify each finding as:
  - CONSENSUS: both models flagged the same issue (same file, similar concern)
  - CLAUDE_ONLY: only Claude found it
  - CODEX_ONLY: only Codex found it
- [ ] Output: updated `MergedReviewResult` with a `crossModelSynthesis` field:
  ```json
  {
    "clean": false,
    "summary": "Cross-model synthesis: 3 consensus, 2 Claude-only, 1 Codex-only",
    "findings": [...],  // all findings, annotated with source
    "synthesis": {
      "consensus": [...],
      "claude_only": [...],
      "codex_only": [...]
    }
  }
  ```
- [ ] Log synthesis result to stream writer: `{ type: 'cross_model_review', status: 'complete', consensus, claudeOnly, codexOnly }`

### Task 4: Opt-out and configuration

**File:** `compose/lib/build.js` (existing)

- [ ] `opts.skipCrossModel` flag to disable (for cost control)
- [ ] Environment variable `COMPOSE_CROSS_MODEL=0` to disable globally
- [ ] If no Codex connector available (opencode not installed): skip gracefully, log warning

### Task 5: Tests

**File:** `compose/test/review-lenses.test.js` (existing, extend)

- [ ] Test: classifyDiffSize — ≤2 files → small, 3-8 → medium, ≥9 → large
- [ ] Test: shouldRunCrossModel — true for ≥9 files, false otherwise

**File:** `compose/test/cross-model-review.test.js` (new)

- [ ] Test: cross-model skipped when diff is small
- [ ] Test: cross-model skipped when COMPOSE_CROSS_MODEL=0
- [ ] Test: cross-model skipped when Codex connector unavailable
- [ ] Test: synthesis prompt includes both Claude and Codex findings
- [ ] Test: stream writer events emitted for start/complete

## Implementation Order

1. Task 1 (diff-size) — standalone
2. Task 2 + 3 (build.js dispatch + synthesis) — main work
3. Task 4 (opt-out) — alongside task 2
4. Task 5 (tests) — alongside each task

## Non-goals

- Pipeline YAML restructuring (keep existing parallel_review intact)
- Structured Codex findings (Codex returns strings, synthesis handles the mismatch)
- True parallel execution of Claude + Codex (sequential is acceptable for v1)
- Cost tracking (deferred to COMP-OBS-COST)
