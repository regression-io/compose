# STRAT-1: Stratum Process Engine Completion

**Date:** 2026-03-07
**Status:** Design
**Related:** [Stratum Audit](../../plans/2026-03-05-stratum-audit.md), [Lifecycle Engine Roadmap](../../plans/2026-02-15-lifecycle-engine-roadmap.md)

## Problem

Compose built a full lifecycle engine (state machine, gates, policy, iterations, reconciliation) because Stratum didn't have the primitives. Now both systems exist, the separation of concerns is wrong, and the primitives aren't reusable.

The stated architecture is: "Stratum is the engine, Compose is the workflow spec." The reality is: Compose is both.

## Goal

Complete Stratum as a general-purpose process engine using Compose's working implementations as the reference spec. Then Compose expresses its lifecycle as a Stratum spec and delegates execution.

After STRAT-1:
- `pip install compose` installs both Compose and Stratum (dependency)
- `compose init` is the single entry point — questionnaire, agent detection, optional UI
- `compose roadmap` decomposes a project into features with specs
- `compose build` executes features through the lifecycle
- The lifecycle is a `.stratum.yaml` spec, not bespoke code

## Separation of Concerns

**Stratum owns the process** — how work gets done:

| Primitive | What it does | Compose reference |
|---|---|---|
| Step execution | Run steps, track state, verify postconditions | Already in Stratum |
| Gates | Suspend until decision, route on outcome | `lifecycle-manager.js:424-497` |
| Policy | Three-level enforcement (gate/flag/skip) | `policy-engine.js` (zero Compose knowledge) |
| Skip | Bypass a step with recorded reason | `lifecycle-manager.js:130-165` |
| Rounds | Track revision cycles, max limits | `lifecycle-manager.js` phaseHistory |
| Iteration loops | Count-tracked retry with exit criteria | `lifecycle-manager.js:218-288` |
| Deferred operations | Freeze intended action, replay on approval | `lifecycle-manager.js` gate operationArgs |
| Pending mutex | One gate per entity at a time | `lifecycle-manager.js:69` pendingGate |
| Reconciliation | Infer state from external signals | `lifecycle-manager.js` reconcile() |
| Audit trail | Full trace per round | `lifecycle-manager.js` policyLog |
| Agent dispatch | Per-step agent assignment | `connectors/` (Claude, Codex) |
| Workflow composition | Sub-workflow invocation via `flow:` | `pipelines/*.stratum.yaml` |

**Compose owns the workspace** — what's going on and where things live:

| Concern | What it does |
|---|---|
| Lifecycle definition | The `.stratum.yaml` spec — Compose's opinion on how features get built |
| Feature folders | `docs/features/<code>/` with `spec.md`, `design.md`, `plan.md` |
| Artifact assessment | Markdown quality checks, section validation |
| Vision Surface | Items, connections, graphs, views |
| Sessions | Working session tracking, feature binding |
| Project config | `.compose/compose.json`, paths, capabilities |
| Agent routing | Which agent is available, skill installation — Compose detects, spec assigns |
| The UI | Terminal, sidebar, canvas, gate approval panel |
| CLI | `compose init`, `compose roadmap`, `compose build`, `compose status` |

## What Stratum Gets (IR v0.2)

### 1. Workflow declaration

A spec can declare itself as a named, invocable workflow — not just an internal flow. This is what makes `compose <name>` work without hardcoding commands.

```yaml
workflow:
  name: build
  description: "Execute feature through full lifecycle"
  input:
    feature: { type: string, required: true }
    skip_prd: { type: boolean, default: false }

steps:
  - id: design
    agent: claude
    intent: "Explore codebase and write design.md for {{input.feature}}."
    # ...
```

- `workflow.name` — the CLI command name (e.g. `compose build`, `compose research`)
- `workflow.description` — shown in `compose --help` and `stratum list`
- `workflow.input` — typed input schema with defaults, validated before execution

Specs without `workflow:` are internal — usable via `flow:` composition but not directly invocable.

**Registry:** Stratum discovers workflow specs from a configurable directory (e.g. `.compose/workflows/`). `stratum list` enumerates all registered workflows with name + description.

**Discovery MCP tool:** `stratum_list_workflows()` — returns registered workflows so the CLI can build its help dynamically.

### 2. Simplified step format

Steps declare intent inline. No separate `functions:` block required.

```yaml
steps:
  - id: design
    agent: claude
    intent: "Explore codebase and write design.md."
    ensure:
      - "file_exists('docs/features/' + input.featureCode + '/design.md')"
    retries: 2

  - id: review
    agent: codex
    intent: "Review implementation against blueprint."
    ensure:
      - "result.clean == true"
    on_fail: fix

  - id: fix
    agent: claude
    intent: "Fix all findings from review."
    inputs:
      findings: "$.steps.review.output.findings"
    next: review
```

- `id` — step name, unique in the flow
- `agent` — which agent executes (claude, codex, gemini, etc.)
- `intent` — what to do (the prompt)
- `ensure` — postconditions (existing)
- `retries` — max retries on ensure failure (existing)
- `on_fail` — route to another step on ensure failure (new — enables cross-agent loops)
- `next` — explicit next step override (new — for loop-back routing)
- `inputs` — data from prior steps (existing)
- `depends_on` — DAG dependencies (existing)

The old `functions:` block is still supported for reusable function definitions, but not required.

### 3. Workflow composition

A step can invoke a sub-workflow instead of running inline:

```yaml
flows:
  review_fix:
    input: { task: string, blueprint: string }
    steps:
      - id: review
        agent: codex
        intent: "Review against blueprint. Return {clean, findings}."
        ensure: "result.clean == true"
        on_fail: fix
      - id: fix
        agent: claude
        intent: "Fix all findings."
        next: review

  compose_feature:
    steps:
      - id: implement
        agent: claude
        intent: "Execute the plan."

      - id: review
        flow: review_fix
        inputs:
          task: "$.steps.implement.output.summary"
          blueprint: "$.input.blueprint"
        depends_on: [implement]
```

`flow:` instead of `agent:` + `intent:` — Stratum creates a sub-execution with its own step graph and audit trail, inheriting the parent's working directory.

Reusable workflows (review-fix, coverage-sweep, security-audit) become a shared library across projects.

### 4. Gate step type

**Reference:** `lifecycle-manager.js` gate subsystem

```yaml
steps:
  - id: design_gate
    mode: gate
    on_approve: blueprint
    on_revise: explore
    on_kill: killed
    timeout: 3600
```

New MCP tool: `stratum_gate_resolve(flow_id, step_id, outcome, rationale, resolved_by)`

The deferred-operation pattern from Compose becomes native: the gate freezes the flow, resolution routes it.

### 5. Policy layer

**Reference:** `policy-engine.js` — directly portable, zero Compose knowledge

```yaml
steps:
  - id: prd
    agent: claude
    intent: "Write PRD."
    policy: gate                  # gate | flag | skip
    policy_fallback: skip         # if no runtime override
```

Resolution (ENG-3): `step.policy ?? "gate"`. `policy_fallback` is parsed and validated
but not evaluated until ENG-6 adds `stratum_set_policy` runtime overrides, at which
point: `runtime_override ?? step.policy ?? step.policy_fallback ?? "gate"`.

`flag` and `skip` both auto-approve and write a PolicyRecord (no GateRecord). They
differ in intent: `flag` = proceed but note for review, `skip` = gate not relevant.

See `docs/features/STRAT-ENG-3/design.md` for full policy evaluation contract.

### 6. Skip

**Reference:** `lifecycle-manager.js` skipPhase()

```yaml
steps:
  - id: prd
    agent: claude
    intent: "Write PRD."
    skip_if: "$.input.skip_prd == true"
    skip_reason: "PRD not required for internal features"
```

Or explicit: `stratum_skip_step(flow_id, step_id, reason)` — records the skip in the audit trace instead of silently omitting it.

### 7. Round tracking

**Reference:** `lifecycle-manager.js` phaseHistory, iteration loops

```yaml
flows:
  compose_feature:
    max_rounds: 10
```

- `round` field on `StepRecord`, incremented on each revise cycle
- `rounds[]` archive on flow state — prior round trace entries preserved
- Per-step iteration tracking: `max_iterations`, `exit_criterion`, `iteration_history[]`

### 8. Cross-agent loop routing

The `on_fail` + `next` fields enable loops across different agents:

```yaml
steps:
  - id: review
    agent: codex
    intent: "Review. Return {clean: boolean, findings: []}."
    ensure: "result.clean == true"
    on_fail: fix

  - id: fix
    agent: claude
    intent: "Fix all findings."
    inputs:
      findings: "$.steps.review.output.findings"
    next: review
```

Codex reviews → fails ensure → routes to claude for fix → claude fixes → routes back to codex → repeat until clean or max retries. Stratum orchestrates, each agent sees only its step.

## Stratum Skill Prompt

A single document that ships with Compose and gets installed per detected agent. Teaches any agent how to author and execute `.stratum.yaml` specs.

**Contents:**
- IR v0.2 format reference (inline steps, `agent`, `flow:`, `ensure`, `on_fail`/`next`)
- MCP tool reference: `stratum_plan`, `stratum_step_done`, `stratum_gate_resolve`, `stratum_audit`
- How to read a spec and understand what each step expects
- How to report structured results that satisfy `ensure` expressions
- Example specs: simple linear, review loop, multi-agent, composed workflows

**Installation:** `compose init` detects available agents and installs the skill to each:
- Claude Code: `~/.claude/skills/stratum/SKILL.md`
- Codex: `~/.codex/skills/stratum/SKILL.md`
- Gemini: equivalent path

The skill is agent-agnostic — same content for all agents. Each agent learns to be a participant in Stratum workflows, not just a standalone tool.

## Compose CLI

After STRAT-1, the Compose CLI is the primary interface:

```
compose init          # one-time setup with questionnaire
compose roadmap       # create/import roadmap, decompose into features + specs
compose build [FEAT-1]  # execute next feature (or named) through lifecycle
compose start         # launch UI daemon (optional)
compose status        # what's in flight, blocked, next
compose review        # cross-feature consistency check
```

### `compose init`

```
Project name (my-project):
Artifact root (.compose/):
Enable lifecycle gates? (Y/n):
Install Compose UI? (Y/n):

Detecting agents...
  ✓ Claude Code — skill installed
  ✓ Codex — skill installed
  ✗ Gemini — not found

Installing UI dependencies... npm install
Starting Compose UI daemon...
  ✓ UI running at http://localhost:3001
  ✓ LaunchAgent registered — starts on login

Done. Next: compose roadmap
```

### `compose roadmap`

Separate session for project decomposition. Could be quick ("import my ROADMAP.md") or involved brainstorming. Produces `ROADMAP.md` and `spec.md` per feature.

### `compose build`

Picks up next unstarted feature from roadmap (or named feature). Reads `spec.md`, enriches into `design.md` via codebase exploration, executes the lifecycle through the `.stratum.yaml` spec.

## Implementation: Three Milestone Gates

Nothing ships until each gate passes. Each milestone produces a usable deliverable, not just internal progress.

---

### Milestone 1: Stratum Engine Complete

**Gate:** Stratum IR v0.2 parses, validates, and executes a multi-step spec with gates, policy, skip, rounds, loops, composition, and per-step agent assignment. Proven with Stratum's own test suite.

All work in the Stratum repo. Each feature is a `/compose` invocation.

#### STRAT-ENG-1: IR v0.2 Schema

All new fields at once in `spec.py` — one schema pass:

**Workflow declaration:**
- `workflow.name` — invocable command name
- `workflow.description` — human-readable summary
- `workflow.input` — typed input schema with defaults
- Registry discovery from configurable directory
- `stratum_list_workflows` MCP tool

**Inline steps:**
- `agent` — which agent executes the step
- `intent` — what to do (prompt), inline on step
- `on_fail` — route to named step on ensure failure
- `next` — explicit next-step override for loop-back

**Workflow composition:**
- `flow:` reference on steps — invoke a sub-workflow

**Gates:**
- `mode: gate` on steps — suspends until resolution
- `on_approve`, `on_revise`, `on_kill` — routing on gate outcome
- `timeout` — optional auto-kill

**Policy:**
- `policy` — gate | flag | skip
- `policy_fallback` — default if no runtime override

**Skip:**
- `skip_if` — expression-based conditional skip
- `skip_reason` — recorded in audit trail

**Rounds:**
- `max_rounds` on flows
- `round`, `iterations` on StepRecord

**Backward compat:** `functions:` block still supported, `function:` reference on steps still works.

**Validation:** `stratum_validate` catches invalid specs.
**Reference:** `contracts/lifecycle.json` for the structural envelope pattern.

#### STRAT-ENG-2: Executor — State Model + Agent Dispatch

Foundation layer. All subsequent features build on this state model.

- `StepRecord` with all new fields (agent, round, iteration_history)
- `FlowState` with rounds[], pending_gate, audit trail
- Agent field passthrough — caller knows who to invoke
- Audit trail infrastructure — all subsequent features write to it

**References:** `lifecycle-manager.js:424-497` (gate creation), `lifecycle-manager.js:174-215` (gate approval)

#### STRAT-ENG-3: Executor — Gates, Policy, Skip

Builds on STRAT-ENG-2's state model and audit infra. Gates, skip_if, and rounds already
implemented — ENG-3's remaining delta is policy evaluation and explicit skip tool.

- Policy evaluation: `step.policy ?? "gate"`, auto-approve for flag/skip with PolicyRecord
- `stratum_skip_step` MCP tool: explicit step skipping with reason
- `policy_fallback` deferred to ENG-6 (`stratum_set_policy` runtime overrides)

**Full design:** `docs/features/STRAT-ENG-3/design.md`

#### STRAT-ENG-4: Executor — Loops and Rounds

Builds on STRAT-ENG-3's gate routing.

- Round tracking: counter increment on revise, `max_rounds` enforcement, `rounds[]` archive
- Per-step iteration tracking: `max_iterations`, `exit_criterion`, `iteration_history[]`

**References:** `lifecycle-constants.js` SKIPPABLE set, `lifecycle-manager.js` phaseHistory

#### STRAT-ENG-5: Executor — Routing and Composition

Builds on STRAT-ENG-4's loop tracking.

- `on_fail` → route to named step on ensure failure
- `next` → explicit next-step override for loop-back
- `flow:` sub-execution creation, result propagation, nested audit trails

**Audit:** `stratum_audit` reports per-round breakdown with all primitive decisions.

#### STRAT-ENG-6: Contract Freeze

Freeze the Stratum contract before Compose integration. Without this, integration thrashes.

**Freeze deliverables:**
- **Spec shape:** final `.stratum.yaml` schema with all v0.2 fields, validated by `stratum_validate`
- **MCP tool names and payloads:** exact signatures for `stratum_plan`, `stratum_step_done`, `stratum_gate_resolve`, `stratum_skip_step`, `stratum_set_policy`, `stratum_iteration_start`, `stratum_iteration_report`, `stratum_audit`
- **Flow state output:** exact shape of flow state JSON (steps, rounds, gates, iterations, audit trail)
- **Audit output:** exact shape of `stratum_audit` response

Published as a contract document in `docs/features/STRAT-1/stratum-contract.md`. Compose codes against this. Post-freeze changes require both sides to update.

---

### Milestone 2: Headless Compose Runner

**Gate:** `compose build FEAT-X` reads a spec, invokes Stratum, dispatches agents, enforces gates, and produces artifacts in the feature folder. No UI, no server — CLI → Stratum → agents → disk.

All work in the Compose repo. Each feature is a `/compose` invocation.

#### STRAT-COMP-1: Skill Prompt + Headless Runner + Init Upgrade

Three deliverables in one feature — they're tightly coupled (init installs the skill, build uses it).

**Stratum skill prompt:**
- IR v0.2 format reference with examples
- MCP tool usage patterns
- How to report structured results that satisfy `ensure` expressions
- Example specs: simple linear, review loop, multi-agent, composed workflows
- Install to all detected agent skill directories (Claude, Codex, Gemini)
- Test: give the skill to an agent, have it author a spec from scratch

**`compose build` — headless lifecycle runner:**
1. Load feature: read `spec.md` (or `design.md`) from feature folder
2. Plan: call `stratum_plan` with the lifecycle spec and feature input
3. Loop: for each step, dispatch to the assigned agent via connector
4. Enforce: gates suspend and wait for resolution (CLI prompt or API call)
5. Track: write artifacts to feature folder, update vision state on disk
6. Audit: call `stratum_audit` on completion, write trace to feature folder

**No server required.** Vision state writes directly to `data/vision-state.json`. Gate resolution via CLI prompt (headless) or REST API (if server is running).

**`compose init` upgrade:**
- Project name, artifact root, gate preference
- Agent auto-detection + skill installation
- Optional UI install (`npm install` + daemon)

#### STRAT-COMP-2: Delete Bespoke Code

Replace Compose's lifecycle engine with Stratum calls:

**What gets deleted:**
- `lifecycle-manager.js` state machine, gate subsystem, iteration subsystem
- `policy-engine.js` (ported to Stratum)
- Most of `lifecycle-constants.js` (execution primitives gone)

**What becomes adapter code** (only needed when UI server runs):
- Gate route handlers → thin proxy to `stratum_gate_resolve`
- Iteration route handlers → thin proxy to `stratum_iteration_*`
- WebSocket broadcasts → triggered by Stratum events

**Preserved transport contracts** (no breaking change to UI):

Gate API:
- `GET /api/vision/gates` — list pending gates (filtered by itemId)
- `GET /api/vision/gates/:id` — get gate detail
- `POST /api/vision/gates/:id/resolve` — resolve with `{ outcome, comment }`
- WebSocket broadcast: `gateResolved { gateId, itemId, outcome, timestamp }`

Iteration API:
- `POST /api/vision/items/:id/lifecycle/iteration/start` — `{ loopType, maxIterations }`
- `POST /api/vision/items/:id/lifecycle/iteration/report` — `{ clean, passing, summary, findings, failures }`
- `GET /api/vision/items/:id/lifecycle/iteration` — current iteration status
- WebSocket broadcasts: `iterationStarted`, `iterationUpdate`, `iterationComplete { loopType, outcome, finalCount }`

**What stays unchanged:**
- Feature folder management, artifact assessment
- The `.stratum.yaml` lifecycle spec (Compose's opinion)
- Vision Surface, sessions, project config, UI
- Gate approval panel UI (same REST contract, different backend)

---

### Milestone 3: Prove It — Run STRAT-1 Through Compose

**Gate:** Compose builds its own Track B (Compose integration) using `compose build`. The headless runner reads the STRAT-1 spec, dispatches Claude to implement, dispatches Codex to review, loops until clean, enforces gates, produces artifacts. Dogfooding milestone D4.

#### STRAT-COMP-3: Proof Run

Write STRAT-1 spec, execute, validate — one feature because it's a single end-to-end run.

**Write spec:** `docs/features/STRAT-1/spec.md` — the input to `compose build STRAT-1`. Covers Track B only (Compose integration). Track A (Stratum engine) must be complete first.

**Execute:** Run `compose build STRAT-1` headless. The runner:
- Reads spec.md
- Explores codebase, writes/updates design.md
- Gates for human approval
- Writes plan.md
- Gates for human approval
- Dispatches Claude for implementation
- Dispatches Codex for review (cross-agent loop)
- Loops until review clean
- Runs coverage sweep
- Writes report, updates docs, commits

**Validate:**
- All 410+ Compose tests pass with Stratum backend
- Stratum's own tests for all v0.2 primitives
- E2E audit trail: complete trace of the STRAT-1 execution
- Cross-agent review loop proven (codex → claude → codex)

## Post-STRAT-1: Additional Workflows

STRAT-1 ships `compose build` as the built-in workflow. The `workflow:` declaration in IR v0.2 and the registry protocol make adding new workflows trivial — drop a `.stratum.yaml` spec, it surfaces as a command:

- `compose research <topic>` — multi-agent exploration, findings consolidated into a research doc
- `compose brainstorm <idea>` — interactive ideation, one question at a time, produces discovery doc
- `compose roadmap` — project decomposition into features with specs
- User-authored workflows for project-specific patterns

Each is a Stratum spec with its own step graph, agents, and gates. No CLI code changes required.

## Open Questions

1. **Event model:** Should Stratum push events (WebSocket/SSE) or should Compose continue polling? Push would eliminate `stratum-sync.js` polling and enable real-time gate notifications.

2. ~~**Iteration loops vs. revision rounds:**~~ **Resolved.** Iteration loops are a Stratum primitive (see Phase 6: Compose Integration). Stratum owns loop execution, count tracking, exit criteria evaluation, and max enforcement. Compose retains the REST/WS adapter layer and the loop type definitions in its `.stratum.yaml` spec.

3. **Artifact awareness:** Reconciliation (infer phase from files on disk) is currently in Compose. Should Stratum have a generic "external signal reconciliation" primitive, or is this always workflow-specific?

4. ~~**Contract format:**~~ **Resolved.** The lifecycle is a `.stratum.yaml` spec. `lifecycle.json` stays as Compose's source of truth for phase names and artifact mappings, but execution is Stratum-native.

5. **Python packaging:** Compose becomes a `pip install` package with Stratum as a dependency. The Node UI server ships as a bundled asset or is installed on demand via `npm install` during `compose init`. Packaging strategy TBD.
