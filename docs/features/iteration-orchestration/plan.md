# Iteration Orchestration (L6): Implementation Plan

**Status:** PLAN
**Date:** 2026-03-06
**Blueprint:** [blueprint.md](./blueprint.md)
**Design:** [design.md](./design.md)

---

## Task Order

Tasks are sequential — each builds on the prior. Tasks 1-3 are server-side (no UI dependency). Task 4 is MCP wiring. Task 5 is client. Task 6 is the pipeline file. Tasks 7-9 are tests.

---

### Task 1: Add `ITERATION_DEFAULTS` to lifecycle-constants.js

**File:** `server/lifecycle-constants.js` (existing)

- [ ] Add `ITERATION_DEFAULTS` export after `TRANSITIONS` (line 27), before `PHASE_ARTIFACTS` (line 29)
- [ ] Shape: `{ review: { maxIterations: 10 }, coverage: { maxIterations: 15 } }`
- [ ] No changes to existing constants

**Test:** Verified in Task 7 (import and value assertions).

---

### Task 2: Add iteration methods to LifecycleManager

**File:** `server/lifecycle-manager.js` (existing)

- [ ] Add `iterationState: null` to lifecycle object after `policyOverrides: null` (line 55)
- [ ] Update import at line 16 to include `ITERATION_DEFAULTS`; update re-export at line 15
- [ ] Add `startIterationLoop(itemId, loopType, { maxIterations } = {})` after `approveGate` (line 203)
  - Rejects if `currentPhase !== 'execute'`
  - Rejects if a loop is already active (no `completedAt`)
  - Validates `loopType` against `ITERATION_DEFAULTS`
  - Creates `iterationState` with `loopId: iter-<uuid>`, `count: 0`, `iterations: []`
  - Persists via `this.#store.updateLifecycle()`
- [ ] Add `reportIterationResult(itemId, { clean, passing, summary, findings, failures })`
  - Increments `count`, pushes iteration to `iterations[]`
  - Evaluates exit criteria: `clean === true` for review, `passing === true` for coverage
  - If met: `outcome: 'clean'`, `continueLoop: false`
  - If `count >= maxIterations`: `outcome: 'max_reached'`, `continueLoop: false`
  - Returns `{ loopId, loopType, count, maxIterations, exitCriteriaMet, continueLoop, outcome }`
- [ ] Add `getIterationStatus(itemId)` — returns `iterationState` or `null`

**Test:** Task 7.

**Depends on:** Task 1.

---

### Task 3: Add iteration REST endpoints to vision-routes.js

**File:** `server/vision-routes.js` (existing)

- [ ] `POST /api/vision/items/:id/lifecycle/iteration/start` — calls `lifecycleManager.startIterationLoop`, broadcasts `iterationStarted` via `broadcastMessage()`
  - Payload: `{ itemId, loopId, loopType, maxIterations, timestamp }`
  - Also calls `scheduleBroadcast()` for state sync
- [ ] `POST /api/vision/items/:id/lifecycle/iteration/report` — calls `lifecycleManager.reportIterationResult`, broadcasts `iterationUpdate` (mid-loop) or `iterationComplete` (loop ended)
  - `iterationUpdate` payload: `{ itemId, loopId, loopType, count, maxIterations, exitCriteriaMet, continueLoop, timestamp }`
  - `iterationComplete` payload (when `continueLoop === false`): `{ itemId, loopId, loopType, outcome, finalCount: count, timestamp }`
- [ ] `GET /api/vision/items/:id/lifecycle/iteration` — calls `lifecycleManager.getIterationStatus`, returns state or 404

Insert after gate resolve endpoint (line 335), before summary endpoint (line 337). Pattern matches existing lifecycle/gate routes exactly.

**Test:** Task 8.

**Depends on:** Task 2.

---

### Task 4: Add MCP tool definitions and implementations

**Files:** `server/compose-mcp-tools.js` (existing), `server/compose-mcp.js` (existing)

**compose-mcp-tools.js:**

- [ ] Add `toolStartIterationLoop({ id, loopType, maxIterations })` — delegates to `_postLifecycle(id, 'iteration/start', ...)`
- [ ] Add `toolReportIterationResult({ id, clean, passing, summary, findings, failures })` — delegates to `_postLifecycle(id, 'iteration/report', ...)`
- [ ] Add `toolGetIterationStatus({ id })` — reads from disk via `loadVisionState()`, returns `item.lifecycle?.iterationState || { error: 'No iteration state' }`

Append after `toolGetPendingGates` (line 337).

**compose-mcp.js:**

- [ ] Add 3 tool definitions to `TOOLS` array before closing `];` (line 247):
  - `start_iteration_loop` — required: `id`, `loopType`; optional: `maxIterations`
  - `report_iteration_result` — required: `id`; optional: `clean`, `passing`, `summary`, `findings`, `failures`
  - `get_iteration_status` — required: `id`
- [ ] Add 3 switch cases before `default:` (line 283)
- [ ] Add 3 new imports from `compose-mcp-tools.js` (lines 29-45)

**Test:** MCP tool names verified in Task 8.

**Depends on:** Task 3 (tools delegate to REST endpoints).

---

### Task 5: Handle iteration messages in visionMessageHandler.js

**File:** `src/components/vision/visionMessageHandler.js` (existing)

- [ ] Add handler for `iterationStarted`, `iterationUpdate`, and `iterationComplete` between `gateResolved` (line 141) and `snapshotRequest` (line 143)
- [ ] Push activity entry to `setAgentActivity`: `{ tool: 'iteration', category: msg.loopType, detail, items: [], timestamp }`
  - `iterationStarted`: detail = `"${loopType} loop started (0/${maxIterations})"`
  - `iterationUpdate`: detail = `"${loopType} iteration ${count}/${maxIterations}"`
  - `iterationComplete`: detail = `"${loopType} loop complete (${outcome} after ${finalCount} iterations)"`
- [ ] On `iterationComplete` with `outcome === 'max_reached'`: call `setAgentErrors` with `errorType: 'iteration_limit'` and increment `sessionState.errorCount`
- [ ] Cap arrays: activity at 20, errors at 10 (matches existing patterns)

**Test:** Task 9.

**Depends on:** None (client-side only, can be done in parallel with Tasks 3-4 but listed here for clarity).

---

### Task 6: Create coverage-sweep.stratum.yaml

**File:** `pipelines/coverage-sweep.stratum.yaml` (new)

- [ ] Define `TestResult` contract: `{ passing: boolean, summary: string, failures: array }`
- [ ] `execute_tests` function: mode compute, retries 1
- [ ] `fix_and_test` function: mode compute, `ensure: result.passing == true`, retries 15
- [ ] `coverage_sweep` flow: execute → sweep (depends_on execute)

Pattern follows `pipelines/review-fix.stratum.yaml`.

**Validation:**

- [ ] YAML syntax: `python3 -c "import yaml; yaml.safe_load(open('pipelines/coverage-sweep.stratum.yaml'))"` (Python's PyYAML is available on macOS)
- [ ] Schema parity: verify `TestResult` contract matches `ReviewResult` structure in `review-fix.stratum.yaml` (both have `passing`/`summary`/`failures` or equivalent)
- [ ] Stratum plan validation: run `stratum_plan` with the pipeline to confirm it parses without errors (done during Phase 7 execution)

**Depends on:** None.

---

### Task 7: Write iteration-manager.test.js

**File:** `test/iteration-manager.test.js` (new)

- [ ] `startIterationLoop` creates iterationState with correct defaults (review: 10, coverage: 15)
- [ ] `startIterationLoop` rejects outside execute phase
- [ ] `startIterationLoop` rejects when loop already active
- [ ] `startIterationLoop` accepts maxIterations override
- [ ] `reportIterationResult` increments count
- [ ] `reportIterationResult` with `clean: true` completes review loop (`outcome: 'clean'`, `continueLoop: false`)
- [ ] `reportIterationResult` with `passing: true` completes coverage loop
- [ ] `reportIterationResult` at max iterations returns `outcome: 'max_reached'`
- [ ] `reportIterationResult` rejects when no active loop
- [ ] `getIterationStatus` returns null when no iteration
- [ ] `getIterationStatus` returns active state during loop

Pattern: follows `test/policy-engine.test.js` — import manager, create in-memory store, call methods directly.

**Depends on:** Tasks 1-2.

---

### Task 8: Write iteration-routes.test.js

**File:** `test/iteration-routes.test.js` (new)

- [ ] POST iteration/start returns loopId
- [ ] POST iteration/start requires loopType (400 without)
- [ ] POST iteration/start rejects outside execute phase (400)
- [ ] POST iteration/report returns continueLoop
- [ ] POST iteration/report with `clean: true` returns `continueLoop: false`
- [ ] POST iteration/report at max returns `outcome: 'max_reached'`
- [ ] GET iteration returns current state
- [ ] GET iteration returns 404 when no iteration
- [ ] Broadcast shapes: `iterationStarted` includes loopType, `iterationUpdate` includes loopType and count, `iterationComplete` includes outcome and finalCount
- [ ] `iterationComplete` broadcast sent only when `continueLoop === false`
- [ ] `compose-mcp.js` TOOLS array contains all 3 iteration tool names

Pattern: follows `test/lifecycle-routes.test.js` — Express + ephemeral port + in-memory store.

**Depends on:** Tasks 1-3.

---

### Task 9: Write iteration-client.test.js

**File:** `test/iteration-client.test.js` (new)

- [ ] `iterationStarted` adds activity entry with `tool: 'iteration'`, `category: loopType`, correct detail string
- [ ] `iterationUpdate` adds activity entry with count in detail
- [ ] `iterationComplete` with `outcome: 'clean'` adds activity entry with completion detail
- [ ] `iterationComplete` with `outcome: 'max_reached'` calls `setAgentErrors` with `errorType: 'iteration_limit'` and increments `sessionState.errorCount`
- [ ] Activity entries have empty `items` array

Pattern: follows `test/gate-client.test.js` — import `handleVisionMessage`, call with mock setters.

**Depends on:** Task 5.

---

## Execution Strategy

Tasks 1-4 are sequential (each depends on the prior). Task 5 and Task 6 are independent of each other and of Tasks 3-4 — they can be parallelized.

Recommended execution order:
1. Tasks 1-2 (constants + manager methods)
2. Task 7 (test the manager methods immediately)
3. Tasks 3-4 (routes + MCP wiring)
4. Tasks 5-6 in parallel (client handler + pipeline)
5. Tasks 8-9 in parallel (route tests + client tests)
6. Full test suite run + build verification

---

## Exit Criteria

- [ ] All 9 tasks complete
- [ ] `npm test` passes (existing tests + new iteration tests)
- [ ] `npm run build` passes
- [ ] No regressions in existing lifecycle/gate functionality
