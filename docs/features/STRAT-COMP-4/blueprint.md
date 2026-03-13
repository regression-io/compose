# STRAT-COMP-4: Vision Store Unification — Blueprint

**Status:** PLANNED
**Created:** 2026-03-12
**Phase:** blueprint

## Related Documents

- [STRAT-COMP-4 design](./design.md) — parent design doc
- [ROADMAP.md](../../../ROADMAP.md) — Milestone 4: Unified Interface

## Corrections Table

The design doc makes several assumptions that diverge from reality. Every correction is verified against source.

| # | Design Assumption | Actual Code | Impact |
|---|---|---|---|
| C1 | "Transitional hack in `vision-writer.js:33-39`" | Dual-lookup is in `findFeatureItem()` at lines 72-76, not 33-39. The check is `item.featureCode === 'feature:${featureCode}' \|\| item.lifecycle?.featureCode === featureCode`. | Line references in design are wrong; logic is correct. |
| C2 | Design says VisionStore `getItemByFeatureCode()` searches only `lifecycle?.featureCode` | Confirmed: `vision-store.js:258-263` only checks `item.lifecycle?.featureCode`. Does NOT search `feature:CODE` convention. | Asymmetric lookup. Items created by CLI (`featureCode: "feature:FEAT-1"`) are invisible to server's `getItemByFeatureCode()`. Unification must pick one format. |
| C3 | Design says `POST /api/vision/gates` creation endpoint needed | Confirmed missing: `vision-routes.js` has only `GET /api/vision/gates` (line 301) and `POST /api/vision/gates/:id/resolve` (line 321). No creation endpoint. | Must add `POST /api/vision/gates` for CLI delegation. |
| C4 | Design says "`POST /api/vision/gates/:id/resolve` → in-memory VisionStore → Stratum" | Resolve route (lines 321-355) does NOT call `stratum.gateResolve()`. It resolves the gate in VisionStore and advances lifecycle directly, but never notifies Stratum. | Gate resolution via web UI will leave Stratum flow stuck at `await_gate`. Must add Stratum bridge or polling CLI must call `stratum.gateResolve()` itself after detecting resolution. |
| C5 | Design says VisionStore `_save()` is "NOT atomic, race-prone" | Confirmed: `vision-store.js:66` uses `fs.writeFileSync` directly — no temp file, no rename. | Must make atomic (temp+rename) to match VisionWriter pattern. |
| C6 | Design says `updateItem()` allowlist does not include `lifecycle` | Confirmed: `vision-store.js:130` allowlist is `['type', 'title', 'description', 'confidence', 'status', 'phase', 'position', 'parentId', 'summary', 'files', 'featureCode', 'stratumFlowId', 'evidence']`. `lifecycle` is absent. | Cannot set lifecycle via `PATCH /api/vision/items/:id`. Must use dedicated lifecycle endpoint or extend allowlist. |
| C7 | Design says VisionWriter `resolveGate()` sets `status: 'resolved'` while VisionStore sets `status = outcome` | Confirmed: VisionWriter line 181 sets `gate.status = 'resolved'` + `gate.outcome = outcome`. VisionStore line 227 sets `gate.status = outcome` + `gate.outcome = outcome`. | Status semantics diverge. Polling CLI checks `gate.status !== 'pending'` — both work for detection, but a gate resolved via web UI will have `status: 'approved'` while CLI-resolved gates have `status: 'resolved'`. Must unify. |
| C8 | Design says liveness check should be "at each gate, not cached at build start" | Acceptance criteria STRAT-COMP-6 originally contradicted: "CLI probes `GET /api/health` at build start, caches result". | Resolved — design.md acceptance criteria updated to match AD-3. No action required. |
| C9 | Design says `writeActiveBuild()` writes limited fields | Confirmed: `build.js:490-496` writes `{ featureCode, flowId, startedAt, currentStepId, specPath }`. No step count, retry count, or violations. | STRAT-COMP-5 (build visibility) needs richer data. Out of scope for STRAT-COMP-4 but noted. |
| C10 | Design says file-watcher has "hardcoded .md filter" | Confirmed: `file-watcher.js:146` — `if (!filename \|\| !filename.endsWith('.md')) return`. | Extending watcher to `active-build.json` requires removing or parameterizing the `.md` filter. Out of scope for STRAT-COMP-4 (belongs to STRAT-COMP-5). |
| C11 | Design proposes `PATCH /api/vision/items/:itemId` with `{ lifecycle: {...} }` as bootstrap option | `updateItem()` will silently drop `lifecycle` since it's not in the allowlist. The `POST /api/vision/items/:id/lifecycle/start` endpoint exists and does exactly what's needed. | Use existing lifecycle/start endpoint, not PATCH hack. Two-step bootstrap: `POST /api/vision/items` then `POST /api/vision/items/:id/lifecycle/start`. |

## Architecture Decisions

### AD-1: featureCode canonical format

**Decision:** Standardize on `lifecycle.featureCode` (plain code, e.g. `"STRAT-COMP-4"`). Remove `feature:` prefix convention.

**Rationale:** The server already uses `lifecycle.featureCode` everywhere (routes, artifact manager, getItemByFeatureCode). VisionWriter is the only consumer of the `feature:CODE` format. Cheaper to fix one file than all server code.

**Changes:**
- `VisionWriter.ensureFeatureItem()` stops writing `featureCode: "feature:..."` on the item. Instead, creates item and sets `lifecycle.featureCode` directly.
- `VisionWriter.findFeatureItem()` drops the `feature:` branch — searches only `lifecycle?.featureCode`.
- Migration: on load, if an item has `featureCode` matching `feature:*` but no `lifecycle.featureCode`, migrate it: set `lifecycle.featureCode` to the bare code, then **delete** the old `featureCode: 'feature:*'` field from the item.

### AD-2: Gate status semantics

**Decision:** Resolved gates use `status: 'resolved'` with `outcome` as the detail field. Both VisionWriter and VisionStore adopt this.

**Rationale:** `status` should be a state-machine state (`pending` -> `resolved`), not a copy of the outcome. The outcome (`approved`, `rejected`, `killed`) is a separate concern. VisionWriter already does this correctly.

**Changes:**
- `VisionStore.resolveGate()` (line 227): change `gate.status = outcome` to `gate.status = 'resolved'`.
- `vision-routes.js` gate resolve handler (line 331): check `gate.status !== 'pending'` remains correct; lifecycle advance logic uses `outcome`, not `status`.

### AD-3: Server probe strategy

**Decision:** Probe at every gate, not cached. Timeout 500ms. No retry — server is either up or it isn't.

**Rationale:** The server can start or stop mid-build. Caching at build start (per acceptance criteria) is wrong. Per-gate probe adds ~500ms worst case when server is down, which is negligible compared to agent execution time.

**Implementation:** New module `lib/server-probe.js` exports `probeServer(port, timeoutMs)`. VisionWriter accepts an optional `{ port }` config. When methods are called, VisionWriter checks liveness and delegates to REST or writes directly.

### AD-4: Stratum gate notification gap

**Decision:** The polling CLI (not the server) calls `stratum.gateResolve()` after detecting resolution via `GET /api/vision/gates/:id`.

**Rationale:** The server has no access to the Stratum MCP client (it runs in the CLI process). Adding Stratum awareness to the server would create a dependency cycle. The CLI already has the Stratum client instance — it should be the one to notify Stratum.

**Flow:** CLI creates gate via REST -> polls `GET /api/vision/gates/:id` -> detects `status: 'resolved'` -> calls `stratum.gateResolve(flowId, stepId, gate.outcome, gate.comment, 'human')` -> continues build.

### AD-5: VisionWriter REST mode — method-level, not constructor-level

**Decision:** Each mutating method in VisionWriter checks server liveness independently. No "mode" flag on the instance.

**Rationale:** Server can appear/disappear between calls. A constructor-time mode decision would go stale. The 500ms probe cost is acceptable per-operation.

**Pattern:**
```
async methodName(args) {
  if (await this._serverAvailable()) {
    return this._restMethodName(args);
  }
  return this._directMethodName(args);  // current file-based logic
}
```

All public methods become async. Callers in `build.js` already use async/await.

## Component Designs

### `lib/server-probe.js` (new)

```js
/**
 * @param {number} port - Server port (default from COMPOSE_PORT env or 3001)
 * @param {number} timeoutMs - Timeout in ms (default 500)
 * @returns {Promise<boolean>} true if server is reachable
 */
export async function probeServer(port = Number(process.env.COMPOSE_PORT) || 3001, timeoutMs = 500)
```

Implementation: `fetch(`http://localhost:${port}/api/health`)` with `AbortController` timeout. Returns `true` on 2xx, `false` on any error/timeout. No retry. No logging on failure (expected when server is down).

Note: The `/api/health` endpoint must exist on the server. Verify it does; if not, add a trivial one.

### `lib/vision-writer.js` (existing)

**Changes:**

1. **Constructor:** Accept optional `{ port }` config for server probe target.

2. **New private methods:**
   - `async _serverAvailable()` — calls `probeServer(this._port)`, returns boolean.
   - `async _restCreateItem(featureCode, title)` — `POST /api/vision/items` + `POST /api/vision/items/:id/lifecycle/start`.
   - `async _restFindItem(featureCode)` — `GET /api/vision/items` then filter client-side (no server endpoint for featureCode lookup).
   - `async _restUpdateStatus(itemId, status)` — `PATCH /api/vision/items/:id { status }`.
   - `async _restUpdatePhase(itemId, stepId)` — uses lifecycle advance endpoint or direct PATCH.
   - `async _restCreateGate(flowId, stepId, itemId)` — `POST /api/vision/gates`.
   - `async _restGetGate(gateId)` — `GET /api/vision/gates/:id` (for polling).

3. **Public methods become async with dual dispatch:**
   - `findFeatureItem(featureCode)` -> `async findFeatureItem(featureCode)`: probe, REST or file.
   - `ensureFeatureItem(featureCode, title)` -> `async ensureFeatureItem(featureCode, title)`: probe, REST or file.
   - `updateItemStatus(itemId, status)` -> `async updateItemStatus(itemId, status)`.
   - `updateItemPhase(itemId, stepId)` -> `async updateItemPhase(itemId, stepId)`.
   - `createGate(flowId, stepId, itemId)` -> `async createGate(flowId, stepId, itemId)`.
   - `resolveGate(gateId, outcome)` -> `async resolveGate(gateId, outcome)`.

4. **featureCode unification (AD-1):**
   - `findFeatureItem()`: remove `item.featureCode === 'feature:${featureCode}'` branch. Search only `item.lifecycle?.featureCode === featureCode`.
   - `ensureFeatureItem()`: stop setting `featureCode: "feature:${featureCode}"` on item. After creating item, set `item.lifecycle = { featureCode, currentPhase: 'explore_design' }` and write.
   - Add `_migrateItem(item)`: if `item.featureCode?.startsWith('feature:')` and no `item.lifecycle?.featureCode`, migrate. Called during `_load()`.

5. **Direct-write methods renamed** with `_direct` prefix to coexist with REST versions. Original file-based logic preserved exactly.

### `server/vision-store.js` (existing)

**Changes:**

1. **Atomic save (C5):**
   ```js
   _save() {
     try {
       fs.mkdirSync(this._dataDir, { recursive: true });
       const data = JSON.stringify(this.getState(), null, 2) + '\n';
       const tmp = path.join(this._dataDir, `vision-state.json.tmp.${Date.now()}`);
       fs.writeFileSync(tmp, data, 'utf-8');
       fs.renameSync(tmp, this._dataFile);
     } catch (err) {
       console.error('[vision] Failed to save state:', err.message);
     }
   }
   ```
   Lines affected: 62-70.

2. **Gate status fix (AD-2, C7):**
   Line 227: change `gate.status = outcome` to `gate.status = 'resolved'`.

3. **Add `getGateByFlowStep(flowId, stepId)` method:**
   ```js
   getGateByFlowStep(flowId, stepId) {
     const id = `${flowId}:${stepId}`;
     return this.gates.get(id) || null;
   }
   ```
   Used by the new gate creation endpoint to check for duplicates.

### `server/vision-routes.js` (existing)

**Changes:**

1. **Add `POST /api/vision/gates` creation endpoint (C3):**
   Insert after line 309 (after the GET /api/vision/gates handler):
   ```js
   app.post('/api/vision/gates', (req, res) => {
     try {
       const { flowId, stepId, itemId, artifact, options, fromPhase, toPhase } = req.body;
       if (!flowId || !stepId) {
         return res.status(400).json({ error: 'flowId and stepId are required' });
       }
       const id = `${flowId}:${stepId}`;
       const existing = store.getGateByFlowStep(flowId, stepId);
       if (existing) {
         return res.status(200).json(existing); // idempotent
       }
       const gate = {
         id,
         flowId,
         stepId,
         itemId,
         artifact: artifact || null,
         options: options || null,
         fromPhase: fromPhase || null,
         toPhase: toPhase || null,
         status: 'pending',
         createdAt: new Date().toISOString(),
       };
       store.createGate(gate);
       scheduleBroadcast();
       broadcastMessage({ type: 'gateCreated', gateId: id, itemId, timestamp: gate.createdAt });
       res.status(201).json(gate);
     } catch (err) {
       res.status(400).json({ error: err.message });
     }
   });
   ```
   **Note:** This is the initial scaffold of the gate creation endpoint. STRAT-COMP-6 owns the canonical definition of `POST /api/vision/gates` and will extend this scaffold with full gate lifecycle semantics (phase transitions, artifact validation, etc.). The broadcast event is `gateCreated` (not `gatePending`) to reflect that gate creation and pending status are distinct concerns.

2. **Gate resolve: fix status semantics (AD-2):**
   Line 331 already checks `gate.status !== 'pending'` — no change needed for the guard. The `store.resolveGate()` fix in vision-store.js handles the status value.

3. **Verify `/api/health` endpoint exists.** If not, add:
   ```js
   app.get('/api/health', (_req, res) => res.json({ ok: true }));
   ```
   This may live in the main server file rather than vision-routes. Check `server/index.js`.

### `lib/build.js` (existing)

**Changes:**

1. **VisionWriter construction:** Pass port config.
   Line 138: `const visionWriter = new VisionWriter(dataDir, { port: Number(process.env.COMPOSE_PORT) || 3001 });`

2. **All VisionWriter calls become awaited:**
   - Line 139: `const itemId = await visionWriter.ensureFeatureItem(featureCode, featureCode);`
   - Line 186: `await visionWriter.updateItemStatus(itemId, 'in_progress');`
   - Line 201: `await visionWriter.updateItemPhase(itemId, stepId);`
   - Line 221: `const gateId = await visionWriter.createGate(flowId, stepId, itemId);`
   - Line 245: `await visionWriter.resolveGate(gateId, outcome);`
   - And all equivalent calls in `executeChildFlow()` and `abortBuild()`.

3. **Gate delegation branch (server-up path):**
   When `response.status === 'await_gate'` (line 217), add server liveness check:
   ```js
   } else if (response.status === 'await_gate') {
     progress.pause();
     console.log(`\nGate: ${stepId}`);

     const serverUp = await probeServer();
     if (serverUp) {
       // Delegate gate to server — create via REST, poll for resolution
       const gateId = await visionWriter.createGate(flowId, stepId, itemId);
       console.log('Gate delegated to web UI. Waiting for resolution...');
       const resolved = await pollGateResolution(visionWriter, gateId);
       // CLI calls stratum.gateResolve — server doesn't have Stratum (AD-4)
       if (resolved) {
         response = await stratum.gateResolve(flowId, stepId, resolved.outcome, resolved.comment, 'human');
       } else {
         // timeout — fall back to readline prompt
         const { outcome, rationale } = await promptGate(response, { ... });
         await visionWriter.resolveGate(gateId, outcome);
         response = await stratum.gateResolve(flowId, stepId, outcome, rationale, 'human');
       }
     } else {
       // Fallback: readline prompt (current behavior)
       const gateId = await visionWriter.createGate(flowId, stepId, itemId);
       const { outcome, rationale } = await promptGate(response, { ... });
       await visionWriter.resolveGate(gateId, outcome);
       response = await stratum.gateResolve(flowId, stepId, outcome, rationale, 'human');
     }
     progress.resume();
   }
   ```

4. **Add `pollGateResolution()` helper:**
   ```js
   async function pollGateResolution(visionWriter, gateId, intervalMs = 2000, timeoutMs = 30 * 60 * 1000) {
     const deadline = Date.now() + timeoutMs;
     while (Date.now() < deadline) {
       const gate = await visionWriter.getGate(gateId);
       if (gate && gate.status !== 'pending') return gate;
       await new Promise(r => setTimeout(r, intervalMs));
     }
     return null; // timeout — caller falls back to readline prompt
   }
   ```

5. **Same pattern in `executeChildFlow()`** for child-flow gates (lines 397-426).

## Data Flow Diagrams

### Path A: Server Running

```
compose build FEAT-1
  │
  ├─ VisionWriter constructed with port config
  │
  ├─ ensureFeatureItem("FEAT-1")
  │    ├─ probeServer() → true
  │    ├─ POST /api/vision/items { type: "feature", title: "FEAT-1" }
  │    ├─ POST /api/vision/items/:id/lifecycle/start { featureCode: "FEAT-1" }
  │    └─ return itemId
  │
  ├─ updateItemStatus(itemId, "in_progress")
  │    ├─ probeServer() → true
  │    └─ PATCH /api/vision/items/:id { status: "in_progress" }
  │
  ├─ [step loop: execute_step → agent → stepDone]
  │    ├─ updateItemPhase(itemId, stepId) → PATCH via REST
  │    └─ updateActiveBuildStep() → file write (always local)
  │
  ├─ [await_gate]
  │    ├─ probeServer() → true
  │    ├─ POST /api/vision/gates { flowId, stepId, itemId, ... }
  │    │    └─ server broadcasts gateCreated via WebSocket
  │    │    └─ Gate View shows pending gate to user
  │    ├─ poll GET /api/vision/gates/:id every 2s
  │    │    └─ user resolves in web UI → POST /gates/:id/resolve
  │    │    └─ server sets status: 'resolved', outcome, broadcasts gateResolved
  │    ├─ poll detects status !== 'pending'
  │    ├─ CLI calls stratum.gateResolve(flowId, stepId, outcome, comment, 'human')
  │    └─ build continues
  │
  └─ [complete] → updateItemStatus(itemId, "complete") via REST
```

### Path B: Server Not Running

```
compose build FEAT-1
  │
  ├─ VisionWriter constructed with port config
  │
  ├─ ensureFeatureItem("FEAT-1")
  │    ├─ probeServer() → false (500ms timeout)
  │    ├─ _load() vision-state.json from disk
  │    ├─ find or create item with lifecycle.featureCode = "FEAT-1"
  │    ├─ _atomicWrite() → temp file + rename
  │    └─ return itemId
  │
  ├─ [step loop: same as today, all writes via _atomicWrite()]
  │
  ├─ [await_gate]
  │    ├─ probeServer() → false
  │    ├─ createGate() → write to vision-state.json
  │    ├─ promptGate() → readline prompt in terminal
  │    ├─ resolveGate() → write to vision-state.json
  │    ├─ stratum.gateResolve() → notify Stratum
  │    └─ build continues
  │
  └─ [complete] → updateItemStatus via file write
```

## Build Sequence

### Phase 1: Foundation (tasks 1-5)

- [ ] **1. Verify `/api/health` endpoint exists.** Check `server/index.js` for health route. Add if missing: `app.get('/api/health', (_, res) => res.json({ ok: true }))`. No behavior change.
- [ ] **2. Create `lib/server-probe.js`.** Single export `probeServer(port, timeoutMs)`. Write tests: probe against a real HTTP server (start one in test), probe against closed port (should return false within timeout).
- [ ] **3. Make `VisionStore._save()` atomic.** Replace `fs.writeFileSync` with temp-file-then-rename pattern. Test: concurrent read during save should never see partial JSON.
- [ ] **4. Fix gate status semantics in `VisionStore.resolveGate()`.** Change `gate.status = outcome` to `gate.status = 'resolved'`. Verify `vision-routes.js` resolve handler still works (it checks `gate.status !== 'pending'`, which remains correct).
- [ ] **5. Add `VisionStore.getGateByFlowStep(flowId, stepId)`.** Used by creation endpoint for idempotency check.

### Phase 2: featureCode Unification (tasks 6-8)

- [ ] **6. Unify `VisionWriter.ensureFeatureItem()`.** Stop writing `featureCode: "feature:..."`. Write `lifecycle: { featureCode, currentPhase: 'explore_design' }` on new items. Update `findFeatureItem()` to search only `lifecycle?.featureCode`.
- [ ] **7. Add migration logic to `VisionWriter._load()`.** If any item has `featureCode` matching `feature:*` without `lifecycle.featureCode`, migrate: set `lifecycle.featureCode` to the bare code, delete the `feature:*` field.
- [ ] **8. Test featureCode unification end-to-end.** Create item via old format, verify `findFeatureItem()` finds it after migration. Create item via new format, verify server's `getItemByFeatureCode()` finds it.

### Phase 3: REST Mode (tasks 9-14)

- [ ] **9. Add constructor config to VisionWriter.** Accept `{ port }` option. Store `this._port`.
- [ ] **10. Add `_serverAvailable()` private method.** Calls `probeServer(this._port)`.
- [ ] **11. Implement REST variants of each public method.** `_restEnsureFeatureItem`, `_restFindFeatureItem`, `_restUpdateStatus`, `_restUpdatePhase`, `_restCreateGate`. Each uses `fetch()` against `localhost:${port}`.
  - **Idempotency requirement for `_restEnsureFeatureItem`:** If the item is found via `_restFindItem` and already has `lifecycle.featureCode`, return `item.id` directly — do not call `lifecycle/start`. The two-step bootstrap (POST /items + POST /lifecycle/start) must only run when the item does not yet exist.
- [ ] **12. Make public methods async with dual dispatch.** Each method: `if (await this._serverAvailable()) return this._restX(...); return this._directX(...)`.
- [ ] **13. Add `getGate(gateId)` method.** REST: `GET /api/vision/gates/:id`. Direct: read from file. Used for gate polling.
- [ ] **14. Update all VisionWriter call sites in `build.js`.** Add `await` to every VisionWriter call. Pass `{ port }` to constructor (line 138). Specific call sites requiring `await` addition:
  - Line 139: `ensureFeatureItem()` (main build)
  - Line 186: `updateItemStatus()` (main build)
  - Line 201: `updateItemPhase()` (step loop)
  - Line 221: `createGate()` (gate handling)
  - Line 245: `resolveGate()` (gate handling)
  - `executeChildFlow()` — all VisionWriter calls within (lines 397-426)
  - `abortBuild()` at lines 564-568: `findFeatureItem()` and `updateItemStatus()` are currently called **without `await`** — these must be awaited:
    ```js
    // BEFORE (broken — fire-and-forget):
    const item = visionWriter.findFeatureItem(featureCode);
    if (item) visionWriter.updateItemStatus(item.id, 'aborted');

    // AFTER (correct):
    const item = await visionWriter.findFeatureItem(featureCode);
    if (item) await visionWriter.updateItemStatus(item.id, 'aborted');
    ```

### Phase 4: Gate Delegation (tasks 15-19)

- [ ] **15. Add `POST /api/vision/gates` endpoint to `vision-routes.js`.** Accept `{ flowId, stepId, itemId, artifact, options, fromPhase, toPhase }`. Idempotent on `flowId:stepId`. Broadcast `gateCreated` via WebSocket. (This is the initial scaffold; STRAT-COMP-6 owns the canonical version.)
- [ ] **16. Add `pollGateResolution()` helper to `build.js`.** Poll `GET /api/vision/gates/:id` every 2s until `status !== 'pending'`. On timeout (30 min), return null and fall back to readline prompt. Return resolved gate object on success.
- [ ] **17. Branch gate handling in `build.js` main loop.** At `await_gate`: probe server. If up: create gate via REST, poll, then call `stratum.gateResolve()` with resolution. If down: readline fallback (current behavior).
- [ ] **18. Branch gate handling in `executeChildFlow()`.** Same pattern as task 17 for child-flow gates (lines 397-426).
- [ ] **19. Integration test: full gate delegation round-trip.** Start server, run build to gate, resolve via `POST /gates/:id/resolve`, verify CLI picks up resolution and continues.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Making VisionWriter methods async breaks callers outside `build.js` | Medium | High | Grep for all `VisionWriter` imports. Verify only `build.js` and tests use it. If other sync callers exist, provide sync wrappers. |
| Server probe adds 500ms latency per operation when server is down | Low | Medium | 500ms is small relative to agent step time (30-120s). If profiling shows impact, batch probe (cache for 5s). |
| featureCode migration corrupts existing vision-state.json | Low | High | Migration sets `lifecycle.featureCode` and removes the old `featureCode: 'feature:*'` field. Backup file before first migrated write. Removal is intentional per AD-1 — downstream features must not depend on the `feature:` prefix. |
| Gate polling loop never terminates (server crashes mid-gate) | Medium | High | Add timeout to `pollGateResolution()` (e.g. 30 min). On timeout, fall back to readline prompt. |
| VisionStore in-memory state diverges from REST-written disk state | Low | High | After REST write, server's in-memory Maps are already updated (REST goes through store methods). File watcher is not needed for this path. |
| Concurrent builds (two terminals) both probe server | Low | Medium | Out of scope. `active-build.json` mutex already prevents concurrent builds for the same feature. Different features are independent. |

## Behavioral Test Checkpoints

These are the golden-flow integration tests that validate the unification works end-to-end.

### Checkpoint 1: featureCode round-trip
- CLI creates feature item via VisionWriter
- Server's `getItemByFeatureCode()` finds it
- Server's artifact endpoints work for that item
- No `feature:` prefix appears anywhere in vision-state.json

### Checkpoint 2: Server-up item creation
- Start server on known port
- VisionWriter detects server via probe
- `ensureFeatureItem()` creates item via REST (POST /items + POST /lifecycle/start)
- Item appears in server's in-memory store immediately
- WebSocket clients receive state broadcast

### Checkpoint 3: Server-down fallback
- No server running
- VisionWriter probe times out in < 600ms
- `ensureFeatureItem()` writes directly to vision-state.json
- File is valid JSON with atomic write (no partial writes)

### Checkpoint 4: Gate delegation round-trip
- Server running
- Build reaches `await_gate`
- CLI creates gate via `POST /api/vision/gates`
- Gate appears in `GET /api/vision/gates` (pending)
- External call to `POST /api/vision/gates/:id/resolve { outcome: "approved" }`
- CLI poll detects resolution
- CLI calls `stratum.gateResolve()` — Stratum flow advances
- Build continues past gate
- **Verification note:** After resolution, the gate no longer appears in `GET /api/vision/gates` (pending-only). Verify resolution via `GET /api/vision/gates/:id`.

### Checkpoint 5: Gate readline fallback
- Server not running
- Build reaches `await_gate`
- Probe fails, CLI falls back to readline
- Gate resolved via terminal input
- `stratum.gateResolve()` called directly
- Build continues

### Checkpoint 6: Gate status unification
- Create gate via VisionWriter (direct write)
- Resolve it → `status: 'resolved'`, `outcome: 'approved'`
- Create gate via VisionStore (server)
- Resolve it → `status: 'resolved'`, `outcome: 'approved'`
- Both produce identical status shape

### Checkpoint 7: Migration
- Load vision-state.json with items using old `featureCode: "feature:FEAT-1"` format
- VisionWriter migrates on load
- Items now have `lifecycle.featureCode: "FEAT-1"`
- `findFeatureItem("FEAT-1")` succeeds
- Old `featureCode` field removed from items
