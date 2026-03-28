# COMP-UI-6: Blueprint

**Updated:** 2026-03-28 (verified against live codebase)

## Task 1: Dead Code Deletion

### 1a. Redirect imports away from VisionTracker

Before deleting VisionTracker.jsx, fix its consumers:

| File | Line | Change |
|------|------|--------|
| `src/components/vision/ChallengeModal.jsx` | 7 | `import { VisionChangesContext } from './VisionTracker.jsx'` → `'./VisionChangesContext.js'` |

PopoutView.jsx (line 5) imports VisionTracker as a full component for `vision://` popout paths. Check if PopoutView is actively used — if not, delete it too. If yes, inline a minimal popout or keep VisionTracker for popout only.

### 1b. Delete dead files

| File | Lines | Verified dead |
|------|-------|---------------|
| `src/components/vision/AppSidebar.jsx` | ~120 | Not imported by any live file. Only referenced in comments. |
| `src/components/vision/ItemRow.jsx` | ~960 | Not imported by any live file. Self-recursive only. |
| `src/components/vision/VisionTracker.jsx` | ~350 | Deprecated. After 1a redirect, only PopoutView depends on it. |

### 1c. Clean vision-logic.js

Only 2 of 10 exports are used (`filterSessions`, `relativeTime` by SessionsView.jsx).

**Remove these dead exports:**
- `isGateBlocked` (line 43) — was for BoardView drag-drop
- `sortItems` (line 59) — was for ItemListView
- `groupItems` (line 91) — was for ItemListView
- `groupLabel` (line 133) — was for ItemListView
- `filterItems` (line 155) — was for ItemListView
- `CHILD_EDGE_TYPES` (line 184) — was for RoadmapView
- `getChildren` (line 195) — was for RoadmapView
- `countDescendants` (line 224) — was for RoadmapView
- `rollupStatus` (line 252) — was for RoadmapView
- `STATUS_ORDER` (line 50) — internal to dead `sortItems`

Also remove section markers: `// --- BoardView`, `// --- ItemListView`, `// --- RoadmapView`.

Keep: `relativeTime` (line 20), `filterSessions` (line 276), `// --- SessionsView` marker, `// --- Shared utilities` marker.

### 1d. Delete dead CSS

From `src/index.css`:
- Lines 118-135: All `--row-*` variables (17 vars) — only consumed by dead ItemRow.jsx
- Line 154: `.row-chevron` class — only consumed by dead ItemRow.jsx

**Keep:** `--border-emphasis` (line 116, 144) — used by `.compose-btn-icon` (line 254). `--color-category-*` — active.

### 1e. Remove dead function export

`src/components/cockpit/agentBarState.js:50` — delete `expandAgentBar()` function (unused export).

### 1f. Update tests

`test/comp-ui-4.test.js` imports dead functions from vision-logic.js. Update to only test `filterSessions` and `relativeTime`, or delete if all tests cover dead code.

## Task 2: Error Boundary Gaps

### Current coverage (6 zones wrapped)

| Zone | Location in App.jsx | Wrapped |
|------|-------------------|---------|
| Header | line 877 | `<PanelErrorBoundary zone="header">` |
| Sidebar | line 990 | `<PanelErrorBoundary zone="sidebar">` |
| Main content | line 1056 | `<PanelErrorBoundary>` |
| Context panel | line 1107 | `<PanelErrorBoundary>` |
| Ops strip | line 1140 | `<PanelErrorBoundary zone="ops strip">` |
| Agent bar | line 1147 | `<PanelErrorBoundary zone="agent bar">` |

### Gaps to fill

| Zone | Location in App.jsx | Action |
|------|-------------------|--------|
| NotificationBar | line 1165 | Wrap: `<PanelErrorBoundary zone="notifications">` |
| GateNotificationBar | line 1170 | Wrap: `<PanelErrorBoundary zone="gate notifications">` |
| ChallengeModal | line 1172-1184 | Wrap: `<PanelErrorBoundary zone="challenge modal">` |
| CommandPalette | line 1192-1197 | Wrap: `<PanelErrorBoundary zone="command palette">` |
| ItemFormDialog | line 1199-1202 | Wrap: `<PanelErrorBoundary zone="item form">` |
| SettingsModal | line 1204-1209 | Wrap: `<PanelErrorBoundary zone="settings">` |

Existing `PanelErrorBoundary` (App.jsx:89-124) already supports the `zone` prop and renders a retry button. No new component needed.

## Task 3: Color Constant Consolidation

### Target file: `src/components/vision/constants.js`

Add new sections after the existing `WORK_TYPE_COLORS` block. Each constant keeps its original shape (object/array) to minimize consumer changes.

### Constants to move

| Source | Constant | Target name | Shape |
|--------|----------|-------------|-------|
| `MessageCard.jsx:17-25` | `TOOL_CATEGORY_COLORS` | `TOOL_CATEGORY_COLORS` | `{ reading: '...', writing: '...', ... }` |
| `ContextPipelineDots.jsx:48-53` | `STATUS_COLORS` | `PIPELINE_STATUS_COLORS` | `{ complete: '...', active: '...', ... }` |
| `TemplateSelector.jsx:6-12` | `CATEGORY_COLORS` | `TEMPLATE_CATEGORY_COLORS` | `{ development: '...', ... }` |
| `GateNotificationBar.jsx:15-34` | `GATE_COLORS` + `FALLBACK_COLOR` | `GATE_COLORS`, `GATE_FALLBACK_COLOR` | object + string |
| `ConfidenceBar.jsx:6` | `COLORS` | `CONFIDENCE_COLORS` | `['slate-600', 'rose-500', ...]` |
| `TimelineEvent.jsx:10-23` | `SEVERITY_COLORS` + `CATEGORY_COLORS` | `SEVERITY_COLORS`, `TIMELINE_CATEGORY_COLORS` | objects |
| `SessionsView.jsx:14-26` | `STATUS_COLORS_SESSION` + `AGENT_COLORS` | `SESSION_STATUS_COLORS`, `AGENT_COLORS` | objects |
| `graphOpsOverlays.js:5-18` | `BUILD_STATE_COLORS` + `AGENT_COLORS` | `BUILD_STATE_COLORS`, share `AGENT_COLORS` from above | objects |
| `AgentPanel.jsx:4-12` | `CATEGORY_COLORS` | `AGENT_CATEGORY_COLORS` | `{ reading: 'var(--color-category-reading)', ... }` |
| `ProductGraph.jsx:18-36` | `COLORS` | Check if values match `TYPE_COLORS` — if yes, replace import; if no, add as `PRODUCT_GRAPH_COLORS` | object |

### Consumer update pattern

For each source file:
1. Copy constant value to constants.js under new name
2. Replace local `const` with `import { NEW_NAME } from './constants.js'`
3. Update any local references to the new name
4. Verify no other file imports the old name from the source file

### AGENT_COLORS dedup

SessionsView.jsx and graphOpsOverlays.js both define `AGENT_COLORS` with the same semantic mapping (agent type → color). Verify values match, then consolidate into one export.

## Verification

- [ ] `npm run build` passes (no broken imports)
- [ ] `npm test` passes (updated tests pass)
- [ ] Zero imports from deleted files: `grep -r 'AppSidebar\|ItemRow\|VisionTracker' compose/src/ --include='*.jsx' --include='*.js'` returns only VisionChangesContext.js re-export line (if kept)
- [ ] Zero references to `--row-` vars: `grep -r '\-\-row-' compose/src/` returns empty
- [ ] All 12 UI zones wrapped in PanelErrorBoundary
- [ ] Color constants only defined in constants.js (no duplicates in component files)
