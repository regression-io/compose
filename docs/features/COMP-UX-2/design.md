# COMP-UX-2: Make the Views Work

**Status:** DESIGN
**Date:** 2026-03-27

## Related Documents

- [Compose Roadmap](../../ROADMAP.md)
- [COMP-UX-1](../COMP-UX-1/) — Zoom-level view architecture (Graph = high, Tree = mid, Detail = low)
- [COMP-VIS-1](../COMP-VIS-1/) — Agent communication graph (shipped)

---

## First Principles

Compose is the process layer that makes coding agent speed safe. The UI is a control tower for supervised agent work. COMP-UX-1 established the right view hierarchy: Graph (topology), Tree (hierarchy), Pipeline (execution), Gates (decisions), Docs (artifacts), Design (conversation), Sessions (history).

**The views are the right views. They're just half-wired.**

---

## Problem

A functional audit of all 8 views reveals systemic gaps:

| Gap | Affected views | Impact |
|-----|---------------|--------|
| **No feature filtering** | Graph, Tree, Gates, Sessions, Docs | User sees all 100+ items instead of their feature's neighborhood |
| **Sessions view is a stub** | Sessions | Server doesn't broadcast session data via WS; view shows empty |
| **Pipeline steps are hardcoded** | Pipeline | 24 static steps don't reflect actual Stratum flow execution |
| **Settings reference ghost views** | Settings | "attention", "roadmap", "list", "board" don't exist |
| **Design view disconnected from lifecycle** | Design | Completing a design doesn't trigger a gate or write to feature folder |
| **No empty state on Graph** | Graph | Filtered to zero items → silent blank canvas |
| **Real-time sync gaps** | All except Design (SSE) | Views are static snapshots; no push updates beyond initial WS hydration |
| **No Dashboard/landing** | All | New users see the graph, not their feature |

---

## Goal

Fix every view to be fully functional for compose users. Add a Dashboard as the landing view. No view removals — just make what exists actually work.

---

## Sub-Features

| Code | Workstream | Design |
|------|-----------|--------|
| [COMP-UX-2a](../COMP-UX-2a/design.md) | Feature-aware filtering | All views get "Focus: AUTH-3" toggle |
| [COMP-UX-2b](../COMP-UX-2b/design.md) | Fix broken views | Sessions, Pipeline, Design, Settings, Graph |
| [COMP-UX-2c](../COMP-UX-2c/design.md) | Dashboard landing view | Feature progress, gates, agents, artifacts |
| [COMP-UX-2d](../COMP-UX-2d/design.md) | First-class group field | Replace regex prefix derivation with proper data model |

---

## Workstream 1: Feature-Aware Filtering (all views)

**The #1 gap.** When a feature is bound (`sessionState.featureCode`), every view should offer a "Focus: AUTH-3" toggle that filters to that feature's items, gates, sessions, and artifacts.

| View | What "focus" means |
|------|-------------------|
| **Graph** | Highlight current feature's items + their 1-hop connections; dim everything else |
| **Tree** | Filter to items with matching featureCode or lifecycle binding |
| **Gates** | Filter to gates where the item belongs to the current feature |
| **Sessions** | Filter to sessions bound to the current feature |
| **Docs** | Default file tree root to `docs/features/<featureCode>/` |
| **Pipeline** | Already feature-scoped (shows activeBuild for current feature) |
| **Design** | Already session-scoped |

Implementation: Add `featureCode` prop to all views. Add a "Focus" toggle in each toolbar (shared component). When active, pass feature filter to data queries. When inactive, show everything.

---

## Workstream 2: Fix Broken Views

### Sessions — Wire the data

The view works but the data doesn't arrive. Lines 33-34 explicitly say: "visionState WS payload does not yet include sessions."

- [ ] Server: include `sessions` array in `visionState` WS payload
- [ ] Server: broadcast `sessionStart`/`sessionEnd`/`sessionBound` events (already emitted, just need client handling for list updates)
- [ ] Client: SessionsView reads from useVisionStore.sessions (already wired, just empty)

### Pipeline — Dynamic steps from Stratum

24 hardcoded steps in constants.js don't match real builds. When a Stratum flow runs, it has its own step sequence.

- [ ] Server: expose current flow's step list via `/api/build/state` (already partially there)
- [ ] Client: PipelineView reads steps from activeBuild when available, falls back to hardcoded template when no build active
- [ ] Add step error details (currently no UI for failed step info)

### Design — Connect to lifecycle

Design conversation completes but doesn't write to feature folder or trigger a gate.

- [ ] On "Complete Design", write/update `docs/features/<featureCode>/design.md`
- [ ] On completion, create an `explore_design` gate if policy mode is `gate`
- [ ] Show feature binding in Design UI header

### Settings — Clean up ghost views

- [ ] Remove "attention", "roadmap", "list", "board" from VIEWS constant
- [ ] Add actual views: "dashboard", "design", "pipeline", "sessions"
- [ ] Validate that default view setting actually routes correctly

### Graph — Empty state

- [ ] Show "No items match current filters" message when filteredItems is empty
- [ ] Make KNOWN_PREFIXES dynamic (derive from item data, not hardcoded array)

---

## Workstream 3: Dashboard (new landing view)

A feature-centric landing that answers: what am I building, what needs my attention, what's happening now.

### Layout

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

### Empty state

```
No feature in progress.
Run /compose <feature-code> in the terminal to start.

Recent: COMP-VIS-1 (complete) · COMP-UX-1 (complete)
```

### Data: all from existing stores

- Feature + phase: `sessionState.featureCode` → `get_feature_lifecycle`
- Agents: `spawnedAgents` from useVisionStore
- Gates: `gates` filtered to feature
- Artifacts: `/api/files` filtered to feature folder
- Sessions: `sessions` filtered to feature

---

## Workstream 4: Forward Roadmap — Aspirational Features

Features that build on a fully functional base. Ordered by value.

### Tier 1: Polish the control surface (V1)

| Code | Feature | Why | Effort |
|------|---------|-----|--------|
| COMP-UX-3 | **Inline gate resolution on Dashboard** | Gates are THE interaction; resolve without switching tabs | **COMPLETE** — delivered by COMP-UX-2c |
| COMP-UX-4 | **Artifact revision diff** | Show what changed between gate revisions; makes review meaningful | **COMPLETE** |
| COMP-UX-5 | **Phase transition animations** | Visual confirmation of progress; polish | **COMPLETE** |
| COMP-UX-8 | **Mermaid in Docs view** | Render diagrams in artifacts; makes design docs visual | **COMPLETE** |

### Tier 2: Deepen agent visibility (differentiators)

| Code | Feature | Inspired by | Effort |
|------|---------|-------------|--------|
| COMP-UX-6 | **Per-agent log viewer tabs** | Kangentic | **COMPLETE** |
| COMP-UX-7 | **Live metrics on agent cards** | Kangentic | **COMPLETE** |
| COMP-UX-9 | **Iteration progress strip** | idea_tiered_evaluation | **COMPLETE** |

### Tier 3: Lifecycle intelligence (post-V1)

| Code | Feature | Effort |
|------|---------|--------|
| COMP-UX-10 | **Hypothesis-mode design cards** | Medium |
| COMP-UX-11 | **Feature event timeline** | Medium |
| COMP-UX-12 | **Drag-reorder pipeline steps** | Large |
| COMP-UX-13 | **Cross-feature dependency view** | Large |

### Tier 4: Ecosystem (future)

| Code | Feature | Effort |
|------|---------|--------|
| COMP-UI-7 | **Tab popout** | Large |
| COMP-GIT-1 | **Git connector** | Large |
| COMP-GIT-2 | **File checkpoint/rewind** | Large |

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/components/vision/DashboardView.jsx` | new | Feature-centric landing |
| `src/components/vision/GraphView.jsx` | modify | Feature focus filter, empty state |
| `src/components/vision/TreeView.jsx` | modify | Feature focus filter |
| `src/components/vision/GateView.jsx` | modify | Feature focus filter |
| `src/components/vision/SessionsView.jsx` | modify | Wire real data, feature filter |
| `src/components/vision/PipelineView.jsx` | modify | Dynamic steps from Stratum |
| `src/components/vision/DocsView.jsx` | modify | Feature-first default path |
| `src/components/vision/DesignView.jsx` | modify | Connect to lifecycle gates + feature folder |
| `src/components/vision/SettingsPanel.jsx` | modify | Fix VIEWS constant |
| `src/components/shared/FeatureFocusToggle.jsx` | new | Shared "Focus: AUTH-3" toolbar component |
| `server/vision-server.js` | modify | Include sessions in visionState WS payload |
| `src/App.jsx` | modify | Add Dashboard route, default view, pass featureCode |

## Acceptance Criteria

- [ ] Feature focus toggle available in Graph, Tree, Gates, Sessions, Docs views
- [ ] When focused, each view shows only current feature's items/gates/sessions/files
- [ ] Sessions view shows real session data from WebSocket
- [ ] Pipeline view shows dynamic steps when a Stratum flow is active
- [ ] Design view writes to feature folder and triggers gate on completion
- [ ] Settings VIEWS constant matches actual views (no ghosts)
- [ ] Graph shows empty state message when filtered to zero
- [ ] Dashboard is default view, shows feature progress + inline gates
- [ ] Dashboard empty state guides users to run `/compose`
- [ ] All existing views still work in unfocused mode (no regressions)

## Open Questions

- [ ] Should feature focus persist across tab switches, or reset per view?
- [ ] Should Dashboard auto-detect feature from sessionState, or show a picker when multiple features are in flight?
