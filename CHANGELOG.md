# Changelog

## 2026-03-15

### COMP-UX-1c: Graph Ops Overlays

- **Build-state node borders:** Building (blue pulse), gate-pending (amber), error (red), blocked-downstream (dimmed 0.35 opacity)
- **HTML badge overlays:** Positioned via Cytoscape `renderedPosition()` — gate badge (amber), error badge (red, clickable), agent badge (blue gear)
- **Gate popover:** Click gate badge → popover with Approve/Revise/Kill buttons calling `resolveGate`
- **Blocked downstream dimming:** Transitive BFS over blocks/informs edges dims all successors of building/gate-pending nodes
- **Pure logic module:** `graphOpsOverlays.js` with `computeBuildStateMap()` and `getDownstreamBlockedIds()` — 18 tests

## 2026-03-13

### STRAT-PAR: Parallel Task Decomposition (STRAT-PAR-1 through STRAT-PAR-6)

**IR v0.3 schema (Stratum side):**
- `decompose` step type: agent emits a TaskGraph with `files_owned`, `files_read`, `depends_on`
- `parallel_dispatch` step type: `max_concurrent`, `isolation`, `require`, `merge`, `intent_template`
- `no_file_conflicts` built-in ensure with transitive dependency detection
- `stratum_parallel_done` MCP tool with require semantics (all/any/N)
- Backward-compatible superset of v0.2. 30 new tests (479 total passing).

**Compose parallel dispatch (STRAT-PAR-4):**
- `build.js` creates git worktree per task under `.compose/par/`
- Agents run in isolated worktrees; diffs collected via `git diff --cached HEAD`
- Diffs applied to main worktree in topo order with `git apply --check` dry-run
- Merge conflict detection sets `mergeStatus='conflict'` with structured error
- Falls back to shared cwd if not a git repo. 19 new tests.

**Pipeline integration (STRAT-PAR-5):**
- `build.stratum.yaml` bumped to v0.3
- `decompose` step after `plan_gate` emits TaskGraph
- `execute` step is now `parallel_dispatch` consuming decomposed tasks

**Agent bar parallel progress (STRAT-PAR-6):**
- Build stream bridge passes `parallel` flag through SSE events
- AgentStream tracks parallel task state (total/completed/failed/active)
- AgentBar shows `∥ N/M tasks` status text + mini progress bar

### COMP-UI-2: Live Sidebar

- **`AttentionQueueSidebar`** (`src/components/vision/AttentionQueueSidebar.jsx`): replaces `AppSidebar` inside `VisionTracker`. Surfaces urgent actions first, ambient context lower:
  - **Active build status**: current step name, progress bar, and step counter (e.g. "Step 4 / 15") read from `.compose/active-build.json` via `useVisionStore`. Pulse dot while running, static bar on completion/failure.
  - **Attention queue**: blocked items and pending decisions sorted by priority — `BLOCKED (3) → PENDING_GATE (2) → DECISION (1)`. Up to 5 rows; "+" overflow link navigates to Attention view.
  - **Phase filter (global)**: phase buttons wired to `selectedPhase`/`setSelectedPhase` in `useVisionStore` — filter is stored globally and applies across all views simultaneously.
  - **Compact stats row**: total items, in-progress, blocked, and pending-gate counts in a single strip below the header.
  - **View navigation**: 9 view buttons (Attention, Gates, Roadmap, List, Board, Tree, Graph, Docs, Settings) with contextual badges (attention count, pending gates, item total). Theme toggle and search in header.
  - **Connection status indicator**: "disconnected" label in header when WebSocket is offline.
  - **Agent telemetry panel**: `AgentPanel` preserved from `AppSidebar`.
- **`attentionQueueState.js`** (`src/components/vision/attentionQueueState.js`): pure logic module (no React, no DOM) for isolated testability:
  - `computeAttentionQueue(items, gates)` — priority-sorted list of attention-worthy items; deduplicates items at highest applicable priority
  - `buildProgress(activeBuild)` — normalizes raw `activeBuild` to `{ pct, stepLabel, isRunning, status, featureCode, stepNum, totalSteps }`
  - `compactStats(items, gates)` — aggregates `{ total, inProgress, blocked, pendingGates, attentionCount }`
  - `togglePhase(current, phaseKey)` — toggle: same key → null (deselect), different key → activate
  - `ATTENTION_PRIORITY` constants: `DECISION = 1`, `PENDING_GATE = 2`, `BLOCKED = 3`
- **Phase filter lifted to `useVisionStore`**: `selectedPhase` / `setSelectedPhase` added to the store; persisted to `sessionStorage`. VisionTracker consumes them from the store directly — one WS connection, global state shared across all views.
- **`VisionTracker` updated**: swapped `AppSidebar` import for `AttentionQueueSidebar`; added `activeBuild`, `selectedPhase`, and `setSelectedPhase` from `useVisionStore`; removed VisionTracker-local `selectedPhase` state and its `sessionStorage` effect; added `phaseFilteredItems` / `phaseFilteredGates` memos.
- **`CockpitSidebar` updated**: removed broken `AppSidebar` lazy-load (AppSidebar was rendered with no props, which would crash at `items.length`). Sidebar body is now owned by VisionTracker's `AttentionQueueSidebar`; CockpitSidebar retains only the collapse/expand toggle tab.
- **Absorbs STRAT-COMP-8 sidebar scope**: active build step and progress visibility that was slated for the build dashboard (STRAT-COMP-8) is now surfaced directly in the attention-queue sidebar.
- **Tests** (`test/attention-queue.test.js`): 33 test cases covering `ATTENTION_PRIORITY` constants, `computeAttentionQueue` (empty input, blocked, pending-gate, decisions, deduplication, sort order), `buildProgress` (running / complete / failed / null), `compactStats`, and `togglePhase`.

### COMP-UI-1: Cockpit Shell

- **`App.jsx` rewrite**: replaced split-pane terminal+canvas layout with a full cockpit grid — header, sidebar, main area, context panel, agent bar, notification bar. `AppInner` is now the thin orchestration layer; each zone is its own component.
- **`ViewTabs`** (`src/components/cockpit/ViewTabs.jsx`): header tab switcher for Vision / Stratum / Docs top-level views. State persisted to `localStorage` (`compose:viewTab`). Pure state functions extracted to `viewTabsState.js`.
- **`CockpitSidebar`** (`src/components/cockpit/CockpitSidebar.jsx`): fixed 208 px left panel for project navigation (phases, search). Replaces `AppSidebar` in the cockpit layout.
- **`ContextPanel`** (`src/components/cockpit/ContextPanel.jsx`): collapsible 280 px right panel for item detail, gate review, and artifact preview. Persists open/closed state to `localStorage` (`compose:contextPanel`).
- **`AgentBar`** (`src/components/cockpit/AgentBar.jsx`): always-present bottom panel replacing the agent stream as a view tab. Three states:
  - `collapsed` — 36 px status line (status dot + active tool name + elapsed time)
  - `expanded` — draggable message stream + chat input (30–50 % of viewport, default 256 px)
  - `maximized` — fills the main area, hides sidebar / main content / context panel
  - State and height persisted to `localStorage` (`compose:agentBarState`, `compose:agentBarHeight`). Pure state machine in `agentBarState.js`.
- **`NotificationBar`** (`src/components/cockpit/NotificationBar.jsx`): thin dismissible alert strip at the bottom, hidden when empty.
- **Main-area tabs**: existing canvas views (Vision, Stratum, Docs) moved from Canvas tab bar into the main-area tab system driven by `ViewTabs`. Agent stream no longer occupies a view tab.
- **`SafeModeBoundary`** preserved: error boundary wraps the full cockpit; per-zone `PanelErrorBoundary` guards individual panels.
- **localStorage keys added**: `compose:viewTab`, `compose:agentBarState`, `compose:agentBarHeight`, `compose:contextPanel`

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
