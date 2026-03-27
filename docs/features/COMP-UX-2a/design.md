# COMP-UX-2a: Feature-Aware Filtering

**Status:** DESIGN (approved as part of COMP-UX-2)
**Date:** 2026-03-27

## Related Documents

- [COMP-UX-2 design](../COMP-UX-2/design.md) — Parent feature (cockpit refocus)
- [COMP-UX-1](../COMP-UX-1/) — Zoom-level view architecture

---

## Problem

No view filters by feature. When a user is building AUTH-3, they see all 100+ tracker items in Graph, all gates in Gates, all sessions in Sessions. There's no way to focus on the current feature's neighborhood.

## Goal

Every view gets a "Focus: AUTH-3" toggle. When active, each view shows only the current feature's relevant data. When inactive, everything shows as before. Shared component, consistent UX across views.

---

## Decision 1: Feature Focus Toggle

Shared toolbar component: `FeatureFocusToggle`. Reads `sessionState.featureCode` from useVisionStore. When no feature bound, toggle is disabled/hidden.

| View | What "focus" means |
|------|-------------------|
| **Graph** | Highlight current feature's items + 1-hop connections; dim everything else |
| **Tree** | Filter to items with matching featureCode or lifecycle binding |
| **Gates** | Filter to gates where the item belongs to current feature |
| **Sessions** | Filter to sessions bound to current feature |
| **Docs** | Default file tree root to `docs/features/<featureCode>/` |
| **Pipeline** | Already feature-scoped (shows activeBuild) |
| **Design** | Already session-scoped |

## Decision 2: Focus persistence

Focus state persists across tab switches within a session (stored in useVisionStore or sessionStorage). Resets on session change.

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/components/shared/FeatureFocusToggle.jsx` | new | Shared toggle component |
| `src/components/vision/GraphView.jsx` | modify | Add focus prop, dim non-feature items |
| `src/components/vision/TreeView.jsx` | modify | Add focus filter |
| `src/components/vision/GateView.jsx` | modify | Add focus filter |
| `src/components/vision/SessionsView.jsx` | modify | Add focus filter |
| `src/components/vision/DocsView.jsx` | modify | Default path when focused |
| `src/App.jsx` | modify | Pass featureCode to views |

## Acceptance Criteria

- [ ] FeatureFocusToggle appears in Graph, Tree, Gates, Sessions, Docs toolbars
- [ ] Toggle disabled when no feature bound
- [ ] Graph: focused items highlighted, others dimmed (not hidden)
- [ ] Tree/Gates/Sessions: filtered to feature items only
- [ ] Docs: defaults to feature folder when focused
- [ ] Focus persists across tab switches
- [ ] Unfocused mode shows everything (no regressions)
