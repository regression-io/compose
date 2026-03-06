# Session-Lifecycle Binding: Implementation Plan

**Status:** COMPLETE
**Date:** 2026-03-06
**Roadmap item:** 26 (Phase 6, L5)

## Related Documents

- [Design](design.md)
- [Blueprint](blueprint.md)

---

## Context

Sessions and lifecycle features are independent tracking systems. The session manager accumulates tool-use events and Haiku summaries; the lifecycle manager tracks which phase each feature is in. But they don't know about each other. This plan implements the binding between them — tagging sessions to features, enriching activity with phase context, auto-filing transcripts, and providing feature-aware handoff context.

All server infrastructure is new. Client changes are additive (new WS handler, enriched session display, session history section).

---

## Task Order

### Task 1: Core binding infrastructure (server)

**Files:**
- `server/session-manager.js` (existing) — constructor options, binding fields, `bindToFeature()`, `phaseAtEnd` capture, `_fileTranscript()`, `getContext(featureCode)`, `sessionsFile` getter
- `server/session-store.js` (existing) — add binding fields to `serializeSession`, add `readSessionsByFeature()`
- `server/vision-store.js` (existing) — add `getItemByFeatureCode()`

**Pattern:** Follow existing `SessionManager` method patterns (`recordActivity`, `recordError`). `readSessionsByFeature` follows `readLastSession` pattern.

**Test first:**
- [ ] `bindToFeature` sets fields on active session
- [ ] `bindToFeature` returns `already_bound` on re-bind
- [ ] `bindToFeature` throws with no active session
- [ ] `endSession` captures `phaseAtEnd` for bound sessions
- [ ] `endSession` copies transcript to feature folder (verify file exists)
- [ ] `endSession` preserves original transcript extension
- [ ] `serializeSession` includes all binding fields
- [ ] `readSessionsByFeature` filters and sorts correctly
- [ ] `getItemByFeatureCode` returns correct item or null
- [ ] `getContext(featureCode)` returns feature-scoped session

**Depends on:** Nothing — pure server-side, no routes needed.

---

### Task 2: Binding routes and broadcasts (server)

**Files:**
- `server/session-routes.js` (existing) — add `POST /api/session/bind`, `GET /api/session/history`, enrich `sessionEnd` broadcast, enrich `GET /api/session/current` with binding fields + `featureCode` query param + `_buildFeatureContext` helper
- `server/index.js` (existing) — change `new SessionManager()` at line 57 to pass `{ getFeaturePhase, featureRoot }` options (uses `visionStore` from line 56)
- `server/vision-server.js` (existing) — pass `store: this.store` to `attachSessionRoutes` deps at line 52-58

**Pattern:** Follow existing route handlers in `session-routes.js`. Broadcast follows `sessionStart`/`sessionEnd` pattern.

**Test first:**
- [ ] `POST /api/session/bind` with valid featureCode → 200, session bound, `sessionBound` broadcast
- [ ] `POST /api/session/bind` with no active session → 409
- [ ] `POST /api/session/bind` with missing featureCode → 400
- [ ] `POST /api/session/bind` on already-bound session → 200, `already_bound: true`
- [ ] `GET /api/session/history?featureCode=X` returns filtered sessions
- [ ] `GET /api/session/history` with missing featureCode → 400
- [ ] `GET /api/session/current?featureCode=X` returns live session when bound to X
- [ ] `GET /api/session/current?featureCode=X` returns last persisted when active session is for different feature
- [ ] `GET /api/session/current?featureCode=X` returns last persisted + lifecycle when no active session
- [ ] All three `featureCode` branches return consistent shape: `{ session, lifecycle, recentSummaries }`
- [ ] `sessionEnd` broadcast includes `featureCode` and `phaseAtEnd`

**Depends on:** Task 1.

---

### Task 3: Activity phase enrichment (server)

**Files:**
- `server/activity-routes.js` (existing) — one-line change to items mapping

**Change:**
```js
// line 84, FROM:
items: items.map(i => ({ id: i.id, title: i.title, status: i.status }))
// TO:
items: items.map(i => ({ id: i.id, title: i.title, status: i.status, phase: i.lifecycle?.currentPhase || null }))
```

**Test first:**
- [ ] `agentActivity` broadcast includes `phase` field on resolved items with lifecycle
- [ ] `agentActivity` broadcast has `phase: null` on items without lifecycle

**Depends on:** Nothing — independent one-line change.

---

### Task 4: MCP tools (server)

**Files:**
- `server/compose-mcp-tools.js` (existing) — add `toolBindSession`, make `toolGetCurrentSession` async with `featureCode` param
- `server/compose-mcp.js` (existing) — add `bind_session` tool schema, update `get_current_session` schema and dispatch

**Pattern:** `toolBindSession` follows `_postLifecycle` HTTP pattern. `toolGetCurrentSession` featureCode path delegates to `GET /api/session/current?featureCode=...`.

**Test first:**
- [ ] `bind_session` MCP tool delegates to REST endpoint
- [ ] `get_current_session` with no args returns last session (existing behavior)
- [ ] `get_current_session` with featureCode returns feature-aware context including `lifecycle` and `recentSummaries`

**Depends on:** Task 2 (REST endpoints must exist for MCP delegation).

---

### Task 5: Client state (frontend)

**Files:**
- `src/components/vision/useVisionStore.js` (existing) — add binding fields to `sessionStart` handler, add `sessionBound` handler, enrich `sessionEnd` handler, enrich hydration

**Changes:**
- `sessionStart` handler (line 143-146): add `featureCode: null, featureItemId: null, phaseAtBind: null, boundAt: null`
- New `sessionBound` handler after `sessionSummary` block (line 163): update `sessionState` with bound feature fields
- `sessionEnd` handler (line 150-154): add `featureCode: msg.featureCode || prev?.featureCode || null, phaseAtEnd: msg.phaseAtEnd || null`
- Hydration (line 215-219): add `featureCode`, `featureItemId`, `phaseAtBind`, `boundAt`

**Depends on:** Task 2 (WS messages must be broadcast).

---

### Task 6: Agent panel feature display (frontend)

**Files:**
- `src/components/vision/AgentPanel.jsx` (existing) — add `onSelectItem` prop, add feature context header
- `src/components/vision/AppSidebar.jsx` (existing) — add `onSelectItem` prop, thread to AgentPanel
- `src/components/vision/VisionTracker.jsx` (existing) — pass `onSelectItem={handleSelect}` to AppSidebar

**Pattern:** Follow existing prop threading pattern (e.g., `agentActivity`, `sessionState` flow from VisionTracker → AppSidebar → AgentPanel).

**Depends on:** Task 5 (sessionState must have feature fields).

---

### Task 7: Session history in item detail (frontend)

**Files:**
- `src/components/vision/ItemDetailPanel.jsx` (existing) — add `SessionHistory` local component with `useState`/`useEffect` fetch from `GET /api/session/history`

**Insertion point:** After ConnectionGraph (line 358), before Evidence blocks (line 360). Guarded by `item.lifecycle?.featureCode`.

**Pattern:** Section label follows existing `text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1.5` pattern. This is the first component in ItemDetailPanel that does local data fetching — new pattern, but isolated.

**Depends on:** Task 2 (history endpoint must exist).

---

## Parallelization

```
Task 1 ──→ Task 2 ──→ Task 4
                  └──→ Task 5 ──→ Task 6
                  └──→ Task 7
Task 3 (independent)
```

Tasks 1→2 are sequential (routes depend on manager methods). After Task 2, Tasks 4/5/7 can run in parallel. Task 6 depends on Task 5. Task 3 is fully independent.

---

## Verification

1. **Unit tests:** Run `test/session-binding.test.js` — all 9 golden flow + 3 error path tests pass
2. **Integration:** Start dev server (`npm run dev`), trigger a session via agent hook, call `bind_session` MCP tool, verify `sessionBound` appears in WS stream
3. **End-to-end:** Run a compose session on a test feature, verify:
   - AgentPanel shows "Working on: <feature>" header
   - Session history appears in ItemDetailPanel for the feature item
   - Transcript is copied to `docs/features/<code>/sessions/`
   - `get_current_session({ featureCode })` returns lifecycle + recentSummaries
4. **Regression:** Existing session tests still pass. Unbound sessions behave exactly as before (no binding fields, no transcript filing, no phase capture).
