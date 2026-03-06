# Policy Enforcement Runtime: Design

**Status:** DESIGN
**Date:** 2026-03-06
**Roadmap item:** 23 (Phase 6)

## Related Documents

- [Lifecycle Engine Roadmap](../../plans/2026-02-15-lifecycle-engine-roadmap.md) — Layer 3 context
- [Lifecycle State Machine Design](../lifecycle-state-machine/design.md) — Layer 1 (dependency)
- [Artifact Awareness Design](../artifact-awareness/design.md) — Layer 2 (dependency)
- [Compose Skill](../../../.claude/skills/compose/SKILL.md) — gate protocol spec

---

## Problem

The lifecycle state machine (item 21) enforces valid transitions — you can't jump from `explore_design` to `execute`. The artifact awareness system (item 22) can tell you if an artifact is structurally complete. But neither blocks an agent from advancing past a gate that should require human approval. The compose skill says "Agent proposes, human decides" for gate mode, but this is prose — an agent can rationalize past it.

Current gaps:

1. **No structural blocking** — `advancePhase()` succeeds immediately if the transition is valid. There's no concept of "this transition requires approval before completing."
2. **No policy configuration** — every transition is treated the same. No way to say "design gates require approval, but report flags are fine."
3. **No gate record** — when a human approves a transition during a compose session, that approval is invisible to the system. It lives only in chat history.
4. **No audit trail** — no record of which transitions were gated, flagged, or skipped, or what the rationale was.

## Goal

Make phase transitions **policy-aware**. The system evaluates a policy before each transition, and depending on the mode (gate/flag/skip), either blocks, logs, or silently proceeds. This is the enforcement substrate — the actual blocking and UI rendering of gates is item 24.

Scope: server-side policy evaluation, gate lifecycle (create/approve/reject), and MCP/REST surface. No UI.

---

## Decision 1: Policy Modes

Three modes per transition, matching the compose skill's gate protocol:

- **Gate** — transition is blocked. A pending gate is created. The transition completes only when the gate is explicitly approved. The caller receives `{ status: 'pending_approval', gateId }` instead of the transition result.
- **Flag** — transition proceeds immediately, but a flag record is created and a broadcast notification is sent. The caller receives the normal transition result plus `{ flagged: true, flagId }`.
- **Skip** — transition proceeds immediately with no notification. A skip record is created in the audit trail. The caller receives the normal transition result.

---

## Decision 2: Policy Defaults

Until the user preferences system (item 20) lands, policies are hardcoded defaults. These map to the compose skill's expectations:

```js
// explore_design is omitted — it's the entry phase, never a transition target.
// Policy applies to the phase being *entered*, not the phase being *left*.
const DEFAULT_POLICIES = {
  prd:            'skip',     // Often skipped entirely for internal features
  architecture:   'skip',     // Often skipped for single-component features
  blueprint:      'gate',     // Blueprint must be approved before implementation
  verification:   'gate',     // Verification results need human eyes
  plan:           'gate',     // Implementation plan needs approval
  execute:        'flag',     // Agent executes, human is notified
  report:         'skip',     // Report is informational
  docs:           'flag',     // Docs update flagged for review
  ship:           'gate',     // Final gate before marking complete
};
```

The key maps **target phase** to policy mode. When advancing from `explore_design` to `blueprint`, the policy for `blueprint` applies (you're gating entry to blueprint).

**Phase-level overrides** are supported — a feature's lifecycle can carry a `policyOverrides` map that overrides defaults for specific phases. This supports the compose skill's `--through` semantics (when `--through design` is active, phases after design use hardcoded gate mode since the skill stops there).

---

## Decision 3: Gate Lifecycle

A gate is a first-class object with its own lifecycle:

```js
{
  id: 'gate-<uuid>',
  itemId: '<vision-item-id>',
  operation: 'advance',         // 'advance' | 'skip' — original operation type
  operationArgs: {              // original parameters for replay on approval
    targetPhase: 'blueprint',
    outcome: 'approved',        // for advance
    // reason: '...',           // for skip
  },
  fromPhase: 'explore_design',
  toPhase: 'blueprint',
  status: 'pending',           // pending | approved | revised | killed
  createdAt: '2026-03-06T...',
  resolvedAt: null,
  resolvedBy: null,             // 'human' | 'system' (for future auto-approval)
  outcome: null,                // same as status when resolved
  comment: null,                // optional human feedback
  artifactAssessment: { ... },  // snapshot of artifact quality at gate time
}
```

**Gate resolution outcomes:**
- **Approved** — the blocked transition completes. `advancePhase()` is called with the original parameters.
- **Revised** — the gate is closed without advancing. The feature stays in its current phase. Agent is expected to revise and re-request.
- **Killed** — the gate is closed and `killFeature()` is called. Feature is abandoned.

---

## Decision 4: Where Gates Live

Gates are stored on the VisionStore as a separate collection, not nested inside lifecycle objects. Rationale:

1. **Cross-feature queryability** — item 24 (Gate UI) needs a gate queue across all features
2. **Gate persistence** — gates survive lifecycle changes (a resolved gate is historical record)
3. **Separation of concerns** — lifecycle tracks phase state, gates track approval state

VisionStore additions:
```
store.gates       — Map<gateId, Gate>
store.createGate(gate)
store.resolveGate(gateId, { outcome, comment })
store.getPendingGates()
store.getGatesForItem(itemId)
```

The lifecycle object gets one reference field: `pendingGate: gateId | null`. This lets the lifecycle manager quickly check "is there a gate blocking this feature?" without querying the gate store.

### Persistence & Migration

Gates are stored in `vision-state.json` alongside `items` and `connections`:

```json
{
  "items": [...],
  "connections": [...],
  "gates": [...]
}
```

**Backward compatibility:** When loading a state file that has no `gates` key, VisionStore initializes `this.gates` to an empty Map. No migration step needed — the absence of the key is the empty state. Same pattern as how `connections` was originally added to the store. The `_save()` method always writes the `gates` array, so after the first save the key exists.

---

## Decision 5: Integration with Lifecycle Manager

The policy check happens **inside** both `advancePhase()` and `skipPhase()`, not in the route handler. This ensures all callers (REST, MCP, direct) and all transition paths are subject to policy. A skip into a gated phase is blocked the same way an advance into a gated phase is.

Modified `advancePhase` flow:

```
advancePhase(itemId, targetPhase, outcome)
  1. Validate transition (existing)
  2. Evaluate policy for targetPhase
  3. If policy === 'gate':
     - Create gate object via store
     - Set lifecycle.pendingGate = gateId
     - Return { status: 'pending_approval', gateId, fromPhase, toPhase }
  4. If policy === 'flag':
     - Create flag record (lightweight — no blocking)
     - Proceed with transition (existing)
     - Return { ...transitionResult, flagged: true, flagId }
  5. If policy === 'skip':
     - Record skip in audit trail
     - Proceed with transition (existing)
     - Return transitionResult
```

New method: `approveGate(gateId, { outcome, comment })`:
```
approveGate(gateId, { outcome, comment })
  1. Look up gate, validate status === 'pending'
  2. If outcome === 'approved':
     - Replay original operation with policy bypass:
       - If gate.operation === 'advance': call advancePhase(gate.itemId, gate.operationArgs.targetPhase, gate.operationArgs.outcome)
       - If gate.operation === 'skip': call skipPhase(gate.itemId, gate.operationArgs.targetPhase, gate.operationArgs.reason)
     - Resolve gate
  3. If outcome === 'revised':
     - Resolve gate, clear lifecycle.pendingGate
     - Feature stays in current phase
  4. If outcome === 'killed':
     - Call killFeature(gate.itemId, comment)
     - Resolve gate
```

**Policy bypass:** When `approveGate` replays the original operation after approval, the replay must not re-evaluate policy (infinite loop). Add an internal `_bypassPolicy` flag or use a separate `_executeTransition` / `_executeSkip` private method that skips policy evaluation.

---

## Decision 6: Artifact Assessment at Gates

When a gate is created, the system snapshots the current artifact assessment for the phase being entered. This gives the gate approver (human or future auto-approver) context about artifact quality without requiring a separate call.

```js
gate.artifactAssessment = artifactManager.assessOne(featureCode, PHASE_ARTIFACTS[fromPhase]);
```

This uses the `fromPhase` artifact (e.g., when gating entry to `blueprint`, assess `design.md` — the artifact that should be complete before advancing). If the from-phase has no artifact (e.g., `verification` → `plan`), the assessment is null.

---

## Decision 7: Audit Trail

Every policy evaluation is recorded, regardless of mode:

```js
{
  type: 'gate' | 'flag' | 'skip',
  id: '<uuid>',
  itemId: '<item-id>',
  fromPhase: 'explore_design',
  toPhase: 'blueprint',
  createdAt: '2026-03-06T...',
  // For gates: resolvedAt, outcome, comment
  // For flags: rationale (auto-generated)
  // For skips: reason (auto-generated)
}
```

Stored on the lifecycle object as `lifecycle.policyLog: PolicyEntry[]`. This is an append-only array — entries are never removed. This gives item 24 (Gate UI) a complete history of policy decisions per feature.

---

## Decision 8: MCP Tools

Two new tools:

- `approve_gate({ gateId, outcome, comment })` — resolve a pending gate (approve/revise/kill)
- `get_pending_gates({ itemId? })` — list pending gates, optionally filtered by item

These are mutation tools, so they delegate to REST endpoints (same pattern as lifecycle tools).

---

## Decision 9: REST Endpoints

```
GET  /api/vision/gates              — all pending gates (gate queue)
GET  /api/vision/gates/:id          — single gate detail
POST /api/vision/gates/:id/resolve  — approve, revise, or kill
```

Both `POST /api/vision/items/:id/lifecycle/advance` and `POST /api/vision/items/:id/lifecycle/skip` get the same policy-aware response shapes:

- If policy is gate: returns `{ status: 'pending_approval', gateId, fromPhase, toPhase, operation }` (HTTP 202)
- If policy is flag: returns `{ ...transitionResult, flagged: true, flagId }` (HTTP 200)
- If policy is skip (or no policy for target): returns `{ ...transitionResult }` (HTTP 200, unchanged)

---

## Decision 10: What This Does NOT Do

- **No UI** — gate rendering is item 24
- **No auto-approval** — future concern; all gates require explicit resolution
- **No policy config UI** — hardcoded defaults until item 20 (preferences) lands
- **No cross-feature policy inheritance** — initiative → feature cascading is future scope
- **No artifact quality thresholds** — policy doesn't auto-gate based on completeness < 1.0 (that's a future policy rule, not core infrastructure)

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `server/policy-engine.js` | **Create** | Policy evaluation, defaults, override resolution |
| `server/lifecycle-manager.js` | **Edit** | Inject policy evaluation into advancePhase, add approveGate |
| `server/vision-store.js` | **Edit** | Add gates collection, createGate, resolveGate, getPendingGates |
| `server/vision-routes.js` | **Edit** | Add gate endpoints, modify advance response shape |
| `server/compose-mcp-tools.js` | **Edit** | Add approve_gate, get_pending_gates tools |
| `server/compose-mcp.js` | **Edit** | Add tool definitions + switch cases |
| `test/policy-engine.test.js` | **Create** | Policy evaluation tests |
| `test/lifecycle-manager.test.js` | **Edit** | Add gate lifecycle tests |
| `test/lifecycle-routes.test.js` | **Edit** | Add gate endpoint tests |
