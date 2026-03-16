---
name: compose
description: Use when starting a non-trivial feature that will span multiple files or phases — orchestrates the full lifecycle from idea through design, spec, blueprint, and implementation using existing skills and agents at each stage.
---

# Compose Lifecycle

## Overview

Orchestrates the full feature development lifecycle by chaining granular skills together with review gates between phases. Each phase produces an artifact in the feature folder. Claude Code's native tools (plan mode, tasks, sessions) handle within-session execution; this skill handles the cross-session lifecycle.

Before any phase begins, read the project state via the `compose` MCP server (get_vision_items, get_phase_summary, get_blocked_items) to understand what's in flight, what's decided, and what's blocked. Every feature maps to a vision item — check it exists, create it if not.

## When to Use

- New feature spanning 3+ files or 2+ phases
- Feature touching multiple components (server + UI, MCP + client)
- Any work that needs a design spec before implementation

**Skip this for:** single-file changes, bug fixes, hotfixes, refactors with obvious approach.

## Partial Execution: `--through <phase>`

By default, `/compose` runs the full lifecycle. Use `--through` to stop after a specific phase's gate is approved:

```
/compose FEAT-1 --through design
/compose FEAT-1 --through prd
/compose FEAT-1 --through architecture
/compose FEAT-1 --through blueprint
/compose FEAT-1 --through plan
/compose FEAT-1 --through execute
/compose FEAT-1 --through report
/compose FEAT-1 --through docs
```

When `--through` is active:
1. Run phases normally up to and including the target phase
2. After the target phase's gate is approved, write `status.md` to the feature folder
3. Commit all artifacts and exit — do NOT propose the next phase
4. On next `/compose` invocation, `status.md` is read during entry scan and informs the resume point

## Feature Folder

Every feature gets a folder at `docs/features/<feature-code>/`. The folder name matches the vision item's semantic ID or tracker code (e.g. `FEAT-1`, `AUTH-3`). 1:1 mapping between vision items and feature folders.

```
docs/features/<feature-code>/
  design.md              # Feature-level design
  prd.md                 # PRD (skip for internal/technical work)
  architecture.md        # Architecture (skip for single-component)
  killed.md              # Present only if feature was abandoned
  sessions/              # Session transcripts
  phase-1-<slug>/        # Implementation phase subfolders
  phase-2-<slug>/
```

For small features, artifacts stay flat at root (no phase subfolders).

## Gate Protocol

Every phase transition is a gate. Three outcomes:

- **Approve** — artifact accepted, proceed
- **Revise** — loop back, improve, re-gate
- **Kill** — write `killed.md` with reason and phase; update vision item status to `killed`

At every gate, always propose whether to proceed, skip, or revise. The difference between dial modes:
- **Gate:** Agent proposes, human decides
- **Flag:** Agent decides, human gets notified
- **Skip:** Agent decides silently

## Lifecycle

```
Phase 1:  Explore & Design ──── gate ──→
Phase 2:  PRD (skippable) ───── gate ──→
Phase 3:  Architecture (skip) ─ gate ──→
Phase 4:  Blueprint ─────────── gate ──→
Phase 5:  Blueprint Verification gate ──→
Phase 6:  Plan ──────────────── gate ──→
Phase 7:  Execute + E2E + Review + Sweep ──→
            ├─ Step 1: TDD execution
            ├─ Step 2: E2E smoke test
            ├─ Step 3: Review loop (till clean)
            └─ Step 4: Coverage sweep (till clean)
Phase 8:  Report (skippable) ── gate ──→
Phase 9:  Update Docs ──────── gate ──→
Phase 10: Ship ─────────────────────────→ Done
```

Phase 7 includes all four steps as exit criteria — you cannot exit without all completing.

## Phases

### Phase 1: Explore & Design

**Agent:** `compose-explorer` (2-3 instances in parallel)

- Check compose MCP for existing vision item; create one if absent
- Create `docs/features/<feature-code>/` folder
- Launch 2-3 `compose-explorer` agents in parallel:
  - "Find features similar to [feature] and trace their implementation"
  - "Map the architecture and abstractions for [area]"
  - "Analyze the current implementation of [related feature]"
- Understand the idea through one-question-at-a-time dialogue
- Explore 2-3 approaches with trade-offs
- Write to `docs/features/<feature-code>/design.md`
- Update vision item status to `in_progress`

**Gate checkpoint:** Does this design depend on unproven technical assumptions? If yes, list them. Spikes happen as roadmap tasks.

**Gate:** User approves design. Commit.

**Skip when:** Spec already exists.

### Phase 2: Write PRD

Formalize into a PRD at `docs/features/<feature-code>/prd.md`. Sections: Problem Statement, Goals & Non-Goals, Requirements (MUST/SHOULD/MAY), Success Criteria, User Stories, Constraints & Assumptions, Open Questions.

**Gate:** All open questions resolved or deferred with rationale.

**Skip when:** PRD exists, or feature is purely internal with no user-facing requirements.

### Phase 3: Architecture Doc

**Agent:** `compose-architect` (2-3 instances with competing mandates)

- **Minimal changes** — smallest possible change, maximum reuse
- **Clean architecture** — maintainability first, elegant abstractions
- **Pragmatic balance** — 80/20, good boundaries without over-engineering

Present all proposals, trade-offs, your recommendation. User picks. Write to `docs/features/<feature-code>/architecture.md`.

**Gate:** Component boundaries and interfaces clear enough for blueprint.

**Skip when:** Feature is small enough that design covers architecture.

### Phase 4: Implementation Blueprint

**Agent:** `compose-explorer` (targeted research)

- Check for overlapping in-flight features: scan other `docs/features/*/blueprint.md` for shared file references
- Launch `compose-explorer` targeting the specific area
- Read every critical file, note patterns with line references
- Build corrections table (spec assumption vs reality)
- Write to `docs/features/<feature-code>/blueprint.md`

**Gate:** Corrections table empty or all corrections documented.

### Phase 5: Blueprint Verification

For every file:line reference in the blueprint:
1. Read the actual file at that line — does it match?
2. Check function signatures
3. Verify pattern claims
4. Confirm imports/exports
5. Flag stale references

Produce a verification table, append to `blueprint.md`. If any stale/wrong, loop back to Phase 4.

**Gate:** All file:line references verified. Zero stale entries.

**Skip when:** Blueprint written in the same session immediately after reading all referenced files.

### Phase 6: Write Implementation Plan

Uses `EnterPlanMode`. Plan writes to `docs/features/<feature-code>/plan.md`.

- Break blueprint into ordered tasks with dependencies
- Each task: file path, what to do, pattern to follow, test to write
- Identify parallelizable tasks

**Gate:** User approves plan via `ExitPlanMode`.

### Phase 7: Execute

**Execution skill selection:**

| Condition | Use |
|---|---|
| Independent tasks, parallelizable | `superpowers:dispatching-parallel-agents` |
| Sequential tasks with dependencies | `superpowers:executing-plans` |

- **REQUIRED:** TDD per task — write test first, watch fail, implement, watch pass
- **REQUIRED:** `superpowers:verification-before-completion` before marking any task done
- Use `superpowers:systematic-debugging` on any unexpected failure

**Blocker protocol:** If external blocker hit — record in feature folder, set vision item to `blocked`, surface to human.

**Gate:** All four steps complete:

1. **All tasks executed** — tests pass
2. **E2E smoke test** — start dev server (`npm run dev` from compose root — Vite on :5173, API on :3001, agent on :3002), run Playwright tests for affected flows
3. **Review loop clean** — Codex reviews via `codex_run`, confidence >= 80, loop until `REVIEW CLEAN`
4. **Coverage sweep clean** — loop until `TESTS PASSING`

**Step 3: Review Loop**

Codex is the default reviewer. Opus executes; Codex reviews. This is not configurable.

```
Call mcp__compose__agent_run with:
  type: "codex"
  task: "Review the implementation against blueprint and plan. List all issues
         with confidence >= 80. Output REVIEW CLEAN if no actionable findings remain."
  files: changed files + docs/features/<feature-code>/blueprint.md + plan.md
```

Fix all issues Codex flags. Re-run until REVIEW CLEAN.

If `mcp__compose__agent_run` is unavailable, fall back to `compose-reviewer`
agent and note the fallback in the session log.

Max 10 iterations. If max hit, problem is in spec — surface to human.

**Step 4: Coverage Sweep**

```
Write and run tests for the implementation in docs/features/<feature-code>/plan.md.
Focus on edge cases, error paths, cross-component integration.
Fix failing tests. Output TESTS PASSING when all pass.
```

Max 15 iterations.

### Phase 8: Implementation Report

Write to `docs/features/<feature-code>/report.md`:

1. Summary
2. Delivered vs Planned
3. Architecture Deviations
4. Key Implementation Decisions
5. Test Coverage
6. Files Changed
7. Known Issues & Tech Debt
8. Lessons Learned

**Gate:** Report complete and honest.

**Skip when:** Feature had no PRD or architecture doc (too small to warrant a report).

### Phase 9: Update All Docs

- `CHANGELOG.md` — entry for this feature
- `README.md` — if setup, usage, or capabilities changed
- `CLAUDE.md` — if new commands, conventions, or architecture changed
- `ROADMAP.md` — update item status to `COMPLETE`
- Update vision item status to `complete`
- Bind the stratum flow to the vision item: `POST /api/stratum/bind` with the flow_id and vision item id

**Do NOT update** pre-implementation intent documents (PRD, architecture).

**Gate:** All doc surfaces reviewed and updated.

### Phase 10: Review & Ship

- Final `superpowers:verification-before-completion`
- Verify all Phase 9 docs committed
- Call `stratum_audit` with `flow_id`, include trace in commit description
- Present options: merge, PR, or cleanup

## Stratum Integration

Compose uses Stratum as the execution tracker. The `.stratum.yaml` spec is generated at invocation — never shown to the user. Claude Code is the executor; Stratum enforces that each phase produced a verifiable artifact before advancing.

### When to Call Each Tool

- **`stratum_plan`** — once, after entry scan, before Phase 1. Flow: `compose_feature`.
- **`stratum_step_done`** — after each step's gate is approved.
- **`stratum_audit`** — in Phase 10 before committing. Bind result to vision item via `POST /api/stratum/bind`.

If Stratum unavailable, continue with flat prompt chain.

### Step → Phase Mapping

| Step | Phases |
|---|---|
| `research` | Phase 1 exploration. No human gate. |
| `write_design` | Phase 1 design + optional Phase 2 PRD + optional Phase 3 Architecture. Gate after Phase 1. |
| `write_blueprint` | Phase 4 + Phase 5 verification. Gate after Phase 5. |
| `implement` | Phase 7 — TDD, E2E, review loop, coverage sweep. Gate after all four steps. |

Phases 6, 8, 9, 10 are sub-activities within adjacent steps.

### Spec Template

```yaml
version: "0.1"
contracts:
  ResearchResult:
    findings: {type: array}
    relevant_files: {type: array}
  DesignResult:
    path: {type: string}
    word_count: {type: integer}
  BlueprintResult:
    path: {type: string}
  ImplementResult:
    files_changed: {type: array}
    tests_pass: {type: boolean}

functions:
  research:
    mode: compute
    intent: "Explore the codebase with compose-explorer agents and surface patterns relevant to the feature."
    input: {description: {type: string}}
    output: ResearchResult
    ensure:
      - "len(result.findings) > 0"
    retries: 2

  write_design:
    mode: compute
    intent: "Run Phase 1 (and optional Phases 2-3) — explore, gate, write design.md."
    input: {description: {type: string}}
    output: DesignResult
    ensure:
      - "file_exists(result.path)"
      - "result.word_count > 200"
    retries: 2

  write_blueprint:
    mode: compute
    intent: "Run Phases 4-5 — blueprint, verification. Gate before returning."
    input: {description: {type: string}}
    output: BlueprintResult
    ensure:
      - "file_exists(result.path)"
    retries: 2

  implement:
    mode: compute
    intent: "Run Phase 7 — TDD, E2E, review loop, coverage sweep."
    input: {description: {type: string}}
    output: ImplementResult
    ensure:
      - "result.tests_pass == True"
      - "len(result.files_changed) > 0"
    retries: 2

flows:
  compose_feature:
    input: {description: {type: string}}
    output: ImplementResult
    steps:
      - id: research
        function: research
        inputs: {description: "$.input.description"}
        output_schema:
          type: object
          required: [findings]
          properties:
            findings: {type: array, items: {type: string}}
            relevant_files: {type: array, items: {type: string}}

      - id: write_design
        function: write_design
        inputs: {description: "$.input.description"}
        depends_on: [research]
        output_schema:
          type: object
          required: [path, word_count]
          properties:
            path: {type: string}
            word_count: {type: integer}

      - id: write_blueprint
        function: write_blueprint
        inputs: {description: "$.input.description"}
        depends_on: [write_design]
        output_schema:
          type: object
          required: [path]
          properties:
            path: {type: string}

      - id: implement
        function: implement
        inputs: {description: "$.input.description"}
        depends_on: [write_blueprint]
        output_schema:
          type: object
          required: [files_changed, tests_pass]
          properties:
            files_changed: {type: array, items: {type: string}}
            tests_pass: {type: boolean}
```

### Result Dict Shapes

```python
# research
{"findings": ["pattern A", "pattern B"], "relevant_files": ["server/index.js"]}

# write_design
{"path": "docs/features/FEAT-1/design.md", "word_count": 450}

# write_blueprint
{"path": "docs/features/FEAT-1/blueprint.md"}

# implement
{"files_changed": ["server/index.js", "src/components/Foo.jsx"], "tests_pass": True}
```

### Narration Pattern

Never mention `.stratum.yaml`, `stratum_plan`, or step IDs to the user:

```
Checking project state and exploring codebase...
Writing design doc...
Writing implementation blueprint...
Implementing...
```

## Entry: Scan First

When `/compose` is invoked, always scan first:

1. Read compose MCP: `get_vision_items` for the feature code, `get_current_session` for context
2. Check `docs/features/<feature-code>/`. If absent, start at Phase 1.
3. If folder exists, read every file. Summarize what's covered and what's missing.
4. If `status.md` exists, read it for resume point, then delete it.
5. Propose starting phase with rationale. Human approves.

## Phase Selection

| Folder State | Action |
|---|---|
| No folder | Start Phase 1 |
| `status.md` | Read for resume point, delete, start indicated phase |
| `design.md` | Review, fill gaps, gate |
| `prd.md` / `architecture.md` | Review completeness. If solid, proceed to Phase 4. |
| `blueprint.md` | Verify (Phase 5). Never skip verification. |
| `plan.md` | Review against current code. If accurate, execute (Phase 7). |
| Code + tests done | E2E, review, sweep (Phase 7 steps 2-4), then docs (Phase 9). |

**Phase 7's E2E and loops are never skipped.** They self-terminate on clean input.

## Cross-Cutting Agents & Skills

| Agent/Skill | When |
|---|---|
| `compose-explorer` | Phase 1 (2-3 parallel), Phase 4 (targeted) |
| `compose-architect` | Phase 3 (2-3 competing mandates) |
| `mcp__compose__agent_run(type="codex")` | Phase 7 step 3 — default reviewer (Opus executes, Codex reviews) |
| `compose-reviewer` | Phase 7 step 3 — fallback only when `codex_run` unavailable |
| `superpowers:test-driven-development` | Phase 7 step 1 |
| `superpowers:verification-before-completion` | Before any task/phase done |
| `superpowers:systematic-debugging` | Any unexpected failure |
| `interface-design:init` | Phase 7 — new UI components |
| `interface-design:critique` | Phase 7 — after building UI |
| `interface-design:audit` | Phase 7 — check UI against design system |
| `refactor` | Phase 7 — when review finds large files |
| `update-docs` | Phase 9 |

## Memory

After completing a feature lifecycle, update project memory:
- Architecture decisions made
- Patterns discovered during blueprint
- Corrections that apply broadly
