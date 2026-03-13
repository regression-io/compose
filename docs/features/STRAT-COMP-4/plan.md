# STRAT-COMP-4: Vision Store Unification — Implementation Plan

**Status:** PLANNED
**Created:** 2026-03-13
**Phase:** plan
**Scope:** This plan covers STRAT-COMP-4 (vision store unification) and STRAT-COMP-4a (`compose new` unification) only. STRAT-COMP-5 (build visibility), STRAT-COMP-6 (web gates UX), STRAT-COMP-7 (agent stream), STRAT-COMP-8 (dashboard), and the Milestone 4 integrated proof are planned separately per the build sequence in design.md. Cross-feature doc-sync tasks are included here because the design marks them as blocking prerequisites for those downstream features. For `.compose/build-stream.jsonl`, STRAT-COMP-7 owns the authoritative event schema; this plan only references that downstream contract.

## Related Documents

- [design.md](./design.md) — Parent design for Milestone 4 (STRAT-COMP-4 through STRAT-COMP-8)
- [blueprint.md](./blueprint.md) — Implementation blueprint with file:line references

---

## Task 1: Verify `/api/health` endpoint and port coordination

**Files:** `server/index.js` (existing)
**Depends on:** --
**Acceptance criteria:**
- [ ] `GET /api/health` returns `{ ok: true }` on main server — already exists at `server/index.js:49`
- [ ] Main server port resolution uses `COMPOSE_PORT > PORT > 3001` (update `server/index.js` if it currently uses only `PORT`)
- [ ] **Note:** `server/agent-server.js` uses `AGENT_PORT` (a separate port for SSE streaming) and is NOT part of the API port coordination

---

## Task 1a: Extract shared `resolvePort()` utility

**Files:** `lib/resolve-port.js` (new), `server/index.js` (existing), `vite.config.js` (existing), `lib/server-probe.js` (new, Task 2)
**Depends on:** --
**Acceptance criteria:**
- [ ] New module `lib/resolve-port.js` exports `resolvePort()` — returns `Number(process.env.COMPOSE_PORT) || Number(process.env.PORT) || 3001`
- [ ] `server/index.js` imports and uses `resolvePort()` for its listen port
- [ ] `vite.config.js` proxy target uses `resolvePort()` (or reads the same env vars in the same order) so the Vite dev proxy points to the correct API port
- [ ] `lib/server-probe.js` (Task 2) uses `resolvePort()` as its default port
- [ ] Any other module that derives the main server API port is audited and updated to use `resolvePort()` or the same `COMPOSE_PORT > PORT > 3001` chain

---

## Task 2: Create `lib/server-probe.js`

**Files:** `lib/server-probe.js` (new)
**Depends on:** Tasks 1, 1a
**Acceptance criteria:**
- [ ] Exports `probeServer(port, timeoutMs)` async function
- [ ] Default port: `resolvePort()` from `lib/resolve-port.js`
- [ ] Default timeout 500ms
- [ ] Uses `fetch()` with `AbortController` for timeout
- [ ] Returns `true` on 2xx response from `GET http://localhost:${port}/api/health`
- [ ] Returns `false` on any error, timeout, or non-2xx — no throw, no logging on failure
- [ ] No retry logic

---

## Task 3: Make `VisionStore._save()` atomic

**Files:** `server/vision-store.js` (existing)
**Depends on:** --
**Acceptance criteria:**
- [ ] `_save()` at line 62 writes to a temp file (`vision-state.json.tmp.${Date.now()}`) then renames
- [ ] Uses `fs.renameSync(tmp, this._dataFile)` for atomic POSIX rename
- [ ] Trailing newline in output (`JSON.stringify(...) + '\n'`)
- [ ] Error handling preserved — `console.error` on failure

---

## Task 4: Fix gate status semantics in `VisionStore.resolveGate()`

**Files:** `server/vision-store.js` (existing)
**Depends on:** --
**Acceptance criteria:**
- [ ] `resolveGate()` at line 227: `gate.status = outcome` changed to `gate.status = 'resolved'`
- [ ] `gate.outcome = outcome` preserved (line 228) — outcome is the detail field
- [ ] `vision-routes.js` resolve handler guard (`gate.status !== 'pending'` at line 327) remains correct
- [ ] VisionWriter (`vision-writer.js:181`) and VisionStore now produce identical gate shapes: `{ status: 'resolved', outcome: '<value>' }`

---

## Task 5: Add `VisionStore.getGateByFlowStep()`, `getGateById()`, and `getAllGates()` methods

**Files:** `server/vision-store.js` (existing)
**Depends on:** --
**Acceptance criteria:**
- [ ] New method `getGateByFlowStep(flowId, stepId, round)` on VisionStore
- [ ] Composes gate id as `${flowId}:${stepId}:${round}` and looks up in `this.gates` Map
- [ ] Returns gate object or `null`
- [ ] New method `getGateById(gateId)` — direct lookup in `this.gates` Map by ID string
- [ ] Returns gate object or `null`
- [ ] New method `getAllGates()` — returns all gates (pending + resolved + expired) as an array (needed by STRAT-COMP-6 gate list endpoint)

---

## Task 6: Unify `VisionWriter.ensureFeatureItem()` featureCode format

**Files:** `lib/vision-writer.js` (existing)
**Depends on:** --
**Acceptance criteria:**
- [ ] `ensureFeatureItem()` at line 98: stop writing `featureCode: "feature:${featureCode}"` on new items
- [ ] Instead, set `lifecycle: { featureCode, currentPhase: 'explore_design' }` on new items
- [ ] Item still gets `type: 'feature'`, `title`, `description`, `status: 'planned'`, `phase: 'planning'`, `slug`, `createdAt`
- [ ] No `featureCode` top-level field on new items (only `lifecycle.featureCode`)

---

## Task 7: Unify `VisionWriter.findFeatureItem()` lookup

**Files:** `lib/vision-writer.js` (existing)
**Depends on:** Task 6
**Acceptance criteria:**
- [ ] `findFeatureItem()` at line 72-76: remove `item.featureCode === 'feature:${featureCode}'` branch
- [ ] Search only `item.lifecycle?.featureCode === featureCode`
- [ ] Existing items with old format are found via migration (Task 8)

---

## Task 8: Add migration logic to `VisionWriter._load()` and `VisionStore._load()`

**Files:** `lib/vision-writer.js` (existing), `server/vision-store.js` (existing)
**Depends on:** Tasks 6, 7
**Acceptance criteria:**
- [ ] Both `VisionWriter._load()` and `VisionStore._load()` run the same migration on startup
- [ ] After parsing `vision-state.json`, iterate items
- [ ] For items with `featureCode` matching `feature:*` but no `lifecycle.featureCode`: set `lifecycle.featureCode` to the bare code, delete the `featureCode` field
- [ ] Migration triggers an atomic write if any items were migrated
- [ ] Items already using `lifecycle.featureCode` are untouched
- [ ] After migration, no `feature:` prefix exists anywhere in vision-state.json
- [ ] Also normalize any persisted gates with legacy outcome values (`approved` → `approve`, `killed` → `kill`, `revised` → `revise`)
- [ ] Audit and update `server/feature-scan.js`: if it creates or looks up items using `featureCode: "feature:..."`, change to use `lifecycle.featureCode`. This is a code change, not just a test assertion — `feature-scan.js` seeds items on startup and must use the new format

---

## Task 9: Add constructor config to VisionWriter

**Files:** `lib/vision-writer.js` (existing)
**Depends on:** Task 2
**Acceptance criteria:**
- [ ] Constructor signature: `constructor(dataDir, opts = {})` — second arg is optional object
- [ ] Stores `this._port = opts.port ?? resolvePort()` (imports `resolvePort` from `./resolve-port.js`)
- [ ] Backward-compatible — existing callers passing only `dataDir` still work

---

## Task 10: Add `_serverAvailable()` private method to VisionWriter

**Files:** `lib/vision-writer.js` (existing)
**Depends on:** Tasks 2, 9
**Acceptance criteria:**
- [ ] `async _serverAvailable()` calls `probeServer(this._port)` and returns boolean
- [ ] Imports `probeServer` from `./server-probe.js`

---

## Task 11: Implement REST variants of each public method

**Files:** `lib/vision-writer.js` (existing)
**Depends on:** Task 10
**Acceptance criteria:**
- [ ] `async _restFindFeatureItem(featureCode)` — `GET /api/vision/items`, filter client-side by `item.lifecycle?.featureCode === featureCode`
- [ ] `async _restEnsureFeatureItem(featureCode, title)` — calls `_restFindFeatureItem()` first; if found and has `lifecycle.featureCode`, returns `item.id` (idempotent); otherwise `POST /api/vision/items` then `POST /api/vision/items/:id/lifecycle/start`
- [ ] `async _restUpdateItemStatus(itemId, status)` — `PATCH /api/vision/items/:id { status }`
- [ ] `async _restUpdateItemPhase(itemId, stepId)` — `POST /api/vision/items/:id/lifecycle/advance { targetPhase: stepId }`. If the advance endpoint rejects (e.g., invalid transition), throw — do not fallback to PATCH (`lifecycle` is not in the `updateItem()` allowlist per the design)
- [ ] `async _restCreateGate(flowId, stepId, itemId, opts)` — `POST /api/vision/gates { flowId, stepId, round, itemId, artifact, summary, ... }` (includes optional gate metadata)
- [ ] `async _restGetGate(gateId)` — `GET /api/vision/gates/:id`
- [ ] `async _restResolveGate(gateId, outcome)` — `POST /api/vision/gates/:id/resolve { outcome }`. **Note:** In the gate-delegation flow, the web UI calls the resolve endpoint (not the CLI). However, `resolveGate()` must still have a REST variant for completeness: if the CLI needs to resolve a gate programmatically (e.g., auto-approve in CI), it routes through the server to keep server state consistent. In the normal web-delegation path, the CLI discovers resolution via `getGate()` polling — it does not call `resolveGate()` itself.
- [ ] All REST methods use `fetch()` against `http://localhost:${this._port}`
- [ ] **REST failure semantics:** If the server probe succeeds but the REST call fails (network error, 5xx, timeout), the method throws (does NOT fall back to direct write — that would bypass server in-memory state). REST calls use a 5-second timeout. Callers handle retries.
- [ ] For items with no `lifecycle.featureCode` found by `_restFindFeatureItem()` (partial creation from a previous failed attempt), `_restEnsureFeatureItem()` calls `POST /lifecycle/start` on the existing item instead of creating a duplicate

---

## Task 12: Make public methods async with dual dispatch

**Files:** `lib/vision-writer.js` (existing)
**Depends on:** Task 11
**Acceptance criteria:**
- [ ] `findFeatureItem(featureCode)` becomes `async findFeatureItem(featureCode)` — probes server, delegates to `_restFindFeatureItem` or `_directFindFeatureItem`
- [ ] `ensureFeatureItem(featureCode, title)` becomes `async ensureFeatureItem(featureCode, title)` — same pattern
- [ ] `updateItemStatus(itemId, status)` becomes `async updateItemStatus(itemId, status)` — same pattern
- [ ] `updateItemPhase(itemId, stepId)` becomes `async updateItemPhase(itemId, stepId)` — same pattern
- [ ] `createGate(flowId, stepId, itemId)` becomes `async createGate(flowId, stepId, itemId, { round, fromPhase, toPhase, artifact, options, summary, comment }?)` — same pattern, with optional gate metadata matching STRAT-COMP-6 enrichment fields
- [ ] `resolveGate(gateId, outcome, comment?)` becomes `async resolveGate(gateId, outcome, comment?)` — same pattern; `comment` is optional string passed to `POST /api/vision/gates/:id/resolve { outcome, comment }` (used by STRAT-COMP-8 GateAlert for revise feedback and kill reasons)
- [ ] Original file-based logic preserved in `_direct*` prefixed methods

---

## Task 13: Add `getGate(gateId)` method to VisionWriter

**Files:** `lib/vision-writer.js` (existing)
**Depends on:** Task 12
**Acceptance criteria:**
- [ ] `async getGate(gateId, opts?)` — REST: `GET /api/vision/gates/:id`; Direct: read from `vision-state.json` gates array
- [ ] Returns gate object or `null`
- [ ] Supports `{ requireServer: true }` option: when set, skips dual-dispatch fallback — if probe fails, throws `ServerUnreachableError` instead of falling back to direct file read. This allows callers (like `pollGateResolution()`) to detect server loss during polling.
- [ ] Default behavior (no option or `requireServer: false`): standard dual-dispatch (REST when server up, direct when down)
- [ ] Used by `pollGateResolution()` in Task 17 with `{ requireServer: true }`

---

## Task 14: Update all VisionWriter call sites in `build.js`

**Files:** `lib/build.js` (existing)
**Depends on:** Task 12
**Acceptance criteria:**
- [ ] Line 138: `new VisionWriter(dataDir)` becomes `new VisionWriter(dataDir, { port })` where `port` is resolved via the shared `resolvePort()` utility (Task 1a)
- [ ] Line 139: `visionWriter.ensureFeatureItem(...)` becomes `await visionWriter.ensureFeatureItem(...)`
- [ ] Line 186: `visionWriter.updateItemStatus(...)` becomes `await visionWriter.updateItemStatus(...)`
- [ ] Line 201: `visionWriter.updateItemPhase(...)` becomes `await visionWriter.updateItemPhase(...)`
- [ ] Line 221: `visionWriter.createGate(...)` becomes `await visionWriter.createGate(...)`
- [ ] Line 245: `visionWriter.resolveGate(...)` becomes `await visionWriter.resolveGate(...)`
- [ ] Lines 381, 400, 424: child flow VisionWriter calls become awaited
- [ ] Lines 303, 312, 315: status update calls become awaited
- [ ] Lines 564-568 (`abortBuild`): `findFeatureItem()` and `updateItemStatus()` become awaited (currently fire-and-forget)

---

## Task 15: Update all VisionWriter call sites in `new.js`

**Files:** `lib/new.js` (existing)
**Depends on:** Task 12
**Acceptance criteria:**
- [ ] All `visionWriter.ensureFeatureItem()` calls become awaited (line 109)
- [ ] All `visionWriter.updateItemStatus()` calls become awaited (lines 121, 290, 293)
- [ ] All `visionWriter.updateItemPhase()` calls become awaited (lines 135, 334)
- [ ] All `visionWriter.createGate()` calls become awaited (lines 209, 348)
- [ ] All `visionWriter.resolveGate()` calls become awaited (lines 239, 350)
- [ ] VisionWriter constructor receives `{ port }` option
- [ ] Gate handling in `new.js` uses the same `pollGateResolution()` helper from `build.js` (Task 17), ensuring identical polling semantics:
  - No client-side poll timeout; the server owns gate expiration via `COMPOSE_GATE_TIMEOUT`
  - `expired` gate status is fatal
  - 404 gate lookup is fatal
  - 3 consecutive probe failures trigger readline fallback only when TTY is available; otherwise exit with error
- [ ] When server is running: create gate via REST (`visionWriter.createGate`), poll with `pollGateResolution()`, then resolve via `stratum.gateResolve()`. When server is down: fall back to readline prompt.
- [ ] Non-interactive/no-TTY fallback: if `!process.stdin.isTTY` and server is unreachable, exit with error "Gate pending but no TTY for readline and server is unreachable. Start the server or run interactively." Exit code 1.
- [ ] `compose new` does NOT write `active-build.json` or `.compose/build-stream.jsonl` — gate delegation is the only shared behavior with `compose build`

---

## Task 16: Add gate REST endpoints

**Files:** `server/vision-routes.js` (existing)
**Depends on:** Task 5
**Acceptance criteria:**

**`POST /api/vision/gates` (creation):**
- [ ] New route inserted after `GET /api/vision/gates` (after line 309)
- [ ] Accepts `{ flowId, stepId, round?, itemId?, artifact?, options?, fromPhase?, toPhase?, summary?, comment? }`
- [ ] Requires `flowId` and `stepId` — returns 400 if missing
- [ ] Gate ID is `${flowId}:${stepId}:${round}` (round defaults to 1)
- [ ] Idempotent: if gate with same ID already exists, returns 200 with existing gate
- [ ] Creates gate with `status: 'pending'`, `createdAt` timestamp
- [ ] Calls `store.createGate(gate)` and `scheduleBroadcast()`
- [ ] Broadcasts `{ type: 'gateCreated', gateId, itemId, timestamp }` via WebSocket
- [ ] Returns 201 with full gate object

**`GET /api/vision/gates/:id` (single gate):**
- [ ] Returns full gate object `{ id, flowId, stepId, round, itemId?, artifact?, summary?, options?, fromPhase?, toPhase?, comment?, status, outcome?, createdAt, resolvedAt? }`
- [ ] Returns 404 if gate does not exist
- [ ] Used by CLI for polling

**`GET /api/vision/gates` (list) update:**
- [ ] Add `?status=resolved` to return only resolved gates
- [ ] Add `?status=all` to return all gates
- [ ] Default (no param) returns pending gates only (excludes expired)

**Gate expiry:**
- [ ] Gates with `status: "pending"` older than `COMPOSE_GATE_TIMEOUT` (default 30 min) are marked `status: "expired"` on access (lazy expiry in `GET /api/vision/gates` and `GET /api/vision/gates/:id`)
- [ ] Expired gates are excluded from the active review queue in the UI
- [ ] Expired gates are terminal server state; the CLI treats `expired` as a fatal condition and the user must re-run the build to create a fresh gate

**`POST /api/vision/gates/:id/resolve` update:**
- [ ] Server MUST NOT advance lifecycle or mutate item status — only update gate `status` to `resolved`, store `outcome`/`comment`, and set `resolvedAt`
- [ ] Normalize legacy outcome values: `approved` → `approve`, `killed` → `kill`, `revised` → `revise`
- [ ] Remove or guard existing server-side lifecycle advance code that currently runs on resolve

---

## Task 17: Add `pollGateResolution()` helper to `build.js`

**Files:** `lib/build.js` (existing)
**Depends on:** Tasks 13, 14
**Acceptance criteria:**
- [ ] New async function `pollGateResolution(visionWriter, gateId, intervalMs = 2000)`
- [ ] Polls `visionWriter.getGate(gateId)` every `intervalMs`
- [ ] Returns gate object when `gate.status === 'resolved'` — caller proceeds to `stratum.gateResolve()` with the outcome
- [ ] Continues polling while `gate.status === 'pending'` — there is no client-side timeout in v1
- [ ] Throws a fatal error if gate status becomes `expired` (server-marked timeout)
- [ ] Throws a fatal error on 404 (authoritative gate record lost)
- [ ] Uses `visionWriter.getGate(gateId, { requireServer: true })` mode (see Task 13) so probe failures are surfaced, not masked by direct-file fallback
- [ ] Tracks consecutive probe failures during polling: if 3 consecutive probes fail (server became unreachable mid-poll), returns `null` immediately so the caller can decide between readline fallback (TTY) and a hard failure (non-interactive)
- [ ] The gate remains `pending` on the server if the server comes back later; the CLI has already resolved via readline

---

## Task 18: Branch gate handling in `build.js` main loop (server-up path)

**Files:** `lib/build.js` (existing)
**Depends on:** Tasks 2, 14, 16, 17
**Acceptance criteria:**
- [ ] At `await_gate` (line 217): probe server via `probeServer()`
- [ ] Server up: create gate via REST (`visionWriter.createGate`), poll with `pollGateResolution()`, then call `stratum.gateResolve()` with resolved outcome
- [ ] While polling, `expired` and 404 surface as fatal errors; only mid-poll server loss (3 consecutive probe failures) may fall back to readline
- [ ] Server down + TTY available: full readline fallback (current behavior preserved exactly)
- [ ] Server down + no TTY (`!process.stdin.isTTY`): exit with error "Gate pending but no TTY for readline and server is unreachable. Start the server or run interactively." Exit code 1.
- [ ] If the server probe succeeds but gate creation REST call fails, exit with error immediately — no readline fallback and no local gate record
- [ ] After readline fallback (mid-poll server loss), attempts `visionWriter.resolveGate()` via REST to sync server state (tolerates failure — server may still be down)
- [ ] `stratum.gateResolve()` always called by CLI (AD-4 — server has no Stratum client)

---

## Task 19: Branch gate handling in `executeChildFlow()`

**Files:** `lib/build.js` (existing)
**Depends on:** Task 18
**Acceptance criteria:**
- [ ] Same server-probe + gate-delegation pattern as Task 18 applied to child flow gate handling (lines 397-426)
- [ ] Falls back to readline prompt only when the server is unreachable and TTY is available; `expired`/404 remain fatal

---

## Task 20: Update existing tests

**Files:** `test/vision-writer.test.js` (existing), `test/build.test.js` (existing)
**Depends on:** Tasks 6-15
**Acceptance criteria:**
- [ ] `vision-writer.test.js` tests updated for async methods (all public methods now return Promises)
- [ ] `vision-writer.test.js` tests updated for new featureCode format (`lifecycle.featureCode` instead of `featureCode: "feature:..."`)
- [ ] Migration test: load state with old `featureCode: "feature:X"` format, verify migration produces `lifecycle.featureCode: "X"` and removes old field
- [ ] `build.test.js` tests updated for async VisionWriter calls
- [ ] All existing test assertions remain valid (no test weakening)

---

## Task 21: Cross-feature doc synchronization

**Files:** `compose/docs/features/STRAT-COMP-2/design.md` (existing), `compose/docs/features/STRAT-COMP-4/design.md` (existing), `compose/docs/features/STRAT-COMP-5/design.md` (existing), `compose/docs/features/STRAT-COMP-8/design.md` (existing)
**Depends on:** Tasks 6-8 (featureCode migration defines the canonical format)
**Acceptance criteria:**
- [ ] Update STRAT-COMP-2 design.md: note that `featureCode: "feature:..."` convention is superseded by `lifecycle.featureCode` as of STRAT-COMP-4
- [ ] Update STRAT-COMP-5 design.md: align `active-build.json` terminal-state semantics with this design (retain final snapshot, do not delete)
- [ ] Update STRAT-COMP-4 design.md (BLOCKING before STRAT-COMP-7 implementation): replace the provisional JSONL contract with a reference to STRAT-COMP-7 as the authoritative `.compose/build-stream.jsonl` schema owner (`type` discriminator, STRAT-COMP-7 event names)
- [ ] Update STRAT-COMP-8 design.md (BLOCKING before STRAT-COMP-8 implementation): align on `active-build.json` terminal-state semantics, `violations` as `string[]`, `buildState` WebSocket payload shape, shared step-to-phase lookup table

---

## Task 22: Integration test — full verification

**Files:** `test/integration/vision-unification.test.js` (new)
**Depends on:** Tasks 1, 1a, 2-19, 21 (exercises all production code paths)
**Acceptance criteria:**

**featureCode round-trip:**
- [ ] CLI creates feature item via VisionWriter (direct mode)
- [ ] Server's `VisionStore.getItemByFeatureCode()` finds the same item after loading the file
- [ ] No `feature:` prefix appears in the serialized `vision-state.json`

**Gate round-trip:**
- [ ] Server creates gate via `POST /api/vision/gates` — gate appears in `GET /api/vision/gates`
- [ ] `GET /api/vision/gates/:id` returns the full gate object
- [ ] Gate resolution via `POST /api/vision/gates/:id/resolve` sets `status: 'resolved'`, `outcome` correctly (using canonical `approve`/`revise`/`kill`)
- [ ] Both VisionWriter and VisionStore produce identical gate status shapes after resolution
- [ ] Server resolve handler does NOT advance lifecycle

**REST dispatch:**
- [ ] VisionWriter with server running dispatches to REST for all public methods
- [ ] VisionWriter with server down dispatches to direct file writes
- [ ] VisionWriter throws (not falls back) when probe succeeds but REST fails

**`compose new` verification:**
- [ ] `compose new` with server running creates items via REST
- [ ] `compose new` with server down writes directly to file
- [ ] `compose new` with server running creates gates via REST and resolves via web UI poll
- [ ] `compose new` with server down uses readline fallback for gates
- [ ] `compose new` with no TTY and no server exits with error for gates

**Port coordination:**
- [ ] Server and CLI agree on port via `COMPOSE_PORT > PORT > 3001`

**Migration:**
- [ ] Verify `server/feature-scan.js` uses `lifecycle.featureCode` format (implemented in Task 8)
- [ ] Update all test fixtures that reference old `featureCode: "feature:..."` format

---

## Build Order

```
Phase 1 (Foundation):     Tasks 1, 1a, 2-5 — Task 2 depends on 1 and 1a; rest parallelizable
Phase 2 (featureCode):    Tasks 6-8   — sequential (6 -> 7 -> 8), includes feature-scan.js audit
Phase 3 (REST mode):      Tasks 9-13  — sequential (9 -> 10 -> 11 -> 12 -> 13)
Phase 4 (Call sites):     Tasks 14-15 — parallel, depend on Task 12
Phase 5 (Gate delegation):Tasks 16-19 — sequential (16 -> 17 -> 18 -> 19)
Phase 6 (Tests):          Tasks 20, 22 — depend on all prior tasks
Phase 7 (Doc sync):       Task 21     — depends on Tasks 6-8, can run in parallel with Phase 6
```
