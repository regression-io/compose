# Session 19: Session-Lifecycle Binding

**Date:** 2026-03-06
**Phase:** 6 (Lifecycle Engine), Layer 5

## What Happened

The ask was to implement L4 (Gate UI) and L5 (Session-Lifecycle Binding) in parallel. The human clarified early that another agent would handle L4 — this session focused exclusively on L5.

L5 connects two independent tracking systems: the session manager (tool-use events, Haiku summaries, work blocks) and the lifecycle manager (phase state machine per feature). Before this work, a 45-minute session working on `gate-ui` knew nothing about `gate-ui` — it was just tool counts and touched items.

The design went through multiple review rounds. The human caught three issues in the design doc: a timing problem with session-start hooks (binding happens after Phase 1 starts, not before), a rebinding conflict (the "sticky for lifetime" model conflicted with an update path), and a transcript format mislabel (`.md` vs `.jsonl`). Each was real.

The blueprint went through four review rounds. The human found eight issues total — constructor inconsistency, `readFileSync` import mismatch, active session visibility from the MCP process, transcript filing race conditions, feature-scoped fallback leaking unrelated sessions, missing `recentSummaries` in two of three response branches. The `_buildFeatureContext` helper emerged from the last fix — a single function that normalizes the response shape across all three featureCode query branches.

Implementation was 7 tasks across 13 files. Two final review findings caught a path traversal vulnerability in `featureCode` (used in `path.join` for transcript filing) and missing HTTP error handling in the MCP bind tool. Both fixed with test coverage.

## What We Built

**Server (7 files):**
- `session-manager.js` — constructor injection, `bindToFeature()`, `_fileTranscript()`, `getContext(featureCode)`
- `session-store.js` — binding fields in serialization, `readSessionsByFeature()`
- `vision-store.js` — `getItemByFeatureCode()`
- `session-routes.js` — bind endpoint, history endpoint, enriched current endpoint with `_buildFeatureContext`
- `index.js` — SessionManager constructed with feature-aware callbacks
- `vision-server.js` — passes store to session routes
- `activity-routes.js` — phase enrichment on activity broadcasts

**MCP (2 files):**
- `compose-mcp-tools.js` — `toolBindSession()`, async `toolGetCurrentSession(featureCode)`
- `compose-mcp.js` — `bind_session` schema and dispatch

**Client (5 files):**
- `visionMessageHandler.js` — `sessionBound` handler, enriched start/end
- `useVisionStore.js` — hydration includes binding fields
- `AgentPanel.jsx` — feature context header with phase badge
- `AppSidebar.jsx`, `VisionTracker.jsx` — prop threading for `onSelectItem`
- `ItemDetailPanel.jsx` — `SessionHistory` component

**Tests:** 31 tests in `test/session-binding.test.js`

**Docs:** design.md, blueprint.md, plan.md, report.md in `docs/features/session-lifecycle-binding/`

## What We Learned

1. **Two-phase context injection solves timing gaps.** The session starts before binding happens (binding requires a `bind_session` call in Phase 1). Generic context at start, enriched context after binding. Don't try to predict the feature at session start.

2. **MCP process isolation requires REST delegation.** The MCP tools process can't see in-memory session state. `toolGetCurrentSession(featureCode)` delegates to `GET /api/session/current?featureCode=...` rather than reading from disk. The REST endpoint has access to both live and persisted sessions.

3. **Normalize response shapes with a helper, not per-branch logic.** Three branches in the featureCode query path were building responses independently. Two of three forgot `recentSummaries`. One helper function, three callers, zero inconsistencies.

4. **Path traversal is always the first review finding on any endpoint that touches the filesystem.** `featureCode` goes into `path.join()` for transcript filing. Regex validation at the entry point, matching the existing `_validateFeatureCode` pattern in `artifact-manager.js`.

5. **Blueprint review rounds compound quality.** Eight issues caught across four rounds. Each round was two findings. The human reviewed methodically — constructor consistency, import patterns, race conditions, response shape consistency. This is the pattern the compose skill should automate.

## Open Threads

- [ ] Vision board item needs status update (server was offline)
- [ ] E2E smoke test with live server: trigger session, call `bind_session`, verify AgentPanel header, check transcript filing
- [ ] L4 (Gate UI) implementation by other agent — verify no conflicts with L5 changes
