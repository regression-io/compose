# STRAT-COMP-6: Web Gate Resolution — Blueprint

**Status:** PLANNED
**Created:** 2026-03-12
**Phase:** blueprint
**Prerequisite:** STRAT-COMP-4 (Vision Store Unification) must be complete before this work begins.

## Related Documents

- [STRAT-COMP-6 design](./design.md) — parent design doc
- [STRAT-COMP-4 blueprint](../STRAT-COMP-4/blueprint.md) — prerequisite: server-probe.js, VisionWriter REST mode, gate status unification
- [STRAT-COMP-8 design](../STRAT-COMP-8/design.md) — downstream consumer (active build dashboard)
- [ROADMAP.md](../../../ROADMAP.md) — Milestone 4: Unified Interface

## Corrections Table

The design doc makes assumptions that diverge from the actual source code. Every correction is verified against source with file:line references.

| # | Design Assumption | Actual Code | Impact |
|---|---|---|---|
| C1 | "VisionWriter.createGate() writes a gate record directly to vision-state.json (lib/vision-writer.js:155)" | Confirmed: `createGate()` at `vision-writer.js:155-168` writes `{ id, flowId, stepId, itemId, status: 'pending', createdAt }` via `_atomicWrite()`. | Line ref is accurate. |
| C2 | "promptGate() opens a readline loop on stdin/stdout (lib/gate-prompt.js:34)" | Confirmed: `promptGate()` at `gate-prompt.js:34` accepts `gateDispatch` and options including `{ input, output, artifact, askAgent, nonInteractive }`. Creates readline interface on stdin/stdout. | Line ref is accurate. |
| C3 | "No POST /api/vision/gates creation endpoint" | Confirmed: `vision-routes.js` has only `GET /api/vision/gates` (line 301), `GET /api/vision/gates/:id` (line 311), and `POST /api/vision/gates/:id/resolve` (line 321). No creation endpoint. | Must add `POST /api/vision/gates`. |
| C4 | "POST /api/vision/gates/:id/resolve does not notify Stratum" | Confirmed: `vision-routes.js:321-355` resolves gate in VisionStore and advances lifecycle (lines 331-346) but never calls `stratum.gateResolve()`. | Polling CLI must call `stratum.gateResolve()` itself after detecting resolution (AD-4 from STRAT-COMP-4). |
| C5 | Design says gate handling is at `build.js:245-246` | Actual: `visionWriter.resolveGate()` at line 245, `stratum.gateResolve()` at line 246. Gate creation at line 221. Full block is lines 217-247. | Line refs accurate. |
| C6 | Design says same pattern in `executeChildFlow()` "lines 397-426" | Actual: gate block at `build.js:397-426`. `createGate()` at line 400, `promptGate()` at line 419, `resolveGate()` at line 424, `stratum.gateResolve()` at line 425. | Line refs accurate. |
| C7 | Design says `lib/server-probe.js` is a new file | STRAT-COMP-4 blueprint specifies creating `lib/server-probe.js` (task 2). If STRAT-COMP-4 is complete, this file already exists. | STRAT-COMP-6 should import from `server-probe.js`, not create it. |
| C8 | Design says VisionWriter needs REST mode additions for gate delegation | STRAT-COMP-4 blueprint adds `_restCreateGate()` and `getGate()` methods (tasks 11, 13). VisionWriter will already support dual dispatch. | STRAT-COMP-6 builds on STRAT-COMP-4's REST mode, adding only the gate delegation orchestration in `build.js`. |
| C9 | Design says `POST /api/vision/gates` endpoint validates `flowId`, `stepId` as required fields | Design section 3.1 lists full payload with `flowId`, `stepId`, `itemId`, `fromPhase`, `toPhase`, `artifact`, `artifactAssessment`, `summary`. But `build.js:221` calls `createGate(flowId, stepId, itemId)` — no phase/artifact/summary data passed. | Gate creation call in `build.js` must be extended to pass full payload. The `response` object at `await_gate` carries `step_id`, `on_approve`, `on_revise`, `on_kill` — but not `fromPhase`, `toPhase`, `artifact`, or `summary`. These must come from VisionWriter's item state or the Stratum dispatch. |
| C10 | Design says `GateView.jsx` status check works with `gate.status === 'pending'` (line 226) | Confirmed: `GateView.jsx:226` checks `gate.status === 'pending'`. After STRAT-COMP-4 AD-2 fix, resolved gates will have `status: 'resolved'` so `gate.status === 'pending'` correctly identifies pending ones. | No change needed in GateView for status semantics. |
| C11 | Design says `/api/health` endpoint may need to be added | Already exists: `server/index.js:49` has `app.get('/api/health', (_req, res) => res.json({ ok: true }))`. | No action needed. |
| C12 | Design proposes gate dedup via `getGateByFlowStep(flowId, stepId)` | STRAT-COMP-4 blueprint adds `getGateByFlowStep()` (task 5). If STRAT-COMP-4 is complete, this method already exists. | Dedup logic in the new POST endpoint should use the existing method. |
| C13 | Design says `VisionStore.resolveGate()` sets `gate.status = outcome` (line 227) | Confirmed at `vision-store.js:227`. STRAT-COMP-4 AD-2 changes this to `gate.status = 'resolved'`. If STRAT-COMP-4 is complete, this is already fixed. | No action for STRAT-COMP-6. |
| C14 | Design says "summary" field comes from `response.summary` on the gate dispatch | `build.js:217` enters `await_gate` when `response.status === 'await_gate'`. The `response` object is a Stratum dispatch — it has `step_id`, `on_approve`, `on_revise`, `on_kill`. Whether it includes `summary` depends on the Stratum spec. Must verify or construct fallback. | Build the summary from available context: `response.summary` if present, else `"${LIFECYCLE_PHASE_LABELS[fromPhase]} phase complete for ${featureCode}"`. |
| C15 | Design §3.2 says poll timeout is 24 hours | Blueprint AD-4 specifies 30 minutes. 30 minutes is the correct value — generous for human review, not a hang risk. | Design §3.2 updated to say 30 minutes. |
| C16 | Design §3.1 says gate ID is UUID | `VisionWriter.createGate()` uses deterministic composite key `flowId:stepId`. Blueprint code also uses `${flowId}:${stepId}`. | Design §3.1 updated to say "deterministic composite key `flowId:stepId`". UUID removed. |
| C17 | Design §3.1 says POST response is `{ gateId }` | Blueprint returns full gate object (more useful for the caller). | Design updated: endpoint returns full gate object. `_restCreateGate()` extracts `.id` from response. |
| C18 | Gate IDs contain `:` which must be URL-encoded in paths | `flowId:stepId` composite keys contain colons. Without encoding, Express routing breaks. | `encodeURIComponent(gateId)` added to polling URL construction. |
| C19 | `POST /api/vision/gates` response shape: design says `{ gateId }`, blueprint returns full object | Full object is more useful — caller can read `.id`, and the response carries all enrichment fields. | Normalized: endpoint returns full gate object. Design updated to match. |

## Architecture Decisions

### AD-1: Gate delegation lives in build.js, not gate-delegate.js

**Decision:** Inline the delegation logic (create gate via REST, poll for resolution) directly in `build.js` rather than creating a separate `lib/gate-delegate.js` module.

**Rationale:** The design proposed `gate-delegate.js` with `delegateGate()` + `pollGateResolution()`. But after STRAT-COMP-4, VisionWriter already has `createGate()` with REST dispatch and `getGate()` for polling. The delegation logic is just: create gate, poll, call `stratum.gateResolve()`. This is ~20 lines of orchestration, not a reusable module. A `pollGateResolution()` helper function in `build.js` is sufficient.

**Impact:** No new file `lib/gate-delegate.js`. The build sequence is simpler.

### AD-2: Gate payload enrichment at creation time

**Decision:** Extend `VisionWriter.createGate()` to accept an optional `extras` object with `{ fromPhase, toPhase, artifact, artifactAssessment, summary }`. Pass these through to the REST endpoint. In direct-write mode, include them in the gate record written to `vision-state.json`.

**Rationale:** The current `createGate(flowId, stepId, itemId)` signature (vision-writer.js:155) only stores the identifiers. The web UI needs `fromPhase`, `toPhase`, and `summary` to show meaningful context. The artifact assessment is needed for the quality indicator in GateView. Without enrichment, the POST endpoint would receive an empty gate and the UI would show "Unknown -> Unknown" with no context.

**Source of enrichment data:**
- `fromPhase`: read from the item's `lifecycle.currentPhase` (VisionWriter already has `itemId` and can load state)
- `toPhase`: from `response.on_approve` or from the Stratum dispatch's transition target
- `artifact`: from `LIFECYCLE_PHASE_ARTIFACTS[fromPhase]` mapped to the feature directory
- `artifactAssessment`: call artifact assessment endpoint if server is running, skip if not
- `summary`: from `response.summary` if present, else construct fallback

### AD-3: Outcome vocabulary mapping in polling consumer

**Decision:** The polling code in `build.js` maps Vision Store outcomes to Stratum vocabulary before calling `stratum.gateResolve()`.

**Mapping:**

| Vision Store `outcome` | Stratum `outcome` |
|---|---|
| `approved` | `approve` |
| `revised` | `revise` |
| `killed` | `kill` |

**Rationale:** The server resolve endpoint (`vision-routes.js:323`) accepts `approved`, `revised`, `killed` (past tense, from GateView buttons). Stratum expects `approve`, `revise`, `kill` (imperative). The mapping is trivial and belongs at the boundary — the polling consumer in `build.js`.

### AD-4: Poll timeout with readline fallback

**Decision:** `pollGateResolution()` has a configurable timeout (default: 30 minutes). If the gate remains pending beyond the timeout, log a warning and fall back to readline prompt. This handles server crashes, network issues, or abandoned web sessions.

**Rationale:** An infinite poll loop is a hang risk. 30 minutes is generous for human review. If a gate truly needs more than 30 minutes, the user can resolve it via readline when the fallback activates.

### AD-5: GateView enhancement scope

**Decision:** Implement the five UX additions from design section 4.2 as incremental changes to the existing `GateView.jsx`, not a rewrite.

**Changes:**
1. Summary display in PendingGateRow
2. Artifact link (clickable, opens canvas)
3. Feature grouping via `useMemo`
4. Gate history (all resolved, collapsed)
5. Build-gate prominence (amber border, larger buttons when `flowId` present)

**Rationale:** GateView is well-structured (299 lines). The additions are additive — new elements in existing components, new grouping logic in the parent. No structural rewrite needed.

## Component Designs

### `server/vision-routes.js` (existing)

**Change 1: Add `POST /api/vision/gates` creation endpoint.**

Insert after line 309 (after the `GET /api/vision/gates` handler):

```js
app.post('/api/vision/gates', (req, res) => {
  try {
    const { flowId, stepId, itemId, fromPhase, toPhase, artifact, artifactAssessment, summary } = req.body;
    if (!flowId || !stepId) {
      return res.status(400).json({ error: 'flowId and stepId are required' });
    }

    // Idempotency: return existing gate if one exists for this flow:step
    const existing = store.getGateByFlowStep(flowId, stepId);
    if (existing) {
      return res.status(200).json(existing);
    }

    const gate = {
      id: `${flowId}:${stepId}`,
      flowId,
      stepId,
      itemId: itemId || null,
      fromPhase: fromPhase || null,
      toPhase: toPhase || null,
      artifact: artifact || null,
      artifactAssessment: artifactAssessment || null,
      summary: summary || null,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    store.createGate(gate);
    scheduleBroadcast();
    broadcastMessage({
      type: 'gateCreated',
      gateId: gate.id,
      itemId: gate.itemId,
      timestamp: gate.createdAt,
    });
    res.status(201).json(gate);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
```

**Validation:** `flowId` and `stepId` are required (they form the gate ID). `itemId` is optional because child flows may not have a direct item mapping. All enrichment fields (`fromPhase`, `toPhase`, `artifact`, `artifactAssessment`, `summary`) are optional.

**Note:** STRAT-COMP-4 provides the initial route scaffold for this endpoint; STRAT-COMP-6 is the canonical definition.

**Change 2: Modify `GET /api/vision/gates` to accept `?status=all`.**

Update the existing GET handler (line 301) to check for a `status` query parameter:

```js
app.get('/api/vision/gates', (req, res) => {
  const gates = req.query.status === 'all'
    ? store.getAllGates()
    : store.getPendingGates();
  res.json({ gates });
});
```

Default behavior (no query param) returns pending-only for backwards compatibility. GateView Change 5 fetches with `?status=all` to populate the history section.

### `server/vision-store.js` (existing)

**Prerequisite check:** STRAT-COMP-4 adds `getGateByFlowStep()` (task 5). If not yet present, add it:

```js
/** Find a gate by flow ID and step ID */
getGateByFlowStep(flowId, stepId) {
  const id = `${flowId}:${stepId}`;
  return this.gates.get(id) || null;
}
```

Insert after `getGatesForItem()` (line 255). Used by the creation endpoint for idempotency.

**Change 2: Add `getAllGates()` method.**

```js
/** Return all gates (pending + resolved) */
getAllGates() {
  return Array.from(this.gates.values());
}
```

Insert after `getGateByFlowStep()`. Used by the `GET /api/vision/gates?status=all` endpoint.

No other changes to vision-store.js — STRAT-COMP-4 handles atomic save (C5) and gate status semantics (C13).

### `lib/vision-writer.js` (existing)

**Prerequisite:** STRAT-COMP-4 makes all public methods async with dual dispatch (REST vs. direct). After STRAT-COMP-4, `createGate()` already delegates to REST when server is running.

**Change 1: Extend `createGate()` signature to accept enrichment data.**

Current signature (line 155): `createGate(flowId, stepId, itemId)`
New signature: `createGate(flowId, stepId, itemId, extras = {})`

In the direct-write path (`_directCreateGate`), merge extras into the gate object:

```js
const gate = {
  id: `${flowId}:${stepId}`,
  flowId,
  stepId,
  itemId,
  fromPhase: extras.fromPhase || null,
  toPhase: extras.toPhase || null,
  artifact: extras.artifact || null,
  artifactAssessment: extras.artifactAssessment || null,
  summary: extras.summary || null,
  status: 'pending',
  createdAt: new Date().toISOString(),
};
```

In the REST path (`_restCreateGate`), pass all fields in the POST body. Extract and return `gate.id` (a string) from the server response — both paths must return a string ID, not the full gate object.

**Change 2: Normalize outcome vocabulary in `resolveGate()`.**

Add normalization at the top of `resolveGate()` to map imperative to past-tense:

```js
const OUTCOME_NORMALIZE = { approve: 'approved', revise: 'revised', kill: 'killed' };
outcome = OUTCOME_NORMALIZE[outcome] || outcome;
```

This ensures the Vision Store always stores past-tense outcomes (`approved`, `revised`, `killed`) regardless of whether the caller passes imperative (`approve`) or past-tense (`approved`) vocabulary.

**Change 3: Add `getGate(gateId)` if not already added by STRAT-COMP-4.**

REST path: `GET /api/vision/gates/${encodeURIComponent(gateId)}` — returns the full gate object. The `encodeURIComponent` is required because gate IDs use composite format `flowId:stepId` which contains colons.
Direct path: load from `vision-state.json`, find gate by ID.

### `lib/build.js` (existing)

**Change 1: Add `pollGateResolution()` helper.**

```js
const GATE_POLL_INTERVAL = 2000;   // 2 seconds
const GATE_POLL_TIMEOUT = 30 * 60 * 1000; // 30 minutes

async function pollGateResolution(visionWriter, gateId) {
  const deadline = Date.now() + GATE_POLL_TIMEOUT;
  while (Date.now() < deadline) {
    const gate = await visionWriter.getGate(gateId);
    if (gate && gate.status !== 'pending') return gate;
    await new Promise(r => setTimeout(r, GATE_POLL_INTERVAL));
  }
  return null; // timeout — caller falls back to readline
}
```

Place before `executeBuild()` function, near other helpers.

**Change 2: Add outcome mapping constant.**

```js
const GATE_OUTCOME_TO_STRATUM = {
  approved: 'approve',
  revised: 'revise',
  killed: 'kill',
};
```

**Change 3: Replace `await_gate` block in main loop (lines 217-247).**

```js
} else if (response.status === 'await_gate') {
  progress.pause();
  console.log(`\nGate: ${stepId}`);

  // Build gate enrichment from available context
  const item = visionWriter.findFeatureItem
    ? await visionWriter.findFeatureItem(featureCode)
    : null;
  const fromPhase = item?.lifecycle?.currentPhase || null;
  const extras = {
    fromPhase,
    toPhase: response.on_approve || null,
    artifact: null, // populated below if available
    summary: response.summary || null,
  };

  const serverUp = await probeServer();
  if (serverUp) {
    // Delegate gate to web UI
    const gateId = await visionWriter.createGate(flowId, stepId, itemId, extras);
    console.log('Gate delegated to web UI. Waiting for resolution...');
    const resolved = await pollGateResolution(visionWriter, gateId);

    if (resolved) {
      const stratumOutcome = GATE_OUTCOME_TO_STRATUM[resolved.outcome] || resolved.outcome;
      response = await stratum.gateResolve(flowId, stepId, stratumOutcome, resolved.comment || '', 'human');
    } else {
      // Poll timeout — fall back to readline
      console.log('Gate poll timed out. Falling back to terminal prompt.');
      const { outcome, rationale } = await promptGate(response, {
        ...(opts.gateOpts ?? {}),
        artifact: context.cwd,
        askAgent,
      });
      await visionWriter.resolveGate(gateId, outcome);
      response = await stratum.gateResolve(flowId, stepId, outcome, rationale, 'human');
    }
  } else {
    // Server not running — readline fallback (current behavior)
    const gateId = await visionWriter.createGate(flowId, stepId, itemId, extras);
    const { outcome, rationale } = await promptGate(response, {
      ...(opts.gateOpts ?? {}),
      artifact: context.cwd,
      askAgent,
    });
    await visionWriter.resolveGate(gateId, outcome);
    response = await stratum.gateResolve(flowId, stepId, outcome, rationale, 'human');
  }
  progress.resume();
}
```

**Change 4: Same pattern in `executeChildFlow()` (lines 397-426).**

Replace the child-flow gate block with the same probe/branch/poll pattern:

```js
} else if (resp.status === 'await_gate') {
  if (progress) progress.pause();
  console.log(`  [${childFlowName}] Gate: ${resp.step_id}`);

  const item = visionWriter.findFeatureItem
    ? await visionWriter.findFeatureItem(context.featureCode)
    : null;
  const extras = {
    fromPhase: item?.lifecycle?.currentPhase || null,
    toPhase: resp.on_approve || null,
    summary: resp.summary || null,
  };

  const serverUp = await probeServer();
  if (serverUp) {
    const gateId = await visionWriter.createGate(childFlowId, resp.step_id, itemId, extras);
    console.log(`  [${childFlowName}] Gate delegated to web UI.`);
    const resolved = await pollGateResolution(visionWriter, gateId);

    if (resolved) {
      const stratumOutcome = GATE_OUTCOME_TO_STRATUM[resolved.outcome] || resolved.outcome;
      resp = await stratum.gateResolve(childFlowId, resp.step_id, stratumOutcome, resolved.comment || '', 'human');
    } else {
      console.log(`  [${childFlowName}] Gate poll timed out. Falling back to terminal.`);
      const { outcome, rationale } = await promptGate(resp, {
        ...gateOpts,
        artifact: context.cwd,
        askAgent,
      });
      await visionWriter.resolveGate(gateId, outcome);
      resp = await stratum.gateResolve(childFlowId, resp.step_id, outcome, rationale, 'human');
    }
  } else {
    const gateId = await visionWriter.createGate(childFlowId, resp.step_id, itemId, extras);
    const { outcome, rationale } = await promptGate(resp, {
      ...gateOpts,
      artifact: context.cwd,
      askAgent,
    });
    await visionWriter.resolveGate(gateId, outcome);
    resp = await stratum.gateResolve(childFlowId, resp.step_id, outcome, rationale, 'human');
  }
  if (progress) progress.resume();
}
```

**Change 5: Import `probeServer`.**

At top of `build.js`, add:

```js
import { probeServer } from './server-probe.js';
```

**Change 6: Extract `askAgent` to shared scope.**

Currently, `askAgent` is defined inline in both the main loop (lines 223-238) and `executeChildFlow()` (lines 402-417). Both are identical. Extract to a factory function at module scope:

```js
function makeAskAgent(context) {
  return async (question, artifactPath) => {
    const connector = getConnector('claude', { cwd: context.cwd });
    const fileRef = artifactPath && !artifactPath.endsWith('/')
      ? `Read the file "${artifactPath}" and answer`
      : `Look at the project files in the working directory and answer`;
    const qaPrompt =
      `${fileRef} this question concisely:\n\n${question}\n\nKeep your answer brief — 2-3 sentences max.`;
    const parts = [];
    for await (const event of connector.run(qaPrompt, {})) {
      if (event.type === 'assistant' && event.content) parts.push(event.content);
      if (event.type === 'result' && event.content && parts.length === 0) parts.push(event.content);
    }
    return parts.join('') || '(no answer)';
  };
}
```

This avoids duplicating askAgent in the new branching code. Both gate paths (main + child flow) use it for the readline fallback.

### `src/components/vision/GateView.jsx` (existing)

**Change 1: Summary display in PendingGateRow.**

After the `ArtifactAssessment` component (line 93), add summary display:

```jsx
{gate.summary && (
  <p className="text-[10px] text-muted-foreground mt-0.5">
    {gate.summary}
  </p>
)}
```

**Change 2: Artifact link.**

After the summary, add a clickable artifact link when `gate.artifact` is a project-relative path:

```jsx
{gate.artifact && (
  <button
    className="text-[10px] text-accent hover:underline font-mono mt-0.5 block"
    onClick={async () => {
      try {
        await fetch('/api/canvas/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: gate.artifact }),
        });
      } catch { /* ignore */ }
    }}
  >
    {gate.artifact}
  </button>
)}
```

**Change 3: Build-gate prominence.**

In `PendingGateRow`, apply visual distinction when `gate.flowId` is present (indicates a gate from an active build):

- Outer div: add amber left border `border-l-amber-400/50` when `gate.flowId` is truthy
- Action buttons: use `h-8 text-xs` (larger) instead of `h-6 text-[10px]` when `gate.flowId` is truthy

Replace line 79:
```jsx
<div className={cn(
  "px-3 py-2 border-l-2 hover:bg-muted/50 transition-colors",
  gate.flowId ? "border-l-amber-400/50" : "border-l-transparent"
)}>
```

Replace button sizes (lines 102-142): conditionally use `h-8 text-xs` or `h-6 text-[10px]` based on `gate.flowId`:

```jsx
const btnSize = gate.flowId ? 'h-8 text-xs' : 'h-6 text-[10px]';
```

Apply `btnSize` to all three button className expressions.

**Change 4: Feature grouping.**

In the main `GateView` component, group pending gates by `itemId`:

```jsx
const groupedPending = useMemo(() => {
  const groups = new Map();
  for (const gate of pending) {
    const key = gate.itemId || '__ungrouped__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(gate);
  }
  return groups;
}, [pending]);
```

Render with feature headers when a group has more than one gate or when multiple groups exist:

```jsx
{groupedPending.size > 1 ? (
  Array.from(groupedPending.entries()).map(([itemId, gates]) => {
    const item = itemMap.get(itemId);
    return (
      <div key={itemId}>
        <div className="px-3 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30">
          {item?.title ?? 'Unknown Feature'}
        </div>
        {gates.map(gate => (
          <PendingGateRow key={gate.id} gate={gate} item={item} ... />
        ))}
      </div>
    );
  })
) : (
  pending.map(gate => <PendingGateRow key={gate.id} ... />)
)}
```

**Change 5: Gate history (all resolved, collapsed).**

Update the GateView fetch call to use `?status=all` so that resolved gates are included:

```js
const response = await fetch('/api/vision/gates?status=all');
```

Replace the "Resolved Today" section with a collapsible "Resolved" section that shows all resolved gates. Use `resolved.length` (not the old `resolvedToday.length`) for the summary bar count:

```jsx
const { pending, resolved } = useMemo(() => {
  const p = [];
  const r = [];
  for (const gate of gates) {
    if (gate.status === 'pending') {
      p.push(gate);
    } else {
      r.push(gate);
    }
  }
  p.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  r.sort((a, b) => new Date(b.resolvedAt ?? b.createdAt) - new Date(a.resolvedAt ?? a.createdAt));
  return { pending: p, resolved: r };
}, [gates]);
```

Add a collapsed-by-default section with count badge:

```jsx
const [historyOpen, setHistoryOpen] = useState(false);

{resolved.length > 0 && (
  <div>
    <button
      onClick={() => setHistoryOpen(!historyOpen)}
      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/50 transition-colors"
    >
      <div className="w-2 h-2 rounded-full shrink-0" style={{ background: '#22c55e' }} />
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Resolved
      </span>
      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
        {resolved.length}
      </span>
      <span className="text-[10px] text-muted-foreground ml-auto">
        {historyOpen ? '−' : '+'}
      </span>
    </button>
    {historyOpen && resolved.map(gate => (
      <ResolvedGateRow key={gate.id} gate={gate} item={itemMap.get(gate.itemId)} />
    ))}
  </div>
)}
```

## Build Sequence

### Phase 1: Server Endpoint (tasks 1-3)

- [ ] **1. Verify STRAT-COMP-4 prerequisites.** Confirm `lib/server-probe.js` exists, `VisionWriter` has async dual dispatch, `VisionStore.getGateByFlowStep()` exists, gate status uses `'resolved'`. If any are missing, complete them first.
- [ ] **2. Add `POST /api/vision/gates` endpoint to `vision-routes.js`.** Insert after line 309. Accept `{ flowId, stepId, itemId, fromPhase, toPhase, artifact, artifactAssessment, summary }`. `itemId` is optional (child flows may not have a direct item mapping). Idempotent on `flowId:stepId` via `store.getGateByFlowStep()`. Broadcast `gateCreated` via WebSocket (note: STRAT-COMP-8 must listen for `gateCreated`, not `gatePending`). Return 201 with full gate object. `_restCreateGate()` extracts `.id` from the response.
- [ ] **2a. Add `?status=all` query param to `GET /api/vision/gates`.** When `req.query.status === 'all'`, call `store.getAllGates()` to return all gates. Default behavior (no param) remains pending-only via `store.getPendingGates()` for backwards compatibility.
- [ ] **2b. Add `getAllGates()` method to `VisionStore`.** Returns all gates (pending + resolved) as an array. GateView Change 5 fetches with `?status=all` to populate the history section.
- [ ] **3. Test gate creation endpoint.** Start server, POST gate, verify it appears in `GET /api/vision/gates`. POST same `flowId:stepId` again, verify 200 with existing gate (idempotent). POST without `flowId`, verify 400.

### Phase 2: VisionWriter Extension (tasks 4-5)

- [ ] **4. Extend `VisionWriter.createGate()` signature.** Add optional `extras` parameter. In direct-write path, include `fromPhase`, `toPhase`, `artifact`, `artifactAssessment`, `summary` in the gate object. In REST path, include all fields in POST body.
- [ ] **5. Add `VisionWriter.getGate(gateId)` if not present.** REST path: `GET /api/vision/gates/:gateId`. Direct path: load state, find gate by ID in `state.gates`. Return gate object or null.

### Phase 3: Build.js Delegation (tasks 6-10)

- [ ] **6. Add `probeServer` import and outcome mapping constant.** Import `probeServer` from `./server-probe.js`. Add `GATE_OUTCOME_TO_STRATUM` mapping. Add `GATE_POLL_INTERVAL` and `GATE_POLL_TIMEOUT` constants.
- [ ] **7. Add `pollGateResolution()` helper.** Polls `visionWriter.getGate(gateId)` every 2s. Returns resolved gate or null on timeout (30 min). Note: `getGate()` uses `encodeURIComponent(gateId)` in the REST URL since gate IDs contain colons.
- [ ] **8. Extract `makeAskAgent()` factory.** Move the duplicated `askAgent` closure from lines 223-238 and 402-417 into a shared factory function at module scope. Both gate paths use it.
- [ ] **9. Replace main-loop `await_gate` block (lines 217-247).** Probe server. If up: create gate via REST with extras, poll for resolution, map outcome, call `stratum.gateResolve()`. If poll times out: fall back to readline. If server down: current readline behavior with extras.
- [ ] **10. Replace child-flow `await_gate` block (lines 397-426).** Same pattern as task 9 for `executeChildFlow()`.

### Phase 4: GateView Enhancements (tasks 11-16)

- [ ] **11. Add summary display to PendingGateRow.** Show `gate.summary` text below the phase transition line, above artifact assessment. Conditional render — skip when null.
- [ ] **12. Add artifact link to PendingGateRow.** Clickable `gate.artifact` path that calls `POST /api/canvas/open` to display the artifact. Font mono, accent color.
- [ ] **13. Add build-gate prominence.** When `gate.flowId` is truthy: amber left border on the row, larger action buttons (`h-8 text-xs` instead of `h-6 text-[10px]`).
- [ ] **14. Add feature grouping.** Group pending gates by `itemId` via `useMemo`. Show feature header when multiple groups exist. Header shows item title.
- [ ] **15. Convert resolved section to collapsible history.** Replace `resolvedToday` filter with all-resolved `resolved` array. Summary bar uses `resolved.length` (not `resolvedToday.length`). Default collapsed. Toggle button with count badge.
- [ ] **16. Smoke test GateView.** Open web UI. Verify pending gates render with summary, artifact link, and prominence. Verify history collapses/expands. Verify feature grouping when multiple gates exist for same item.

### Phase 5: Integration (tasks 17-18)

- [ ] **17. End-to-end test: gate delegation round-trip.** Start server. Run build to gate. Verify gate appears in web UI with summary and phase transition. Resolve via web UI. Verify CLI picks up resolution, maps outcome, calls `stratum.gateResolve()`, and build continues.
- [ ] **18. End-to-end test: server-down fallback.** Stop server. Run build to gate. Verify probe fails within 500ms. Verify readline prompt appears. Resolve via terminal. Verify build continues.

## Integration Notes

- **Gate creation event name:** STRAT-COMP-6 broadcasts `gateCreated` on gate creation. STRAT-COMP-8 (active build dashboard) must listen for `gateCreated`, not `gatePending`.
- **Gate ID format:** Deterministic composite key `flowId:stepId`, consistent with existing `VisionWriter.createGate()`. Not UUID.
- **Endpoint ownership:** STRAT-COMP-4 provides the initial scaffold for `POST /api/vision/gates`; STRAT-COMP-6 is the canonical definition. `itemId` is optional per STRAT-COMP-6's rule (child flows may not have a direct item mapping).
- **Outcome normalization:** `VisionWriter.resolveGate()` normalizes imperative outcomes (`approve`, `revise`, `kill`) to past-tense (`approved`, `revised`, `killed`) before storing. Consumers of Vision Store data always see past-tense.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| STRAT-COMP-4 incomplete when STRAT-COMP-6 starts | Medium | High | Task 1 gates the entire build sequence. If prerequisites are missing, complete them first or abort. |
| Gate enrichment data unavailable in Stratum dispatch | Medium | Medium | `extras` fields are all optional. Gate works without enrichment — UI shows "Unknown -> Unknown" but is functional. Summary fallback constructed from feature code. |
| Poll loop blocks CLI process during gate wait | Low | Low | Poll uses `setTimeout` (non-blocking). CLI can still receive SIGINT to abort. 30-min timeout prevents infinite hang. |
| Idempotency check misses gates from crashed builds with different flow IDs | Low | Medium | Gate ID is `flowId:stepId`. A restart generates a new `flowId`, so the dedup won't fire. Old pending gates remain orphaned. Out of scope — tracked for STRAT-COMP-8 (abandoned gate cleanup). |
| GateView becomes sluggish with large gate history | Low | Low | History section is collapsed by default. Only renders resolved gates when user expands. Gate count per feature is typically <20. |
| Race condition: CLI creates gate via REST, server restarts, gate lost from memory | Low | High | VisionStore persists to disk via `_save()` after `createGate()`. On restart, gates reload from `vision-state.json`. After STRAT-COMP-4 atomic save, this is safe. |
| askAgent extraction changes readline fallback behavior | Low | Medium | The extracted `makeAskAgent()` produces an identical closure. Both call sites currently have the same code (lines 223-238 and 402-417 are identical). No behavioral change. |

## Behavioral Test Checkpoints

### Checkpoint 1: Gate creation via POST

- POST `{ flowId: "f1", stepId: "s1", itemId: "i1", summary: "Test gate" }` to `/api/vision/gates`
- Response: 201 with gate object containing all fields
- GET `/api/vision/gates` returns the new gate in `pending` list
- POST same `flowId:stepId` again: 200 with existing gate (not 201, not duplicate)
- POST without `flowId`: 400

### Checkpoint 2: Gate delegation round-trip (server running)

- Server running on port 3001
- Build reaches `await_gate` in main loop
- `probeServer()` returns true
- CLI calls `visionWriter.createGate()` which POSTs to server
- Gate appears in web UI GateView within 2s
- User clicks Approve in GateView
- `POST /api/vision/gates/:id/resolve { outcome: 'approved' }` fires
- CLI poll detects `status: 'resolved'`, `outcome: 'approved'`
- CLI calls `stratum.gateResolve(flowId, stepId, 'approve', '', 'human')`
- Build continues past gate

### Checkpoint 3: Gate delegation with revise outcome

- Same setup as Checkpoint 2
- User clicks Revise, enters feedback "needs more detail"
- `POST /api/vision/gates/:id/resolve { outcome: 'revised', comment: 'needs more detail' }`
- CLI poll detects `outcome: 'revised'`
- CLI maps to `stratum.gateResolve(flowId, stepId, 'revise', 'needs more detail', 'human')`
- Build re-enters the phase

### Checkpoint 4: Server-down fallback

- No server running
- Build reaches `await_gate`
- `probeServer()` returns false within 500ms
- `visionWriter.createGate()` writes gate to `vision-state.json` directly
- `promptGate()` opens readline
- User types `a` (approve)
- `visionWriter.resolveGate()` writes resolution to file
- `stratum.gateResolve()` called
- Build continues

### Checkpoint 5: Poll timeout fallback

- Server running at gate creation
- Gate created via POST
- Server crashes (or gate never resolved)
- CLI polls for 30 minutes (test with reduced timeout)
- Poll returns null
- CLI falls back to readline prompt
- Gate resolved via terminal
- Build continues

### Checkpoint 6: Child flow gate delegation

- Build enters `executeChildFlow()`
- Child flow hits `await_gate`
- Server running: gate delegated via REST with child flow ID
- Gate appears in web UI
- Resolution round-trip works identically to main flow

### Checkpoint 7: GateView enhancements

- Gate created with `summary: "Design phase complete"`, `artifact: "docs/features/FEAT-1/design.md"`, `flowId: "feature:FEAT-1:build"`
- PendingGateRow shows summary text between phase transition and artifact assessment
- Artifact path is clickable — clicking calls `POST /api/canvas/open`
- Row has amber left border (build-gate prominence)
- Action buttons are `h-8 text-xs` (larger than non-build gates)
- After resolution, gate moves to collapsed "Resolved" section
- Expanding "Resolved" shows the gate with outcome badge
