# COMP-BUDGET Implementation Plan

**Items:** 141-144
**Scope:** Iteration budget enforcement — auto-abort on ceiling hit, cumulative tracking, policy integration.

## Architecture

The iteration loop is server-driven: `POST /api/vision/items/:id/lifecycle/iteration/report` in `vision-routes.js:303-334` already checks `count >= maxIterations`. COMP-BUDGET extends this with two new ceilings (wall-clock timeout, action count) and adds cumulative cross-session tracking.

**What exists:**
- `maxIterations` checked at report time (vision-routes.js:320)
- Defaults: review=4, coverage=15 (vision-server.js:43-46)
- Settings UI overrides (settings-store.js:125-128)
- `iterationState.startedAt` timestamp already tracked

**What's new:**
- Wall-clock timeout: checked at each report, auto-abort if elapsed > limit
- Action count: agent reports `actionCount` in result, checked against ceiling
- Cumulative ledger: per-feature iteration totals across sessions
- Policy integration: ceilings configurable per phase in settings

## Tasks

### Task 1: Wall-clock timeout enforcement

**File:** `compose/server/vision-routes.js` (existing)

- [ ] In iteration report handler (~line 303): after count check, add elapsed time check
  - `const elapsed = Date.now() - new Date(iter.startedAt).getTime()`
  - `const timeoutMs = (iter.wallClockTimeout ?? 30) * 60 * 1000` (default 30 min)
  - If `elapsed > timeoutMs`: set outcome to `'timeout'`, complete the loop
- [ ] In iteration start handler (~line 275): accept `wallClockTimeout` (minutes) from request body, store in iterationState
- [ ] Broadcast `iterationComplete` with `outcome: 'timeout'` and `elapsedMinutes`

### Task 2: Action count ceiling

**File:** `compose/server/vision-routes.js` (existing)

- [ ] In iteration report handler: check `result.actionCount` against ceiling
  - `iter.totalActions = (iter.totalActions ?? 0) + (result.actionCount ?? 0)`
  - If `iter.maxActions` is set and `iter.totalActions >= iter.maxActions`: outcome = `'action_limit'`
- [ ] In iteration start handler: accept `maxActions` from request body (optional)
- [ ] Update iterationState schema: add `totalActions`, `maxActions`, `wallClockTimeout`

### Task 3: Cumulative budget ledger

**File:** `compose/lib/budget-ledger.js` (new)

- [ ] Export `readLedger(composeDir)` → reads `.compose/data/budget-ledger.json`, returns `{ features: { [code]: { totalIterations, totalActions, totalTimeMs, sessions } } }`
- [ ] Export `recordIteration(composeDir, featureCode, { iterations, actions, timeMs })` → appends to ledger
- [ ] Export `checkCumulativeBudget(composeDir, featureCode, limits)` → returns `{ exceeded: bool, reason, usage }` 
- [ ] Cumulative limits from settings: `iterations.review.maxTotal` and `iterations.coverage.maxTotal` (see Task 4), `maxTotalCostUsd` (future, placeholder)

**File:** `compose/server/vision-routes.js` (existing)

- [ ] In iteration report handler (vision-routes.js:303-334): after `iter.status` becomes `'complete'` (exit criteria met at line 318-319 OR max_reached at line 320-321), call `recordIteration()` to update ledger
- [ ] In iteration abort handler (vision-routes.js:336-351): after `iter.status` becomes `'complete'` with outcome `'aborted'` (line 343), call `recordIteration()` to update ledger
- [ ] In iteration start handler: call `checkCumulativeBudget()`, reject with 429 if exceeded

### Task 4: Policy integration

**File:** `compose/server/vision-server.js` (existing) and `compose/server/settings-store.js` (existing)

- [ ] Add settings fields under existing `iterations` shape (matches `iterations.review.*` / `iterations.coverage.*` in settings-store.js:65-67):
  - `iterations.review.timeout` (minutes, default 15)
  - `iterations.coverage.timeout` (minutes, default 30)
  - `iterations.review.maxTotal` (cumulative across sessions, default 20)
  - `iterations.coverage.maxTotal` (cumulative across sessions, default 50)
- [ ] Update `iterationDefaults` in vision-server.js:43-46 to include `timeout` and `maxTotal` alongside existing `maxIterations`
- [ ] Settings validation: timeout 1-120 min, maxTotal 1-200
- [ ] In iteration start: read settings for loop-type-specific defaults (e.g., `settings.iterations[loopType].timeout`)

### Task 5: Client-side budget visibility

**File:** `compose/src/components/vision/visionMessageHandler.js` (existing)

- [ ] Handle `timeout` and `action_limit` outcomes alongside `max_reached`
- [ ] Show elapsed/budget info in iteration state (for ops strip display)

### Task 6: Tests

**File:** `compose/test/budget-ledger.test.js` (new)

- [ ] Test: readLedger returns empty on missing file
- [ ] Test: recordIteration creates ledger file and appends
- [ ] Test: checkCumulativeBudget returns exceeded when over limit
- [ ] Test: wall-clock timeout triggers at report time
- [ ] Test: action count ceiling triggers at report time
- [ ] Test: cumulative budget blocks iteration start when exceeded
