# STRAT-COMP-3: Proof Run Design

**Feature:** Execute `compose build STRAT-1` end-to-end, validating the headless lifecycle runner using the fixed workflow spec at `pipelines/build.stratum.yaml`.

**Status:** Tasks 1-5 complete (317 tests, 0 fail). Task 6 (live proof run) is manual/gated.

**Related:**
- `docs/features/STRAT-1/design.md` — STRAT-1 master architecture
- `docs/features/STRAT-1/stratum-contract.md` — Frozen MCP tool signatures
- `ROADMAP.md` item #46 (Milestone 3: Prove It)
- `pipelines/build.stratum.yaml` — The 12-step lifecycle spec

---

## Problem Statement

`compose build` exists (`lib/build.js`, 459 lines) but has never been executed end-to-end on a real feature. The STRAT-1 Milestone 3 gate requires a successful proof run: multi-agent, gated, audited. Several bugs in the build infrastructure would cause failures before the first agent dispatch completes.

**Goal:** Fix all blocking bugs, run `compose build STRAT-1` headless, and validate the output (audit trail, vision state, test suite integrity).

**Key constraint:** `compose build` always plans from the fixed workflow spec at `pipelines/build.stratum.yaml` (`build.js:111`). Feature docs (`docs/features/<code>/design.md`) are only used as a fallback description source (`build.js:118`). There is no per-feature spec — the proof run validates the runner's execution of the shared pipeline, not a feature-specific spec.

---

## Bugs Blocking a Successful Run

### Bug 1: Missing `.compose/compose.json`

**Location:** `.compose/compose.json` (missing; `.compose/` directory exists with `breadcrumbs.log` and `data/`)

`build.js:106` checks for `.compose/compose.json` and throws if absent. The directory exists but the manifest file was never created.

**Fix:** Create `.compose/compose.json` with valid config:
```json
{
  "version": "1.0",
  "capabilities": { "stratum": true },
  "paths": { "docs": "docs", "features": "docs/features" }
}
```

### Bug 2: `skipped` dispatch shape — potential undefined fields

**Location:** `lib/build.js:229-235`

The `skipped` branch calls `stratum.stepDone(flowId, stepId, ...)`. While `flowId` and `stepId` are declared at lines 169-170 from `response.flow_id` and `response.step_id`, the question is whether the `skipped` dispatch from stratum-mcp actually includes these fields. If the dispatch omits `flow_id` or `step_id` for skipped steps, the call fails silently with undefined arguments.

**Fix:** Verify the actual dispatch shape for `skipped` status from stratum-mcp. If fields are present, no code change needed. If missing, read from the flow context or skip the `stepDone` call (Stratum may auto-advance on skip).

### Bug 3: No stratum-mcp availability guard

**Location:** `lib/build.js:125-126`

`StratumMcpClient` spawns `stratum-mcp` as a stdio subprocess. If the binary isn't on `$PATH`, the spawn fails with a cryptic error. No pre-check exists.

**Fix:** Add a `which stratum-mcp` probe in `stratum-mcp-client.js:connect()` or at the top of `runBuild()` before connecting. Throw a clear error: `"stratum-mcp not found. Install with: pip install stratum-mcp"`.

### Bug 4: VisionWriter dual-convention lookup

**Location:** `lib/vision-writer.js:70-77`

`findFeatureItem()` searches for items matching either `item.featureCode === 'feature:CODE'` (seedFeatures convention) or `item.lifecycle?.featureCode === 'CODE'` (lifecycle-manager convention). `ensureFeatureItem()` creates with the `feature:` prefix convention. This works but is fragile — if the server's VisionStore also writes items with different conventions, lookups can miss.

**Severity:** Low. Both paths are checked. Not blocking but should be documented or normalized post-proof-run.

---

## What the Proof Run Validates

### Flow Execution

The 12-step `build.stratum.yaml` spec executes through these phases:

```
explore_design → design_gate → prd [skip] → architecture [skip] →
blueprint → verification → plan → plan_gate → execute →
review [flow:review_fix] → coverage [flow:coverage_sweep] →
report [skip] → docs → ship → ship_gate
```

**Validated behaviors:**
- Agent dispatch (Claude via `ClaudeSDKConnector`)
- Gate resolution via CLI readline (`design_gate`, `plan_gate`, `ship_gate`)
- `skip_if: "true"` auto-skip for `prd`, `architecture`, `report`
- Sub-flow execution: `review_fix` (codex→claude loop) and `coverage_sweep` (claude test→fix loop)
- `ensure` postcondition enforcement with retries
- `on_fail`/`next` routing within sub-flows
- Audit trail written to `docs/features/STRAT-1/audit.json`

### Cross-Agent Dispatch

- Claude (`ClaudeSDKConnector`): explore_design, blueprint, verification, plan, execute, fix, run_tests, fix_tests, docs, ship
- Codex (`CodexConnector`): review step in `review_fix` sub-flow

**Prerequisite:** Both `ANTHROPIC_API_KEY` and Codex credentials must be configured. The spec hardcodes `agent: codex` for the review step — there is no runtime fallback. If Codex is unavailable, the review step will throw from `defaultConnectorFactory` and the build will fail. See Risks table for options.

### Vision State Updates

- `VisionWriter.ensureFeatureItem('STRAT-1')` creates or finds the item
- `updateItemStatus(itemId, 'in_progress')` on start
- `updateItemPhase(itemId, stepId)` on each step
- `createGate(flowId, stepId, itemId)` at each gate
- `resolveGate(gateId, outcome)` after human input
- `updateItemStatus(itemId, 'complete')` on success

### Test Suite Integrity

All 315 existing tests must still pass after bug fixes. The proof run itself doesn't add tests — it validates the integration of existing components.

---

## Approach

### Phase 1: Fix bugs (pre-run)

1. Create `.compose/compose.json` with valid config
2. Verify `skipped` dispatch shape from stratum-mcp — fix `build.js` if needed
3. Add stratum-mcp availability guard to `stratum-mcp-client.js`
4. Run full test suite — confirm 315 pass

### Phase 2: Dry run (validate plumbing)

Before burning API credits on a full run, validate the dispatch loop with a mock connector:

1. Write a `test/proof-run.test.js` integration test that uses `connectorFactory` override
2. Mock connector returns canned responses matching `output_contract` shapes
3. Verify: all 12 steps dispatch in order, skips fire, gates prompt, sub-flows execute, audit trail written

### Phase 3: Live run

Execute `compose build STRAT-1` with real inference backends:

```bash
node bin/compose.js build STRAT-1
```

Authentication uses `@anthropic-ai/claude-agent-sdk` with OAuth (`/login`), not API keys.

Human approves gates via readline. Monitor for:
- Clean skip of prd/architecture/report
- Design gate → approve → blueprint sequence
- Review sub-flow dispatches to Codex, fix dispatches to Claude
- Coverage sweep runs tests, fixes failures
- Ship gate → approve → audit written

### Phase 4: Validate output

After successful run, verify:
- [ ] `docs/features/STRAT-1/audit.json` exists with complete trace
- [ ] Trace includes all 12+ step outcomes (some skipped, some executed, some gated)
- [ ] `.compose/data/vision-state.json` has STRAT-1 item with status `complete`
- [ ] All gates resolved with `approve` outcome (gate-prompt returns `approve`/`revise`/`kill`, vision-writer stores as-is)
- [ ] Sub-flow traces nested inside parent steps
- [ ] 315+ tests still pass (no regressions from bug fixes)
- [ ] No manual intervention beyond gate approvals

---

## Validation Criteria

| Criterion | How verified |
|---|---|
| Full lifecycle execution | `audit.json` contains entries for all non-skipped steps |
| Gates enforced | `audit.json` shows `await_gate` → `approve` for design, plan, ship |
| Skips work | `audit.json` shows `skipped` for prd, architecture, report |
| Cross-agent dispatch | `audit.json` shows `codex` agent for review steps |
| Sub-flows execute | `audit.json` shows nested `review_fix` and `coverage_sweep` traces |
| Vision state updated | `vision-state.json` item status is `complete`, gates resolved |
| Test integrity | `npm test` reports 315+ pass, 0 fail |
| Audit trail complete | `audit.json` has `total_duration_ms` and `status: complete` |

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Codex unavailable | The spec hardcodes `agent: codex` for the review step (`build.stratum.yaml:53`), and the runner uses whatever agent the dispatch declares (`build.js:182`). **Options:** (a) Ensure Codex credentials are configured before the live run — this is the preferred path since cross-agent dispatch is a core validation goal. (b) If Codex is truly unavailable, edit `build.stratum.yaml` to use `agent: claude` for the review step — this reduces proof coverage but unblocks the run. There is no runtime agent override mechanism. |
| API rate limits during long run | Use sonnet for speed; review sub-flow has 10 retries built in |
| Stratum-mcp protocol mismatch | Verify dispatch shapes in dry run before live run |
| Agent produces invalid output_contract JSON | `result-normalizer.js` has 3-strategy extraction; build.js falls back to `{ summary: 'Step complete' }` |
| Gate timeout (3600s for design/plan) | Reasonable for human review; ship gate has 1800s |

---

## Files Modified

| File | Change | Status |
|---|---|---|
| `.compose/compose.json` | Create with valid config | new |
| `lib/stratum-mcp-client.js` | Add availability guard in `connect()` | existing |
| `lib/build.js` | Fix skipped dispatch if needed | existing |
| `test/proof-run.test.js` | Dry-run integration test with mock connector | new |

## Files Read-Only (reference)

| File | Why |
|---|---|
| `pipelines/build.stratum.yaml` | Spec under test |
| `lib/step-prompt.js` | Prompt construction |
| `lib/result-normalizer.js` | Output extraction |
| `lib/gate-prompt.js` | Gate resolution |
| `lib/vision-writer.js` | Vision state management |
| `server/connectors/claude-sdk-connector.js` | Claude dispatch |
| `server/connectors/codex-connector.js` | Codex dispatch |
