# Gate UI: Implementation Plan

**Status:** PLAN
**Date:** 2026-03-06
**Blueprint:** [blueprint.md](./blueprint.md)
**Design:** [design.md](./design.md)

---

## Task Order

Tasks are sequential — each builds on the previous. No parallelizable tasks due to tight coupling (store → components → wiring).

---

### Task 1: Add lifecycle phase constants

**File:** `src/components/vision/constants.js` (existing)
**What:** Add `LIFECYCLE_PHASE_LABELS` and `LIFECYCLE_PHASE_ARTIFACTS` after line 45.
**Pattern:** Same export style as existing `PHASE_LABELS` at line 36.
**Test:** Import both maps in `test/gate-logic.test.js`, verify every phase from `server/lifecycle-constants.js:PHASES` has a label entry, plus terminal states `complete` and `killed`.

---

### Task 2: Add gates state and WS handlers to useVisionStore

**File:** `src/components/vision/useVisionStore.js` (existing)
**What:**
- [ ] Extract `handleVisionMessage(msg, refs, setters)` — pull the `msg.type` switch logic out of the `ws.onmessage` closure into an exported pure function in a new file `src/components/vision/visionMessageHandler.js`. The function takes the parsed message, ref objects (`{ gatesRef, prevItemMapRef, snapshotProviderRef, pendingResolveIdsRef }`), and setter callbacks (`{ setItems, setConnections, setGates, setGateEvent, ... }`). The `ws.onmessage` handler becomes a one-liner that calls `handleVisionMessage(msg, refs, setters)`. This creates the testable seam for `gate-client.test.js`.
- [ ] Add `gates`, `gateEvent` state, `gatesRef`, `pendingResolveIdsRef` refs (after line 81)
- [ ] Add `useEffect` to sync `gatesRef` (after line 87)
- [ ] In `handleVisionMessage`: read `msg.gates` from `visionState` (alongside existing items/connections)
- [ ] In `handleVisionMessage`: add `gatePending` handler — fetch full gate via `GET /api/vision/gates/:id`, append to state, emit `gateEvent`
- [ ] In `handleVisionMessage`: add `gateResolved` handler — optimistic status update, self-suppression check via `pendingResolveIdsRef` Set, emit `gateEvent` if external
- [ ] Add `resolveGate` mutation with `try/catch` cleanup of `pendingResolveIdsRef` on failure (after line 282)
- [ ] Add `gates`, `gateEvent`, `resolveGate` to return object (line 284)

**Pattern:** Follow `agentActivity`/`sessionState` handler pattern at lines 128-174. The extraction keeps `useVisionStore` as the hook interface; `visionMessageHandler.js` is the testable logic.
**Test:** `test/gate-client.test.js` — import `handleVisionMessage` directly, call with mock setters, test visionState hydration, gatePending fetch trigger, gateResolved optimistic update, self-suppression with Set, failure cleanup.

---

### Task 3: Create GateToast component

**File:** `src/components/vision/GateToast.jsx` (new)
**What:** Minimal toast — fade-in, auto-dismiss 5s, clickable to navigate to Gates view.
**Props:** `event` (gateEvent from store), `items` (for title lookup), `onNavigate` (sets activeView).
**Pattern:** `fixed bottom-4 right-4 z-50`, `border-border bg-card shadow-lg` matching `ConnectPopover` at `ItemDetailPanel.jsx:137`.
**Test:** Manual — visual verification during E2E.

---

### Task 4: Create GateView component

**File:** `src/components/vision/GateView.jsx` (new)
**What:** Main gate queue view with Pending and Resolved Today sections.
**Props:** `gates`, `items`, `onResolve`, `onSelect`.
**Structure:**
- [ ] Summary bar: `N gates pending · M resolved today`
- [ ] Pending section: sorted by `createdAt` ascending, each row shows feature title, transition labels (`LIFECYCLE_PHASE_LABELS`), artifact assessment, action buttons
- [ ] Resolved Today section: sorted by `resolvedAt` descending, outcome badges, optional comment
- [ ] Empty state: "No gates pending."
- [ ] Inline input state: `expandedGateId` + `expandedAction` for Revise/Kill forms
- [ ] Approve calls `onResolve` directly; Revise/Kill toggle inline `<input>`

**Pattern:** Follow `AttentionView.jsx` exactly — `Section` component (line 214), row layout (line 21), `useMemo` derivation (line 76), `relativeTime` helper (line 9).
**Test:** `test/gate-logic.test.js` — pending/resolved partitioning logic, artifact display derivation.

---

### Task 5: Add Gates entry to AppSidebar

**File:** `src/components/vision/AppSidebar.jsx` (existing)
**What:**
- [ ] Add `ShieldCheck` to lucide imports (line 2)
- [ ] Add `{ key: 'gates', label: 'Gates', icon: ShieldCheck }` to VIEWS array after `attention` (line 12)
- [ ] Add `pendingGateCount` to function props (line 68)
- [ ] Add badge for gates view before the attention badge ternary (line 177): amber badge with count, hidden when 0

**Pattern:** Follow attention badge at lines 177-179.
**Test:** Manual — visual verification.

---

### Task 6: Wire everything in VisionTracker

**File:** `src/components/vision/VisionTracker.jsx` (existing)
**What:**
- [ ] Import `GateView` and `GateToast` (after line 14)
- [ ] Destructure `gates`, `gateEvent`, `resolveGate` from `useVisionStore` (line 17-21)
- [ ] Add `pendingGateCount` useMemo (after line 68)
- [ ] Pass `pendingGateCount` to `AppSidebar` (line 125-137)
- [ ] Add `{activeView === 'gates' && <GateView .../>}` (after line 208)
- [ ] Pass `gates` and `onResolveGate={resolveGate}` to `ItemDetailPanel` (line 212-225)
- [ ] Add `<GateToast event={gateEvent} items={items} onNavigate={() => setActiveView('gates')} />` (before line 241)

**Pattern:** Follow existing view wiring pattern (roadmap/list/board/etc at lines 149-208).
**Test:** Manual — verify gates view renders, toast appears on gate events, badge shows count.

---

### Task 7: Add lifecycle section to ItemDetailPanel

**File:** `src/components/vision/ItemDetailPanel.jsx` (existing)
**What:**
- [ ] Add `LIFECYCLE_PHASE_LABELS` to constants import (line 8)
- [ ] Add `ShieldCheck, Check, RotateCcw, Ban` to lucide imports (line 2)
- [ ] Add `gates`, `onResolveGate` to function props (line 188)
- [ ] Add `GateBannerActions` helper component (local, not exported) with inline input state for Revise/Kill
- [ ] Add lifecycle section between ConnectionGraph (line 358) and evidence (line 360): phase badge, feature code, gate banner with `GateBannerActions`, phase history timeline

**Pattern:** Follow Stratum Trace section structure at lines 380-406 — `text-[10px] font-medium uppercase tracking-wider text-muted-foreground` label, rows in `bg-muted/30`.
**Test:** Manual — select an item with lifecycle data, verify section renders with phase and history.

---

### Task 8: Write tests

**Files:**
- [ ] `test/gate-logic.test.js` (new) — phase label completeness, pending/resolved partitioning, artifact display derivation, self-suppression Set behavior, pendingGateCount
- [ ] `test/gate-routes.test.js` (new) — Express integration: visionState includes gates, gatePending broadcast shape (no scheduleBroadcast), gateResolved broadcast shape (with scheduleBroadcast), GET gate by ID, POST resolve with all three outcomes
- [ ] `test/gate-client.test.js` (new) — extracted WS handler: visionState hydration, gatePending fetch trigger, gateResolved optimistic update, self-suppression, failure cleanup

**Pattern:** Follow `lifecycle-routes.test.js` for integration tests (Express + ephemeral port + in-memory store). Follow `policy-engine.test.js` for pure logic tests.

---

### Task 9: E2E verification

**What:** Start the dev server and manually verify all UI behaviors that are not covered by automated tests. This task is the exit gate — all items must pass before L4 is complete.

**Setup:** `npm run dev` from compose root (Vite on :5173, API on :3001).

**Checklist:**

Gate visibility:
- [ ] Gates view appears in sidebar with `ShieldCheck` icon
- [ ] Pending gate count badge shows on sidebar item, hidden when 0
- [ ] Gates view shows "No gates pending." when empty

Gate creation flow:
- [ ] Advance a lifecycle item into a gated phase (blueprint/verification/plan/ship) via MCP or curl
- [ ] `gatePending` toast appears bottom-right with feature title and transition labels
- [ ] Clicking toast switches to Gates view
- [ ] Toast auto-dismisses after 5s
- [ ] Pending gate row appears with correct feature title, phase labels, and relative timestamp
- [ ] Artifact assessment displays completeness %, word count, and missing sections (when non-null)

Gate resolution — Approve:
- [ ] Click Approve on a pending gate row
- [ ] Gate moves from Pending to Resolved Today with "Approved" badge
- [ ] Item's lifecycle phase advances (verify in item detail panel)
- [ ] No self-toast on resolution

Gate resolution — Revise:
- [ ] Click Revise on a pending gate row
- [ ] Inline input appears below action buttons
- [ ] Empty submit works (optional comment)
- [ ] Submit with comment works — comment shows on resolved row
- [ ] Escape hides the input without resolving
- [ ] Item stays in current phase after revise

Gate resolution — Kill:
- [ ] Click Kill on a pending gate row
- [ ] Inline input appears with required reason
- [ ] Submit disabled when empty
- [ ] Submit with reason kills the feature — item status becomes "killed"
- [ ] Killed gate shows in Resolved Today with "Killed" badge and reason

Item Detail Panel:
- [ ] Select an item with `lifecycle` data — lifecycle section appears between connections and evidence
- [ ] Phase badge and feature code display correctly
- [ ] Phase history timeline shows all phases with durations
- [ ] When item has pending gate: gate banner appears with amber border, target phase label, artifact assessment, and Approve/Revise/Kill buttons
- [ ] Approve/Revise/Kill from the banner work identically to GateView actions
- [ ] When item has no pending gate: no gate banner, lifecycle section still shows phase + history

Multi-client:
- [ ] Open two browser tabs
- [ ] Create a gate in tab 1 — tab 2 shows toast and gate appears in Gates view
- [ ] Resolve gate in tab 1 — tab 2 shows toast and gate updates to resolved

Edge cases:
- [ ] Resolve two gates back-to-back quickly — both resolve correctly, no stale toasts
- [ ] Disconnect/reconnect WebSocket — gates repopulate from `visionState` on reconnect
- [ ] Page refresh — gates hydrate correctly from initial `visionState`

---

## Verification

Run automated tests: `node --test test/gate-logic.test.js test/gate-routes.test.js test/gate-client.test.js`

Run E2E verification: Task 9 checklist above.

---

## Files Summary

| File | Action | Task |
|------|--------|------|
| `src/components/vision/constants.js` | Edit | 1 |
| `src/components/vision/visionMessageHandler.js` | Create | 2 |
| `src/components/vision/useVisionStore.js` | Edit | 2 |
| `src/components/vision/GateToast.jsx` | Create | 3 |
| `src/components/vision/GateView.jsx` | Create | 4 |
| `src/components/vision/AppSidebar.jsx` | Edit | 5 |
| `src/components/vision/VisionTracker.jsx` | Edit | 6 |
| `src/components/vision/ItemDetailPanel.jsx` | Edit | 7 |
| `test/gate-logic.test.js` | Create | 8 |
| `test/gate-routes.test.js` | Create | 8 |
| `test/gate-client.test.js` | Create | 8 |
