# COMP-UI-6: Implementation Plan

**Created:** 2026-03-28
**Status:** Executed

## Tasks (all complete)

- [x] Consolidate 13 JS color constants from 9 files into `constants.js`
- [x] Redirect ChallengeModal VisionChangesContext import from VisionTracker to VisionChangesContext.js
- [x] Wrap 6 remaining UI zones in PanelErrorBoundary (NotificationBar, GateNotificationBar, ChallengeModal, CommandPalette, ItemFormDialog, SettingsModal)
- [x] Delete dead files: ItemRow.jsx (~960 lines), AppSidebar.jsx (~120 lines)
- [x] Clean VisionTracker.jsx: remove @deprecated, remove re-export, update docstring for PopoutView use
- [x] Clean vision-logic.js: remove 8 dead functions, keep filterSessions + relativeTime
- [x] Delete 17 `--row-*` CSS variables and `.row-chevron` class from index.css
- [x] Remove `expandAgentBar()` dead export from agentBarState.js
- [x] Update tests: remove dead function tests from comp-ui-4.test.js, remove expandAgentBar from cockpit-layout.test.js

## Verification

- [x] `npx vite build` passes
- [x] `node --test test/comp-ui-4.test.js test/cockpit-layout.test.js` — 46 tests pass, 0 fail
- [x] No production imports of deleted files
- [x] No `--row-*` CSS references
- [x] No `expandAgentBar` in production code
