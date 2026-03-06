# Iteration Orchestration (L6): Implementation Report

**Date:** 2026-03-06
**Design:** [design.md](./design.md)
**Blueprint:** [blueprint.md](./blueprint.md)
**Plan:** [plan.md](./plan.md)

---

## 1. Summary

Iteration loops (review and coverage) are now a Compose-managed primitive. The lifecycle manager tracks loop state server-side, enforces max iterations, requires structured exit signals via MCP tools, and broadcasts progress to the Vision Surface via WebSocket. Agents report iteration results through `start_iteration_loop`, `report_iteration_result`, and `get_iteration_status` MCP tools instead of text strings.

## 2. Delivered vs Planned

| Planned | Delivered | Notes |
|---------|-----------|-------|
| `ITERATION_DEFAULTS` constant | Yes | review: 10, coverage: 15 |
| `iterationState` on lifecycle object | Yes | Null until loop starts |
| 3 lifecycle manager methods | Yes | `startIterationLoop`, `reportIterationResult`, `getIterationStatus` |
| 3 REST endpoints | Yes | start, report, GET status |
| 3 MCP tools + definitions | Yes | Registered in compose-mcp.js |
| 3 WS message types | Yes | `iterationStarted`, `iterationUpdate`, `iterationComplete` |
| Client handler for iteration messages | Yes | Activity feed + error surface |
| `coverage-sweep.stratum.yaml` | Yes | YAML validated |
| Phase transition guard | Yes | **Added during review** — not in original plan |
| Tests | 39 total | 21 manager + 13 routes + 5 client |

## 3. Architecture Deviations

- **`iterationComplete` as separate broadcast**: The original blueprint had a single `iterationUpdate` for all events. Review identified that the design spec requires three distinct WS message types. Fixed: the route sends `iterationUpdate` for every report, plus `iterationComplete` when `continueLoop === false`.

- **Phase transition guard**: Not in the original design or blueprint. Review identified that `advancePhase`/`skipPhase` could leave `execute` while an iteration loop was active, making loops optional metadata. Fixed: both methods now throw if `iterationState` exists with `completedAt === null`.

- **`loopType` in `reportIterationResult` return value**: Blueprint originally omitted `loopType` from the return. Needed by the route to include in WS broadcast. Added during blueprint reconciliation.

## 4. Key Implementation Decisions

1. **Guard placement**: The active-loop guard is in `advancePhase`/`skipPhase`, not in `#executeAdvance`/`#executeSkip`. This ensures gates also respect the guard — a gated advance will still fail if the loop hasn't completed.

2. **`iterationComplete` is always paired with `iterationUpdate`**: The route sends both when a loop ends. This means clients that only listen for `iterationUpdate` still see the final iteration, while clients that care about completion get a clean signal.

3. **`items: []` on activity entries**: Iteration events don't carry tracker item objects. The AgentPanel's "Working on" rows are populated from `entry.items` which expects `{id, status, title}` objects. Empty array prevents rendering artifacts.

4. **`max_reached` surfaces through `setAgentErrors` + `errorCount`**: Consistent with how `agentError` WS messages are handled. The session header chip shows the error count.

## 5. Test Coverage

| Test File | Tests | Coverage |
|-----------|-------|----------|
| `test/iteration-manager.test.js` | 21 | Constants, start/reject/override, report/exit/max, status, phase transition guard |
| `test/iteration-routes.test.js` | 13 | REST endpoints, broadcast shapes, MCP tool names, error cases |
| `test/iteration-client.test.js` | 5 | All 3 message types, max_reached error path, empty items |
| **Total new** | **39** | |
| **Full suite** | **306** | 0 failures |

## 6. Files Changed

| File | Change |
|------|--------|
| `server/lifecycle-constants.js` | Added `ITERATION_DEFAULTS` |
| `server/lifecycle-manager.js` | Added `iterationState` field, 3 methods, phase transition guard |
| `server/vision-routes.js` | Added 3 REST endpoints with WS broadcasts |
| `server/compose-mcp-tools.js` | Added 3 tool implementations |
| `server/compose-mcp.js` | Added 3 tool definitions, imports, switch cases |
| `src/components/vision/visionMessageHandler.js` | Added iteration message handler |
| `pipelines/coverage-sweep.stratum.yaml` | New pipeline (coverage sweep) |
| `test/iteration-manager.test.js` | New (21 tests) |
| `test/iteration-routes.test.js` | New (13 tests) |
| `test/iteration-client.test.js` | New (5 tests) |

## 7. Known Issues & Tech Debt

- **Token budget comment stale**: `compose-mcp.js` lines 19-23 still reference "5 tools / ~519 tokens". Now 18 tools. Low priority — cosmetic.
- **No dedicated iteration UI**: Per design D5, iteration events render as activity feed entries. A progress bar or loop dashboard is a follow-up.
- **Single-loop constraint**: Only one loop active at a time. If parallel review+coverage is ever needed, `iterationState` would need to become an array or map.

## 8. Lessons Learned

1. **Phase transition guards are essential for sub-phase state**: Any state that must complete before a phase exits needs an explicit guard in the transition methods, not just documentation. The lifecycle manager's `pendingGate` guard was the pattern to follow.

2. **WS message type parity with design**: When the design specifies N distinct event types, the implementation must emit N types — not overload one type with different payloads. Clients key on `msg.type` for routing.

3. **Activity entry shape must match renderer expectations**: The AgentPanel's `items` array expects objects, not strings. Passing the wrong shape doesn't crash but produces invisible rendering bugs.
