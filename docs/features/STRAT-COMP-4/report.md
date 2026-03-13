# STRAT-COMP-4: Vision Store Unification — Implementation Report

**Status:** COMPLETE
**Date:** 2026-03-13
**Feature:** STRAT-COMP-4 (Vision Store Unification)

## Related Documents

- [design.md](./design.md) — Parent design for Milestone 4
- [blueprint.md](./blueprint.md) — Implementation blueprint with file:line references
- [plan.md](./plan.md) — 22-task implementation plan

---

## What Was Built

Unified the vision state system so VisionWriter (CLI) and VisionStore (server) share a single data format, port resolution chain, and gate contract. The implementation spans 9 source files and 5 test files.

### Foundation (Tasks 1–5)
- **`lib/resolve-port.js`** — Canonical port resolution: `COMPOSE_PORT > PORT > 3001`. Used by server, VisionWriter, build runner, and Vite proxy.
- **`lib/server-probe.js`** — `probeServer(port, timeout)` fetches `/api/health` with AbortController. Returns boolean, never throws.
- **`server/vision-store.js`** — Atomic writes via temp file + `renameSync`. Migration on load (legacy `featureCode: "feature:X"` → `lifecycle.featureCode`). Gate outcome normalization. New methods: `getGateByFlowStep`, `getGateById`, `getAllGates`.
- **`server/index.js`** — Uses `resolvePort()` instead of hardcoded `PORT`.

### featureCode Unification (Tasks 6–8)
- **`lib/vision-writer.js`** — Complete rewrite. Dual dispatch: REST when server up, direct file when down. `ServerUnreachableError` for `requireServer` mode. Migration on `_load()`. All methods async. Default gate round = 1. Outcome normalization in direct mode.
- **`server/feature-scan.js`** — Updated to use `lifecycle.featureCode`.

### REST Mode (Tasks 9–13)
- VisionWriter REST variants for: `findFeatureItem`, `ensureFeatureItem`, `updateItemStatus`, `updateItemPhase`, `createGate`, `getGate`, `resolveGate`.
- `_fetch()` helper with 5s timeout, throws on non-2xx.
- `_restEnsureFeatureItem` handles partial repair (item exists without lifecycle).

### Call Sites (Tasks 14–15)
- **`lib/build.js`** — All VisionWriter calls awaited. `pollGateResolution` with 3-failure tolerance. Unified `handleGate` with server-up/down paths. Mid-poll fallback uses REST-only sync.
- **`lib/new.js`** — Same pattern. Gate rationale persisted through all paths.

### Gate Delegation (Tasks 16–19)
- **`server/vision-routes.js`** — Gate creation endpoint with idempotency. Outcome normalization (`approved`→`approve`, etc.). Gate expiry persisted to disk. **AD-4 compliant**: server does NOT advance lifecycle or kill items on gate resolve.

### Tests (Tasks 20, 22)
- 55 tests across 5 files, all passing.

## Deviations from the Plan

1. **Gate ID format**: Plan specified `${flowId}:${stepId}:${round}` with optional round. During Codex review, this was tightened to always default round to 1, producing consistent IDs across REST and direct modes.

2. **Mid-poll fallback sync**: Originally used dual-dispatch `resolveGate()` which could fall back to direct file writes. Codex review identified this as reintroducing server-memory divergence. Changed to `_restResolveGate()` (REST-only, best-effort).

3. **Gate expiry persistence**: Initially only applied in-memory. Codex review flagged that restarts would resurrect expired gates. Added `store._save()` after expiry marking.

4. **Partial REST bootstrap repair**: Original `_restEnsureFeatureItem` couldn't find partially-created items (those without lifecycle). Fixed to search all feature items by title as fallback.

## Architecture Decisions

- **AD-4 (Gate Delegation)**: Server is stateless with respect to lifecycle transitions. It stores gate state and broadcasts events, but CLI owns all Stratum interactions and lifecycle state changes. This avoids split-brain between Stratum flow state and server state.

- **Outcome Normalization**: Canonical outcomes are `approve`, `revise`, `kill`. Normalization happens at three layers: migration on load, direct-mode resolve, and REST endpoint. This ensures consistency regardless of whether callers use legacy (`approved`) or canonical (`approve`) values.

- **Atomic Writes**: Both VisionStore and VisionWriter use temp file + `renameSync`. This prevents partial writes from corrupting state if the process dies mid-write.

## Lessons Learned

1. Gate ID contracts must be explicit about defaults. Optional fields that affect identity (like `round`) cause subtle divergence between code paths.
2. Dual-dispatch systems need normalization at every write boundary, not just at read time.
3. "Best effort sync" after server loss should be REST-only to avoid creating divergent local state.

## Ship-Gate Fixes (Round 2)

5. **Orphaned gate reconciliation**: Mid-poll fallback in `build.js` and `new.js` now falls back to direct file write (`_directResolveGate`) when REST resolve fails, preventing stale pending gates after server loss.
6. **Client-side gate status shape**: `visionMessageHandler.js` optimistic update now sets `status: 'resolved'` instead of `status: msg.outcome`, matching the canonical gate shape.

## Remaining Tech Debt

- Task 21 (cross-feature doc synchronization) was deferred — STRAT-COMP-2, 5, 8 design docs reference the old featureCode format and should be updated.
- No test coverage for server-up VisionWriter REST dispatch (would require running a real Express server in tests).
- `lib/new.js` has no dedicated test file — gate handling is only covered indirectly via build.test.js patterns.
- `pollGateResolution` loop is not tested (would need mock timers or a test server with delayed resolution).
