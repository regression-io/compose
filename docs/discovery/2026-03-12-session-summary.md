# Session Summary — 2026-03-12

**Purpose:** Capture everything needed to resume work on Compose.

---

## What Was Built This Session

### 1. SDK Event Normalization Fix

**Files:** `server/connectors/claude-sdk-connector.js`

The Claude SDK yields `{ type: 'assistant', message: BetaMessage }` where `message.content` is an array of content blocks (text, tool_use). The old `_normalize` function passed these through unchanged, so `textParts` in the result normalizer was always empty and JSON extraction always failed. Replaced `_normalize` with `_normalizeAll` that unpacks `msg.message.content` blocks into individual typed events:

- `block.type === 'text'` yields `{ type: 'assistant', content: block.text }`
- `block.type === 'tool_use'` yields `{ type: 'tool_use', tool: block.name, input: block.input }`

Also handles `result` events (`msg.result` → `{ type: 'result', content: msg.result }`) and passes through `tool_use_summary`, `tool_progress`, and `delta` events.

### 2. CLAUDECODE Nesting Guard Fix

**Files:** `server/connectors/claude-sdk-connector.js`

SDK child process crashed immediately because `CLAUDECODE` env var was set (running inside a Claude Code session). Fixed by stripping `CLAUDECODE` from the env object before spawning:

```js
const cleanEnv = { ...process.env };
delete cleanEnv.CLAUDECODE;
```

### 3. Progress Logging Working

**Files:** `lib/result-normalizer.js`

The result normalizer now logs `tool_use`, `tool_use_summary`, and `tool_progress` events to stderr during agent execution. Also captures text from `result` event type as a fallback when no `assistant` text blocks arrive. Debug mode (`COMPOSE_DEBUG=1`) logs every event type and text previews.

### 4. injectSchema Rewrite

**Files:** `server/connectors/agent-connector.js`

Changed the schema injection strategy from "respond with JSON only" to "include a JSON code block at the very end." This works with how agents actually produce output — they explain their work in prose and can include structured JSON at the end, rather than being forced into pure-JSON mode which breaks tool use.

### 5. Agent-as-Validator

**Files:** `lib/step-validator.js` (new)

After each step, the dispatch loop can optionally run a lightweight validation agent that reads the artifact and checks criteria. Validate configs are declared in YAML spec per step:

```yaml
validate:
  artifact: docs/discovery/research.md
  criteria:
    - "Contains at least 2 existing tools"
    - "Mentions architectural patterns"
```

These configs are stripped from the spec before sending to Stratum (Stratum rejects unknown fields). If validation fails, the dispatch loop sends a fix prompt to another agent instance, then continues.

### 6. Gate Conversation Mode

**Files:** `lib/gate-prompt.js`, `lib/new.js`, `lib/build.js`

Gate prompt now supports typing questions that dispatch to a Claude agent for Q&A before deciding. The flow:

1. Gate shows options: `[a]pprove / [r]evise / [k]ill`
2. User can type a question instead of a/r/k
3. Question dispatched to Claude with artifact context
4. Answer printed inline
5. User types more questions or makes a decision
6. Notes from conversation become the rationale

Wired up in `new.js` (both main loop and with artifact paths) and `build.js` (both main loop and child flow). Approve no longer requires rationale (defaults to "approved").

### 7. Gate Artifact Display

**Files:** `lib/new.js`

Gates show the content of the artifact being reviewed before the approve/revise/kill options. Resolves artifact path via `priorStepId` lookup through multiple sources: `response.on_revise`, `response.depends_on[0]`, or spec lookup. Shows first 60 lines inline, with a truncation note for longer files.

### 8. Step Summaries

**Files:** `lib/new.js`

After each step completes, prints a summary line. Sources (in priority order):
1. `result.summary` from structured JSON extraction
2. Artifact file metadata (line count, first heading)
3. Fallback: `"{stepId} complete"`

### 9. Questionnaire Persistence

**Files:** `lib/questionnaire.js` (new), `bin/compose.js`

Interactive pre-flight for `compose new`. Asks project type, language, complexity, research preference, review agent preference. Saves answers to `.compose/questionnaire.json`. Behavior:
- First run: auto-runs questionnaire
- Subsequent runs: skips (uses saved answers as defaults for intent enrichment)
- `--ask` flag: re-runs questionnaire with previous answers as defaults
- `--auto` flag: always skips

### 10. Auto-Init in compose new/build

**Files:** `bin/compose.js`

Both `compose new` and `compose build` check for `.compose/compose.json` AND pipeline specs. If either is missing, runs `compose init` automatically before proceeding. Eliminates the common error of forgetting to run `compose init` first.

### 11. Stratum README

**File:** `/Users/ruze/reg/my/forge/stratum/README.md` (in sibling repo)

Full reference documentation for the Stratum process engine.

### 12. Compose README

**File:** `/Users/ruze/reg/my/forge/compose/README.md` (new)

Full reference documentation for Compose CLI and architecture.

### 13. STRAT-COMP-4 Design Doc

**File:** `docs/features/STRAT-COMP-4/design.md` (new)

Milestone 4: Unified Interface. 5 sub-features (items 47-51) for integrating CLI and web UI. Key architecture decisions:
- **Ownership model:** Server owns `vision-state.json` when running; CLI talks via REST. CLI owns file directly when server is down.
- **Per-gate liveness checks:** CLI probes `GET /api/health` at each gate (500ms timeout), not cached at build start.
- **Agent stream transport:** CLI appends to `.compose/build-stream.jsonl`, agent-server tails and rebroadcasts on existing SSE endpoint.
- **Gate delegation:** CLI creates gate via `POST /api/vision/gates`, polls for resolution. Falls back to readline when server is unreachable.

Went through 3 rounds of code review fixing API endpoints, lifecycle bootstrap sequence, and ownership semantics.

### 14. Claude Octopus Analysis

Reviewed https://github.com/nyldn/claude-octopus. Key takeaway: reaction engine pattern — auto-respond to CI failures, PR approvals, stuck agents. Adds event-driven automation on top of agent orchestration. User said "yes" to adding to roadmap (conversation was interrupted before the roadmap entry was written).

---

## Uncommitted Changes

### Modified Files

| File | What Changed |
|------|-------------|
| `server/connectors/claude-sdk-connector.js` | `_normalize` → `_normalizeAll`, CLAUDECODE env strip, result event handling |
| `server/connectors/agent-connector.js` | `injectSchema` rewrite (JSON code block instead of JSON-only mode) |
| `lib/result-normalizer.js` | Progress logging (tool_use/summary/progress), result event capture, debug mode |
| `lib/gate-prompt.js` | Conversation mode with agent Q&A, approve skips rationale |
| `lib/build.js` | askAgent callback wired into gates (main + child flow), auto-init guard |
| `bin/compose.js` | `compose new` command, `compose import` command, `compose feature` command, `compose pipeline` command, auto-init, questionnaire integration |
| `ROADMAP.md` | Milestone 4 items (47-51), STRAT-COMP-4 through STRAT-COMP-8 |
| `package.json` | Likely dependency or script updates |
| `test/connectors.test.js` | Updated for `_normalizeAll` changes |
| `test/gate-prompt.test.js` | Tests for conversation mode, approve without rationale |
| `test/result-normalizer.test.js` | Updated for progress logging and result event changes |
| `.compose/breadcrumbs.log` | Session breadcrumbs |

### New Files

| File | What It Is |
|------|-----------|
| `lib/new.js` | Kickoff runner for `compose new` pipeline |
| `lib/step-validator.js` | Agent-as-validator for post-step artifact checking |
| `lib/questionnaire.js` | Interactive pre-flight questionnaire with persistence |
| `lib/pipeline-cli.js` | Pipeline inspection/mutation CLI (`compose pipeline show/set/disable`) |
| `lib/import.js` | Project import/analysis for `compose import` |
| `pipelines/new.stratum.yaml` | Kickoff pipeline spec (research → brainstorm → gate → roadmap → gate → scaffold) |
| `docs/features/STRAT-COMP-4/design.md` | Unified Interface design doc |
| `README.md` | Compose reference documentation |

---

## Known Issues

1. **Gate artifact display fragile** — Depends on `priorStepId` lookup finding the right validate config via `response.on_revise`, `response.depends_on[0]`, or spec lookup. If none of these resolve, no artifact is shown. Only wired in `new.js`, not `build.js`.

2. **JSON extraction best-effort** — Result normalizer tries 3 strategies (full JSON parse, fenced block, balanced braces) then falls back to `{ summary }`. This means `$.steps.X.output.summary` inter-step references may be empty when extraction fails.

3. **Vision store convention mismatch** — `VisionWriter` (CLI) uses `featureCode: "feature:FEAT-1"` format. `VisionStore` (server) queries via `item.lifecycle?.featureCode`. Transitional hack exists in `vision-writer.js:33-39`. Documented in STRAT-COMP-4 design as item 47 to fix.

4. **Tests: 319 passing** — As of end of session. Gate tests cover conversation mode, approve-without-rationale, revise-with-notes. Connector tests cover `_normalizeAll`. Result normalizer tests cover progress logging.

5. **compose build does not strip validate configs** — Unlike `new.js` which strips `validate` fields from the spec before sending to Stratum, `build.js` does not have this logic. If `build.stratum.yaml` adds validate configs, they will be sent to Stratum and rejected.

6. **askAgent in build.js child flow** — The `askAgent` callback is wired in `build.js` child flow's `await_gate` handler, but the artifact path is always `context.cwd` (the project root), not the specific artifact. Less useful for Q&A than `new.js` which resolves the actual artifact path.

---

## Pending Work

### Immediate

1. **Commit everything** — Massive uncommitted changeset spanning multiple sessions. Modified and new files listed above.

2. **Test compose new end-to-end** — The logslice run showed progress logging and gates working, but the run was not completed through the scaffold step. Need a full end-to-end run with real inference.

3. **STRAT-COMP-3 Task 6** — Live proof run with real inference. Still manual/gated. This is the "prove it" milestone: Compose builds itself using `compose build`.

### Roadmap Additions

4. **Reaction engine** — Inspired by claude-octopus. Auto-respond to CI failures, PR events, stuck agents. User approved adding to roadmap but the entry was not written. Pattern: event listeners on GitHub webhooks / CI status → auto-dispatch agent with context.

5. **Validate "we do it better" claims** — User asked to validate that Compose's approaches (Stratum state machine, file-based artifacts, agent-as-validator) are actually better than claude-octopus alternatives (wrapper scripts, GitHub Actions, retry loops). Analysis not done.

### STRAT-COMP-4 Implementation (Milestone 4)

6. **STRAT-COMP-4 (Vision store unification)** — Single `featureCode` format, VisionWriter REST mode, remove transitional hack. Prerequisite for all other Milestone 4 items.

7. **STRAT-COMP-5 (Build visibility)** — Extend server file watcher to `active-build.json`, broadcast build state via WebSocket.

8. **STRAT-COMP-6 (Web gate resolution)** — CLI probes server health at each gate, creates gates via REST, polls for resolution. Readline fallback.

9. **STRAT-COMP-7 (Agent stream bridge)** — CLI appends to `.compose/build-stream.jsonl`, agent-server tails and rebroadcasts.

10. **STRAT-COMP-8 (Active build dashboard)** — Build View component in web UI.

---

## Architecture Quick Reference

### Pipeline Execution Flow

```
compose new "intent"
  → bin/compose.js
    → auto-init if needed
    → questionnaire (first run or --ask)
    → enrich intent with project context
    → lib/new.js: runNew()
      → connect to stratum-mcp
      → stratum.plan(spec, 'new', { projectName, intent })
      → dispatch loop:
          execute_step → buildStepPrompt → connector.run → runAndNormalize → validateStep → stepDone
          await_gate   → show artifact → promptGate (with askAgent) → gateResolve
          execute_flow → recursive executeChildFlow
          ensure_failed → fix prompt → retry
      → write audit trace
```

```
compose build FEAT-X
  → bin/compose.js
    → auto-init if needed
    → lib/build.js: runBuild()
      → check/resume active-build.json
      → connect to stratum-mcp
      → stratum.plan(spec, 'build', { featureCode, description })
      → dispatch loop (same pattern as new.js, plus active-build tracking)
      → write audit trace to docs/features/FEAT-X/audit.json
```

### SDK Connector Data Flow

```
ClaudeSDKConnector.run(prompt)
  → query({ prompt, options: { cwd, model, permissionMode, tools, env: cleanEnv } })
  → for await (msg of query):
      _normalizeAll(msg) → [
        { type: 'assistant', content: text }      ← from msg.message.content[].text
        { type: 'tool_use', tool, input }          ← from msg.message.content[].tool_use
        { type: 'result', content: finalText }     ← from msg.result
        { type: 'tool_use_summary', summary }      ← passthrough
        { type: 'tool_progress', tool, elapsed }   ← passthrough
      ]
```

### Result Normalizer Flow

```
runAndNormalize(connector, prompt, stepDispatch)
  → if output_fields: convert to JSON Schema, inject into prompt
  → for await (event of connector.run):
      accumulate text from assistant/result events
      log tool_use/summary/progress to stderr
  → extractJson(text): try full parse → fenced block → balanced braces → null
  → if null: fallback { summary: text.slice(0, 200) }
  → return { text, result }
```

### Gate Resolution Flow

```
promptGate(gateDispatch, { artifact, askAgent })
  → show a/r/k options
  → loop:
      user types question → askAgent(question, artifact) → print answer
      user types a/r/k → set outcome
  → if notes collected: notes = rationale
  → if approve with no notes: rationale = "approved"
  → if revise/kill with no notes: prompt for rationale
  → return { outcome, rationale }
```

### Validation Flow

```
step completes
  → lookup validateConfigs.get(stepId)
  → if config exists:
      validateStep({ artifact, criteria, connector })
        → dispatch validation agent
        → extract { valid, issues } from response
      → if !valid:
          dispatch fix agent with issues list
          (no re-validation — optimistic)
```

### Key File Locations

| Purpose | Path |
|---------|------|
| CLI entry point | `bin/compose.js` |
| Kickoff runner | `lib/new.js` |
| Build runner | `lib/build.js` |
| Gate prompt | `lib/gate-prompt.js` |
| Step validator | `lib/step-validator.js` |
| Result normalizer | `lib/result-normalizer.js` |
| Questionnaire | `lib/questionnaire.js` |
| Pipeline CLI | `lib/pipeline-cli.js` |
| Import/analysis | `lib/import.js` |
| SDK connector | `server/connectors/claude-sdk-connector.js` |
| Base connector | `server/connectors/agent-connector.js` |
| Codex connector | `server/connectors/codex-connector.js` |
| Stratum MCP client | `lib/stratum-mcp-client.js` |
| Vision writer (CLI) | `lib/vision-writer.js` |
| Step prompt builder | `lib/step-prompt.js` |
| Kickoff pipeline | `pipelines/new.stratum.yaml` |
| Build pipeline | `pipelines/build.stratum.yaml` |
| Project config | `.compose/compose.json` |
| Active build state | `.compose/data/active-build.json` |
| Questionnaire answers | `.compose/questionnaire.json` |
| Vision state | `.compose/data/vision-state.json` |
| STRAT-COMP-4 design | `docs/features/STRAT-COMP-4/design.md` |
| Roadmap | `ROADMAP.md` |

---

## Roadmap State Summary

| Phase | Status |
|-------|--------|
| Phase 0: Bootstrap | COMPLETE |
| Phase 1: Vision Surface | COMPLETE |
| Phase 2: Agent Awareness | COMPLETE |
| Phase 3: Session Tracking | COMPLETE |
| Phase 4: Agent Connector | PARTIAL (manual gate pending) |
| Phase 4.5: Stratum Sync | COMPLETE |
| Phase 6: Lifecycle Engine (L0-L6) | COMPLETE |
| INIT-1: Project Bootstrap | COMPLETE |
| STRAT-1 Milestone 1: Stratum Engine | COMPLETE |
| STRAT-1 Milestone 2: Headless Runner | COMPLETE |
| STRAT-1 Milestone 3: Prove It (STRAT-COMP-3) | PARTIAL — Task 6 (live proof run) remains |
| STRAT-1 Milestone 4: Unified Interface (STRAT-COMP-4 through 8) | PLANNED — design doc written |
