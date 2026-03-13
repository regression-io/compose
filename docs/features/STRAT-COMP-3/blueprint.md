# STRAT-COMP-3: Implementation Blueprint

**Feature:** Proof run — fix build infrastructure bugs, rewrite sub-flow spec, prove dispatch loop with mock connectors (317 tests, 0 fail). Live run (Task 6) remains manual/gated.

**Status:** Tasks 1–5 complete. Task 6 is a live-inference run gated by human approval.

---

## 1. Scope

STRAT-COMP-3 touches exactly five files (four edits, one creation) plus adds one entirely new test file. Everything else is read-only.

| # | File | Action | Task |
|---|------|---------|------|
| 1 | `.compose/compose.json` | **Create** | Task 1 — missing manifest |
| 2 | `lib/stratum-mcp-client.js` | **Edit** lines 41–69 | Task 2 — pre-flight guard + cwd fix |
| 3 | `lib/build.js` | **Edit** lines 175–266 | Task 3 — dead `skipped` branch; Task 4 — ensure_failed cross-agent recovery |
| 4 | `pipelines/build.stratum.yaml` | **Edit** lines 44–88 | Task 4 — sub-flow spec rewrite |
| 5 | `test/proof-run.test.js` | **Create** | Task 5 — proof run test suite |

---

## 2. Component Map

```
bin/compose.js
    │
    ▼
lib/build.js:89  runBuild(featureCode, opts)
    │
    ├─── lib/stratum-mcp-client.js:29  StratumMcpClient
    │         .connect()    :41   — spawn stratum-mcp via stdio
    │         .plan()       :148  — stratum_plan MCP tool
    │         .stepDone()   :168  — stratum_step_done MCP tool
    │         .gateResolve():185  — stratum_gate_resolve MCP tool
    │         .resume()     :157  — stratum_resume MCP tool
    │         .audit()      :215  — stratum_audit MCP tool
    │
    ├─── lib/step-prompt.js:12   buildStepPrompt(stepDispatch, context)
    │    lib/step-prompt.js:48   buildRetryPrompt(stepDispatch, violations, context)
    │
    ├─── lib/result-normalizer.js:129  runAndNormalize(connector, prompt, stepDispatch, opts)
    │         lib/result-normalizer.js:55   outputFieldsToJsonSchema(outputFields)
    │         lib/result-normalizer.js:81   extractJson(text)    — 3-strategy JSON parse
    │
    ├─── lib/gate-prompt.js:34   promptGate(gateDispatch, options)
    │
    ├─── lib/vision-writer.js    VisionWriter — atomic disk writes
    │
    ├─── server/connectors/claude-sdk-connector.js:13   ClaudeSDKConnector
    │         .run(prompt, opts)  :29  — @anthropic-ai/claude-agent-sdk query()
    │
    └─── server/connectors/codex-connector.js:47   CodexConnector
              .run(prompt, opts)  :64  — extends OpencodeConnector
```

Spec consumed at runtime:
```
pipelines/build.stratum.yaml — 308 lines, version: "0.2"
```

---

## 3. Bug Fixes (Tasks 1–3)

### 3.1 Task 1 — Missing `.compose/compose.json`

**Trigger:** `lib/build.js:106–109`

```javascript
// lib/build.js:106
const configPath = join(composeDir, 'compose.json');
if (!existsSync(configPath)) {
  throw new Error(`No .compose/compose.json found at ${cwd}. Run 'compose init' first.`);
}
```

**Fix:** Create `.compose/compose.json` with this exact content:

```json
{
  "version": "2",
  "capabilities": { "stratum": true },
  "paths": { "docs": "docs", "features": "docs/features" }
}
```

No code change required — this is a data file creation. The test harness replicates it at `test/proof-run.test.js:151–157` (`setupProofProject()`).

---

### 3.2 Task 2 — stratum-mcp Pre-flight Guard

**Location:** `lib/stratum-mcp-client.js:41–69` (`connect()` method)

**Before (broken):** StdioClientTransport threw `ENOENT` with no context when `stratum-mcp` wasn't on `$PATH`.

**After (fixed, lines 47–56):**

```javascript
// lib/stratum-mcp-client.js:47–56
if (command === 'stratum-mcp') {
  try {
    execFileSync('which', [command], { stdio: 'pipe', timeout: 3000 });
  } catch {
    throw new Error(
      'stratum-mcp not found on $PATH. Install with: pip install stratum-mcp'
    );
  }
}
```

**CWD fix (lines 58–59):** The `cwd` option must be passed to `StdioClientTransport` so that stratum-mcp resolves `file_exists()` ensures relative to the compose project root, not the shell's working directory.

```javascript
// lib/stratum-mcp-client.js:58–60
const transportOpts = { command, args, stderr: 'pipe' };
if (opts.cwd) transportOpts.cwd = opts.cwd;
this.#transport = new StdioClientTransport(transportOpts);
```

The `connect()` call site in `lib/build.js:130` already passes `{ cwd }`:

```javascript
// lib/build.js:129–130
const stratum = new StratumMcpClient();
await stratum.connect({ cwd });
```

---

### 3.3 Task 3 — Dead `skipped` Dispatch Branch

**Location:** `lib/build.js:175–266` (dispatch loop)

**Problem:** Stratum auto-advances past `skip_if: "true"` steps internally. The dispatch loop never receives a `status === 'skipped'` event. Any branch attempting `stratum.stepDone()` on a skipped step caused a protocol error.

**Fix:** The dispatch loop has no `skipped` branch. The current loop at `lib/build.js:175` only handles:

```
execute_step   → lib/build.js:181–194
await_gate     → lib/build.js:196–226
execute_flow   → lib/build.js:228–246
ensure_failed  → lib/build.js:248–259
(unknown)      → lib/build.js:261–264  warn + break
```

Verified: `prd`, `architecture`, `report` (all `skip_if: "true"` in `pipelines/build.stratum.yaml:139, 159, 271`) never appear in `test/proof-run.test.js:210–212`:

```javascript
// test/proof-run.test.js:210–212
for (const step of ['prd', 'architecture', 'report']) {
  assert.ok(!stepIds.includes(step), `Step "${step}" should be skipped, not dispatched`);
}
```

---

## 4. Sub-flow Spec Rewrite (Task 4)

### 4.1 What Changed in `pipelines/build.stratum.yaml`

The two sub-flow blocks at lines 44–88 were rewritten from a broken 2-step shape to a correct 1-step + retry shape.

**Before (broken — 2-step sub-flows):**
```yaml
review_fix:        # old name
  steps:
    - id: review   # codex
    - id: fix      # claude, depends_on: [review]
```

The 2-step shape violated Stratum's `execute_flow` contract: the parent flow couldn't intercept child step failures.

**After (correct — 1-step + stratum retry):**

```yaml
# pipelines/build.stratum.yaml:49–67
review_check:
  input:
    task:      {type: string}
    blueprint: {type: string}
  output: ReviewResult
  steps:
    - id: review
      agent: codex
      intent: >
        Review the implementation against the blueprint. Return structured JSON:
        { "clean": boolean, "summary": string, "findings": string[] }.
        Set clean=true only if no actionable findings with confidence >= 80 remain.
      inputs:
        task: "$.input.task"
        blueprint: "$.input.blueprint"
      output_contract: ReviewResult
      ensure:
        - "result.clean == True"
      retries: 10

# pipelines/build.stratum.yaml:72–88
coverage_check:
  input:
    task: {type: string}
    plan: {type: string}
  output: TestResult
  steps:
    - id: run_tests
      agent: claude
      intent: >
        Run the project test suite. Return structured JSON:
        { "passing": boolean, "summary": string, "failures": string[] }.
      inputs:
        task: "$.input.task"
      output_contract: TestResult
      ensure:
        - "result.passing == True"
      retries: 15
```

These sub-flows are invoked from the main `build` flow at lines 235–253:

```yaml
# pipelines/build.stratum.yaml:235–253
- id: review
  flow: review_check
  inputs:
    task: "$.steps.execute.output.summary"
    blueprint: "$.input.description"
  ensure:
    - "result.clean == True"
  depends_on: [execute]

- id: coverage
  flow: coverage_check
  inputs:
    task: "$.steps.execute.output.summary"
    plan: "$.input.description"
  ensure:
    - "result.passing == True"
  depends_on: [review]
```

### 4.2 Cross-Agent Recovery in `lib/build.js`

When stratum fires `ensure_failed` for a child flow step, `build.js` dispatches a fix agent before the next retry. The logic lives at `lib/build.js:383–413` inside `executeChildFlow()`:

```javascript
// lib/build.js:383–413
} else if (resp.status === 'ensure_failed' || resp.status === 'schema_failed') {
  const violations = resp.violations ?? [];
  const stepAgent = resp.agent ?? 'claude';
  const fixAgent = stepAgent === 'codex' ? 'claude' : stepAgent;  // cross-agent!

  const fixPrompt =
    `Fix step "${resp.step_id}" — postconditions failed:\n` +
    violations.map(v => `- ${v}`).join('\n') + '\n\n' +
    `Fix every issue. Do not skip any.\n\n` +
    `## Context\nWorking directory: ${context.cwd}\nFeature: ${context.featureCode}`;
  const fixConnector = getConnector(fixAgent, { cwd: context.cwd });
  await runAndNormalize(fixConnector, fixPrompt, resp, { progress });

  // Retry original agent with buildRetryPrompt
  const prompt = buildRetryPrompt(resp, violations, context);
  const connector = getConnector(stepAgent, { cwd: context.cwd });
  const { result } = await runAndNormalize(connector, prompt, resp, { progress });

  resp = await stratum.stepDone(
    resp.flow_id ?? childFlowId, resp.step_id,
    result ?? { summary: 'Retry complete' }
  );
}
```

The main dispatch loop also handles `ensure_failed` at `lib/build.js:248–259` for top-level steps (same logic, no cross-agent distinction because top-level steps are all `agent: claude`).

---

## 5. Proof Run Test Suite (Task 5)

**File:** `test/proof-run.test.js` — 386 lines

### 5.1 Test Infrastructure

#### Mock Connector Factory (`test/proof-run.test.js:49–96`)

Returns a connector factory that:
1. Extracts `step_id` from the prompt via regex `step "(\w+)"` (line 63)
2. Pushes `{ stepId, agentType, promptSnippet }` into `dispatches` array (line 65)
3. Creates artifact files on disk for `file_exists()` ensures (lines 68–75)
4. Returns canned JSON matching the step's output contract (lines 78–90)
5. Yields two events: `{ type: 'assistant', content: JSON }` + `{ type: 'system', subtype: 'complete' }` (lines 82–84, 89–90)

**Step→artifact mapping** (`test/proof-run.test.js:52–56`):
```javascript
const artifactMap = {
  explore_design: 'design.md',
  blueprint:      'blueprint.md',
  plan:           'plan.md',
};
```

**Default result routing** (`test/proof-run.test.js:98–124`):
- `review`    → `{ clean: true, summary: ..., findings: [] }`
- `run_tests` → `{ passing: true, summary: ..., failures: [] }`
- all others  → `{ phase, artifact, outcome: 'complete', summary }`

#### Gate Auto-approve Helper (`test/proof-run.test.js:130–145`)

```javascript
function createAutoApproveGateOpts() {
  const output = new PassThrough();
  output.on('data', () => {}); // drain

  return {
    get input() {
      const input = new PassThrough();
      setImmediate(() => {
        input.write('a\n');                          // approve
        setImmediate(() => { input.write('LGTM\n'); }); // rationale
      });
      return input;
    },
    output,
  };
}
```

The gate prompt reads from `options.input` at `lib/gate-prompt.js:39–42`:
```javascript
const rl = createInterface({
  input: input ?? process.stdin,
  output: output ?? process.stdout,
});
```

#### Project Setup (`test/proof-run.test.js:151–168`)

`setupProofProject(tmpDir)` creates the minimum file tree required by `runBuild()`:

```
tmpDir/
  .compose/
    data/
    compose.json        ← { version: "1.0", capabilities: { stratum: true } }
  docs/features/PROOF-1/
    design.md           ← used by loadFeatureDescription() (lib/build.js:460–471)
  pipelines/
    build.stratum.yaml  ← copied from real spec at line 165–166
```

It copies the real `build.stratum.yaml` using `copyFileSync` so the test is always in sync with the current spec.

### 5.2 Test Scenarios

#### Happy Path (`test/proof-run.test.js:191–262`)

**Test:** `'12-step pipeline completes with mock connectors'` — timeout 120s

Calls `runBuild('PROOF-1', { cwd: tmpDir, connectorFactory, description, gateOpts })`.

**Assertions on dispatch sequence** (lines 202–223):
- Steps that MUST dispatch: `explore_design, blueprint, verification, plan, execute`
- Steps that MUST NOT dispatch: `prd, architecture, report` (all `skip_if: "true"`)
- Sub-flow steps: `review` (via `review_check`), `run_tests` (via `coverage_check`)
- Agent type: `review` → `codex`; `execute` → `claude`

**Assertions on audit trail** (lines 225–241):
- `docs/features/PROOF-1/audit.json` exists
- `audit.status === 'complete'`
- `audit.trace` is an array
- At least 3 `skip` entries (prd, architecture, report)
- At least 3 `gate` entries (design_gate, plan_gate, ship_gate)

**Assertions on vision state** (lines 243–257):
- `.compose/data/vision-state.json` exists
- Feature item `status === 'complete'`
- All gates `status === 'resolved'`, `outcome === 'approve'`

**Cleanup check** (lines 259–261):
- `.compose/data/active-build.json` deleted by `deleteActiveBuild()` at `lib/build.js:308`

#### Cross-Agent Recovery (`test/proof-run.test.js:283–337`)

**Test:** `'failing review triggers claude fix then codex re-review'` — timeout 120s

Override for `review` step (lines 287–295): returns `{ clean: false }` on first call, `{ clean: true }` on second.

**Assertions** (lines 310–330):
- At least 3 `review` dispatches
- First dispatch → `agentType === 'codex'`
- At least one dispatch with `agentType === 'claude'` (the fix)
- Claude fix index > first codex index
- A codex dispatch exists after the claude fix

#### Same-Agent Recovery (`test/proof-run.test.js:339–384`)

**Test:** `'failing tests triggers fix then retest (same-agent recovery)'` — timeout 120s

Override for `run_tests` step: returns `{ passing: false }` on first call, `{ passing: true }` on second.

**Assertions** (lines 365–383):
- At least 3 `run_tests` dispatches
- All dispatches are `agentType === 'claude'` (same-agent — claude fixes claude)
- Final audit `status === 'complete'`

### 5.3 Skip Guard (`test/proof-run.test.js:30–34`)

All three `describe` blocks have `skip: !stratumAvailable`:

```javascript
let stratumAvailable = false;
try {
  execFileSync('stratum-mcp', ['--help'], { timeout: 5000, stdio: 'pipe' });
  stratumAvailable = true;
} catch { /* not installed */ }
```

Tests are skipped when `stratum-mcp` is not on `$PATH`, making the suite CI-safe.

---

## 6. Dispatch Loop Reference (lib/build.js)

The main loop (`lib/build.js:175–266`) drives all execution:

```
lib/build.js:175   while (response.status !== 'complete' && response.status !== 'killed')
lib/build.js:181   if (response.status === 'execute_step')
lib/build.js:190     agentType = response.agent ?? 'claude'
lib/build.js:190     prompt = buildStepPrompt(response, context)       → lib/step-prompt.js:12
lib/build.js:191     connector = getConnector(agentType, { cwd })       → DEFAULT_AGENTS map :29
lib/build.js:192     { result } = await runAndNormalize(...)            → lib/result-normalizer.js:129
lib/build.js:194     response = await stratum.stepDone(...)             → lib/stratum-mcp-client.js:168

lib/build.js:196   } else if (response.status === 'await_gate')
lib/build.js:219     { outcome, rationale } = await promptGate(...)    → lib/gate-prompt.js:34
lib/build.js:225     response = await stratum.gateResolve(...)          → lib/stratum-mcp-client.js:185

lib/build.js:228   } else if (response.status === 'execute_flow')
lib/build.js:238     childResult = await executeChildFlow(...)          → lib/build.js:325
lib/build.js:246     response = await stratum.stepDone(parentFlowId, parentStepId, childResult)

lib/build.js:248   } else if (response.status === 'ensure_failed' || 'schema_failed')
lib/build.js:252     prompt = buildRetryPrompt(response, violations, context)
lib/build.js:253     connector = getConnector(agentType, { cwd })
lib/build.js:254     { result } = await runAndNormalize(connector, prompt, response, ...)
lib/build.js:256     response = await stratum.stepDone(response.flow_id, response.step_id, result)
```

The child-flow loop (`lib/build.js:325–435`) mirrors the main loop and handles nested `execute_flow` recursively at `lib/build.js:415–426`.

---

## 7. Data Contracts

### 7.1 Output Contracts (`pipelines/build.stratum.yaml:14–29`)

| Contract | Fields |
|---|---|
| `PhaseResult` | `phase: string`, `artifact: string`, `outcome: complete\|skipped\|failed`, `summary: string` |
| `ReviewResult` | `clean: boolean`, `summary: string`, `findings: array` |
| `TestResult` | `passing: boolean`, `summary: string`, `failures: array` |

### 7.2 Connector Envelope Events (`server/connectors/agent-connector.js`)

All connectors yield typed events:

| Event type | Fields | Source |
|---|---|---|
| `system` | `subtype: init\|complete`, `agent`, `model?` | init/close |
| `assistant` | `content: string` | text output |
| `tool_use` | `tool: string`, `input: object` | tool invocations |
| `result` | `content: string` | final aggregated text |
| `error` | `message: string` | failures |

`result-normalizer.js:129` accumulates `assistant` events and applies 3-strategy JSON extraction:
- Strategy A: full text is valid JSON (`lib/result-normalizer.js:83`)
- Strategy B: fenced ` ```json ``` ` block (`lib/result-normalizer.js:88`)
- Strategy C: first balanced `{…}` substring (`lib/result-normalizer.js:96–109`)

### 7.3 Active Build State (`.compose/data/active-build.json`)

Written by `lib/build.js:437–450` (`startFresh()`) and updated by `lib/build.js:452–458` (`updateActiveBuildStep()`):

```json
{
  "featureCode": "STRAT-COMP-3",
  "flowId": "<uuid>",
  "startedAt": "ISO8601",
  "currentStepId": "<step_id>",
  "specPath": "pipelines/build.stratum.yaml"
}
```

Deleted on completion by `lib/build.js:308` (`deleteActiveBuild(dataDir)`).

---

## 8. Connector Factory Override Pattern

`runBuild()` accepts `opts.connectorFactory` (`lib/build.js:91`) to replace the default connector registry. This is the injection point for mock connectors in tests.

```javascript
// lib/build.js:89–92
export async function runBuild(featureCode, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const getConnector = opts.connectorFactory ?? defaultConnectorFactory;
```

Default registry (`lib/build.js:29–32`):
```javascript
const DEFAULT_AGENTS = new Map([
  ['claude', (opts) => new ClaudeSDKConnector(opts)],
  ['codex', (opts) => new CodexConnector(opts)],
]);
```

Mock override in tests (`test/proof-run.test.js:194–199`):
```javascript
await runBuild('PROOF-1', {
  cwd: tmpDir,
  connectorFactory: mockConnectorFactory(dispatches, featureDir),
  description: 'Proof run integration test',
  gateOpts,
});
```

---

## 9. Task 6: Live Proof Run

Task 6 is explicitly **not automated** — it requires human gate approval at three points. It is executed as:

```bash
node bin/compose.js build STRAT-1
```

### Prerequisites

| Item | Verification |
|---|---|
| `stratum-mcp` on `$PATH` | `which stratum-mcp` |
| `ANTHROPIC_API_KEY` set | `echo $ANTHROPIC_API_KEY` |
| Codex configured (or `review` step reassigned) | `opencode auth status` |
| `.compose/compose.json` exists | Created in Task 1 |
| All 317 tests green | `npm test` |

### Execution Sequence

1. `stratum.plan()` → `explore_design` dispatched to `ClaudeSDKConnector` (writes `design.md`)
2. `await_gate: design_gate` → human types `a` → `stratum.gateResolve(approve)`
3. `prd`, `architecture` auto-skipped by Stratum
4. `blueprint` → `verification` → `plan` dispatched to Claude
5. `await_gate: plan_gate` → human approves
6. `execute` dispatched to Claude (TDD — writes tests, then code)
7. `execute_flow: review_check` → `review` step dispatched to `CodexConnector`
   - On `ensure_failed`: `executeChildFlow` (`:383`) dispatches claude fix, then retries codex
8. `execute_flow: coverage_check` → `run_tests` dispatched to `ClaudeSDKConnector`
   - On `ensure_failed`: same-agent recovery (claude fix, then claude retry)
9. `report` auto-skipped
10. `docs` + `ship` dispatched to Claude
11. `await_gate: ship_gate` → human approves
12. Audit written to `docs/features/STRAT-1/audit.json`
13. Vision item `STRAT-1` marked `complete`

### Validation Checklist

After the live run, verify:
- `docs/features/STRAT-1/audit.json` — `status: "complete"`
- Audit trace has `skipped` entries for `prd`, `architecture`, `report`
- Audit trace has `gate` entries for `design_gate`, `plan_gate`, `ship_gate`
- Audit shows `agent: "codex"` for `review_check.review`
- `.compose/data/vision-state.json` — STRAT-1 item `status: "complete"`, all gates resolved
- All artifact files exist: `design.md`, `blueprint.md`, `plan.md`
- `npm test` ≥ 317 passing, 0 failing

---

## 10. File:Line Quick Reference

| Symbol | Location |
|---|---|
| `runBuild()` — entry point | `lib/build.js:89` |
| `defaultConnectorFactory()` | `lib/build.js:34` |
| `startFresh()` | `lib/build.js:437` |
| `updateActiveBuildStep()` | `lib/build.js:452` |
| `deleteActiveBuild()` | `lib/build.js:69` |
| Dispatch loop — main `while` | `lib/build.js:175` |
| `execute_step` branch | `lib/build.js:181` |
| `await_gate` branch | `lib/build.js:196` |
| `execute_flow` branch | `lib/build.js:228` |
| `ensure_failed` branch (main) | `lib/build.js:248` |
| `executeChildFlow()` | `lib/build.js:325` |
| `ensure_failed` branch (child) | `lib/build.js:383` |
| Cross-agent recovery: `fixAgent` selection | `lib/build.js:386` |
| Audit write | `lib/build.js:281–305` |
| `StratumMcpClient` class | `lib/stratum-mcp-client.js:29` |
| `connect()` — pre-flight guard | `lib/stratum-mcp-client.js:47–56` |
| `connect()` — cwd in transport | `lib/stratum-mcp-client.js:58–60` |
| `plan()` | `lib/stratum-mcp-client.js:148` |
| `stepDone()` | `lib/stratum-mcp-client.js:168` |
| `gateResolve()` | `lib/stratum-mcp-client.js:185` |
| `#callTool()` — MCP invocation | `lib/stratum-mcp-client.js:90` |
| `buildStepPrompt()` | `lib/step-prompt.js:12` |
| `buildRetryPrompt()` | `lib/step-prompt.js:48` |
| `runAndNormalize()` | `lib/result-normalizer.js:129` |
| `outputFieldsToJsonSchema()` | `lib/result-normalizer.js:55` |
| `extractJson()` — 3 strategies | `lib/result-normalizer.js:81` |
| `promptGate()` | `lib/gate-prompt.js:34` |
| `ClaudeSDKConnector.run()` | `server/connectors/claude-sdk-connector.js:29` |
| Claude env strip (`CLAUDECODE`) | `server/connectors/claude-sdk-connector.js:37–38` |
| `CodexConnector` class | `server/connectors/codex-connector.js:47` |
| `CODEX_MODEL_IDS` set | `server/connectors/codex-connector.js:15` |
| Spec — `review_check` sub-flow | `pipelines/build.stratum.yaml:49` |
| Spec — `coverage_check` sub-flow | `pipelines/build.stratum.yaml:72` |
| Spec — `review` step (codex) | `pipelines/build.stratum.yaml:55` |
| Spec — `run_tests` step (claude) | `pipelines/build.stratum.yaml:79` |
| Spec — `prd` skip_if | `pipelines/build.stratum.yaml:139` |
| Spec — `architecture` skip_if | `pipelines/build.stratum.yaml:159` |
| Spec — `report` skip_if | `pipelines/build.stratum.yaml:271` |
| Test — `mockConnectorFactory()` | `test/proof-run.test.js:49` |
| Test — `createAutoApproveGateOpts()` | `test/proof-run.test.js:130` |
| Test — `setupProofProject()` | `test/proof-run.test.js:151` |
| Test — happy-path describe | `test/proof-run.test.js:175` |
| Test — cross-agent recovery describe | `test/proof-run.test.js:269` |
| Test — same-agent recovery describe | `test/proof-run.test.js:339` |
| Test — skip guard | `test/proof-run.test.js:30` |
