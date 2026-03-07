# STRAT-COMP-1: Implementation Plan

**Date:** 2026-03-07
**Design:** [design.md](./design.md)
**Contract:** [Stratum Contract Freeze](../STRAT-1/stratum-contract.md)

---

## Task Order

Dependencies flow top-to-bottom. Tasks within the same group are independent and parallelizable.

```
T1  Stratum skill prompt
T2  IR v0.2 lifecycle spec
    ──────────────────────
T3  Stratum MCP client
T4  Result normalizer
T5  Step prompt builder
T6  Gate prompt
T7  Vision writer
    ──────────────────────
T8  Build runner (core loop)
    ──────────────────────
T9  Init upgrade (agent detection + skill install)
T10 CLI wiring (build + init changes in bin/compose.js)
    ──────────────────────
T11 Integration test
```

---

## T1: Stratum Skill Prompt

**File:** `skills/stratum/SKILL.md` (new)

Write the universal agent skill document. Content sections:

- [ ] IR v0.2 format reference — `version`, `workflow`, `flows`, `steps`, `functions`, `contracts`
- [ ] Step types: inline (`intent`), function reference (`function`), sub-workflow (`flow`)
- [ ] Step fields: `agent`, `inputs`, `ensure`, `on_fail`, `next`, `skip_if`, `retries`, `max_iterations`
- [ ] Gate steps: `mode: gate`, `on_approve`/`on_revise`/`on_kill`, `policy`
- [ ] MCP tool loop: `stratum_plan` → `stratum_step_done` → repeat → `stratum_audit`
- [ ] Gate resolution: `stratum_gate_resolve` with outcome/rationale/resolved_by
- [ ] Iteration loop: `stratum_iteration_start` → `stratum_iteration_report` → repeat
- [ ] Structured result reporting: how to return JSON satisfying `ensure` and `output_schema`
- [ ] Example: simple 3-step linear spec
- [ ] Example: review-fix loop with `on_fail`/`next`
- [ ] Example: multi-agent spec with `agent` per step
- [ ] Example: composed workflow with `flow:` sub-execution

**Pattern:** Reference the contract freeze doc (`STRAT-ENG-6/design.md`) for exact field names and tool signatures. Do not invent — transcribe.

**Test:** Manual — give the skill to a fresh Claude session, ask it to write and validate a spec. Verify `stratum_validate` passes.

---

## T2: IR v0.2 Lifecycle Spec

**File:** `pipelines/build.stratum.yaml` (new)

Upgrade the lifecycle from v0.1 `compose_feature.stratum.yaml` to IR v0.2 with gates, agents, and composition.

- [ ] `version: "0.2"` with `workflow:` declaration (`name: build`, `input: { featureCode: string, description: string }`)
- [ ] Inline steps with `agent: claude` (design, plan, execute, report, docs, ship)
- [ ] Gate steps between design→plan and plan→execute with `on_approve`/`on_revise`/`on_kill`
- [ ] `flow: review_fix` composition step within execute phase (references `flows.review_fix` sub-workflow)
- [ ] `flow: coverage_sweep` composition step within execute phase
- [ ] `review_fix` sub-flow: inline steps with `agent: codex` for review, `agent: claude` for fix, `on_fail`/`next` loop
- [ ] `coverage_sweep` sub-flow: inline steps with `agent: claude` for test execution and fix
- [ ] `ensure` expressions: `file_exists(...)` for artifact phases, `result.clean == true` for review
- [ ] `skip_if` on optional phases (prd, architecture, report) matching `contracts/lifecycle.json` SKIPPABLE set
- [ ] `max_rounds: 10` on the top-level flow

**Pattern:** Follow IR v0.2 schema from `STRAT-ENG-6/design.md` section 1. Validate with `stratum-mcp validate pipelines/build.stratum.yaml`.

**Test:**
- [ ] `stratum-mcp validate pipelines/build.stratum.yaml` passes
- [ ] `stratum_plan` with mock inputs returns a valid first step dispatch

---

## T3: Stratum MCP Client

**File:** `lib/stratum-mcp-client.js` (new)

MCP client that spawns `stratum-mcp` (no subcommand) as a child process and calls tools via the MCP SDK. The stdio MCP server is the default entrypoint (`server.py:1510`) — `stratum-mcp serve` is the separate JSON API server and must NOT be used here.

- [ ] `connect()` — spawn subprocess, establish MCP client connection
- [ ] `close()` — kill subprocess, clean up
- [ ] `plan(spec, flow, inputs)` → calls `stratum_plan`, returns parsed response
- [ ] `stepDone(flowId, stepId, result)` → calls `stratum_step_done`
- [ ] `gateResolve(flowId, stepId, outcome, rationale, resolvedBy)` → calls `stratum_gate_resolve`
- [ ] `skipStep(flowId, stepId, reason)` → calls `stratum_skip_step`
- [ ] `audit(flowId)` → calls `stratum_audit`
- [ ] `iterationStart(flowId, stepId)` → calls `stratum_iteration_start`
- [ ] `iterationReport(flowId, stepId, result)` → calls `stratum_iteration_report`
- [ ] Error handling: parse Stratum error envelope, throw typed errors

**Pattern:** Use `@modelcontextprotocol/sdk/client` — `Client` class with `StdioClientTransport`. Same SDK the compose MCP server uses on the server side.

**Test:** `test/stratum-mcp-client.test.js` (new)
- [ ] Connects to stratum-mcp subprocess
- [ ] Calls `plan` with a minimal valid spec, gets `execute_step` response
- [ ] Calls `stepDone`, gets next step or `complete`
- [ ] Calls `audit`, gets audit snapshot
- [ ] Error case: invalid spec returns error envelope

---

## T4: Result Normalizer

**File:** `lib/result-normalizer.js` (new)

Bridges connector text streams to structured step results.

- [ ] `runAndNormalize(connector, prompt, stepDispatch)` → `{ text, result }`
- [ ] `outputFieldsToJsonSchema(outputFields)` — convert Stratum's flat type map (`{ field: "type_string" }`) to a JSON Schema object that `injectSchema()` accepts. Stratum dispatch provides `output_fields` as `{ "clean": "boolean", "findings": "array" }` (from `executor.py:709,731`), not a JSON Schema. This function maps each field's type string to the corresponding JSON Schema type (string→string, boolean→boolean, array→array, etc.) and wraps them in `{ type: "object", required: [...], properties: { ... } }`.
- [ ] If `stepDispatch.output_fields` is non-empty, convert via `outputFieldsToJsonSchema()` then inject into prompt via `injectSchema()` from `server/connectors/agent-connector.js`
- [ ] Accumulate all `type: 'assistant'` events from the connector stream
- [ ] JSON extraction chain: full text → fenced ```json block → first balanced `{...}` substring
- [ ] If schema was injected and extraction fails, throw `ResultParseError` with raw text (caller builds retry prompt)
- [ ] If no schema expected (empty `output_fields`), return `{ text, result: null }`
- [ ] Handle `type: 'error'` events — throw `AgentError`

**Pattern:** Extraction logic mirrors `agent-mcp.js:80-86` JSON.parse path, extended with fenced-block and balanced-brace fallbacks.

**Type mapping reference** (Stratum contract type strings → JSON Schema):
| Stratum type | JSON Schema type |
|---|---|
| `string` | `{ "type": "string" }` |
| `boolean` | `{ "type": "boolean" }` |
| `integer` | `{ "type": "integer" }` |
| `number` | `{ "type": "number" }` |
| `array` | `{ "type": "array" }` |
| `object` | `{ "type": "object" }` |
| `any` / unknown | `{}` (no constraint) |

**Test:** `test/result-normalizer.test.js` (new)
- [ ] `outputFieldsToJsonSchema` converts `{ "clean": "boolean" }` → valid JSON Schema with `required` and `properties`
- [ ] `outputFieldsToJsonSchema` maps `"any"` to unconstrained `{}`
- [ ] Normalizes clean JSON text → parsed result
- [ ] Extracts JSON from fenced ```json block
- [ ] Extracts JSON from text with surrounding prose
- [ ] Throws `ResultParseError` when schema expected but no JSON found
- [ ] Passes through text when no schema expected (empty output_fields)
- [ ] Throws `AgentError` on error events

---

## T5: Step Prompt Builder

**File:** `lib/step-prompt.js` (new)

Constructs agent prompts from Stratum step dispatch responses.

- [ ] `buildStepPrompt(stepDispatch, context)` → prompt string
  - Includes: step_id, intent, inputs, output_fields, ensure expressions, cwd, featureCode
- [ ] `buildRetryPrompt(stepDispatch, violations, context)` → prompt string
  - Prepends violation list to the base prompt
- [ ] `buildFlowStepPrompt(flowDispatch, context)` → prompt string for child flow steps

**Pattern:** Template follows design doc section "Step Prompt Construction".

**Test:** `test/step-prompt.test.js` (new)
- [ ] Builds prompt with all fields populated
- [ ] Builds prompt with minimal fields (no ensure, no output_fields)
- [ ] Retry prompt includes violations
- [ ] Flow step prompt includes child flow context

---

## T6: Gate Prompt

**File:** `lib/gate-prompt.js` (new)

CLI readline interface for gate resolution.

- [ ] `promptGate(gateDispatch)` → `{ outcome, rationale }`
- [ ] Displays step_id, on_approve/on_revise/on_kill targets
- [ ] Accepts `a`/`approve`, `r`/`revise`, `k`/`kill` (case-insensitive)
- [ ] Requires rationale (non-empty string)
- [ ] Re-prompts on invalid input

**Pattern:** Uses Node `readline/promises` (`createInterface`). No external dependencies.

**Test:** `test/gate-prompt.test.js` (new)
- [ ] Mock stdin: `a\nsome rationale\n` → `{ outcome: 'approve', rationale: 'some rationale' }`
- [ ] Mock stdin: `k\naborted\n` → `{ outcome: 'kill', rationale: 'aborted' }`
- [ ] Invalid then valid input → re-prompts, returns valid

---

## T7: Vision Writer

**File:** `lib/vision-writer.js` (new)

Atomic read-modify-write for `vision-state.json` with step-to-item mapping.

- [ ] `VisionWriter` class — constructed with data dir path
- [ ] `findFeatureItem(featureCode)` — transitional lookup checking both `item.featureCode === 'feature:<code>'` and `item.lifecycle?.featureCode === '<code>'`
- [ ] `ensureFeatureItem(featureCode, title)` — find or create item using `seedFeatures()` convention (top-level `featureCode: 'feature:<code>'`)
- [ ] `updateItemStatus(itemId, status)` — set item status
- [ ] `updateItemPhase(itemId, stepId)` — set `lifecycle.currentPhase`
- [ ] `createGate(flowId, stepId, itemId)` — add gate to `gates[]` with `status: 'pending'`
- [ ] `resolveGate(gateId, outcome)` — update gate status + outcome
- [ ] `_atomicWrite(state)` — write to temp file, `fs.renameSync` to final path

**Pattern:** Reads via `loadVisionState()` from `server/compose-mcp-tools.js`. Writes atomically. Uses `server/project-root.js` for path resolution.

**Test:** `test/vision-writer.test.js` (new)
- [ ] Creates feature item when none exists
- [ ] Finds existing item by top-level `featureCode`
- [ ] Finds existing item by `lifecycle.featureCode` (transitional)
- [ ] Does not duplicate when both fields present
- [ ] Updates item status atomically
- [ ] Creates and resolves gate entries
- [ ] Atomic write survives concurrent read

---

## T8: Build Runner (Core Loop)

**File:** `lib/build.js` (new)

The main orchestrator — ties T3-T7 together.

- [ ] `runBuild(featureCode, opts)` — entry point. `opts` includes optional `connectorFactory` override (default: `getConnector` from design) for test injection of mock agents
- [ ] **Load phase:** read `.compose/compose.json`, resolve feature folder, read spec/design from `docs/features/<code>/`
- [ ] **Resume check:** read `.compose/data/active-build.json`. If an in-progress flow exists, abandon it (delete `~/.stratum/flows/{flowId}.json`) and start fresh — there is no MCP tool to recover the current dispatch from a persisted flow
- [ ] **Plan phase:** call `stratumClient.plan(spec, flow, { featureCode, description })`, write `active-build.json`
- [ ] **Dispatch loop:** iterate on responses:
  - `execute_step` → `connectorFactory(agent)` → `runAndNormalize()` → `stepDone()` (uses `opts.connectorFactory` if provided, otherwise default `getConnector`)
  - `await_gate` → `promptGate()` → `gateResolve()` + vision writer gate entries
  - `execute_flow` → recursive `executeFlow()` → `stepDone()` on parent
  - `ensure_failed`/`schema_failed` → `buildRetryPrompt()` → re-dispatch
- [ ] **Vision updates:** via `VisionWriter` at each state transition
- [ ] **Active build tracking:** update `currentStepId` in `active-build.json` on each step
- [ ] **Completion:** write `docs/features/<code>/audit.json` from the completion/killed envelope's `trace` field directly (Stratum deletes persisted flows on completion, so `stratum_audit()` may return `flow_not_found`). Fall back to `stratum_audit()` only for killed flows that may still be persisted. Delete `active-build.json`
- [ ] **Abort handling:** `--abort` flag — kill gate flows via `gateResolve`, delete non-gate flow files, delete `active-build.json`
- [ ] **Error handling:** on unrecoverable error, write state to `active-build.json` for future resume, exit with non-zero code
- [ ] Console output: step progress (`[1/10] design...`), gate prompts, completion summary

**Pattern:** Follows design doc "Step Dispatch Loop" pseudocode. Each helper module (T3-T7) is imported and composed.

**Test:** `test/build.test.js` (new)
- [ ] Happy path: mock stratum client returns execute_step → complete; verify audit written
- [ ] Gate path: mock stratum returns await_gate; mock stdin resolves; verify gate_resolve called
- [ ] Resume path: active-build.json exists for same feature; verify old flow abandoned and fresh plan started
- [ ] Abort path: --abort deletes active-build.json and cleans up flow
- [ ] Unknown agent: step with `agent: 'unknown'` throws with agent name in error
- [ ] Ensure failure: mock ensure_failed response; verify retry prompt built and re-dispatched

---

## T9: Init Upgrade

**File:** `bin/compose.js` (existing) — modify `runInit()` function

- [ ] `detectAgents()` function — checks `which claude`/`which opencode`/`which gemini-cli` and home dir existence
- [ ] `installSkill(agent)` — copies `skills/stratum/SKILL.md` to agent's skill directory (`~/.claude/skills/stratum/`, etc.)
- [ ] Call `detectAgents()` + `installSkill()` during `runInit()`
- [ ] Print detection results (` + Claude Code — skill installed`, ` - Gemini — not found`)
- [ ] Write `agents` section to `.compose/compose.json`
- [ ] `--yes`/`-y` flag for non-interactive mode (skip readline prompts)
- [ ] Update `runSetup()` to also install stratum skill to detected agents (global path)

**Pattern:** Same `spawnSync('which', ...)` pattern already used for stratum detection at `bin/compose.js:51`.

**Test:** Update `test/init.test.js` (existing)
- [ ] Detects claude when `~/.claude/` exists (mock `existsSync`)
- [ ] Detects codex when `which opencode` succeeds (mock `spawnSync`)
- [ ] Writes `agents` section to `compose.json`
- [ ] Copies SKILL.md to detected agent dirs
- [ ] Skips Gemini install with warning when detected but unverified

---

## T10: CLI Wiring

**File:** `bin/compose.js` (existing) — add `build` command

- [ ] Parse `compose build [FEAT-CODE]` with optional `--abort` and `--resume` flags
- [ ] Import and call `runBuild()` from `lib/build.js`
- [ ] Update help text with `build` command
- [ ] Error handling: catch build errors, print message, exit with code 1
- [ ] If no FEAT-CODE provided, error with: "Usage: compose build <feature-code>"

**Pattern:** Same command dispatch pattern as existing `init`/`setup`/`start` in `bin/compose.js:157-204`.

**Test:** Covered by T8 build runner tests and T11 integration test.

---

## T11: Integration Test

**File:** `test/build-integration.test.js` (new)

End-to-end tests using a real stratum-mcp subprocess and mock agent connectors.

### Test 1: 2-step inline flow (happy path)
- [ ] Prerequisite check: skip if `stratum-mcp` not installed
- [ ] Create temp project dir with `.compose/compose.json` and `docs/features/TEST-1/` with a minimal `spec.md`
- [ ] Write a 2-step inline spec with `agent: claude` and sequential `depends_on`
- [ ] Mock the connector to write marker files and return step results
- [ ] Run `runBuild('TEST-1', { cwd: tempDir })` programmatically
- [ ] Verify: `active-build.json` deleted (flow completed)
- [ ] Verify: `audit.json` written with `status: 'complete'` and `trace` array
- [ ] Verify: vision-state.json has item with `status: 'complete'` and `featureCode: 'feature:TEST-1'`
- [ ] Verify: both step marker files exist (design.done, implement.done)

### Test 2: Sub-flow dispatch (execute_flow path)
- [ ] Write a spec with a parent flow (`build`) containing a `flow:` step referencing a sub-flow (`review_fix`)
- [ ] Parent flow: `implement` → `review` (flow: review_fix) → `ship`
- [ ] Sub-flow `review_fix`: `review` → `fix` (two steps with ReviewResult contract)
- [ ] Mock connector returns contract-appropriate results per step_id
- [ ] Run `runBuild('SUB-1', { cwd: tempDir })`
- [ ] Verify: parent flow completes (audit.json `status: 'complete'`)
- [ ] Verify: `ship` step ran after sub-flow completed (marker file) — proves parent continued after child completion envelope was reported via `stepDone`
- [ ] Verify: sub-flow's own steps ran (review.done marker)
- [ ] Verify: vision-state item is `complete`

**Pattern:** Uses `node --test` runner. Temp dirs via `fs.mkdtempSync`. Connector mock via dependency injection (T8's `runBuild` accepts an optional `connectorFactory` override). Cleanup in `after()`.

---

## Execution Order

| Phase | Tasks | Notes |
|---|---|---|
| 1 | T1, T2 | Independent authoring — skill doc and lifecycle spec |
| 2 | T3, T4, T5, T6, T7 | All independent leaf modules |
| 3 | T8 | Depends on T3-T7 |
| 4 | T9, T10 | Depends on T1 (skill), T8 (build runner) |
| 5 | T11 | Depends on everything |
