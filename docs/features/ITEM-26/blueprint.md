# ITEM-26: Iteration Orchestration — Blueprint

## Key Finding

The client-side message handler for iteration events **already exists** (visionMessageHandler.js:159-190). It handles `iterationStarted`, `iterationUpdate`, `iterationComplete` and renders them in the activity feed. Only server-side work is needed.

## File Plan

| File | Action | Lines |
|------|--------|-------|
| `server/vision-routes.js` | MODIFY (existing) | +60 after line 266 |
| `server/compose-mcp-tools.js` | MODIFY (existing) | +15 after line 298 |
| `server/compose-mcp.js` | MODIFY (existing) | +45 tool defs after line 169, +3 cases after line 289 |
| `pipelines/coverage-sweep.stratum.yaml` | CREATE | ~40 |
| `test/iteration-routes.test.js` | CREATE | ~120 |

No UI changes needed — visionMessageHandler.js already handles all 3 message types.

## Task 1: Add iteration REST endpoints to vision-routes.js

Insert after `lifecycle/complete` route (line 266), before artifact endpoints (line 268).

**Constants** (add near TRANSITIONS/SKIPPABLE at ~line 125):

```js
const ITERATION_TYPES = new Set(['review', 'coverage']);
```

**Route 1: POST /api/vision/items/:id/lifecycle/iteration/start**

```js
app.post('/api/vision/items/:id/lifecycle/iteration/start', (req, res) => {
  try {
    const item = store.items.get(req.params.id);
    if (!item?.lifecycle) return res.status(404).json({ error: 'No lifecycle on this item' });
    const { loopType, maxIterations } = req.body;
    if (!ITERATION_TYPES.has(loopType)) {
      return res.status(400).json({ error: `Invalid loopType: ${loopType}. Must be one of: ${[...ITERATION_TYPES].join(', ')}` });
    }
    if (item.lifecycle.iterationState?.status === 'running') {
      return res.status(409).json({ error: 'An iteration loop is already running' });
    }

    // Resolve max from settings or request
    const settingsMax = settingsStore?.get()?.iterations?.[loopType]?.maxIterations;
    const max = maxIterations ?? settingsMax ?? 10;

    const now = new Date().toISOString();
    item.lifecycle.iterationState = {
      loopType,
      loopId: `iter-${Date.now()}`,
      status: 'running',
      count: 0,
      maxIterations: max,
      startedAt: now,
      completedAt: null,
      outcome: null,
      iterations: [],
    };
    store.updateLifecycle(req.params.id, item.lifecycle);
    scheduleBroadcast();
    broadcastMessage({
      type: 'iterationStarted', itemId: req.params.id,
      loopId: item.lifecycle.iterationState.loopId,
      loopType, maxIterations: max, timestamp: now,
    });
    res.json(item.lifecycle.iterationState);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
```

**Route 2: POST /api/vision/items/:id/lifecycle/iteration/report**

```js
app.post('/api/vision/items/:id/lifecycle/iteration/report', (req, res) => {
  try {
    const item = store.items.get(req.params.id);
    if (!item?.lifecycle?.iterationState) return res.status(404).json({ error: 'No iteration loop active' });
    const iter = item.lifecycle.iterationState;
    if (iter.status !== 'running') return res.status(409).json({ error: `Loop is ${iter.status}, not running` });

    const { result } = req.body;
    if (!result || typeof result !== 'object') return res.status(400).json({ error: 'result object required' });

    const now = new Date().toISOString();
    iter.count++;
    iter.iterations.push({ n: iter.count, startedAt: now, result });

    // Evaluate exit criteria
    const exitMet = iter.loopType === 'review' ? result.clean === true
                  : iter.loopType === 'coverage' ? result.passing === true
                  : false;

    let shouldContinue = true;
    if (exitMet) {
      iter.status = 'complete';
      iter.outcome = 'clean';
      iter.completedAt = now;
      shouldContinue = false;
    } else if (iter.count >= iter.maxIterations) {
      iter.status = 'complete';
      iter.outcome = 'max_reached';
      iter.completedAt = now;
      shouldContinue = false;
    }

    store.updateLifecycle(req.params.id, item.lifecycle);
    scheduleBroadcast();

    if (iter.status === 'complete') {
      broadcastMessage({
        type: 'iterationComplete', itemId: req.params.id,
        loopId: iter.loopId, loopType: iter.loopType,
        outcome: iter.outcome, finalCount: iter.count, timestamp: now,
      });
    } else {
      broadcastMessage({
        type: 'iterationUpdate', itemId: req.params.id,
        loopId: iter.loopId, loopType: iter.loopType,
        count: iter.count, maxIterations: iter.maxIterations,
        exitCriteriaMet: false, findingsCount: result.findings?.length ?? 0,
        timestamp: now,
      });
    }

    res.json({ continue: shouldContinue, count: iter.count, maxIterations: iter.maxIterations, outcome: iter.outcome });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
```

**Route 3: POST /api/vision/items/:id/lifecycle/iteration/abort**

```js
app.post('/api/vision/items/:id/lifecycle/iteration/abort', (req, res) => {
  try {
    const item = store.items.get(req.params.id);
    if (!item?.lifecycle?.iterationState) return res.status(404).json({ error: 'No iteration loop active' });
    const iter = item.lifecycle.iterationState;
    if (iter.status !== 'running') return res.status(409).json({ error: `Loop already ${iter.status}` });

    const now = new Date().toISOString();
    iter.status = 'complete';
    iter.outcome = 'aborted';
    iter.completedAt = now;
    store.updateLifecycle(req.params.id, item.lifecycle);
    scheduleBroadcast();
    broadcastMessage({
      type: 'iterationComplete', itemId: req.params.id,
      loopId: iter.loopId, loopType: iter.loopType,
      outcome: 'aborted', finalCount: iter.count, timestamp: now,
    });
    res.json({ aborted: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
```

## Task 2: Add MCP tool implementations to compose-mcp-tools.js

After `toolCompleteFeature` (line 298), add:

```js
export async function toolIterationStart({ id, loopType, maxIterations }) {
  return _postLifecycle(id, 'iteration/start', { loopType, maxIterations });
}

export async function toolIterationReport({ id, result }) {
  return _postLifecycle(id, 'iteration/report', { result });
}

export async function toolIterationAbort({ id, reason }) {
  return _postLifecycle(id, 'iteration/abort', { reason });
}
```

Reuses existing `_postLifecycle` helper (line 230).

## Task 3: Register tools in compose-mcp.js

**3a: Tool definitions** — after `complete_feature` (line 169), add 3 tool defs:

```js
{
  name: 'start_iteration_loop',
  description: 'Start a review or coverage iteration loop. Returns loop state.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Item ID or semanticId' },
      loopType: { type: 'string', enum: ['review', 'coverage'], description: 'Loop type' },
      maxIterations: { type: 'number', description: 'Override max iterations (optional)' },
    },
    required: ['id', 'loopType'],
  },
},
{
  name: 'report_iteration_result',
  description: 'Report one iteration result. Returns { continue, count, maxIterations, outcome }.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Item ID or semanticId' },
      result: { type: 'object', description: 'Iteration result (review: {clean, findings}, coverage: {passing, failures})' },
    },
    required: ['id', 'result'],
  },
},
{
  name: 'abort_iteration_loop',
  description: 'Abort the current iteration loop early.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Item ID or semanticId' },
      reason: { type: 'string', description: 'Why the loop was aborted' },
    },
    required: ['id'],
  },
},
```

**3b: Imports** — add to import block (~line 29):

```js
import { ..., toolIterationStart, toolIterationReport, toolIterationAbort } from './compose-mcp-tools.js';
```

**3c: Switch cases** — after `complete_feature` case (line 289):

```js
case 'start_iteration_loop':     result = await toolIterationStart(args); break;
case 'report_iteration_result':  result = await toolIterationReport(args); break;
case 'abort_iteration_loop':     result = await toolIterationAbort(args); break;
```

## Task 4: Create coverage-sweep.stratum.yaml

```yaml
version: "0.1"

contracts:
  CoverageResult:
    passing:  {type: boolean}
    summary:  {type: string}
    failures: {type: array}

functions:
  run_coverage:
    mode: compute
    intent: >
      Run the test suite. Return structured JSON:
      { "passing": boolean, "summary": string, "failures": string[] }.
      Set passing=true only if all tests pass with no failures.
    input:
      task: {type: string}
    output: CoverageResult
    ensure:
      - "result.passing == true"
    retries: 15

flows:
  coverage_sweep:
    input:
      task: {type: string}
    output: CoverageResult
    steps:
      - id: sweep
        function: run_coverage
        inputs:
          task: "$.input.task"
```

## Task 5: Tests (test/iteration-routes.test.js)

Test via HTTP against a real VisionServer instance (same pattern as test/gate-routes.test.js).

**Test cases:**

| # | Scenario | Assertion |
|---|----------|-----------|
| 1 | Start review loop | Returns iterationState with status='running', count=0 |
| 2 | Start with invalid loopType | 400 error |
| 3 | Start while loop already running | 409 conflict |
| 4 | Report clean result | Returns continue=false, outcome='clean' |
| 5 | Report dirty result | Returns continue=true, count incremented |
| 6 | Report past max iterations | Returns continue=false, outcome='max_reached' |
| 7 | Abort running loop | Returns aborted=true, outcome='aborted' |
| 8 | Report on non-running loop | 409 conflict |

## Verification Table

| Ref | File:Line | Verified |
|-----|-----------|----------|
| updateLifecycle method | vision-store.js:189 | Accepts lifecycle object, saves |
| lifecycle/complete route | vision-routes.js:246-266 | Pattern for new routes |
| settingsStore access | vision-routes.js: passed as `settingsStore` in deps | Available for iteration defaults |
| _postLifecycle helper | compose-mcp-tools.js:230 | Reusable for iteration tools |
| toolCompleteFeature | compose-mcp-tools.js:296 | Insertion point for new tools |
| TOOLS array | compose-mcp.js:160-169 | Insertion point for tool defs |
| switch handler | compose-mcp.js:287-289 | Insertion point for cases |
| visionMessageHandler iteration | visionMessageHandler.js:159-190 | Already handles all 3 message types |
| iterationDefaults | vision-server.js:40-43 | review: max 4, coverage: max 15 |
