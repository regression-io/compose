# COMP-UX-2b: Fix Broken Views

**Status:** DESIGN (approved as part of COMP-UX-2)
**Date:** 2026-03-27

## Related Documents

- [COMP-UX-2 design](../COMP-UX-2/design.md) — Parent feature (cockpit refocus)

---

## Problem

Five views have functional gaps ranging from stub data to disconnected lifecycle integration:

1. **Sessions** — Server doesn't include sessions in WS payload; view is empty
2. **Pipeline** — 24 hardcoded steps don't reflect actual Stratum flow execution
3. **Design** — Completing a design doesn't write to feature folder or trigger a gate
4. **Settings** — VIEWS constant references 4 views that don't exist
5. **Graph** — Silent blank canvas when filtered to zero items

## Goal

Fix each view to be fully functional. No new UI concepts — just wire what exists.

---

## Fix 1: Sessions — Wire the data

Lines 33-34 say: "visionState WS payload does not yet include sessions."

- [ ] Server: include `sessions` in `visionState` WS payload
- [ ] Server: broadcast session events already emitted (sessionStart/End/Bound) to update list
- [ ] Client: SessionsView reads from useVisionStore.sessions (already wired, just empty)
- [ ] Show tool count, error count, elapsed time per session
- [ ] Feature code column links to feature in Graph/Tree

## Fix 2: Pipeline — Dynamic steps from Stratum

- [ ] Server: expose current flow's step list in `/api/build/state` response
- [ ] Client: PipelineView reads steps from activeBuild.steps when available
- [ ] Client: fall back to hardcoded template when no build active
- [ ] Show step error details when step status is "failed"
- [ ] Auto-refresh via WebSocket (remove manual refresh button dependency)

## Fix 3: Design — Connect to lifecycle

- [ ] On "Complete Design", POST to create/update `docs/features/<featureCode>/design.md`
- [ ] On completion, create `explore_design` gate if policy mode is `gate`
- [ ] Show feature binding in Design UI header (currently scoped but not shown)
- [ ] Persist decisions to feature folder as structured data

## Fix 4: Settings — Clean ghost views

- [ ] Remove "attention", "roadmap", "list", "board" from VIEWS constant
- [ ] Add actual views: "dashboard", "design", "pipeline", "sessions"
- [ ] Verify default view setting routes correctly on app load

## Fix 5: Graph — Empty state

- [ ] Show "No items match current filters" when filteredItems is empty
- [ ] Derive KNOWN_PREFIXES dynamically from item data instead of hardcoded array

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `server/vision-server.js` | modify | Include sessions in visionState payload |
| `src/components/vision/SessionsView.jsx` | modify | Wire real data, show tool/error counts |
| `src/components/vision/PipelineView.jsx` | modify | Dynamic steps, error details, auto-refresh |
| `src/components/vision/DesignView.jsx` | modify | Write to feature folder, trigger gate |
| `src/components/vision/SettingsPanel.jsx` | modify | Fix VIEWS constant |
| `src/components/vision/GraphView.jsx` | modify | Empty state, dynamic prefixes |
| `server/session-routes.js` | modify | Ensure session list endpoint returns full data |

## Acceptance Criteria

- [ ] Sessions view shows real session data from WebSocket
- [ ] Pipeline view shows dynamic steps when Stratum flow is active
- [ ] Pipeline falls back to template when no build
- [ ] Design "Complete" writes to feature folder and triggers gate
- [ ] Settings VIEWS matches actual views (no ghosts)
- [ ] Graph shows empty state message when filtered to zero
- [ ] KNOWN_PREFIXES derived from data, not hardcoded
