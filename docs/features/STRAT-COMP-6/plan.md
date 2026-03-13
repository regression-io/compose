# STRAT-COMP-6: Web Gate Resolution — Implementation Plan

**Status:** COMPLETE
**Created:** 2026-03-13
**Blueprint:** [blueprint.md](./blueprint.md)
**Design:** [design.md](./design.md)

---

## Prerequisites

**Polling contract:** This plan follows the authoritative reviewed contract: no client-side timeout, `expired` is fatal, 404 is fatal, and only mid-poll server loss (3 consecutive probe failures) may fall back to readline when TTY is available.

STRAT-COMP-4 (Vision Store Unification) is **not yet complete**. The following prerequisites are missing and must be built as part of this plan:

- `lib/server-probe.js` does not exist
- `VisionWriter` has no async dual dispatch, no `_restCreateGate()`, no `getGate()`
- `VisionStore` has no `getGateByFlowStep()` or `getAllGates()`
- No `POST /api/vision/gates` creation endpoint

Tasks 1–3 cover these prerequisites inline. If STRAT-COMP-4 ships first, these tasks become verification-only (confirm deliverables exist with expected API). If STRAT-COMP-6 ships first, these tasks create the modules and STRAT-COMP-4 skips its equivalent tasks.

Cross-feature contract rules for this plan:

- API port resolution must match STRAT-COMP-4 exactly: `COMPOSE_PORT > PORT > 3001`
- Gate REST payloads must use the STRAT-COMP-4 shape; `artifactAssessment` is out of scope for v1
- If the server probe succeeds and a gate REST call fails, the CLI exits with an error — no readline fallback

---

## Task 1: Create `lib/server-probe.js`

**Files:** `lib/server-probe.js` (new)
**Depends on:** --

**Acceptance criteria:**
- [ ] Exports `probeServer(port, timeoutMs)` function
- [ ] Default port uses `resolvePort()` from `lib/resolve-port.js` (STRAT-COMP-4 Task 1a) — full chain `COMPOSE_PORT > PORT > 3001`
- [ ] Default timeout is `500` ms
- [ ] Calls `GET /api/health` with `AbortSignal.timeout(timeoutMs)`
- [ ] Returns `true` if response is 2xx from `GET /api/health`, `false` on any error or timeout (matches STRAT-COMP-4 contract)
- [ ] Does not throw — all errors are caught and return `false`

---

## Task 2: Add `getGateByFlowStep()` and `getAllGates()` to VisionStore

**Files:** `server/vision-store.js` (existing)
**Depends on:** --

**Acceptance criteria:**
- [ ] `getGateByFlowStep(flowId, stepId, round)` returns the gate matching composite key `${flowId}:${stepId}:${round}` or `null`
- [ ] `getAllGates()` returns all gates (pending + resolved + expired) as an array
- [ ] Both methods work with the existing `this.gates` Map
- [ ] `loadFromFile()` normalizes legacy past-tense outcomes (`approved->approve`, `revised->revise`, `killed->kill`) on load

---

## Task 3: Add `POST /api/vision/gates` creation endpoint, `GET /api/vision/gates/:id`, and `?status` query param

**Files:** `server/vision-routes.js` (existing)
**Depends on:** Task 2

**Acceptance criteria:**
- [ ] `POST /api/vision/gates` accepts `{ flowId, stepId, round, itemId, fromPhase, toPhase, artifact, options, summary, comment }` (matches STRAT-COMP-4 gate contract — no `artifactAssessment` in v1)
- [ ] Returns 400 if `flowId` or `stepId` is missing
- [ ] `round` defaults to `1` if not provided
- [ ] Idempotent: if gate with same ID already exists (any status), returns 200 with existing gate (matches STRAT-COMP-4 convention)
- [ ] Creates gate with deterministic ID `${flowId}:${stepId}:${round}`, status `pending`, `createdAt`
- [ ] Broadcasts `gateCreated` WebSocket message on creation (note: STRAT-COMP-8 listens for `gateCreated`, not `gatePending`)
- [ ] Returns 201 with full gate object on new creation
- [ ] `GET /api/vision/gates/:id` returns full gate object or 404 if not found (used by CLI polling)
- [ ] `GET /api/vision/gates` accepts `?status` query param: `pending` (default), `resolved`, `all`
- [ ] Existing `?itemId` filtering composes with `?status` (e.g., `?status=all&itemId=X`)
- [ ] Default `GET /api/vision/gates` (no param) still returns pending-only for backwards compatibility
- [ ] **Gate expiry:** Pending gates older than `COMPOSE_GATE_TIMEOUT` (default 30 min, from env var) are lazily marked `status: "expired"` on access in `GET /api/vision/gates` and `GET /api/vision/gates/:id`. Expired gates are excluded from the active review queue. CLI treats `expired` as fatal (see Task 5)
- [ ] `POST /api/vision/gates/:id/resolve` accepts imperative outcomes (`approve`, `revise`, `kill`); normalizes legacy past-tense inputs
- [ ] `POST /api/vision/gates/:id/resolve` on already-resolved gate returns 200 (idempotent no-op, does not overwrite previous resolution)
- [ ] `POST /api/vision/gates/:id/resolve` does NOT call `stratum.gateResolve()` or advance lifecycle
- [ ] Gate IDs containing `:` are URL-decoded via `decodeURIComponent(req.params.id)` in route handlers

---

## Task 4: Extend `VisionWriter.createGate()` with extras and add `getGate()`

**Files:** `lib/vision-writer.js` (existing)
**Depends on:** Task 3

**Acceptance criteria:**
- [ ] `createGate(flowId, stepId, itemId, extras = {})` accepts optional `{ round, fromPhase, toPhase, artifact, options, summary, comment }` (matches STRAT-COMP-4 gate contract — no `artifactAssessment` in v1)
- [ ] `round` defaults to `1` if not in extras
- [ ] Gate ID format: `${flowId}:${stepId}:${round}`
- [ ] Direct-write path: merges extras into the gate object written to `vision-state.json`
- [ ] REST path (`_restCreateGate`): POSTs all fields to `POST /api/vision/gates`, extracts and returns `gate.id` as a string
- [ ] `createGate()` returns a string gate ID in both paths
- [ ] `getGate(gateId, opts?)` added — REST path: `GET /api/vision/gates/${encodeURIComponent(gateId)}`; direct path: loads state, finds gate by ID. Supports `{ requireServer: true }` option: when set, throws `ServerUnreachableError` on probe failure instead of falling back to direct read (used by `pollGateResolution()` to detect mid-poll server loss)
- [ ] `resolveGate(gateId, outcome, comment?)` normalizes legacy past-tense outcomes to imperative: `approved->approve`, `revised->revise`, `killed->kill`; passes `comment` to `POST /api/vision/gates/:id/resolve { outcome, comment }`
- [ ] Probe-based dispatch: uses `probeServer()` to decide REST vs. direct path

---

## Task 5: Add `pollGateResolution()` and outcome mapping to `build.js`

**Files:** `lib/build.js` (existing)
**Depends on:** Task 1, Task 4

**Acceptance criteria:**
- [ ] Imports `probeServer` from `./server-probe.js`
- [ ] `pollGateResolution(visionWriter, gateId, intervalMs = 2000)` polls (signature matches STRAT-COMP-4 Task 17). `GATE_POLL_INTERVAL` constant removed in favor of the default parameter `visionWriter.getGate(gateId, { requireServer: true })` every 2s
- [ ] Returns resolved gate object when `status === 'resolved'`
- [ ] Continues polling while `status === 'pending'` — there is no client-side timeout in v1
- [ ] If `status === 'expired'`, throws a fatal error immediately
- [ ] Consecutive probe failure counter (via `{ requireServer: true }` throws): after 3 consecutive `ServerUnreachableError`s, returns `null` to signal mid-poll server loss; counter resets on any successful poll
- [ ] 404 response throws a fatal error immediately (gate lost, not retryable)
- [ ] `makeAskAgent(context)` factory extracted from duplicated `askAgent` closures
- [ ] `GATE_ARTIFACTS` map: `{ design_gate: 'design.md', prd_gate: 'prd.md', architecture_gate: 'architecture.md', plan_gate: 'plan.md', report_gate: 'report.md' }` for artifact path derivation

---

## Task 6: Replace main-loop `await_gate` block in `build.js`

**Files:** `lib/build.js` (existing)
**Depends on:** Task 5

**Acceptance criteria:**
- [ ] Main-loop `await_gate` block (around lines 217-247) replaced with probe/branch logic
- [ ] Gate enrichment built from available context: `fromPhase` from item lifecycle, `toPhase` from `response.on_approve`, `artifact` from `GATE_ARTIFACTS` map resolved to feature path, `summary` from `response.summary` or shared `STEP_LABELS` fallback chain
- [ ] `round` passed from Stratum step retry count (default `1`)
- [ ] Server running path: creates gate via `visionWriter.createGate()` with extras, polls for resolution, calls `stratum.gateResolve(flowId, stepId, outcome, comment, 'human')`
- [ ] Mid-poll server-loss path: when `pollGateResolution()` returns `null`, fall back to readline prompt only if TTY is available; otherwise exit with error
- [ ] Server-down path: creates gate with extras via direct write, uses readline prompt (if TTY) or exits with error code 1 and message "Gate pending but no TTY for readline and server is unreachable. Start the server or run interactively." (if non-interactive) — matches STRAT-COMP-4 canonical error message
- [ ] Server probe succeeds but `POST /api/vision/gates` fails: exits with error (fatal per STRAT-COMP-4 REST failure semantics — no readline fallback when server is up but REST fails, as that would bypass server state)
- [ ] After readline fallback, attempts `visionWriter.resolveGate()` via REST to sync server state (tolerates failure)

---

## Task 7: Replace child-flow `await_gate` block in `build.js`

**Files:** `lib/build.js` (existing)
**Depends on:** Task 6

**Acceptance criteria:**
- [ ] `executeChildFlow()` gate block (around lines 397-426) replaced with same probe/branch/poll pattern
- [ ] Uses `childFlowId` (not parent `flowId`) in gate creation — produces unique composite keys per child flow
- [ ] `itemId` may be `null` for child flows without direct item mapping
- [ ] Server running path: delegated gate with child flow ID, polls, resolves
- [ ] Mid-poll server-loss + server-down fallbacks identical to main loop (including TTY check)
- [ ] Non-interactive mode: server lost during polling triggers build exit with error
- [ ] `makeAskAgent()` used instead of inline `askAgent` closure

---

## Task 8: Apply same gate delegation pattern to `lib/new.js`

**Files:** `lib/new.js` (existing)
**Depends on:** Task 5

**Acceptance criteria:**
- [ ] Main-loop gate block (around line 184) updated with same probe/branch/poll pattern as `build.js`
- [ ] Child-flow gate block (around line 346) updated with same pattern
- [ ] Uses same `pollGateResolution()`, `GATE_ARTIFACTS` map, and fallback rules as `build.js`
- [ ] Payload derivation: `flowId`/`stepId`/`round` from Stratum dispatch, `itemId` from `visionWriter.findFeatureItem()`, enrichment fields derived the same way as in `build.js`
- [ ] Non-interactive mode handling identical to `build.js`

---

## Task 9: Add summary display and artifact link to GateView

**Files:** `src/components/vision/GateView.jsx` (existing)
**Depends on:** Task 3

**Acceptance criteria:**
- [ ] `gate.summary` renders in `PendingGateRow` between phase transition and the artifact/action area (conditional — skipped when null)
- [ ] `gate.artifact` renders as clickable monospace link that calls `POST /api/canvas/open` with the path
- [ ] Both elements use `text-[10px] text-muted-foreground` styling consistent with existing UI

---

## Task 10: Add build-gate prominence to GateView

**Files:** `src/components/vision/GateView.jsx` (existing)
**Depends on:** Task 9

**Acceptance criteria:**
- [ ] PendingGateRow outer div has `border-l-amber-400/50` left border when `gate.flowId` is truthy
- [ ] Action buttons use `h-8 text-xs` (larger) when `gate.flowId` is truthy, `h-6 text-[10px]` otherwise
- [ ] Non-build gates (no `flowId`) render without amber border (transparent border)

---

## Task 11: Add feature grouping to GateView

**Files:** `src/components/vision/GateView.jsx` (existing)
**Depends on:** Task 10

**Acceptance criteria:**
- [ ] Pending gates grouped by `itemId` via `useMemo`
- [ ] When multiple groups exist, each group renders under a feature header showing item title
- [ ] Single-group with `itemId` present still shows feature header (provides context)
- [ ] Feature header omitted only when there is exactly one gate with no `itemId` (ungrouped child flow gate)
- [ ] `__ungrouped__` key used for gates without `itemId`; renders under "Other" group header
- [ ] Stale `itemId` fallback: gate with `itemId` referencing missing item shows truncated ID string (e.g., `"Item abc1234…"`)

---

## Task 12: Convert resolved section to collapsible gate history

**Files:** `src/components/vision/GateView.jsx` (existing)
**Depends on:** Task 3, Task 11

**Acceptance criteria:**
- [ ] Resolved gates read from `gates` prop (populated by `visionState` WebSocket broadcast via `VisionStore.getState()`), not from a separate REST fetch
- [ ] `resolved` array includes all resolved gates (not just today), sorted most recent first
- [ ] Resolved section collapsed by default with `useState(false)`
- [ ] Toggle button shows count badge with `resolved.length`
- [ ] Expanding shows all resolved gates sorted by most recent first
- [ ] Resolved section uses green dot indicator consistent with existing design
- [ ] Gates with null enrichment fields (`fromPhase`, `toPhase`, `artifact` all null) render without errors

---

## Task 13: Migrate outcome vocabulary to imperative in GateView and ItemDetailPanel

**Files:** `src/components/vision/GateView.jsx` (existing), `src/components/vision/ItemDetailPanel.jsx` (existing)
**Depends on:** Task 3

**Acceptance criteria:**
- [ ] `GateView.jsx` `onResolve` calls send imperative outcomes (`approve`, `revise`, `kill`) instead of past-tense (`approved`, `revised`, `killed`)
- [ ] `outcomeColors` map keys in `ResolvedGateRow` updated to imperative form
- [ ] `ItemDetailPanel.jsx` `onResolveGate` calls updated from past-tense to imperative
- [ ] `outcomeColors` map keys in `ItemDetailPanel.jsx` updated to imperative form
- [ ] Phase transition and gate step labels use shared `STEP_LABELS` from `lib/constants.js`, with title-case fallback for unknown step IDs

---

## Task 14: Update `visionMessageHandler.js` and `useVisionStore.js`

**Files:** `src/components/vision/visionMessageHandler.js` (existing), `src/components/vision/useVisionStore.js` (existing)
**Depends on:** Task 3

**Acceptance criteria:**
- [ ] `visionMessageHandler.js` listens for `gateCreated` instead of `gatePending`
- [ ] `useVisionStore.js` URL-encodes gate IDs with `encodeURIComponent()` in all REST paths
- [ ] Both files align with `gateCreated` event name

---

## Task 15: Replace StratumPanel gate display with GateView link

**Files:** `src/components/StratumPanel.jsx` (existing), `src/components/vision/VisionTracker.jsx` (existing)
**Depends on:** Task 12
**Note:** StratumPanel changes are transitional — STRAT-COMP-8 deletes StratumPanel.jsx entirely. Minimize investment here.

**Acceptance criteria:**
- [ ] `StratumPanel.jsx` gate list rendering removed; replaced with "View gates in sidebar" text link
- [ ] Link writes `sessionStorage.setItem('vision-activeView', 'gates')` and dispatches `window.dispatchEvent(new Event('vision-view-change'))`
- [ ] `VisionTracker.jsx` adds event listener for `vision-view-change` that reads from `sessionStorage` and calls `setActiveView()`
- [ ] Cross-panel communication avoids prop threading through unrelated component trees

---

## Task 16: Create shared `STEP_LABELS` constant

**Files:** `lib/constants.js` (new)
**Depends on:** --

**Acceptance criteria:**
- [ ] Exports shared `STEP_LABELS` map containing the canonical STRAT-COMP-4 labels for lifecycle, review, and gate steps
- [ ] Gate label values match STRAT-COMP-4 exactly, including `design_gate: 'Design Gate'`, `prd_gate: 'PRD Gate'`, `plan_gate: 'Plan Gate'`, `architecture_gate: 'Architecture Gate'`, `report_gate: 'Report Gate'`, `ship_gate: 'Ship Gate'`
- [ ] This is the single canonical label source — STRAT-COMP-8's `build-utils.js` must import from here, not define its own
- [ ] Importable by both CLI (`lib/build.js`, `lib/new.js`) and frontend (if bundled)
- [ ] Used everywhere step/gate labels are needed (`build.js`, `new.js`, `GateView.jsx`, related helpers) instead of defining feature-local label maps
- [ ] Used in summary fallback chain: `"${STEP_LABELS[stepId]} for ${featureCode}"`, then title-case of `stepId`, then `"Gate: ${stepId}"`

---

## Task 17: Integration smoke test

**Files:** -- (manual verification)
**Depends on:** Tasks 1–16

**Acceptance criteria:**
- [ ] `node --check` passes on all modified server/lib files
- [ ] `npm run build` succeeds (Vite build for client)
- [ ] Gate creation endpoint responds correctly: 201 for new, 200 for dedup, 400 for missing fields
- [ ] `GET /api/vision/gates/:id` returns full gate object; 404 for nonexistent gate
- [ ] `?status=all` returns both pending and resolved gates
- [ ] `?status=resolved` returns only resolved gates
- [ ] GateView renders pending gates with summary, artifact link, and prominence styling
- [ ] Gate history section collapses/expands correctly
- [ ] Outcome vocabulary is imperative throughout (no past-tense `approved`/`revised`/`killed` in UI or store)
- [ ] StratumPanel shows "View gates in sidebar" link instead of duplicate gate list
- [ ] Non-interactive mode: server unreachable + no TTY exits with error code 1
- [ ] Gate with `round: 2` (revise retry) gets unique ID distinct from `round: 1`
