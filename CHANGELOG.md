# Changelog

## 2026-03-28

### COMP-UX-11: Feature Event Timeline

- Collapsible right panel on Dashboard showing chronological feature lifecycle events
- 5 event categories: Phase, Gate, Session, Iteration, Error — each with distinct icons and severity colors
- Historical hydration from sessions.json + gates; live updates via WebSocket
- Virtualized scrolling (`@tanstack/react-virtual`) for large event histories
- Filter chips to narrow by event category
- Added client-side handlers for previously unhandled `lifecycleStarted` and `lifecycleTransition` WebSocket messages
- Gate outcome normalization handles both short-form (`approve`) and long-form (`approved`) variants
- New files: `timelineAssembler.js`, `EventTimeline.jsx`, `TimelineEvent.jsx`
- 11 unit tests for timeline assembler

## 2026-03-19

### Phase 4.5 Closed + Phase 6 Closed

**18h: Acceptance Gate (Phase 4.5)**
- Registered `agents` MCP server in `.mcp.json` — `agent_run` tool now discoverable
- Copied `review-fix.stratum.yaml` to `pipelines/` (was only in worktree)
- Fixed JSON code block extraction in `agent-mcp.js` schema mode
- Golden flow tests: 6 MCP protocol tests + live smoke test stubs
- `run-pipeline.mjs` script for end-to-end pipeline acceptance testing
- Phase 4.5 fully closed (all 18a–18h items COMPLETE)

**ITEM-23: Policy Enforcement Runtime**
- `evaluatePolicy()` pure function — reads per-phase policy modes from settings
- Build.js integration: skip (silent), flag (auto-approve + notify), gate (human approval)
- Gate records enriched with `policyMode` and `resolvedBy` fields
- Settings loaded lazily from disk at build start
- 10 unit tests + 2 Stratum integration tests (skip + flag paths verified e2e)

**ITEM-24: Gate UI Polish**
- `resolvedBy` badge on resolved gates (human vs auto-flag/auto-skip)
- Full gate history (replaces "Resolved Today" — last 10, expandable to 50)
- Prior revision feedback displayed on re-gated pending gates
- Handles both normalized outcome forms (approve/approved, revise/revised)

**ITEM-25a: Subagent Activity Nesting**
- `AgentRegistry` class — persistent parent-child tracking of spawned agents
- `agent-spawn.js` registers with registry, derives agentType from prompt heuristics
- `agentSpawned` WebSocket event broadcast on spawn
- `GET /api/agents/tree` returns hierarchy for current session
- AgentPanel "Subagents" section: pulsing dot for running, check/X for complete
- 11 unit tests for AgentRegistry

**ITEM-26: Iteration Orchestration**
- 3 REST endpoints: `iteration/start`, `iteration/report`, `iteration/abort`
- 3 MCP tools: `start_iteration_loop`, `report_iteration_result`, `abort_iteration_loop`
- Server-side exit criteria evaluation (review: clean==true, coverage: passing==true)
- Server-side max iteration enforcement (from settings: review=4, coverage=15)
- `iterationState` on item.lifecycle with full iteration history
- WebSocket broadcasts: iterationStarted/Update/Complete (client handler pre-existed)
- `coverage-sweep.stratum.yaml` pipeline
- 9 integration tests

**COMP-UI-6: Polish and Teardown**
- Deleted `compose-ui/` (old prototype), `SkeletonCard`, unused hooks
- Zone error boundaries on header, sidebar, ops strip, agent bar
- Migrated all legacy CSS token refs to modern `hsl(var(--*))` across 11 files
- Deleted legacy CSS token block from `index.css`
- Zero legacy token refs remaining in `src/`

## 2026-03-16

### COMP-DESIGN-1: Interactive Design Conversation

- **Design tab** in cockpit header — new view for interactive product design conversations with the LLM
- **Decision cards** — LLM presents options as clickable cards with recommendations; cards render from inline ` ```decision ``` ` JSON blocks in markdown
- **Design sidebar** — running decision log replacing AttentionQueueSidebar when Design tab is active; supports decision revision
- **Session management** — one session per scope (product or feature), persisted to `.compose/data/design-sessions.json`, survives page reloads
- **SSE streaming** — real-time LLM response streaming via session-scoped Server-Sent Events with in-flight dispatch guard
- **Design doc generation** — "Complete Design" action writes structured design doc to `docs/design.md` (product) or `docs/features/{code}/design.md` (feature)
- **`compose new` integration** — detects existing design doc and uses it as enriched intent, skipping the questionnaire
- **Security hardening** — prototype pollution protection, input validation, completed session guards, optimistic rollback

## 2026-03-15

### COMP-UX-1d: Ops Strip

- **OpsStrip component** (`src/components/cockpit/OpsStrip.jsx`): persistent 36px bar between main workspace and agent bar, surfaces active builds, pending gates, and recent errors as horizontally-scrollable pills
- **OpsStripEntry component** (`src/components/cockpit/OpsStripEntry.jsx`): pill component with design-token colors (blue/amber/red/green HSL), inline gate approve button, dismiss button for errors
- **Pure logic module** (`src/components/cockpit/opsStripLogic.js`): `deriveEntries()` and `filterRecentErrors()` — testable without React
- **recentErrors derived state** in `useVisionStore`: filters `agentErrors` to 60s window (max 5), recomputes on 10s interval for reactive aging
- **Entry animations**: slide-in on enter, flash green on build complete (2s), fade-out on dismiss
- **Visibility**: hidden when `activeView === 'docs'`, hidden when no entries
- **Build key uniqueness**: keyed by flowId/startedAt to prevent dismissal collision across builds for the same feature

## 2026-03-13

### STRAT-COMP-6: Web Gate Resolution

- **Gate enrichment**: CLI populates `fromPhase`, `toPhase`, `artifact`, `round`, and `summary` on gate creation
- **Shared constants** (`lib/constants.js`): canonical `STEP_LABELS`, `GATE_ARTIFACTS`, and `buildGateSummary()` — single source for CLI and frontend
- **GateView enhancements**: summary display, artifact link (opens canvas), build-gate prominence (amber border, larger buttons when `flowId` present), feature grouping by `itemId`, collapsible gate history with count badge
- **Imperative outcome vocabulary**: `approve`/`revise`/`kill` throughout GateView, ItemDetailPanel, and resolve calls (legacy past-tense keys retained as fallbacks in color maps)
- **`gateCreated` event**: renamed from `gatePending`; `visionMessageHandler.js` and tests updated
- **URL-encoded gate IDs**: `encodeURIComponent(gateId)` in `useVisionStore.js` resolve calls and `visionMessageHandler.js` fetch
- **Idempotent re-resolve**: `POST /api/vision/gates/:id/resolve` returns 200 on already-resolved gates instead of 400
- **StratumPanel gate link**: gate list replaced with "View gates in sidebar" link using `sessionStorage` + custom event for cross-panel navigation
- **VisionTracker listener**: responds to `vision-view-change` event to switch sidebar view

### STRAT-COMP-4: Vision Store Unification

- **Canonical port resolution** (`lib/resolve-port.js`): `COMPOSE_PORT > PORT > 3001` used by all components
- **Server probe** (`lib/server-probe.js`): lightweight health check with timeout for dual-dispatch routing
- **Dual-dispatch VisionWriter**: routes mutations through REST when server is up, writes directly to disk when down
- **featureCode migration**: legacy `featureCode: "feature:X"` auto-migrated to `lifecycle.featureCode` on load
- **Gate outcome normalization**: canonical `approve`/`revise`/`kill` enforced at all write boundaries
- **Atomic writes**: temp file + `renameSync` in both VisionStore and VisionWriter
- **AD-4 gate delegation**: server stores gate state and broadcasts events; CLI owns all lifecycle transitions
- **Gate expiry persistence**: expired gates written to disk so restarts don't resurrect them
- **55 integration tests** across 5 test files covering all unification behaviors

### STRAT-COMP-5: Build Visibility

- **Atomic `active-build.json`**: writes via temp file + rename, extended fields (stepNum, totalSteps, retries, violations, status, startedAt)
- **Terminal state retention**: completed/aborted builds retain `active-build.json` on disk (overwritten on next build start)
- **`buildState` WebSocket handler**: `visionMessageHandler.js` handles `buildState` messages, updates `activeBuild` state
- **File watcher extension**: server watches `.compose/` directory for `active-build.json` changes

### STRAT-COMP-7: Agent Stream Bridge

- **`BuildStreamWriter`** (`lib/build-stream-writer.js`): appends JSONL events to `.compose/build-stream.jsonl` with monotonic `_seq` and ISO timestamps
- **`BuildStreamBridge`** (`server/build-stream-bridge.js`): watches JSONL file, maps CLI events to SSE-compatible shapes, broadcasts to AgentStream
- **Build instrumentation**: `build.js` creates `BuildStreamWriter` after plan/resume, writes `build_start`, `build_step_start`, `build_step_done`, `build_gate`, `build_gate_resolved`, `build_error`, and `build_end` events
- **Crash detection**: bridge emits synthetic `build_end(crashed)` after configurable timeout during active step
- **27 tests** covering writer, bridge, event mapping, crash detection, and stale file handling
