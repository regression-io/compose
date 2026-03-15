# COMP-UX-1 — Implementation Plan

**Design:** [design.md](design.md)
**Mockups:** [mockups/final-flow-v2.html](mockups/final-flow-v2.html)

---

## COMP-UX-1a: View Consolidation — COMPLETE

- [x] Remove BoardView.jsx, ItemListView.jsx, RoadmapView.jsx, AttentionView.jsx
- [x] Update DEFAULT_MAIN_TABS and CockpitView switch
- [x] Graph as default view with track compound grouping
- [x] TreeView with search, status/type filters, create button
- [x] Tab order: Graph | Tree | Docs (was 10+ tabs)
- [x] Blue-slate color scheme matching graph view
- [x] Track checkboxes in sidebar (multi-select for graph filtering)
- [x] Track/phase sort by priority (active first)
- [x] Project switching via `POST /api/project/switch`
- [x] Feature scanner: parse status from docs, sub-package detection, roadmap-graph import
- [x] Selection/deselection consistency audit
- [x] Layout persistence (localStorage for view, track, phase, visible tracks)
- [x] DocsView rewrite: file tree + markdown preview + edit mode + resizable divider
- [x] Cross-view file navigation (context panel → Docs with back button)
- [x] Gate count badge on tab
- [x] Graph export endpoint (`GET /api/export/roadmap-graph`)

---

## COMP-UX-1b: Context Panel as Workhorse — PLANNED

Widen the context panel and add ops sections below existing content.

- [ ] Widen ContextPanel to 50% width in Tree view, 40% in Graph view
  - Modify `src/components/cockpit/ContextPanel.jsx` (existing)
  - Add width prop or view-aware sizing
- [ ] Add resizable divider between main content and context panel
  - Reuse the drag pattern from DocsView
  - Persist width to localStorage (`compose:contextPanelWidth`)
- [ ] Add Pipeline section to ContextItemDetail
  - New component: `src/components/cockpit/PipelineDots.jsx` (new)
  - 18px circles, 2px connecting lines, phase labels below
  - Only visible when `activeBuild` has steps for this feature's `featureCode`
  - Colors: green=done, blue=active (pulse), amber=gate, grey=pending
- [ ] Add Sessions section to ContextItemDetail
  - Fetch sessions by `featureCode` from vision store
  - Table: agent (colored), duration, R/W/E stats, summary text
  - Most recent at top
- [ ] Add Errors section to ContextItemDetail
  - Red left-border cards with error message, agent, step, timestamp
  - Empty state: "(none)"
- [ ] Add Files section to ContextItemDetail
  - List `item.files` array as clickable links
  - Click → call `onOpenFile(path)` → navigates to Docs view
- [ ] Preserve ALL existing ItemDetailPanel features untouched
  - Type/phase badges, title editing, status dropdown, confidence
  - Description editing, connections, connection graph
  - Lifecycle, gate approval, delete button

**Acceptance:**
- [ ] Context panel renders at 50% width in Tree, 40% in Graph
- [ ] Divider is draggable, width persists
- [ ] Pipeline dots appear for features with active builds
- [ ] Sessions show for lifecycle-bound features
- [ ] Files link to Docs view with back navigation
- [ ] All existing ItemDetailPanel features still work

---

## COMP-UX-1c: Graph Ops Overlays — PLANNED

Overlay live ops status on graph nodes.

- [ ] Node border color from build status
  - Modify `src/components/vision/GraphView.jsx` (existing)
  - Map item status + activeBuild state to border color
  - Building: #3b82f6 blue with pulse animation
  - Gate pending: #f59e0b amber
  - Error: #ef4444 red
  - Complete: #22c55e green
  - Blocked downstream: dashed border, opacity 0.4
- [ ] HTML badge overlays for gates and errors
  - Render as positioned divs over the cytoscape canvas
  - Update position on `cy.on('render')` via `node.renderedPosition()`
  - ⚠ badge (16px circle, amber) for pending gates
  - ✕ badge (16px circle, red) for errors
  - Badges are clickable independently from nodes
- [ ] Gate popover on ⚠ badge click
  - Phase transition, artifact %, word count
  - [Approve] [Revise] [Kill] buttons
  - Calls existing `resolveGate` from vision store
- [ ] Error popover on ✕ badge click
  - Error message, agent, step, timestamp
- [ ] Building nodes show agent + step as label
  - Second line: "Claude · 4/8 · 3m" in smaller font
  - Node height increases slightly (48→56px)
- [ ] Blocked downstream detection
  - Walk successors of gate/error nodes
  - Apply dimmed class to downstream nodes

**Acceptance:**
- [ ] Building nodes pulse blue with agent info
- [ ] Gate nodes show ⚠ badge, clickable for popover
- [ ] Approving gate via popover updates all views
- [ ] Error nodes show ✕ badge, clickable for details
- [ ] Downstream of gate/error is visually dimmed

---

## COMP-UX-1d: Ops Strip — PLANNED

Persistent bottom bar for cross-view ops awareness.

- [ ] New component: `src/components/cockpit/OpsStrip.jsx` (new)
  - 36px height, bg #1e293b, border-top #334155
  - Renders in App.jsx below AgentBar, above NotificationBar
  - Hidden when activeView === 'docs'
- [ ] Compact inline entries for each active/gate/error item
  - Building: colored dot + feature code + progress blocks (40px) + step/total + agent + time
  - Gate: amber dot + feature code + "gate" + inline [Approve] button
  - Error: red dot + feature code + "error"
  - Complete: green dot + feature code + "complete" → fade out after 3s
- [ ] Click entry → select item (updates selectedItemId + context panel)
- [ ] Inline gate approve button calls resolveGate
- [ ] Data source: derive from items + activeBuild + gates + sessions in vision store

**Acceptance:**
- [ ] Ops strip visible in Graph and Tree views
- [ ] Shows all active builds, pending gates, errors
- [ ] Inline approve works
- [ ] Click entry selects item across views
- [ ] Hidden in Docs view

---

## COMP-UX-1e: Cross-View Navigation — PLANNED

Smooth navigation between zoom levels with state persistence.

- [ ] Add "View in Graph ↑" link to context panel (when in Tree view)
- [ ] Add "View in Tree ↓" link to context panel (when in Graph view)
- [ ] Clicking cross-view link switches tab, preserves selectedItemId
- [ ] In Graph: auto-center on selected node after tab switch
- [ ] File click in context panel → Docs view with back button (already partially done)
- [ ] Verify: selectedItemId, selectedTrack, selectedPhase, visibleTracks all persist across tab switches
- [ ] Verify: context panel stays open with same content across tab switches

**Acceptance:**
- [ ] Cross-view links work in both directions
- [ ] Selection persists when switching views
- [ ] Graph centers on selected node when arriving from Tree
- [ ] Back button from Docs returns to previous view

---

## COMP-UX-1f: Agent Bar Integration — PLANNED

Connect the agent bar to the ops overlay system.

- [ ] Verify AgentBar renders in all views (already does via App.jsx)
- [ ] Agent activity events (`agentActivity` WebSocket messages) update ops strip entries
- [ ] Build start event creates/updates ops strip entry for the feature
- [ ] Build complete event triggers: node color change, strip entry flash + fade, context panel update
- [ ] Error events add ✕ badge to graph node + ops strip entry
- [ ] Gate events add ⚠ badge to graph node + ops strip entry

**Acceptance:**
- [ ] Starting `compose build FEAT-X` shows progress in ops strip + graph
- [ ] Errors during build appear on graph nodes and ops strip
- [ ] Gate creation during build shows ⚠ on graph and ops strip
- [ ] Completing a build turns graph node green
