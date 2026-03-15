# Compose

AI-powered product lifecycle orchestrator. Compose takes a product idea from intent to shipped code through structured, agent-driven pipelines with human gates at every critical decision point.

Compose coordinates multiple AI agents (Claude, Codex) through YAML-defined workflows powered by [Stratum](https://github.com/your-org/stratum), enforcing postconditions, retrying on failure, and producing auditable execution traces.

## Table of Contents

- [How It Works](#how-it-works)
- [Installation and Setup](#installation-and-setup)
- [CLI Commands](#cli-commands)
- [Web UI — Cockpit Shell](#web-ui--cockpit-shell)
- [The Kickoff Pipeline (new)](#the-kickoff-pipeline)
- [The Build Pipeline (build)](#the-build-pipeline)
- [Agent Connectors](#agent-connectors)
- [Questionnaire System](#questionnaire-system)
- [Gate System](#gate-system)
- [Validation System](#validation-system)
- [Pipeline CLI](#pipeline-cli)
- [Recovery Logic](#recovery-logic)
- [Progress Logging](#progress-logging)
- [Result Normalization and JSON Extraction](#result-normalization-and-json-extraction)
- [Vision Writer Integration](#vision-writer-integration)
- [Configuration Files](#configuration-files)
- [MCP Server](#mcp-server)
- [Pipeline Specs](#pipeline-specs)
- [Examples and Workflows](#examples-and-workflows)

---

## How It Works

Compose is a CLI that orchestrates AI agents through multi-step workflows defined in `.stratum.yaml` pipeline specs. Each step dispatches a prompt to an agent (Claude or Codex), collects the result, validates postconditions, and advances to the next step. Human gates pause the pipeline for approve/revise/kill decisions. If postconditions fail, Compose runs a fix pass with a different agent and retries.

```
compose new "REST API for todo lists"
  -> questionnaire (interactive)
  -> research (claude)
  -> brainstorm (claude)
  -> [human gate] approve/revise/kill
  -> roadmap (claude)
  -> [human gate]
  -> scaffold (claude)
  -> done: feature folders + ROADMAP.md ready

compose build FEAT-1
  -> explore & design (claude)
  -> [human gate]
  -> blueprint (claude)
  -> verification (claude)
  -> plan (claude)
  -> [human gate]
  -> execute / TDD (claude)
  -> review (codex) + fix loop
  -> coverage sweep (claude) + fix loop
  -> docs update (claude)
  -> ship (claude)
  -> [human gate]
  -> done: feature implemented, tested, documented
```

---

## Installation and Setup

### Prerequisites

- Node.js 18+
- `stratum-mcp` on PATH (`pip install stratum-mcp`)
- For Codex steps: `opencode` CLI (`brew install opencode`) with OpenAI credentials configured (`opencode auth login` or set `OPENAI_API_KEY`)

### Project-local setup (`compose init`)

Run from inside your project directory:

```bash
cd /path/to/your/project
npx compose init
```

This:
1. Creates `.compose/` directory with `compose.json` config
2. Creates `.compose/data/` for vision state
3. Detects installed agents (Claude, Codex, Gemini)
4. Registers `compose-mcp` in `.mcp.json`
5. Scaffolds `ROADMAP.md` from template (if absent)
6. Copies default pipeline specs to `pipelines/`
7. Installs the Stratum skill to detected agents

Flags:
- `--no-stratum` -- disable Stratum integration
- `--no-lifecycle` -- disable lifecycle tracking

### Global setup (`compose setup`)

Installs the `/compose` skill globally and registers `stratum-mcp`:

```bash
npx compose setup
```

This:
1. Copies the `/compose` skill to `~/.claude/skills/compose/`
2. Installs the Stratum skill to all detected agents
3. Registers `stratum-mcp` with Claude Code (if available)

### Global CLI via ~/bin

To use `compose` as a global command:

```bash
ln -s /path/to/compose/bin/compose.js ~/bin/compose
chmod +x ~/bin/compose
```

### Backwards compatibility

`compose install` runs both `init` and `setup` in sequence.

---

## CLI Commands

### `compose new`

Kickoff a new product. Runs the full kickoff pipeline: research, brainstorm, roadmap, and scaffold.

```bash
compose new "Structured log analyzer CLI for JSON-lines files"
compose new "REST API for managing team todo lists" --auto
compose new "OAuth2 provider library" --ask
```

**Arguments:**
- First argument: product description (quoted string)
- `--auto` -- skip the questionnaire entirely
- `--ask` -- re-run the questionnaire (uses previous answers as defaults)

Auto-initializes the project if `.compose/` doesn't exist. Reads existing context from `README.md`, `package.json`, `pyproject.toml`, `Cargo.toml`, and any prior `project-analysis.md` from `compose import`.

### `compose import`

Scan an existing project and generate a structured analysis at `docs/discovery/project-analysis.md`.

```bash
cd existing-project
compose import
```

Walks the file tree (max depth 4, ignoring `node_modules`, `.git`, etc.), reads key files (`README.md`, `package.json`, config files, top-level source files), and dispatches Claude to produce:
- Project overview (what it does, language, maturity)
- Architecture map
- Feature inventory with suggested codes
- Patterns and conventions
- Gaps and opportunities
- Suggested roadmap

The generated analysis is automatically consumed by `compose new` and `compose build` as context.

### `compose feature`

Add a single feature to the project with a folder structure, seed design doc, and ROADMAP entry.

```bash
compose feature LOG-1 "CLI tool for parsing JSON-lines log files"
compose feature AUTH-2 "Add OAuth2 login flow with PKCE"
```

Creates:
- `docs/features/<CODE>/design.md` -- seed design doc with status, date, intent
- Appends a row to `ROADMAP.md` with the feature code and PLANNED status
- Updates the project description in ROADMAP if still placeholder

### `compose build`

Run a feature through the headless build lifecycle. This is the main execution command.

```bash
compose build FEAT-1
compose build --abort        # abort the active build
compose build FEAT-1 --abort # abort a specific feature's build
```

Loads `pipelines/build.stratum.yaml`, starts a Stratum flow, and dispatches each step to the appropriate agent. Tracks active build state in `.compose/data/active-build.json` for resume/abort support. Only one build can be active at a time.

### `compose pipeline`

View and edit the build pipeline spec (`pipelines/build.stratum.yaml`).

```bash
compose pipeline show
compose pipeline set <step> --agent codex
compose pipeline set <step> --mode gate
compose pipeline set <step> --mode review
compose pipeline set <step> --retries 5
compose pipeline add --id lint --after execute --agent claude --intent "Run linter"
compose pipeline remove <step>
compose pipeline enable <step> [step...]
compose pipeline disable <step> [step...]
```

See [Pipeline CLI](#pipeline-cli) for full details.

### `compose init`

Project-local initialization. Creates `.compose/`, detects agents, registers MCP server, scaffolds ROADMAP and pipeline specs.

```bash
compose init
compose init --no-stratum
compose init --no-lifecycle
```

### `compose setup`

Global skill and MCP registration. Installs the `/compose` skill and Stratum skill to all detected agents.

```bash
compose setup
```

### `compose start`

Start the Compose app (supervisor with web UI, terminal, and API server).

```bash
compose start
COMPOSE_TARGET=/path/to/project compose start
```

---

## Web UI — Cockpit Shell

`compose start` opens a browser-based cockpit at `http://localhost:3001`. The cockpit replaces the old split-pane layout (agent stream left, canvas right) with a structured five-zone layout:

```
┌─────────────────────────────────────────────────────────────┐
│ Header │ [ViewTabs: Vision | Stratum | Docs]  [Controls]    │
├────────┬────────────────────────────────────┬───────────────┤
│        │                                    │               │
│Sidebar │          MAIN AREA                 │ Context Panel │
│(208px) │    (active view content)           │   (280px)     │
│        │                                    │               │
├────────┴────────────────────────────────────┴───────────────┤
│ AGENT BAR  (collapsed | expanded | maximized)               │
├─────────────────────────────────────────────────────────────┤
│ NOTIFICATION BAR  (hidden when empty)                       │
└─────────────────────────────────────────────────────────────┘
```

### Zones

| Zone | Component | Description |
|------|-----------|-------------|
| **Header** | `ViewTabs` | Tab switcher for Vision, Stratum, and Docs top-level views. Global theme and font controls. |
| **Sidebar** | `CockpitSidebar` → `AttentionQueueSidebar` | Fixed 208 px left panel. Attention-queue view: active build status, pending gates with inline Approve / Revise / Kill, blocked items sorted by priority, compact stats, global phase filter, and view navigation. |
| **Main Area** | driven by `ViewTabs` | Renders the active top-level view — Vision Surface (7 sub-views), Stratum flow panel, or Docs canvas. |
| **Context Panel** | `ContextPanel` | Collapsible 280 px right panel. Shows item detail, gate review, or artifact preview depending on selection. |
| **Agent Bar** | `AgentBar` | Always-present bottom panel for the agent stream. Three states (see below). |
| **Notification Bar** | `NotificationBar` | Thin dismissible alert strip. Hidden when there are no active notifications. |

### Attention-Queue Sidebar

The sidebar (`AttentionQueueSidebar`) replaces the old `AppSidebar` and organizes content by urgency:

| Section | Content |
|---------|---------|
| **Active Build** | Current step name, progress bar, and step counter (e.g. "Step 4 / 15") from `.compose/active-build.json`. Spinner while running; check / X icon on complete / error. |
| **Pending Gates** | Up to 3 pending gates with inline **Approve / Revise / Kill** buttons. "+ N more" badge when overflow. |
| **Attention Queue** | Blocked items and decisions, sorted by priority: `DECISION → PENDING_GATE → BLOCKED`. |
| **Phase Filter** | Multi-select chip row. Selection is **global** — applies to all views, not just the sidebar. |
| **Compact Stats** | Single-row totals: total items, in-progress, blocked, pending gates. |
| **View Nav** | 9 view buttons plus theme toggle and search. |

The phase filter state is owned by `App.jsx` (lifted from `VisionTracker`) to prevent duplicate WebSocket connections and ensure all views share the same filter.

### Agent Bar States

The agent bar is always present — it is not a view tab. Toggle between states with the chevron control at the right edge of the bar.

| State | Height | Content |
|-------|--------|---------|
| `collapsed` | ~36 px | Status dot, active tool name, elapsed time |
| `expanded` | 30–50 % of viewport (default 256 px, draggable) | Full message stream + chat input |
| `maximized` | Fills main area | Full stream; hides sidebar, main content, and context panel |

### Cockpit State Persistence

All cockpit layout preferences survive page reloads:

| `localStorage` key | Type | Default |
|--------------------|------|---------|
| `compose:viewTab` | `'vision' \| 'stratum' \| 'docs'` | `'vision'` |
| `compose:agentBarState` | `'collapsed' \| 'expanded' \| 'maximized'` | `'collapsed'` |
| `compose:agentBarHeight` | number (px) | `256` |
| `compose:contextPanel` | `'open' \| 'closed'` | `'open'` |
| `compose:fontSize` | number | `13` |
| `compose:theme` | `'light' \| 'dark'` | system default |

### Error Boundaries

The cockpit wraps the full shell in a `SafeModeBoundary`. Each zone additionally has a `PanelErrorBoundary` so a crash in one zone (e.g. the context panel) does not take down the rest of the UI.

---

## The Kickoff Pipeline

Defined in `pipelines/new.stratum.yaml`. Orchestrates product creation from intent to scaffolded feature folders.

### Steps

| # | Step | Agent | What It Does |
|---|------|-------|-------------|
| 1 | `research` | claude | Searches for prior art, existing tools, architectural patterns, risks. Writes to `docs/discovery/research.md`. Validated against criteria (>= 2 prior art entries, patterns, risks). |
| 2 | `brainstorm` | claude | Generates feature list with codes, user stories, 2-3 architecture options with trade-offs. Writes to `docs/discovery/brainstorm.md`. Validated (>= 3 features, user stories, architecture options). |
| 3 | `review_gate` | human | Gate: approve brainstorm, revise (loop back to brainstorm), or kill. Displays the brainstorm artifact for review. Timeout: 2 hours. |
| 4 | `roadmap` | claude | Structures brainstorm into phased ROADMAP.md with feature table. Validated (markdown table, phased features, PLANNED status). |
| 5 | `roadmap_gate` | human | Gate: approve roadmap, revise, or kill. Timeout: 1 hour. |
| 6 | `scaffold` | claude | Creates `docs/features/<CODE>/design.md` for each ROADMAP feature with seed content. |

### Contracts

- `ResearchResult`: `{ priorArt, patterns, risks, summary }`
- `BrainstormResult`: `{ features, userStories, archOptions, summary }`
- `RoadmapResult`: `{ phases, features, summary, artifact }`
- `ScaffoldResult`: `{ created, summary }`

### Skipping Research

The questionnaire can disable research. When skipped, the `research` step gets `skip_if: "true"` injected into the spec before planning.

---

## The Build Pipeline

Defined in `pipelines/build.stratum.yaml`. Executes a feature through the full development lifecycle.

### Steps

| # | Step | Agent | What It Does |
|---|------|-------|-------------|
| 1 | `explore_design` | claude | Explores codebase, writes design doc to `docs/features/{code}/design.md` |
| 2 | `design_gate` | human | Approve design, revise (loop to explore_design), or kill. Timeout: 1h |
| 3 | `prd` | claude | Write PRD. **Skipped by default** -- enable via `compose pipeline enable prd` |
| 4 | `architecture` | claude | Architecture doc with competing proposals. **Skipped by default** |
| 5 | `blueprint` | claude | Implementation blueprint with file:line references. Retries: 3 |
| 6 | `verification` | claude | Verify all blueprint references against actual code. `on_fail: blueprint` loops back if stale |
| 7 | `plan` | claude | Ordered implementation plan with tasks, deps, file paths, acceptance criteria |
| 8 | `plan_gate` | human | Approve plan, revise (loop to plan), or kill. Timeout: 1h |
| 9 | `execute` | claude | TDD implementation: write test, watch fail, implement, watch pass |
| 10 | `review` | codex (sub-flow) | Codex reviews implementation against blueprint. Retries: 10. Cross-agent fix: claude fixes, codex re-reviews |
| 11 | `coverage` | claude (sub-flow) | Run tests, fix failures, re-run. Retries: 15 |
| 12 | `report` | claude | Post-implementation report. **Skipped by default** |
| 13 | `docs` | claude | Update CHANGELOG, README, ROADMAP, CLAUDE.md |
| 14 | `ship` | claude | Final verification, run tests, commit |
| 15 | `ship_gate` | human | Final approval. Timeout: 30min |

### Sub-flows

**`review_check`**: Single-step codex review. Returns `{ clean, summary, findings }`. Retries until `clean == true` (max 10). When postconditions fail, the build runner dispatches a claude fix pass before the next codex review iteration.

**`coverage_check`**: Single-step test runner. Returns `{ passing, summary, failures }`. Retries until `passing == true` (max 15). Fix pass dispatched on failure.

### Contracts

- `PhaseResult`: `{ phase, artifact, outcome, summary }` -- `outcome` is one of `complete`, `skipped`, `failed`
- `ReviewResult`: `{ clean, summary, findings }`
- `TestResult`: `{ passing, summary, failures }`

### on_fail Routing

The `verification` step has `on_fail: blueprint` -- when retries are exhausted without valid references, the pipeline routes back to the blueprint step for a rewrite.

---

## Agent Connectors

Compose dispatches work to AI agents through a connector abstraction. All connectors implement the same async generator interface yielding typed message envelopes.

### Message Envelope

```js
{ type: 'system',    subtype: 'init' | 'complete', agent: string, model?: string }
{ type: 'assistant', content: string }
{ type: 'tool_use',  tool: string, input: object }
{ type: 'tool_use_summary', summary: string }
{ type: 'tool_progress', tool: string, elapsed: number }
{ type: 'result',    content: string }
{ type: 'error',     message: string }
```

### ClaudeSDKConnector

Wraps `@anthropic-ai/claude-agent-sdk`'s `query()` function. Default model: `claude-sonnet-4-6` (override via `CLAUDE_MODEL` env var). Runs in `acceptEdits` permission mode with full `claude_code` tool access.

Key behaviors:
- Strips `CLAUDECODE` env var to allow spawning nested Claude Code sessions
- Normalizes SDK messages (assistant content blocks, tool_use, deltas) into the shared envelope
- Supports `interrupt()` to abort the active query
- Schema injection via `injectSchema()` for structured output

### CodexConnector

Extends `OpencodeConnector`, locked to OpenAI Codex models. Requires the `opencode` CLI (`brew install opencode`). Auth via `OPENAI_API_KEY` env var or `opencode auth login` for OAuth.

Supported models: `gpt-5.4`, `gpt-5.2-codex`, `gpt-5.1-codex-max`, `gpt-5.1-codex`, `gpt-5.1-codex-mini` (with `/low`, `/medium`, `/high`, `/xhigh` effort suffixes). Default: `gpt-5.4` (override via `CODEX_MODEL` env var).

### OpencodeConnector

Model-agnostic base for any non-Anthropic agent running through the OpenCode SDK. Manages a singleton `opencode serve` subprocess (one per process, shared across instances). Creates sessions, sends prompts, and streams SSE events.

### AgentConnector (base class)

Abstract base with `run()`, `interrupt()`, and `isRunning`. Subclasses must implement `run()` as an async generator. Also exports `injectSchema(prompt, schema)` which appends JSON Schema instructions to prompts.

### Agent Registry

The build runner maps agent names to connector factories:

```
claude -> ClaudeSDKConnector
codex  -> CodexConnector
```

The connector factory is injectable for testing via `opts.connectorFactory`.

---

## Questionnaire System

Interactive pre-flight for `compose new`. Runs automatically on first invocation, then only with `--ask`. Skip entirely with `--auto`.

### Questions Asked

1. **Refine description** -- text input with previous answer as default
2. **Project type** -- CLI tool, Web API, Library/SDK, Full-stack app, Other
3. **Language/runtime** -- Node.js (JS), Node.js (TS), Python, Go, Rust, Other
4. **Scope** -- Small (1-3 features), Medium (3-8), Large (8+)
5. **Research** -- yes/no: research prior art before brainstorming?
6. **Additional context** -- multiline free-form notes
7. **Review agent** -- Human (gate prompt), Codex (automated review), Skip review
8. **Confirm** -- summary + launch confirmation

### Answer Persistence

Answers are saved to `.compose/questionnaire.json`. On subsequent runs:
- Without `--ask`: saved answers are loaded silently to enrich the intent
- With `--ask`: saved answers appear as defaults (press Enter to keep)

### Pipeline Customization

The review agent choice modifies the pipeline:
- "Codex (automated review)" sets the `review_gate` to `--mode review`
- "Skip review" disables the `review_gate` step

### Enriched Intent

The questionnaire output is an enriched intent string combining:
- Refined description
- Project constraints (type, language, scope)
- Additional context notes
- Any existing project context (README, package.json, project-analysis.md)

---

## Gate System

Gates pause the pipeline for human decisions. Three outcomes:

| Key | Outcome | Effect |
|-----|---------|--------|
| `a` | **approve** | Proceed to `on_approve` step |
| `r` | **revise** | Loop back to `on_revise` step |
| `k` | **kill** | Terminate the flow |

### Conversation Mode

If the user types anything other than `a`/`r`/`k`, it's collected as a note/question. The user can ask questions or provide feedback before making their decision. Notes are included in the rationale sent to Stratum.

```
Gate: review_gate
  [a]pprove -> roadmap
  [r]evise  -> brainstorm
  [k]ill    -> (terminate)
  Or type a question/comment to discuss before deciding.

> What about error handling for edge cases?
  (noted -- enter a/r/k when ready to decide)
> The feature list looks comprehensive
  (noted -- enter a/r/k when ready to decide)
> a
  Notes collected: 2
  Additional rationale (or Enter to use notes):
```

### Rationale

A rationale is always required. If notes were collected during conversation mode, they serve as the rationale. Otherwise, the user is prompted explicitly.

### Gate Definitions in Specs

```yaml
functions:
  design_gate:
    mode: gate
    timeout: 3600   # seconds

steps:
  - id: design_gate
    function: design_gate
    on_approve: plan        # proceed to this step
    on_revise: explore_design  # loop back
    on_kill: null           # null = terminate flow
```

### Artifact Display

Before gate prompts in the `new` pipeline, the artifact produced by the prior step is displayed so the user can make an informed decision. For short documents (<= 80 lines), the full content is shown; for longer ones, the first 60 lines plus a truncation notice.

---

## Validation System

Agent-as-validator: after a step writes its artifact, a separate lightweight agent call reads the artifact and checks it against criteria defined in the pipeline spec.

### How It Works

1. The pipeline spec defines `validate` on a step:
   ```yaml
   - id: brainstorm
     validate:
       artifact: docs/discovery/brainstorm.md
       criteria:
         - "Contains at least 3 features with short codes"
         - "Contains user stories in 'As a...' format"
         - "Contains at least 2 architecture options"
   ```
2. After the step completes, the validator dispatches a fresh Claude call with a prompt asking it to read the artifact and check each criterion.
3. The validator returns `{ valid: boolean, issues: string[] }`.
4. If `valid` is false, a fix agent (claude) is dispatched to fix all issues, then the pipeline continues.
5. If the validator can't extract structured JSON, it optimistically assumes valid (no crash).

### Criteria

Criteria are human-readable strings. The validator agent interprets them and returns a boolean judgment per criterion. This means validation is semantic, not syntactic -- "Contains at least 3 features" is checked by an agent reading the document, not by a regex.

---

## Pipeline CLI

`compose pipeline` provides full control over `pipelines/build.stratum.yaml`.

### `show`

Pretty-prints the pipeline with color-coded step types:
- Green: agent steps (with ensure count, retries, on_fail)
- Yellow: gate steps (with timeout)
- Cyan: flow steps (sub-flow name, inner steps, agent)
- Gray: skipped steps (with reason)

Also shows sub-flow details and contracts.

### `set`

Modify step properties:

```bash
# Change which agent executes a step
compose pipeline set execute --agent codex

# Convert a step to a human gate
compose pipeline set review --mode gate

# Convert a step to a codex review sub-flow
compose pipeline set review --mode review
# Creates a review_check sub-flow with codex agent, ReviewResult contract,
# ensure "result.clean == True", retries 10

# Convert back to a regular agent step
compose pipeline set review --mode agent

# Set retry count
compose pipeline set blueprint --retries 5
```

### `add`

Insert a new step after an existing one:

```bash
compose pipeline add --id lint --after execute --agent claude --intent "Run linter and fix issues"
```

Creates a step with default `PhaseResult` output contract, 2 retries, and `depends_on: [<after>]`. Rewires the next step's dependencies.

### `remove`

Remove a step and rewire dependencies:

```bash
compose pipeline remove prd
```

Steps that depended on the removed step inherit its dependencies. Gate references (`on_approve`, `on_revise`, `on_fail`) are also rewired.

### `enable` / `disable`

```bash
compose pipeline enable prd architecture report  # remove skip_if
compose pipeline disable prd                      # set skip_if: "true"
```

---

## Recovery Logic

When a step's postconditions fail (`ensure_failed` or `schema_failed`), Compose runs a two-phase recovery:

### 1. Fix Pass

A fix agent is dispatched with the violations:

```
Fix step "review" -- postconditions failed:
- result.clean == True
Fix every issue. Do not skip any.
```

For codex steps, the fix pass goes to **claude** (cross-agent fix). For claude steps, the fix is same-agent but with a distinct prompt focused on fixing.

### 2. Retry

After the fix pass, the original step is retried with a retry prompt that includes both the original intent and the violations:

```
RETRY -- Previous attempt failed postconditions:
- result.clean == True
Fix these issues and try again.
[original step prompt]
```

### Retry Limits

Each step has a `retries` count (set in the pipeline spec). The review sub-flow defaults to 10 retries; coverage defaults to 15. When retries are exhausted, `on_fail` routing kicks in (if configured), or the step fails.

### on_fail Routing

Steps can specify `on_fail: <step-id>` to route to a different step when retries are exhausted. The `verification` step uses `on_fail: blueprint` to loop back for a blueprint rewrite.

---

## Progress Logging

During agent execution, Compose streams tool_use events to stderr so the user sees activity:

```
[1/6] research...
    -> Bash: rg "todo" --type js
    -> Read: /path/to/file.js
    -> Write: docs/discovery/research.md
  [checkmark] Wrote docs/discovery/research.md (45 lines) -- Prior Art Research
```

Event types logged:
- `tool_use`: Shows tool name and a shortened detail (command, pattern, query, or file_path -- max 60 chars)
- `tool_use_summary`: Shows summary text (max 80 chars)
- `tool_progress`: Shows tool name and elapsed time in seconds

Enable verbose event logging with `COMPOSE_DEBUG=1`.

---

## Result Normalization and JSON Extraction

The result normalizer (`lib/result-normalizer.js`) bridges the gap between streaming agent text and structured step results.

### Schema Injection

When a step has `output_fields`, the normalizer:
1. Converts Stratum's flat type map (`{ clean: "boolean", findings: "array" }`) to JSON Schema
2. Injects schema instructions into the prompt via `injectSchema()`
3. The agent sees: "include a JSON code block at the very end of your response matching this schema"

### JSON Extraction

After the agent completes, the normalizer tries three extraction strategies in order:

1. **Full text parse** -- the entire output is valid JSON
2. **Fenced block** -- extract from ` ```json ... ``` `
3. **Balanced braces** -- find the first `{` and its matching `}`, parse the substring

If all strategies fail, a warning is logged and a fallback `{ summary: "..." }` is returned (first 200 chars of output). The pipeline does not crash.

### Error Handling

- `AgentError` -- thrown when the agent yields an error event
- `ResultParseError` -- thrown when JSON extraction fails (includes raw text for debugging)

---

## Vision Writer Integration

The `VisionWriter` (`lib/vision-writer.js`) maintains `.compose/data/vision-state.json` with atomic read-modify-write operations (POSIX rename).

### What It Tracks

- **Feature items**: Each feature gets a vision item with id, type, title, status, phase, featureCode, slug, confidence, timestamps
- **Phase updates**: As each step executes, the item's `lifecycle.currentPhase` is updated
- **Gate entries**: Each gate creates a record with flowId, stepId, itemId, status, timestamps
- **Gate resolutions**: Outcome (approve/revise/kill) and resolution timestamp

### Lookup Conventions

Supports both `feature:CODE` (seed convention) and `lifecycle.featureCode` (lifecycle-manager convention) for feature item lookup.

### Status Transitions

```
planned -> in_progress -> complete
planned -> in_progress -> killed
```

---

## Configuration Files

### `.compose/compose.json`

Project-level configuration. Created by `compose init`.

```json
{
  "version": 2,
  "capabilities": {
    "stratum": true,
    "lifecycle": true
  },
  "agents": {
    "claude": { "detected": true, "skillInstalled": true },
    "codex": { "detected": true, "skillInstalled": true },
    "gemini": { "detected": false }
  },
  "paths": {
    "docs": "docs",
    "features": "docs/features",
    "journal": "docs/journal"
  }
}
```

### `.compose/questionnaire.json`

Saved questionnaire answers (enriched intent, project type, language, scope, research preference, notes, review agent choice).

### `.compose/data/vision-state.json`

Vision tracker state: items, connections, gates. Managed by `VisionWriter`. Atomic writes via temp file + rename.

### `.compose/data/active-build.json`

Active build state for resume/abort:

```json
{
  "featureCode": "FEAT-1",
  "flowId": "uuid",
  "startedAt": "2026-03-11T...",
  "currentStepId": "blueprint",
  "specPath": "pipelines/build.stratum.yaml"
}
```

### `pipelines/build.stratum.yaml`

The build pipeline spec. Editable via `compose pipeline` or by hand. See [The Build Pipeline](#the-build-pipeline).

### `pipelines/new.stratum.yaml`

The kickoff pipeline spec. See [The Kickoff Pipeline](#the-kickoff-pipeline).

### `.mcp.json`

MCP server registration. `compose init` adds:

```json
{
  "mcpServers": {
    "compose": {
      "command": "node",
      "args": ["<compose-root>/server/compose-mcp.js"]
    }
  }
}
```

### `ROADMAP.md`

Scaffolded from `templates/ROADMAP.md` with project name, date, and placeholder phases. Updated by `compose feature` and the build pipeline.

---

## MCP Server

Compose exposes project state as MCP tools via `server/compose-mcp.js` (stdio transport). Registered in `.mcp.json` by `compose init`. Available tools:

| Tool | Description |
|------|-------------|
| `get_vision_items` | Query items by phase, status, type, keyword |
| `get_item_detail` | Full item detail with connections |
| `get_phase_summary` | Status/type distribution per phase |
| `get_blocked_items` | Items blocked by non-complete dependencies |
| `get_current_session` | Active session context (tool count, items touched) |
| `bind_session` | Bind agent session to a lifecycle feature |
| `get_feature_lifecycle` | Feature lifecycle state, phase history, artifacts |
| `kill_feature` | Kill a feature with reason |
| `complete_feature` | Mark feature complete (ship phase only) |
| `assess_feature_artifacts` | Quality signals for feature artifacts |
| `scaffold_feature` | Create feature folder with template stubs |
| `approve_gate` | Resolve a pending gate (approved/revised/killed) |
| `get_pending_gates` | List pending gates |

---

## Pipeline Specs

Compose ships with five pipeline specs in `pipelines/`:

| Spec | Flow | Purpose |
|------|------|---------|
| `new.stratum.yaml` | `new` | Product kickoff: research, brainstorm, roadmap, scaffold |
| `build.stratum.yaml` | `build` | Feature lifecycle: design through ship |
| `review-fix.stratum.yaml` | `review_fix` | Two-phase loop: implement then review/fix until clean |
| `coverage-sweep.stratum.yaml` | `coverage_sweep` | Test loop: run tests, fix failures until passing |
| `compose_feature.stratum.yaml` | `compose_feature` | Legacy function-based lifecycle spec |

### Stratum IR v0.3

Specs use Stratum IR v0.3 format (backward-compatible superset of v0.2). All existing v0.2 specs run unchanged. Specs that use v0.3 features declare `ir_version: "0.3"` at the top level.

**v0.2 primitives (all retained):**
- **contracts**: Output shape definitions with typed fields
- **functions**: Reusable compute/gate definitions with retries and postconditions
- **flows**: Step graphs with dependencies, routing, sub-flows
- **ensure expressions**: Python-like postconditions (`result.clean == True`, `file_exists(path)`)
- **input expressions**: Data flow between steps (`$.input.x`, `$.steps.prev.output.y`)
- **skip_if / skip_reason**: Conditional step skipping

**v0.3 additions (STRAT-PAR-1):**
- **`decompose` step type**: the agent emits a **TaskGraph** — an array of tasks, each with `files_owned` (write set), `files_read` (read set), and `depends_on` (dependency list). Used to break a sequential step into independent subtasks before parallel execution.
- **`parallel_dispatch` step type**: consumes a TaskGraph and coordinates concurrent agent runs. Fields: `require` (upstream TaskGraph reference), `max_concurrent` (concurrency cap), `isolation` (`worktree` | `none`), `merge` (`squash` | `rebase` | `none`), and `intent_template` (per-task prompt template).

---

## Examples and Workflows

### Start a new project from scratch

```bash
mkdir my-cli-tool && cd my-cli-tool
compose new "CLI tool that converts CSV files to JSON with filtering and validation"
# Answer questionnaire questions
# Approve brainstorm at gate
# Approve roadmap at gate
# Feature folders scaffolded

compose build CSV-1  # build the first feature
```

### Add a feature to an existing project

```bash
cd existing-project
compose import                           # scan and analyze
compose feature AUTH-1 "JWT auth middleware with refresh tokens"
compose build AUTH-1
```

### Customize the pipeline before building

```bash
compose init
compose pipeline show                    # see default pipeline
compose pipeline enable prd architecture # enable optional phases
compose pipeline set review --agent codex --retries 5
compose pipeline add --id lint --after execute --agent claude --intent "Run ESLint and fix issues"
compose build FEAT-1
```

### Skip research for a well-understood project

```bash
compose new "Internal admin dashboard for existing API" --ask
# At "Research prior art?" question, answer: n
```

### Use automated review instead of human gates

```bash
compose new "microservice template" --ask
# At "Who should review?" question, choose: Codex (automated review)
```

### Abort a stuck build

```bash
compose build --abort
```

### View pipeline state

```bash
compose pipeline show
```

Output:
```
  Pipeline: build (15 steps)

   1. explore_design  agent  agent: claude [2 ensures] (retries: 2)
   2. design_gate     gate   human gate (timeout: 3600s)
   3. prd             skip   PRD skipped by default
   4. architecture    skip   Architecture skipped by default
   5. blueprint       agent  agent: claude [2 ensures] (retries: 3)
   6. verification    agent  agent: claude [1 ensures] (retries: 2) -> on_fail: blueprint
   7. plan            agent  agent: claude [2 ensures] (retries: 2)
   8. plan_gate       gate   human gate (timeout: 3600s)
   9. execute         agent  agent: claude (retries: 2)
  10. review          flow   review_check: review (agent: codex)
  11. coverage        flow   coverage_check: run_tests (agent: claude)
  12. report          skip   Report skipped by default
  13. docs            agent  agent: claude (retries: 2)
  14. ship            agent  agent: claude (retries: 2)
  15. ship_gate       gate   human gate (timeout: 1800s)
```

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Default model for ClaudeSDKConnector |
| `CODEX_MODEL` | `gpt-5.4` | Default model for CodexConnector |
| `COMPOSE_DEBUG` | (unset) | Enable verbose event logging to stderr |
| `COMPOSE_TARGET` | (unset) | Override project root for `compose start` |
