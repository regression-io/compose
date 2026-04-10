# Changelog

## 2026-04-09

### COMP-IDEABOX Batch 3: Advanced Features (Items 184, 186, 187, 188, 189)

**Item 184: Lifecycle integration**
- **build.js:** after each agent step, scans output text for "we should/could/might" patterns and emits `idea_suggestion` stream events (hints only, nothing auto-filed).
- **bin/compose.js:** `compose new --from-idea <ID>` flag pre-populates intent from an ideabox entry's title + description + cluster, skips duplicate questionnaire fields.
- **AttentionQueueSidebar.jsx:** "Ideas" section below the attention queue showing untriaged idea count. Click navigates to the ideabox view.

**Item 186: Discussion threads**
- **lib/ideabox.js:** `parseIdeabox` and `serializeIdeabox` support inline discussion entries (`**Discussion:**` block with `- [date] author: text` entries). Discussion field parsed to `[{ date, author, text }]`.
- **lib/ideabox.js:** `addDiscussion(parsedData, ideaId, author, text)` mutation helper.
- **server/ideabox-routes.js:** `POST /api/ideabox/ideas/:id/discuss` endpoint.
- **bin/compose.js:** `compose ideabox discuss <ID> "<comment>"` subcommand.
- **IdeaboxView.jsx:** discussion thread rendered in detail panel; inline input to add comments.
- **useIdeaboxStore.js:** `addDiscussion` and `updateIdea` actions.

**Item 187: Impact/effort matrix**
- **lib/ideabox.js:** `effort` (S|M|L) and `impact` (low|medium|high) fields added to idea schema. Parsed from `**Effort:**` and `**Impact:**` lines.
- **server/ideabox-routes.js:** PATCH allows `effort` and `impact` fields.
- **IdeaboxMatrixView.jsx (new):** 2x2 scatter plot with Quick Wins / Big Bets / Fill-ins / Money Pits quadrants. Unassigned tray with inline EffortImpactForm. Dot colors by cluster.
- **IdeaboxView.jsx:** "Cards | Matrix" tab toggle in header.

**Item 188: Roadmap graph integration**
- **GraphView.jsx:** "Ideas" toggle (default off). When on, renders idea nodes as dashed amber circles connected via dashed edges to their `mapsTo` feature targets.

**Item 189: Source analytics + digest dashboard**
- **IdeaboxAnalytics.jsx (new):** collapsible analytics section in header — source breakdown bars, NEW→DISCUSSING→PROMOTED status funnel with kill rate, cluster health with promotion rate. Pure derived computation from store data.

- **Tests:** 68 tests, all passing. New suites: discussion parsing, addDiscussion, effort/impact fields, resurrectIdea.

### COMP-IDEABOX: Product Idea Capture & Triage (Wave 3) — Batches 1+2

**Batch 1 (Backend + CLI):**
- **lib/ideabox.js (new):** pure markdown parser/writer. parseIdeabox/serializeIdeabox round-trip, addIdea, promoteIdea, killIdea, resurrectIdea, setPriority, addDiscussion, loadLens. Handles SmartMemory canonical format.
- **server/ideabox-routes.js (new):** REST API — GET, POST, PATCH, /promote, /kill, /resurrect, /discuss. PATCH rejects status mutations (must use /promote or /kill).
- **server/ideabox-cache.js (new):** mtime-invalidated JSON cache for fast UI queries.
- **bin/compose.js:** `compose init` scaffolds `docs/product/ideabox.md`. `compose ideabox` subcommands: add, list, promote, kill, pri, triage, discuss. Respects `paths.ideabox` and `paths.features` from compose.json.
- 48 parser/CLI tests.

**Batch 2 (Core Web UI):**
- **IdeaboxView.jsx (new):** main view with digest header, filter bar (tag/status/priority/search), priority lanes, drag-and-drop, click-to-detail panel, graveyard.
- **IdeaboxTriagePanel.jsx (new):** modal triage flow with keyboard shortcuts, similarity hints, progress.
- **IdeaboxPromoteDialog.jsx (new):** 3-step wizard (feature code → preview → confirm).
- **useIdeaboxStore.js (new):** Zustand store with WS-driven hydration.
- ViewTabs registers ideabox tab; App.jsx routes it.
- 24 store tests.

**Batch 3 (Advanced + Integrations):**
- **Discussion threads:** parse/serialize, addDiscussion endpoint, CLI `compose ideabox discuss`, detail panel thread UI.
- **Effort/impact matrix:** schema fields with enum validation, IdeaboxMatrixView.jsx (2x2 scatter with quadrants, unassigned tray).
- **Graph integration:** GraphView "Ideas" toggle renders idea nodes as dashed amber circles connected to mapsTo features. Nodes carry status='idea' for handler compatibility.
- **Source analytics:** IdeaboxAnalytics.jsx — source breakdown bars, status funnel, cluster health.
- **Lifecycle integration:** build.js scans agent output for "we should/could" patterns, emits idea_suggestion stream events. AttentionQueueSidebar shows untriaged count. `compose new --from-idea <ID>` pre-populates intent.
- 20 additional tests (discussion, addDiscussion, effort/impact, resurrect).

**Codex fixes:** REST promote now creates feature folder (CLI parity), enum validation on effort/impact, idea graph nodes interactive, idea_suggestion events bridged to UI.

92 total tests, all passing.

### COMP-CTX: Ambient Context Layer (Wave 3)

- **compose init:** scaffolds `docs/context/` with tech-stack.md, conventions.md, decisions.md. Path configurable via `compose.json` `paths.context`.
- **step-prompt.js:** ambient context injected into every agent prompt as `## Project Context`. Cached per-build, invalidated after decision log append.
- **staleness.js:** `checkStaleness()` reads `<!-- phase: ... -->` markers from artifacts, flags stale files in gate context.
- **Decision log:** gate outcomes auto-appended to decisions.md with date, feature, step, outcome, rationale.
- 33 tests, all passing.

### COMP-CAPS-ENFORCE: Runtime Violation Detection (Wave 3)

- **result-normalizer.js:** `onToolUse` callback tap on tool_use events — passive, doesn't change event flow.
- **capability-checker.js:** `checkCapabilityViolation()` compares tools against agent template. Violation (disallowed) vs warning (not in allowedTools).
- **build.js:** violations checked in both main loop and child flow steps. Logged to stream + console.
- **settings-store.js:** `capabilities.enforcement` setting — `log` (default) or `block`. Block mode fails the step on violation.
- 11 tests, all passing.

### COMP-TEST-BOOTSTRAP: Test Framework Bootstrap (Wave 3)

- **test-bootstrap.js:** `detectTestFramework()` checks config files + package.json deps. `scaffoldTestFramework()` creates vitest/jest/pytest/go/rust test setup.
- **build.js:** before coverage step, detects framework; if missing, scaffolds then annotates step intent for golden flow generation.
- **Ship step:** uses detected test command instead of hardcoded `npm test`.
- 25 tests, all passing.

### COMP-OBS-SURFACE + COMP-OBS-STREAM (Wave 3)

- **OBS-SURFACE:** Items 146, 148, 150 already implemented. Item 192 (live budget counters): OpsStrip shows "review 3/5, 2:34/15:00" during active iterations with live elapsed timer.
- **OBS-STREAM:** Items 145, 151-152 already implemented. Bridge mapping, ToolResultBlock, verbose gating all in place.

### COMP-UX-3: Workflow Approachability (Wave 3)

- **Scaffold defaults (137):** `compose feature` detects language, test framework, counts existing features. Pre-populates profile in feature.json (needs_prd, needs_architecture, etc.).
- **Conversational gates (138):** `buildRecommendation()` derives 1-sentence summary + recommended action from artifact assessment. Enter key defaults to recommendation. "d" shows full details. Web UI RecommendationBadge above gate actions.
- **Status narration (139):** 1-line console summaries after each step, gate resolution, and iteration. Full detail still in stream events.

### STRAT-REV-7: Cross-Model Adversarial Synthesis (Wave 2)

- **review-lenses.js:** `classifyDiffSize()` (small/medium/large by file count) and `shouldRunCrossModel()` gate.
- **build.js:** `runCrossModelReview()` — after Claude lenses complete on large diffs (≥9 files), dispatches Codex review, parses string findings, runs Claude synthesis agent to classify CONSENSUS/CLAUDE_ONLY/CODEX_ONLY. Fail-open: Codex errors return original result.
- **Opt-out:** `opts.skipCrossModel`, `COMPOSE_CROSS_MODEL=0` env var, graceful skip when Codex unavailable.
- No pipeline YAML changes — all orchestration in build.js.
- 29 tests (13 diff-size + 16 cross-model), all passing.

### COMP-DESIGN-2: Compose New Integration (Wave 2)

- Already implemented in prior session. `compose new` detects `docs/design.md`, appends to intent, skips questionnaire. Each pipeline step receives design doc via `$.input.intent`.

### COMP-BUDGET: Iteration Budget Enforcement (Wave 1)

- **vision-routes.js:** Wall-clock timeout enforcement (checked at each report, configurable per loop type), action count ceiling (accumulated from agent reports), auto-abort with structured outcomes (`timeout`, `action_limit`).
- **budget-ledger.js:** Cumulative cross-session budget tracking in `.compose/data/budget-ledger.json`. `recordIteration()` called from both report and abort routes. `checkCumulativeBudget()` blocks iteration start when cumulative limits exceeded (429).
- **settings-store.js:** Per-loop-type settings: `iterations.review.timeout` (15min default), `iterations.coverage.timeout` (30min), `iterations.review.maxTotal` (20), `iterations.coverage.maxTotal` (50).
- **visionMessageHandler.js:** Client handles `timeout` and `action_limit` outcomes with distinct messages.
- 15 tests, all passing.

### HOOK-CACHE: Read Cache Hook (Wave 1)

- **read-cache.py:** PreToolUse hook on Read. Per-agent mtime + line-range tracking. Blocks redundant reads of unchanged files with covered ranges. Merges overlapping intervals. Metrics to `stats.json`.
- **read-cache-invalidate.py:** PostToolUse hook on Edit/Write/MultiEdit. Invalidates cache entry for modified file.
- **read-cache-compact.py:** PreCompact hook. Clears entire session cache (context no longer has the content).
- **hooks.json:** Registered all three hooks, replacing old `read-cache.sh`.
- 15 tests, all passing.

### COMP-PLAN-VERIFY: Plan-Diff Verification (Wave 1)

- **plan-parser.js:** Agent-side helper — `parsePlanItems()` extracts checkbox items with file paths and critical flags, `matchItemsToDiff()` classifies done/missing/extra.
- **spec.py:** `plan_completion(plan_items, files_changed, threshold=90)` ensure builtin. Division-by-zero guard. Critical missing items → plain string violations. Below threshold → violation with percentage.
- **executor.py:** Registered `plan_completion` in ensure sandbox.
- **build.stratum.yaml:** Ship step ensure clause: `plan_completion(result.plan_items, result.files_changed)`. Ship step intent updated to instruct agent to extract plan items.
- 12 Python + 16 JS tests, all passing.

### STRAT-IMMUTABLE: Spec Immutability During Execution (Wave 1)

- **Stratum executor:** `spec_checksum` on FlowState — SHA-256 of parsed FlowDefinition computed at flow start, verified at every `stratum_step_done` and `stratum_parallel_done`. Detects in-memory spec mutation. Checksum persisted/restored across MCP restarts.
- **build.js Layer 2:** Pipeline file hash and policy hash captured at build start. `verifyPipelineIntegrity()` re-reads YAML from disk before each step transition — detects on-disk tampering. `verifyPolicyIntegrity()` hashes settings.json policies before gate resolution — detects gate criteria weakening.
- 9 Python tests + 7 JS tests, all passing.

### COMP-AGENT-CAPS: Agent Capability Profiles (Wave 1)

- **agent-templates.js:** 4 built-in profiles — `read-only-reviewer` (Read/Grep/Glob only), `implementer` (full access), `orchestrator` (no Edit/Write), `security-auditor` (Read/Grep/Glob/Bash).
- **agent-string.js:** Centralized `parseAgentString("claude:read-only-reviewer")` → `{ provider, template }` + `resolveAgentConfig()` for full resolution with tool restrictions.
- **claude-sdk-connector.js:** Accepts `allowedTools`/`disallowedTools`, passes to SDK. Falls back to `preset: claude_code` when no restrictions (backward compat).
- **build.js:** `defaultConnectorFactory` resolves agent string through template registry. Emits `capability_profile` stream events.
- **build.stratum.yaml:** Review sub-flow steps use `claude:orchestrator` (triage, merge) and `claude:read-only-reviewer` (lens dispatch).
- 28 tests, all passing.

### COMP-TRIAGE: Task Tier Classification (Wave 1)

- **triage.js:** Pure file analysis — counts paths in plan/blueprint, detects security/core paths, assigns tier 0-4 and build profile (`needs_prd`, `needs_architecture`, `needs_verification`, `needs_report`).
- **build.js integration:** Triage runs before `stratum_plan()`, mutates `skip_if` on skippable steps based on profile. Cached in feature.json with mtime-based invalidation.
- **CLI:** `compose triage <feature>` standalone command. `compose build --template <name>` and `--skip-triage` flags.
- No new pipeline templates — reuses existing `build.stratum.yaml` with `skip_if` toggling.
- 13 tests, all passing.

### COMP-DESIGN-1c: Live Design Doc (Wave 0)

- **DesignDocPanel.jsx** (new): Context panel component showing a live markdown preview of the design document as it builds from decisions. Preview mode (react-markdown + remark-gfm) and edit mode (monospace textarea). Manual edits survive across assistant turns. "Reset to auto-generated" rebuilds from current decisions.
- **designSessionState.js**: Added `buildDraftDoc(messages, decisions)` — constructs markdown draft from problem statement + active decisions + open threads. Added `buildTopicOutline(messages, decisions)` — extracts decided topics for the research sidebar.
- **useDesignStore.js**: New state fields (`draftDoc`, `docManuallyEdited`, `researchItems`, `topicOutline`). Draft rebuilds on each assistant turn unless manually edited. Manual edit state preserved across rehydration.
- **design-routes.js**: `POST /api/design/complete` accepts optional `draftDoc` body field — uses human-edited draft as seed for final LLM polish pass instead of generating from scratch.
- **App.jsx**: Context panel auto-shows DesignDocPanel when design view is active.

### COMP-DESIGN-1d: Research Sidebar (Wave 0)

- **DesignSidebar.jsx**: Added tab bar (Decisions / Research) with count badges. Existing decision log under Decisions tab. Research tab shows live research activity.
- **ResearchTab.jsx** (new): Three collapsible sections — Topic Outline (decided/open topics), Codebase References (Read/Grep/Glob tool uses with file paths), Web Searches (queries + summaries). Live updates as research events stream in.
- **design-routes.js**: Broadcasts `research` and `research_result` SSE events from `tool_use` and `tool_use_summary` events during design conversations. Unique `tu-N` IDs for reliable event correlation.
- **useDesignStore.js**: SSE handlers for research events with ID-based correlation. Research items accumulate across the full session.
- 38 design tests, all pass. 8 new test cases for `buildDraftDoc` and `buildTopicOutline`.

## 2026-03-28

### STRAT-REV: Parallel Multi-Lens Review (1-4, 6)

- **Stratum:** Added `isolation: "none"` to IR v0.3 schema (`spec.py`) for read-only parallel_dispatch tasks. 2 new tests.
- **Lens library:** `lib/review-lenses.js` — 4 lens definitions (diff-quality, contract-compliance, security, framework) with confidence gates and false-positive exclusions. `triageLenses()` activates lenses based on file patterns. 10 tests.
- **Pipeline:** `pipelines/build.stratum.yaml` — new contracts (LensFinding, LensTask, LensResult, TriageResult, MergedReviewResult), `parallel_review` sub-flow (triage → parallel lens dispatch → merge), main flow review step wired to `parallel_review`.
- **Build.js:** Review timeout bumped to 15min, added triage (2min) and merge (3min) timeouts. `isolation: "none"` path verified for read-only tasks.
- **Fix loop:** Parent-level ensure/retry drives the fix loop — ensure fails → build.js claude fix → whole sub-flow re-invoked with fresh triage/lenses/merge.
- STRAT-REV-5 (selective re-review) complete: sidecar `.compose/prior_dirty_lenses.json` written on review ensure_failed, triage reads it on retry. STRAT-REV-7 (cross-model synthesis) deferred.

### COMP-UI-6: Polish and Teardown

- Deleted dead components: `AppSidebar.jsx` (~120 lines), `ItemRow.jsx` (~960 lines)
- Cleaned `VisionTracker.jsx`: removed @deprecated tag, scoped to PopoutView only
- Consolidated 13 scattered JS color constants from 9 files into `constants.js`
- Wrapped 6 remaining UI zones in `PanelErrorBoundary` (NotificationBar, GateNotificationBar, ChallengeModal, CommandPalette, ItemFormDialog, SettingsModal)
- Removed 8 dead functions from `vision-logic.js` (kept `filterSessions`, `relativeTime`)
- Deleted 17 dead `--row-*` CSS variables and `.row-chevron` class from `index.css`
- Removed dead `expandAgentBar()` export from `agentBarState.js`
- Updated tests: removed dead function tests, all 46 remaining tests pass
- **COMP-UI feature complete** — all 6 items done

### COMP-AGT-1-4: Agent Lifecycle Control

- `server/agent-health.js`: HealthMonitor class — stdout+stderr liveness probes, 60s silence warning, 5min auto-kill, wall-clock timeout, memory RSS polling, terminal reason tracking
- `server/worktree-gc.js`: WorktreeGC class — .owner file ownership, orphan scanning, age-based pruning, git worktree remove + rm fallback
- `server/agent-spawn.js`: `POST /api/agent/:id/stop` (SIGTERM→grace→SIGKILL), `POST /api/agent/gc`, health monitor wiring, terminal state precedence
- `server/agent-server.js`: 5s interrupt escalation timer for SDK sessions
- `server/agent-registry.js`: getRunning() and updateStatus() methods
- `lib/build.js`: .owner file on worktree creation, disk quota check (500MB default)
- UI: kill button per agent tab, silence warning yellow dot, agentKilled terminal state
- 16 tests (agent-health: 10, worktree-gc: 6)

### COMP-PIPE-1-3: Pipeline Authoring Loop

- 4 new pipeline templates: bug-fix (6 steps), refactor (7), content (4), research (3)
- Metadata blocks on all 7 templates (id, label, description, category, steps, estimated_minutes)
- `server/pipeline-routes.js`: template listing, spec fetch, draft CRUD with draftId concurrency, approve/reject with safe lifecycle
- `lib/build.js`: template selection via `opts.template`
- Store: `pipelineDraft` state + WS handlers for `pipelineDraft`/`pipelineDraftResolved`
- `TemplateSelector.jsx`: template card picker
- `PipelineView.jsx`: three modes — Empty (template selector), Draft (read-only + approve/reject), Active (existing)
- Version-aware step derivation (v0.1 flows + v0.3 workflow)
- Approved specs written to `.compose/data/approved-specs/` (not template library)
- 18 tests for pipeline-routes

### Phase 6.9: Agent Fleet Management — Roadmap

Added 17 items (COMP-AGT-1 through COMP-AGT-17) across 5 feature groups:
- Agent Lifecycle Control: interrupt, health monitoring, resource limits, worktree GC
- Agent Coordination: parent-child RPC, inter-task coordination, message ordering
- Merge & Recovery: conflict recovery strategies, graceful degradation with retry
- Registry & Observability: rich queries, structured metrics, dependency validation
- Agent Templates & Parent Skills: template library, capability registry, root parent
  orchestration skill, parallel dispatch skill, persistent state machine

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
