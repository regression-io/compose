# COMP-UX-1 — Zoom-Level View Architecture

**Status:** In Progress
**Date:** 2026-03-15

## Related Documents
- [COMP-UI Integration Brief](../../../compose-ui/INTEGRATION-BRIEF.md) — original cockpit merge spec
- [ROADMAP.md](../../../ROADMAP.md) — COMP-UI items 52-57

## Problem

The compose UI has too many views doing overlapping things (Board, List, Roadmap, Tree, Graph, Pipeline, Sessions, Gates, Attention, Docs). Users can't form a mental model of where to go for what. Ops monitoring (pipeline, gates, sessions) is split across three separate tabs that are empty most of the time. The context panel is too narrow to be useful for real work.

## Goals

1. Consolidate views into three zoom levels + docs
2. Make the context panel the workhorse (50% width) with all existing features + ops additions
3. Add ops status overlays to the graph (node border colors, badges)
4. Add persistent ops strip for cross-view awareness
5. Enable smooth cross-view navigation with state persistence
6. Integrate agent chat bar for control

## Non-Goals

- Replacing the agent terminal/stream (AgentBar stays as-is)
- Changing the data model (vision store, connections, gates)
- Mobile/responsive layout

## Architecture: Three Zoom Levels

### High Level — Graph
The dependency graph with live ops status overlaid on nodes.
- Node borders show build status (blue=building, amber=gate, red=error, green=complete)
- HTML badge overlays for gates (click for popover approve) and errors
- Track compound grouping with dagre layout
- Status filter pills in header
- Click node → context panel opens (low level)

### Mid Level — Tree
Features grouped by track with rollup status badges.
- Track sections: collapsible, show count + rollup (building/gate/error/complete counts)
- Flat feature list within each track (not hierarchical indentation)
- Blocked items show "blocked by X" note
- Building items show inline progress bar + step + agent + time
- Click item → context panel opens (low level)

### Low Level — Detail Panel (Context Panel)
The right-side context panel, 40-50% width, showing everything for one feature.

**Existing sections (preserved from current app):**
- Type + Phase badges
- Title (double-click to edit)
- Status dropdown + Confidence control
- Phase selector
- Description (click to edit)
- Connections (grouped by type, clickable, deletable)
- Connection sub-graph
- Lifecycle (current phase, feature code, phase history)
- Add connection dialog
- Delete item button

**New ops sections (added below existing):**
- Pipeline dot visualization (when build is active)
- Sessions table (agent, duration, R/W/E stats, summary)
- Errors (red-bordered cards)
- Files (linked docs, clickable → Docs view)
- Cross-view navigation links

### Docs (orthogonal, not a zoom level)
File tree + markdown preview with edit capability.
- No context panel, no ops strip
- Back button when navigated from another view
- Resizable divider

## Persistent Elements

### Ops Strip (bottom, 36px)
Always visible in Graph and Tree views. Shows all active/gate/error items as compact inline entries:
- Building: progress blocks + step + agent + time
- Gate: amber dot + feature + inline [Approve] button
- Error: red dot + feature
- Click any entry → selects in current view + opens context panel

### Agent Bar (above ops strip)
Chat/terminal for agent control. Three states: collapsed (status line), expanded (chat), maximized (full screen).

### Sidebar (left)
Track checkboxes (filter graph), phase filters. Persistent across Graph and Tree views.

## Visual Specs

Interactive mockups demonstrating the zoom-level navigation:
- [Full flow demo](mockups/final-flow-v2.html) — cross-view navigation across all levels
- [High level: Graph](mockups/final-graph-v2.html) — dependency graph with ops overlays
- [Mid level: Tree](mockups/final-tree-v2.html) — track-grouped feature tree
- [Docs](mockups/final-docs-v2.html) — file browser with markdown preview

Design exploration iterations: [mockups/iterations/](mockups/iterations/)

## Implementation Plan

### Phase 1: View Consolidation (done)
- Remove Board, List, Roadmap, Attention views
- Keep Tree (add search, filters), Graph, Docs
- Graph as default view

### Phase 2: Context Panel Enhancement
- Widen to 50% (Tree) / 40% (Graph)
- Add pipeline dot visualization
- Add sessions table
- Add errors section
- Add files section with Docs navigation
- Preserve all existing ItemDetailPanel features

### Phase 3: Ops Integration
- Add ops status overlays to graph nodes (border colors, badges)
- Add gate popover on graph badge click
- Add ops strip (bottom bar)
- Add status filter pills

### Phase 4: Cross-View Navigation
- "View in Graph ↑" / "View in Tree ↓" links in context panel
- State persistence across tab switches (selection, filters)
- Back navigation from Docs

### Phase 5: Agent Bar Integration
- Chat visible in all views (collapsed by default)
- Agent activity reflected in ops strip + node colors
- Build commands from chat trigger ops updates

## Decisions

### Decision 1: Flat tree, not hierarchical
Items within tracks are listed flat. "Blocks" connections are dependency indicators, not containment. Indenting blocked items under blockers was confusing — it implied parent-child when the relationship is "depends on."

### Decision 2: Three tabs, not six
Graph | Tree | Docs replaces Graph | Board | List | Roadmap | Tree | Pipeline | Sessions | Gates | Attention | Docs. Pipeline/Sessions/Gates are absorbed into the context panel and ops strip.

### Decision 3: Context panel is the workhorse
50% width, not a narrow sidebar. All existing features preserved + ops additions. The panel is where real work happens — editing, approving gates, investigating errors.
