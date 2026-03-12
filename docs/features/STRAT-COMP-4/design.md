# STRAT-COMP-4: Unified Interface

**Status:** PLANNED
**Created:** 2026-03-11
**Roadmap:** Milestone 4 (items 47–51)

## Related Documents

- [ROADMAP.md](../../../ROADMAP.md) — Milestone 4: Unified Interface
- [STRAT-COMP-3 design](../STRAT-COMP-3/design.md) — Milestone 3: Prove It (prerequisite)

## Intent

CLI pipeline runner (`compose build`, `compose new`) and web UI (`compose start`) are currently disconnected systems that share a JSON file. This feature unifies them so builds are visible and controllable from the web UI.

## Current State (Problems)

### Vision Store Mismatch (STRAT-COMP-4, item 47)
- `VisionWriter` (CLI) uses `featureCode: "feature:FEAT-1"` format
- `VisionStore` (server) queries via `item.lifecycle?.featureCode`
- Transitional hack in `vision-writer.js:33-39` checks both conventions
- Both read/write `data/vision-state.json` without coordination
- **Core issue:** server keeps long-lived in-memory state. Even with file locking, the server can overwrite newer CLI changes on its next save.

### No Build Visibility (STRAT-COMP-5, item 48)
- `compose build` logs step progress to terminal only
- Web UI has no awareness of active builds
- `active-build.json` is written by CLI but never read by server

### Separate Gate Systems (STRAT-COMP-6, item 49)
- CLI: readline prompt → `VisionWriter.resolveGate()` → `vision-state.json`
- Server: `POST /api/vision/gates/:id/resolve` → in-memory VisionStore → Stratum
- Two separate gate tracking systems that diverge

### Disconnected Agent Streams (STRAT-COMP-7, item 50)
- CLI: stateless one-shot `query()` per step, output to terminal
- Server: stateful session with `resume`, SSE via agent-server on `AGENT_PORT`
- Same `ClaudeSDKConnector` class, different invocation patterns

### No Build Dashboard (STRAT-COMP-8, item 51)
- Web UI has Gate View and Attention View but no Build View
- No way to see: current step, retry count, violations, audit trail
- `active-build.json` tracks this but only for CLI abort/resume

## Architecture

### Ownership Model

**Single authority for `vision-state.json`:**
- **Server running:** Server owns the file. CLI talks to server via REST (`POST /api/vision/items`, `POST /api/vision/gates`). `VisionWriter` becomes a thin REST client when server is reachable.
- **Server not running:** CLI owns the file. `VisionWriter` writes directly as it does today.

Detection: CLI probes `GET http://localhost:${COMPOSE_PORT}/api/health` (respecting `COMPOSE_PORT` env var, default 3001). Liveness is checked at each gate, not cached at build start — the server may come up or go down mid-build. Each check has a short timeout (500ms) so it doesn't block when the server is down.

This eliminates the race condition entirely — there is never concurrent write access.

### Data Flow

```
compose build/new
    │
    ├── Server running?
    │     │
    │     ├── YES: VisionWriter → REST calls to server
    │     │         Gate pending → POST /api/vision/gates, poll for resolution
    │     │         Build stream → append .compose/build-stream.jsonl
    │     │
    │     └── NO:  VisionWriter → direct file writes (current behavior)
    │              Gate pending → readline prompt (current behavior)
    │
    ├── writes active-build.json (always, for abort/resume)
    ├── writes docs/discovery/*.md, ROADMAP.md (always, artifacts)
    │
    ▼
compose start (server)
    │
    ├── file watcher: docs/ (already), extend to active-build.json
    ├── REST endpoints: receive vision mutations from CLI
    ├── agent-server: ingest build-stream.jsonl → SSE broadcast
    └── WebSocket: broadcast state changes to all clients
```

### Gate Delegation

```
CLI detects gate_pending
  → Is server running? (checked at gate time, 500ms timeout)
    → YES:
        1. POST /api/vision/gates {
             flowId, stepId, itemId,
             artifact, options,
             fromPhase, toPhase
           }
           (itemId from VisionWriter.ensureFeatureItem, phases from lifecycle)
        2. Poll GET /api/vision/gates/:id every 2s
        3. Gate View shows pending gate in web UI
        4. User resolves via web UI → POST /api/vision/gates/:id/resolve
        5. CLI poll picks up resolution, continues build
    → NO:
        Fall back to readline prompt (current behavior)
```

### Agent Stream Transport

The agent-server (port `AGENT_PORT`) owns the SSE stream to AgentStream UI. For build visibility:

1. CLI appends tool_use events to `.compose/build-stream.jsonl`
2. Agent-server watches that file (tail -f style) and rebroadcasts events on the existing SSE endpoint
3. AgentStream UI receives build events through its existing subscription — no second connection needed

## Acceptance Criteria

### STRAT-COMP-4: Vision Store Unification
- [ ] Single `featureCode` format: `item.lifecycle.featureCode` everywhere
- [ ] Remove transitional hack from `vision-writer.js`
- [ ] `VisionWriter` gains REST mode: detects server, uses `POST /api/vision/*` when available
- [ ] REST-mode bootstrap is a two-step sequence using existing API surface:
  1. `POST /api/vision/items` → creates item, returns `itemId`
  2. `PATCH /api/vision/items/:itemId` with `{ lifecycle: { featureCode, currentPhase } }` — requires extending `updateItem()` in VisionStore to accept lifecycle fields
  Alternatively, add `POST /api/vision/items/:itemId/start-lifecycle { featureCode, currentPhase }` as a dedicated endpoint. Either way, VisionStore.createItem() or updateItem() must persist lifecycle data — this is a server-side change, not just a client change.
- [ ] Direct file mode only when server is not running
- [ ] Server reloads `vision-state.json` from disk on startup (already does)

### STRAT-COMP-5: Build Visibility
- [ ] Server file watcher extended to watch `active-build.json`
- [ ] Parse `active-build.json` on change → broadcast build state via WebSocket
- [ ] Build state message includes: pipeline, currentStep, stepNum, totalSteps, retries, violations

### STRAT-COMP-6: Web Gate Resolution
- [ ] CLI probes `GET /api/health` at build start, caches result (respects `COMPOSE_PORT`)
- [ ] Gate pending: CLI creates gate via `POST /api/vision/gates`, polls for resolution
- [ ] Gate View in web UI shows pending gates from build (already exists, verify it works)
- [ ] `POST /api/vision/gates/:id/resolve` returns outcome to polling CLI
- [ ] Readline fallback when server is unreachable

### STRAT-COMP-7: Agent Stream Bridge
- [ ] CLI appends events to `.compose/build-stream.jsonl`
- [ ] Agent-server tails that file and rebroadcasts on existing SSE endpoint
- [ ] Build events mapped to SDK message shapes the UI already renders:
  - `step_start` → `{ type: "system", subtype: "init", message: { content: [{ type: "text", text: "Step: research..." }] } }`
  - `tool_use` → `{ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } }`
  - `step_done` → `{ type: "result", result: "Step complete: ..." }`
  - `step_boundary` → `{ type: "system", subtype: "compact_boundary" }` (visual separator)
- [ ] Agent-server performs this mapping when ingesting build-stream events — frontend unchanged

### STRAT-COMP-8: Active Build Dashboard
- [ ] Build View component in web UI
- [ ] Shows: pipeline name, current step, progress bar, retries, violations
- [ ] Live updates via WebSocket from `active-build.json` watcher
- [ ] Audit trail viewer after build completes

## Build Sequence

1. STRAT-COMP-4 (vision store) — prerequisite, eliminates race condition
2. STRAT-COMP-5 (build visibility) — extend file watcher, cheapest win
3. STRAT-COMP-6 (web gates) — highest user-facing value
4. STRAT-COMP-7 (agent stream) — agent-server ingests build log
5. STRAT-COMP-8 (dashboard) — UI component, depends on 5 for data
