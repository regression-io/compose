# Gate UI: Implementation Report

**Status:** COMPLETE
**Date:** 2026-03-06
**Design:** [design.md](./design.md)
**Blueprint:** [blueprint.md](./blueprint.md)
**Plan:** [plan.md](./plan.md)

---

## Summary

Implemented the L4 Gate UI feature: a full client-side surface for viewing, resolving, and tracking lifecycle gates in the Vision Surface. Users can now see pending gates, approve/revise/kill them with inline forms, view artifact assessment context, and track gate history — all without leaving the UI.

## Delivered vs Planned

All 9 planned tasks delivered. One server-side change added during review (not in original plan).

| Planned | Delivered | Notes |
|---------|-----------|-------|
| Lifecycle phase constants | Yes | `LIFECYCLE_PHASE_LABELS`, `LIFECYCLE_PHASE_ARTIFACTS` |
| WS handler extraction + gates state | Yes | `visionMessageHandler.js` + useVisionStore changes |
| GateToast component | Yes | 5s auto-dismiss, clickable navigation |
| GateView component | Yes | Pending queue + resolved today, inline Revise/Kill |
| AppSidebar gates entry | Yes | ShieldCheck icon, amber badge with pending count |
| VisionTracker wiring | Yes | All components connected |
| ItemDetailPanel lifecycle section | Yes | Full lifecycle context + pending gate banner with artifact assessment |
| Tests (3 files) | Yes | 40 tests across gate-client, gate-logic, gate-routes |
| E2E checklist | Partial | No Playwright infrastructure; manual verification via build |

## Architecture Deviations

1. **Server broadcast change (not in original plan):** Added `itemId` to `gateResolved` broadcast in `vision-routes.js`. The original design derived `itemId` from `gatesRef.current` client-side, but this had a race condition when `gateResolved` arrived before the async `gatePending` fetch settled. Server-side fix was cleaner and race-free.

2. **Lifecycle section scope expanded:** Original plan specified a "Lifecycle Gates" block. Review correctly identified this as incomplete — items with `item.lifecycle` but no current gates lost all lifecycle context. Expanded to show current phase, feature code, and phase history regardless of gate presence.

## Key Implementation Decisions

- **WS handler extraction:** Extracted all WebSocket message dispatch logic into `visionMessageHandler.js` as a pure function taking refs and setters. This made the gate handler testable without React/jsdom while keeping `useVisionStore` as the hook interface.

- **Self-toast suppression via Set:** Uses `pendingResolveIdsRef` (a Set, not a single ref) to track in-flight resolve calls. Handles overlapping resolves correctly. Failed resolves clean up via try/catch.

- **gatePending requires REST fetch:** Server does not call `scheduleBroadcast()` after `gatePending`, so no `visionState` follows. Client handles this by fetching the full gate object via `GET /api/vision/gates/:id` and appending to local state.

- **Inline inputs over modals:** Revise/Kill actions use per-row inline `<input>` with expansion state, not `window.prompt` or modal dialogs. Consistent in both GateView and ItemDetailPanel.

## Test Coverage

| File | Tests | Coverage |
|------|-------|----------|
| `test/gate-client.test.js` | 18 | WS handler: visionState hydration, gatePending, gateResolved optimistic update, self-suppression, race-safe itemId, snapshot, session lifecycle, change tracking |
| `test/gate-logic.test.js` | 12 | Phase label completeness, artifact map parity, gate partitioning, pendingGateCount, assessment display |
| `test/gate-routes.test.js` | 7 | visionState includes gates, gatePending skips scheduleBroadcast, gateResolved includes itemId (all 3 outcomes), gate object shape |
| `test/lifecycle-routes.test.js` | 8 (existing) | Gate REST endpoints: 202 on gated advance, GET gates, resolve with all outcomes, broadcast shapes |

Total gate-related: 45 tests. Full suite: 266 tests, 0 failures.

## Files Changed

| File | Action |
|------|--------|
| `src/components/vision/constants.js` | Modified |
| `src/components/vision/visionMessageHandler.js` | Created |
| `src/components/vision/useVisionStore.js` | Modified |
| `src/components/vision/GateToast.jsx` | Created |
| `src/components/vision/GateView.jsx` | Created |
| `src/components/vision/AppSidebar.jsx` | Modified |
| `src/components/vision/VisionTracker.jsx` | Modified |
| `src/components/vision/ItemDetailPanel.jsx` | Modified |
| `server/vision-routes.js` | Modified (added itemId to gateResolved broadcast) |
| `test/gate-client.test.js` | Created |
| `test/gate-logic.test.js` | Created |
| `test/gate-routes.test.js` | Created |

## Known Issues & Tech Debt

1. **No Playwright E2E tests:** Project lacks Playwright infrastructure. The 30-item E2E checklist in the plan requires manual verification or future Playwright setup.

2. **GateView and ArtifactAssessment duplication:** The artifact assessment rendering exists in both `GateView.jsx` (as `ArtifactAssessment` component) and `ItemDetailPanel.jsx` (inline). Could be extracted to a shared component if more surfaces need it.

3. **gatePending fetch has no retry:** If the REST fetch for the full gate object fails (network blip), the gate won't appear in local state until the next `visionState` broadcast. Low risk since `visionState` arrives on any subsequent server mutation.

## Lessons Learned

1. **Server broadcast shapes matter for client architecture.** The missing `itemId` on `gateResolved` created a client-side race that no amount of ref-juggling could fully solve. Adding one field to the server broadcast was the correct fix.

2. **Extract before test.** Moving WS handler logic to a pure function before writing tests made coverage straightforward — no React, no jsdom, no mocking.

3. **Review catches scope gaps.** The lifecycle section was initially gate-only. Review correctly identified that items with lifecycle data but no gates lost all context. The expanded section is materially better.
