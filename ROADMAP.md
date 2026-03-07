# Compose Roadmap

**Project:** Compose — a lifecycle runtime for AI-assisted feature development.
Compose orchestrates multi-agent workflows via Stratum specs: gates that block, policies that enforce,
iterations that loop across agents, artifacts that are tracked.

**Last updated:** 2026-03-07

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

## STRAT-1: Stratum Process Engine + Compose MVP — IN_PROGRESS

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
| 46 | STRAT-COMP-3 | Proof run: write STRAT-1 spec, execute `compose build STRAT-1` headless, validate (410+ tests, E2E audit trail) | PLANNED |

**Gate:** Compose builds itself using `compose build`. Multi-agent, gated, audited.

**Exit:** `pip install compose` → `compose init` → `compose build`. Compose is a thin layer: lifecycle spec + visibility + agent routing + optional UI.

See `docs/features/STRAT-1/` for full design.

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
