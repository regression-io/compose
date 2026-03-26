# Session Context - 2026-03-16

## Task Summary
Build all COMP-UX-1 sub-features (1b through 1f) for the Compose cockpit UI, then fix the underlying state management architecture (COMP-STATE 1-4), then design the next feature (COMP-DESIGN-1).

## Current State
in-progress
COMP-UX-1 (all 6 sub-features) and COMP-STATE (all 4 features) are complete and pushed. COMP-DESIGN-1 design doc is written. Implementation has not started.

## Key Decisions
- **Zustand singleton store**: Replaced React hook `useVisionStore` with Zustand `create()` store. One WebSocket, one state, one set of intervals. All consumers use `useShallow` selectors.
- **fcose layout**: Graph uses `cytoscape-fcose` for compound node packing instead of dagre (which stacks disconnected nodes vertically).
- **Feature code grouping**: Graph groups items by known feature code prefix whitelist (COMP-UX, STRAT-ENG, etc.), not by item type or regex.
- **Pixel-based context panel**: Switched from fraction-based to pixel-based width with drag handle.
- **Stratum sub-flow fix**: Fixed `server.py:201` — parent flow steps with `step_mode: flow` now correctly read child flow output instead of returning None.
- **COMP-DESIGN-1 direction**: New "Design" view tab for interactive product design conversations. LLM asks questions, presents decision cards with recommendations. Human clicks cards or types free text. Decisions accumulate into live design doc. LLM researches inline. Sessions scoped to product or feature. Any decision revisable. Human can edit the doc directly.

## Files Modified (key files, not exhaustive)

### COMP-UX-1 (cockpit UI features)
- `compose/src/App.jsx` - Width computation, ops strip, build lifecycle, cross-view nav, agent bar integration
- `compose/src/components/cockpit/ContextPanel.jsx` - Dynamic pixel width, drag handle, project summary
- `compose/src/components/cockpit/ContextItemDetail.jsx` - DetailTabs routing, featureCode resolution
- `compose/src/components/cockpit/DetailTabs.jsx` - (new) Tab strip for context panel
- `compose/src/components/cockpit/OpsStrip.jsx` - (new) Persistent ops bar with build/gate/error pills
- `compose/src/components/cockpit/OpsStripEntry.jsx` - (new) Pill component with animations
- `compose/src/components/cockpit/opsStripLogic.js` - (new) Entry derivation logic
- `compose/src/components/cockpit/contextPanelState.js` - (new) Width computation + detail tab definitions
- `compose/src/components/vision/ContextPipelineDots.jsx` - (new) Pipeline dot visualization
- `compose/src/components/vision/ContextSessionsTable.jsx` - (new) Sessions table filtered by feature
- `compose/src/components/vision/ContextErrorLog.jsx` - (new) Error log filtered by feature
- `compose/src/components/vision/ContextFilesTab.jsx` - (new) Feature folder file list
- `compose/src/components/vision/GraphView.jsx` - Rewrote: fcose layout, compound grouping, build overlays, badges, gate popover
- `compose/src/components/vision/graphOpsOverlays.js` - (new) buildStateMap computation
- `compose/src/components/vision/AttentionQueueSidebar.jsx` - Group filters replacing phase/track filters
- `compose/src/components/vision/shared/GateNotificationBar.jsx` - No raw UUIDs, readable gate labels
- `compose/src/components/AgentStream.jsx` - Chat pre-selection on feature code pattern

### COMP-STATE (singleton store)
- `compose/src/components/vision/useVisionStore.js` - Complete rewrite: Zustand singleton, single WebSocket, HMR teardown with disposed guard
- `compose/src/components/vision/visionMessageHandler.js` - Gate race fix (remove optimistic fetch), session zombie fix (3s timer)

### Stratum fix
- `stratum/stratum-mcp/src/stratum_mcp/server.py` - Line 201: fix child flow output unwrapping

### Tests
- `compose/test/context-panel-state.test.js` - (new) 19 tests for width/tab logic
- `compose/test/ops-strip.test.js` - (new) 13 tests for entry derivation
- `compose/test/vision-store.test.js` - (new) 11 tests for store lifecycle
- `compose/test/gate-client.test.js` - Updated: gateId fallback instead of null

### Docs
- `ROADMAP.md` - COMP-UX-1 all COMPLETE, COMP-STATE all COMPLETE, COMP-DESIGN-1 PLANNED
- `compose/README.md` - Web UI section rewritten for cockpit architecture
- `docs/features/COMP-DESIGN-1/design.md` - (new) Full design spec for interactive design conversation

## Pending Work
- [ ] COMP-DESIGN-1: Build the Design view (DesignView.jsx, DesignCard.jsx, DesignSidebar.jsx)
- [ ] COMP-DESIGN-1: Server-side design session (design-session.js, design-routes.js, SSE streaming)
- [ ] COMP-DESIGN-1: Structured output protocol (```decision``` block parsing)
- [ ] COMP-DESIGN-1: Live design doc preview with human editing
- [ ] COMP-DESIGN-1: Agent dispatch with inline research (web search, codebase scan)
- [ ] COMP-DESIGN-2: Session persistence + sidebar (topic outline, decision log)
- [ ] COMP-DESIGN-3: `compose new` integration (detect docs/design.md, skip questionnaire)
- [ ] COMP-UX-1 status: Update ROADMAP to mark COMP-UX-1 as COMPLETE (not just sub-features)
- [ ] Stratum fix: Commit the server.py fix to the stratum repo separately

## Important Context
- Git root for compose is `/Users/ruze/reg/my/forge/compose` (not the forge root)
- ROADMAP.md is at the forge root `/Users/ruze/reg/my/forge/ROADMAP.md` (outside compose git)
- Stratum MCP server was reinstalled with the sub-flow fix (`pip install -e ".[dev]"`)
- The self-preservation rule was deleted per user request
- Feature code prefix whitelist in GraphView: COMP-UX, COMP-UI, COMP-RT, COMP-BENCH, STRAT-ENG, STRAT-COMP, STRAT-PAR, INIT, TEST
- All COMP-STATE features are complete: Zustand singleton, gate race fix, build completion flash, session zombie fix
- 89 tests passing across 5 test files (context-panel-state, cockpit-layout, ops-strip, vision-store, gate-client)
- Audit found all 33 COMP-UX-1 acceptance criteria passing
- COMP-DESIGN-1 design decisions: inline research, multi-session (product + per-feature), revisable decisions, live doc preview with human editing
