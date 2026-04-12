# Compose Roadmap

**Project:** Compose — a lifecycle runtime for AI-assisted feature development.
Compose orchestrates multi-agent workflows via Stratum specs: gates that block, policies that enforce,
iterations that loop across agents, artifacts that are tracked.

**Last updated:** 2026-04-09

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
| 46 | STRAT-COMP-3 | Proof run: fix build infrastructure bugs, rewrite sub-flow spec, prove dispatch loop with mock connectors (449 Stratum tests, 0 fail). Live run (Task 6) remains manual/gated. | COMPLETE |

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

## COMP-UI: Cockpit Integration — COMPLETE

Merge the cockpit architecture from compose-ui into the production compose/src/ codebase. Replace the split-pane terminal+canvas layout with a sidebar + tabbed main area + context panel + collapsible agent bar. Preserve everything that works (agent stream, canvas, Cytoscape graph, WebSocket data layer, error boundaries).

See `compose-ui/INTEGRATION-BRIEF.md` for the full merge spec.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 52 | COMP-UI-1 | **Cockpit shell:** rewrite `App.jsx` to render cockpit layout (header with ViewTabs, sidebar, main area, context panel, agent bar, notification bar). Move existing views from canvas tabs to main-area tabs. Agent stream becomes a collapsible bottom panel (agent bar) — always present, not a view tab. Three states: collapsed (status line), expanded (message stream + input), maximized (fills main area). | COMPLETE |
| 53 | COMP-UI-2 | **Live sidebar:** replace AppSidebar with attention-queue sidebar. Wire to useVisionStore for phase filter (global, affects all views), pending gates, blocked items, active build status (current step, progress from `active-build.json`), compact stats. Absorbs sidebar scope from STRAT-COMP-8. | COMPLETE |
| 54 | COMP-UI-3 | **Context panel:** right-side slide-in panel. Item click → ItemDetailPanel (inline field editing, connection editor). Gate click → GateReviewPanel (prior decisions, artifact summary, connected items, feedback). Build step detail component exists (`ContextStepDetail.jsx`) but not wired into item detail tabs. Artifact files open in DocsView. Persists across view switches. Absorbs detail scope from STRAT-COMP-8. | COMPLETE |
| 55 | COMP-UI-4 | **View upgrades:** replace BoardView (drag-drop with gate-aware transitions), ListView (filter bar: status/phase/type/agent), RoadmapView (collapsible tree with indentation). Restyle existing GraphView. Add PipelineView (visual step diagram) and SessionsView (browser with agent/status filters, read/write/error counters). | COMPLETE |
| 56 | COMP-UI-5 | **Interaction components:** CommandPalette (Cmd+K search across items/gates/sessions), ItemFormDialog (quick-type creation presets), SettingsModal (governance dials per phase), GateNotificationBar (persistent bottom bar with inline actions). Shared primitives: StatusBadge, PhaseTag, AgentAvatar, ConfidenceBar, RelativeTime, EmptyState, SkeletonCard. | COMPLETE |
| 57 | COMP-UI-6 | **Polish and teardown:** error boundaries per zone, delete replaced vision components and all compose-ui dead code (old pages, Layout, auth, base44). Merge color tokens into single constants file. localStorage persistence for cockpit state (active view, sidebar collapsed, font size). | COMPLETE |

**Gate:** Each step must pass its test criteria from `INTEGRATION-BRIEF.md` before the next begins.

**Exit:** Compose web UI uses the cockpit layout. All views render in tabs. Agent bar provides persistent bottom-panel access to the agent stream (collapsed/expanded/maximized). Context panel shows detail/gate/artifact. Command palette (Cmd+K), item creation (Cmd+N), settings modal, and gate notification bar work. All shared primitives (StatusBadge, PhaseTag, AgentAvatar, ConfidenceBar, RelativeTime, EmptyState, SkeletonCard) adopted across views. No compose-ui dead code remains.

---

## COMP-UX-1: Zoom-Level View Architecture — COMPLETE

Redesign the compose UI around three zoom levels (Graph → Tree → Detail) instead of 10+ separate view tabs. Absorb ops monitoring (Pipeline, Sessions, Gates) into the context panel and a persistent ops strip. Make the context panel the workhorse at 50% width.

See `docs/features/COMP-UX-1/design.md` for full spec and interactive mockups.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 73 | COMP-UX-1a | **View consolidation:** Remove Board, List, Roadmap, Attention views. Graph as default. Tree with search + filters. Three tabs: Graph, Tree, Docs. Blue-slate color scheme. Track filters in sidebar. Project switching. Feature scanner with roadmap-graph import. | COMPLETE |
| 74 | COMP-UX-1b | **Context panel as workhorse:** Widen to 50% (Tree) / 40% (Graph) with resizable divider. Add pipeline dot visualization, sessions table, errors section, files with Docs navigation. Preserve all existing ItemDetailPanel features (editing, connections, lifecycle, gates). | COMPLETE |
| 75 | COMP-UX-1c | **Graph ops overlays:** Node border colors from build status. HTML badge overlays for gates/errors. Gate popover on badge click. Building nodes show agent + step. Blocked downstream nodes dimmed. | COMPLETE |
| 76 | COMP-UX-1d | **Ops strip:** Persistent bottom bar (36px) showing active builds, gates, errors. Inline gate approve. Click entry to select. Completed items flash then clear. Hidden in Docs view. | COMPLETE |
| 77 | COMP-UX-1e | **Cross-view navigation:** "View in Graph ↑" / "View in Tree ↓" links in context panel. File click → Docs with back button. Selection persists across tab switches. Filters persist. | COMPLETE |
| 78 | COMP-UX-1f | **Agent bar integration:** Agent activity updates ops strip + node colors. Build start/complete events reflected across all views. Chat commands trigger ops updates. | COMPLETE |

**Dependencies:** 1a (done) → 1b → 1c ∥ 1d → 1e → 1f

**Gate:** Each sub-feature must pass visual comparison against the interactive mockups in `docs/features/COMP-UX-1/mockups/`.

**Exit:** Compose has three zoom levels. Graph shows dependency network with ops overlays. Tree shows features by track. Context panel is the workhorse for investigation and action. Ops strip provides persistent awareness. Agent bar controls everything.

---

## COMP-STATE: Singleton State Store — COMPLETE

Replace the `useVisionStore` hook (called independently by 12+ components, creating 12 WebSocket connections and 12 state copies) with a Zustand singleton store. One connection, one state, one set of intervals.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 79 | COMP-STATE-1 | **Zustand migration:** Convert `useVisionStore.js` from React hook to Zustand `create()` store. Single WebSocket connection, single state atom. All components read from same store via `useVisionStore()` selector hooks. One 10s recentErrors interval, one 5s build poll. | COMPLETE |
| 80 | COMP-STATE-2 | **Gate race fix:** Remove optimistic fetch on gateCreated (server already broadcasts). Prevent null itemId in gate resolved toast. | COMPLETE |
| 81 | COMP-STATE-3 | **Build completion reliability:** 5s build poll. Synthetic 'done' build kept for 3s so ops strip flash fires even on fast builds. | COMPLETE |
| 82 | COMP-STATE-4 | **Session zombie cleanup:** 3s end timer (was 15s). New session start unconditionally clears previous session and its timer. | COMPLETE |

**Dependencies:** 1 → 2 ∥ 3 ∥ 4

**Exit:** One WebSocket connection per client. All UI components show identical state. No race conditions in gate or build lifecycle. No zombie sessions.

---

## COMP-DESIGN: Interactive Design Conversation — PARTIAL (1a–1d COMPLETE, 2 PLANNED)

Product design conversation with the LLM before the roadmap exists. The LLM asks questions, presents structured decision cards with recommendations, and the human selects or responds with free text. Decisions accumulate into a design document that feeds into `compose new`.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 83 | COMP-DESIGN-1a | **Design view + message thread:** "Design" tab in cockpit. Conversation UI with text input. SSE streaming to agent via `ClaudeSDKConnector`. Markdown rendering. Server-side design session (`design-routes.js`, `design-session.js`). Product-scope and feature-scope sessions. Tests passing. | COMPLETE |
| 84 | COMP-DESIGN-1b | **Decision cards:** `parseDecisionBlocks` extracts fenced `decision` JSON from LLM responses. `DesignCard` renders clickable panels (letter prefix, title, bullets, recommendation badge, selected check). Card selection sends `card_select` message. Revisable via `reviseDecision`. | COMPLETE |
| 85 | COMP-DESIGN-1c | **Live design doc:** DesignDocPanel in context panel with live markdown preview (react-markdown + remark-gfm). Draft builds incrementally from decisions via `buildDraftDoc()`. Human can edit inline — edits survive across assistant turns and rehydration. `POST /complete` accepts edited draft as seed for final LLM polish. | COMPLETE |
| 86 | COMP-DESIGN-1d | **Research + sidebar:** DesignSidebar with Decisions/Research tab bar. ResearchTab shows topic outline, codebase references (Read/Grep/Glob), and web searches. Live SSE events (`research`/`research_result`) with unique IDs for reliable correlation. Topic outline auto-generated from decisions. | COMPLETE |
| 87 | COMP-DESIGN-2 | **compose new integration:** `compose new` detects `docs/design.md` and uses it as enriched intent, skipping the questionnaire. Research and brainstorm steps reference design decisions. | COMPLETE |

**Dependencies:** 1a → 1b → 1c, 1a → 1d, 1c → 2

**Exit:** `compose design` starts an interactive design conversation. Decisions render as cards. Output feeds directly into `compose new` for roadmap generation.

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
| 67 | STRAT-PAR-1 | **IR v0.3 schema:** add `decompose` and `parallel_dispatch` step types to spec. `decompose` emits a TaskGraph (tasks with `files_owned`, `files_read`, `depends_on`). `parallel_dispatch` consumes a TaskGraph with `max_concurrent`, `isolation`, `require`, `merge`, `intent_template`. Backward-compatible superset of v0.2. | COMPLETE |
| 68 | STRAT-PAR-2 | **`no_file_conflicts` ensure function:** built-in validation that no two independent tasks (no dependency edge) share `files_owned` entries. Read-only overlap allowed. Transitive dependency detection. 5 tests. | COMPLETE |
| 69 | STRAT-PAR-3 | **Executor dispatch + `stratum_parallel_done`:** decompose returns `execute_step` with `step_mode: "decompose"`. `parallel_dispatch` returns task graph with resolved source ref. New MCP tool `stratum_parallel_done` for batch result reporting with require semantics (all/any/N). 10 tests. | COMPLETE |
| 70 | STRAT-PAR-4 | **Compose parallel dispatch:** `build.js` handles `parallel_dispatch` — git worktree per task under `.compose/par/`, dispatch up to `max_concurrent` agents, collect diffs via `git diff --cached HEAD`, apply in topo order with `git apply --check`. Conflict detection sets `mergeStatus='conflict'`. Falls back to shared cwd if not a git repo. 19 tests. | COMPLETE |
| 71 | STRAT-PAR-5 | **Pipeline integration:** `build.stratum.yaml` bumped to v0.3 — `decompose` step after `plan_gate` emits TaskGraph with `no_file_conflicts` + `len >= 1` ensures, `execute` step is now `parallel_dispatch` consuming decomposed tasks with worktree isolation. Validates cleanly. | COMPLETE |
| 72 | STRAT-PAR-6 | **Agent bar parallel progress:** build-stream-bridge passes `parallel` flag through SSE events. AgentStream tracks parallel task state (total/completed/failed/active). AgentBar shows `\u2225 N/M tasks` status text + mini progress bar when parallel dispatch is active. | COMPLETE |

**Exit:** `compose build` decomposes implementation tasks, runs independent ones in parallel worktrees, merges cleanly. Falls back to sequential on conflict. Agent bar shows parallel progress. Pipeline runs measurably faster on features with independent subtasks.

---

## STRAT-REV: Parallel Multi-Lens Review — COMPLETE

Replace the single-pass review step with parallel specialized reviewers ("lenses"), each focused on one concern. A triage step activates only relevant lenses, they run concurrently via `parallel_dispatch`, and a merge step deduplicates findings before the fix loop.

Inspired by [claude-review-loop](https://github.com/hamelsmu/claude-review-loop) — multi-agent parallel review with deduplication.

See `docs/features/STRAT-REV/design.md` for the full design.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 79 | STRAT-REV-1 | **Triage step:** file-list analysis to activate conditional lenses | COMPLETE |
| 80 | STRAT-REV-2 | **Lens library:** 4 review prompts (diff-quality, contract-compliance, security, framework) with `LensFinding` contract. Each lens declares a **confidence gate** (minimum confidence threshold, e.g. security=8/10, diff-quality=6/10) — findings below the gate are suppressed. Each lens also declares a **false-positive exclusion list** (e.g. security lens excludes DoS/rate-limiting, memory safety in memory-safe languages, absent hardening without concrete risk). Inspired by gstack `/cso` zero-noise pattern. | COMPLETE |
| 81 | STRAT-REV-3 | **Parallel review dispatch:** `parallel_dispatch` with `isolation: none` for read-only review tasks | COMPLETE |
| 82 | STRAT-REV-4 | **Merge + dedup + fix-first classification:** collect, deduplicate by file+issue, assign severity. Classify each finding as **AUTO-FIX** (mechanical: formatting, simple tests, obvious typos) or **ASK** (requires judgment). AUTO-FIX findings are applied immediately in the fix loop. ASK findings are batched into a single gate decision. Inspired by gstack `/review` fix-first pipeline. | COMPLETE |
| 83 | STRAT-REV-5 | **Selective re-review:** on retry, only re-run lenses with actionable findings | COMPLETE |
| 84 | STRAT-REV-6 | **Pipeline integration:** replace `review_check` with `parallel_review` in `build.stratum.yaml` | COMPLETE |
| 85 | STRAT-REV-7 | **Cross-model adversarial synthesis:** For large diffs (≥9 files), Codex review runs after Claude lenses. Synthesis agent classifies CONSENSUS/CLAUDE_ONLY/CODEX_ONLY findings. Auto-scales by file count. Opt-out via flag or env var. Fail-open on Codex errors. All orchestration in build.js, no pipeline YAML changes. | COMPLETE |

**Dependencies:** STRAT-PAR (parallel dispatch infrastructure)

**Exit:** Review step runs 2–4 specialized lenses in parallel, merges findings with severity, auto-fixes mechanical issues, batches judgment calls, and only re-reviews dirty lenses on retry. Confidence gates and false-positive exclusions ensure zero-noise output. Large diffs get cross-model adversarial synthesis. Review quality improves without proportional cost increase.

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

## COMP-CTX: Context Artifacts — COMPLETE

Manage project-level context documents as first-class artifacts in the feature lifecycle. Agents always see ambient context (tech stack, conventions, decision log) without manual injection. Stale artifacts are flagged when the code or phase moves past them.

Inspired by [Conductor](https://github.com/nicklatkovich/conductor-plugin)'s "context as artifact" pattern — treating product vision, tech decisions, and work tracks as managed artifacts alongside code.

Note: cross-artifact consistency (design↔blueprint↔plan alignment) is already handled by Codex review loops in the build pipeline.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 100 | COMP-CTX-1 | **Ambient context layer:** `compose init` scaffolds `docs/context/` with `tech-stack.md`, `conventions.md`, `decisions.md`. These are injected into every agent prompt during `compose build` as read-only context. Updated manually or via `compose context update`. | PLANNED |
| 101 | COMP-CTX-2 | **Artifact staleness detection:** track last-modified timestamps and phase at time of writing. When the feature advances past the artifact's phase or code changes touch files referenced in the artifact, flag it as potentially stale. Surface in context panel and gate reviews. | PLANNED |
| 102 | COMP-CTX-3 | **Decision log accumulation:** agent decisions during `compose build` (model choices, architecture trade-offs, rejected approaches) auto-append to `docs/context/decisions.md` with timestamp, feature ref, and rationale. Queryable via `compose context decisions`. | PLANNED |

**Dependencies:** None — independent of other features. Enhances L2 artifact awareness and L3 policy enforcement.

**Exit:** `compose init` creates context docs. Agents see ambient context automatically. Stale artifacts are flagged. Decision log accumulates across builds.

---

## COMP-TUI: CLI Terminal UI — PARTIAL

Rich terminal interface for `compose build`. Replaces raw text output with structured progress visualization, interactive gates, and live parallel task tracking.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 103 | COMP-TUI-1 | **Step pipeline bar:** horizontal progress visualization showing all build steps with done/active/pending states. Always visible at top of output. | PLANNED |
| 104 | COMP-TUI-2 | **Gate panel:** interactive gate UI with artifact summary, approve/revise/kill as selectable options. Replaces raw readline prompt. | PLANNED |
| 105 | COMP-TUI-3 | **Violation/findings table:** formatted table for review findings (severity, file, line, description) instead of raw JSON output. | PLANNED |
| 106 | COMP-TUI-4 | **Parallel task grid:** live 2-4 row grid during `parallel_dispatch` showing per-task status (spinner/done/failed) with agent and elapsed time. | PLANNED |
| 107 | COMP-TUI-5 | **File manifest:** running list of files changed by the build, updated after execute step. | PLANNED |
| 108 | COMP-TUI-6 | **Build summary:** completion report with step durations, retries, total cost/tokens, pass/fail per step. | PLANNED |
| 109 | COMP-TUI-7 | **Split pane layout:** top pane for pipeline progress, bottom for tool output. Terminal equivalent of cockpit main area + agent bar. | PLANNED |
| 110 | COMP-TUI-8 | **Item detail on gate:** pull item connections, lifecycle phase, related artifacts into the gate review panel. | PLANNED |

**Support features (complete):**
- Heartbeat timer: 5s elapsed time tick during silent agent runs
- Key commands: t=toggle s=skip r=retry Ctrl+C=abort
- Collapsed/expanded tool output with last-5 view
- Stall detection in opencode connector (120s warning)
- Rate-limit/auth error detection in opencode connector

**Exit:** `compose build` has a rich terminal interface. Pipeline progress is always visible. Gates are interactive with context. Review findings are formatted. Parallel tasks show live progress.

---

## COMP-PIPE-EDIT: Visual Pipeline Editor — PLANNED

Drag-and-drop pipeline editor in the web UI. Build, modify, and rewire `.stratum.yaml` specs visually instead of editing YAML by hand. Extends the existing COMP-PIPE template picker with a full editor.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 111 | COMP-PIPE-EDIT-1 | **Step canvas:** Drag-and-drop step nodes on a canvas. Each node shows step ID, agent, intent preview. Dependency edges rendered as arrows. Add step via toolbar or context menu. Delete step via node menu. | PLANNED |
| 112 | COMP-PIPE-EDIT-2 | **Step inspector:** Click a step node to open a side panel with editable fields: ID, agent, intent (multiline), inputs (key-value), output_contract (dropdown from defined contracts), ensure conditions, retries, on_fail. Live validation as you type. | PLANNED |
| 113 | COMP-PIPE-EDIT-3 | **Dependency wiring:** Drag from one node's output port to another's input port to create `depends_on` edges. Visual feedback for invalid connections (cycles, missing refs). Auto-layout via dagre/elk. | COMPLETE |
| 114 | COMP-PIPE-EDIT-4 | **Contract editor:** Define and edit contracts (LensFinding, ReviewResult, etc.) in a schema form. Contracts available as dropdowns in step inspector. New contracts auto-added to the spec. | COMPLETE |
| 115 | COMP-PIPE-EDIT-5 | **Sub-flow support:** Collapse a group of steps into a named sub-flow. Expand sub-flows to edit internals. Sub-flow inputs/outputs visible as ports on the collapsed node. | COMPLETE |
| 116 | COMP-PIPE-EDIT-6 | **YAML sync:** Bidirectional sync between canvas and YAML. Edit in canvas → YAML updates live. Edit YAML in Docs view → canvas updates. Conflict resolution when both sides change. | COMPLETE |
| 117 | COMP-PIPE-EDIT-7 | **Template save:** Save the current canvas as a new pipeline template in `pipelines/`. Templates appear in the existing TemplateSelector for future builds. | COMPLETE |

**Dependencies:** COMP-PIPE (template selector, pipeline routes — complete), COMP-UX-1 (context panel — complete)

**Exit:** Users can visually build, modify, and save pipeline specs. Steps are draggable nodes with editable properties. Dependencies are wired via drag. Sub-flows collapse/expand. YAML stays in sync. Custom pipelines save as reusable templates.

---

## STRAT-TIER: Model Tier Routing — COMPLETE

Assign Stratum steps to model tiers based on task criticality. Steps declare a `model_tier` (critical/standard/fast) and the executor routes to the appropriate model. Enables hybrid chains: Opus plans → Haiku executes → Sonnet reviews.

Inspired by [wshobson/agents](https://github.com/wshobson/agents) model routing strategy.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 88 | STRAT-TIER-1 | **IR schema extension:** add optional `model_tier` field to step definitions (`critical` → Opus, `standard` → Sonnet/inherit, `fast` → Haiku). Backward-compatible — absent field means inherit. | COMPLETE |
| 89 | STRAT-TIER-2 | **Executor routing:** executor reads `model_tier`, resolves to concrete model via config map, passes to agent dispatch. Override via CLI flag or `.stratum.yaml` top-level `model_map`. | COMPLETE |
| 90 | STRAT-TIER-3 | **Compose integration:** `build.js` reads tier from step, passes model to connector. Audit trail records which model ran each step. Cost tracking per tier. | COMPLETE |
| 91 | STRAT-TIER-4 | **Hybrid chain presets:** built-in chain templates — `plan-execute-review` (Opus→Haiku→Sonnet), `review-fix` (Sonnet→Haiku), `security-audit` (Opus→Opus). Selectable in spec or via `compose build --chain`. | COMPLETE |

**Dependencies:** None — independent of other features.

**Exit:** Stratum specs declare model tiers per step. Executor routes accordingly. Compose tracks cost per tier. Hybrid chains reduce cost without sacrificing quality on critical steps.

---

## COMP-TEAMS: Agent Team Presets — COMPLETE (v1)

Pre-configured multi-agent team compositions for common workflows. Each preset defines agent count, roles, file ownership boundaries, and coordination protocol. Builds on STRAT-PAR's parallel dispatch infrastructure.

Inspired by [wshobson/agents](https://github.com/wshobson/agents) agent-teams plugin — team-lead orchestration with file ownership model.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 92 | COMP-TEAMS-1 | **Team presets library (v1):** 3 preset configs — `review` (3 reviewers: security/perf/arch), `feature` (decompose + parallel implement + verify), `research` (3 explorers: codebase/web/docs). Stored as `.stratum.yaml` in bundled `presets/`. Two-level template loader (project → bundled fallback). | COMPLETE |
| 93 | COMP-TEAMS-2 | **File ownership enforcement:** Plan-time validation via `no_file_conflicts` ensure on decompose step. Runtime enforcement deferred to COMP-CAPS-ENFORCE. | PARTIAL |
| 94 | COMP-TEAMS-3 | **Team-lead agent pattern:** `decompose` step with `claude:orchestrator` serves this role in v1. Dedicated team-lead profile deferred. | PARTIAL |
| 95 | COMP-TEAMS-4 | **`compose build --team`:** CLI flag rewrites to `--template team-<name>`. Named presets only. Batch rejection. New `read-only-researcher` capability profile for web research. | COMPLETE |

**Dependencies:** STRAT-PAR (parallel dispatch, worktree isolation, `no_file_conflicts`)

**Deferred to future:** `debug` team (COMP-TEAMS-DEBUG), `fullstack` team (COMP-TEAMS-FULLSTACK), runtime file ownership enforcement (COMP-CAPS-ENFORCE), custom team paths (`--team custom:./path`).

**Exit:** `compose build --team review|research|feature` runs curated multi-agent pipeline. 3 built-in presets cover review, research, and implementation workflows.

---

## SKILL-PD: Progressive Disclosure for Skills — PARKED (Claude Code dependency)

Restructure Compose and Claude Code skills into a three-tier progressive disclosure architecture. Tier 1 (metadata + activation trigger) is always loaded. Tier 2 (core instructions) loads on activation. Tier 3 (examples, templates, resources) loads on demand. Reduces token burn in skill-heavy sessions.

Inspired by [wshobson/agents](https://github.com/wshobson/agents) progressive disclosure architecture for agent skills.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 96 | SKILL-PD-1 | **Tier format spec:** Three-tier SKILL.md format with frontmatter, `## Instructions`, `## Resources` with `<!-- lazy -->` markers. | PARKED — needs Claude Code adoption to be useful |
| 97 | SKILL-PD-2 | **Skill loader refactor:** Tier parsing and lazy loading in the skill loader. | PARKED — owned by Claude Code, not Compose |
| 98 | SKILL-PD-3 | **Migrate existing skills:** Convert SKILL.md files to three-tier format. | PARKED — provides zero savings until item 97 ships |
| 99 | SKILL-PD-4 | **Compose skill activation:** Phase→skill mapping. | PARKED — soft hints only without loader support |

**Dependencies:** None — independent of other features.

**Exit:** Skills use three-tier progressive disclosure. Only metadata is always loaded. Instructions activate on demand. Examples/templates are lazy-loaded. Measurable token reduction in multi-skill sessions.

---

## STRAT-VOCAB: Vocabulary Enforcement — PLANNED

Ensure function that checks generated code against a canonical name registry. Prevents naming entropy across sessions — the "is it `user_id`, `uid`, `UserId`?" problem. A `vocabulary.yaml` in the project declares canonical names with rejected aliases. The ensure function greps generated/modified files for rejected names and fails the step if any appear.

Inspired by [SpeQ](https://github.com/speq-ai/speq)'s closed-world VOCABULARY construct — but implemented as a Stratum ensure function, not a new DSL.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 107 | STRAT-VOCAB-1 | **Vocabulary file format:** `contracts/vocabulary.yaml` — map of canonical names to rejected aliases, grouped by domain. Example: `auth_token: { reject: [jwt, accessToken, JwtToken, authToken] }`. Optional `scope` field to limit checks to specific directories. | PLANNED |
| 108 | STRAT-VOCAB-2 | **`vocabulary_compliance` ensure function:** built-in Stratum ensure that greps modified files for rejected aliases. Returns violations with file, line, rejected term, and canonical replacement. Runs on implementation steps. | PLANNED |
| 109 | STRAT-VOCAB-3 | **Compose integration:** `compose init` scaffolds empty `contracts/vocabulary.yaml`. `compose build` implementation steps include `vocabulary_compliance` ensure by default. Violations surface in review findings. | PLANNED |

**Dependencies:** None — standalone ensure function.

**Exit:** `contracts/vocabulary.yaml` declares canonical names. Stratum ensure catches rejected aliases in generated code. No new DSL — just a YAML file and a grep-based checker.

---

## STRAT-IMMUTABLE: Spec Immutability During Execution — COMPLETE

Make `.stratum.yaml` specs read-only while a flow is executing. Prevents the failure mode where an agent modifies its own spec to reconcile with bad output. The executor checksums the spec at flow start and fails if the file changes mid-run.

Inspired by [SpeQ](https://github.com/speq-ai/speq)'s immutable spec rule — "modifying the spec to match generated code is a security violation." Also informed by [LaneKeep](https://github.com/algorismo-au/lanekeep)'s self-protection rules — agents blocked from modifying their own config, hook definitions, and policy files during a session.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 110 | STRAT-IMMUTABLE-1 | **Spec checksum at flow start:** executor computes SHA-256 of parsed FlowDefinition when `stratum_plan` is called. Stored in FlowState, persisted/restored across restarts. | COMPLETE |
| 111 | STRAT-IMMUTABLE-2 | **Integrity check on step transitions:** `stratum_step_done` and `stratum_parallel_done` recompute checksum and compare. Mismatch → `spec_modified` error, flow halts. Pipeline file hash verified from disk in `build.js` before each step transition. | COMPLETE |
| 112 | STRAT-IMMUTABLE-3 | **PostToolUse guard (optional):** hook that watches for Edit/Write targeting `*.stratum.yaml` files during active flows. | PARKED — no Python hook mechanism exists; pipeline file hash in build.js covers the primary threat |
| 140 | STRAT-IMMUTABLE-4 | **Gate criteria protection:** `build.js` hashes `settings.json` policy fields at build start, verifies before gate resolution. Policy mutation detected → `POLICY_MODIFIED` error, build halts. | COMPLETE |

**Dependencies:** None — executor-level change.

**Exit:** Specs and gate criteria cannot be silently modified during execution. Checksum mismatch halts the flow. Agents must work within the spec and governance rules as written.

---

## HOOK-CACHE: Read Cache Hook — COMPLETE

PreToolUse hook that blocks redundant file reads within a session. Claude re-reads files it already has in context — a token-optimization hook tracks what's been read, checks mtime for freshness, and blocks re-reads of unchanged, already-loaded content.

Inspired by [claude-context-optimizer](https://github.com/egorfedorov/claude-context-optimizer) — reported 68% token savings on heavy sessions (362K → 115K). We take the core idea (mtime + range tracking) and drop the baggage (historical pattern DB, crypto donation injection, heuristic token estimates, warnings that consume the tokens they're trying to save).

| # | Feature | Item | Status |
|---|---------|------|--------|
| 103 | HOOK-CACHE-1 | **Read cache core:** `read-cache.py` PreToolUse hook. Per-agent mtime + line-range tracking in `~/.claude/read-cache/<session>/<agent>/`. First read records mtime + range. Subsequent reads: mtime changed → allow + update; range fully covered → block; uncovered range → allow + merge intervals. | COMPLETE |
| 104 | HOOK-CACHE-2 | **Invalidation rules:** `read-cache-invalidate.py` PostToolUse hook on Edit/Write/MultiEdit deletes cache entry. `read-cache-compact.py` PreCompact hook clears entire session cache. All registered in `hooks.json`. | COMPLETE |
| 105 | HOOK-CACHE-3 | **Partial read awareness:** block message includes cached line ranges so Claude can request uncovered ranges via offset/limit. | COMPLETE |
| 106 | HOOK-CACHE-4 | **Metrics:** Appends to `~/.claude/read-cache/stats.json` on every decision — timestamp, session, decision, file path, estimated tokens saved. Metrics for the human, not injected into context. | COMPLETE |

**Dependencies:** None — standalone hook, independent of Compose/Stratum.

**Exit:** PreToolUse hook blocks redundant reads with mtime + range validation. Edit/Write/compaction invalidate correctly. Metrics show token savings. No tokens wasted on warnings or pattern databases.

---

## COMP-QA: Diff-Aware QA Scoping — COMPLETE

Scope integration/browser testing to changed functionality instead of full regression. When `compose build` reaches the test phase, analyze the git diff to identify affected routes/pages, detect the running dev server, and test only changed functionality. Prevents regression on adjacent pages without paying for full-suite reruns.

Inspired by gstack `/qa` diff-aware mode — git diff analysis → affected route identification → targeted browser verification.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 113 | COMP-QA-1 | **Diff-to-route mapper:** analyze git diff to identify changed files, map to routes/pages via framework conventions (Next.js pages/, Express routes/, etc.) or explicit `routes.yaml` mapping. Output: list of affected URLs to test. | COMPLETE |
| 114 | COMP-QA-2 | **Dev server detection:** scan common ports (3000, 4000, 5173, 8080) for running dev servers. If none found, attempt `npm run dev` or equivalent from manifest. Timeout after 30s. | COMPLETE |
| 115 | COMP-QA-3 | **Targeted browser verification:** for each affected route, run a Playwright verification pass — navigate, check for console errors, verify key elements render, take before/after screenshots. Findings feed into review merge step. | COMPLETE |
| 116 | COMP-QA-4 | **Regression guard:** on adjacent routes (one hop from changed routes in the route graph), run a lightweight smoke check (200 OK + no console errors) to catch collateral breakage without full verification cost. | COMPLETE |

**Dependencies:** None — standalone, but enhances `compose build` test phase.

**Exit:** `compose build` test phase scopes browser verification to changed routes. Adjacent routes get smoke checks. Full regression only on explicit request.

---

## COMP-HEALTH: Quantified Quality Score for Gates — COMPLETE

Assign a numeric quality score to gate decisions based on weighted dimensions. Instead of binary pass/fail, gates surface a composite score (0–100) that policy can threshold. Dimensions include test coverage, review finding severity, console errors, contract compliance, and documentation freshness. Score history enables trend tracking.

Inspired by gstack `/qa` health scoring — weighted average across 8 dimensions with per-severity deductions.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 117 | COMP-HEALTH-1 | **Score dimensions:** define 6 weighted dimensions — test coverage (25%), review findings (25%, weighted by severity), contract compliance (15%), console/runtime errors (15%), documentation freshness (10%), plan completion (10%). Configurable weights in `.compose/compose.json`. | COMPLETE |
| 118 | COMP-HEALTH-2 | **Score computation:** after each phase completes, compute composite score from available signals (Stratum audit trace, review findings, test results). Missing dimensions scored as neutral (50), not zero. | COMPLETE |
| 119 | COMP-HEALTH-3 | **Policy integration:** gates can declare `min_score: 70` as a threshold. Score below threshold → gate blocks. Score between threshold and target → gate warns. Score above target → auto-approve (if policy allows). | COMPLETE |
| 120 | COMP-HEALTH-4 | **Score history and trends:** persist scores in `.compose/data/health-scores.json` per feature per phase. `compose status` shows current score. Context panel shows score trend across phases. `/retro` includes score trends. | COMPLETE |

**Dependencies:** STRAT-REV (review findings feed into scoring), COMP-CTX-2 (documentation freshness signal).

**Exit:** Gate decisions include a composite quality score. Policy thresholds on score. Trend tracking shows quality trajectory across phases. Scores are configurable, not hardcoded.

---

## COMP-PLAN-VERIFY: Plan-Diff Verification — COMPLETE

Mechanical verification that plan items appear in the implementation diff before the ship gate. Cross-references the plan's acceptance criteria checkboxes against the actual diff to detect missing deliverables and scope creep. Runs as a Stratum ensure function.

Inspired by gstack `/ship` plan completion audit — cross-referencing TODOS.md against diff to detect scope drift.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 121 | COMP-PLAN-VERIFY-1 | **Plan parser:** `plan-parser.js` — `parsePlanItems()` extracts checkbox items with file paths and critical flags from plan.md. Agent-side helper for the ship step. | COMPLETE |
| 122 | COMP-PLAN-VERIFY-2 | **Diff matcher:** `matchItemsToDiff()` classifies plan items as DONE (file in diff), MISSING (file not in diff), EXTRA (diff file not in plan — scope creep). | COMPLETE |
| 123 | COMP-PLAN-VERIFY-3 | **`plan_completion` ensure function:** Python ensure builtin in spec.py. Runs on the ship step (not ship_gate). Division-by-zero guard. Critical missing → plain string violations. Below threshold → violation with percentage. Registered in executor sandbox. | COMPLETE |
| 124 | COMP-PLAN-VERIFY-4 | **Scope creep report:** EXTRA items from `matchItemsToDiff` are informational. Agent presents at ship_gate for human review. Optional policy gate via `len(result.scope_creep) == 0`. | COMPLETE |

**Dependencies:** None — standalone ensure function. Enhances any `compose build` pipeline with a plan.

**Exit:** Ship gate mechanically verifies plan items against diff. Missing items block (configurable). Scope creep surfaced. No manual cross-referencing needed.

---

## COMP-TEST-BOOTSTRAP: Test Framework Bootstrap — COMPLETE

Detect when a project has no test framework and auto-generate one during the build phase. Instead of failing on "no tests," scaffold a framework-appropriate test setup, generate golden flow tests from the implementation, and gate on the generated suite passing.

Inspired by gstack `/ship` test bootstrap — detects missing framework, installs it, generates initial tests before first PR.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 125 | COMP-TEST-BOOTSTRAP-1 | **Framework detection:** check for test config files (jest.config, vitest.config, pytest.ini, go test files, etc.). If none found, classify project by language/framework and select appropriate test runner. | PLANNED |
| 126 | COMP-TEST-BOOTSTRAP-2 | **Scaffold generation:** install test runner, create config, generate a minimal test helper with project-specific setup (db connection, server boot, auth fixture). Output as a `test-bootstrap` decompose task in the implementation phase. | PLANNED |
| 127 | COMP-TEST-BOOTSTRAP-3 | **Golden flow generation:** from the implementation diff, generate 1–3 golden flow tests covering the core capability lifecycle. Tests follow the project's testing hierarchy (golden flows > error harness > contract > unit). | PLANNED |
| 128 | COMP-TEST-BOOTSTRAP-4 | **Gate integration:** test phase ensure requires `test_count >= 1` and `test_pass_rate == 100%`. If bootstrap generated the tests, review lens flags them for human verification ("auto-generated tests — verify assertions match intent"). | PLANNED |

**Dependencies:** None — standalone enhancement to the build pipeline test phase.

**Exit:** `compose build` on a test-less project auto-scaffolds a test framework and generates golden flow tests. Tests gate the ship step. Human reviews auto-generated assertions.

---

## COMP-TRIAGE: Task Tier Classification — COMPLETE

Pre-flight classification of task complexity and blast radius before work begins. Analyzes the task description, affected files, and dependency surface to recommend a tier (0–4) and the corresponding agent chain. Prevents under-scoping (security-sensitive change run as Tier 1) and over-scoping (typo fix run through full review chain).

Inspired by [Hub3r7/claude-code-orchestration-template](https://github.com/Hub3r7/claude-code-orchestration-template) `/tier-check` skill — upfront task classification with chain recommendation.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 129 | COMP-TRIAGE-1 | **Classification engine:** `lib/triage.js` — pure file analysis. Counts paths in plan/blueprint, detects security/core paths, assigns tier 0-4 and build profile (`needs_prd`, `needs_architecture`, `needs_verification`, `needs_report`). No LLM calls. | COMPLETE |
| 130 | COMP-TRIAGE-2 | **`compose triage` CLI command:** standalone command prints tier, profile flags, signal counts, rationale. Persists to feature.json. | COMPLETE |
| 131 | COMP-TRIAGE-3 | **Build integration:** `compose build` runs triage before `stratum_plan()`. Profile toggles `skip_if` on existing pipeline steps — no new templates needed. `--skip-triage` and `--template` flags. Cache invalidation via mtime comparison. Creates feature.json if missing. | COMPLETE |
| 132 | COMP-TRIAGE-4 | **Tier history:** deferred — triage results persist in feature.json per feature. Cross-feature history log is a one-liner addition when needed. | PARKED |

**Dependencies:** None — standalone, enhances `compose build` entry point.

**Exit:** Every `compose build` starts with a triage step. Tier determines pipeline depth. Under-scoping and over-scoping are caught before work begins. Tier accuracy tracked over time.

---

## COMP-AGENT-CAPS: Agent Capability Profiles — PARTIAL

Standardize agent capability profiles with explicit tool restrictions. Each agent declares its role (read-only reviewer, implementer, orchestrator) and the system enforces tool access boundaries. Prevents review agents from modifying code and implementation agents from self-reviewing.

Inspired by [Hub3r7/claude-code-orchestration-template](https://github.com/Hub3r7/claude-code-orchestration-template) `disallowedTools` pattern — review agents restricted to `[Read, Grep, Glob]`, orchestrator restricted to meta-config only.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 133 | COMP-AGENT-CAPS-1 | **Capability profile schema:** `server/agent-templates.js` — 4 profiles with `allowedTools`/`disallowedTools`. `lib/agent-string.js` — centralized `parseAgentString("claude:template")` parser + `resolveAgentConfig()`. | COMPLETE |
| 134 | COMP-AGENT-CAPS-2 | **Profile templates:** `read-only-reviewer`, `implementer`, `orchestrator`, `security-auditor`. Resolved by agent string parser at build time. | COMPLETE |
| 135 | COMP-AGENT-CAPS-3 | **Compose enforcement:** `build.js` connector factory resolves agent string → template → tool restrictions. `claude-sdk-connector` passes `allowedTools`/`disallowedTools` to SDK. Review sub-flow steps use `claude:orchestrator` and `claude:read-only-reviewer`. `capability_profile` stream events emitted. | COMPLETE |
| 136 | COMP-AGENT-CAPS-4 | **Violation detection:** informational logging via stream events in v1. Runtime violation detection (inspecting actual tool_use events against profile) requires normalizer integration — deferred to v2. | PARTIAL |

**Dependencies:** None — standalone, enhances agent dispatch in `compose build`.

**Exit:** Agents declare capability profiles. Review agents cannot modify files. Implementers cannot self-review. Profiles are reusable templates. Violation detection is informational in v1.

---

## COMP-CAPS-ENFORCE: Agent Capability Violation Detection — COMPLETE

Runtime detection of agent tool calls that violate their capability profile. Currently COMP-AGENT-CAPS logs which template was active per step, but doesn't inspect actual tool_use events. This feature hooks into the result normalizer's event stream to compare each tool call against the agent's profile and surface violations.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 193 | COMP-CAPS-ENFORCE-1 | **Normalizer event tap:** Extend `result-normalizer.js` to emit structured `tool_use` events (tool name, timestamp) to a callback or event emitter during `runAndNormalize()`. Currently normalizer only returns `{ text, result }` — tool events are consumed but not surfaced. | PLANNED |
| 194 | COMP-CAPS-ENFORCE-2 | **Violation checker:** After each step completes, compare observed tool_use events against the step's agent template (`allowedTools`/`disallowedTools`). Classify: VIOLATION (disallowed tool used), WARNING (tool not in allowedTools but not explicitly disallowed). | PLANNED |
| 195 | COMP-CAPS-ENFORCE-3 | **Build audit integration:** Violations written to build-stream as `capability_violation` events with step, agent, tool, template, severity. Surface in review findings and context panel audit trail. | PLANNED |
| 196 | COMP-CAPS-ENFORCE-4 | **Enforcement mode:** Policy setting `capabilities.enforcement: "log" | "block"`. Log mode (default): violations recorded but don't block. Block mode: violation fails the step with `capability_violation` error. | PLANNED |

**Dependencies:** COMP-AGENT-CAPS (template registry — COMPLETE)

**Exit:** Every tool call during a templated step is checked against the profile. Violations surface in build audit. Block mode available via policy for strict environments.

---

## COMP-UX-3: Workflow Approachability — COMPLETE

Reduce friction in the Compose workflow so first-time users can be productive without reading docs. Smarter defaults, conversational prompts at decision points, and concise status narration. The goal is not a simpler product — it's a less intimidating one.

Inspired by [srf6413/cstack](https://github.com/srf6413/cstack) — zero-config agent orchestration that prioritizes approachability over power.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 137 | COMP-UX-3a | **Scaffold defaults:** `scaffold_feature` infers lifecycle shape from project context (language, existing features, test setup). Only prompts for what can't be inferred. Default lifecycle covers 80% of cases — user overrides only when needed. | PLANNED |
| 138 | COMP-UX-3b | **Conversational gates:** Gate prompts rewritten as plain-English questions with recommended action. "Tests pass, 2 review findings (both minor). Ship it? [Y/n]" instead of full audit dump. Detail available on expand. | PLANNED |
| 139 | COMP-UX-3c | **Status narration:** Phase transitions and iteration reports summarized in 1–2 sentences focused on what changed and what's next. Full detail behind a toggle, not inline. | PLANNED |

**Dependencies:** None — standalone UX pass. Can run in parallel with any wave.

**Exit:** A user can `scaffold_feature` → `compose build` → approve gates → ship without reading Compose documentation. Status updates are concise. Detail is available but not forced.

---

## COMP-BUDGET: Iteration Budget Enforcement — COMPLETE

Hard ceilings on iteration loops to prevent runaway agents. Today `abort_iteration_loop` exists but requires manual intervention. Budget enforcement auto-aborts with a structured failure report when any ceiling is hit.

Inspired by [LaneKeep](https://github.com/algorismo-au/lanekeep)'s budget-as-enforcement pattern — action counts, token caps, cost thresholds, and wall-clock timeouts as hard limits, not warnings. Cross-session cumulative limits.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 141 | COMP-BUDGET-1 | **Iteration ceilings:** Wall-clock timeout and action count ceiling checked at each `report_iteration_result`. Timeout and maxActions stored in iterationState. Exceeded → auto-abort with `timeout` or `action_limit` outcome. | COMPLETE |
| 142 | COMP-BUDGET-2 | **Cumulative tracking:** `budget-ledger.js` persists per-feature iteration totals in `.compose/data/budget-ledger.json`. Recorded from both report and abort routes. `checkCumulativeBudget()` blocks start when exceeded (429). | COMPLETE |
| 143 | COMP-BUDGET-3 | **Budget visibility:** Client handles `timeout` and `action_limit` outcomes with distinct messages. Ops strip display of elapsed/budget deferred to COMP-OBS-SURFACE. | PARTIAL |
| 144 | COMP-BUDGET-4 | **Policy integration:** Per-loop-type settings: `iterations.review.timeout` (15min), `iterations.coverage.timeout` (30min), `iterations.review.maxTotal` (20), `iterations.coverage.maxTotal` (50). Validated in settings-store. | COMPLETE |

**Dependencies:** None — enhances existing iteration loop infrastructure.

**Exit:** Iteration loops auto-abort when ceilings are hit. Cumulative budgets tracked across sessions. Ops strip shows live budget consumption. Policy controls ceilings per phase.

---

## COMP-OBS-SURFACE: Step Detail Surface — COMPLETE

Render existing but invisible data in the UI. Retry counts, postcondition results, and filtered SDK events already flow through build-stream events or audit traces — they just aren't displayed. Pure frontend work, no backend changes.

Inspired by [LaneKeep](https://github.com/algorismo-au/lanekeep)'s append-only audit trail — structured visibility into every evaluation tier and decision point.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 146 | COMP-OBS-SURFACE-1 | **Retry surface:** when a Stratum step fails postconditions and retries, show the failure reason and retry count in the message stream. Data already exists: `build.js` tracks `retries` per step, `ItemDetailPanel` shows `step.attempts` in audit trace. Add: retry badge on ops strip entry ("retry 2/3"), failure reason inline in build step message. Currently silent retries look like the agent is stuck. | PLANNED |
| 148 | COMP-OBS-SURFACE-2 | **Postcondition visibility:** `build_step_done` events already carry `violations` array from `response.violations` in `build.js`. Render in MessageCard: check name, pass/fail icon, violation detail (expandable). Currently opaque — user sees "step done" but not what was verified. | PLANNED |
| 150 | COMP-OBS-SURFACE-3 | **Filtered event toggle:** AgentStream.jsx suppresses `tool_progress`, `tool_use_summary`, `stream_event` (lines 226-228). Add a "verbose" toggle in agent bar settings. When on, these events render as dimmed, smaller-font entries. Off by default. Persisted in localStorage with other cockpit state. | PLANNED |
| 192 | COMP-OBS-SURFACE-4 | **Live iteration budget counters:** OpsStrip shows "review 3/5, 2:34/15:00" during active iterations. Live elapsed timer via 1s setInterval. Reads wallClockTimeout/startedAt from iterationState. | COMPLETE |

**Dependencies:** None — all data already available in the event stream. Item 192 depends on COMP-BUDGET (COMPLETE).

**Exit:** Retry attempts visible with count badge. Postcondition checks shown per step. Verbose mode available for filtered events. Live iteration budget counters in ops strip. Default view stays clean.

---

## COMP-OBS-STREAM: Tool Result Streaming — COMPLETE

Enrich the existing `tool_use_summary` event with full output content and render results attached to their `tool_use` blocks. Connectors truncate at 2KB. AgentStream pre-groups pairs by position. Visibility gated by COMP-OBS-SURFACE's verbose toggle.

See `docs/features/COMP-OBS-STREAM/design.md` for the full design.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 145 | COMP-OBS-STREAM-1 | **Connector enrichment:** both connectors yield enriched `tool_use_summary` with `output` field (≤2KB). `result-normalizer.js` forwards to streamWriter (currently missing). Bridge adds `tool_use_summary` case to `_mapEvent`. | PLANNED |
| 151 | COMP-OBS-STREAM-2 | **UI rendering:** AgentStream pre-groups consecutive `tool_use` → `tool_use_summary` pairs. MessageCard renders `ToolResultBlock` (new component) attached below tool_use blocks. Collapsible: summary one-liner → first 20 lines → full content. Error detection with destructive styling. | PLANNED |
| 152 | COMP-OBS-STREAM-3 | **Verbose gating:** reuses COMP-OBS-SURFACE's verbose toggle (no separate toggle). Verbose off: summaries filtered, no results visible. Verbose on: summaries consumed by pre-grouping, results render attached to tool_use. `tool_progress` renders standalone dimmed. | PLANNED |

**Dependencies:** COMP-OBS-SURFACE (verbose toggle).

**Exit:** Tool results flow through enriched `tool_use_summary` events. Users see results attached to tool calls when verbose is on. Collapsed by default, expandable per-message.

---

## COMP-OBS-COST: Token and Cost Tracking — COMPLETE

Per-step token usage and cost. Currently only session-level `total_cost_usd` appears in the result message. No per-step breakdown, no cumulative build cost, no input/output token split. Requires extending the Stratum audit format and the build-stream event schema.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 147 | COMP-OBS-COST-1 | **Audit format extension:** Stratum `stratum_audit` response gains per-step `input_tokens`, `output_tokens`, `cost_usd` fields. Populated from SDK result events accumulated during step execution. Stored in flow state alongside existing `duration_ms`. | COMPLETE |
| 153 | COMP-OBS-COST-2 | **Build-stream cost events:** `build_step_done` events gain `tokens` and `cost_usd` fields from the audit data. `build_end` event gains `total_tokens` and `total_cost_usd` aggregated across all steps. | COMPLETE |
| 154 | COMP-OBS-COST-3 | **Ops strip cost display:** cumulative build cost shown in ops strip during active builds (e.g., "$0.42"). Updates on each `build_step_done`. | COMPLETE |
| 155 | COMP-OBS-COST-4 | **Context panel cost breakdown:** build detail in context panel shows per-step table: step name, input tokens, output tokens, cost, duration. Sortable by cost. Highlights most expensive step. | COMPLETE |

**Dependencies:** None — standalone. Benefits from COMP-BUDGET (cumulative cost tracking reuses budget ledger).

**Exit:** Every build step reports token usage and cost. Ops strip shows running total. Context panel shows per-step breakdown. Most expensive steps are immediately visible.

---

## COMP-OBS-GATES: Tiered Gate Evaluation — COMPLETE

Gate checks run in cost order with short-circuit on failure. Currently gates have no defined evaluation order — an expensive Codex review runs even when a cheap lint check would have caught the issue. This is both a pipeline change (ordering + short-circuit logic) and a UI change (showing which tiers ran).

Inspired by [LaneKeep](https://github.com/algorismo-au/lanekeep)'s 7-9 tier evaluation pipeline — fast pattern matching first, expensive LLM verification last, first failure blocks.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 149 | COMP-OBS-GATES-1 | **Tier definition:** define 5 gate evaluation tiers: T0 schema/type validation, T1 lint/format, T2 test suite, T3 LLM review (Claude lenses), T4 cross-model review (Codex). Each tier declares cost category (fast/medium/expensive). Configured in `.compose/compose.json` under `gate_tiers`. | COMPLETE |
| 156 | COMP-OBS-GATES-2 | **Short-circuit execution:** gate evaluator runs tiers in order. First tier failure halts evaluation — expensive tiers never run. Gate result includes: tiers_run, tier_that_failed (if any), tiers_skipped. | COMPLETE |
| 157 | COMP-OBS-GATES-3 | **Gate detail view:** context panel gate review shows tier pipeline visualization — each tier as a dot (green=pass, red=fail, gray=skipped). Click tier for detail. Failed tier shows findings. Skipped tiers show "skipped — prior tier failed". | COMPLETE |
| 158 | COMP-OBS-GATES-4 | **Cost savings tracking:** track and display estimated cost saved by short-circuiting (cost of skipped tiers). Accumulate in `.compose/data/gate-savings.json`. Surface in build summary. | COMPLETE |

**Dependencies:** STRAT-REV (lens library provides T3/T4 tier implementations).

**Exit:** Gates evaluate cheap-to-expensive with short-circuit. Gate detail shows tier pipeline. Cost savings from short-circuiting are tracked and visible.

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

## Execution Sequencing

Proposed wave order for all PLANNED and PARTIAL features. Dependencies flow forward — each wave
unblocks the next. COMP-UX-2 (2d → 2a → 2c) runs as a **parallel track** throughout, not gated by
these waves.

### Parallel Track: COMP-UX-2 (COMPLETE)

Cockpit refocus — make existing views functional. All sub-features implemented: 2b (fix broken views), 2d (group field), 2a (feature-aware filtering), 2c (dashboard landing).

### Wave 0: Close Partials

Finish half-done work before starting new features.

| Feature | Items | Effort | Rationale |
|---------|-------|--------|-----------|
| COMP-UI-6 | 57 | S | Last COMP-UI item. Dead code removal, error boundaries. Closes COMP-UI. |
| COMP-DESIGN-1c | 85 | M | Live preview + human editing of design doc. Unblocks COMP-DESIGN-2. |
| COMP-DESIGN-1d | 86 | M | Research sidebar — inline web search + codebase scan. Parallel with 1c. |

**Unlocks:** D2 (self-hosting), COMP-DESIGN-2

### Wave 1: Pipeline Integrity

Cheap safety nets and mechanical enforcement. Highest leverage per line of code.

| Feature | Items | Effort | Rationale |
|---------|-------|--------|-----------|
| STRAT-IMMUTABLE | 110–112, 140 | S | Checksum spec + gate criteria at flow start, fail on mutation. Prevents agent self-modification. |
| COMP-BUDGET | 141–144 | M | Iteration budget enforcement — auto-abort on ceiling hit, cumulative tracking, policy integration. |
| COMP-PLAN-VERIFY | 121–124 | M | Ensure function verifying plan items appear in diff. Catches missing deliverables + scope creep. |
| HOOK-CACHE | 103–106 | M | Formalize read-cache hook — mtime + range tracking, proper invalidation on Edit/Write/compact. |
| COMP-TRIAGE | 129–132 | S | Pre-flight task classification — tier + chain recommendation before work begins. Prevents under/over-scoping. |
| COMP-AGENT-CAPS | 133–136 | S | Agent capability profiles — read-only reviewers, tool restriction enforcement, violation logging. |

**Unlocks:** D3 (enforced)

### Wave 2: Review Quality

The highest-impact planned feature. Replaces single-pass review with parallel specialized lenses.

| Feature | Items | Effort | Rationale |
|---------|-------|--------|-----------|
| STRAT-REV | 79–85 | L | Parallel multi-lens review: confidence gates, false-positive exclusions, fix-first classification, cross-model adversarial synthesis. Depends on STRAT-PAR (COMPLETE). |
| COMP-DESIGN-2 | 87 | S | `compose new` reads design doc. Unblocked by Wave 0. Small integration. |

**Unlocks:** COMP-HEALTH (needs review findings), COMP-BENCH (needs review pipeline)

### Wave 3: Developer Experience

Three independent tracks — can run in parallel.

| Feature | Items | Effort | Rationale |
|---------|-------|--------|-----------|
| COMP-TEST-BOOTSTRAP | 125–128 | M | Auto-scaffold test framework + generate golden flows for test-less projects. |
| SKILL-PD | 96–99 | M | Three-tier progressive disclosure. ≥40% token reduction in multi-skill sessions. |
| COMP-CTX | 100–102 | M | Ambient context layer + staleness detection + decision log accumulation. |
| COMP-UX-3 | 137–139 | S | Workflow approachability — smart defaults, conversational gates, concise narration. |
| COMP-OBS-SURFACE | 146, 148, 150, 192 | S | Render existing invisible data: retries, postconditions, filtered events, live iteration budget counters. UI-only. |
| COMP-OBS-STREAM | 145, 151–152 | S | Tool result streaming through build-stream bridge + UI rendering. |
| COMP-CAPS-ENFORCE | 193–196 | M | Runtime capability violation detection — normalizer event tap, violation checker, enforcement mode. |
| COMP-IDEABOX (core) | 178–189 | L | Ideabox: scaffold, skill, full web UI (cards, lanes, triage, discussion, matrix, graph layer, analytics, promote wizard). |

**Unlocks:** COMP-HEALTH (needs COMP-CTX-2 for doc freshness signal)

### Wave 4: Quality Infrastructure

Quantified signals on top of the review and context layers from Waves 2–3.

| Feature | Items | Effort | Rationale |
|---------|-------|--------|-----------|
| COMP-HEALTH | 117–120 | M | Weighted quality score (0–100) for gate decisions. Depends on STRAT-REV + COMP-CTX-2. |
| COMP-QA | 113–116 | M | Diff-aware QA scoping — test only changed routes, smoke-check adjacent. |
| STRAT-TIER | 88–91 | M | Model tier routing. Opus plans → Haiku executes → Sonnet reviews. Cost reduction. |
| COMP-OBS-COST | 147, 153–155 | M | Per-step token/cost tracking. Extends Stratum audit + build-stream + ops strip + context panel. |
| COMP-OBS-GATES | 149, 156–158 | M | Tiered gate evaluation with short-circuit. Depends on STRAT-REV. |

**Unlocks:** Cost-efficient multi-agent runs, meaningful benchmark comparisons, full agent visibility

### Wave 5: Scale

Multi-agent coordination, production hardening, benchmarking. Enables D4.

| Feature | Items | Effort | Rationale |
|---------|-------|--------|-----------|
| ~~COMP-TEAMS~~ | 92–95 | S | **COMPLETE (v1)** — 3 team presets (review, research, feature), --team CLI, two-level template loader, read-only-researcher profile. |
| COMP-RT | 58–61 | L | Event coalescing, client hydration, connector trait split, session branching. |
| STRAT-VOCAB | 107–109 | S | Vocabulary enforcement — naming consistency across parallel agents. |
| COMP-BENCH | 62–66 | L | Model benchmark suite. Needs STRAT-REV + STRAT-TIER to be meaningful. |
| COMP-IDEABOX (scale) | 190–191 | M | Multi-project ideabox aggregation + external source import (GitHub, Linear). Needs workspace manifest. |

**Unlocks:** D4 (multi-agent dogfooding)

### Dependency Graph

```
Wave 0 ──→ Wave 2 (COMP-DESIGN-2 needs 1c)
Wave 0 ──→ D2
Wave 1 ──→ D3
Wave 2 ──→ Wave 4 (COMP-HEALTH needs STRAT-REV)
Wave 3 ──→ Wave 4 (COMP-HEALTH needs COMP-CTX-2)
Wave 4 ──→ Wave 5 (COMP-BENCH needs STRAT-REV + STRAT-TIER)
Wave 5 ──→ D4

Parallel: COMP-UX-2 runs independently throughout
Parallel: Wave 3 items are independent of each other
Parallel: Wave 1 items are independent of each other
```

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
| [wshobson/agents](https://github.com/wshobson/agents) | Reference: plugin marketplace with progressive disclosure, model routing, team presets |
| [garrytan/gstack](https://github.com/garrytan/gstack) | Reference: role-specialized skill prompts, confidence gates, fix-first review, diff-aware QA, health scoring, plan-diff verification, test bootstrap |
| [Hub3r7/claude-code-orchestration-template](https://github.com/Hub3r7/claude-code-orchestration-template) | Reference: tiered task escalation, PASS/FAIL loop-back, read-only agent enforcement, agent notes persistence |
| [srf6413/cstack](https://github.com/srf6413/cstack) | Reference: zero-config agent orchestration, markdown-as-state, heartbeat meta-agent, conversational setup |
| [algorismo-au/lanekeep](https://github.com/algorismo-au/lanekeep) | Reference: local-first governance sidecar, tiered evaluation pipeline, self-protection rules, budget-as-enforcement, append-only audit |

---

## COMP-CONSENSUS: Multi-LLM Consensus Orchestration — PLANNED

Run multiple LLM providers on the same task and use a consensus gate (e.g., 75% agreement) to catch disagreements and hallucinations. Extends the existing connector architecture to dispatch the same prompt to 2–4 providers, collect responses, and score agreement. Disagreements surface for human review.

Inspired by [Claude Octopus](https://github.com/nyldn/claude-octopus) (2.4K stars) — multi-provider consensus pattern.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 159 | COMP-CONSENSUS-1 | **Consensus dispatcher:** send same prompt to N connectors in parallel. Reuses existing connector trait + STRAT-PAR parallel execution. Configurable provider list per consensus step. Timeout per provider with partial-result fallback. | PLANNED |
| 160 | COMP-CONSENSUS-2 | **Agreement scorer:** semantic similarity + structured diff across responses. Pairwise comparison matrix. Agreement threshold configurable (default 75%). Scoring method pluggable — exact match, embedding cosine, LLM-as-judge. | PLANNED |
| 161 | COMP-CONSENSUS-3 | **Disagreement gate:** surface divergent responses as a gate decision. When agreement falls below threshold, gate blocks with a structured comparison view: areas of agreement, areas of divergence, per-provider response excerpts. Human selects winner or requests re-run. | PLANNED |
| 162 | COMP-CONSENSUS-4 | **Pipeline integration:** optional `consensus: true` flag on any Stratum step. When enabled, step dispatches through consensus dispatcher instead of single connector. Consensus result replaces step output. Audit trace includes per-provider responses and agreement score. | PLANNED |

**Dependencies:** Phase 4 connectors (COMPLETE).

**Exit:** Any Stratum step can opt into multi-provider consensus. Agreement is scored and disagreements block as gates. Human resolves divergences. Audit trace captures all provider responses.

---

## COMP-AUTOHARNESS: Autonomous Agent Harness Optimization — PLANNED

Meta-agent that iterates on agent configurations (system prompts, tool lists, routing rules) against benchmarks overnight. Instead of hand-tuning, AutoHarness runs: modify config → benchmark → score → keep/discard → repeat. Complements COMP-BENCH (provides the benchmark infrastructure).

Inspired by [AutoAgent](https://github.com/kevinrgu/autoagent) (MarkTechPost) — hit #1 on SpreadsheetBench (96.5%) via autonomous iteration.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 163 | COMP-AUTOHARNESS-1 | **Harness definition format:** YAML describing mutable config dimensions — system prompt variants, tool subsets, routing rule alternatives, model tier overrides. Each dimension declares value space and constraints. Stored in `.compose/harness/<name>.yaml`. | PLANNED |
| 164 | COMP-AUTOHARNESS-2 | **Iteration loop:** modify → dispatch → score → keep/discard cycle. Selects dimension to mutate, generates variant, runs benchmark suite, compares score to current best. Keeps improvement, discards regression. Configurable iteration count and convergence threshold. | PLANNED |
| 165 | COMP-AUTOHARNESS-3 | **COMP-BENCH integration:** use bench suite as scoring oracle. Harness submits config variant → COMP-BENCH runs feature set → returns aggregate score. Harness compares against baseline. Requires COMP-BENCH seed repos and scoring rubric. | PLANNED |
| 166 | COMP-AUTOHARNESS-4 | **`compose optimize --feature X` CLI command:** runs harness overnight against a specific feature's benchmark. Reports: best config found, score delta vs baseline, iteration history, recommended changes. Writes result to `.compose/data/optimize-results/<feature>.json`. | PLANNED |

**Dependencies:** COMP-BENCH (benchmark infrastructure).

**Exit:** Agent configurations can be optimized automatically against benchmarks. CLI command runs overnight optimization. Results include score improvement and recommended config changes.

---

## STRAT-CODEGRAPH: Code Graph Context for Agents — PLANNED

Feed structural code understanding (call hierarchies, type relationships, dependency chains) into agent prompts during implementation phases. Reduces token waste by replacing broad file reads with targeted structural queries. Claimed: 32% cost reduction, 67% more code edits.

Sources: [Scope CLI](https://rynhardt-potgieter.github.io/scope/) (Rust-based code intelligence), [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) (2.8K stars, MCP server with tree-sitter + graph DB).

| # | Feature | Item | Status |
|---|---------|------|--------|
| 167 | STRAT-CODEGRAPH-1 | **Code graph MCP integration:** configure Scope or CodeGraphContext as a tool available during `compose build`. Auto-detect project language, index on first run, incremental re-index on file changes. Graph queryable via MCP tool calls from any Stratum step. | PLANNED |
| 168 | STRAT-CODEGRAPH-2 | **Auto-query injection:** implementation steps auto-query the code graph for relevant context before dispatching agents. Given a task targeting file X, query: callers of X, types used by X, tests covering X. Inject as structured context block, replacing broad file reads. | PLANNED |
| 169 | STRAT-CODEGRAPH-3 | **Blast radius scoring:** use PageRank + co-change history to rank file importance relative to a change set. High-PageRank files get extra review attention. Co-change clusters surface "you probably also need to update Y" warnings. Inspired by [SoulForge](https://github.com/ProxySoul/soulforge) (174 stars). | PLANNED |

**Dependencies:** None — standalone integration.

**Exit:** Code graph is indexed and queryable during builds. Implementation steps receive targeted structural context. Blast radius scoring warns about high-impact changes. Token usage measurably reduced vs. broad file reads.

---

## COMP-SPECFLOW: Spec-Driven Development Artifacts — PLANNED

Formalize the proposal → spec → design → tasks artifact flow as a lightweight, iterative (not waterfall) pipeline. Each artifact type has a schema and a "good enough" quality bar. Artifacts are fluid — updated as understanding evolves, not frozen at creation. Compose already has lifecycle phases that map to this — this feature refines the artifact schemas and makes them usable outside Compose.

Inspired by [OpenSpec](https://github.com/Fission-AI/OpenSpec/) — spec-driven development framework.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 170 | COMP-SPECFLOW-1 | **Artifact schemas:** `proposal.md`, `spec.md`, `design.md`, `tasks.md` templates with required/optional sections. Each template declares: required fields, optional fields, cross-reference expectations, minimum content thresholds. Stored in `.compose/templates/artifacts/`. | PLANNED |
| 171 | COMP-SPECFLOW-2 | **Quality bar definitions:** per-artifact "good enough" checklist that gates can reference. Proposal: problem stated, audience identified, scope bounded. Spec: acceptance criteria as checkboxes, contract references. Design: component diagram, data flow, error handling. Tasks: dependencies ordered, effort estimated, file paths annotated `(new)`/`(existing)`. | PLANNED |
| 172 | COMP-SPECFLOW-3 | **`compose artifact validate` CLI:** schema + quality check without running a full build. Validates artifact against its template schema, checks required fields, flags missing cross-references, scores against quality bar. Returns structured pass/warn/fail per check. | PLANNED |
| 173 | COMP-SPECFLOW-4 | **Standalone export:** artifacts usable with any AI coding tool, not just Compose. Export strips Compose-specific metadata, preserves content and cross-references as relative links. Output formats: markdown (default), JSON (for tooling). `compose artifact export --format md`. | PLANNED |

**Dependencies:** COMP-DESIGN (design conversation — PARTIAL).

**Exit:** Artifact templates enforce consistent structure. Quality bars gate progression. CLI validates without full builds. Artifacts export cleanly for use outside Compose.

---

## COMP-REVIEW-ENH: Review Pipeline Enhancements — PLANNED

Enhance the existing STRAT-REV review pipeline with patterns from compound-engineering's multi-agent review system. Extends the lens library with adversarial reviewers, adds domain-aware conditional dispatch, and introduces plan deepening for pre-implementation validation.

Inspired by [compound-engineering-plugin](https://github.com/EveryInc/compound-engineering-plugin) (Every Inc) — ~50 agents, ~40 skills, Brainstorm→Plan→Work→Review→Compound lifecycle.

| # | Feature | Item | Status |
|---|---------|------|--------|
| 174 | COMP-REVIEW-ENH-1 | **Adversarial review lens:** new lens that constructs failure scenarios to break implementations across component boundaries. Unlike existing lenses (diff-quality, security, contract-compliance) which check what IS there, this lens imagines what COULD go wrong. Feeds into existing merge + dedup step. | PLANNED |
| 175 | COMP-REVIEW-ENH-2 | **Domain-aware conditional dispatch:** review triage step activates lenses based on detected codebase characteristics — Rails reviewer only for Rails projects, migration reviewer only when migrations are present, security reviewer weighted higher when auth files change. Extends STRAT-REV-1 (triage step, COMPLETE) with richer activation rules. | PLANNED |
| 176 | COMP-REVIEW-ENH-3 | **Plan deepening:** re-run research agents against an existing plan to find gaps, without re-planning from scratch. `compose deepen FEAT-X` dispatches investigators that probe the plan for missing edge cases, untested paths, and implicit assumptions. Findings surface as plan amendments, not rewrites. | PLANNED |
| 177 | COMP-REVIEW-ENH-4 | **Document review personas:** pre-implementation gate with specialized document reviewers — coherence checker, feasibility assessor, scope guardian, product lens, design lens. Validates plan/spec quality before the build phase begins. Extends COMP-DESIGN (design conversation) with structured plan validation. | PLANNED |

**Dependencies:** STRAT-REV (parallel multi-lens review — PARTIAL), COMP-DESIGN (design conversation — PARTIAL)

**Exit:** Review pipeline includes adversarial scenarios. Lenses activate conditionally based on codebase. Plans can be deepened without replanning. Document review personas validate specs before build. Review quality improves without proportional cost increase.

---

## COMP-IDEABOX: Product Idea Capture & Triage — PARTIAL (core COMPLETE, 190/191 deferred to Wave 5)

Built-in product ideabox for any Compose-managed project. `compose init` scaffolds an ideabox. Ideas are captured, clustered, triaged, and promoted into the roadmap — all through CLI or web UI. The ideabox is a Compose primitive, not a per-project custom file.

**Prior art:** SmartMemory has a mature `ideabox.md` (85+ ideas, clustered by feature, priority lenses, sequential IDs) and a `/ideabox` skill. This feature productizes that pattern into Compose so any project gets it out of the box.

| # | Feature | Item | Status |
|---|---------|------|--------|
| # | Feature | Item | Status |
|---|---------|------|--------|
| 178 | COMP-IDEABOX-1 | **`compose init` ideabox scaffold:** `compose init` creates `docs/product/ideabox.md` with conventions header (ID format, statuses, priorities, tags). Manifest gains `ideabox_path` field. `/ideabox` skill resolves path from manifest — works on any Compose project. Existing SmartMemory ideabox migrates cleanly (already follows the format). LLM-assisted auto-clustering on `/ideabox add` — suggests best-fit cluster or proposes a new one. | COMPLETE |
| 179 | COMP-IDEABOX-2 | **Promote + kill workflows:** `/ideabox promote` creates feature folder in `docs/features/`, seeds `plan.md`, adds to ROADMAP.md, updates `roadmap-graph.html`, marks idea as PROMOTED. `/ideabox kill` moves to Killed section with reason and date. Works against any project's ideabox via manifest path. | COMPLETE |
| 180 | COMP-IDEABOX-3 | **Priority lens support:** Persona-based triage lenses. `/ideabox triage --lens <name>` filters and ranks ideas through a target-user lens (e.g., "vibe-coder", "enterprise-admin"). Lenses stored as `ideabox-priority-<lens>.md` alongside the ideabox. `compose init` scaffolds an empty lens template. | COMPLETE |
| 181 | COMP-IDEABOX-4 | **Design UI — Ideabox view:** New "Ideabox" tab in the Compose cockpit. Landing state: digest summary ("3 new since last visit, 12 untriaged, top P0 cluster: Graph Viewer"). Card-based layout with ideas grouped by cluster. Each card: ID, title, tags, priority badge, source, status. Drag-and-drop between priority lanes (P0/P1/P2/untriaged). Click card → context panel with full idea details, related roadmap features, promote/kill/discuss actions. Filter by tag, status, priority, source. Search bar. Killed ideas in a collapsible "Graveyard" section with reason, date, and resurrect action. | COMPLETE |
| 182 | COMP-IDEABOX-5 | **Design UI — Triage flow:** Interactive triage mode in the web UI. Presents untriaged ideas one-at-a-time (or in batches). For each: full idea card + related context + LLM-detected duplicates ("similar to IDEA-12, IDEA-45"). Actions: assign priority, promote, kill, skip, discuss, merge (mark as duplicate of another idea). Progress indicator (N/total). Triage summary on completion. Priority lens selector to filter triage by persona. | COMPLETE |
| 183 | COMP-IDEABOX-6 | **Design UI — Promote flow:** Wizard-style flow. Single idea: select or create feature ID → confirm roadmap placement → preview generated `plan.md` → confirm. Cluster merge-and-promote: select 2+ related ideas from same cluster → merge into single feature with combined context → promote as one. Updates ideabox.md, ROADMAP.md, and `roadmap-graph.html` in one operation. Visual confirmation with link to new feature in Graph/Tree view. | COMPLETE |
| 184 | COMP-IDEABOX-7 | **Compose lifecycle integration:** `compose design` and `compose build` sessions auto-detect surfaced ideas and suggest `/ideabox add`. Auto-capture prompt (never auto-file). Promoted ideas feed into `compose new` as enriched intent — skipping questionnaire fields already answered in the idea. Ideabox stats visible in cockpit sidebar (N new, N triaged, N promoted). Staleness nudges: ideas untriaged for 14+ days surfaced in sidebar attention queue. Ideas with no activity for 30+ days flagged in triage. | COMPLETE |
| 185 | COMP-IDEABOX-8 | **API + persistence:** REST API for ideabox CRUD (`GET/POST/PATCH/DELETE /api/ideabox`, `POST /api/ideabox/:id/discuss`, `POST /api/ideabox/:id/promote`, `POST /api/ideabox/:id/kill`). Markdown parser reads `ideabox.md` into structured JSON. WebSocket broadcast on ideabox state changes. File-based persistence in `ideabox.md` (source of truth) with parsed JSON cache in `.compose/data/ideabox-cache.json` for fast UI queries. | COMPLETE |
| 186 | COMP-IDEABOX-9 | **Design UI — Discussion threads:** When an idea is DISCUSSING, context panel shows a lightweight threaded conversation. Each message: author (human or agent), timestamp, text. Discussion context preserved and included when the idea is eventually promoted (seeded into `plan.md` as "Prior discussion"). `/ideabox discuss IDEA-N <comment>` from CLI appends to thread. Stored inline in ideabox.md under the idea entry. | COMPLETE |
| 187 | COMP-IDEABOX-10 | **Design UI — Impact/effort matrix:** Visual 2x2 scatter plot view alongside the card/lane view. X-axis: estimated effort (S/M/L, assignable during triage). Y-axis: estimated impact (low/medium/high). Ideas plotted as dots colored by cluster. Quadrant labels: Quick Wins (high impact, low effort), Big Bets (high impact, high effort), Fill-ins (low impact, low effort), Money Pits (low impact, high effort). Click dot → context panel. Drag dot to reassign effort/impact. | COMPLETE |
| 188 | COMP-IDEABOX-11 | **Design UI — Roadmap graph integration:** Ideas appear as a ghost layer in the existing Graph view. Idea nodes rendered as dashed-border circles, smaller than feature nodes, colored by priority. Connected to roadmap features via "maps to" edges (dotted lines). Toggle: "Show ideas" checkbox in graph controls. Clicking an idea node opens ideabox context panel. Promoted ideas animate from idea node → solid feature node on promote. | COMPLETE |
| 189 | COMP-IDEABOX-12 | **Design UI — Source analytics + digest:** Dashboard section in the Ideabox tab header. Source breakdown: bar chart of idea sources (competitor analysis, session insight, user feedback, research paper). Conversion funnel: NEW → DISCUSSING → PROMOTED (with kill rate). Cluster health: which clusters have the most ideas, most promoted, most killed. Time series: ideas added per week. All derived from ideabox.md metadata, no external tracking. | COMPLETE |
| 190 | COMP-IDEABOX-13 | **Multi-project aggregation:** When Compose manages multiple projects (via parent workspace manifest or explicit project list), unified ideabox view across all projects. Ideas tagged with project origin. Cross-project dedup detection ("SmartMemory IDEA-42 and Forge IDEA-7 overlap"). Promote targets a specific project's roadmap. Filter by project. Requires: workspace-level manifest in parent repo listing Compose projects. | PLANNED |
| 191 | COMP-IDEABOX-14 | **External source sync:** `/ideabox sync` pulls and pushes ideas between ideabox and external systems. Supported sources: GitHub issues (by label, e.g. `idea` or `enhancement`), Linear tickets (by project/status), Jira issues (by JQL filter or label), clipboard (paste a URL or text block). Bidirectional: import creates IDEA-N with source attribution and backlink; promote/kill status syncs back to the external system (close issue, update ticket status). Dedup check on sync. Bulk import with preview before filing. Configurable sync schedule or manual trigger. | PLANNED |

**Dependencies:** COMP-UX-1 (context panel — COMPLETE), COMP-DESIGN (design conversation — PARTIAL for auto-capture in item 7)

**Exit:** Any Compose project gets an ideabox out of the box via `compose init`. CLI and web UI for full lifecycle: capture (with auto-clustering and dedup), triage (with persona lenses and impact/effort matrix), discuss (threaded conversations), promote (single or cluster-merge, wizard flow), kill (with graveyard and resurrect). Ideas visible as ghost layer in roadmap graph. Source analytics show where ideas come from and what converts. Multi-project aggregation for workspaces. External import from GitHub/Linear. Staleness nudges keep the backlog healthy.
