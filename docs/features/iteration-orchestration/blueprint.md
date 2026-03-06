# Iteration Orchestration (L6): Implementation Blueprint

**Status:** BLUEPRINT
**Date:** 2026-03-06
**Design:** [design.md](./design.md)

---

## File Plan

### 1. `server/lifecycle-constants.js` (existing)

Add `ITERATION_DEFAULTS` after `TRANSITIONS` (line 27), before `PHASE_ARTIFACTS` (line 29):

```js
export const ITERATION_DEFAULTS = {
  review:   { maxIterations: 10 },
  coverage: { maxIterations: 15 },
};
```

No changes to `PHASES`, `TRANSITIONS`, or `TERMINAL`. Iteration loops happen within a phase (execute), not as phase transitions.

### 2. `server/lifecycle-manager.js` (existing)

**a) Add `iterationState: null` to lifecycle object** — insert after `policyOverrides: null` at line 55, before the closing `}` at line 56:

```js
      policyOverrides: null,
      iterationState: null,   // ← new
    };
```

**b) Add three new public methods after `approveGate` (line 203), before `reconcile` (line 205):**

```js
  startIterationLoop(itemId, loopType, { maxIterations } = {}) {
    const { lifecycle } = this.#getLifecycle(itemId);
    if (lifecycle.currentPhase !== 'execute') {
      throw new Error(`Cannot start iteration loop outside execute phase (current: ${lifecycle.currentPhase})`);
    }
    if (lifecycle.iterationState && !lifecycle.iterationState.completedAt) {
      throw new Error(`Iteration loop already active: ${lifecycle.iterationState.loopId}`);
    }
    const defaults = ITERATION_DEFAULTS[loopType];
    if (!defaults) throw new Error(`Unknown loop type: ${loopType}`);

    const loopId = `iter-${uuidv4()}`;
    lifecycle.iterationState = {
      loopType,
      loopId,
      phase: 'execute',
      count: 0,
      maxIterations: maxIterations || defaults.maxIterations,
      startedAt: new Date().toISOString(),
      completedAt: null,
      outcome: null,
      iterations: [],
    };
    this.#store.updateLifecycle(itemId, lifecycle);
    return { loopId, loopType, maxIterations: lifecycle.iterationState.maxIterations };
  }

  reportIterationResult(itemId, { clean, passing, summary, findings, failures }) {
    const { lifecycle } = this.#getLifecycle(itemId);
    const state = lifecycle.iterationState;
    if (!state || state.completedAt) {
      throw new Error('No active iteration loop');
    }

    const n = state.count + 1;
    const now = new Date().toISOString();

    // Determine if exit criteria met
    const exitCriteriaMet = state.loopType === 'review' ? (clean === true) : (passing === true);

    state.iterations.push({
      n,
      startedAt: state.iterations.length > 0 ? state.iterations[state.iterations.length - 1].completedAt || now : state.startedAt,
      completedAt: now,
      result: { clean, passing, summary, findings, failures },
    });
    state.count = n;

    let continueLoop = true;
    if (exitCriteriaMet) {
      state.completedAt = now;
      state.outcome = 'clean';
      continueLoop = false;
    } else if (n >= state.maxIterations) {
      state.completedAt = now;
      state.outcome = 'max_reached';
      continueLoop = false;
    }

    this.#store.updateLifecycle(itemId, lifecycle);

    return {
      loopId: state.loopId,
      loopType: state.loopType,
      count: n,
      maxIterations: state.maxIterations,
      exitCriteriaMet,
      continueLoop,
      outcome: state.outcome,
    };
  }

  getIterationStatus(itemId) {
    const { lifecycle } = this.#getLifecycle(itemId);
    return lifecycle.iterationState || null;
  }
```

**c) Import `ITERATION_DEFAULTS`** — update the import at line 16 (and re-export at line 15):

```js
// Line 15 — re-export:
export { PHASES, TERMINAL, SKIPPABLE, TRANSITIONS, PHASE_ARTIFACTS, ITERATION_DEFAULTS } from './lifecycle-constants.js';
// Line 16 — import:
import { PHASES, TERMINAL, SKIPPABLE, TRANSITIONS, PHASE_ARTIFACTS, ITERATION_DEFAULTS } from './lifecycle-constants.js';
```

The existing `uuidv4` import at line 10 is already present — no new import needed.

### 3. `server/vision-routes.js` (existing)

Add 3 new endpoints after the gate resolve endpoint (line 335), before the summary endpoint (line 337):

```js
  // ── Iteration endpoints ─────────────────────────────────────────────────

  app.post('/api/vision/items/:id/lifecycle/iteration/start', (req, res) => {
    try {
      const { loopType, maxIterations } = req.body;
      if (!loopType) return res.status(400).json({ error: 'loopType is required' });
      const result = lifecycleManager.startIterationLoop(req.params.id, loopType, { maxIterations });
      scheduleBroadcast();
      broadcastMessage({
        type: 'iterationStarted',
        itemId: req.params.id,
        loopId: result.loopId,
        loopType,
        maxIterations: result.maxIterations,
        timestamp: new Date().toISOString(),
      });
      res.json(result);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  });

  app.post('/api/vision/items/:id/lifecycle/iteration/report', (req, res) => {
    try {
      const result = lifecycleManager.reportIterationResult(req.params.id, req.body);
      scheduleBroadcast();
      const now = new Date().toISOString();
      broadcastMessage({
        type: 'iterationUpdate',
        itemId: req.params.id,
        loopId: result.loopId,
        loopType: result.loopType,
        count: result.count,
        maxIterations: result.maxIterations,
        exitCriteriaMet: result.exitCriteriaMet,
        continueLoop: result.continueLoop,
        timestamp: now,
      });
      if (!result.continueLoop) {
        broadcastMessage({
          type: 'iterationComplete',
          itemId: req.params.id,
          loopId: result.loopId,
          loopType: result.loopType,
          outcome: result.outcome,
          finalCount: result.count,
          timestamp: now,
        });
      }
      res.json(result);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  });

  app.get('/api/vision/items/:id/lifecycle/iteration', (req, res) => {
    try {
      const result = lifecycleManager.getIterationStatus(req.params.id);
      if (!result) return res.status(404).json({ error: 'No iteration state' });
      res.json(result);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  });
```

Pattern follows existing lifecycle/gate endpoints exactly. Each POST calls `scheduleBroadcast()` + `broadcastMessage()`.

### 4. `server/compose-mcp-tools.js` (existing)

Add 3 new tool functions after `toolGetPendingGates` (line 337):

```js
export async function toolStartIterationLoop({ id, loopType, maxIterations }) {
  if (!id) throw new Error('id is required');
  if (!loopType) throw new Error('loopType is required');
  return _postLifecycle(id, 'iteration/start', { loopType, maxIterations });
}

export async function toolReportIterationResult({ id, clean, passing, summary, findings, failures }) {
  if (!id) throw new Error('id is required');
  return _postLifecycle(id, 'iteration/report', { clean, passing, summary, findings, failures });
}

export function toolGetIterationStatus({ id }) {
  if (!id) throw new Error('id is required');
  const { items } = loadVisionState();
  const item = items.find(i => i.id === id || i.semanticId === id || i.slug === id);
  if (!item) return { error: `Item not found: ${id}` };
  return item.lifecycle?.iterationState || { error: 'No iteration state' };
}
```

`start` and `report` use `_postLifecycle` (line 229) — same pattern as `toolAdvanceFeaturePhase`. `status` reads from disk via `loadVisionState()` — same pattern as `toolGetPendingGates`.

### 5. `server/compose-mcp.js` (existing)

**a) Add tool definitions to TOOLS array** — insert before the closing `];` at line 247:

```js
    {
      name: 'start_iteration_loop',
      description: 'Start a review or coverage iteration loop within the execute phase. Returns loop ID and max iterations.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Vision item ID' },
          loopType: { type: 'string', enum: ['review', 'coverage'], description: 'Type of iteration loop' },
          maxIterations: { type: 'number', description: 'Override max iterations (default: 10 review, 15 coverage)' },
        },
        required: ['id', 'loopType'],
      },
    },
    {
      name: 'report_iteration_result',
      description: 'Report one iteration result. Returns whether to continue the loop or exit.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Vision item ID' },
          clean: { type: 'boolean', description: 'Review loop: true if no actionable findings remain' },
          passing: { type: 'boolean', description: 'Coverage loop: true if all tests pass' },
          summary: { type: 'string', description: 'Brief summary of this iteration' },
          findings: { type: 'array', items: { type: 'string' }, description: 'Review findings (strings)' },
          failures: { type: 'array', items: { type: 'string' }, description: 'Test failures (strings)' },
        },
        required: ['id'],
      },
    },
    {
      name: 'get_iteration_status',
      description: 'Get the current iteration loop state for a feature item.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Vision item ID' },
        },
        required: ['id'],
      },
    },
```

**b) Add switch cases** — insert before `default:` at line 283:

```js
      case 'start_iteration_loop':    result = await toolStartIterationLoop(args); break;
      case 'report_iteration_result': result = await toolReportIterationResult(args); break;
      case 'get_iteration_status':    result = toolGetIterationStatus(args); break;
```

**c) Add imports** — update the import at the top of compose-mcp.js to include the 3 new functions from compose-mcp-tools.js.

### 6. `src/components/vision/visionMessageHandler.js` (existing)

Add iteration message handlers between `gateResolved` (line 141) and `snapshotRequest` (line 143):

```js
  } else if (msg.type === 'iterationStarted' || msg.type === 'iterationUpdate' || msg.type === 'iterationComplete') {
    // Surface iteration events in the agent activity feed
    setAgentActivity(prev => {
      let detail;
      if (msg.type === 'iterationStarted') {
        detail = `${msg.loopType} loop started (0/${msg.maxIterations})`;
      } else if (msg.type === 'iterationComplete') {
        detail = `${msg.loopType ?? 'loop'} loop complete (${msg.outcome} after ${msg.finalCount} iterations)`;
      } else {
        detail = `${msg.loopType ?? 'loop'} iteration ${msg.count}/${msg.maxIterations}`;
      }
      const next = [...prev, {
        tool: 'iteration',
        category: msg.loopType || 'iteration',
        detail,
        items: [],  // iteration events are not tracker item objects — don't populate "Working on"
        timestamp: msg.timestamp,
      }];
      return next.length > 20 ? next.slice(-20) : next;
    });

    // Surface max_reached as a visible error in AgentPanel's error section + bump session error count
    if (msg.type === 'iterationComplete' && msg.outcome === 'max_reached') {
      setAgentErrors(prev => {
        const next = [...prev, {
          errorType: 'iteration_limit',
          severity: 'warning',
          message: `${msg.loopType ?? 'Loop'} hit max iterations (${msg.finalCount}) — problem may be in the spec`,
          timestamp: msg.timestamp,
        }];
        return next.length > 10 ? next.slice(-10) : next;
      });
      setSessionState(prev => prev?.active ? { ...prev, errorCount: (prev.errorCount || 0) + 1 } : prev);
    }

  }
```

No new state fields needed. Iteration events are rendered as activity entries, using the existing `agentActivity` array and `AgentPanel` rendering. The `tool: 'iteration'` value and `category: msg.loopType` give the UI enough to style these differently if desired later.

### 7. `pipelines/coverage-sweep.stratum.yaml` (new)

```yaml
version: "0.1"

# coverage-sweep pipeline
#
# Runs test coverage verification via a fix-then-test loop:
#   1. execute_tests — run the test suite once
#   2. fix_and_test  — fix failures, re-run tests, repeat until passing or max retries
#
# Inputs:
#   task      — what was implemented (for context in fix prompts)
#   plan      — the implementation plan (for test scope)

contracts:
  TestResult:
    passing:  {type: boolean}
    summary:  {type: string}
    failures: {type: array}

functions:
  execute_tests:
    mode: compute
    intent: >
      Run the project test suite. Return a structured result with passing status,
      summary, and any failure details.
    input:
      task: {type: string}
    output: TestResult
    retries: 1

  fix_and_test:
    mode: compute
    intent: >
      Implement one full fix-then-test cycle using the agent_run MCP tool.

      Step A — Fix (skip on first attempt if no prior failures):
        If this is a retry (previous ensure failed with failures), call agent_run
        with type "claude". Pass the original task plus the previous failures.
        Instruct Claude to fix every failure before proceeding.

      Step B — Test:
        Run the test suite. Return structured JSON with:
          { passing: boolean, summary: string, failures: string[] }
        Set passing=true only if all tests pass.
    input:
      task:            {type: string}
      execute_summary: {type: string}
      plan:            {type: string}
    output: TestResult
    ensure:
      - "result.passing == true"
    retries: 15

flows:
  coverage_sweep:
    input:
      task: {type: string}
      plan: {type: string}
    output: TestResult
    steps:
      - id: execute
        function: execute_tests
        inputs:
          task: "$.input.task"

      - id: sweep
        function: fix_and_test
        inputs:
          task:            "$.input.task"
          execute_summary: "$.steps.execute.output.summary"
          plan:            "$.input.plan"
        depends_on: [execute]
```

### 8. Tests

**`test/iteration-manager.test.js` (new)** — Pure logic tests for lifecycle manager iteration methods:

- `startIterationLoop` creates iterationState with correct defaults
- `startIterationLoop` rejects outside execute phase
- `startIterationLoop` rejects when loop already active
- `startIterationLoop` accepts maxIterations override
- `reportIterationResult` increments count
- `reportIterationResult` with `clean: true` completes review loop
- `reportIterationResult` with `passing: true` completes coverage loop
- `reportIterationResult` at max iterations returns `outcome: 'max_reached'`
- `reportIterationResult` rejects when no active loop
- `getIterationStatus` returns null when no iteration
- `getIterationStatus` returns active state during loop

Pattern: follows `policy-engine.test.js` — import manager, create in-memory store, call methods directly.

**`test/iteration-routes.test.js` (new)** — Integration tests for REST endpoints:

- POST iteration/start returns loopId
- POST iteration/start requires loopType
- POST iteration/start rejects outside execute phase
- POST iteration/report returns continueLoop
- POST iteration/report with clean=true returns continueLoop=false
- POST iteration/report at max returns outcome max_reached
- GET iteration returns current state
- GET iteration returns 404 when no iteration
- Broadcast shapes: `iterationStarted` and `iterationUpdate` messages verified
- MCP tool schemas: `compose-mcp.js` contains all 3 iteration tool names

Pattern: follows `lifecycle-routes.test.js` — Express + ephemeral port + in-memory store + `request()` helper.

**`test/iteration-client.test.js` (new)** — Client handler tests:

- `iterationStarted` adds activity entry with loop type and max
- `iterationUpdate` adds activity entry with count
- `iterationUpdate` with `outcome: 'max_reached'` calls `setAgentErrors` with `errorType: 'iteration_limit'` and increments `sessionState.errorCount`
- activity entries have empty `items` array (not bare strings)

Pattern: follows `gate-client.test.js` — import `handleVisionMessage`, call with mock setters.

---

## Corrections Table

| # | Assumption | Reality | Impact |
|---|-----------|---------|--------|
| 1 | `lifecycle-manager.js` imports ITERATION_DEFAULTS | Not yet — must add to import at line 16 (and re-export at line 15) | Add to both import and re-export statements |
| 2 | `compose-mcp.js` import includes iteration tools | Not yet — must add 3 new function imports | Add to import statement |
| 3 | Token budget comment at compose-mcp.js:19-23 is stale | Only counts original 5 tools, not the 9 added since | Update comment when adding iteration tools |
| 4 | `_postLifecycle` helper works for nested paths | Must verify it handles `iteration/start` as the action parameter | Passes as URL path segment, should work: `/api/vision/items/${id}/lifecycle/iteration/start` |
| 5 | `visionMessageHandler.js` has `sessionBound` handler at line 94 | Added by L5 (session binding), not in original codebase | Blueprint targets current file state including L5 changes |
| 6 | `AgentPanel.jsx` needs no changes | Iteration events render as standard activity entries | Correct — no AgentPanel changes needed |
| 7 | `loopType` field is enough to distinguish review vs coverage exit criteria | Yes — `clean` for review, `passing` for coverage | Verified in design D2 |

---

## Verification Checklist

After implementation, verify:

- [ ] `startIterationLoop` rejects if `currentPhase !== 'execute'`
- [ ] `startIterationLoop` rejects if a loop is already active
- [ ] `reportIterationResult` increments count each call
- [ ] `reportIterationResult` with `clean: true` ends review loop
- [ ] `reportIterationResult` with `passing: true` ends coverage loop
- [ ] `reportIterationResult` at max returns `max_reached`, not an error
- [ ] `continueLoop` is `true` until exit criteria met or max reached
- [ ] WS broadcast `iterationStarted` includes loopType and maxIterations
- [ ] WS broadcast `iterationUpdate` includes count and exitCriteriaMet
- [ ] MCP tools work end-to-end via compose-mcp.js
- [ ] Client handler adds iteration events to agentActivity array
- [ ] `getIterationStatus` returns null when no iteration, object when active
- [ ] Full test suite passes (current 267 + new iteration tests)
- [ ] Build passes
