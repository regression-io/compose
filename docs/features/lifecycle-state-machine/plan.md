# Feature Lifecycle State Machine: Implementation Plan

**Status:** PLAN
**Date:** 2026-03-05
**Blueprint:** [blueprint.md](./blueprint.md)
**Design:** [design.md](./design.md)

---

## Task Order

Tasks 1 and 3 are independent (core module + store method). Task 2 (tests) depends on both. Tasks 4–6 are sequential after that. Task 7 verifies everything.

```
Task 1: lifecycle-manager.js (core module)  ─┐
Task 3: vision-store.js (updateLifecycle)    ─┤ (parallel)
                                              ↓
Task 2: lifecycle-manager.test.js (prove core + store)
  ↓
Task 4: vision-routes.js (REST endpoints)
  ↓
Task 5: compose-mcp-tools.js (MCP tool implementations)
  ↓
Task 6: compose-mcp.js (tool definitions + switch wiring)
  ↓
Task 7: integration test (REST endpoints + wiring)
```

---

## Task 1: Create `server/lifecycle-manager.js` (new)

**What:** Core state machine module — constants, class, all 8 methods.

**File:** `server/lifecycle-manager.js` (new)

**Pattern:** Follow `server/vision-store.js` — ES module export, private fields with `#`, no class inheritance.

**Implementation:**

- [ ] Export constants: `PHASES`, `TERMINAL`, `SKIPPABLE`, `TRANSITIONS`, `PHASE_ARTIFACTS`
- [ ] Export `class LifecycleManager` with `#store` and `#featureRoot` private fields
- [ ] `constructor(store, featureRoot)` — store assignments, validate featureRoot exists
- [ ] `startLifecycle(itemId, featureCode)` — get item, scan artifacts, create lifecycle object with seeded open history entry, call `store.updateLifecycle()`
- [ ] `advancePhase(itemId, targetPhase, outcome)` — validate not terminal, validate targetPhase in `TRANSITIONS[currentPhase]`, validate outcome is `approved|revised`, if `revised` validate backward edge, close current history entry, push new entry, update currentPhase, scan artifact, clear reconcileWarning, persist
- [ ] `skipPhase(itemId, targetPhase, reason)` — validate not terminal, validate currentPhase in `SKIPPABLE`, validate targetPhase in transitions, close with `skipped` + reason, push new entry, persist
- [ ] `killFeature(itemId, reason)` — validate not terminal, close with `killed`, set `killedAt`/`killReason`, persist lifecycle, update item status to `killed`
- [ ] `completeFeature(itemId)` — validate `currentPhase === 'ship'`, close with `approved`, set `completedAt`, persist lifecycle, update item status to `complete`
- [ ] `getPhase(itemId)` — return `lifecycle.currentPhase`
- [ ] `getHistory(itemId)` — return `lifecycle.phaseHistory`
- [ ] `reconcile(itemId)` — scan artifacts, compare inferred phase vs current: forward → advance with `reconciled` entries, backward → set `reconcileWarning`, equal → clear warning
- [ ] Helper: `#getLifecycle(itemId)` — shared get-item-and-validate used by all methods
- [ ] Helper: `#scanArtifacts(featureCode)` — check `fs.existsSync` for each `PHASE_ARTIFACTS` value
- [ ] Use `import fs from 'node:fs'` and `import path from 'node:path'`

**Test:** Covered by Task 2.

---

## Task 2: Create `test/lifecycle-manager.test.js` (new)

**What:** Full test coverage for the state machine and store method. Depends on Tasks 1 and 3 both being complete.

**File:** `test/lifecycle-manager.test.js` (new)

**Pattern:** Follow `test/server-units.test.js` — `node:test` + `assert/strict`, temp dirs via `mkdtempSync`, dynamic imports.

**Implementation:**

- [ ] **Helpers:** `makeStore()` creates a VisionStore pointing at a temp dir with one pre-populated feature item; `makeManager(store, featureDir)` wraps construction; `afterEach` cleanup of temp dirs
- [ ] **Happy path: startLifecycle** — creates lifecycle with `currentPhase: 'explore_design'`, seeded history entry, scanned artifacts
- [ ] **Happy path: full advance sequence** — explore_design → blueprint (skip prd, architecture) → verification → plan → execute → docs → ship → complete
- [ ] **Happy path: skipPhase** — skip prd (from explore_design), skip architecture (from prd), skip report (from execute)
- [ ] **Happy path: revision loop** — verification → blueprint with `outcome: 'revised'`
- [ ] **Happy path: killFeature** — kill from any mid-phase, verify `killedAt`, `killReason`, item status
- [ ] **Happy path: completeFeature** — from ship, verify `completedAt`, item status
- [ ] **Error paths (table-driven):**
  - [ ] Invalid transition (explore_design → execute) → throws
  - [ ] Advance from terminal `complete` → throws
  - [ ] Advance from terminal `killed` → throws
  - [ ] Skip non-skippable phase (blueprint) → throws
  - [ ] Complete from non-ship phase (execute) → throws
  - [ ] Kill from terminal state → throws
  - [ ] Invalid outcome ('foo') → throws
  - [ ] `revised` on forward edge (explore_design → blueprint) → throws
  - [ ] No lifecycle on item → throws
  - [ ] Item not found → throws
- [ ] **Reconciliation: forward** — create lifecycle at explore_design, put `blueprint.md` on disk, reconcile → currentPhase advances, intermediate entries have `outcome: 'reconciled'`
- [ ] **Reconciliation: backward** — create lifecycle at `plan`, remove `blueprint.md`, reconcile → `reconcileWarning` set, currentPhase unchanged
- [ ] **Reconciliation: equal** — reconcile with matching state → clears any existing warning
- [ ] **Store integration: allowlist protection** — call `store.updateItem(id, { lifecycle: {...} })` → lifecycle field not set on item
- [ ] **Store integration: updateLifecycle** — call `store.updateLifecycle(id, {...})` → lifecycle field is set

**Run:** `node --test test/lifecycle-manager.test.js`

---

## Task 3: Edit `server/vision-store.js` (existing)

**What:** Add `updateLifecycle()` method.

**File:** `server/vision-store.js` (existing) — insert after line 141 (end of `updateItem`)

**Pattern:** Follow `updateItem` — same item lookup, timestamp, save pattern.

**Implementation:**

- [ ] Add `updateLifecycle(id, lifecycle)` method after line 141:
  ```js
  updateLifecycle(id, lifecycle) {
    const item = this.items.get(id);
    if (!item) throw new Error(`Item not found: ${id}`);
    item.lifecycle = lifecycle;
    item.updatedAt = new Date().toISOString();
    this.items.set(id, item);
    this._save();
    return item;
  }
  ```
- [ ] No changes to `updateItem` — allowlist already excludes `lifecycle`

**Test:** Already covered by Task 2 store integration tests.

---

## Task 4: Edit `server/vision-routes.js` (existing)

**What:** Add 6 lifecycle REST endpoints.

**File:** `server/vision-routes.js` (existing)

**Pattern:** Follow existing route handlers — try/catch, `res.json()`, `scheduleBroadcast()` after mutations.

**Implementation:**

- [ ] Add import at top (after line 21): `import { LifecycleManager } from './lifecycle-manager.js';`
- [ ] Add route comment to file header docblock: lifecycle endpoint paths
- [ ] Inside `attachVisionRoutes`, after line 105, instantiate: `const lifecycleManager = new LifecycleManager(store, path.join(projectRoot, 'docs', 'features'));`
- [ ] `GET /api/vision/items/:id/lifecycle` — return lifecycle object or 404
- [ ] `POST /api/vision/items/:id/lifecycle/start` — `{ featureCode }` → `lifecycleManager.startLifecycle()`, `scheduleBroadcast()`, broadcast `lifecycleStarted` event (distinct from transition — no `from`/`outcome`)
- [ ] `POST /api/vision/items/:id/lifecycle/advance` — `{ targetPhase, outcome }` → `lifecycleManager.advancePhase()`, broadcast `lifecycleTransition`
- [ ] `POST /api/vision/items/:id/lifecycle/skip` — `{ targetPhase, reason }` → `lifecycleManager.skipPhase()`, broadcast `lifecycleTransition`
- [ ] `POST /api/vision/items/:id/lifecycle/kill` — `{ reason }` → `lifecycleManager.killFeature()`, broadcast `lifecycleTransition`
- [ ] `POST /api/vision/items/:id/lifecycle/complete` — `{}` → `lifecycleManager.completeFeature()`, broadcast `lifecycleTransition`
- [ ] All POST routes: try/catch, 400 on validation errors, 404 on item not found, 500 on unexpected
- [ ] Broadcast shapes:
  - `lifecycleStarted`: `{ type: 'lifecycleStarted', itemId, phase: 'explore_design', featureCode, timestamp }`
  - `lifecycleTransition`: `{ type: 'lifecycleTransition', itemId, from, to, outcome, timestamp }`

**Test:** Task 7 smoke test.

---

## Task 5: Edit `server/compose-mcp-tools.js` (existing)

**What:** Add 5 MCP tool implementations + HTTP helper.

**File:** `server/compose-mcp-tools.js` (existing) — add after line 171

**Pattern:** Follow existing tool functions — take destructured args, return plain object.

**Implementation:**

- [ ] Add `import http from 'node:http';` at top of file
- [ ] Add `const COMPOSE_API = \`http://127.0.0.1:${process.env.COMPOSE_PORT || process.env.PORT || 3001}\`;` — `COMPOSE_PORT` is the explicit override for when MCP and server run in different env contexts; falls back to `PORT` (same-process) then `3001` (default)
- [ ] Add `_postLifecycle(itemId, action, body)` — Promise wrapper around `http.request`, POST JSON, parse response
- [ ] `export function toolGetFeatureLifecycle({ id })` — `loadVisionState()`, find item by id or slug, return `item.lifecycle` or error
- [ ] `export async function toolAdvanceFeaturePhase({ id, targetPhase, outcome })` — `await _postLifecycle(id, 'advance', { targetPhase, outcome })`
- [ ] `export async function toolSkipFeaturePhase({ id, targetPhase, reason })` — `await _postLifecycle(id, 'skip', { targetPhase, reason })`
- [ ] `export async function toolKillFeature({ id, reason })` — `await _postLifecycle(id, 'kill', { reason })`
- [ ] `export async function toolCompleteFeature({ id })` — `await _postLifecycle(id, 'complete', {})`

**Test:** Task 7 integration test exercises `_postLifecycle` → REST round-trip. Additionally, Task 7 directly imports and calls `toolGetFeatureLifecycle` (sync, disk-read) and verifies MCP tool schemas.

---

## Task 6: Edit `server/compose-mcp.js` (existing)

**What:** Wire new tools — imports, definitions, switch cases.

**File:** `server/compose-mcp.js` (existing)

**Pattern:** Follow existing tool registration — same structure.

**Implementation:**

- [ ] Add imports after line 35: `toolGetFeatureLifecycle`, `toolAdvanceFeaturePhase`, `toolSkipFeaturePhase`, `toolKillFeature`, `toolCompleteFeature`
- [ ] Add 5 tool definitions to `TOOLS` array before the closing `];` at line 114 — schemas from blueprint section 4
- [ ] Add 5 switch cases before `default:` at line 140:
  - `get_feature_lifecycle` — sync (no await)
  - `advance_feature_phase` — `await`
  - `skip_feature_phase` — `await`
  - `kill_feature` — `await`
  - `complete_feature` — `await`

**Test:** Task 7 verifies tool schema registration via text parsing (compose-mcp.js is an executable entrypoint — cannot be imported without side effects) and `node --check` validates syntax.

---

## Task 7: Integration Test

**What:** Verify REST endpoints + broadcast wiring end-to-end. Not just syntax — actually hit the routes.

**File:** `test/lifecycle-routes.test.js` (new)

**Pattern:** Spin up Express app with in-memory VisionStore, attach routes, use `node:http` to hit endpoints.

**Implementation:**

- [ ] **Setup:** Create Express app, temp-dir VisionStore, attach vision routes, listen on ephemeral port (`server.listen(0)`)
- [ ] **Teardown:** Close server, clean temp dir
- [ ] **Test: start lifecycle** — POST `/api/vision/items/:id/lifecycle/start` with `{ featureCode }` → 200, response has `currentPhase: 'explore_design'`
- [ ] **Test: advance phase** — POST `/api/vision/items/:id/lifecycle/advance` with `{ targetPhase: 'blueprint', outcome: 'approved' }` → 200, response has `from` and `to`
- [ ] **Test: skip phase** — start fresh, POST skip with reason → 200, response has `outcome: 'skipped'`
- [ ] **Test: kill feature** — POST kill with reason → 200, verify item status changed to `killed`
- [ ] **Test: complete feature** — advance to ship, POST complete → 200, verify `completedAt`
- [ ] **Test: invalid transition** — POST advance with bad target → 400
- [ ] **Test: GET lifecycle** — GET `/api/vision/items/:id/lifecycle` → 200, returns lifecycle object
- [ ] **Test: broadcast emitted** — capture `broadcastMessage` calls, verify `lifecycleStarted` and `lifecycleTransition` shapes
- [ ] **Test: MCP tool read (disk)** — import `toolGetFeatureLifecycle` from `compose-mcp-tools.js`, call with item id, verify it returns lifecycle from disk state
- [ ] **Test: MCP tool mutation (HTTP delegation)** — set `process.env.COMPOSE_PORT` to the ephemeral test server port before importing `compose-mcp-tools.js`, then call `toolAdvanceFeaturePhase` and verify it round-trips through `_postLifecycle` → REST → LifecycleManager → response. Reset env after test.
- [ ] **Test: MCP tool schemas** — `node --check server/compose-mcp.js` for syntax; for schema validation, read the file as text and parse the `TOOLS` array entries with a regex or JSON extract (do NOT import the module — it's an executable entrypoint with top-level server startup that would hang). Verify 5 new tool names exist: `get_feature_lifecycle`, `advance_feature_phase`, `skip_feature_phase`, `kill_feature`, `complete_feature`.
- [ ] Syntax checks: `node --check` on all 5 server files
- [ ] Regression: `node --test test/server-units.test.js` still passes

**Run:** `node --test test/lifecycle-routes.test.js`

---

## Files Summary

| File | Action | Task |
|------|--------|------|
| `server/lifecycle-manager.js` | **Create** | 1 |
| `server/vision-store.js` | **Edit** (add method after line 141) | 3 |
| `test/lifecycle-manager.test.js` | **Create** | 2 |
| `server/vision-routes.js` | **Edit** (add import + 6 routes after line 105) | 4 |
| `server/compose-mcp-tools.js` | **Edit** (add import + helper + 5 functions after line 171) | 5 |
| `server/compose-mcp.js` | **Edit** (add imports + 5 defs + 5 cases) | 6 |
| `test/lifecycle-routes.test.js` | **Create** | 7 |
| `server/vision-server.js` | **No change** | — |
