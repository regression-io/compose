# Trusted Pipeline Harness: Design

**Status:** DESIGN
**Date:** 2026-03-28
**Feature Code:** COMP-HARNESS (items HARNESS-1 through HARNESS-9)
**Prerequisite:** Phase 6.9 (Agent Fleet Management: COMP-AGT-1 through COMP-AGT-17)

## Related Documents

- [Compose Roadmap](../../compose/docs/ROADMAP.md) -- Phase 7 definition, Phase 6.9 prerequisite
- [Architecture Foundation Plan](../../compose/docs/plans/2026-02-26-architecture-foundation-plan.md) -- Phase 4.5, connector layer origin
- [Agent Connectors Design](../../compose/docs/features/agent-connectors/design.md) -- Connector class hierarchy
- `compose/lib/build.js` -- Current orchestration loop (to be superseded)
- `compose/lib/result-normalizer.js` -- Current agent output normalization
- `compose/lib/stratum-mcp-client.js` -- Stratum MCP protocol client
- `compose/server/connectors/agent-connector.js` -- Base connector interface
- `compose/server/build-stream-bridge.js` -- SSE event bridge + crash detection

---

## Problem

### The Trust Gap

The current pipeline has a structural trust problem: the agent being evaluated controls the evaluation.

**Today's execution model** (`lib/build.js`):

1. `build.js` calls `stratum.plan()` to get the first step dispatch
2. For each step, `build.js` sends a prompt to an agent via `runAndNormalize()`
3. The agent executes the step and returns a structured result (e.g., `{ clean: true, findings: [] }`)
4. `build.js` passes this self-reported result directly to `stratum.stepDone()`
5. Stratum validates postconditions against what the agent claimed

The problem is at step 3-4. Every verification in the system depends on the agent's own report:

- **Review loops** (`review_check` child flow): The review agent returns `{ clean: true }`. Nothing confirms Codex was actually invoked, that it reviewed the right files, or that its findings were addressed. The executor agent could return `{ clean: true }` without calling Codex at all. In `executeChildFlow()` (build.js:1216), the child step result flows directly from `runAndNormalize()` to `stratum.stepDone()` with no independent check.

- **Coverage loops** (`coverage_check` child flow): The agent returns `{ passing: true, coverage: 85 }`. Nothing confirms tests actually ran, what the real exit code was, or whether the coverage number is fabricated. Same flow path -- agent output becomes stratum input with no verification.

- **File changes**: `build.js:451` tracks changed files via `git diff --name-only` but only records file *names*, not content hashes. An agent could claim to have fixed an issue while making no meaningful changes, or could overwrite files with suppress/wontfix comments to silence reviewers.

- **Postcondition enforcement**: Stratum's `ensure` clauses check `result.clean == True` or `result.passing == True` -- but these are agent-claimed booleans (`result-normalizer.js:256`, `extractJson()`). The JSON is literally extracted from the agent's text output.

- **Retry loops**: When `ensure_failed` fires (build.js:624), the retry prompt includes violations, but the retried agent can return `{ clean: true }` again without actually fixing anything. There is no environmental ground-truth check.

### Why This Matters

This is not a theoretical concern. Observed failure modes include:

1. **Review theater** -- Agent claims review is clean when reviewer found issues, because the executor agent summarized the review result rather than passing it through
2. **Stagnation loops** -- Agent retries the same step 5+ times, producing activity (tool calls, file reads) but zero environmental change, burning budget
3. **Suppress-to-pass** -- Agent adds `// eslint-disable` or deletes failing tests to make `{ passing: true }` technically accurate
4. **Self-review** -- Same Claude instance reviews its own code and finds it clean (confirmation bias is structural, not malicious)

---

## Goal

### In Scope

- Deterministic pipeline runner that treats all agents as untrusted workers
- Independent verification of every agent-claimed result via ground-truth checks
- Hash-chained audit trail that agents cannot tamper with
- Stagnation detection that measures environmental delta, not agent-reported progress
- Effort budgets that prevent unbounded exploration
- Multi-agent routing with executor/reviewer separation as an invariant
- Tiered evaluation (cheap fast checks before expensive full checks)
- Iteration ledger for cross-iteration learning within a single review loop

### Not In Scope

- Cryptographic agent identity (attestation, signing) -- post-V1
- UI changes to Vision Surface (this is infrastructure only; UI reads existing build-stream events)
- Changes to Stratum itself (harness is a consumer of Stratum's existing MCP API)
- New agent connectors (uses existing ClaudeSDKConnector, CodexConnector from Phase 4.5)
- Changes to the `.stratum.yaml` spec format

### Success Criteria

- No agent ever calls `stratum_step_done` -- only the harness does
- Every `{ clean: true }` is independently verified before Stratum receives it
- Every iteration has a content-addressed delta (SHA256 of changed files)
- Stagnation warned at 2 idle iterations, aborted at 3
- Audit trail is hash-chained and append-only
- Executor and reviewer are provably different agents for every review step

---

## Decision 1: Harness Architecture (HARNESS-1)

### Trust Problem

`build.js` is a monolithic function that mixes orchestration (step dispatch, gate handling, resume logic) with agent interaction (prompt building, result normalization). The orchestrator and the agent share a trust boundary -- the orchestrator trusts whatever the agent returns.

The current flow in `runBuild()` (build.js:214):

```
stratum.plan() -> while loop {
  execute_step: buildStepPrompt() -> runAndNormalize() -> stratum.stepDone(result)
  await_gate:   policy check -> human/UI prompt -> stratum.gateResolve()
  execute_flow: executeChildFlow() -> stratum.stepDone(childResult)
  ensure_failed: buildRetryPrompt() -> runAndNormalize() -> stratum.stepDone(result)
}
```

At every `stratum.stepDone(result)` call, `result` is the agent's self-report. The harness must interpose between agent output and stratum input.

### Design

Create `server/pipeline-runner.js` as a new module that replaces `build.js` as the orchestration layer. `build.js` becomes a thin CLI entry point that instantiates the runner.

**Core loop:**

```
class PipelineRunner {
  constructor(stratum, connectorFactory, verifier, auditor, budgetManager, router)

  async run(featureCode, specYaml, opts) {
    const plan = await this.stratum.plan(specYaml, flowName, inputs);
    const auditor = this.auditor.startRun(featureCode);

    let dispatch = plan;
    while (!isTerminal(dispatch.status)) {
      dispatch = await this.#handleDispatch(dispatch, auditor);
    }

    auditor.finalize();
  }

  async #handleDispatch(dispatch, auditor) {
    switch (dispatch.status) {
      case 'execute_step': return this.#executeStep(dispatch, auditor);
      case 'await_gate':   return this.#handleGate(dispatch, auditor);
      case 'execute_flow': return this.#executeChildFlow(dispatch, auditor);
      case 'ensure_failed': return this.#handleRetry(dispatch, auditor);
      case 'parallel_dispatch': return this.#handleParallel(dispatch, auditor);
    }
  }

  async #executeStep(dispatch, auditor) {
    const { step_id, agent } = dispatch;
    const budget = this.budgetManager.allocate(step_id);

    // 1. Route to agent (HARNESS-7)
    const selectedAgent = this.router.select(dispatch);
    const connector = this.connectorFactory(selectedAgent, { cwd: this.agentCwd });

    // 2. Snapshot environment IMMEDIATELY BEFORE agent execution
    //    The harness owns both snapshots — the agent never touches them.
    const envBefore = await this.verifier.snapshot(this.agentCwd);

    // 3. Execute with budget tracking (HARNESS-3)
    const agentOutput = await this.#runWithBudget(connector, dispatch, budget);

    // 4. Snapshot environment IMMEDIATELY AFTER agent execution
    //    envAfter is captured inside verifier.verify() (see HARNESS-4).

    // 5. Independent verification (HARNESS-4)
    const verified = await this.verifier.verify(dispatch, agentOutput, envBefore);

    // 6. Audit (HARNESS-6)
    auditor.record({
      step_id,
      agent: selectedAgent,
      agentClaimed: agentOutput.result,
      harnessVerified: verified,
      envDelta: verified.envDelta,
    });

    // 7. Harness -- not agent -- calls stepDone with verified result
    return this.stratum.stepDone(dispatch.flow_id, step_id, verified.result);
  }
}
```

**Key invariant:** The `result` passed to `stratum.stepDone()` is constructed by the harness from its own verification, never passed through from agent output. The agent's claimed result is recorded in the audit trail for comparison but never trusted.

### Integration with Existing Code

- `build.js:runBuild()` becomes a wrapper that instantiates `PipelineRunner` with the same infrastructure (stratum client, connector factory, vision writer, stream writer)
- `result-normalizer.js` is unchanged -- it still extracts structured JSON from agent output, but the extracted result is now an *input* to verification, not the final answer
- `step-prompt.js` is unchanged -- prompt construction stays the same
- `build-stream-writer.js` receives the same events from the harness as from build.js today
- Active-build state management (`active-build.json`) moves into the runner

### Migration Strategy

`PipelineRunner` replaces `build.js` incrementally, preserving all external interfaces:

1. **Same public interface:** `PipelineRunner` implements the same public contract as `runBuild()` in `build.js` — same arguments, same return shape, same error types.

2. **`active-build.json` format preserved:** Same read/write helpers (`readActiveBuild()`, `writeActiveBuild()`). `PipelineRunner` reads and writes the identical JSON shape so Vision Surface and CLI resume work unchanged.

3. **Build-stream events preserved:** Same SSE payload shapes emitted via `build-stream-writer.js`. No subscriber-visible changes — Vision Surface, CLI progress, and any external listeners see identical events.

4. **Gate handling delegates to same policy evaluator:** `evaluatePolicy()` in `server/policy-evaluator.js` is called by the runner, not reimplemented. Gate mode (gate/flag/skip) logic stays in one place.

5. **CLI entry point (`compose build`) becomes a thin wrapper:**
   - Default: instantiates `PipelineRunner`
   - `--legacy` flag: falls back to the original `build.js` `runBuild()` path
   - This allows safe rollback during migration.

6. **Resume:** `PipelineRunner` reads `active-build.json` + Stratum flow state, same as `build.js`. The resume path is compatible in both directions — a build started by `build.js` can be resumed by `PipelineRunner` and vice versa.

7. **Contract tests (migration gates):**
   - [ ] SSE event payload shapes match between old and new runner
   - [ ] `active-build.json` format is byte-compatible (same keys, same value types)
   - [ ] Gate resolution flow produces identical policy evaluator calls
   - [ ] CLI flags (`--resume`, `--step`, `--dry-run`) work identically
   - [ ] Resume of a legacy-started build completes under PipelineRunner

### Dependencies

- COMP-AGT-1 (interrupt): Runner must be able to kill agents that exceed budgets
- COMP-AGT-2 (health monitoring): Runner uses health probes to detect stuck agents
- COMP-AGT-3 (resource limits): Runner enforces wall-clock and memory limits

---

## Decision 2: Stagnation Detection Model (HARNESS-2)

### Trust Problem

An agent can produce high activity (many tool calls, file reads, terminal commands) while making zero progress. Current crash detection in `build-stream-bridge.js:14` uses a 5-minute inactivity timer (`DEFAULT_CRASH_TIMEOUT_MS = 300_000`), but this only catches *silent* hangs. An actively-spiraling agent that reads the same files repeatedly, or retries the same failing approach, is invisible to inactivity timers.

In the retry loop (build.js:624-674), there is no check for whether the retry actually changed anything. The agent gets violations, produces a response, and the result goes to `stratum.stepDone()` regardless of whether the environment changed.

### Design

**Environmental delta tracking** -- measure what actually changed on disk, not what the agent claims changed.

```js
// server/stagnation-detector.js

class StagnationDetector {
  #snapshots = [];         // Array of EnvironmentSnapshot
  #windowSize;             // Number of iterations to look back
  #thresholds;             // { warn: number, abort: number }

  /**
   * Take a snapshot of the environment state.
   * Returns a content-addressed summary.
   *
   * Verification is contract-driven and tiered (see HARNESS-8):
   * - Cheap (always): Content hash comparison — SHA256 of changed files, detects any file delta in <1s
   * - Medium (when step contract references tests): Run `npm test` or equivalent only for
   *   steps whose ensure clauses reference test outcomes
   * - Expensive (final gate only): Full codex review + complete test suite
   *
   * By default, snapshot() only captures the cheap tier. Medium/expensive tiers
   * are triggered by the TieredEvaluator (HARNESS-8) based on step contract.
   */
  async snapshot(cwd, { includeMedium = false } = {}) {
    const snap = {
      timestamp: Date.now(),
      fileHashes: await this.#hashChangedFiles(cwd),    // Map<path, sha256> — always, <1s
    };

    // Medium tier: only when the step's ensure clauses reference test/lint outcomes
    if (includeMedium) {
      snap.testResults = await this.#runTestSuite(cwd);      // { passing, failing, output_hash }
      snap.lintResults = await this.#runLinter(cwd);         // { errors, warnings, output_hash }
    }

    return snap;
  }

  /**
   * Compare two snapshots and return a delta.
   * Delta of zero = no progress.
   */
  delta(before, after) {
    const filesChanged = this.#diffHashes(before.fileHashes, after.fileHashes);
    const testsImproved = after.testResults.passing > before.testResults.passing
                       || after.testResults.failing < before.testResults.failing;
    const lintImproved = after.lintResults.errors < before.lintResults.errors;
    const outputChanged = after.testResults.output_hash !== before.testResults.output_hash;

    return {
      filesChanged,                        // number of files with different content
      testsImproved,                       // boolean
      lintImproved,                        // boolean
      outputChanged,                       // boolean -- even if counts are same, output differs
      score: filesChanged + (testsImproved ? 2 : 0) + (lintImproved ? 1 : 0),
    };
  }

  /**
   * Evaluate whether the pipeline should warn or abort.
   * Called after each iteration completes.
   *
   * Step categories control stagnation behavior:
   * - 'mutating' (execute, fix, refactor): zero file delta after 2 iterations = warn, 3 = abort
   * - 'analytical' (plan, review, scope, design): zero file delta is expected —
   *    stagnation checks the OUTPUT artifact hash instead (did the plan/review change?)
   * - 'gated' (gate steps): no stagnation check — human-controlled
   *
   * The category is read from step metadata in the pipeline template.
   */
  evaluate(iterationNumber, { stepCategory = 'mutating', outputArtifactHash = null } = {}) {
    // Gated steps are human-controlled — never flag stagnation
    if (stepCategory === 'gated') {
      return { action: 'continue' };
    }

    const recent = this.#snapshots.slice(-this.#windowSize);
    const deltas = [];
    for (let i = 1; i < recent.length; i++) {
      deltas.push(this.delta(recent[i - 1], recent[i]));
    }

    let zeroProgressCount;

    if (stepCategory === 'analytical') {
      // For analytical steps, zero file delta is expected.
      // Stagnation means the output artifact itself didn't change.
      if (outputArtifactHash === null) return { action: 'continue' };
      zeroProgressCount = this.#countConsecutiveStaleArtifacts(outputArtifactHash);
    } else {
      // For mutating steps, zero file delta = no progress
      zeroProgressCount = deltas.filter(d => d.score === 0).length;
    }

    if (zeroProgressCount >= this.#thresholds.abort) {
      return { action: 'abort', reason: `${zeroProgressCount} consecutive iterations with zero ${stepCategory === 'analytical' ? 'output artifact' : 'environmental'} delta` };
    }
    if (zeroProgressCount >= this.#thresholds.warn) {
      return { action: 'warn', reason: `${zeroProgressCount} iterations without measurable progress` };
    }
    return { action: 'continue' };
  }

  /**
   * Track output artifact hashes for analytical steps.
   * Returns the number of consecutive iterations where the artifact hash was unchanged.
   */
  #artifactHashes = [];
  #countConsecutiveStaleArtifacts(currentHash) {
    this.#artifactHashes.push(currentHash);
    let count = 0;
    for (let i = this.#artifactHashes.length - 1; i > 0; i--) {
      if (this.#artifactHashes[i] === this.#artifactHashes[i - 1]) count++;
      else break;
    }
    return count;
  }
}

/**
 * Step category classification.
 * Used by PipelineRunner to pass the correct category to evaluate().
 */
const STEP_CATEGORIES = {
  execute:      'mutating',
  fix:          'mutating',
  refactor:     'mutating',
  run_tests:    'mutating',
  docs:         'mutating',
  plan:         'analytical',
  review:       'analytical',
  scope:        'analytical',
  design:       'analytical',
  prd:          'analytical',
  architecture: 'analytical',
  blueprint:    'analytical',
  gate:         'gated',
  approve:      'gated',
  await_gate:   'gated',
  ship:         'gated',
};
```

**Default thresholds:**
- `warn`: 2 zero-delta iterations (inject warning into next prompt)
- `abort`: 3 consecutive zero-delta iterations (halt step, record in audit)
- For `analytical` steps, "zero-delta" means the output artifact hash is unchanged (not file system delta)
- For `gated` steps, stagnation checks are skipped entirely

**File hashing:** SHA256 of file contents for all files in `git diff --name-only HEAD` plus `git ls-files --others --exclude-standard`. This reuses the same git commands already in build.js:451 but adds content hashing.

### Integration

- `PipelineRunner.#executeStep()` calls `stagnationDetector.snapshot()` before and after each agent dispatch
- On retry (`ensure_failed`), the detector compares pre-retry and post-retry snapshots
- Stagnation warnings are injected into the retry prompt via `buildRetryPrompt()` as additional context
- Abort triggers `stratum.iterationAbort()` and records the reason in the audit trail
- The detector state resets when the step changes (stagnation is per-step, not per-flow)

### Dependencies

- HARNESS-1: Runner must exist to call the detector
- HARNESS-6: Stagnation events recorded in tamper-evident audit

---

## Decision 3: Effort Budget System (HARNESS-3)

### Trust Problem

An agent can consume unbounded resources within a single step. Current timeouts (build.js:72-87, `STEP_TIMEOUT_MS`) are wall-clock limits only -- a 45-minute timeout for `execute` allows an enormous number of tool calls. An agent could read hundreds of files, make dozens of failed attempts, or explore irrelevant code paths, all within the timeout window.

The `AgentTimeoutError` (result-normalizer.js:129) is a blunt instrument that kills the entire step after a fixed duration. There is no mechanism to set proportional limits based on step complexity.

### Design

**Tool-call budget** -- each step gets a budget of tool invocations that depletes as the agent works.

```js
// server/effort-budget.js

class EffortBudget {
  #remaining;
  #initial;
  #stepId;
  #toolCounts = {};     // tool_name -> count

  constructor(stepId, budget) {
    this.#stepId = stepId;
    this.#initial = budget;
    this.#remaining = budget;
  }

  /**
   * Deduct a tool call. Returns false if budget exhausted.
   * Different tools have different costs.
   */
  deduct(toolName) {
    const cost = TOOL_COSTS[toolName] ?? 1;
    this.#remaining -= cost;
    this.#toolCounts[toolName] = (this.#toolCounts[toolName] ?? 0) + 1;
    return this.#remaining > 0;
  }

  get exhausted() { return this.#remaining <= 0; }
  get remaining() { return this.#remaining; }

  summary() {
    return {
      stepId: this.#stepId,
      initial: this.#initial,
      remaining: this.#remaining,
      consumed: this.#initial - this.#remaining,
      toolCounts: { ...this.#toolCounts },
    };
  }
}

/**
 * Tool cost weights. Write operations cost more than reads.
 * Costs are approximate -- the budget is a circuit breaker, not a billing system.
 */
const TOOL_COSTS = {
  Read:      1,
  Glob:      1,
  Grep:      1,
  Bash:      3,     // shell commands are high-impact
  Edit:      2,
  Write:     2,
  Agent:     5,     // spawning sub-agents is expensive
  // Default: 1
};

/**
 * Default budgets per step type.
 * These are generous -- they should only fire on genuine spirals.
 */
const STEP_BUDGETS = {
  scope:          50,
  prd:           100,
  architecture:  100,
  blueprint:     150,
  plan:          100,
  execute:       300,
  review:         80,
  run_tests:      50,
  report:         60,
  docs:           80,
  ship:           20,
};
const DEFAULT_BUDGET = 150;
```

**Budget enforcement point:** Inside `runAndNormalize()`, the harness intercepts `tool_use` events from the connector's async generator. When the budget is exhausted, the harness calls `connector.interrupt()` (from COMP-AGT-1) and synthesizes a result indicating budget exhaustion.

```js
// In PipelineRunner.#runWithBudget():
for await (const event of connector.run(prompt, {})) {
  if (event.type === 'tool_use') {
    if (!budget.deduct(event.tool)) {
      connector.interrupt();
      auditor.record({ type: 'budget_exhausted', ...budget.summary() });
      return { text: '', result: { outcome: 'budget_exhausted', summary: budget.summary() } };
    }
  }
  // ... normal event handling
}
```

### Integration

- `PipelineRunner` creates a budget per step dispatch via `budgetManager.allocate(stepId)`
- Tool events from the connector's async generator are counted against the budget
- Budget exhaustion triggers agent interrupt (COMP-AGT-1) and records the event
- Budget summaries are included in the audit trail (HARNESS-6) and iteration ledger (HARNESS-9)
- Retries get a fresh budget (same size) -- the budget is per-attempt, not per-step

### Dependencies

- HARNESS-1: Runner holds the budget and the connector event stream
- COMP-AGT-1: `connector.interrupt()` must work reliably to stop the agent

---

## Decision 4: Independent Verification Protocol (HARNESS-4)

### Trust Problem

This is the core trust gap. In the current flow:

```
agent returns { clean: true, findings: [] }
    |
    v
stratum.stepDone(flow_id, step_id, { clean: true, findings: [] })
    |
    v
stratum checks: ensure result.clean == True  -->  PASS
```

Stratum's postcondition enforcement is sound -- it correctly rejects `clean: false`. But the input to the check is agent-controlled. The harness must generate its own ground-truth data.

### Design

**Verification protocol** -- each step type has a registered verifier that independently confirms the agent's work.

```js
// server/verification.js

class Verifier {
  #verifiers = new Map();   // step_type -> VerificationFn

  constructor() {
    this.#verifiers.set('review',    this.#verifyReview.bind(this));
    this.#verifiers.set('run_tests', this.#verifyTests.bind(this));
    this.#verifiers.set('execute',   this.#verifyExecution.bind(this));
    this.#verifiers.set('docs',      this.#verifyDocs.bind(this));
    this.#verifiers.set('plan',      this.#verifyPlan.bind(this));
  }

  /**
   * Verify agent output independently.
   * Returns the result that the HARNESS will pass to stratum.stepDone().
   */
  async verify(dispatch, agentOutput, envBefore) {
    const envAfter = await this.snapshot(dispatch.cwd);
    const envDelta = this.#computeDelta(envBefore, envAfter);

    // Resolve step type from pipeline template metadata (preferred) or fall back to step_id (legacy compat).
    // Each step in the template should declare type: 'execute'|'review'|'test'|'plan'|'design'|'gate'.
    const stepType = dispatch.step_type ?? (() => {
      console.warn(`[harness] step "${dispatch.step_id}" missing step_type in template metadata — falling back to step_id matching (deprecated)`);
      return dispatch.step_id;
    })();

    const verifier = this.#verifiers.get(stepType);
    const policy = this.#verifierPolicy(stepType);

    if (!verifier) {
      // Deny-by-default: if the step has ensure clauses and no verifier, reject.
      if (policy === 'required') {
        return {
          result: { outcome: 'ensure_failed', _harnessVerified: false,
                    _rejection: `No registered verifier for step type "${stepType}" but verifierPolicy is "required"` },
          envDelta,
        };
      }
      // 'optional' steps (plan, design) — pass through with delta annotation
      // 'skip' steps (human-gated) — pass through unchanged
      return {
        result: { ...agentOutput.result, _harnessVerified: false },
        envDelta,
      };
    }

    const verified = await verifier(dispatch, agentOutput, envDelta);
    return { result: { ...verified, _harnessVerified: true }, envDelta };
  }

  /**
   * Determine the verifier policy for a step type.
   * - 'required': step has ensure clauses → must have a registered verifier or reject
   * - 'optional': analytical steps (plan, design, scope, prd) → pass-through allowed
   * - 'skip': human-gated steps → no automated verification
   */
  #verifierPolicy(stepType) {
    const OPTIONAL_STEPS = new Set(['plan', 'design', 'scope', 'prd', 'architecture', 'blueprint']);
    const SKIP_STEPS = new Set(['gate', 'approve', 'await_gate']);
    if (SKIP_STEPS.has(stepId)) return 'skip';
    if (OPTIONAL_STEPS.has(stepId)) return 'optional';
    return 'required';  // default for steps with ensure clauses
  }
}
```

**Review verification (`#verifyReview`):**

The harness does not trust the executor's review result. Instead:

1. Harness takes a snapshot of all changed files (content hashes)
2. Harness spawns a *separate* reviewer agent (via HARNESS-7 routing -- always a different agent than the executor)
3. Reviewer receives the file list and diffs, returns `{ clean: boolean, findings: string[] }`
4. Harness compares reviewer's findings against executor's claimed result
5. If reviewer finds issues the executor claimed were fixed, the harness-constructed result is `{ clean: false }`

```js
async #verifyReview(dispatch, agentOutput, envDelta) {
  // 1. Harness selects reviewer (not executor). Router enforces executor ≠ reviewer
  //    at the connector level (different `type` field).
  const executorAgent = dispatch._executorAgent;
  const reviewerType = this.router.selectReviewer(dispatch);  // Never same as executor

  // 2. Build exact file:hash pairs for the reviewer — not just file names
  const reviewedFileHashes = {};
  for (const file of envDelta.changedFiles) {
    reviewedFileHashes[file] = envDelta.fileHashes?.[file] ?? await sha256File(resolve(dispatch.cwd, file));
  }

  // 2b. Reviewer runs against a snapshotted diff, NOT the live workspace.
  //     This ensures the reviewer is read-only by construction — it receives
  //     diff text as context, not workspace access. No Write/Edit tools needed.
  const diffText = await this.#generateDiff(dispatch.cwd, envDelta.changedFiles);

  const reviewer = this.connectorFactory(reviewerType, {
    cwd: dispatch.cwd,
    // Reviewer gets read-only tool set only (no Write/Edit).
    // Prefer diff-based approach: reviewer receives diff text, not live workspace.
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
  });

  // 3. Reviewer receives diff text and file:hash pairs — not workspace write access
  const reviewPrompt = buildReviewPrompt(envDelta.changedFiles, {
    fileHashes: reviewedFileHashes,
    diffText,  // reviewer works from this snapshot, not live files
  });
  const reviewResult = await runAndNormalize(reviewer, reviewPrompt, {
    output_fields: { clean: 'boolean', findings: 'array' },
  });

  // 4. Harness captures full reviewer transcript/structured result
  const reviewerTranscript = reviewResult.rawText ?? '';
  const reviewerStructured = reviewResult.result ?? {};

  // 5. Audit entry binds all provenance fields:
  //    reviewer agent ID, executor agent ID, reviewed file hashes,
  //    reviewer raw output, extracted verdict
  return {
    clean: reviewerStructured.clean ?? false,
    findings: reviewerStructured.findings ?? [],
    _reviewerAgent: reviewerType,
    _executorAgent: executorAgent,
    _reviewedFileHashes: reviewedFileHashes,
    _reviewerTranscript: reviewerTranscript,
    _reviewerVerdict: reviewerStructured,
    _executorClaimed: agentOutput.result,
  };
}
```

**Test verification (`#verifyTests`):**

The harness runs the test suite itself -- it does not ask an agent to report pass/fail.

```js
async #verifyTests(dispatch, agentOutput, envDelta) {
  // Run tests directly -- no agent involvement
  const testCmd = dispatch.inputs?.testCommand ?? 'npm test';
  const { exitCode, stdout, stderr } = await execWithTimeout(testCmd, {
    cwd: dispatch.cwd,
    timeout: 120_000,
  });

  const passing = exitCode === 0;

  // Parse coverage from stdout if available
  const coverageMatch = stdout.match(/Statements\s*:\s*([\d.]+)%/);
  const coverage = coverageMatch ? parseFloat(coverageMatch[1]) : null;

  return {
    passing,
    exitCode,
    coverage,
    outputHash: sha256(stdout + stderr),
    _agentClaimed: agentOutput.result,
  };
}
```

**Execution verification (`#verifyExecution`):**

After the execute step, the harness checks that claimed artifacts actually exist and have content.

```js
async #verifyExecution(dispatch, agentOutput, envDelta) {
  const claimed = agentOutput.result ?? {};
  const checks = [];

  // Verify claimed artifact exists
  if (claimed.artifact && typeof claimed.artifact === 'string') {
    const exists = existsSync(resolve(dispatch.cwd, claimed.artifact));
    checks.push({ check: 'artifact_exists', path: claimed.artifact, passed: exists });
  }

  // Verify files were actually changed
  if (envDelta.filesChanged === 0 && claimed.outcome === 'complete') {
    checks.push({ check: 'files_changed', passed: false, reason: 'Agent claimed complete but no files changed' });
  }

  const allPassed = checks.every(c => c.passed);
  return {
    ...claimed,
    outcome: allPassed ? claimed.outcome : 'incomplete',
    _verificationChecks: checks,
  };
}
```

### Integration

- `PipelineRunner.#executeStep()` calls `verifier.verify()` between agent output and `stratum.stepDone()`
- The verified result replaces the agent's self-reported result in the stratum call
- Agent's original claimed result is preserved in `_executorClaimed` / `_agentClaimed` fields for audit
- Verification failures trigger the same retry logic as `ensure_failed` (Stratum sees a failing result and dispatches a retry)

### Dependencies

- HARNESS-1: Verification runs inside the runner's step execution
- HARNESS-5: Anti-gaming builds on verification by adding persistent scoring
- HARNESS-7: Review verification requires multi-agent routing to select an independent reviewer
- HARNESS-8: Tiered evaluation controls which verification tier runs per step (cheap hash-only vs. medium test-inclusive vs. expensive full review)
- COMP-AGT-1: Reviewer agent must be interruptible if it hangs

---

## Decision 5: Anti-Gaming Verification (HARNESS-5)

### Trust Problem

Even with independent verification (HARNESS-4), agents can game the system through several tactics:

1. **Suppress-to-pass:** Add `// eslint-disable`, `@SuppressWarnings`, or `skip()` to tests. The harness runs tests and they pass -- but the quality has degraded.

2. **Wontfix-to-clean:** The reviewer finds 5 issues. The executor adds `// WONTFIX` comments. The reviewer re-reviews and finds 0 new issues -- the old ones are now "acknowledged." `clean: true` is technically correct.

3. **Minimal-change theater:** Agent changes whitespace or comments to produce a non-zero environmental delta, passing stagnation detection, while not addressing the actual issues.

4. **Test deletion:** Agent deletes failing tests. Test suite passes. Coverage drops, but if coverage isn't a hard gate, this succeeds.

### Design

**Persistent quality score** that tracks quality across iterations within a review loop. The score can go *down* -- quality regressions are detected and penalized.

```js
// server/quality-scorer.js

class QualityScorer {
  #history = [];    // Array of QualitySnapshot

  /**
   * Score the current state. Compares against previous scores
   * to detect regressions.
   */
  async score(cwd, envDelta) {
    const snapshot = {
      iteration: this.#history.length,
      timestamp: Date.now(),

      // Lint/style metrics (harness-run, not agent-reported)
      lintErrors: await this.#countLintErrors(cwd),
      lintWarnings: await this.#countLintWarnings(cwd),

      // Test metrics
      testsPassing: envDelta.testResults?.passing ?? 0,
      testsFailing: envDelta.testResults?.failing ?? 0,
      testsTotal: (envDelta.testResults?.passing ?? 0) + (envDelta.testResults?.failing ?? 0),

      // Suppress detection
      suppressions: await this.#countSuppressions(cwd, envDelta.changedFiles),

      // Content quality signals
      deletedLines: envDelta.deletedLines ?? 0,
      addedLines: envDelta.addedLines ?? 0,
    };

    // Compare against previous iteration
    const prev = this.#history.length > 0 ? this.#history[this.#history.length - 1] : null;
    if (prev) {
      snapshot.regressions = this.#detectRegressions(prev, snapshot);
    }

    this.#history.push(snapshot);
    return snapshot;
  }

  #detectRegressions(prev, current) {
    const regressions = [];

    // Test count decreased (test deletion)
    if (current.testsTotal < prev.testsTotal) {
      regressions.push({
        type: 'test_deletion',
        detail: `Tests decreased from ${prev.testsTotal} to ${current.testsTotal}`,
        severity: 'high',
      });
    }

    // Suppressions increased
    if (current.suppressions > prev.suppressions) {
      regressions.push({
        type: 'suppression_increase',
        detail: `Suppressions increased from ${prev.suppressions} to ${current.suppressions}`,
        severity: 'high',
      });
    }

    // Lint errors increased
    if (current.lintErrors > prev.lintErrors) {
      regressions.push({
        type: 'lint_regression',
        detail: `Lint errors increased from ${prev.lintErrors} to ${current.lintErrors}`,
        severity: 'medium',
      });
    }

    // Net deletion without corresponding test improvement
    if (current.deletedLines > current.addedLines * 2 && !current.testsImproved) {
      regressions.push({
        type: 'suspicious_deletion',
        detail: `High deletion ratio (${current.deletedLines} deleted, ${current.addedLines} added) without test improvement`,
        severity: 'medium',
      });
    }

    return regressions;
  }

  /**
   * Count suppression patterns in changed files.
   * Detects eslint-disable, @ts-ignore, @SuppressWarnings, skip(), .skip, etc.
   */
  async #countSuppressions(cwd, changedFiles) {
    const patterns = [
      /eslint-disable/,
      /@ts-ignore/,
      /@ts-expect-error/,
      /\bskip\(\)/,
      /\.skip\b/,
      /@SuppressWarnings/,
      /noinspection/,
      /NOSONAR/,
      /pragma:\s*no\s*cover/,
    ];

    let count = 0;
    for (const file of changedFiles) {
      const content = readFileSync(resolve(cwd, file), 'utf-8');
      for (const pattern of patterns) {
        const matches = content.match(new RegExp(pattern, 'g'));
        if (matches) count += matches.length;
      }
    }
    return count;
  }
}
```

**Rejection rules:**

The harness rejects results when anti-gaming checks fail:

```js
// In Verifier.verify(), after step-specific verification:

async #applyAntiGaming(dispatch, verified, envDelta) {
  const score = await this.qualityScorer.score(dispatch.cwd, envDelta);

  // Rule 1: Reject clean:true with zero file changes
  if (verified.clean === true && envDelta.filesChanged === 0) {
    return { ...verified, clean: false,
      _rejection: 'clean claimed but no files changed since last iteration' };
  }

  // Rule 2: Reject if suppressions increased
  if (score.regressions?.some(r => r.type === 'suppression_increase')) {
    return { ...verified, clean: false,
      _rejection: 'quality score regression: suppression count increased' };
  }

  // Rule 3: Reject if test count decreased
  if (score.regressions?.some(r => r.type === 'test_deletion')) {
    return { ...verified, passing: false,
      _rejection: 'quality score regression: test count decreased' };
  }

  // Rule 4: Reject if net deletions are suspicious
  if (score.regressions?.some(r => r.type === 'suspicious_deletion' && r.severity === 'high')) {
    return { ...verified, outcome: 'suspicious',
      _rejection: 'high deletion ratio without corresponding quality improvement' };
  }

  return verified;
}
```

### Integration

- `QualityScorer` is owned by the `PipelineRunner`, persisted per-step across iterations
- Quality scores are recorded in the audit trail (HARNESS-6) and iteration ledger (HARNESS-9)
- Regressions inject warnings into the retry prompt so the agent knows *why* it was rejected
- The scorer resets when the step changes (quality is tracked per-step, not per-flow)

### Dependencies

- HARNESS-4: Anti-gaming operates on the verified result, not the agent's raw output
- HARNESS-2: Stagnation detection uses quality score deltas as a signal
- HARNESS-6: Quality history recorded in audit trail
- HARNESS-9: Quality regressions recorded as "mistakes" in the iteration ledger

---

## Decision 6: Tamper-Evident Audit Trail (HARNESS-6)

### Trust Problem

Current audit storage is via `stratum_audit` which writes to vision items (stratum-sync.js). This is a JSON blob that any process with write access to the data directory can modify. There is no integrity check -- if an agent (or a bug) overwrites the audit data, there is no way to detect it.

Furthermore, the current audit trace only records what Stratum saw -- which is the agent's self-reported result. There is no record of what the harness independently verified vs. what the agent claimed.

### Design

**Hash-chained JSONL** -- append-only log where each entry includes the SHA256 hash of the previous entry.

The audit ledger is stored OUTSIDE the agent-accessible cwd to prevent agents from rewriting the chain:

- **Primary:** `.compose/data/audit/{flowId}.jsonl` (in the compose data directory, not the project cwd)
- **Entries written by the harness process only** (append-only, no agent tool access)
- Each entry sealed with: `{ seq, prev_hash, timestamp, ... }`
- Final root digest written to vision item evidence (existing `stratum_audit` pattern)
- Verification: `AuditChain.verify()` walks the chain and checks `hash(entry[n-1]) === entry[n].prev_hash`

```
File: .compose/data/audit/{featureCode}/{flowId}.audit.jsonl

Entry format:
{
  "seq": 0,
  "ts": "2026-03-28T14:30:00.000Z",
  "prev_hash": "0000000000000000000000000000000000000000000000000000000000000000",
  "type": "run_start",
  "featureCode": "AUTH-3",
  "flowId": "flow_abc123",
  "specHash": "sha256_of_spec_yaml"
}
{
  "seq": 1,
  "ts": "2026-03-28T14:30:05.000Z",
  "prev_hash": "a1b2c3d4...",  // SHA256 of entry seq=0
  "type": "step_dispatched",
  "stepId": "execute",
  "agent": "claude",
  "budgetAllocated": 300
}
{
  "seq": 2,
  "ts": "2026-03-28T14:35:00.000Z",
  "prev_hash": "e5f6a7b8...",  // SHA256 of entry seq=1
  "type": "step_verified",
  "stepId": "execute",
  "agentClaimed": { "outcome": "complete", "artifact": "lib/auth.js" },
  "harnessVerified": { "outcome": "complete", "artifact_exists": true, "filesChanged": 3 },
  "envDelta": { "fileHashes": { "lib/auth.js": "sha256..." } },
  "qualityScore": { ... },
  "budgetConsumed": { "initial": 300, "remaining": 142, "toolCounts": { ... } }
}
```

**Implementation:**

```js
// server/audit-chain.js

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';

class AuditChain {
  #filePath;
  #seq = 0;
  #lastHash = '0'.repeat(64);   // genesis hash

  /**
   * @param {string} featureCode
   * @param {string} flowId
   * @param {string} dataDir - Must be the compose data directory (.compose/data),
   *   NOT the project cwd. This keeps the audit ledger outside agent-accessible paths.
   */
  constructor(featureCode, flowId, dataDir) {
    const dir = join(dataDir, 'audit', featureCode);
    mkdirSync(dir, { recursive: true });
    this.#filePath = join(dir, `${flowId}.audit.jsonl`);

    // If file exists, recover chain state
    if (existsSync(this.#filePath)) {
      this.#recoverChain();
    }
  }

  /**
   * Append an entry to the chain.
   * Returns the hash of the appended entry.
   */
  record(entry) {
    const record = {
      seq: this.#seq,
      ts: new Date().toISOString(),
      prev_hash: this.#lastHash,
      ...entry,
    };

    const serialized = JSON.stringify(record);
    const hash = createHash('sha256').update(serialized).digest('hex');

    appendFileSync(this.#filePath, serialized + '\n', 'utf-8');

    this.#lastHash = hash;
    this.#seq++;
    return hash;
  }

  /**
   * Verify the integrity of the entire chain.
   * Returns { valid: boolean, entries: number, brokenAt?: number }.
   */
  static verify(filePath) {
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    let prevHash = '0'.repeat(64);

    for (let i = 0; i < lines.length; i++) {
      const entry = JSON.parse(lines[i]);
      if (entry.prev_hash !== prevHash) {
        return { valid: false, entries: lines.length, brokenAt: i };
      }
      prevHash = createHash('sha256').update(lines[i]).digest('hex');
    }

    return { valid: true, entries: lines.length };
  }

  /**
   * Recover chain state from existing file.
   */
  #recoverChain() {
    const lines = readFileSync(this.#filePath, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) return;

    const lastLine = lines[lines.length - 1];
    const lastEntry = JSON.parse(lastLine);
    this.#seq = lastEntry.seq + 1;
    this.#lastHash = createHash('sha256').update(lastLine).digest('hex');
  }
}
```

**Recorded event types:**

| Type | When | Fields |
|------|------|--------|
| `run_start` | Pipeline begins | featureCode, flowId, specHash |
| `step_dispatched` | Step sent to agent | stepId, agent, budgetAllocated |
| `step_verified` | Harness verifies result | agentClaimed, harnessVerified, envDelta, qualityScore |
| `step_done` | Stratum accepts result | stepId, stratumResponse |
| `budget_exhausted` | Budget depleted | stepId, budgetSummary |
| `stagnation_detected` | Zero-delta detected | iterationCount, deltas |
| `gate_resolved` | Human/policy gate | stepId, outcome, rationale, resolver |
| `quality_regression` | Score went down | regressions, previousScore, currentScore |
| `iteration_result` | Iteration completes | iterationNumber, delta, mistakes, fixes |
| `run_complete` | Pipeline finishes | status, totalSteps, totalDuration |

### Integration

- `AuditChain` instance created per flow run inside `PipelineRunner`
- Every decision point in the runner records to the chain
- Chain verification runs at `stratum_audit` time and the result is included in the audit summary
- Existing `stratum-sync.js` vision item updates continue alongside the chain (UI compatibility)
- Build-stream events continue for SSE (the chain is for integrity, not real-time display)

### Dependencies

- HARNESS-1: All audit recording happens inside the runner
- None from Phase 6.9 (pure data structure, no agent interaction)

---

## Decision 7: Multi-Agent Routing (HARNESS-7)

### Trust Problem

In the current system, the `agent` field on step dispatches determines which connector handles the step (build.js:416, `const agentType = response.agent ?? 'claude'`). This is specified in the `.stratum.yaml` spec, which is authored by the project -- but there is no enforcement that the executor and reviewer are different agents.

The `review_check` child flow (build.js:603-622) dispatches to whatever agent the spec says. If the spec says `agent: claude` for both execute and review, the same Claude instance reviews its own work. Even if the spec says `agent: codex` for review, there is no runtime check that the reviewer is actually different from the executor.

Self-review has a structural confirmation bias: the same model that wrote the code tends to find it acceptable.

### Design

**Agent routing table** with hard constraints:

```js
// server/agent-router.js

class AgentRouter {
  #routes;
  #executorLog = new Map();   // stepId -> agentType used for execution

  constructor(routes = DEFAULT_ROUTES) {
    this.#routes = routes;
  }

  /**
   * Select an agent for a step dispatch.
   * Enforces the executor/reviewer separation invariant.
   */
  select(dispatch) {
    // Prefer explicit step_type from pipeline template metadata; fall back to step_id classification (legacy compat)
    const stepType = dispatch.step_type ?? (() => {
      console.warn(`[router] step "${dispatch.step_id}" missing step_type — falling back to step_id classification (deprecated)`);
      return this.#classifyStep(dispatch.step_id);
    })();
    const route = this.#routes[stepType] ?? this.#routes.default;

    // For review-type steps, enforce separation
    if (stepType === 'review') {
      const executorAgent = this.#executorLog.get(this.#findExecuteStep(dispatch));
      if (executorAgent && route.agent === executorAgent) {
        // Spec requested same agent as executor -- override to alternate
        return route.fallback ?? this.#alternateAgent(executorAgent);
      }
    }

    return route.agent;
  }

  /**
   * Record which agent executed a step (called after dispatch).
   */
  recordExecution(stepId, agentType) {
    this.#executorLog.set(stepId, agentType);
  }

  /**
   * Return an agent that is NOT the given one.
   */
  #alternateAgent(agentType) {
    if (agentType === 'claude') return 'codex';
    if (agentType === 'codex') return 'claude';
    return 'codex';  // default reviewer fallback
  }

  /**
   * Classify a step ID into a routing category.
   */
  #classifyStep(stepId) {
    if (stepId === 'review' || stepId.includes('review')) return 'review';
    if (stepId === 'run_tests' || stepId.includes('test') || stepId.includes('coverage')) return 'test';
    if (stepId === 'execute' || stepId === 'plan' || stepId === 'blueprint') return 'execute';
    if (stepId === 'scope' || stepId === 'prd' || stepId === 'architecture') return 'design';
    return 'default';
  }
}

const DEFAULT_ROUTES = {
  execute:  { agent: 'claude' },
  design:   { agent: 'claude' },
  review:   { agent: 'codex', fallback: 'claude' },  // codex default; claude if codex unavailable
  test:     { agent: 'claude' },  // test running is harness-verified (HARNESS-4), agent choice less critical
  default:  { agent: 'claude' },
};
```

**Invariant enforcement:**

The router maintains a log of which agent executed each step. When a review step is dispatched, the router checks the log and guarantees the reviewer is different from the executor. This is a hard constraint -- the router overrides the spec if necessary.

```
Execute step:  route -> claude   (recorded in executorLog)
Review step:   route -> codex    (different from executor)

If codex is unavailable:
Execute step:  route -> claude   (recorded)
Review step:   HARD FAIL -- no independent reviewer available, surface to human gate
```

**No-independent-reviewer hard fail:** If only one agent type is available (e.g., codex connector not configured), the router does **not** fall back to same-agent review. The stated invariant is "executor and reviewer are provably different agents" -- a fresh conversation with the same model is not a different agent, it is the same model with the same biases. Instead, the harness rejects the review step with `{ verification_failed: true, reason: 'no independent reviewer available' }` and surfaces the step to human review via the gate mechanism. This preserves the invariant: either a genuinely different agent reviews, or a human does.

### Integration

- `PipelineRunner` uses `AgentRouter.select()` before every `connectorFactory()` call
- Router replaces the current `response.agent ?? 'claude'` pattern in build.js:416
- The selected agent is recorded in the audit trail (HARNESS-6) alongside the step result
- COMP-AGT-13 (agent templates) can extend the routing table with specialized agent types
- COMP-AGT-14 (capability registry) feeds the router's capability matching

### Dependencies

- HARNESS-1: Router is a component of the pipeline runner
- HARNESS-4: Review verification uses the router to select the independent reviewer
- COMP-AGT-13 (future): Agent templates enrich routing options
- COMP-AGT-14 (future): Capability registry constrains which agents can handle which steps

---

## Decision 8: Tiered Evaluation (HARNESS-8)

### Trust Problem

Current evaluation is binary: either the full gate fires (human review, full test suite, full codex review) or it does not. This is expensive. A review loop that takes 10 minutes per iteration running a full codex review + full test suite wastes time when a 5-second check could have detected that the agent made no meaningful changes.

The `evaluatePolicy()` function (server/policy-evaluator.js) handles gate mode (gate/flag/skip) but operates at the step level, not at the iteration level within a retry loop.

### Design

**Two-tier evaluation**: cheap fast checks run first; expensive full checks only run when fast checks pass.

```
Agent completes iteration
    |
    v
TIER 1: Fast checks (< 10 seconds)
  - Did flagged files actually change? (content hash comparison)
  - Did the specific failing test pass? (run single test, not full suite)
  - Did lint error count decrease?
  - Did suppression count stay the same or decrease?
    |
    +--> Any fast check FAILS --> skip full evaluation, return to agent with specific failure
    |
    v
TIER 2: Full checks (1-10 minutes)
  - Full test suite
  - Full codex review
  - Quality scoring
  - Anti-gaming verification
```

**Implementation:**

```js
// server/tiered-evaluator.js

class TieredEvaluator {
  /**
   * Run tier-1 fast checks. Returns early if any fail.
   * @returns {{ passed: boolean, failures: string[], durationMs: number }}
   */
  async fastCheck(dispatch, agentOutput, envBefore) {
    const start = Date.now();
    const failures = [];
    const envAfter = await this.verifier.snapshot(dispatch.cwd);

    // Fast check 1: Progress actually happened (step-category-aware)
    // Uses the same step categories as HARNESS-2 stagnation detection.
    const delta = this.stagnationDetector.delta(envBefore, envAfter);
    const stepCategory = STEP_CATEGORIES[dispatch.step_type ?? dispatch.step_id] ?? 'mutating';

    if (stepCategory === 'mutating') {
      // Mutating steps: zero file delta = fast-fail
      if (delta.filesChanged === 0) {
        failures.push('No files changed since last iteration');
      }
    } else if (stepCategory === 'analytical') {
      // Analytical steps: check output artifact hash (did the plan/review/design change?)
      const currentArtifactHash = agentOutput.result?._artifactHash ?? null;
      const prevArtifactHash = dispatch._previousArtifactHash ?? null;
      if (currentArtifactHash && prevArtifactHash && currentArtifactHash === prevArtifactHash) {
        failures.push('Output artifact unchanged since last iteration');
      }
    }
    // Gated steps: skip fast check entirely (human-controlled)

    // Fast check 2: Specific failing test (if known from previous iteration)
    if (dispatch._failingTest) {
      const result = await this.#runSingleTest(dispatch.cwd, dispatch._failingTest);
      if (!result.passed) {
        failures.push(`Failing test still fails: ${dispatch._failingTest}`);
      }
    }

    // Fast check 3: Lint error count
    if (dispatch._previousLintErrors !== undefined) {
      const currentErrors = await this.#countLintErrors(dispatch.cwd);
      if (currentErrors >= dispatch._previousLintErrors) {
        failures.push(`Lint errors did not decrease (was ${dispatch._previousLintErrors}, now ${currentErrors})`);
      }
    }

    // Fast check 4: Suppression count
    if (dispatch._previousSuppressions !== undefined) {
      const currentSuppressions = await this.qualityScorer.countSuppressions(dispatch.cwd, delta.changedFiles);
      if (currentSuppressions > dispatch._previousSuppressions) {
        failures.push(`Suppressions increased (was ${dispatch._previousSuppressions}, now ${currentSuppressions})`);
      }
    }

    return {
      passed: failures.length === 0,
      failures,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Run tier-2 full checks. Only called when fast checks pass.
   */
  async fullCheck(dispatch, agentOutput, envBefore) {
    // This is the existing verification protocol from HARNESS-4
    return this.verifier.verify(dispatch, agentOutput, envBefore);
  }

  /**
   * Run a single test file or test case.
   */
  async #runSingleTest(cwd, testIdentifier) {
    // testIdentifier format: "path/to/test.js" or "path/to/test.js::testName"
    const [file, testName] = testIdentifier.split('::');
    const cmd = testName
      ? `npx vitest run ${file} -t "${testName}"`
      : `npx vitest run ${file}`;

    try {
      const { exitCode } = await execWithTimeout(cmd, { cwd, timeout: 30_000 });
      return { passed: exitCode === 0 };
    } catch {
      return { passed: false };
    }
  }
}
```

**Cost savings:** In a typical review loop of 5 iterations, if iterations 2-4 fail fast checks (common when the agent is stuck), the harness saves 3 full codex review invocations (approx. 3-10 minutes each) and 3 full test suite runs.

### Integration

- `PipelineRunner.#handleRetry()` runs `TieredEvaluator.fastCheck()` before `fullCheck()`
- Fast check failures skip the full verification and immediately construct a rejection result for `stratum.stepDone()`
- Fast check results are recorded in the audit trail (HARNESS-6) and iteration ledger (HARNESS-9)
- The evaluator enriches the dispatch with `_failingTest`, `_previousLintErrors`, etc. from the previous iteration's results, creating a targeted fast-check profile

### Dependencies

- HARNESS-2: Stagnation detector provides delta computation
- HARNESS-4: Full verification is the tier-2 check
- HARNESS-5: Anti-gaming (suppression counting) is a fast check input
- HARNESS-9: Fast check results recorded in iteration ledger

---

## Decision 9: Iteration Ledger (HARNESS-9)

### Trust Problem

Current iteration history in `build.js` is a flat array of `{ stepId, artifact, summary, outcome }` entries (build.js:437-444). This captures *what* happened but not *why* it failed, *what* the agent got wrong, or *what rule* would prevent the mistake in the future.

When a retry loop runs 5 iterations, the agent on iteration 5 has no structured knowledge of what went wrong in iterations 1-4. The retry prompt (build.js:637, `buildRetryPrompt()`) includes violations but not the pattern of mistakes across iterations.

### Design

**Per-iteration JSONL log** with structured mistake/fix/prevention records.

```
File: .compose/data/ledger/{featureCode}/{flowId}-{stepId}.ledger.jsonl

Entry format (one per iteration):
{
  "iteration": 2,
  "ts": "2026-03-28T14:45:00.000Z",
  "stepId": "review",
  "agent": "claude",

  "envDelta": {
    "filesChanged": 3,
    "fileHashes": { "lib/auth.js": "abc123...", "lib/auth.test.js": "def456..." },
    "testsImproved": true,
    "lintImproved": false
  },

  "fastCheckResult": {
    "passed": true,
    "durationMs": 3200
  },

  "fullCheckResult": {
    "clean": false,
    "findings": ["Missing error handling in auth.js:42", "No test for edge case X"]
  },

  "qualityScore": {
    "lintErrors": 3,
    "suppressions": 0,
    "testsPassing": 12,
    "testsFailing": 2,
    "regressions": []
  },

  "budgetConsumed": {
    "initial": 300,
    "remaining": 185,
    "toolCounts": { "Read": 15, "Edit": 8, "Bash": 4 }
  },

  "mistakes": [
    {
      "type": "missing_error_handling",
      "location": "lib/auth.js:42",
      "description": "Async function lacks try/catch around database call",
      "severity": "high"
    }
  ],

  "fixes": [
    {
      "type": "added_error_handling",
      "location": "lib/auth.js:38-45",
      "description": "Wrapped database call in try/catch, returns 500 on failure",
      "resolves": "missing_error_handling"
    }
  ],

  "preventionRules": [
    {
      "rule": "All async database calls must have error handling",
      "pattern": "async.*db\\.|await.*query",
      "applies_to": ["lib/**/*.js"]
    }
  ]
}
```

**Ledger construction:**

The harness constructs each ledger entry from the verification results, not from agent claims:

```js
// server/iteration-ledger.js

class IterationLedger {
  #filePath;
  #entries = [];

  constructor(featureCode, flowId, stepId, dataDir) {
    const dir = join(dataDir, 'ledger', featureCode);
    mkdirSync(dir, { recursive: true });
    this.#filePath = join(dir, `${flowId}-${stepId}.ledger.jsonl`);
  }

  /**
   * Record an iteration result.
   * Mistakes and fixes are extracted by comparing consecutive iterations.
   */
  record(entry) {
    const prev = this.#entries.length > 0 ? this.#entries[this.#entries.length - 1] : null;

    // Auto-extract mistakes from verification failures
    if (!entry.mistakes && entry.fullCheckResult?.findings) {
      entry.mistakes = entry.fullCheckResult.findings.map(f => ({
        type: 'review_finding',
        description: f,
        severity: 'medium',
      }));
    }

    // Auto-extract fixes by comparing with previous iteration's mistakes
    if (!entry.fixes && prev?.mistakes) {
      entry.fixes = prev.mistakes
        .filter(m => !entry.mistakes?.some(current => current.description === m.description))
        .map(m => ({
          type: 'resolved',
          description: `Fixed: ${m.description}`,
          resolves: m.type,
        }));
    }

    // Auto-generate prevention rules from recurring mistakes
    if (prev?.mistakes && entry.mistakes) {
      const recurring = entry.mistakes.filter(m =>
        prev.mistakes.some(pm => pm.type === m.type)
      );
      if (recurring.length > 0) {
        entry.preventionRules = recurring.map(m => ({
          rule: `Recurring issue: ${m.description}`,
          recurrenceCount: this.#countRecurrences(m.type),
        }));
      }
    }

    this.#entries.push(entry);
    appendFileSync(this.#filePath, JSON.stringify(entry) + '\n', 'utf-8');
  }

  /**
   * Get the full iteration history for prompt enrichment.
   * Returns a compact summary suitable for injection into retry prompts.
   */
  summary() {
    return this.#entries.map((e, i) => ({
      iteration: i,
      outcome: e.fullCheckResult?.clean ? 'passed' : 'failed',
      findings: e.fullCheckResult?.findings?.length ?? 0,
      fixed: e.fixes?.length ?? 0,
      remaining: e.mistakes?.length ?? 0,
      preventionRules: e.preventionRules ?? [],
    }));
  }

  /**
   * Count how many times a mistake type has recurred across all iterations.
   */
  #countRecurrences(type) {
    return this.#entries.filter(e => e.mistakes?.some(m => m.type === type)).length;
  }
}
```

**Prompt enrichment:**

The ledger summary is injected into retry prompts so the agent has structured knowledge of its history:

```js
// In PipelineRunner, when building retry prompts:
const ledgerSummary = iterationLedger.summary();
const enrichedPrompt = buildRetryPrompt(dispatch, violations, context, conflicts) +
  `\n\n## Iteration History\n` +
  ledgerSummary.map(s =>
    `Iteration ${s.iteration}: ${s.outcome} (${s.findings} findings, ${s.fixed} fixed, ${s.remaining} remaining)`
  ).join('\n') +
  (ledgerSummary.some(s => s.preventionRules.length > 0)
    ? `\n\n## Prevention Rules (recurring issues)\n` +
      ledgerSummary.flatMap(s => s.preventionRules).map(r => `- ${r.rule}`).join('\n')
    : '');
```

**SmartMemory ingestion:**

When a step completes (all iterations done), the ledger's prevention rules are candidates for ingestion into SmartMemory (COMP-MEM-2). This is a future integration point -- the ledger writes the rules, SmartMemory consumes them.

### Integration

- One `IterationLedger` instance per step within a retry loop
- Entries are written after each verification (HARNESS-4) completes
- Ledger summary enriches retry prompts via `buildRetryPrompt()` in `step-prompt.js`
- Prevention rules accumulate across iterations and surface recurring patterns
- Ledger entries are also referenced by audit chain entries (HARNESS-6) via iteration number

### Dependencies

- HARNESS-4: Verification results populate ledger entries
- HARNESS-5: Quality scores included in ledger entries
- HARNESS-8: Fast/full check results recorded in ledger
- COMP-MEM-2 (future): Prevention rules ingested for cross-session learning

---

## Approach Summary

| Item | Module | Trust Problem Solved | Verification Mechanism |
|------|--------|---------------------|----------------------|
| HARNESS-1 | `server/pipeline-runner.js` | Agent controls orchestration | Harness owns the step loop; agents are workers |
| HARNESS-2 | `server/stagnation-detector.js` | Activity without progress | Content-hash delta across iterations |
| HARNESS-3 | `server/effort-budget.js` | Unbounded resource consumption | Tool-call counting with per-step limits |
| HARNESS-4 | `server/verification.js` | Agent self-reports pass/fail | Harness runs tests, calls independent reviewer |
| HARNESS-5 | `server/quality-scorer.js` | Suppress/delete/wontfix gaming | Persistent quality score that detects regressions |
| HARNESS-6 | `server/audit-chain.js` | Audit data can be tampered with | SHA256 hash-chained append-only JSONL |
| HARNESS-7 | `server/agent-router.js` | Self-review confirmation bias | Hard constraint: executor != reviewer |
| HARNESS-8 | `server/tiered-evaluator.js` | Expensive checks on stuck iterations | Cheap fast checks gate expensive full checks |
| HARNESS-9 | `server/iteration-ledger.js` | No structured learning across retries | Per-iteration JSONL with mistake/fix/prevention |

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `server/pipeline-runner.js` | new | Core harness: step dispatch, verification, audit orchestration |
| `server/stagnation-detector.js` | new | Content-hash delta tracking, zero-progress detection |
| `server/effort-budget.js` | new | Per-step tool-call budget with weighted costs |
| `server/verification.js` | new | Independent verification protocol per step type |
| `server/quality-scorer.js` | new | Persistent quality scoring, suppression detection, regression tracking |
| `server/audit-chain.js` | new | SHA256 hash-chained JSONL audit trail |
| `server/agent-router.js` | new | Multi-agent routing with executor/reviewer separation |
| `server/tiered-evaluator.js` | new | Two-tier evaluation: fast checks then full checks |
| `server/iteration-ledger.js` | new | Per-iteration JSONL log with mistake/fix/prevention rules |
| `lib/build.js` | existing | Thin CLI wrapper; delegates to PipelineRunner |
| `lib/result-normalizer.js` | existing | Unchanged; still extracts JSON from agent output |
| `lib/step-prompt.js` | existing | Extended with ledger summary injection for retries |
| `lib/stratum-mcp-client.js` | existing | Unchanged; harness uses same MCP API |
| `server/connectors/agent-connector.js` | existing | Unchanged; harness uses existing connector interface |

---

## Open Questions

1. **Verification for design steps (scope, prd, architecture):** These steps produce documents, not testable code. What does independent verification look like for a PRD? Options: (a) structural checks only (file exists, has expected sections), (b) separate reviewer rates quality, (c) skip verification for design steps. Leaning toward (a) with optional (b).

2. **Test command discovery:** HARNESS-4's test verification runs `npm test` by default. For polyglot projects, the test command varies. Should the harness read this from `compose.json`, from the `.stratum.yaml` spec, or auto-detect from package.json/Makefile/etc.?

3. **Quality scorer calibration:** The suppression patterns and regression thresholds in HARNESS-5 are heuristic. Should these be configurable per-project (via `compose.json`), or should we start with fixed defaults and tune based on observed false positive rates?

4. **Codex availability:** HARNESS-7 assumes codex is available as an independent reviewer. What is the degradation path when codex is not configured? The current design falls back to fresh-conversation Claude, but this is weaker separation. Should the harness warn or block?

5. **Audit chain rotation:** HARNESS-6 creates one JSONL file per flow. For long-running features with many retries, this file could grow large. Should we rotate (one file per step? cap at N entries?) or is append-only simplicity more valuable?

6. **Fast check extensibility (HARNESS-8):** The current fast checks are hardcoded (file change, single test, lint, suppressions). Should there be a plugin/hook system for project-specific fast checks, or is the fixed set sufficient for V1?

7. **Prevention rule quality:** HARNESS-9's auto-generated prevention rules are heuristic (recurring mistake type => rule). These could be noisy. Should we gate prevention rule generation behind a minimum recurrence count (e.g., 3+ occurrences), or accept all rules and let SmartMemory filter?
