# Compose: Product Specification

**Version:** 1.0
**Date:** 2026-03-12
**Status:** Living document — reflects built, in-progress, and planned capabilities

---

## What Compose Is

Compose is a **lifecycle runtime for AI-assisted software development**. It sits between a developer's intent ("I want X") and the finished result ("X is built correctly"), providing the structured process that turns one into the other.

It is not a task tracker, a chat wrapper, an IDE, or a project management tool — though it contains elements of all four. It is the **structured process** between wanting something and having it, executed by AI agents under human governance.

### The Core Problem

AI coding agents are powerful executors but have no persistent awareness of where a project stands, what to work on next, or what constraints to respect. Developers maintain this context in their heads, in scattered documents, or not at all — leading to:

- No way to see the big picture across all work
- Significant time orienting at the start of each session
- No coordination when multiple agents run in parallel
- Agents drifting without structured constraints
- No visual way to track progress across complex, multi-track projects

### The Core Thesis

**Visibility enables steering.** If you can see what's happening — in real time, at every level — you can direct it. Compose makes AI development visible, structured, and governable.

---

## Design Principles

Five architectural decisions define what Compose is and isn't:

### 1. Agent-Primary Architecture

The embedded agent (Claude Code in terminal) is the primary **write** interface. The structured UI (views, graphs, dashboards) is the primary **read** interface. Both are backed by the same `.compose/` persistence layer. The agent IS the process engine — there is no distinction between managing work and doing work.

### 2. The 3-Mode Dial

Every decision point in the system is a configurable dial with three modes:

| Mode | Behavior | Human Role |
|------|----------|------------|
| **Gate** | Blocked until human decides | Decider |
| **Flag** | Agent proceeds, human notified | Reviewer |
| **Skip** | Agent proceeds silently | Delegator |

Modes inherit downward through the work hierarchy. The human can override at any level. This single primitive governs all policy in the system.

### 3. Deliberation Is Work

Brainstorming, discussions, design decisions, and explorations are all **work items** with different labels — not separate entity types. An `informs` dependency connects deliberation to execution. Compose tracks the full journey from fuzzy idea to shipped code.

### 4. Deterministic UI, Dynamic Content

Views, layout, interactions, and navigation are **fixed and predictable**. The LLM contributes dynamic content (summaries, proposals, analysis) that flows into existing views. Compose feels like mission control, not a chatbot.

### 5. Live Render Surface

The Vision Surface provides sub-second latency (~100ms), real-time animation, and tight bidirectional feedback between agent and human. This responsiveness is the product differentiator — CRUD and filtering are commodity substrate.

---

## Composition Model

Compose's requirements framework defines a structured space:

```
Phases (7) × Things (7) × Verbs (4) × Processes (8) × Lenses (5)
```

### Phases — Levels of Concreteness

```
Vision → Requirements → Design → Planning → Implementation → Verification → Release
```

Phases are not enforced as a linear sequence. Any phase can loop back to any other. The system tracks the **macro phase** (where the center of gravity is) while allowing items to exist at any phase. Users use what applies — a research project may stop at vision; a full build goes to release.

### Things — What Users Work With (at every phase)

1. What they're **thinking about** — ideas, brainstorms, explorations
2. What they've **decided** — committed positions, rationale, rejected alternatives
3. What they need to **figure out** — open questions, gaps, unknowns
4. What they need to **do** — tasks, plans, specs
5. How those things **relate** — connections between items
6. Where each thing **stands** — status, confidence, what needs attention
7. What's been **produced** — outputs, artifacts, deliverables

### Verbs — What Users Do (at every phase)

| Verb | What it means |
|------|---------------|
| **See** | Visibility into structure, state, and meaning |
| **Change** | Create, evolve, connect, synthesize, mark |
| **Evaluate** | Challenge claims, update confidence, detect staleness, crystallize or kill |
| **Execute** | Direct agents, assign work, monitor progress, collect results |

### Processes — Activities That Produce, Change, or Evaluate

**Universal** (happen everywhere):
- Discovery — Q&A decomposition, exploring unknowns
- Evaluation — pressure testing, counterfactuals, confidence assessment
- Synthesis — distilling multiple sources into consolidated outputs
- Capture — recording knowledge, decisions, rationale

**Phase-associated** (stronger affinity, not exclusive):
- Decomposition → Planning
- Building → Implementation
- Testing → Verification
- Deploying → Release

### Lenses — Orthogonal Dimensions

| Lens | What it shows |
|------|---------------|
| **Confidence** | How sure we are (untested → low → moderate → high) |
| **Governance** | The 3-mode dial (gate / flag / skip) — inherits downward |
| **Scope** | Granularity (project → feature → task → subtask) |
| **Actor** | Who (human, AI agent, background sub-agent) |
| **Time** | When created, changed, superseded |

---

## Product Surface

Compose has three interfaces that work together:

```
┌──────────────────────────────────────────────────┐
│                  Web UI (compose start)           │
│  ┌──────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ Terminal  │  │ Vision       │  │ Canvas     │  │
│  │ (agent)   │  │ Surface      │  │ (docs)     │  │
│  │           │  │ (7 views)    │  │            │  │
│  │ write     │  │ read         │  │ read/write │  │
│  └──────────┘  └──────────────┘  └────────────┘  │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│                  CLI (compose build)              │
│  Headless lifecycle runner — no UI required       │
│  Same pipeline, same gates, same artifacts        │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│                  MCP Server                       │
│  12 tools — any MCP client can query/mutate state │
└──────────────────────────────────────────────────┘
```

---

## Feature Inventory

### A. Project Bootstrap

| Feature | Intent | Status |
|---------|--------|--------|
| **`compose init`** | Initialize any repo as a Compose project. Detects capabilities (Stratum, agents), writes `.compose/compose.json` manifest, configures paths. | COMPLETE |
| **`compose setup`** | Global installation: register MCP servers, install skills into Claude Code and Codex, configure hooks. | COMPLETE |
| **Interactive questionnaire** | On first `compose new` or `compose build`, ask project questions (type, language, scope, review preference). Persist answers to `.compose/questionnaire.json`. | COMPLETE |
| **Agent detection** | Auto-detect installed agents (Claude Code, Codex, Gemini) and configure connectors. | COMPLETE |
| **Stratum graceful degradation** | When `stratum-mcp` is not installed, all Stratum calls soft-fail. Compose works without Stratum as a flat prompt chain. | COMPLETE |

---

### B. Vision Surface — See Everything

The visual dashboard. Seven views of the same data, updated in real time via WebSocket.

| View | What it shows | Status |
|------|---------------|--------|
| **Roadmap** | Hierarchical view of initiatives → features → tasks with status indicators and progress rollup | COMPLETE |
| **List** | Flat sortable/filterable table of all items | COMPLETE |
| **Board** | Kanban-style columns by status (planned → in_progress → review → complete) | COMPLETE |
| **Tree** | Nested tree view showing parent/child hierarchy | COMPLETE |
| **Graph** | Visual dependency graph showing blocks/informs/supports/implements/contradicts connections | COMPLETE |
| **Docs** | Document browser linked to `docs/features/` folders | COMPLETE |
| **Attention** | Priority queue: what needs human attention now (pending gates, flagged items, stalled work) | COMPLETE |

**Data model:**

| Entity | Properties |
|--------|------------|
| **Item** | id, name, description, type (idea/decision/question/task/spec/artifact/evaluation/thread), status (planned/in_progress/review/complete/blocked/parked/killed), phase, confidence (0-3), labels, acceptance criteria, evidence log, scope boundaries |
| **Connection** | source, target, type (blocks/informs/supports/implements/contradicts/produces/consumes/supersedes) |

**Real-time sync:** All state changes broadcast via WebSocket to all connected clients. File watcher detects artifact changes on disk. Sub-second latency.

**Persistence:** `data/vision-state.json` — file-based, atomic writes, reload on restart.

---

### C. Agent Awareness — Observe Without Watching

Compose observes what agents are doing without the human watching the terminal.

| Feature | Intent | Status |
|---------|--------|--------|
| **Activity hooks** | Tool-use events from Claude Code POSTed to `/api/agent/activity` | COMPLETE |
| **File-path resolution** | Map tool events (Read, Write, Edit) to tracker items via scope boundaries | COMPLETE |
| **Auto-status promotion** | Write/Edit on a `planned` item → automatically promote to `in_progress` | COMPLETE |
| **Error detection** | Pattern-match tool responses for errors, broadcast `agentError` events | COMPLETE |
| **Activity feed** | Live sidebar stream of tool-use events with category pills (read/write/test/error) | COMPLETE |

---

### D. Session Management — Track Who's Doing What

| Feature | Intent | Status |
|---------|--------|--------|
| **Session lifecycle** | Start/end sessions with source (claude/codex/human), reason, transcript path | COMPLETE |
| **Per-item accumulator** | Track reads, writes, first/last touched per item per session | COMPLETE |
| **Work block detection** | Group tool events by resolved item set into coherent work blocks | COMPLETE |
| **Block classification** | Classify blocks as building / debugging / testing / exploring / thinking | COMPLETE |
| **Haiku summarization** | Background LLM generates 1-line summaries of significant events | COMPLETE |
| **Session persistence** | Append-only `data/sessions.json`, reload last session on startup | COMPLETE |
| **Session-feature binding** | One-shot immutable binding of session to feature + phase. Phase tracked at bind and end. | COMPLETE |
| **Context briefing** | On session start, inject: assigned work, acceptance criteria, scope, what others are doing | COMPLETE |

---

### E. Lifecycle Engine — The Process Layer

Seven layers (L0–L6) that enforce the feature development lifecycle.

#### L0: User Preferences

Configurable settings that govern all other layers.

| Feature | Intent | Status |
|---------|--------|--------|
| **Settings store** | `data/settings.json` with REST API (`GET/PATCH /api/settings`, `POST /api/settings/reset`) | COMPLETE |
| **Settings panel** | Sidebar UI for editing preferences | COMPLETE |
| **Policy defaults** | Settings provide middle-tier defaults for gate/flag/skip modes | COMPLETE |
| **WebSocket broadcast** | Setting changes broadcast to all clients | COMPLETE |

#### L1: Feature Lifecycle State Machine

The phase contract that governs how features move through the pipeline.

| Feature | Intent | Status |
|---------|--------|--------|
| **Lifecycle contract** | `contracts/lifecycle.json` — single source of truth for phases, transitions, validation | COMPLETE |
| **Phase tracking** | `currentPhase` + `phaseHistory` on every feature item | COMPLETE |
| **Forward-only transitions** | Phases advance forward; revision loops back to blueprint only | COMPLETE |
| **Lifecycle constants** | `lifecycle-constants.js` derives all exports from contract | COMPLETE |
| **Contract parity tests** | 28 tests verifying code matches contract | COMPLETE |

#### L2: Artifact Awareness

The system knows what artifacts exist and what's missing.

| Feature | Intent | Status |
|---------|--------|--------|
| **Artifact detection** | Scan `docs/features/<CODE>/` for design.md, blueprint.md, plan.md, report.md | COMPLETE |
| **Schema-based assessment** | Section completeness, word count, structural quality signals | COMPLETE |
| **Phase-appropriate templates** | Generate starter templates per artifact type | COMPLETE |
| **Artifact ↔ item linking** | Artifacts linked to tracker items via feature code | COMPLETE |
| **Scaffold MCP tool** | `scaffold_feature` creates folder + stub design.md | COMPLETE |
| **Assess MCP tool** | `assess_feature_artifacts` returns artifact completeness summary | COMPLETE |

#### L3: Policy Enforcement

The 3-mode dial made real.

| Feature | Intent | Status |
|---------|--------|--------|
| **Gate/flag/skip modes** | Per-phase configurable enforcement level | COMPLETE |
| **Policy inheritance** | Parent item policies cascade to children with override at any level | COMPLETE |
| **Gate creation** | Automatic gate creation on phase transition attempts | COMPLETE |
| **Policy defaults** | Hardcoded defaults, overrideable by L0 settings, then per-item | COMPLETE |
| **Audit trail** | All gate decisions (approve/revise/kill) recorded with timestamp and actor | COMPLETE |

#### L4: Gate UI

Human review interface for policy gates.

| Feature | Intent | Status |
|---------|--------|--------|
| **Gate queue view** | Sidebar showing all pending gates with artifact context | COMPLETE |
| **Three actions** | Approve (proceed), Revise (loop back with feedback), Kill (terminate with reason) | COMPLETE |
| **Toast notifications** | Real-time notification when a gate is created | COMPLETE |
| **Gate history** | Full record of gate decisions per feature | COMPLETE |
| **Artifact context** | Gate rows show the artifact being gated with assessment summary | COMPLETE |

#### L5: Session-Lifecycle Binding

Sessions know which feature and phase they serve.

| Feature | Intent | Status |
|---------|--------|--------|
| **Feature binding** | Session bound to a feature code at start — immutable | COMPLETE |
| **Phase tracking** | `phaseAtBind` and `phaseAtEnd` recorded per session | COMPLETE |
| **Transcript filing** | Session transcripts auto-filed under feature folder | COMPLETE |
| **Feature-grouped activity** | Activity feed filterable by feature | COMPLETE |

#### L6: Iteration Orchestration

Autonomous retry loops with server-side enforcement.

| Feature | Intent | Status |
|---------|--------|--------|
| **Review loops** | Codex reviews code; Claude fixes; loop until `clean: true`. Max 10 iterations. | COMPLETE |
| **Coverage sweeps** | Test runner identifies gaps; agent writes tests; loop until passing. Max 15 iterations. | COMPLETE |
| **Server-side enforcement** | Compose enforces max iterations — agents cannot self-report done without Compose confirming | COMPLETE |
| **Structured exit signals** | Loops exit on JSON contracts (`ReviewResult`, `TestResult`), not text parsing | COMPLETE |

---

### F. Agent Connectors — Direct Multiple Models

| Feature | Intent | Status |
|---------|--------|--------|
| **AgentConnector base class** | Abstract interface: `run(prompt, options)` → structured result | COMPLETE |
| **ClaudeSDKConnector** | Claude Code via `@anthropic-ai/claude-code` SDK. Agentic (full tool loop). | COMPLETE |
| **CodexConnector** | OpenAI Codex CLI. Agentic. | COMPLETE |
| **`agent_run` MCP tool** | Stdio MCP transport: routes `agent_run(type, task)` to configured connector | COMPLETE |
| **Schema injection** | Agent connectors inject output contract as JSON code block in system prompt | COMPLETE |
| **Event normalization** | `_normalizeAll()` unpacks nested SDK event structures into flat tool-use events | COMPLETE |

---

### G. Build Pipeline — The Feature Lifecycle

The core product workflow. Takes a feature from intent to shipped code.

#### Product Kickoff: `compose new "intent"`

```
research (claude) → brainstorm (claude) → [human gate]
  → roadmap (claude) → [human gate] → scaffold (claude)
```

Interactive product kickoff. Asks questions one-at-a-time, researches prior art with parallel explorer agents, writes brainstorm doc, structures roadmap, scaffolds feature folders.

**Status:** COMPLETE

#### Feature Build: `compose build CODE`

A 21-step pipeline defined in `pipelines/build.stratum.yaml`:

```
Phase 1: Design
  explore_design (claude) → design_review (codex) → [design gate]
  → prd (claude) → prd_review (codex) → [prd gate]
  → architecture (claude) → architecture_review (codex) → [architecture gate]

Phase 2: Blueprint
  blueprint (claude) → verification (claude) → blueprint_review (codex)

Phase 3: Implement
  plan (claude) → plan_review (codex) → [plan gate]
  → execute (claude) → review loop (codex↔claude, max 10) → coverage sweep (max 15)

Phase 4: Ship
  report (claude) → report_review (codex) → [report gate]
  → docs (claude) → ship (claude) → [ship gate]
```

**Key properties:**
- Every phase has a human gate — can be set to gate/flag/skip
- Review is always cross-agent: Claude writes, Codex reviews
- Postconditions (`ensure:`) are machine-checked after every step
- Failed postconditions trigger automatic retry with feedback
- Cross-agent recovery: when Codex review fails, Claude is dispatched to fix
- Full audit trace via `stratum_audit`

**Partial execution:** `compose build CODE --through design` stops after Phase 1 gate.

**Output contracts:**
- `PhaseResult`: `{ phase, artifact, outcome: complete|skipped|failed, summary }`
- `ReviewResult`: `{ clean: boolean, summary, findings: [] }`
- `TestResult`: `{ passing: boolean, summary, failures: [] }`

**Status:** COMPLETE (proven via STRAT-COMP-3 proof run — 347 tests, 0 failures)

#### Pipeline Management: `compose pipeline`

| Subcommand | What it does | Status |
|------------|-------------|--------|
| `show` | Display pipeline steps with agents, modes, retries, gates | COMPLETE |
| `set` | Change step agent, mode, or retry count | COMPLETE |
| `add` | Insert new step with automatic dependency rewiring | COMPLETE |
| `remove` | Delete step with dependency rewiring | COMPLETE |
| `enable/disable` | Toggle step execution via `skip_if` | COMPLETE |

#### Multi-Feature Build: `compose build --all`

Build multiple features respecting dependency order. DAG resolution ensures features are built in correct sequence.

**Status:** COMPLETE

---

### H. Stratum Integration — The Execution Engine

Compose delegates process execution to Stratum, a separate workflow engine.

| Feature | Intent | Status |
|---------|--------|--------|
| **Stratum IR v0.2** | YAML workflow specs with typed inputs, inline steps, agent assignment, `ensure:` postconditions, `on_fail:`/`next:` routing, `flow:` composition | COMPLETE |
| **Stratum executor** | State model (StepRecord, FlowState), agent passthrough, audit infrastructure | COMPLETE |
| **Gates and policy** | `mode: gate\|flag\|skip` per step, `stratum_skip_step` tool | COMPLETE |
| **Loops and rounds** | Round tracking, `max_rounds`, per-step iteration with exit criteria | COMPLETE |
| **Routing and composition** | `on_fail:`/`next:` step routing, `flow:` sub-workflow execution | COMPLETE |
| **Stratum sync** | Poll `~/.stratum/flows/`, sync flow status → Vision Surface item status | COMPLETE |
| **Audit trail** | `stratum_audit` produces full execution trace — steps, retries, gate decisions, timing | COMPLETE |

---

### I. MCP Server — Programmatic Access

12 tools exposed via MCP (Model Context Protocol) for any MCP-compatible client:

| Tool | What it does |
|------|-------------|
| `get_vision_items` | Query items by phase, status, type, keyword |
| `get_item_detail` | Full item with connections and lifecycle |
| `get_phase_summary` | Status/type distribution per phase |
| `get_blocked_items` | Items blocked by unresolved dependencies |
| `get_current_session` | Active session context |
| `bind_session` | Bind agent session to feature |
| `get_feature_lifecycle` | Phase history, artifacts, gate decisions |
| `scaffold_feature` | Create feature folder with stub design.md |
| `assess_feature_artifacts` | Artifact completeness summary |
| `approve_gate` | Resolve a pending gate (approve/revise/kill) |
| `get_pending_gates` | All gates awaiting human decision |
| `kill_feature` / `complete_feature` | Terminal status transitions |

---

### J. CLI Surface

| Command | What it does | Status |
|---------|-------------|--------|
| `compose init` | Initialize project — manifest, capabilities, paths | COMPLETE |
| `compose setup` | Global install — MCP, skills, hooks | COMPLETE |
| `compose new "intent"` | Interactive product kickoff → brainstorm → roadmap → scaffold | COMPLETE |
| `compose import` | Scan existing project → analysis doc → suggested roadmap | COMPLETE |
| `compose feature CODE "desc"` | Add single feature to roadmap + scaffold folder | COMPLETE |
| `compose build CODE` | Run full lifecycle (design → ship) or partial (`--through phase`) | COMPLETE |
| `compose build --all` | Multi-feature build with dependency ordering | COMPLETE |
| `compose pipeline show\|set\|add\|remove\|enable\|disable` | View and edit pipeline configuration | COMPLETE |
| `compose roadmap` | Status overview with next-buildable recommendations | COMPLETE |
| `compose start` | Launch web UI server (terminal + Vision Surface + canvas) | COMPLETE |

---

## Planned Features

### Milestone 4: Unified Interface (STRAT-COMP-4 through STRAT-COMP-8)

**Intent:** CLI and web UI share execution context. Builds running in the terminal are visible and controllable from the web app.

| # | Feature | Intent |
|---|---------|--------|
| 47 | **Vision store unification** | Reconcile `VisionWriter` (CLI) and `VisionStore` (server) — format mismatch, race-free shared access. Core issue: server's long-lived in-memory state can overwrite newer CLI changes. |
| 48 | **Build visibility** | Server watches `.compose/` and `active-build.json`. Build state broadcast via WebSocket. |
| 49 | **Web gate resolution** | When `compose start` is running, gates resolve through the web UI (Gate View) instead of CLI readline. CLI falls back when server not running. |
| 50 | **Agent stream bridge** | CLI writes tool_use events to `.compose/build-stream.jsonl`. Server watches and pipes to AgentStream SSE. |
| 51 | **Active build dashboard** | Web UI shows current build state: active step, retries, violations, audit trail — from `active-build.json` with live updates. |

**Gate:** `compose start` + `compose build` run simultaneously. Build progress, agent activity, and gates are all visible and actionable in the web UI.

---

### Milestone 5: Model Benchmark Suite (STRAT-COMP-9)

**Intent:** Systematic evaluation of how well different LLMs perform on Compose/Stratum workflows. Answers: which model follows pipelines best, produces the best artifacts, respects gates, and recovers from failures — at what cost?

| # | Feature | Intent |
|---|---------|--------|
| 52 | **Seed repo** | ~2k LOC task management API (Express + SQLite + vanilla frontend) with tests and a planted race condition bug. Pre-initialized `.compose/`. |
| 53 | **Feature specs** | 5 canonical requests: OAuth auth (hard), repo refactor (medium), WebSocket notifications (hard), race condition fix (medium), CSV export (easy). Each with machine-checkable acceptance criteria. |
| 54 | **Benchmark harness** | Git worktree isolation per run, connector config per model, run orchestration, result collection. |
| 55 | **Scoring system** | Hybrid: automated (6 axes from Stratum audit trace) + judge model (5 qualitative axes). Composite score + cost efficiency ratio. |
| 56 | **`compose bench` CLI** | `run` (execute benchmark), `report` (generate comparison), `compare` (side-by-side models). |

**Scoring axes:**

Automated (from audit trace):
- Pipeline fidelity — did it follow the YAML steps?
- Gate compliance — did it stop at gates?
- Postcondition pass rate — first-try success
- Retry efficiency — minimal wasted retries
- Budget compliance — under token budget
- Test pass rate — code actually works

Judge (LLM evaluates artifacts):
- Design coherence — does design match implementation?
- Artifact quality — useful to a human engineer?
- Code quality — clean, idiomatic, no dead code
- Over-engineering penalty — did it add unnecessary complexity?
- Recovery quality — targeted fixes vs. shotgun approach

**Gate:** `compose bench run --model X --feature Y` produces `scores.json`. 3+ models benchmarked. Judge stddev < 2.

---

## PRD Feature Areas (Long-Term Vision)

These are the full product vision features from the PRD. Items above represent what's built or actively planned. The following captures the remaining PRD scope:

### Work Hierarchy (partially built)

- [x] Arbitrary-depth nesting of work items
- [x] Work item properties (name, status, labels, acceptance criteria, evidence)
- [x] Dependencies (blocks, informs, supports, implements, contradicts)
- [x] Connection graph with 5 relationship types
- [ ] Scope boundaries (files/directories in-scope per item) — data model exists, enforcement planned
- [ ] Evidence collection (git commits, test results linked to items) — session tracking captures tool events, formal evidence linking not yet built

### Policy System (built, enforcement partial)

- [x] 3-mode dial (gate/flag/skip)
- [x] Policy inheritance through hierarchy
- [x] Start and completion gates
- [x] Policy configuration at any level
- [ ] Scope enforcement (flag/block when agent touches out-of-scope files)
- [ ] Budget enforcement (token/time/file-change limits)
- [ ] Decomposition gates (approval for sub-item creation)
- [ ] Assignment gates (approval for session claiming work)

### Decomposition Workflow (partially built)

- [x] Human-created work items at any level
- [x] AI-proposed decomposition via `compose new` brainstorm → roadmap
- [x] Pipeline decomposition: `compose build` breaks features into design → blueprint → plan → implement
- [ ] Ad-hoc decomposition: select an item in the UI and request AI breakdown
- [ ] Iterative refinement: decompose mid-flight when a task proves complex

### Evidence and Verification (partially built)

- [x] Acceptance criteria on work items
- [x] Machine-checkable postconditions via Stratum `ensure:`
- [x] Automated test verification in coverage sweep
- [ ] Evidence linking (git commits → acceptance criteria)
- [ ] Formal verification workflow (review → machine-check → human-check → complete)

### Multi-Project Support (not started)

- [ ] Project registry (multiple repos in one Compose instance)
- [ ] Cross-project work items
- [ ] Cross-project dependency graph
- [ ] Cross-project visibility in dashboard

### Connectors (partially built)

**Agent connectors:**
- [x] Claude Code (ClaudeSDKConnector — agentic, full tool loop)
- [x] Codex (CodexConnector — agentic)
- [ ] Gemini (detected but no connector)
- [ ] Cursor (context file generation)
- [ ] Devin (task assignment via API)

**External system connectors:**
- [ ] GitHub Issues/Projects (bidirectional sync)
- [ ] Linear (bidirectional sync)
- [ ] JIRA (bidirectional sync)
- [ ] Markdown files in git (built-in default — effectively done via `.compose/`)

---

## Dogfooding Milestones

| Milestone | Description | Status |
|-----------|-------------|--------|
| **D0: Bootstrap** | Compose built manually, out-of-band | COMPLETE |
| **D1: Visible** | Compose tracks its own development in the Vision Surface | COMPLETE |
| **D2: Self-hosting** | Planning sessions for Compose happen inside Compose | PARTIAL |
| **D3: Enforced** | Phase transitions on Compose features gated through Compose's policy runtime | PARTIAL |
| **D4: Multi-agent** | A feature built end-to-end using multiple agents dispatched by Compose | PLANNED |

---

## Architecture Summary

```
┌─────────────────────────────────────────────────────────────────┐
│                          Interfaces                             │
│  ┌──────────┐  ┌──────────────┐  ┌──────────┐  ┌────────────┐  │
│  │  CLI     │  │  Web UI      │  │ MCP      │  │ Skill      │  │
│  │ compose  │  │ compose      │  │ Server   │  │ /compose   │  │
│  │ build    │  │ start        │  │ 12 tools │  │ in Claude  │  │
│  └────┬─────┘  └──────┬───────┘  └────┬─────┘  └─────┬──────┘  │
│       │               │               │              │          │
│  ─────┼───────────────┼───────────────┼──────────────┼────────  │
│       ▼               ▼               ▼              ▼          │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Lifecycle Engine                       │   │
│  │  L0 Settings │ L1 State Machine │ L2 Artifacts           │   │
│  │  L3 Policy   │ L4 Gates         │ L5 Sessions            │   │
│  │  L6 Iteration Orchestration                               │   │
│  └────────────────────────┬─────────────────────────────────┘   │
│                           │                                     │
│  ─────────────────────────┼───────────────────────────────────  │
│                           ▼                                     │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Execution Layer                        │   │
│  │  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐   │   │
│  │  │ Stratum     │  │ Agent        │  │ Vision         │   │   │
│  │  │ Engine      │  │ Connectors   │  │ Surface        │   │   │
│  │  │ (process)   │  │ (dispatch)   │  │ (visibility)   │   │   │
│  │  └─────────────┘  └──────────────┘  └────────────────┘   │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Persistence                            │   │
│  │  .compose/compose.json │ data/vision-state.json           │   │
│  │  data/sessions.json    │ data/settings.json               │   │
│  │  active-build.json     │ docs/features/*/                 │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Key File Paths

| Path | What it is |
|------|-----------|
| `bin/compose.js` | CLI entry point — all commands |
| `pipelines/build.stratum.yaml` | 21-step feature build pipeline |
| `pipelines/new.stratum.yaml` | 6-step product kickoff pipeline |
| `contracts/lifecycle.json` | Phase transition rules (source of truth) |
| `.compose/compose.json` | Project manifest (capabilities, paths) |
| `data/vision-state.json` | Vision Surface state (all items + connections) |
| `data/sessions.json` | Session history |
| `data/settings.json` | User preferences |
| `server/` | Web UI server (Express + WebSocket) |
| `lib/` | CLI libraries (build, new, pipeline, gates, validation) |
| `src/` | React frontend (Vision Surface, Terminal, Canvas) |
| `.claude/skills/compose/SKILL.md` | Compose skill for Claude Code |
| `docs/features/` | 34 feature folders with design/blueprint/plan/report docs |
| `docs/PRD.md` | Full product requirements document |
| `docs/requirements/` | Core requirements (CR1-CR7), scope, needs, matrices |
| `docs/decisions/` | 5 architectural decision records |

---

## Success Criteria (from PRD)

| Metric | Target |
|--------|--------|
| **Orientation time** | Starting a new agent session takes <30 seconds (claim work → get briefing → start) |
| **Big picture clarity** | Opening the dashboard answers "where are we" in <10 seconds |
| **Parallel safety** | Multiple agent sessions never conflict or duplicate work |
| **Policy compliance** | Agents stay within defined boundaries >95% of the time |
| **Self-hosting** | Compose manages its own development (D2+) |

---

## Target User

**Primary:** Solo developer working with AI agents. Knows what to build, wants the process on rails.

**Secondary:** Founder/PM who shifts between strategic thinking and hands-on building. Same person, different depth — "developer mode" vs "product mode."

**Not for (v1):** Large teams, enterprise workflows, non-technical users.

---

## What Compose Is NOT

- Not a task tracker (though it tracks work)
- Not a chat wrapper (though it involves conversation)
- Not an IDE (though it embeds terminals and agents)
- Not a project management tool (though it manages projects)

It's the structured process between "I want X" and "X is built correctly" — executed by AI agents, governed by humans, visible in real time.
