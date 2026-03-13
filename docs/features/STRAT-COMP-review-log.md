# STRAT-COMP Design & Blueprint Review Log

**Date:** 2026-03-12
**Reviewer:** forge-reviewer (automated)
**Scope:** All STRAT-COMP-4 through STRAT-COMP-8 design docs and blueprints

## Aggregate Summary

### Per-Feature Reviews (Round 1)

| Feature | Verdict | P0 | P1 | P2 | Total |
|---------|---------|----|----|----| ------|
| STRAT-COMP-4 | ISSUES FOUND | 2 | 4 | 0 | 6 |
| STRAT-COMP-5 | ISSUES FOUND | 1 | 3 | 2 | 6 |
| STRAT-COMP-6 | ISSUES FOUND | 3 | 5 | 0 | 8 |
| STRAT-COMP-7 | ISSUES FOUND | 2 | 6 | 0 | 8 |
| STRAT-COMP-8 | ISSUES FOUND | 2 | 4 | 0 | 6 |
| **Totals** | | **10** | **22** | **2** | **34** |

### Integration Review (Round 1)

| # | Severity | Features | Description |
|---|----------|----------|-------------|
| A | P0 | STRAT-COMP-5 ↔ 8 | `violations` field: STRAT-COMP-5 writes string array, STRAT-COMP-8 expects numeric count. `build.violations > 0` is always truthy for non-empty array; renders `"[object Array] violations"`. |
| B | P0 | STRAT-COMP-6 ↔ 8 | Gate creation event name: STRAT-COMP-6 broadcasts `gateCreated`, STRAT-COMP-8 listens for `gatePending`. Dashboard never receives gate creation events. STRAT-COMP-4 blueprint also broadcasts `gatePending` — two blueprints define same endpoint with different event names. |
| C | P0 | STRAT-COMP-6 design ↔ 4+6 blueprints | Gate ID: design says server generates UUID, all blueprint code uses composite `flowId:stepId`. CLI polling code extracts `gateId` from response but response shape differs between design and blueprint. |
| D | P1 | STRAT-COMP-4 ↔ 8 | `featureCode` prefix stripping: STRAT-COMP-4 removes `feature:` prefix at source, STRAT-COMP-8 still has `displayFeatureName()` with `.replace(/^feature:/, '')`. Harmless but signals STRAT-COMP-8 was written against pre-STRAT-COMP-4 model. |
| E | P1 | STRAT-COMP-5 ↔ 8 | STRAT-COMP-5 writes ~40 lines into `StratumPanel.jsx` (ActiveBuildBanner, FlowList refresh). STRAT-COMP-8 deletes `StratumPanel.jsx` entirely. STRAT-COMP-5 tasks 12-13 are disposable work. |
| F | P1 | STRAT-COMP-4 blueprint ↔ 6 blueprint | Both define `POST /api/vision/gates` with conflicting validation: STRAT-COMP-4 requires `itemId`, STRAT-COMP-6 makes it optional. Two blueprints co-own same endpoint. |
| G | P1 | STRAT-COMP-7 ↔ 5 | `build_step_start` JSONL event writes `stepNum`/`totalSteps` without documenting they come from `response.step_number`/`response.total_steps` (established by STRAT-COMP-5). |
| H | P1 | STRAT-COMP-5 ↔ 8 | Per-step `violations` in `steps[]` is count integer (STRAT-COMP-8) but top-level `violations` is array (STRAT-COMP-5). Same field, different types in same `lib/build.js`. |

**Integration verdict: ISSUES FOUND — 8 findings (3 P0, 5 P1)**

---

## STRAT-COMP-4: Vision Store Unification

**Verdict: ISSUES FOUND — 6 findings (2 Critical, 4 Important)**

| # | Severity | Description | Location |
|---|----------|-------------|----------|
| 1 | P0 | `abortBuild()` at `build.js:564-568` calls `findFeatureItem()` and `updateItemStatus()` without `await`. After async refactor, `itemId` is always `undefined` — vision item never gets `killed` status on abort. Task 14 checklist omits these call sites. | blueprint.md Phase 3 Task 14, build.js:564-568 |
| 2 | P0 | `_restEnsureFeatureItem` two-step bootstrap not idempotent against migrated items. `POST /lifecycle/start` returns 400 if `item.lifecycle` already exists. Blueprint doesn't specify skipping `lifecycle/start` when item is found with existing lifecycle. | blueprint.md Component Designs vision-writer.js |
| 3 | P1 | `GET /api/vision/gates` only returns pending gates. Checkpoint 4 says "Gate appears in list" but after resolution it vanishes from list. Blueprint should clarify post-resolution access is via `/:id` only. | blueprint.md Checkpoint 4 |
| 4 | P1 | Design doc contradicts itself on liveness probe: Architecture section (line 53) says "checked at each gate, not cached" but STRAT-COMP-6 acceptance criteria (line 130) says "probes at build start, caches result." Design doc not corrected. | design.md:53 vs design.md:130 |
| 5 | P1 | `POST /api/vision/gates` route snippet accesses `store.gates` Map directly instead of using the `getGateByFlowStep()` method proposed in task 5. Breaks encapsulation pattern. | blueprint.md Component Designs vision-routes.js |
| 6 | P1 | AD-1 says "delete the `feature:*` field" but Risk Assessment row 3 says "preserves `featureCode` field." Direct contradiction — migration behavior undefined for implementers. | blueprint.md AD-1 vs Risk Assessment |

---

## STRAT-COMP-5: Build Visibility

**Verdict: ISSUES FOUND — 6 findings (1 P0, 3 P1, 2 P2)**

| # | Severity | Description | Location |
|---|----------|-------------|----------|
| 1 | P0 | `this.onBuildStateChanged` used inside `registerDataWatcher` closure — `this` is unbound in the standalone closure. Will throw `TypeError` at runtime. Blueprint line 215 documents the fix (`const self = this`) but the code block itself uses `this`. | blueprint.md:187, 215 |
| 2 | P1 | Blueprint line 257 ambiguously states `DATA_DIR` is "already available" — it is NOT imported in `vision-server.js`. Implementer may skip the import, causing `ReferenceError`. | blueprint.md:257 |
| 3 | P1 | Blueprint internally contradicts itself: section 7d says `FlowList` should call `useVisionStore()` directly, but risk table (line 373) says prop-drill from `StratumPanel`. Creates multiple WebSocket connections. | blueprint.md:342-343 vs 373 |
| 4 | P1 | `ensure_failed` block has no existing `updateActiveBuildStep()` call. Blueprint says "update callers" but there are no callers — a new call must be added, not modified. | blueprint.md:125, build.js:269-284 |
| 5 | P2 | `activeBuild` added to `useVisionStore` state but not listed in the return object update — missing from build sequence task list. | blueprint.md:291-293 |
| 6 | P2 | Design edge case table (line 213) claims "FS events trigger watch attempt on first file write" — no such mechanism exists. Contradicts "no change needed" claim on line 96. | design.md:96, 213 |

---

## STRAT-COMP-6: Web Gate Resolution

**Verdict: ISSUES FOUND — 8 findings (3 P0, 5 P1)**

| # | Severity | Description | Location |
|---|----------|-------------|----------|
| 1 | P0 | `createGate()` return type ambiguity: REST path returns full gate object, direct-write returns string ID. Polling code expects string — type mismatch causes broken `getGate()` call in REST path. | blueprint.md:113,247; vision-writer.js:155 |
| 2 | P0 | GateView summary bar references `resolvedToday` after Change 5 renames variable to `resolved` — runtime crash (`resolvedToday is not defined`). | blueprint.md:463-507; GateView.jsx:251 |
| 3 | P0 | `GET /api/vision/gates` only returns pending gates via `getPendingGates()`. Resolved gate history can never reach GateView — Change 5 (gate history section) cannot work. | vision-routes.js:301-308; vision-store.js:238-246 |
| 4 | P1 | Poll timeout: design says 24 hours, blueprint says 30 minutes. Direct contradiction, not listed in corrections table. | design.md §3.2; blueprint.md AD-4 |
| 5 | P1 | Gate IDs contain `:` characters (`flowId:stepId`). Polling `fetch` URL must `encodeURIComponent(gateId)` or Express routing breaks. Blueprint omits this. | blueprint.md:205-210 |
| 6 | P1 | Child flow gate `fromPhase` always null — shows "Unknown → ..." in web UI despite data being available via `visionWriter.findFeatureItem()` which is in scope. | blueprint.md:289-294; build.js:400 |
| 7 | P1 | `POST /api/vision/gates` response shape contradicts design: full gate object vs `{ gateId }`. No agreed contract for `_restCreateGate()` field extraction. | design.md §3.1; blueprint.md:135 |
| 8 | P1 | Outcome vocabulary inconsistency: readline fallback stores imperative (`approve`) via VisionWriter, web UI stores past-tense (`approved`) via VisionStore. Same field, different values per path. | vision-writer.js:177; gate-prompt.js:10-16 |

---

## STRAT-COMP-7: Agent Stream Bridge

**Verdict: ISSUES FOUND — 8 findings (2 P0, 6 P1)**

| # | Severity | Description | Location |
|---|----------|-------------|----------|
| 1 | P0 | Byte cursor uses string `.length` (UTF-16 code units) vs byte length. Non-ASCII characters (em dashes, Unicode paths) corrupt cursor — subsequent reads re-process or skip events silently. | design.md:196 |
| 2 | P0 | File rotation cursor reset only checks `stat.size < cursor`. If new build file grows past old cursor before bridge wakes, `build_start` and early events are silently dropped. Must use inode-based detection (`stat.ino`). | design.md:458; blueprint.md:134 |
| 3 | P1 | `_pollForDirectory` → `start()` re-entrancy: if `fs.watch()` throws for non-directory reasons (permissions, too many watchers), creates unbounded interval accumulation. | design.md:212-219 |
| 4 | P1 | `build_gate_resolved` in JSONL schema and bridge mapping but absent from design's SSE mapping table and `MessageCard.jsx` renderers. Gate resolution events invisible in UI. | design.md:258-267; blueprint.md:148 |
| 5 | P1 | `streamWriter` not passed to `runAndNormalize()` in `ensure_failed`/`schema_failed` retry branches (build.js:275) or any of three child flow call sites (build.js:386,444,453). Retry tool calls invisible in stream. | blueprint.md T4/T5; build.js:275,386,444,453 |
| 6 | P1 | Concurrent build + interactive session status bar behavior unspecified. `build_end` idle debounce interaction with existing idle timer undocumented. | AgentStream.jsx:129-137; blueprint.md:462 |
| 7 | P1 | Checkpoint 4 only tests "new file smaller than cursor" subcase. The "new file larger than cursor" case silently fails — test gives false confidence. | blueprint.md:443-445 |
| 8 | P1 | `build_error` write point ambiguous — placed in `result-normalizer.js` after a `throw`, making it unreachable. Should be in `build.js` try/catch around `runAndNormalize()`. | result-normalizer.js:150-152; blueprint.md Component 5 |

---

## STRAT-COMP-8: Active Build Dashboard

**Verdict: ISSUES FOUND — 6 findings (2 Critical, 4 Important)**

| # | Severity | Description | Location |
|---|----------|-------------|----------|
| 1 | P0 | Tab label changes unconditionally (`'Stratum'` → `'Build'`), breaking feature flag revert semantics. If `USE_BUILD_DASHBOARD = false`, tab says "Build" but renders `<StratumPanel />`. | blueprint.md:654 |
| 2 | P0 | `activeBuild` will be `undefined` (not `null`) until STRAT-COMP-5 is done. Dashboard silently shows "No active build" even when a build is running — silent correctness failure, hard to diagnose. | blueprint.md:106–109 |
| 3 | P1 | 60-second audit collapse timer (`setTimeout`) not cleaned up on `BuildDashboard` unmount. Produces React warning on state update to unmounted component. | blueprint.md:117 |
| 4 | P1 | Collapse threshold wording ambiguous: "more than 6" (exclusive) vs `>= 6` (inclusive). No test for exactly 6 completed steps. | design §3.3 vs blueprint behavioral tests |
| 5 | P1 | `border-l-warning` token (design §7) vs `border-l-amber-400` (blueprint). If CSS variable not defined, border is invisible. Design and blueprint contradict. | design §7 vs blueprint §4 GateAlert |
| 6 | P1 | Retry/violation tracking in `ensure_failed` handler missing null-guard after `readActiveBuild()`, inconsistent with pattern in sibling code block. | blueprint.md:590–601 |

---

## Cross-Cutting Themes

### 1. Dependency sequencing is fragile
STRAT-COMP-4 is a prerequisite for 5, 6, 7, 8 — but multiple blueprints assume STRAT-COMP-4 changes are in source when they aren't. The async VisionWriter refactor, gate status normalization, and `getGateByFlowStep()` are referenced as existing. Implementation must be strictly sequential.

### 2. Gate endpoint returns only pending gates
Both STRAT-COMP-4 and STRAT-COMP-6 reference gate history features, but `GET /api/vision/gates` calls `getPendingGates()` which filters out resolved gates. This blocks the gate history UX in both STRAT-COMP-6 and STRAT-COMP-8.

### 3. Outcome vocabulary divergence
VisionWriter stores imperative (`approve`), VisionStore stores past-tense (`approved`). No normalization layer exists. Affects STRAT-COMP-4 (unification) and STRAT-COMP-6 (gate delegation).

### 4. `active-build.json` field extensions
STRAT-COMP-5 blueprint adds `stepNum, totalSteps, retries, violations`. STRAT-COMP-8 blueprint adds `steps[]` array. These must be coordinated — both modify `writeActiveBuild()` and `updateActiveBuildStep()` in `build.js`.

### 5. Blueprint code samples contain bugs
Multiple blueprints have code snippets with runtime errors (`this` binding, stale variable references, missing null guards). Code samples must be treated as pseudocode, not copy-paste implementations.
