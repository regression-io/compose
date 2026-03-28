# COMP-UI-6: Polish and Teardown

**Updated:** 2026-03-28 (verified against live codebase)

## Problem

The cockpit UI is functionally complete (COMP-UI-1 through COMP-UI-5, COMP-UX-1, COMP-STATE) but has accumulated dead components from the pre-COMP-UX-1 architecture, scattered JS color constant definitions, and two remaining error boundary gaps.

## Goal

Clean production codebase: no dead components, centralized color constants, error boundaries on all UI zones. localStorage persistence is already complete.

## Scope

### 1. Dead Code Deletion

**Files to delete:**

| File | Reason |
|------|--------|
| `src/components/vision/AppSidebar.jsx` | Not imported by App.jsx or any live component. Replaced by AttentionQueueSidebar + ViewTabs. |
| `src/components/vision/ItemRow.jsx` | Not imported by any component. Was used by old Roadmap view. |
| `src/components/vision/VisionTracker.jsx` | Marked `@deprecated`. Absorbed into App.jsx. ChallengeModal import must be redirected first. PopoutView dependency must be assessed. |

**Import redirects before deletion:**

| Consumer | Current import source | Redirect to |
|----------|----------------------|-------------|
| `ChallengeModal.jsx:7` | `VisionChangesContext` from `./VisionTracker.jsx` | `./VisionChangesContext.js` |
| `PopoutView.jsx:5` | `VisionTracker` (full component) | Assess: if PopoutView is actively used, extract minimal popout renderer. If unused, delete PopoutView too. |

**Code to remove:**

| Location | What | Reason |
|----------|------|--------|
| `agentBarState.js:50` | `expandAgentBar()` function | Unused export |
| `vision-logic.js` | 8 dead functions: `isGateBlocked`, `sortItems`, `groupItems`, `groupLabel`, `filterItems`, `CHILD_EDGE_TYPES`, `getChildren`, `countDescendants`, `rollupStatus` | Only `filterSessions` and `relativeTime` are imported (by SessionsView.jsx) |
| `index.css:118-136` | `--row-*` CSS variables (17 vars) + `.row-chevron` class | Only consumed by dead ItemRow.jsx |
| `test/comp-ui-4.test.js` | Tests for dead vision-logic functions | Tests dead code — update to only test live exports |

### 2. Error Boundaries — Remaining Gaps

**Already wrapped (6 zones):** header, sidebar, main content, context panel, ops strip, agent bar.

**Missing:**
- `NotificationBar` (App.jsx:1165) — not wrapped
- Modal stack: ChallengeModal, GateNotificationBar, CommandPalette, ItemFormDialog, SettingsModal — not wrapped

Each gap gets a `<PanelErrorBoundary zone="...">` wrapper. Modal errors should dismiss gracefully, not crash the app.

### 3. Color Constant Consolidation

Legacy CSS variables are already cleaned up. The remaining issue is **scattered JS color constants** across 10+ component files. The central file `src/components/vision/constants.js` already has TYPE_COLORS, STATUS_COLORS, WORK_TYPE_COLORS.

**JS constants to consolidate into constants.js:**

| Source file | Constant | Target name in constants.js |
|-------------|----------|-----------------------------|
| `MessageCard.jsx` | `TOOL_CATEGORY_COLORS` | `TOOL_CATEGORY_COLORS` |
| `ContextPipelineDots.jsx` | `STATUS_COLORS` (duplicate) | `PIPELINE_STATUS_COLORS` |
| `TemplateSelector.jsx` | `CATEGORY_COLORS` | `TEMPLATE_CATEGORY_COLORS` |
| `GateNotificationBar.jsx` | `GATE_COLORS` + `FALLBACK_COLOR` | `GATE_COLORS`, `GATE_FALLBACK_COLOR` |
| `ConfidenceBar.jsx` | `COLORS` (array) | `CONFIDENCE_COLORS` |
| `TimelineEvent.jsx` | `SEVERITY_COLORS` + `CATEGORY_COLORS` | `SEVERITY_COLORS`, `TIMELINE_CATEGORY_COLORS` |
| `SessionsView.jsx` | `STATUS_COLORS_SESSION` + `AGENT_COLORS` | `SESSION_STATUS_COLORS`, `AGENT_COLORS` |
| `graphOpsOverlays.js` | `BUILD_STATE_COLORS` + `AGENT_COLORS` | `BUILD_STATE_COLORS`, unify with above `AGENT_COLORS` |
| `AgentPanel.jsx` | `CATEGORY_COLORS` (CSS vars) | `AGENT_CATEGORY_COLORS` |
| `ProductGraph.jsx` | `COLORS` (type→hex) | Replace with `TYPE_COLORS` import if values match |

### 4. localStorage Persistence — ALREADY DONE

13+ keys already persisted. No work needed.

## Non-Goals

- No new features
- No component refactoring beyond import redirects
- No hardcoded hex cleanup (leave for future pass)
- No CSS variable migration (already done)
