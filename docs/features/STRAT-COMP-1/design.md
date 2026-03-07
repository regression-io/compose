# STRAT-COMP-1: Skill Prompt + Headless Runner + Init Upgrade

**Date:** 2026-03-07
**Status:** Design
**Parent:** [STRAT-1 Design](../STRAT-1/design.md) (Milestone 2, item 44)
**Contract:** [Stratum Contract Freeze](../STRAT-1/stratum-contract.md)

## Related Documents

- [STRAT-1 Design](../STRAT-1/design.md) — parent feature, full architecture
- [INIT-1 Design](../INIT-1/design.md) — current init implementation
- [Stratum Contract](../STRAT-1/stratum-contract.md) — frozen MCP tool signatures, IR v0.2 schema

---

## Problem

Compose has three gaps that prevent headless feature execution:

1. **No universal agent skill.** Agents (Claude, Codex, Gemini) don't know how to participate in Stratum workflows. Each agent needs to understand IR v0.2, MCP tool usage, and how to report structured results. Today the compose skill teaches `/compose` invocation — it doesn't teach Stratum participation.

2. **No `compose build` command.** The CLI has `init`, `setup`, `start`. There's no way to execute a feature lifecycle without the UI server running. The `agent_run` MCP tool and connectors exist, but nothing orchestrates the full loop: load spec → dispatch steps to agents → enforce gates → write artifacts.

3. **`compose init` doesn't detect or install agent skills.** It detects `stratum-mcp` and creates `.compose/compose.json`, but doesn't detect which AI agents are available or install skills to their directories.

## Goal

After STRAT-COMP-1:

```
compose init           # detects agents, installs stratum skill to each, questionnaire
compose build FEAT-1   # headless: spec → stratum → agents → gates → artifacts
```

No server required. Vision state written directly to disk. Gates resolved via CLI prompt.

---

## Deliverable 1: Stratum Skill Prompt

A single markdown document that teaches any AI agent how to be a participant in Stratum-orchestrated workflows. Installed per agent.

### Content

The skill document covers:

1. **IR v0.2 format reference** — step types (inline, function, flow), field meanings, how `ensure` expressions work
2. **MCP tool patterns** — how `stratum_plan`/`stratum_step_done`/`stratum_gate_resolve`/`stratum_audit` work together in a loop
3. **Structured result reporting** — how to return JSON that satisfies `ensure` expressions and `output_schema` contracts
4. **Example specs** — simple linear, review loop, multi-agent with `on_fail`/`next`, composed workflows with `flow:`
5. **Step execution contract** — when you receive a step dispatch, what fields to read (`intent`, `inputs`, `ensure`, `agent`), what to return

### Installation Targets

| Agent | Skill directory | Detection |
|---|---|---|
| Claude Code | `~/.claude/skills/stratum/SKILL.md` | `which claude` or `~/.claude/` exists |
| Codex | `~/.codex/skills/stratum/SKILL.md` | `which opencode` or `~/.codex/` exists |
| Gemini | `~/.gemini/skills/stratum/SKILL.md` | `which gemini-cli` or `~/.gemini/` exists |

The skill is agent-agnostic — identical content for all agents. Agent-specific details (tool availability, model defaults) are runtime concerns, not skill concerns.

### Source Location

`skills/stratum/SKILL.md` in the compose package. `compose init` copies it to detected agent directories. `compose setup` does the same for global (non-project) installation.

### Verification

Give the skill to an agent cold, ask it to author a spec from scratch. If the agent can produce a valid `.stratum.yaml` and execute it via MCP tools, the skill works.

---

## Deliverable 2: `compose build` — Headless Lifecycle Runner

### Overview

`compose build [FEAT-CODE]` executes a feature through the Stratum lifecycle without the UI server.

```
compose build FEAT-1
  1. Load feature: read spec.md or design.md from docs/features/FEAT-1/
  2. Load lifecycle spec: pipelines/compose_feature.stratum.yaml (or v0.2 upgrade)
  3. Plan: call stratum_plan with spec + feature inputs
  4. Loop: for each step dispatch, route to the assigned agent via connector
  5. Gates: suspend, prompt user in terminal, call stratum_gate_resolve
  6. Track: write artifacts to feature folder, update vision-state.json on disk
  7. Audit: call stratum_audit on completion, write trace to feature folder
```

### Architecture

```
bin/compose.js          — CLI entry, adds "build" command
  └─ lib/build.js       — headless runner (new file)
       ├─ reads .compose/compose.json for config
       ├─ loads spec from feature folder
       ├─ calls stratum MCP tools (via stratum-client.js or direct subprocess)
       ├─ dispatches to agents via connectors (claude-sdk-connector, codex-connector)
       ├─ gates: readline prompt in terminal
       ├─ writes vision-state.json directly (no HTTP)
       └─ writes audit trace to docs/features/<code>/audit.json
```

### Stratum Communication

Two options for talking to stratum-mcp from the headless runner:

**Option A: Subprocess MCP (preferred).** Spawn `stratum-mcp` as a child process with stdio transport. Use the MCP SDK client to call tools. Same pattern as `agent-mcp.js` but in reverse — compose is the client.

**Option B: Direct Python import.** Call `stratum-mcp` CLI commands (`stratum-mcp query`, `stratum-mcp gate`). Simpler but loses structured responses.

**Decision: Option A.** The MCP SDK provides typed request/response. The compose MCP server already demonstrates this pattern. We spawn `stratum-mcp` as stdio, use `@modelcontextprotocol/sdk/client` to call `stratum_plan`, `stratum_step_done`, etc.

### Step Dispatch Loop

```
response = stratum_plan(spec, flow, inputs)

while response.status !== 'complete' && response.status !== 'killed':
    if response.status === 'execute_step':
        // Route to agent
        agent = response.agent ?? 'claude'
        prompt = buildStepPrompt(response)  // intent + inputs + ensure context
        result = await runAgent(agent, prompt, response)
        response = stratum_step_done(flow_id, step_id, result)

    else if response.status === 'await_gate':
        // CLI prompt
        outcome = await promptGate(response)
        response = stratum_gate_resolve(flow_id, step_id, outcome, rationale, 'human')

    else if response.status === 'execute_flow':
        // Recursive: execute child flow, then step_done on parent
        childResult = await executeFlow(response.child_flow_id, response.child_step)
        response = stratum_step_done(parent_flow_id, parent_step_id, childResult)

    else if response.status === 'ensure_failed' || response.status === 'schema_failed':
        // Retry: re-dispatch same step with violation context
        prompt = buildRetryPrompt(response)
        result = await runAgent(agent, prompt, response)
        response = stratum_step_done(flow_id, step_id, result)
```

### Agent Dispatch

Reuse existing connectors:

```js
import { ClaudeSDKConnector } from '../server/connectors/claude-sdk-connector.js';
import { CodexConnector } from '../server/connectors/codex-connector.js';

const KNOWN_AGENTS = new Map([
    ['claude', (opts) => new ClaudeSDKConnector(opts)],
    ['codex',  (opts) => new CodexConnector(opts)],
]);

function getConnector(agentType, opts) {
    const factory = KNOWN_AGENTS.get(agentType);
    if (!factory) {
        throw new Error(
            `compose build: step requires agent "${agentType}" but no connector is registered for it.\n` +
            `Known agents: ${[...KNOWN_AGENTS.keys()].join(', ')}\n` +
            `Check your .stratum.yaml spec or register the agent in compose.json.`
        );
    }
    return factory(opts);
}
```

The `agent` field from the step dispatch selects the connector. **Unknown agents fail fast** — no silent fallback. If a spec references an agent that isn't available, the runner errors immediately with the step ID and agent name so the user can fix the spec or install the agent.

### Result Normalization

Connectors stream text via `AsyncGenerator`. The headless runner needs a **result normalization layer** that sits between the connector and `stratum_step_done`. This is the same role `agent-mcp.js` plays in the MCP server path — schema injection into the prompt, text accumulation, and JSON parsing — but extracted as a reusable module.

```js
// lib/result-normalizer.js

/**
 * Run a connector and normalize the streamed output into a structured result.
 *
 * 1. If step has output_schema or output_fields, inject JSON schema instructions
 *    into the prompt (same pattern as injectSchema() in agent-connector.js)
 * 2. Accumulate all 'assistant' content from the stream
 * 3. Extract JSON from the accumulated text:
 *    a. Try JSON.parse() on the full text
 *    b. Try extracting a fenced ```json block
 *    c. Try extracting the first { ... } or [ ... ] balanced substring
 * 4. If output_schema is present and JSON extraction fails, throw with
 *    the raw text so the caller can build a retry prompt
 * 5. Return { text, result } — text is always the raw output,
 *    result is the parsed object (or null if no schema was expected)
 */
async function runAndNormalize(connector, prompt, stepDispatch) { ... }
```

This module is `lib/result-normalizer.js` — new file. It imports `injectSchema` from `agent-connector.js` for the schema injection, replicating the same contract that `agent-mcp.js:80-86` uses today.

The dispatch loop calls `runAndNormalize()` instead of calling connectors directly:

```js
const { result } = await runAndNormalize(connector, prompt, stepDispatch);
response = stratum_step_done(flow_id, step_id, result);
```

### Step Prompt Construction

Each step dispatch includes `intent`, `inputs`, `ensure`, and `output_contract`. The runner builds a prompt:

```
You are executing step "{step_id}" in a Stratum workflow.

## Intent
{intent}

## Inputs
{JSON.stringify(inputs, null, 2)}

## Expected Output
Return a JSON object with these fields:
{output_fields description}

## Postconditions
Your result must satisfy:
{ensure expressions listed}

## Context
Working directory: {cwd}
Feature: {featureCode}
```

For retry prompts, prepend violation context:

```
Previous attempt failed postconditions:
{violations listed}

Fix these issues and try again.
```

### Gate Resolution (Headless)

When `await_gate` is received, the runner prompts in the terminal:

```
Gate: {step_id}
  Approve → {on_approve}
  Revise  → {on_revise}
  Kill    → {on_kill}

[a]pprove / [r]evise / [k]ill: _
Rationale: _
```

Uses Node's `readline` — no server dependency.

### Flow Resume

Stratum persists active flows to `~/.stratum/flows/{flow_id}.json`. The headless runner must persist the active `flow_id` so interrupted builds can resume instead of creating duplicate flows.

**State file:** `.compose/data/active-build.json`

```json
{
    "featureCode": "FEAT-1",
    "flowId": "uuid",
    "startedAt": "2026-03-07T10:00:00Z",
    "currentStepId": "design",
    "specPath": "pipelines/build.stratum.yaml"
}
```

**Resume logic in `compose build`:**

1. On start, check `.compose/data/active-build.json`
2. If present and `featureCode` matches the requested feature:
   - Verify the flow still exists in Stratum (`stratum_audit(flow_id)`)
   - If flow is `in_progress`, resume from its current step
   - If flow is `complete` or `killed`, delete the state file and report
3. If present but `featureCode` differs, error: "Another build is active for {code}. Use `compose build --abort` to cancel it."
4. On flow completion (or kill), delete `active-build.json`
5. On each step transition, update `currentStepId` in `active-build.json`

**`compose build --abort`:** Cleans up both sides:

1. If the flow is at a gate step, kill via `stratum_gate_resolve(flow_id, step_id, 'kill', 'aborted by user', 'human')`.
2. Otherwise, delete the persisted flow file directly: `rm ~/.stratum/flows/{flow_id}.json`. The frozen Stratum contract exposes no MCP tool to kill an arbitrary non-gate flow — `stratum_gate_resolve` only works at gate steps, and `delete_persisted_flow()` is an internal Python helper. Direct file deletion is the only available mechanism for non-gate abort. **This is a known contract gap.** If Stratum adds a `stratum_kill_flow` tool post-freeze, abort should prefer it over file deletion.
3. Delete `active-build.json`.

Stratum has no TTL/expiry — flows persist indefinitely unless explicitly completed or killed, so abort must always clean up.

**`compose build --resume`:** Explicit resume — same as automatic resume but skips the "do you want to resume?" confirmation prompt.

### Vision State Updates (Disk-Direct)

The runner writes directly to `data/vision-state.json` (or `.compose/data/vision-state.json` per project config). No HTTP calls to the compose server.

**Vision state writer:** `lib/vision-writer.js` — new module that wraps `loadVisionState()` from `compose-mcp-tools.js` with write capability. Atomic writes (write to temp, rename) to avoid corruption from concurrent access with the UI server.

**Step-to-item mapping:** Two code paths currently use different `featureCode` fields:

- `feature-scan.js:93-106` writes **top-level** `item.featureCode = 'feature:<name>'` and looks up via `item.featureCode === featureKey`
- `vision-store.js:258-260` (`getItemByFeatureCode`) looks up via `item.lifecycle?.featureCode` — a **different nested field** set by the lifecycle manager

The headless runner uses a **transitional lookup** that checks both fields to avoid duplicating items that were created by the existing lifecycle manager:

```js
function findFeatureItem(items, featureCode) {
    const key = `feature:${featureCode}`;
    return items.find(i =>
        i.featureCode === key ||
        i.lifecycle?.featureCode === featureCode
    );
}
```

If no item is found by either field, the runner creates one with top-level `featureCode` set (the `seedFeatures()` convention). New items are never written with `lifecycle.featureCode` — that field is owned by the lifecycle manager which STRAT-COMP-2 removes.

**Why both fields:** `feature-scan.js:95` writes top-level `item.featureCode = 'feature:<name>'`. `lifecycle-manager.js` writes `item.lifecycle.featureCode = '<name>'` (no `feature:` prefix). Projects may have items created by either path. The transitional lookup handles both until STRAT-COMP-2 unifies them.

The resolved `itemId` is stored in `active-build.json` and used for all subsequent vision updates.

**Gate entries:** Gates in vision state use a composite ID `{flowId}:{stepId}` so they're traceable to the Stratum flow. The vision writer creates gate entries with `status: 'pending'` on `await_gate` and updates them on resolution — same shape as the existing `gates[]` array in vision state.

Updates happen at:
- **Build start:** item status → `in_progress`, item `lifecycle.currentPhase` → first step ID
- **Step start:** item `lifecycle.currentPhase` → step ID
- **Gate pending:** create gate entry in `gates[]` with `{flowId, stepId, itemId, status: 'pending'}`
- **Gate resolved:** update gate entry status + outcome
- **Flow complete:** item status → `complete`
- **Flow killed:** item status → `killed`

### Audit Trail

On flow completion (or kill), write `docs/features/<code>/audit.json` with the full `stratum_audit` response. This is the permanent record of the execution.

### Lifecycle Spec Upgrade

The current `pipelines/compose_feature.stratum.yaml` is IR v0.1 with `functions:` blocks. For STRAT-COMP-1, upgrade it to IR v0.2:

- Add `workflow:` declaration with `name: build`, `input: { featureCode: string, description: string }` (must match entry flow input keys per IR v0.2 contract)
- Convert to inline steps with `agent` field
- Add gate steps between design/plan/execute phases
- Add `on_fail`/`next` for review-fix loops
- Add `flow:` composition for review-fix sub-workflow

The v0.2 spec lives at `pipelines/build.stratum.yaml`. The old v0.1 specs are kept for backward compatibility.

---

## Deliverable 3: `compose init` Upgrade

### Current State

`compose init` (`bin/compose.js:41-122`):
1. Creates `.compose/` directory
2. Detects `stratum-mcp` via `which`
3. Writes `.compose/compose.json` with capabilities and paths
4. Registers `compose-mcp` in `.mcp.json`
5. Scaffolds `ROADMAP.md` from template

### Additions

**Agent detection:**

```js
function detectAgents() {
    const agents = [];

    // Claude Code
    if (commandExists('claude') || dirExists(join(homedir(), '.claude'))) {
        agents.push({ name: 'claude', skillDir: join(homedir(), '.claude', 'skills', 'stratum') });
    }

    // Codex (via opencode)
    if (commandExists('opencode') || dirExists(join(homedir(), '.codex'))) {
        agents.push({ name: 'codex', skillDir: join(homedir(), '.codex', 'skills', 'stratum') });
    }

    // Gemini CLI
    if (commandExists('gemini-cli') || dirExists(join(homedir(), '.gemini'))) {
        agents.push({ name: 'gemini', skillDir: join(homedir(), '.gemini', 'skills', 'stratum') });
    }

    return agents;
}
```

**Skill installation:** For each detected agent, copy `skills/stratum/SKILL.md` to the agent's skill directory.

**Questionnaire upgrade:** Add agent detection output and skill installation confirmation:

```
Detecting agents...
  + Claude Code — skill installed to ~/.claude/skills/stratum/
  + Codex — skill installed to ~/.codex/skills/stratum/
  - Gemini — not found

Enable lifecycle gates? (Y/n):
```

**Config update:** Add `agents` to `.compose/compose.json`:

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

### Interactive vs Non-Interactive

`compose init` gains a `--yes` / `-y` flag for non-interactive mode (accept all defaults). Interactive mode uses `readline` for the questionnaire.

---

## File Manifest

### New Files

| File | Purpose |
|---|---|
| `lib/build.js` | Headless lifecycle runner — the core of `compose build` |
| `lib/stratum-mcp-client.js` | MCP client wrapper for calling stratum-mcp via stdio |
| `lib/result-normalizer.js` | Stream-to-structured-result layer (schema injection, JSON extraction) |
| `lib/vision-writer.js` | Atomic vision-state.json writer with step-to-item mapping |
| `lib/gate-prompt.js` | CLI readline gate resolution |
| `lib/step-prompt.js` | Build agent prompts from step dispatch |
| `skills/stratum/SKILL.md` | Universal agent skill document |
| `pipelines/build.stratum.yaml` | IR v0.2 lifecycle spec with gates, agents, composition |

### Modified Files

| File | Change |
|---|---|
| `bin/compose.js` | Add `build` command dispatch, upgrade `init` with agent detection |

### Unchanged (reused)

| File | How it's used |
|---|---|
| `server/compose-mcp-tools.js` | `loadVisionState()` reused by `vision-writer.js` |
| `server/connectors/agent-connector.js` | `injectSchema()` reused by `result-normalizer.js` |
| `server/artifact-manager.js` | Feature folder scaffolding |
| `server/project-root.js` | Path resolution |

---

## Risks and Mitigations

### Risk: Stratum MCP client complexity
Spawning stratum-mcp as a subprocess and speaking MCP protocol adds complexity. **Mitigation:** The MCP SDK client is well-documented. If subprocess spawning is unreliable, fall back to `stratum-mcp` CLI commands with JSON output.

### Risk: Agent dispatch without server context
Connectors currently run inside the MCP server process. Running them from `compose build` means they need to work standalone. **Mitigation:** `ClaudeSDKConnector` uses `@anthropic-ai/claude-agent-sdk` directly — no server dependency. `CodexConnector` wraps `opencode` CLI — also standalone. Both already work without the compose server.

### Risk: Vision state concurrent writes
If the UI server is running while `compose build` writes vision state, there could be write conflicts. **Mitigation:** Use atomic write (write to temp file, rename). The server already reads from disk on each request, so it will pick up changes.

---

## What This Does NOT Include

- **STRAT-COMP-2 scope:** Deleting bespoke lifecycle code (lifecycle-manager.js, policy-engine.js). That's the next feature.
- **`compose roadmap` command.** Separate workflow spec, not part of STRAT-COMP-1.
- **`compose review` or `compose status` commands.** Future work.
- **UI integration.** The build runner works headless. UI remains unchanged.
- **Runtime policy overrides.** Not available per contract freeze (STRAT-ENG-6 section 6).

---

## Open Questions

1. **Gemini CLI skill path:** Is `~/.gemini/skills/` the correct convention? Need to verify Gemini CLI's skill discovery mechanism. For now, detect but don't install — log a warning.

2. **Step prompt richness:** How much context should each step prompt include? The design shows the minimal prompt. In practice, agents may need feature folder context, prior step outputs, and codebase-specific instructions. Start minimal, iterate based on proof run (STRAT-COMP-3).
