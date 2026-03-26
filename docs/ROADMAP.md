# Compose Roadmap

**Project:** Compose — structured implementation pipeline for AI-driven development
**Last updated:** 2026-03-19

## Related Documents

- [Lifecycle Engine Roadmap](plans/2026-02-15-lifecycle-engine-roadmap.md) — Phase 6 layer detail
- [Architecture Foundation Plan](plans/2026-02-26-architecture-foundation-plan.md) — Phase 4.5 step-by-step plan
- [Agent Connectors Design](features/agent-connectors/design.md) — Phase 4.5 design decisions
- [Original Integration Roadmap](plans/2026-02-11-integration-roadmap.md) — **SUPERSEDED** — preserved for history

---

## Phase 1: Foundation — COMPLETE

Bootstrap: receive and adapt the Base44 UI, achieve first self-hosting milestone.

| # | Item | Status |
|---|------|--------|
| 1 | Receive and evaluate Base44 UI code | COMPLETE |
| 2 | Terminal embed + first boot — crash resilience, supervisor, tmux session persistence | COMPLETE |
| 3 | Discovery Level 2 — vision crystallized, ontology explored, feature map complete | COMPLETE |
| 4 | Core Requirements — Composition model (CR1-CR7), 8 decisions approved | COMPLETE |

---

## Phase 2: Vision Surface — COMPLETE

Five live views, WebSocket updates, drill-down navigation, pressure testing, theme system.

| # | Item | Status |
|---|------|--------|
| 5 | Vision Surface — 5 views (roadmap, list, board, tree, graph), WebSocket live updates | COMPLETE |
| 6 | Roadmap drill-down — explorer breadcrumbs, initiative summaries, status chips, AI insight | COMPLETE |
| 7 | Pressure test system — agent spawn, question workflow, discuss/resolve/dismiss | COMPLETE |
| 8 | Product ontology graph — 10 entity types, 6-phase pipeline visualization | COMPLETE |
| 9 | Theme system — light/dark, CSS tokens, terminal sync | COMPLETE |
| 10 | CLI tooling — vision-track.mjs (create/update/search/connect) | COMPLETE |

---

## Phase 3: Agent Awareness — COMPLETE

Real-time visibility into what the agent is doing, errors it hits, and session lifecycle.

| # | Item | Status |
|---|------|--------|
| 11 | Agent status detection — OSC title parsing, working/idle indicator | COMPLETE |
| 12 | Activity classification — tool tracking, thinking vs executing vs waiting (7 categories) | COMPLETE |
| 13 | Error/outcome detection — pattern-match failures, surface in UI | COMPLETE |
| 14 | Session tracking — start/stop detection, Haiku summaries, auto-journaling hooks | COMPLETE |

---

## Phase 4: Integration & UI Extensions — PARKED

Independent enhancements. No downstream phases depend on these. Parked in favor of
Phase 6.5/6.8/7 which are on the critical path.

| Code | Item | Status |
|------|------|--------|
| COMP-GIT-1 | Git/file connector — link work items to code changes, diff awareness | PARKED |
| COMP-GIT-2 | File checkpoint/rewind — snapshot affected files before agent changes; rewind surface in UI *(inspired by Damocles)* | PARKED |
| COMP-UI-7 | Tab popout — dockable/undockable tabs to separate monitors *(UI extension)* | PARKED |
| COMP-VIS-1 | Live agent communication graph — animated packet flow on GraphView edges when agents message each other in real time; topology overlay showing active relays, message direction, and throughput *(inspired by Meridian)* | PLANNED |
| — | Persistence evolution — event-sourced, markdown generation from tracker | **SUPERSEDED** — Base44 dependency already cut; flat JSON store sufficient for current scale |
| — | Agent connector (read-write) — direct sessions from Compose | **SUPERSEDED by Phase 4.5** |

---

## Phase 4.5: Architecture Foundation — COMPLETE

**Scope boundary:** Delivers the connector *infrastructure* — class hierarchy, MCP tools, Stratum
harness. This is the engineering substrate. Phase 7 builds on this to make the lifecycle itself
agent-agnostic (swap Claude Code for Codex end-to-end). Phase 4.5 wires two specific connectors;
Phase 7 defines the protocol that makes connectors interchangeable.

Deliver the agent connector layer (ClaudeSDKConnector + CodexConnector as MCP tools) with
Stratum as the process harness. No new UI surface. Clean server modularization. Verified end-to-end.

See: [Architecture Foundation Plan](plans/2026-02-26-architecture-foundation-plan.md) for acceptance criteria on all 8 steps.

| # | Item | Status |
|---|------|--------|
| 18a | Architecture alignment — connector class hierarchy, delete codex-server.js, reshape connectors | COMPLETE |
| 18b | Integration surface stabilization — agent-mcp.js, `agent_run` MCP tool with `type` parameter (codex, claude, etc.), .mcp.json. **Acceptance:** `/compose` Phase 7 step 3 calls `agent_run(type="codex")` as default reviewer (Opus executes, Codex reviews) | COMPLETE |
| 18c | Stratum externalization — pipelines/ directory, review-fix.stratum.yaml, end-to-end run | COMPLETE |
| 18d | UI decoupling — verify zero new UI surface; VisionServer SSE stays sole UI channel | COMPLETE |
| 18e | Server modularization — split server/ into domain modules, single responsibility per file | COMPLETE |
| 18f | Test + observability hardening — golden flow tests for both MCP tools, Stratum audit trace | COMPLETE — unit tests (13) + agent-mcp golden flow tests (6) + live smoke tests pass |
| 18g | Cutover + cleanup — remove openai dep, dead code, dangling imports | COMPLETE |
| 18h | Acceptance gate — both tools callable; Stratum pipeline completes on a real feature | COMPLETE — review-fix pipeline ran end-to-end (claude execute → codex review → clean), audit trace written |

---

## Phase 5: Standalone — PLANNED

Compose as an installable tool: LaunchAgent, version-aware restart, CLI + npm distribution.

| Code | Item | Status |
|------|------|--------|
| COMP-DIST-1 | Standalone app — LaunchAgent, version-aware restart, CLI + npm distribution | PLANNED |

---

## Phase 5.5: Skill Architecture Upgrade — COMPLETE

**Note on ordering:** Phase 5.5 completed before Phase 5 because it was a skill-layer concern
(agent definitions, review protocol) with no dependency on the standalone app. Half-phases are
parallel tracks that surface when significant work fits between two sequential phases. Completion
of 5.5 does not imply completion of 5; 19a (skill arch) and 19 (standalone) are independent.

| # | Item | Status |
|---|------|--------|
| 19a | Agent-based skill architecture — compose-explorer, compose-architect, compose-reviewer agents; competing architecture proposals; confidence-scored review; rename feature-dev → compose | COMPLETE |

---

## Phase 6: Lifecycle Engine — COMPLETE

The `/compose` skill becomes the product. Seven layers from user preferences through iteration
orchestration. See: [Lifecycle Engine Roadmap](plans/2026-02-15-lifecycle-engine-roadmap.md).

| # | Item | Status |
|---|------|--------|
| 20 | User preferences inventory — config surface for feature toggles, policy defaults, agent settings | COMPLETE |
| 21 | Feature lifecycle state machine — explicit phase tracking per feature, event-driven transitions | COMPLETE |
| 22 | Artifact awareness — feature folder management, presence detection, templates, quality signals | COMPLETE |
| 23 | Policy enforcement runtime — gate/flag/skip dials as structural enforcement, not prose | COMPLETE — evaluatePolicy + build.js integration, settings-driven per-phase modes |
| 24 | Gate UI — interactive approve/revise/kill in Vision Surface, gate queue, trade-offs display | COMPLETE — GateView with policyMode badges, full history, revision feedback, multi-channel (bar/toast/ops/palette) |
| 25 | Session-lifecycle binding — sessions tagged to features and phases, contextualized activity | COMPLETE |
| 25a | Subagent activity nesting — hierarchical view of parallel compose agents in Vision Surface; each compose-explorer/architect instance visible as a child of the parent phase *(inspired by Damocles)* | COMPLETE — AgentRegistry + AgentPanel subagents section, persistent tracking, WebSocket events |
| 26 | Iteration orchestration — ralph loops as Compose primitive, completion promise monitoring, exit criteria enforcement | COMPLETE — 3 MCP tools, server-side exit criteria evaluation, max iteration enforcement, WS broadcasts |

---

## Phase 6.5: Pipeline Authoring Loop — PLANNED

**Note on ordering:** Phase 6.5 is a parallel track on the stratum-compose integration — the
closed loop between the embedded agent, the pipeline editor UI, and stratum execution. Independent
of Phase 6's lifecycle state machine work; both can progress simultaneously.

Close the loop between agent and UI so users can design, review, and execute pipelines without
leaving compose. Agent drafts → UI surfaces → user approves → stratum executes.

| Code | Item | Status |
|------|------|--------|
| COMP-PIPE-1 | Pipeline template library — predefined `.stratum.yaml` templates (feature dev, bug fix, refactor, content, research) selectable by agent or user | PLANNED |
| COMP-PIPE-2 | `stratum_draft_pipeline` MCP tool — agent pushes a drafted spec into the PipelineEditor UI; user can review and tweak before execution begins | PLANNED |
| COMP-PIPE-3 | PipelineEditor live refresh — poll or WebSocket so UI updates when agent calls `stratum_draft_pipeline` without requiring manual reload | PLANNED |

---

## Phase 6.8: Cross-Session Memory Layer — PLANNED

**Note on ordering:** SmartMemory (`/reg/my/SmartMemory`) is already registered as an MCP server
in compose's `.mcp.json` and session hooks (start/stop) already push episodic memories to it.
Phase 6.8 formalizes it as the canonical cross-session memory layer and closes the loop so the
agent actively consults memory at the start of each feature rather than treating it as ambient
background.

**SmartMemory fit:** lite mode (SQLite + usearch, no Docker) runs embedded. Memory types map
cleanly: `episodic` → session summaries, `decision` → architecture choices, `semantic` → discovered
patterns, `code` → indexed entities from blueprint research.

**The key idea from Damocles:** pull-first catalog. Rather than injecting all memories into every
prompt, the agent receives a compact ranked catalog at feature start and retrieves full details on
demand. This keeps context bounded regardless of conversation history length.

**Implementation split:** SmartMemory owns the pull-first catalog tool (in progress). Compose
wires it in at skill entry — item 32 is integration work only, not a build.

| Code | Item | Status |
|------|------|--------|
| COMP-MEM-1 | Memory catalog integration — wire SmartMemory's native pull-first catalog tool into compose skill entry; SmartMemory owns the implementation, compose calls it *(blocked on SmartMemory pull-first landing)* | PLANNED |
| COMP-MEM-2 | Feature-scoped memory ingestion — after each gate approval, ingest phase artifact (design.md, blueprint.md, decisions) into SmartMemory with `feature_id` tag; retrieval scoped to feature or cross-feature | PLANNED |
| COMP-MEM-3 | Compose skill entry integration — `/compose` skill calls `get_memory_catalog` before Phase 1; surfaces relevant prior decisions and patterns from similar past features | PLANNED |

---

## Phase 7: Trusted Pipeline Harness — PLANNED (Post-V1)

**Scope boundary:** Phase 4.5 has CC as orchestrator — it calls `stratum_plan`, runs steps,
and calls `stratum_step_done` with self-reported results. This works but has a trust gap: the
agent reporting postcondition results is the same agent whose work is being evaluated.

Phase 7 moves orchestration out of any agent. A deterministic harness outside CC drives the
pipeline, verifies postconditions independently, and treats all agents (CC, Codex, others) as
workers that receive prompts and return outputs. No agent calls `stratum_step_done` — the
harness does, after verifying ground truth itself (run tests, check files, call a reviewer).

**The shift:**
- Phase 4.5: CC orchestrates, Stratum enforces what CC reports
- Phase 7: Harness orchestrates, Stratum enforces what harness verifies independently

| Code | Item | Status |
|------|------|--------|
| COMP-HARNESS-1 | Pipeline runner — deterministic harness (`server/pipeline-runner.js`) that calls `stratum_plan`, dispatches steps to agent workers via `agent_run`, verifies postconditions independently, calls `stratum_step_done` | PLANNED |
| COMP-HARNESS-2 | Stagnation detection — track environmental delta (files changed, tests passing) across iterations; trigger warning/abort when agent produces high activity but zero progress over an observation window *(inspired by Agent-Harness)* | PLANNED |
| COMP-HARNESS-3 | Effort budget — per-step tool-call budget that depletes with each action; harness halts the step when budget exhausted, preventing unbounded exploration within a single iteration *(inspired by Agent-Harness)* | PLANNED |
| COMP-HARNESS-4 | Independent verification — harness runs tests, checks file existence, and calls a reviewer agent as a separate verification step; no agent self-reports pass/fail | PLANNED |
| COMP-HARNESS-5 | Anti-gaming verification — harness checks environmental delta before accepting structured results; rejects `clean: true` if no files changed since last iteration, rejects `passing: true` if test output unchanged. Persistent quality score across iterations that can go *down* on re-review — wontfix/suppress tactics widen the lenient/strict gap, actual improvement required to move the number *(inspired by Agent-Harness + Desloppify)* | PLANNED |
| COMP-HARNESS-6 | Tamper-evident audit — SHA256 hash-chained JSONL audit trail for all harness decisions; each entry references the hash of the previous entry for non-repudiation *(inspired by Agent-Harness)* | PLANNED |
| COMP-HARNESS-7 | Multi-agent routing — harness selects which connector (`claude`, `codex`, others) to use per step based on step type; executor and reviewer never the same agent | PLANNED |
| COMP-HARNESS-8 | Tiered evaluation — fast-loop evals (cheap per-iteration: did flagged files change? did targeted test pass?) before full gates (expensive: full codex review, full test suite); skip full gate when fast check fails *(inspired by Itera)* | PLANNED |
| COMP-HARNESS-9 | Iteration ledger — per-iteration JSONL log with mistake/fix/prevention rules; enriches iteration history beyond `{ n, result }` so the agent learns within a single review loop; ingested to SmartMemory via COMP-MEM-2 for cross-session learning *(inspired by Itera)* | PLANNED |

---

## Dogfooding Milestones

These milestones use sequential labels (D0–D3) that are independent of roadmap phase numbers.

| Milestone | Description | Status |
|-----------|-------------|--------|
| D0: Bootstrap | Manual, out-of-band. Markdown files and chat transcripts. | COMPLETE |
| D1: Self-tracking | Compose tracks its own work via Vision Surface (114+ items, 136+ connections). | COMPLETE |
| D2: Self-aware | Agent monitoring feeds session activity into the tracker automatically. | ACTIVE |
| D3: Self-directing | Lifecycle engine enforces the compose process structurally. All work happens in Compose. | PLANNED |
