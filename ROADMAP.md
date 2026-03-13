# Compose Roadmap

**Project:** Compose — a lifecycle runtime for AI-assisted feature development.
Compose orchestrates multi-agent workflows via Stratum specs: gates that block, policies that enforce,
iterations that loop across agents, artifacts that are tracked.

**Last updated:** 2026-03-13

---

## Roadmap Conventions

- **Status:** `PLANNED` | `IN_PROGRESS` | `PARTIAL` | `COMPLETE` | `SUPERSEDED` | `PARKED`
- **Phases** are sequential. **Half-phases** (e.g. 4.5) are parallel tracks that surface between sequential phases.
- Items are numbered sequentially across all phases — never reuse a number.
- Cross-reference stable IDs (e.g. `Phase 3`, item 18) not section headings.

---

## Phase 0: Bootstrap — COMPLETE

Manual, out-of-band. None of this is tracked in Compose itself.

| # | Item | Status |
|---|------|--------|
| — | Discovery, requirements, PRD, UI-BRIEF | COMPLETE |
| — | External UI build (Base44) + gap evaluation | COMPLETE |
| — | Terminal embed: xterm.js + WebSocket + node-pty | COMPLETE |
| — | Process supervisor with auto-restart | COMPLETE |
| — | First boot crash analysis and resilience fixes | COMPLETE |

**Exit:** Claude Code runs in the embedded terminal and survives server restarts.

---

## Phase 1: Vision Surface — COMPLETE

Make the agent's work visible. Compose can see what's happening without the human watching the terminal.

| # | Item | Status |
|---|------|--------|
| 1 | Vision tracker: item CRUD with phase/type/status/confidence | COMPLETE |
| 2 | Connection graph: blocks, informs, supports, implements, contradicts | COMPLETE |
| 3 | 7 views: Roadmap, List, Board, Tree, Graph, Docs, Attention | COMPLETE |
| 4 | WebSocket broadcast: real-time state sync to all clients | COMPLETE |
| 5 | File-based persistence: `data/vision-state.json`, reload on restart | COMPLETE |
| 6 | Snapshot API: browser-side state captured via WS request/response | COMPLETE |

**Exit:** The Vision Surface tracks items, renders 7 views, and updates in real time.

---

## Phase 2: Agent Awareness (Read-Only) — COMPLETE

Compose observes what the agent is doing without the human watching the terminal.

| # | Item | Status |
|---|------|--------|
| 7 | Activity hooks: tool-use events POSTed to `/api/agent/activity` | COMPLETE |
| 8 | File-path resolution: map tool events to tracker items | COMPLETE |
| 9 | Auto-status promotion: Write/Edit on planned items → in_progress | COMPLETE |
| 10 | Error detection: pattern-match tool responses, broadcast `agentError` | COMPLETE |
| 11 | Activity feed in sidebar: live tool-use stream with category pills | COMPLETE |

**Exit:** Compose surfaces agent activity and errors in the Vision Surface without the human watching the terminal.

---

## Phase 3: Session Tracking — COMPLETE

Sessions accumulate context across tool uses. Compose builds a record of each working session.

| # | Item | Status |
|---|------|--------|
| 12 | Session lifecycle: start/end with source, reason, transcript path | COMPLETE |
| 13 | Per-item accumulator: reads, writes, first/last touched per tracker item | COMPLETE |
| 14 | Work block detection: group tool events by resolved item set | COMPLETE |
| 15 | Block classification: building / debugging / testing / exploring / thinking | COMPLETE |
| 16 | Haiku summarization: batch significant events → background LLM summary | COMPLETE |
| 17 | Session persistence: append-only `data/sessions.json`, reload last on startup | COMPLETE |

**Exit:** Sessions accumulate per-item stats and LLM summaries; each session persists to disk.

---

## Phase 4: Agent Connector (Read-Write) — PARTIAL

Compose can direct agents, not just observe them. Connectors route prompts to Claude or Codex via MCP.

| # | Item | Status |
|---|------|--------|
| 18a | Connector class hierarchy: AgentConnector → ClaudeSDKConnector, OpencodeConnector → CodexConnector | COMPLETE |
| 18b | `agent_run` MCP tool (stdio transport): routes to claude or codex | COMPLETE |
| 18c | `review-fix.stratum.yaml`: two-phase execute → fix/review pipeline | COMPLETE |
| 18d | UI decoupling verified: zero new HTTP/WS surface added | COMPLETE |
| 18e | Server modularization: no file in `server/` over ~300 lines | COMPLETE |
| 18f | Regression tests: connectors, server pure functions, activity routes (69/69) | COMPLETE |
| 18g | Dead code removal: `openai` and `gray-matter` deps removed | COMPLETE |
| 18h | Acceptance gate: end-to-end pipeline with live inference backends | MANUAL GATE |

**Exit:** Claude Code can call `agent_run` to dispatch work to Claude or Codex and run the review-fix pipeline.
See `docs/plans/2026-03-05-18h-acceptance-gate.md` for the acceptance test checklist.

---

## Phase 4.5 Support: Stratum Sync + Feature Scan — COMPLETE

Infrastructure that landed alongside Phase 4 connector work.

| # | Item | Status |
|---|------|--------|
| — | Feature scan: seed tracker from `docs/features/` folders (replaced speckit) | COMPLETE |
| — | Stratum sync: poll `~/.stratum/flows/`, sync flow status → item status | COMPLETE |
| — | Stratum bind/audit routes: link flows to items, store audit traces | COMPLETE |
| — | compose-mcp: 5 MCP tools for querying Vision Surface state | COMPLETE |

---

## Phase 5: Standalone App — SUPERSEDED by STRAT-1

Packaging is now part of STRAT-1. `pip install compose` replaces `npm install -g compose`.
UI installation is handled by `compose init` questionnaire.

---

## Phase 6: Lifecycle Engine — PARTIAL

Compose's lifecycle layers (L0–L6) are built and working. The process primitives
(gates, policy, skip, rounds) currently live in Compose. STRAT-1 moves them to Stratum
and makes Compose a thin workflow layer.

### Phase 6 Layers (Compose-internal, all COMPLETE)

| # | Layer | Status |
|---|-------|--------|
| 21 | **L0 — User Preferences Inventory:** full preferences system — `data/settings.json`, REST API (`GET/PATCH /api/settings`, `POST /api/settings/reset`), WS broadcast, Settings panel in sidebar. Policy engine + lifecycle manager use settings as middle fallback. Agent server reads model from disk. | COMPLETE |
| 22 | **L1 — Feature Lifecycle State Machine:** `contracts/lifecycle.json` (single source of truth); `lifecycle-constants.js` derives all exports; `policy-engine.js` validates against contract; `compose_feature.stratum.yaml` generated from contract with compound steps for revision loops; 28 contract parity tests; `currentPhase` + `phaseHistory` on feature items; centralized state in `vision-state.json`. | COMPLETE |
| 23 | **L2 — Artifact Awareness:** feature folder creation, artifact presence detection, phase-appropriate templates, artifact ↔ tracker item linking. | COMPLETE |
| 24 | **L3 — Policy Enforcement Runtime:** gate/flag/skip dials that structurally block phase transitions. Policy inheritance through work hierarchy. Override at any level. Hardcoded defaults until L0 lands. | COMPLETE |
| 25 | **L4 — Gate UI:** sidebar surface for pending phase transitions — shows artifact, proposed next phase, rationale. Three actions: Approve / Revise / Kill. Gate history. | COMPLETE |
| 26 | **L5 — Session-Lifecycle Binding:** sessions tagged to feature + phase. Activity grouped by feature. Transcripts auto-filed. Handoff context injected automatically. | COMPLETE |
| 27 | **L6 — Iteration Orchestration:** review and coverage loops as Compose primitives. Compose dispatches, monitors for completion promises, enforces exit criteria. Agent cannot self-report done without Compose confirming. | COMPLETE |

**Exit (current):** Lifecycle layers work end-to-end with Compose-internal primitives. Gates block, policies inherit, iterations are orchestrated, artifacts are managed.

**Exit (after STRAT-1):** Process primitives live in Stratum. Compose's lifecycle is a `.stratum.yaml` spec. Compose owns workspace concerns only.

See `docs/plans/2026-02-15-lifecycle-engine-roadmap.md` for full layer detail.

---

## INIT-1: Project Bootstrap — COMPLETE

Make Compose portable across any project, not just its own repo.

| # | Item | Status |
|---|------|--------|
| 28 | `compose init` command: creates `.compose/`, writes manifest, detects capabilities | COMPLETE |
| 29 | Project manifest: `.compose/compose.json` with version, capabilities, paths | COMPLETE |
| 34 | Stratum graceful degradation: soft-fail when stratum-mcp not installed | COMPLETE |
| 35 | Config-driven paths: all server modules read docs/features/journal from manifest | COMPLETE |
| 36 | Target binding: `compose start` resolves project root via parent traversal | COMPLETE |

**Exit:** `compose init` in any repo bootstraps Compose. Server starts against that project. No hard dependency on stratum. All paths configurable.

See `docs/features/INIT-1/` for design, blueprint, plan, and report.

---

## STRAT-1: Stratum Process Engine + Compose MVP — COMPLETE

Three milestone gates. Each produces a usable deliverable. Nothing ships until each gate passes.

### Milestone 1: Stratum Engine Complete

Stratum IR v0.2 parses, validates, and executes specs with all primitives. All work in the Stratum repo.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 37 | — | Audit Stratum: inventory existing primitives, identify gaps | COMPLETE |
| 38 | STRAT-ENG-1 | IR v0.2 schema: `workflow:` declaration, inline steps (`agent`, `intent`, `on_fail`, `next`), `flow:` composition, gates, policy, skip, rounds | COMPLETE |
| 39 | STRAT-ENG-2 | Executor — state model: StepRecord, FlowState, agent passthrough, audit infra | COMPLETE |
| 40 | STRAT-ENG-3 | Executor — gates, policy, skip: policy evaluation (`skip`/`flag`/`gate`), `stratum_skip_step` tool | COMPLETE |
| 41 | STRAT-ENG-4 | Executor — loops and rounds: round tracking, `max_rounds`, per-step iteration | COMPLETE |
| 42 | STRAT-ENG-5 | Executor — routing and composition: `on_fail`/`next`, `flow:` sub-execution | COMPLETE |
| 43 | STRAT-ENG-6 | Contract freeze: spec shape, MCP tool signatures, flow state/audit output | COMPLETE |
| 43.1 | STRAT-ENG-HOOKS | `stratum-mcp install` hooks: install to `~/.stratum/hooks/` with absolute paths instead of per-project copies | COMPLETE |

**Gate:** Multi-step spec with gates, loops, and per-step agent assignment executes end-to-end in Stratum.

### Milestone 2: Headless Compose Runner

`compose build` works without UI. CLI → Stratum → agents → artifacts. All work in the Compose repo.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 44 | STRAT-COMP-1 | Skill prompt + headless runner + init upgrade: universal agent skill, `compose build`, questionnaire, agent detection | COMPLETE |
| 45 | STRAT-COMP-2 | Delete bespoke code: replace lifecycle-manager/policy-engine with Stratum adapters | COMPLETE |

**Gate:** `compose build FEAT-X` reads a spec, dispatches agents, enforces gates, produces artifacts. No server required.

### Milestone 3: Prove It

Run STRAT-1's own Compose integration through `compose build`. Dogfooding milestone D4.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 46 | STRAT-COMP-3 | Proof run: fix build infrastructure bugs, rewrite sub-flow spec, prove dispatch loop with mock connectors (317 tests, 0 fail). Live run (Task 6) remains manual/gated. | COMPLETE |

**Gate:** Compose builds itself using `compose build`. Multi-agent, gated, audited.

### Milestone 4: Unified Interface

CLI and web UI share execution context. Build runs are visible in the web app. Gates resolve from either interface.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 47 | STRAT-COMP-4 | Vision store unification: reconcile `VisionWriter` (CLI) and `VisionStore` (server) conventions — `featureCode` format mismatch, race-free shared access | COMPLETE |
| 48 | STRAT-COMP-5 | Build visibility: extend server file watcher to `.compose/` and `active-build.json`, broadcast build state via WebSocket | COMPLETE |
| 49 | STRAT-COMP-6 | Web gate resolution: when `compose start` is running, gates resolve through the web UI (Gate View) instead of CLI readline. CLI falls back to readline when server is not running | COMPLETE |
| 50 | STRAT-COMP-7 | Agent stream bridge: CLI writes tool_use events to `.compose/build-stream.jsonl`, server watches and pipes to AgentStream SSE | COMPLETE |
| 51 | STRAT-COMP-8 | ~~Active build dashboard~~ **SUPERSEDED by COMP-UI.** Build state visibility distributed across COMP-UI-2 (sidebar: active step, progress) and COMP-UI-3 (context panel: retries, violations, audit trail). | SUPERSEDED |

**Gate:** `compose start` + `compose build` run simultaneously. Build progress, agent activity, and gates are all visible and actionable in the web UI.

**Exit:** `pip install compose` → `compose init` → `compose build`. Compose is a thin layer: lifecycle spec + visibility + agent routing + optional UI.

See `docs/features/STRAT-1/` for full design.

---

## COMP-UI: Cockpit Integration — PLANNED

Merge the cockpit architecture from compose-ui into the production compose/src/ codebase. Replace the split-pane terminal+canvas layout with a sidebar + tabbed main area + context panel + collapsible agent bar. Preserve everything that works (agent stream, canvas, Cytoscape graph, WebSocket data layer, error boundaries).

See `compose-ui/INTEGRATION-BRIEF.md` for the full merge spec.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 52 | COMP-UI-1 | **Cockpit shell:** rewrite `App.jsx` to render cockpit layout (header with ViewTabs, sidebar, main area, context panel, agent bar, notification bar). Move existing views from canvas tabs to main-area tabs. Agent stream becomes a collapsible bottom panel (agent bar) — always present, not a view tab. Three states: collapsed (status line), expanded (message stream + input), maximized (fills main area). | PLANNED |
| 53 | COMP-UI-2 | **Live sidebar:** replace AppSidebar with attention-queue sidebar. Wire to useVisionStore for phase filter (global, affects all views), pending gates, blocked items, active build status (current step, progress from `active-build.json`), compact stats. Absorbs sidebar scope from STRAT-COMP-8. | PLANNED |
| 54 | COMP-UI-3 | **Context panel:** right-side slide-in panel. Item click → ItemDetailPanel (inline field editing, acceptance criteria checkboxes, connection editor). Gate click → GateReviewPanel (prior decisions, artifact summary, connected items, feedback). Build step click → step detail (retries, violations, audit trail). Artifact → Canvas in panel mode. Persists across view switches. Absorbs detail scope from STRAT-COMP-8. | PLANNED |
| 55 | COMP-UI-4 | **View upgrades:** replace BoardView (drag-drop with gate-aware transitions), ListView (filter bar: status/phase/type/agent), RoadmapView (collapsible tree with indentation). Restyle existing GraphView. Add PipelineView (visual step diagram) and SessionsView (browser with agent/status filters, read/write/error counters). | PLANNED |
| 56 | COMP-UI-5 | **Interaction components:** CommandPalette (Cmd+K search across items/gates/sessions), ItemFormDialog (quick-type creation presets), SettingsModal (governance dials per phase), GateNotificationBar (persistent bottom bar with inline actions). Shared primitives: StatusBadge, PhaseTag, AgentAvatar, ConfidenceBar, RelativeTime, EmptyState, SkeletonCard. | PLANNED |
| 57 | COMP-UI-6 | **Polish and teardown:** error boundaries per zone, delete replaced vision components and all compose-ui dead code (old pages, Layout, auth, base44). Merge color tokens into single constants file. localStorage persistence for cockpit state (active view, sidebar collapsed, font size). | PLANNED |

**Gate:** Each step must pass its test criteria from `INTEGRATION-BRIEF.md` before the next begins.

**Exit:** Compose web UI uses the cockpit layout. All views render in tabs. Agent bar provides persistent bottom-panel access to the agent stream (collapsed/expanded/maximized). Context panel shows detail/gate/artifact. Command palette, item creation, and gate notification bar work. No compose-ui dead code remains.

---

## COMP-RT: Real-Time Resilience — PLANNED

Harden the streaming and connector layer for production-quality performance, late-joining clients, and multi-vendor extensibility.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 58 | COMP-RT-1 | **Event coalescing for WebSocket broadcasts:** accumulate agent activity and state-change events into a sparse buffer, flush to clients at a fixed interval (~60 fps). Prevents UI thrash from fine-grained tool-use deltas during heavy agent runs. | PLANNED |
| 59 | COMP-RT-2 | **Client hydration on connect:** when a new browser tab or reconnecting client joins via WebSocket, send a single state snapshot (active build, vision state, in-flight agent stream) so it starts current instead of empty. Eliminates the "blank panel until next event" problem. | PLANNED |
| 60 | COMP-RT-3 | **Connector trait split — discovery vs runtime:** refactor AgentConnector into two interfaces: a stateless `AgentRegistry` (enumerate installed agents, load session history, validate model IDs) and a stateful `AgentRuntime` (stream execution, interrupt, schema injection). Enables adding new vendors without touching the execution path. | PLANNED |
| 61 | COMP-RT-4 | **Session branching:** fork an in-progress agent session at any turn, creating an independent branch that shares history up to the fork point but diverges from there. Persist both branches with shared-prefix-aware storage. Web UI shows branch points and lets the user open divergent paths side-by-side for comparison. | PLANNED |

**Exit:** WebSocket clients never miss state. Streaming is smooth under load. New agent vendors plug in without modifying the runtime. Agent sessions can be branched mid-conversation for exploratory work.

---

## STRAT-PAR: Parallel Task Decomposition — PLANNED

Automatically decompose pipeline steps into independent subtasks, analyze their dependency graph, and execute non-dependent subtasks concurrently with worktree isolation and structured merge. Bumps Stratum IR from v0.2 to v0.3.

See `docs/features/STRAT-PAR/design.md` for the full design.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 67 | STRAT-PAR-1 | **IR v0.3 schema:** add `decompose` and `parallel_dispatch` step types to spec. `decompose` emits a TaskGraph (tasks with `files_owned`, `files_read`, `depends_on`). `parallel_dispatch` consumes a TaskGraph with `max_concurrent`, `isolation`, `require`, `merge`, `intent_template`. Backward-compatible superset of v0.2. | PLANNED |
| 68 | STRAT-PAR-2 | **`no_file_conflicts` ensure function:** built-in validation that no two independent tasks (no dependency edge) share `files_owned` entries. Read-only overlap allowed. Decompose retries add dependency edges to resolve conflicts. | PLANNED |
| 69 | STRAT-PAR-3 | **Executor ready-set model:** replace `current_idx` with `completed_steps` set + `active_steps` set. Compute ready steps from satisfied `depends_on`. Return `parallel_dispatch` dispatch type with full task graph. New MCP tool `stratum_parallel_done` for batch result reporting. | PLANNED |
| 70 | STRAT-PAR-4 | **Compose parallel dispatch:** `build.js` handles `parallel_dispatch` — topo-sort tasks into levels, create git worktree per task under `.compose/par/`, dispatch up to `max_concurrent` agents, collect diffs, apply in topo order. Conflict detection with sequential fallback. | PLANNED |
| 71 | STRAT-PAR-5 | **Pipeline integration:** update `build.stratum.yaml` — insert `decompose` step after `plan_gate`, replace sequential `execute` with `parallel_dispatch`. Graceful degradation: if decompose fails or merge conflicts, fall back to single sequential execute. | PLANNED |
| 72 | STRAT-PAR-6 | **Agent bar parallel progress:** when `parallel_dispatch` is active, agent bar shows per-task status (queued/working/complete/failed), overall progress bar, and task count. | PLANNED |

**Exit:** `compose build` decomposes implementation tasks, runs independent ones in parallel worktrees, merges cleanly. Falls back to sequential on conflict. Agent bar shows parallel progress. Pipeline runs measurably faster on features with independent subtasks.

---

## COMP-BENCH: Model Benchmark Suite — PLANNED

Score LLMs on multi-phase workflow fidelity — not just code correctness (SWE-bench) but pipeline discipline, artifact quality, gate compliance, and cost efficiency. A fixed seed repo + 5 canonical feature requests + Stratum audit traces + judge-model scoring.

See `docs/features/COMP-BENCH/design.md` for the full design.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 62 | COMP-BENCH-1 | **Seed repo:** ~2k LOC task management API (Express + SQLite + integration tests). Planted race condition for BENCH-4. Pre-initialized `.compose/` manifest. Deterministic `npm test`. | PLANNED |
| 63 | COMP-BENCH-2 | **Feature specs:** 5 canonical requests as YAML — OAuth (hard), repo refactor (medium), WebSocket notifications (hard), race condition fix (medium), CSV export (easy). Machine-checkable acceptance criteria + judge rubric per feature. | PLANNED |
| 64 | COMP-BENCH-3 | **Benchmark harness:** runner with git worktree isolation per run, connector config per model, `audit-scorer.js` (6 automated axes from Stratum audit), `judge-scorer.js` (5 qualitative axes, blind evaluation, 3x inter-rater check). | PLANNED |
| 65 | COMP-BENCH-4 | **Scoring and calibration:** composite score (50% automated + 50% judge), cost-efficiency ratio, rubric anchor calibration from baseline runs. Judge stddev < 2 across repeated evaluations. | PLANNED |
| 66 | COMP-BENCH-5 | **`compose bench` CLI:** `compose bench run --model X --feature Y`, `compose bench report --compare X,Y,Z`. Results persisted in `bench/results/{model}-{feature}-{timestamp}/`. | PLANNED |

**Exit:** `compose bench run --model claude-opus --feature all` produces scored results. `compose bench report` generates a comparison table across 3+ models. Automated scores correlate with human judgment.

---

## Dogfooding Milestones

| Milestone | Description | Status |
|-----------|-------------|--------|
| D0: Bootstrap | Compose built manually, out-of-band. | COMPLETE |
| D1: Visible | Compose tracks its own development in the Vision Surface. Activity hooks fire during Compose development sessions. | COMPLETE |
| D2: Self-hosting | A planning session for Compose happens entirely inside Compose — inline docs, decisions recorded, items created. | PARTIAL |
| D3: Enforced | Phase transitions on Compose features are gated through Compose's own policy runtime. | PARTIAL |
| D4: Multi-agent | A feature is built end-to-end using multiple agents dispatched by Compose via Stratum. | PLANNED |

---

## Key Documents

| Document | What it is |
|---|---|
| `docs/features/STRAT-1/design.md` | STRAT-1 full design — IR v0.2, executor, CLI, integration |
| `docs/plans/2026-02-15-lifecycle-engine-roadmap.md` | Full Layer 0–7 design, dependency graph, open questions |
| `docs/plans/2026-02-26-architecture-foundation-plan.md` | Phase 4 items 18a–18h detail |
| `docs/plans/2026-03-05-18h-acceptance-gate.md` | Manual acceptance test checklist for Phase 4 gate |
| `docs/plans/2026-03-05-manual-test-guide.md` | Full manual test guide for all 15 system areas |
| `docs/features/feature-dev-v2/design.md` | Feature-dev v2 design — the skill that Phase 6 enforces |
| `../compose-ui/INTEGRATION-BRIEF.md` | COMP-UI merge spec — what to replace, keep, adopt, and drop |
| `docs/features/STRAT-PAR/design.md` | STRAT-PAR design — parallel task decomposition, IR v0.3, worktree isolation |
| `docs/features/COMP-BENCH/design.md` | COMP-BENCH design — seed repo, 5 features, scoring system, harness |
