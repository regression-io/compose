# COMP-UI-6: Polish and Teardown

## Problem

The cockpit UI is functionally complete (COMP-UI-1 through COMP-UI-5, COMP-UX-1) but has accumulated dead code from the prototype migration, scattered color token definitions, and incomplete error isolation between UI zones.

## Goal

Clean production codebase: no dead code, centralized color tokens, error boundaries per zone. localStorage persistence is already complete (no work needed).

## Scope

### 1. Dead Code Deletion

**Files to delete:**
- `compose-ui/` — entire old prototype directory (zero runtime references from production)
- `src/hooks/use-mobile.jsx` — unused hook, zero references
- `src/components/vision/shared/SkeletonCard.jsx` — unused component

**Code to delete:**
- `expandAgentBar()` export in `src/components/cockpit/agentBarState.js`
- Stale view comments in `src/components/vision/vision-logic.js` (references to deleted BoardView, ItemListView, RoadmapView)
- 5 unused CSS variables in `src/index.css`: `--button-border-radius`, `--button-font-weight`, `--button-padding-vertical`, `--button-padding-horizontal`, `--input-height`

### 2. Error Boundaries Per Zone

Currently wrapped: main content area, context panel.

**Add boundaries for:** sidebar, header/ViewTabs, AgentBar, OpsStrip.

Each boundary catches render errors independently so one zone crashing doesn't take down the others. Fallback shows zone name + retry button.

### 3. Color Token Merge

~60 legacy CSS variables (`--compose-void`, `--compose-base`, `--ember`, `--indigo`, `--magenta`, etc.) defined in `src/index.css` lines 99-160, consumed by 8 files via inline `hsl(var(...))` styles.

**Strategy:** Map each legacy variable to its nearest Tailwind semantic equivalent (from the HSL system already in index.css). Update the 8 consumer files. Delete the legacy block.

### 4. localStorage Persistence — ALREADY DONE

All cockpit state is persisted: active view, sidebar collapsed, font size, theme, context panel width, selected phase, docs tree width, tracks. No work needed.

## Non-Goals

- No new features
- No component refactoring beyond what's needed for color migration
- No test changes (unless deleting tests for deleted code)
