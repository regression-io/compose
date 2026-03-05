# Feature Lifecycle State Machine: Design

**Status:** DESIGN
**Date:** 2026-03-05
**Roadmap item:** 21 (Phase 6)

## Related Documents

- [Lifecycle Engine Roadmap](../../plans/2026-02-15-lifecycle-engine-roadmap.md) — Layer 1 context
- [Compose Skill](../../../.claude/skills/compose/SKILL.md) — the 10-phase lifecycle this formalizes
- [Compose ROADMAP](../../ROADMAP.md) — Phase 6, item 21

---

## Problem

Today, feature phase is **implicit**. The compose skill scans `docs/features/<code>/` at entry and infers which phase to resume based on which files exist. There is no persistent record of:

- What phase a feature is currently in
- When it entered that phase
- How long it spent in each phase
- What completion criteria were met (or skipped)
- Phase transition history

This means:
1. No UI can show "Feature X is in Phase 4: Blueprint" — it's only known inside the skill's prompt
2. No enforcement — the agent can skip phases without any system noticing
3. No cross-session continuity beyond file presence
4. No foundation for policy enforcement (item 23) or gate UI (item 24)

## Goal

Make feature phase **explicit** — a first-class tracked field with event-driven transitions, history, and completion criteria. This is the substrate that policy enforcement (23), gate UI (24), and session binding (25) build on.

---

## Decision 1: Phase Model

The compose skill defines 10 phases. The vision store currently has 6 coarse phases (`vision`, `specification`, `planning`, `implementation`, `verification`, `release`). These are different things:

- **Vision store phases** describe where an item sits in the product pipeline (any item type)
- **Compose skill phases** describe where a *feature build* sits in the dev lifecycle

They don't map 1:1 and shouldn't be merged. The state machine tracks **compose lifecycle phases** on feature items specifically.

### Lifecycle Phases

```
explore_design    → Phase 1: Explore & Design
prd               → Phase 2: PRD (skippable)
architecture      → Phase 3: Architecture (skippable)
blueprint         → Phase 4: Blueprint
verification      → Phase 5: Blueprint Verification
plan              → Phase 6: Implementation Plan
execute           → Phase 7: Execute (TDD + E2E + review + sweep)
report            → Phase 8: Report (skippable)
docs              → Phase 9: Update Docs
ship              → Phase 10: Ship
```

Plus two terminal states: `complete`, `killed`.

### New Fields on Vision Items

Only feature-type items with an active lifecycle get these fields. They're stored in a `lifecycle` object on the item, not as top-level fields, to avoid polluting items that aren't feature builds.

```js
{
  // existing fields...
  lifecycle: {
    currentPhase: 'blueprint',        // current phase ID (or 'complete' | 'killed')
    phaseHistory: [                    // ordered list of transitions
      {
        phase: 'explore_design',
        enteredAt: '2026-03-05T10:00:00Z',
        exitedAt: '2026-03-05T11:30:00Z',
        outcome: 'approved',          // approved | revised | skipped | killed | reconciled
        sessionId: 'abc-123',         // which session did this phase
      },
      {
        phase: 'prd',
        enteredAt: '2026-03-05T11:30:00Z',
        exitedAt: '2026-03-05T11:30:01Z',
        outcome: 'skipped',
        reason: 'Internal feature, no user-facing requirements',
      },
      // ...
    ],
    artifacts: {                      // what files exist for this feature
      'design.md': true,              // Phase 1: Explore & Design
      'prd.md': false,                // Phase 2: PRD
      'architecture.md': false,       // Phase 3: Architecture
      'blueprint.md': true,           // Phase 4: Blueprint
      'plan.md': false,               // Phase 6: Plan
      'report.md': false,             // Phase 8: Report
    },
    // Phases without artifacts (verification, execute, docs, ship) are
    // tracked by phaseHistory alone — they produce side effects, not files.
    startedAt: '2026-03-05T10:00:00Z',
    completedAt: null,                // set by completeFeature()
    killedAt: null,                   // set by killFeature()
    killReason: null,                 // set by killFeature()
  }
}
```

**Note on artifacts map:** Only phases that produce a named file in the feature folder
appear here. Phases 5 (verification), 7 (execute), 9 (docs), and 10 (ship) are process
phases — they modify external files or produce side effects but don't create a canonical
artifact in the feature folder. Their completion is tracked via `phaseHistory` entries.

---

## Decision 2: Where the State Machine Lives

A new `server/lifecycle-manager.js` module. Not a class wrapping Stratum — the state machine is **Compose's own state**, independent of whether Stratum is running. Stratum tracks execution of individual steps within a phase; the lifecycle manager tracks which phase a feature is in.

```
LifecycleManager(store, featureRoot)
  - startLifecycle(itemId, featureCode)        → creates lifecycle object, sets phase to explore_design
  - advancePhase(itemId, targetPhase, outcome) → validates transition, records history, updates currentPhase
  - skipPhase(itemId, targetPhase, reason)     → records skip with reason, advances to targetPhase
  - killFeature(itemId, reason)                → sets currentPhase to killed, records in history, sets killedAt/killReason
  - completeFeature(itemId)                    → sets currentPhase to complete, records in history, sets completedAt
  - getPhase(itemId)                           → returns current phase
  - getHistory(itemId)                         → returns full phase history
  - reconcile(itemId)                          → cross-checks artifacts on disk vs recorded phase
```

### Transition Rules

```
explore_design  → prd | architecture | blueprint | killed
prd             → architecture | blueprint | killed
architecture    → blueprint | killed
blueprint       → verification | killed
verification    → plan | blueprint (revision) | killed
plan            → execute | killed
execute         → report | docs | killed
report          → docs | killed
docs            → ship | killed
ship            → complete
```

Key rules:
- **Forward-only** except verification → blueprint (revision loop)
- **Skipping allowed** — prd, architecture, report can be skipped (with recorded reason)
- **No skipping** — blueprint, verification, execute, docs, ship
- **Killed from any phase** — via `killFeature()`, not `advancePhase()`
- **Complete only from ship** — via `completeFeature()`, not `advancePhase()`

### Terminal Operations

`killFeature(itemId, reason)` and `completeFeature(itemId)` are separate methods, not
transitions through `advancePhase`. This makes terminal semantics explicit:

- **killFeature**: Sets `currentPhase: 'killed'`, `killedAt`, `killReason`. Records a
  history entry with `outcome: 'killed'` on the current phase. Updates vision item
  `status` to `killed`.
- **completeFeature**: Only callable when `currentPhase === 'ship'`. Sets
  `currentPhase: 'complete'`, `completedAt`. Records a history entry with
  `outcome: 'approved'` on `ship`. Updates vision item `status` to `complete`.

### Validation

`advancePhase(itemId, targetPhase, outcome)` checks:
1. `targetPhase` is a valid successor of `currentPhase` per the transition graph
2. `outcome` is valid (`approved` or `revised`)
3. Terminal states (`complete`, `killed`) cannot be transitioned out of

`skipPhase(itemId, targetPhase, reason)` checks:
1. `targetPhase` is a valid successor of `currentPhase`
2. The current phase is skippable (prd, architecture, report)
3. Records outcome as `skipped` with the provided reason

All methods throw on invalid transitions. The caller (compose skill or MCP tool) provides
the explicit `targetPhase` — the state machine validates it but does not choose it.

**Outcome vocabulary:**
- `approved` — phase completed via gate approval (`advancePhase`)
- `revised` — phase re-entered via revision loop (`advancePhase` with backward target)
- `skipped` — phase bypassed with reason (`skipPhase`)
- `killed` — feature terminated (`killFeature`)
- `reconciled` — phase inferred from disk artifacts during reconciliation (`reconcile()` only, never from external callers)

---

## Decision 3: Reconciliation

The skill currently infers phase from files on disk. The state machine should be consistent
with that. Reconciliation runs at lifecycle start and on demand:

1. Scan `docs/features/<code>/` for known artifacts
2. Update `lifecycle.artifacts` to match what's actually on disk
3. Compare inferred phase (from artifact presence) against `lifecycle.currentPhase`
4. Apply directional rules:

**Forward reconciliation (artifacts ahead of state):** If artifacts suggest a later phase
than `currentPhase`, advance to match. For example, if `currentPhase` is `explore_design`
but `blueprint.md` exists, advance to `blueprint`. Intermediate phases are recorded as
`outcome: 'reconciled'` — a history-only outcome written exclusively by `reconcile()` (not `skipped` — we don't know why they were skipped, so we don't
fabricate reasons).

**Backward reconciliation (artifacts behind state):** If artifacts suggest an earlier phase
than `currentPhase` (e.g., `blueprint.md` was deleted while `currentPhase` is `plan`),
**do not move backward**. Instead, flag the inconsistency:

```js
{
  reconcileWarning: {
    currentPhase: 'plan',
    inferredPhase: 'explore_design',
    missingArtifacts: ['blueprint.md'],
    detectedAt: '...',
  }
}
```

The warning is stored on the lifecycle object and surfaced via MCP tools and the API. The
compose skill or human decides what to do — the state machine never auto-regresses.

**Why no auto-regression:** Artifacts can be deleted accidentally, temporarily moved, or
renamed. Auto-regression would destroy valid phase history. The state machine is
forward-only; backward movement requires explicit human or agent action via `advancePhase`
with the revision transition (verification → blueprint).

---

## Decision 4: Integration Points

### Compose Skill

The skill calls `LifecycleManager` at entry and at each gate:

1. **Entry scan**: Call `reconcile(itemId)` to sync disk → state. Read `currentPhase` to determine where to resume.
2. **Phase gate approved**: Call `advancePhase(itemId, targetPhase, 'approved')` to record the transition and advance.
3. **Phase skipped**: Call `skipPhase(itemId, targetPhase, reason)`.
4. **Feature killed**: Call `killFeature(itemId, reason)`.
5. **Feature shipped**: Call `completeFeature(itemId)` from the ship phase.

The skill's existing folder-scan logic remains but becomes a **fallback** — if the lifecycle object doesn't exist (old features, manual work), the skill infers phase as today and optionally bootstraps a lifecycle.

### MCP Tools

Extend `compose-mcp-tools.js` with:

- `get_feature_lifecycle(itemId)` — returns current phase, history, artifacts
- `advance_feature_phase(itemId, targetPhase, outcome, reason?)` — agent-callable phase transition
- `skip_feature_phase(itemId, targetPhase, reason)` — skip a skippable phase
- `kill_feature(itemId, reason)` — kill the feature from any phase
- `complete_feature(itemId)` — mark feature complete (only from ship phase)

These are what the compose skill actually calls during a `/compose` run.

### Vision Routes

Extend `vision-routes.js` with:

- `GET /api/vision/items/:id/lifecycle` — returns lifecycle object
- `POST /api/vision/items/:id/lifecycle/advance` — advance phase `{ targetPhase, outcome }`
- `POST /api/vision/items/:id/lifecycle/skip` — skip phase `{ targetPhase, reason }`
- `POST /api/vision/items/:id/lifecycle/kill` — kill feature `{ reason }`
- `POST /api/vision/items/:id/lifecycle/complete` — complete feature (from ship only)

### WebSocket

Broadcast `lifecycleTransition` events via VisionServer when phase changes:

```js
{
  type: 'lifecycleTransition',
  itemId: '...',
  from: 'explore_design',
  to: 'blueprint',
  outcome: 'approved',
  timestamp: '...',
}
```

The UI can listen for these to update phase indicators in real time.

### Stratum

No direct integration needed at this layer. Stratum tracks step execution within a phase (e.g., the TDD/review/sweep loop in Phase 7). The lifecycle manager tracks which phase the feature is in. They're complementary, not overlapping:

- Stratum: "Step `implement` is on retry 3 of fix_and_review"
- Lifecycle: "Feature FEAT-21 is in phase `execute`"

The existing `stratumFlowId` binding on vision items continues to work. Phase 7's stratum flow is bound to the feature; when the flow completes, the compose skill calls `advancePhase` to move to phase `report`.

---

## Decision 5: Storage

Lifecycle state is stored **on the vision item itself** in the `lifecycle` field. This means:

- No new storage system — uses existing `vision-store.js` persistence
- Lifecycle data is co-located with the item it describes
- Backup/restore of `data/vision-state.json` includes lifecycle state

The `lifecycle` field is optional — items without it are treated as not having an active
lifecycle. The lifecycle manager creates it on `startLifecycle()` and the compose skill
creates it on first `/compose` invocation for a feature.

### Write Protection

The `lifecycle` field is **write-protected from generic PATCH**. The vision store's
`updateItem()` method strips `lifecycle` from incoming patch data. All lifecycle mutations
go through `LifecycleManager` methods, which call a dedicated `updateLifecycle(itemId, lifecycle)`
on the store that bypasses the strip.

This prevents:
- Direct PATCH requests from bypassing transition validation
- Agents or UI code from setting arbitrary phase values
- Accidental overwrites of phase history

The only way to mutate lifecycle state is through the LifecycleManager API or the dedicated
lifecycle REST endpoints, both of which enforce transition rules.

---

## Decision 6: Phase Duration Tracking

Each phase history entry records `enteredAt` and `exitedAt`. This gives:

- Time spent per phase (design took 2 hours, blueprint took 45 minutes)
- Total feature duration (started → completed)
- Session count per phase (via sessionId in history entries)

No aggregation or analysis at this layer — just recording the data. Dashboard/reporting can be built later on top of the history.

---

## What This Enables

With explicit phase state, the next items become straightforward:

- **Item 22 (Artifact awareness)**: `lifecycle.artifacts` already tracks what exists. Extend with templates and quality signals.
- **Item 23 (Policy enforcement)**: Read `currentPhase`, check policy for that transition, block/flag/skip accordingly.
- **Item 24 (Gate UI)**: Display `currentPhase` + proposed next phase in the sidebar. Wire approve/revise/kill to `advancePhase`.
- **Item 25 (Session binding)**: `phaseHistory[].sessionId` already links sessions to phases.

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `server/lifecycle-manager.js` | **Create** | State machine: transitions, validation, reconciliation |
| `server/vision-store.js` | **Edit** | Strip `lifecycle` from generic `updateItem()` patches; add dedicated `updateLifecycle(itemId, lifecycle)` method |
| `server/compose-mcp-tools.js` | **Edit** | Add `get_feature_lifecycle`, `advance_feature_phase` tools |
| `server/vision-routes.js` | **Edit** | Add lifecycle endpoints |
| `server/vision-server.js` | **Edit** | Broadcast lifecycle events |
| `test/lifecycle-manager.test.js` | **Create** | State machine tests |

---

## Resolved Questions

1. **`--through` behavior:** Updates `lifecycle.currentPhase` directly. Falls back to
   writing `status.md` for features without a lifecycle object (backward compat).

2. **Reconciliation direction:** Forward jumps record intermediate phases as
   `outcome: 'reconciled'`. Backward regression is flagged but never auto-applied
   (see Decision 3).
