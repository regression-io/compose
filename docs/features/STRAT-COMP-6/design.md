# STRAT-COMP-6: Web Gate Resolution

**Status:** COMPLETE
**Created:** 2026-03-12
**Roadmap:** [ROADMAP.md](../../../ROADMAP.md) — Milestone 4, item 49

## Related Documents

- [STRAT-COMP-4 design](../STRAT-COMP-4/design.md) — parent feature, Unified Interface (prerequisite)
- [STRAT-COMP-5 design](../STRAT-COMP-5/design.md) — build visibility (parallel dependency)
- [STRAT-COMP-8 design](../STRAT-COMP-8/design.md) — active build dashboard (downstream consumer)

**Prerequisite sequencing:** STRAT-COMP-4 defines the foundational changes (async dual dispatch in VisionWriter, server-probe.js, getGateByFlowStep). STRAT-COMP-6 depends on those pieces. If STRAT-COMP-4 is not yet complete when STRAT-COMP-6 implementation begins, the implementation plan builds the missing prerequisites as its first tasks. The Files Changed table marks each entry with its owner. **Ownership rule:** items marked "STRAT-COMP-4 prerequisite" are owned by STRAT-COMP-4's design and acceptance criteria. STRAT-COMP-6 builds them only if they are absent at implementation time. STRAT-COMP-6's acceptance criteria cover only the STRAT-COMP-6-scoped work; prerequisite items are accepted against STRAT-COMP-4's criteria.

---

## Goals

1. **Gates resolvable via web UI.** When any Compose flow (`compose build` or `compose new`) hits a gate and the server is running, the gate appears in the web UI and can be resolved there. The CLI polls for the resolution and continues the flow.
2. **Unified gate system.** Eliminate the dual gate systems (CLI file-based + server in-memory). Vision Store is the single source of truth when the server is running.
3. **Graceful fallback.** When the server is unreachable at probe time, the CLI falls back to readline prompt (current behavior). No regression. When the server is confirmed running but a REST call fails, the build exits with error (per STRAT-COMP-4 single-authority rule). When the server is lost mid-poll (3 consecutive failures), the CLI falls back to readline if TTY is available. In non-interactive mode (no TTY, per STRAT-COMP-4): if the server is running, gate delegation to the web UI is the only option (user resolves via browser). If both TTY and server are unavailable, the build exits with error: "Gate pending but no TTY for readline and server is unreachable. Start the server or run interactively." Exit code 1.

## Non-Goals

1. **WebSocket-based CLI notification.** Polling at 2s is sufficient for human-review gates. WebSocket push is out of scope.
2. **Abandoned gate cleanup beyond expiration.** Stale gates are expired after `COMPOSE_GATE_TIMEOUT` (per STRAT-COMP-4). More sophisticated cleanup (e.g., cross-referencing `active-build.json` to identify truly orphaned gates) is out of scope.
3. **Gate resolution from server-side Stratum.** The server does not call `stratum.gateResolve()`. Only the CLI, which owns the live Stratum session, resolves flows.
4. **Rewriting GateView.** The existing component is well-structured. Changes are additive, not a rewrite.

---

## 1. Problem Statement

### What is a gate?

A gate is a hard pause in the Stratum build pipeline. When `stratum_step_done` returns `status: 'await_gate'`, the CLI must collect a human decision — approve, revise, or kill — before the build continues. The gate carries structured context: which feature, which lifecycle transition, and what artifact was just produced.

### What is broken today?

**Two gate systems coexist and diverge.**

The CLI owns one system: `VisionWriter.createGate()` writes a gate record directly to `vision-state.json` (`lib/vision-writer.js:155`), then `promptGate()` opens a readline loop on stdin/stdout (`lib/gate-prompt.js:34`). When the user decides, `VisionWriter.resolveGate()` updates the file and `stratum.gateResolve()` resolves the Stratum flow (`lib/build.js:245-246`).

The server owns a separate system: `VisionStore` keeps an in-memory gate map. `GET /api/vision/gates` and `POST /api/vision/gates/:id/resolve` operate on that in-memory state. `GateView.jsx` in the sidebar reads Vision Store gates. `StratumPanel.jsx` reads Stratum's own gate list via `GET /api/stratum/gates`.

**The three concrete breakages:**

1. **CLI file writes are invisible to the server.** `VisionWriter` writes directly to `vision-state.json`. `VisionStore` loads from disk at startup and then maintains in-memory state. File writes by the CLI after startup are never picked up — the server's gate map stays empty while a build is running.

2. **No `POST /api/vision/gates` endpoint.** The CLI cannot create a gate in the Vision Store via REST. There is no creation endpoint — only `GET` (list) and `POST /:id/resolve` (resolve an existing gate). Even if the CLI tried to delegate gate creation to the server, there is nowhere to call.

3. **`POST /api/vision/gates/:id/resolve` does not notify Stratum.** The resolve endpoint calls `store.resolveGate()` and broadcasts a `gateResolved` WebSocket message, but never calls `stratum.gateResolve()` (`server/vision-routes.js:321-355`). A gate resolved through the web UI leaves the Stratum flow permanently blocked.

**Consequence:** if `compose start` is running and a build hits a gate, the CLI falls through to readline (the server is unreachable from the gate's perspective), the web UI shows nothing, and the two systems give different answers about gate state.

---

## 2. Architecture

### Design principle: Vision Store is the single source of truth for gates

Stratum gates and Vision Store gates must be unified. The Vision Store owns the gate lifecycle. Stratum is notified of resolution outcomes. This is the same ownership model that STRAT-COMP-4 establishes for `vision-state.json` generally: when the server is running, the server owns state and the CLI delegates via REST.

**Why Vision Store, not Stratum?**

Stratum gates are identified by `(flowId, stepId)` — internal Stratum identifiers. Vision Store gates carry `itemId`, `fromPhase`, `toPhase`, `artifactAssessment` — the human-meaningful context the UI needs. The web UI already renders Vision Store gates correctly. Promoting Stratum gates to the web layer would mean replicating that context into Stratum's data model. It's cheaper to keep Stratum as the executor and Vision Store as the truth.

### Server-running path

```
CLI: response.status === 'await_gate'
  │
  ├── probe GET /api/health (500ms timeout)
  │       └── 200 OK → server is running
  │
  ├── POST /api/vision/gates
  │     body: { flowId, stepId, round, itemId, fromPhase, toPhase,
  │             artifact, artifactAssessment, summary }
  │     response: full gate object (CLI extracts gate.id as string)
  │
  ├── poll GET /api/vision/gates/:gateId every 2s (gateId is URL-encoded)
  │       └── gate.status === 'pending'  → keep polling
  │           gate.status === 'resolved' → read outcome, call stratum.gateResolve()
  │           gate.status === 'expired'  → server-side timeout (see §3.2)
  │
  └── on 'resolved': call stratum.gateResolve(flowId, stepId, outcome, rationale, 'human')
      └── build continues
```

### Server-not-running path (fallback)

```
CLI: response.status === 'await_gate'
  │
  ├── probe GET /api/health (500ms timeout)
  │       └── ECONNREFUSED / timeout → server not running
  │
  ├── VisionWriter.createGate() → direct file write (current behavior)
  │
  ├── promptGate() → readline on stdin/stdout (current behavior)
  │
  └── VisionWriter.resolveGate() + stratum.gateResolve() (current behavior)
```

### Server liveness check

The health check is performed once at the `await_gate` dispatch, not cached from build start. The server may start or stop during a build. A 500ms `AbortSignal` timeout is used — if the server is not reachable within that window, the CLI proceeds to readline. This matches the model established in STRAT-COMP-4.

### REST call failure after successful probe

**Gate creation failure:** If `POST /api/vision/gates` fails after a successful probe, the CLI throws (per STRAT-COMP-4: REST failure is fatal when server is confirmed running). The build exits with error: "Gate creation failed: server confirmed running but POST /api/vision/gates returned [status/error]. Cannot proceed." Exit code 1. No readline fallback, no local file write — the server-running path is committed once the probe succeeds. The rationale: once the CLI has confirmed the server is running and selected the server-running path, falling back to readline would create an unrecorded gate (violating single-authority) and silently degrade the user experience. The user should restart the server or investigate the failure. This applies regardless of TTY availability.

**Mid-poll server loss:** If the server becomes unreachable during polling (per STRAT-COMP-4: after 3 consecutive failures, ~6 seconds), the CLI checks for TTY. If TTY is available, it falls back to readline. After readline resolution, the CLI calls `stratum.gateResolve()` to advance the build and attempts `visionWriter.resolveGate()` via REST (tolerates failure if server still down). If no TTY is available (non-interactive mode) and the server is lost during polling, the build exits with error: "Gate pending but server lost and no TTY available." This is the unified rule: **after any server loss, check TTY before falling back to readline.**

**Polling failure counting:** During the poll loop, network errors (ECONNREFUSED, timeout) and 5xx responses increment a consecutive failure counter. After 3 consecutive failures, the CLI falls back to readline. A successful 200 response resets the counter to 0.

**404 handling:** A 404 from `GET /api/vision/gates/:gateId` on a reachable server means the gate record was lost (server restart before save, or data corruption). This is fatal — the build exits with error: "Gate not found on server (possible data loss). Gate ID: [gateId]." Exit code 1. No readline fallback. The rationale: once the server-running path is committed, losing the authoritative gate record is unrecoverable within the single-authority model. The user must investigate why the gate was lost (server restart, disk corruption) and re-run the build.

---

## 3. Gate Delegation Protocol

### 3.1 Gate creation payload

The CLI calls `POST /api/vision/gates` with:

```json
{
  "flowId": "feature:FEAT-1:build",
  "stepId": "design_gate",
  "round": 1,
  "itemId": "item-uuid",
  "fromPhase": "explore_design",
  "toPhase": "prd",
  "artifact": "docs/features/FEAT-1/design.md",
  "artifactAssessment": null,
  "summary": "Design phase complete. Agent produced design.md covering intent and architecture."
}
```

The `round` field is provided by the CLI from the Stratum step's retry count (per STRAT-COMP-4: `round` from the step's retry count, default `1`). **Server-side validation:** `round` defaults to `1` if absent from the request body; returns `400` if present but not a positive integer (prevents malformed composite keys). The server generates a deterministic composite key `flowId:stepId:round` as the gate ID from the request body fields, sets `status: 'pending'`, `createdAt`, and stores the gate in `VisionStore`. It responds `201` with the full gate object. The CLI's `_restCreateGate()` extracts `.id` from the response and returns it as a string.

**Gate identity across revise/retry loops:** Stratum's revise loops increment `state.round` within the same flow, so the same `flowId` and `stepId` will be encountered again after a revise. To avoid gate ID collisions, the composite key includes the round number: `${flowId}:${stepId}:${round}`. The `round` value comes from the Stratum step's retry count (per STRAT-COMP-4 gate schema, default `1`). This ensures each gate attempt produces a unique ID and previous gates remain in history with their resolved status. The dedup logic is a server-side safety net — if a gate creation request is delivered twice (e.g., due to network retry at the HTTP layer or a re-execution of the same build step), the server returns the existing gate instead of creating a duplicate. The CLI itself does not retry failed gate creation requests; gate creation failure after a successful probe is fatal (see §2, REST call failure).

**Acceptance criteria for gate identity:**
- [ ] Gate ID format is `${flowId}:${stepId}:${round}` where `round` defaults to `1` (per STRAT-COMP-4 gate schema).
- [ ] After a revise resolution, the next gate for the same `stepId` has a different `round` and thus a different gate ID.
- [ ] Both the old (resolved) and new (pending) gates are visible in gate history.

The `summary` field is the human-readable description of what the agent just did. The CLI populates it from `response.summary` on the gate dispatch if present, or constructs a fallback using `GATE_STEP_LABELS` (see enrichment table below).

**Gate ID URL encoding:** The composite key `flowId:stepId:round` contains colons. All URL paths that include a gate ID must use `encodeURIComponent(gateId)` (e.g., `GET /api/vision/gates/${encodeURIComponent(gateId)}`).

**Enrichment data derivation:**

| Field | Source | Fallback when unavailable |
|---|---|---|
| `fromPhase` | `item.lifecycle.currentPhase` via `VisionWriter.findFeatureItem(featureCode)` | `null` — UI shows "Unknown" |
| `toPhase` | `response.on_approve` from the Stratum `await_gate` dispatch. This is a step ID (e.g., `prd`). The UI renders it using the same `LIFECYCLE_PHASE_LABELS` constant from `src/components/vision/constants.js` that GateView already imports. If the step ID is not found in the label map, the UI applies a title-case fallback: replace underscores with spaces, capitalize first letter of each word. | `null` — UI shows "Unknown" |
| `artifact` | Primary: `response.inputs.artifact_path` from the Stratum `await_gate` dispatch step metadata (per STRAT-COMP-4 gate schema). Fallback: a static `GATE_ARTIFACTS` map in `lib/build.js` (`{ design_gate: 'design.md', prd_gate: 'prd.md', architecture_gate: 'architecture.md', plan_gate: 'plan.md', report_gate: 'report.md' }`) resolved to `docs/features/${featureCode}/${filename}` (project-relative, no `compose/` prefix — matches the path format used by `/api/canvas/open` and the example payload). Gates not in the map and without step metadata produce `null`. For child flows without `featureCode`, `null`. | `null` — no artifact link in UI |
| `artifactAssessment` | **Omitted in v1.** Always `null`. The field is reserved in the gate schema for future use (e.g., calling `GET /api/vision/items/${itemId}/artifacts` to populate it), but v1 does not populate it. The gate and UI are fully functional without it — no quality indicator is shown. | `null` — no quality indicator in UI |
| `summary` | `response.summary` from the Stratum dispatch | Fallback chain: (1) `"${GATE_STEP_LABELS[stepId]} for ${featureCode}"` using a static `GATE_STEP_LABELS` map in a shared module `lib/constants.js` (importable by both CLI and frontend), e.g., `{ design_gate: 'Design Review', prd_gate: 'PRD Review', plan_gate: 'Plan Review', architecture_gate: 'Architecture Review', report_gate: 'Report Review', ship_gate: 'Ship Review' }`; (2) title-case fallback of `stepId` (replace underscores, capitalize); (3) `"Gate: ${stepId}"` as the guaranteed final fallback. Never null or undefined. |

All enrichment fields except `summary` are optional. The CLI always provides `summary` — either from `response.summary` or the constructed fallback — so it is never null in practice. The remaining enrichment fields (`fromPhase`, `toPhase`, `artifact`, `artifactAssessment`) may be null if the data source is unavailable. The gate is fully functional without them — the UI degrades gracefully (shows "Unknown -> Unknown" for phase transition, no artifact link, no quality indicator). This ensures gates work even if the Stratum dispatch shape changes or if `VisionWriter.findFeatureItem()` is not available.

### 3.2 Polling for resolution

The CLI polls `GET /api/vision/gates/:gateId` every 2 seconds. The response is the full gate object: `{ id, flowId, stepId, round, itemId?, artifact?, summary?, fromPhase?, toPhase?, status, outcome?, comment?, createdAt, resolvedAt? }`. The CLI reads `status` to determine the poll result. When `gate.status === 'resolved'`, the CLI reads `gate.outcome` (one of `approve | revise | kill`) and `gate.comment` (optional string) and calls `stratum.gateResolve(flowId, stepId, gate.outcome, gate.comment, 'human')`. No outcome translation is needed — Vision Store and Stratum use the same canonical enum. When `gate.status === 'expired'`, the CLI treats it as a fatal error — the build exits with error: "Gate expired on server before resolution. Gate ID: [gateId]." Exit code 1. The `expired` status is terminal in the Vision Store — an expired gate cannot transition to `resolved`. The rationale: expiration means the gate sat unresolved past `COMPOSE_GATE_TIMEOUT` (default 30 min), indicating the user is not actively monitoring. Silently falling back to readline would mask the timeout. The user must re-run the build to create a fresh gate.

**Client-side poll timeout:** The CLI's own poll timeout is not needed — the server handles gate expiration via `COMPOSE_GATE_TIMEOUT` (default 30 min). The CLI polls indefinitely until it receives `resolved` (success), `expired` (fatal), or hits the 3-failure threshold (server loss). This avoids duplicating timeout logic in two places.

After the user resolves via readline, the CLI calls `stratum.gateResolve(flowId, stepId, outcome, rationale, 'human')` to advance the build. It also attempts to resolve the server-side gate via `POST /api/vision/gates/:id/resolve` (REST call, not a local file write). **Important:** `VisionWriter.resolveGate()` must distinguish between server-created gates and locally-created gates. For server-created gates (those created via `POST /api/vision/gates`), resolution uses the REST endpoint only — never a direct file write. For locally-created gates (fallback path when server was not running), resolution uses `VisionWriter`'s direct file write as today. The gate's origin (server or local) is tracked by the CLI using a flag set at creation time (e.g., `gateOrigin: 'server' | 'local'`). If the REST resolve call was for a gate already resolved via web UI (double-resolution), the REST call returns `200` with the existing gate (no-op, idempotent — does not overwrite the previous resolution). If the REST call fails (server down), the gate remains pending in the server store. **This is an accepted known gap:** the Stratum flow has advanced (via `stratum.gateResolve()`) but the Vision Store gate is stale. The CLI does NOT retry the REST resolve — it proceeds with the build. The stale gate will be expired by `COMPOSE_GATE_TIMEOUT` on the server's next periodic cleanup (per STRAT-COMP-4's `expireStaleGates()`) or can be manually resolved via the web UI on next server start. No reconciliation mechanism exists in v1 beyond expiration.

**Acceptance criteria for polling:**
- [ ] CLI polls indefinitely (no client-side timeout) — server-side `COMPOSE_GATE_TIMEOUT` handles expiration.
- [ ] Poll interval is `GATE_POLL_INTERVAL` (default: 2 seconds).
- [ ] On `resolved`: CLI reads outcome/comment, calls `stratum.gateResolve()`, build continues.
- [ ] On `expired`: CLI exits with fatal error (expired is terminal, gate cannot be resolved after expiration).
- [ ] On 404: CLI exits with fatal error (gate record lost).
- [ ] On 3 consecutive network/5xx failures: CLI falls back to readline (if TTY) or exits with error (if non-interactive).

### 3.3 Stratum gate resolution

After the CLI receives `status === 'resolved'` from polling, it calls:

```js
await stratum.gateResolve(flowId, stepId, outcome, rationale, 'human')
```

The server-side resolve endpoint (`POST /api/vision/gates/:id/resolve`) does NOT call `stratum.gateResolve()`. That call belongs to the CLI, which holds the live MCP connection to Stratum. The server has a separate `stratum-client.js` subprocess but it is a different Stratum session — using it to resolve a CLI-owned Stratum flow would target the wrong session.

### 3.4 Outcome vocabulary mapping

| Outcome | Meaning |
|---|---|
| `approve` | Accept artifact, advance phase |
| `revise` | Reject with feedback, redo phase |
| `kill` | Terminate feature at this gate |

### 3.5 Child-flow gate protocol

Child flows (e.g., `artifact-review`, `review-check`) may hit `await_gate` within `executeChildFlow()`. The gate delegation protocol is identical to the main loop with these differences:

- **`flowId`:** The `flowId` field in the POST payload is set to the child flow's `childFlowId` value (not the parent's `flowId`). The API field name is still `flowId` — only the value changes. This ensures unique composite keys per child flow.
- **`round`:** From the child flow step's retry count (same source as main flow).
- **`itemId`:** May be `null` if the child flow has no direct item mapping. The gate is functional without it.
- **`fromPhase` / `toPhase`:** Derived the same way (from item lifecycle and `response.on_approve`). May be `null` for child flows without feature context.
- **`summary`:** Falls back to `"Gate: ${stepId}"` when `featureCode` is unavailable.
- **Polling and resolution:** Identical to the main loop — same failure counting, same fatal error on `expired`/404, same readline fallback on server loss.

**Canonical enum (per STRAT-COMP-4):** The outcome enum is `approve | revise | kill` across all systems — CLI readline, web UI, VisionWriter, VisionStore, and Stratum. Legacy past-tense values (`approved`, `revised`, `killed`) must be migrated to imperative form. `VisionWriter.resolveGate()` normalizes any legacy past-tense inputs to imperative before storing: `approved→approve`, `revised→revise`, `killed→kill`. The web UI buttons send `approve`, `revise`, `kill` directly. No translation layer is needed between Vision Store and Stratum — both use the same values.

---

## 4. UX Requirements

### 4.1 What exists today

`GateView.jsx` already implements the core UI structure: pending gates section, resolved-today section, Approve/Revise/Kill buttons, artifact assessment display, and phase transition labels using `LIFECYCLE_PHASE_LABELS`. This component is well-structured and does not need a rewrite.

**StratumPanel.jsx gate display:** `StratumPanel.jsx` currently reads Stratum's own gate list via `GET /api/stratum/gates`. After this feature, `GateView.jsx` is the canonical gate surface. `StratumPanel.jsx` should stop displaying its own gate list and instead link to or embed GateView for gate interactions. This avoids two competing gate UIs. The specific change: remove the gate list rendering from `StratumPanel.jsx` and replace it with a "View gates in sidebar" text link. Since `StratumPanel` is mounted from `App.jsx` (not under `VisionTracker`), the link writes `sessionStorage.setItem('vision-activeView', 'gates')` and dispatches a `window.dispatchEvent(new Event('vision-view-change'))` custom event. `VisionTracker` adds an event listener for `vision-view-change` that reads the new value from `sessionStorage` and calls `setActiveView()`. This cross-panel communication avoids prop threading through unrelated component trees.

### 4.2 Required additions to GateView

**a. Contextual summary** — Add a `summary` display in `PendingGateRow` between the phase transition line and the artifact assessment.

**b. Artifact link** — When `gate.artifact` is a project-relative path, show it as a clickable link that opens the file in the canvas via `POST /api/canvas/open`.

**c. Grouping by feature** — Pending gates are always grouped by `itemId` via `useMemo`. When there are multiple groups (i.e., gates from different features), each group renders under a feature header showing the item title. When all pending gates belong to a single group, the feature header is still shown if `itemId` is present (providing context), but omitted only if there is exactly one gate and it has no `itemId` (ungrouped child flow gate). Gates without `itemId` are collected under an "Other" group. **Stale itemId fallback:** If a gate has `itemId` but the corresponding item no longer exists in the vision state (deleted or from a previous session), the feature header renders the `itemId` as a truncated ID string (e.g., `"Item abc1234…"`) instead of a title. The gate remains fully functional — grouping, action buttons, and resolution all work regardless of whether the item exists.

**d. Gate history** — Expand resolved section to show all resolved gates (not just today), collapsed by default with a count badge. The existing `visionState` WebSocket broadcast already includes all gates (pending + resolved) via `VisionStore.getState()` (line 77). `useVisionStore` passes the full `gates` array to `GateView` as props. GateView already has access to resolved gates — it just needs to render them. No additional REST fetching or state management is needed. The `?status=all` and `?status=resolved` query params on `GET /api/vision/gates` are still added for API completeness (useful for direct API consumers, debugging, and future features), but GateView does not use them — it reads from the `gates` prop (which already includes all gates from the `visionState` WebSocket broadcast).

**e. Build-gate prominence** — Pending gates from an active build (have `flowId`) get larger action buttons (`h-8 text-xs`) and a subtle amber left border to signal urgency.

---

## 5. Unifying the Two Gate Systems

### Current duplication

| Concern | CLI system | Server system |
|---|---|---|
| Gate record storage | `vision-state.json` (file) | `VisionStore.gates` (in-memory) |
| Gate creation | `VisionWriter.createGate()` | No REST endpoint (gap) |
| Gate resolution | `VisionWriter.resolveGate()` | `POST /api/vision/gates/:id/resolve` |
| Stratum notification | `stratum.gateResolve()` in `build.js` | Missing (gap) |
| UI | None (readline) | `GateView.jsx` |

### Target state

| Concern | Unified |
|---|---|
| Gate record storage | `VisionStore` (in-memory + `_save()` to file) |
| Gate creation | `POST /api/vision/gates` when server running; `VisionWriter.createGate()` when not. STRAT-COMP-4 provides the initial route scaffold; STRAT-COMP-6 is the canonical definition. `itemId` is optional (child flows may not have a direct item mapping). |
| Gate resolution | `POST /api/vision/gates/:id/resolve` (server) or `VisionWriter.resolveGate()` (CLI fallback) |
| Stratum notification | Always `stratum.gateResolve()` in CLI, after polling resolution |
| UI | `GateView.jsx` (sidebar) |

---

## 6. Acceptance Criteria

### Gate delegation
- [ ] CLI probes `GET /api/health` at gate time (not cached from build start). Timeout: 500ms.
- [ ] When server is running: CLI calls `POST /api/vision/gates` with full gate payload.
- [ ] Server creates gate in `VisionStore` with deterministic composite key `flowId:stepId:round`, status `pending`, `createdAt`.
- [ ] On successful server-path gate creation, no duplicate gate record exists in `vision-state.json` (CLI does not also write locally). Single authoritative record in VisionStore only.
- [ ] Resolved gates have `status: 'resolved'` and `outcome` set to one of `approve | revise | kill` (per STRAT-COMP-4 gate status contract).
- [ ] Server broadcasts `gateCreated` WebSocket message on creation. Note: STRAT-COMP-8 must listen for `gateCreated` (not `gatePending`).
- [ ] CLI polls `GET /api/vision/gates/:gateId` every 2s until `status === 'resolved'`. Falls back to readline after 3 consecutive network/5xx failures (counter reset on success). Exits with fatal error on 404 (gate record lost — unrecoverable in single-authority model).
- [ ] If polling returns `status === 'expired'`, CLI exits with fatal error. `expired` is a terminal status — cannot transition to `resolved`. Does not fall back to readline.
- [ ] CLI calls `stratum.gateResolve(flowId, stepId, outcome, comment, 'human')` after polling resolves.
- [ ] Build continues correctly after web-resolved gate.
- [ ] When server is unreachable: CLI falls through to `VisionWriter.createGate()` + `promptGate()`.
- [ ] Non-interactive mode (no TTY): if server is running, gate is delegated to web UI (polling continues). If server is also unreachable, build exits with error (exit code 1).
- [ ] When server probe succeeds but `POST /api/vision/gates` fails: build exits with error (exit code 1). No readline fallback, no local gate record. Fatal per STRAT-COMP-4 single-authority rule — once server-running path is selected, all REST failures are fatal.
- [ ] Non-interactive mode: server lost during polling triggers build exit with error (not silent readline fallback).
- [ ] `lib/new.js` main-loop gate block (line 184) and child-flow gate block (line 346) updated with the same probe/branch/poll pattern as `build.js`. The gate delegation protocol is identical — `compose new` uses the same `pollGateResolution()`, `GATE_ARTIFACTS` map, and fallback rules. Payload derivation: `flowId`/`stepId`/`round` from Stratum dispatch, `itemId` from `visionWriter.findFeatureItem()`, enrichment fields derived the same way as in `build.js`.
- [ ] Child-flow gates (`executeChildFlow()`) follow the same probe/branch/poll pattern as the main loop.
- [ ] Child-flow gates use `childFlowId` (not the parent `flowId`) in the gate ID, producing unique composite keys per child flow.
- [ ] Child-flow gates work with `itemId: null` when no direct item mapping exists.
- [ ] After readline fallback (server loss during polling), CLI attempts to resolve the server-side gate via `POST /api/vision/gates/:id/resolve` (REST only, no local file write for server-created gates). If the REST call fails (server still down), the gate remains pending on the server (known stale state; can be manually resolved via web UI on next server start).

### Server endpoint additions
- [ ] `POST /api/vision/gates` endpoint added to `server/vision-routes.js`.
- [ ] Endpoint validates required fields: `flowId`, `stepId`. Returns 400 if missing or not strings. `round` defaults to `1` if absent; returns 400 if present but not a positive integer (prevents ID collisions from invalid retry metadata).
- [ ] Gate deduplication: if pending gate for `(flowId, stepId, round)` exists, return existing gate (200, not 201). Dedup key is the full composite ID `flowId:stepId:round`.
- [ ] `POST /api/vision/gates` response (201) includes full gate object with at minimum: `id`, `flowId`, `stepId`, `status`, `createdAt`.
- [ ] `GET /api/vision/gates/:id` returns the full gate object (per STRAT-COMP-4): `{ id, flowId, stepId, round, itemId?, artifact?, summary?, fromPhase?, toPhase?, status, outcome?, comment?, createdAt, resolvedAt? }`. Returns 404 if gate does not exist. The CLI polling loop consumes `status`, `outcome`, and `comment`; the UI consumes all fields for rendering.
- [ ] `POST /api/vision/gates/:id/resolve` does NOT call `stratum.gateResolve()`.
- [ ] `POST /api/vision/gates/:id/resolve` MUST NOT advance lifecycle or mutate item status (per STRAT-COMP-4 ownership rule). It only updates gate `status` to `resolved` and stores `outcome`/`comment`. All lifecycle/status mutations happen on the CLI side after polling detects resolution. Existing lifecycle advance code in the resolve handler must be removed or guarded behind a flag that is off for CLI-delegated gates.
- [ ] `POST /api/vision/gates/:id/resolve` on an already-resolved gate returns 200 with the existing gate (no-op, idempotent). Does not overwrite the previous resolution. This enables safe double-resolution in race conditions.
- [ ] `POST /api/vision/gates/:id/resolve` accepts imperative outcomes (`approve`, `revise`, `kill`). Legacy past-tense values (`approved`, `revised`, `killed`) are normalized to imperative at the resolve handler before storing.
- [ ] All stored gate outcomes use the canonical enum `approve | revise | kill`. (Prerequisite: STRAT-COMP-4 normalizes legacy values on load in `VisionStore.loadFromFile()`. STRAT-COMP-6 verifies this works but does not own the implementation.)
- [ ] `visionMessageHandler.js` updated to listen for `gateCreated` instead of `gatePending`.
- [ ] `GET /api/vision/gates` accepts `?status` query param: `pending` (default), `resolved` (resolved only), `all` (both). This is the canonical query contract per STRAT-COMP-4. Existing `?itemId` filtering continues to work and composes with `?status` (e.g., `?status=all&itemId=X` returns all gates for item X).
- [ ] `VisionStore` exposes `getAllGates()` method.
- [ ] Gate IDs containing `:` are URL-encoded in all REST paths (`encodeURIComponent(gateId)`).

### Resilience
- [ ] When enrichment data is unavailable (e.g., `findFeatureItem` returns null), gate creation succeeds with null enrichment fields. UI degrades gracefully.
- [ ] Stale gate expiration (per STRAT-COMP-4): gates older than `COMPOSE_GATE_TIMEOUT` (default 30 min) with `status: 'pending'` are marked `status: 'expired'` by the server on next access or periodic cleanup. Expired gates are filtered out of the active review queue in the UI. (Prerequisite: STRAT-COMP-4 owns the `expireStaleGates()` implementation. STRAT-COMP-6 verifies the CLI correctly handles `expired` status during polling.)
- [ ] Gates created via `POST /api/vision/gates` are persisted to disk via `VisionStore._save()` and survive server restarts. After restart, `GET /api/vision/gates` returns previously created gates.

### UX
- [ ] Pending gates from active CLI build appear in `GateView.jsx` within one poll cycle (2s).
- [ ] `summary` field renders in `PendingGateRow` when present.
- [ ] Gate history section renders resolved gates from the existing `gates` prop. The `visionState` WebSocket broadcast includes all gates (pending + resolved) via `VisionStore.getState()` on every state change and on initial connection. Resolved gates are visible immediately on first load without waiting for a subsequent broadcast.
- [ ] "View gates in sidebar" link in `StratumPanel.jsx` switches the Vision sidebar to the gates view via `window.dispatchEvent(new Event('vision-view-change'))` and `sessionStorage`.
- [ ] Artifact path renders as a canvas-opening link.
- [ ] Multiple pending gates for same `itemId` render under shared feature header. Single-group gates with `itemId` show feature header. Gates without `itemId` appear under "Other" group. Gates with `itemId` referencing a deleted/missing item render with truncated ID fallback header.
- [ ] Build gates (have `flowId`) have visually prominent action buttons.
- [ ] Phase transition labels use `LIFECYCLE_PHASE_LABELS` lookup with title-case fallback for unknown step IDs (e.g., `"some_step"` renders as `"Some Step"`).
- [ ] Gate history shows all resolved gates, collapsed by default with count.
- [ ] `StratumPanel.jsx` gate section replaced with link to GateView (avoids competing gate UIs).
- [ ] Gates with null enrichment fields (`fromPhase`, `toPhase`, `artifact` all null) render in GateView without errors. Phase transition shows "Unknown" placeholders. No artifact link. `summary` is always present (CLI guarantees a fallback value). Action buttons still work.

---

## 7. Files Changed

| File | Status | Owner | Change |
|---|---|---|---|
| `lib/server-probe.js` | new | STRAT-COMP-4 prerequisite; built inline by STRAT-COMP-6 if missing | `probeServer(port, timeoutMs)` health check utility |
| `server/vision-store.js` | existing | `getGateByFlowStep()` is a STRAT-COMP-4 prerequisite (updated to accept round); `getAllGates()` is STRAT-COMP-6 | Add `getGateByFlowStep(flowId, stepId, round)` for dedup using composite key `flowId:stepId:round`; add `getAllGates()` |
| `server/vision-routes.js` | existing | STRAT-COMP-6 | Add `POST /api/vision/gates` creation endpoint; add `?status=all` to GET |
| `lib/vision-writer.js` | existing | `createGate()` extras + `getGate()` are STRAT-COMP-6; async dual dispatch is STRAT-COMP-4 prerequisite | Extend `createGate()` with extras, add `getGate()`, add outcome normalization in `resolveGate()`, extend `resolveGate(gateId, outcome, comment)` to accept and persist comment |
| `lib/build.js` | existing | STRAT-COMP-6 | Replace `await_gate` blocks: probe server, branch to REST or readline; extract `makeAskAgent()` |
| `lib/new.js` | existing | STRAT-COMP-6 | Same `await_gate` probe/branch/poll pattern as `build.js` — both main loop (line 184) and child flow (line 346) gate blocks |
| `lib/gate-delegate.js` | — | — | NOT created; delegation logic inlined in `lib/build.js` per blueprint AD-1 |
| `src/components/vision/GateView.jsx` | existing | STRAT-COMP-6 | Summary, artifact link, feature grouping, history, build-gate prominence |
| `src/components/vision/visionMessageHandler.js` | existing | STRAT-COMP-6 | Update `gatePending` handler to `gateCreated`; URL-encode gate IDs in any REST calls |
| `src/components/vision/useVisionStore.js` | existing | STRAT-COMP-6 | URL-encode gate IDs in REST paths; align with `gateCreated` event name |
| `src/components/vision/GateView.jsx` (outcome migration) | existing | STRAT-COMP-6 | Migrate `onResolve` calls from past-tense (`approved`, `revised`, `killed`) to imperative (`approve`, `revise`, `kill`). Update `outcomeColors` map keys in `ResolvedGateRow`. |
| `src/components/vision/ItemDetailPanel.jsx` | existing | STRAT-COMP-6 | Migrate `onResolveGate` calls from past-tense to imperative. Update `outcomeColors` map keys. |
| `server/vision-routes.js` (outcome migration) | existing | STRAT-COMP-6 | Update resolve handler outcome checks (`approved` -> `approve`, `killed` -> `kill`). Remove/guard lifecycle advance code in resolve handler (per STRAT-COMP-4 ownership rule). Add idempotent re-resolve (200 no-op for already-resolved gates). |
| `server/vision-store.js` (additional) | existing | STRAT-COMP-4 prerequisite (built inline if missing) | Add `expireStaleGates(timeoutMs)` method. Add legacy outcome normalization on load (`loadFromFile()` maps past-tense to imperative). |
| `src/components/vision/VisionTracker.jsx` | existing | STRAT-COMP-6 | Add `vision-view-change` event listener to update `activeView` state from `sessionStorage` |
| `src/components/StratumPanel.jsx` | existing | STRAT-COMP-6 | Remove duplicate gate display; link to GateView instead |

---

## 8. Companion Doc Sync

The blueprint (`blueprint.md`) and implementation plan (`plan.md`) were written before the design review cycle and contain older contracts (gate IDs without `round`, past-tense outcomes, different grouping behavior). **This design doc is the authoritative source of truth.** The blueprint and plan must be updated to align with this design before implementation begins. Key deltas: gate ID format `flowId:stepId:round`, canonical outcome enum `approve|revise|kill`, prop-driven GateView history, `expired` gate status, non-interactive mode handling, `GATE_STEP_LABELS` map.

---

## 9. Open Questions

1. ~~**Gate expiration edge cases.**~~ **RESOLVED:** The `COMPOSE_GATE_TIMEOUT`-based expiration (default 30 min) is the v1 contract. Gates from stalled-but-running builds will be expired after the timeout, which may require the user to re-run the build. More sophisticated cleanup (cross-referencing `active-build.json`) is explicitly out of scope (see Non-Goals §2). The 30-minute default is long enough for human review but short enough to avoid indefinite stale gates. Users can increase it via `COMPOSE_GATE_TIMEOUT` env var if their review cycles are longer.

