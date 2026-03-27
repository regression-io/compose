# COMP-UX-2c: Dashboard Landing View

**Status:** DESIGN (approved as part of COMP-UX-2)
**Date:** 2026-03-27

## Related Documents

- [COMP-UX-2 design](../COMP-UX-2/design.md) — Parent feature (cockpit refocus)
- [COMP-UX-2a](../COMP-UX-2a/) — Feature-aware filtering (Dashboard uses same featureCode)

---

## Problem

New users see the Graph view (100+ items) with no orientation. Returning users have no quick way to see: what feature am I building, what phase am I in, what needs my attention.

## Goal

A feature-centric landing view that answers three questions:
1. **What am I building?** — Feature name, phase, progress
2. **What needs my attention?** — Pending gates
3. **What's happening now?** — Active agents, recent sessions

---

## Decision 1: Layout

```
┌─────────────────────────────────────────────────┐
│ AUTH-3: User Authentication                      │
│ Phase: Blueprint (4/10)  ████████░░░░░░░ 40%    │
├──────────────────────┬──────────────────────────┤
│ Phase Timeline       │ Active Agents            │
│ ✓ Design (approved)  │ ◆ explorer-1 (running)   │
│ → Blueprint (current)│ ◆ architect-1 (complete)  │
│ ○ Plan               │                          │
│ ○ Execute            │ Artifacts                │
│ ○ Ship               │ ✓ design.md (1,240 w)    │
│                      │ ◐ blueprint.md (writing) │
├──────────────────────┴──────────────────────────┤
│ ⚡ Pending Gate: Blueprint Review                │
│ [Approve]  [Revise]  [Kill]                      │
├─────────────────────────────────────────────────┤
│ Recent Sessions (2)                              │
└─────────────────────────────────────────────────┘
```

## Decision 2: Empty state

```
No feature in progress.
Run /compose <feature-code> in the terminal to start.

Recent: COMP-VIS-1 (complete) · COMP-UX-1 (complete)
```

## Decision 3: Inline gate resolution

Gates render directly on the Dashboard with approve/revise/kill actions. No need to switch to Gates tab for the common case (one pending gate for the current feature).

## Decision 4: Data sources

All from existing stores — no new backend work:
- Feature + phase: `sessionState.featureCode` → `get_feature_lifecycle` MCP
- Agents: `spawnedAgents` from useVisionStore
- Gates: `gates` filtered to current feature
- Artifacts: `/api/files` filtered to feature folder
- Sessions: `sessions` filtered to featureCode

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/components/vision/DashboardView.jsx` | new | Feature-centric landing |
| `src/App.jsx` | modify | Add Dashboard route, set as default view |
| `src/components/cockpit/ViewTabs.jsx` | modify | Add Dashboard tab |

## Acceptance Criteria

- [ ] Dashboard is default view for new sessions
- [ ] Shows feature name, phase progress bar, phase timeline
- [ ] Shows active agents with type and status
- [ ] Shows artifacts with word count and status (done/writing/not started)
- [ ] Shows pending gates with inline approve/revise/kill
- [ ] Shows recent sessions (last 3-5)
- [ ] Empty state shows guidance + recent completed features
- [ ] Auto-detects current feature from sessionState.featureCode
