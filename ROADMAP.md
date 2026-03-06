# Compose Roadmap

**Project:** Compose — a lifecycle runtime for AI-assisted feature development.
Compose enforces the `/compose` skill structurally: gates that block, phases that are tracked,
artifacts that are managed, iterations that are orchestrated.

**Last updated:** 2026-03-06

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

## Phase 4.5 Support: Speckit + Stratum Sync — COMPLETE

Infrastructure that landed alongside Phase 4 connector work.

| # | Item | Status |
|---|------|--------|
| — | Speckit: seed tracker from `.specify/` feature folders | COMPLETE |
| — | Stratum sync: poll `~/.stratum/flows/`, sync flow status → item status | COMPLETE |
| — | Stratum bind/audit routes: link flows to items, store audit traces | COMPLETE |
| — | compose-mcp: 5 MCP tools for querying Vision Surface state | COMPLETE |

---

## Phase 5: Standalone App — PARKED

Deferred in favour of Phase 6. Packaging doesn't change what Compose is — the lifecycle engine does.
Revisit once L3 (Policy Enforcement Runtime) is stable.

| # | Item | Status |
|---|------|--------|
| 19 | macOS LaunchAgent: start on login, `KeepAlive: true`, `compose ui install/uninstall` | PARKED |
| 20 | Version-aware restart: detect code updates, show banner, `/api/restart` | PARKED |
| 21 | Suspend/resume watchdog: detect system sleep, restart on wake | PARKED |
| 22 | CLI + package distribution: `npm install -g compose`, pre-built dist, no Vite in production | PARKED |

---

## Phase 6: Lifecycle Engine — IN_PROGRESS

Compose is a workflow spec on top of Stratum. Stratum is the engine — steps, transitions, gates,
retries, ensures. Compose defines the 10-phase lifecycle as a Stratum spec and consumes Stratum
primitives directly rather than building a bespoke lifecycle engine.

### Phase 6 Pre-work: Stratum Refactor — IN_PROGRESS

Stratum must expose the primitives Compose needs before L1 can be built.

| # | Item | Status |
|---|------|--------|
| 19 | Audit Stratum: inventory existing primitives, identify gaps (human gates, skip, revise, round tracking) | IN_PROGRESS |
| 20 | Stratum refactor: add missing primitives, expose hooks for workflow specs like Compose | PLANNED |

### Phase 6 Layers

| # | Layer | Status |
|---|-------|--------|
| 21 | **L0 — User Preferences Inventory:** full preferences system — gate/flag/skip defaults, artifact versioning, agent model, UI prefs. Deferred until L3–L6 reveal what actually needs configuring. | PARKED |
| 22 | **L1 — Feature Lifecycle State Machine:** `contracts/lifecycle.json` (single source of truth); `lifecycle-constants.js` derives all exports; `policy-engine.js` validates against contract; `compose_feature.stratum.yaml` generated from contract with compound steps for revision loops; 28 contract parity tests; `currentPhase` + `phaseHistory` on feature items; centralized state in `vision-state.json`. | COMPLETE |
| 23 | **L2 — Artifact Awareness:** feature folder creation, artifact presence detection, phase-appropriate templates, artifact ↔ tracker item linking. | COMPLETE |
| 24 | **L3 — Policy Enforcement Runtime:** gate/flag/skip dials that structurally block phase transitions. Policy inheritance through work hierarchy. Override at any level. Hardcoded defaults until L0 lands. | COMPLETE |
| 25 | **L4 — Gate UI:** sidebar surface for pending phase transitions — shows artifact, proposed next phase, rationale. Three actions: Approve / Revise / Kill. Gate history. | COMPLETE |
| 26 | **L5 — Session-Lifecycle Binding:** sessions tagged to feature + phase. Activity grouped by feature. Transcripts auto-filed. Handoff context injected automatically. | COMPLETE |
| 27 | **L6 — Iteration Orchestration:** review and coverage loops as Compose primitives. Compose dispatches, monitors for completion promises, enforces exit criteria. Agent cannot self-report done without Compose confirming. | COMPLETE |

**Key architectural decision (2026-03-05):** Compose does not build a lifecycle engine. Stratum is
the engine. Compose is a workflow spec. L1 is a Stratum spec + contract, not a new backend service.
L0 deferred — design it after L3–L6 reveal what actually needs to be configurable.

**L3 is the core new build.** It is the difference between "the skill says gate" and "Compose won't let you proceed without approval."

**Exit:** Compose enforces the `/compose` lifecycle structurally via Stratum. Gates block, policies inherit, iterations are orchestrated, artifacts are managed. The process runs through Compose, not alongside it.

See `docs/plans/2026-02-15-lifecycle-engine-roadmap.md` for full layer detail.

---

## Phase 7: Agent Abstraction — PLANNED (Post-V1)

Agent-agnostic lifecycle. Claude Code, Codex, Gemini run the same pipeline through adapters.

| # | Item | Status |
|---|------|--------|
| 30 | Connector interface: plan, execute, review, iterate capabilities | PLANNED |
| 31 | Claude Code adapter | PLANNED |
| 32 | Codex adapter | PLANNED |
| 33 | Agent capability negotiation: adapt lifecycle when agent lacks a capability | PLANNED |

**Exit:** The feature lifecycle is the same regardless of which agent runs it.

---

## Dogfooding Milestones

| Milestone | Description | Status |
|-----------|-------------|--------|
| D0: Bootstrap | Compose built manually, out-of-band. | COMPLETE |
| D1: Visible | Compose tracks its own development in the Vision Surface. Activity hooks fire during Compose development sessions. | COMPLETE |
| D2: Self-hosting | A planning session for Compose happens entirely inside Compose — inline docs, decisions recorded, items created. | PARTIAL |
| D3: Enforced | Phase transitions on Compose features are gated through Compose's own policy runtime. | PARTIAL |

---

## Key Documents

| Document | What it is |
|---|---|
| `docs/plans/2026-02-15-lifecycle-engine-roadmap.md` | Full Layer 0–7 design, dependency graph, open questions |
| `docs/plans/2026-02-26-architecture-foundation-plan.md` | Phase 4 items 18a–18h detail |
| `docs/plans/2026-03-05-18h-acceptance-gate.md` | Manual acceptance test checklist for Phase 4 gate |
| `docs/plans/2026-03-05-manual-test-guide.md` | Full manual test guide for all 15 system areas |
| `docs/features/feature-dev-v2/design.md` | Feature-dev v2 design — the skill that Phase 6 enforces |
