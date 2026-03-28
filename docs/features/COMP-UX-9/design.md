# COMP-UX-9: Iteration Progress Strip

**Status:** DESIGN
**Date:** 2026-03-28

## Related Documents

- [COMP-UX-2 design](../COMP-UX-2/design.md) — Tier 2 roadmap entry
- [idea_tiered_evaluation](../../../.claude/projects/-Users-ruze-reg-my-forge/memory/idea_tiered_evaluation.md) — Inspiration

---

## Problem

During Phase 7 execution, Compose runs review loops (max 4 iterations) and coverage sweeps (max 15 iterations). These are the longest-running parts of a build — often minutes per iteration. But the UI shows nothing about iteration progress. The operator sees "executing" in PipelineView and has no idea whether it's iteration 1/4 or 3/4, or whether the loop hit its exit criteria.

Iteration data already exists on the server (`item.lifecycle.iterationState`) and is broadcast via WebSocket (`iterationStarted`, `iterationUpdate`, `iterationComplete`), but useVisionStore only logs it to the FIFO `agentActivity[]` array (max 20 entries) where it rotates out and disappears.

## Goal

Surface iteration progress in two places:
1. **OpsStrip** — persistent bottom bar shows "Review 2/4" or "Coverage 3/15" alongside builds and gates
2. **Dashboard** — iteration card when a loop is active

---

## Decision 1: Add iterationStates (Map) to useVisionStore

Add a dedicated `iterationStates` Map keyed by `loopId` — supports concurrent loops across multiple features/agents:

```javascript
iterationStates: Map<loopId, {
  loopId: string,
  itemId: string,
  loopType: 'review' | 'coverage',
  count: number,
  maxIterations: number,
  status: 'running' | 'complete',
  outcome: null | 'clean' | 'max_reached' | 'aborted',
  startedAt: ISO8601,
}>
```

Updated by visionMessageHandler:
- `iterationStarted` → set entry in Map
- `iterationUpdate` → update count for loopId
- `iterationComplete` → set status/outcome, remove entry after 5s (per-loopId timer ref, cancels stale timers)

## Decision 2: OpsStrip Integration

Add an `iteration` entry type to `opsStripLogic.js`:

```javascript
{
  key: `iter-${loopId}`,
  type: 'iteration',
  label: `${loopType} ${count}/${maxIterations}`,
}
```

Visual: blue background (distinct from green build, amber gate, red error). Shows while iteration is running. Flashes green on `outcome: 'clean'`, red on `outcome: 'max_reached'`, then fades.

## Decision 3: Dashboard Iteration Card

When `iterationState` is active, show a compact card in the Dashboard between the phase timeline and pending gates:

```
┌─────────────────────────────────────────────┐
│ ↻ Review Loop                    2 of 4     │
│ ████████░░░░░░░░░░░░  50%                   │
│ Waiting for clean review...                  │
└─────────────────────────────────────────────┘
```

- Progress bar (count/maxIterations)
- Loop type label
- Status message: "Waiting for clean review..." / "Waiting for tests passing..." / "Clean!" / "Max iterations reached"

## Decision 4: OpsStrip Rendering

The OpsStrip component (`OpsStrip.jsx`) renders entries from `deriveEntries()`. Add iteration entry rendering with:
- Blue pill background (`bg-blue-500/20 text-blue-400`)
- Spinner icon for running, checkmark for clean, X for max_reached
- Same enter/steady/flash/exit animation as other entry types

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/components/vision/useVisionStore.js` | modify | Add `iterationState` field |
| `src/components/vision/visionMessageHandler.js` | modify | Populate iterationState from messages |
| `src/components/cockpit/opsStripLogic.js` | modify | Add iteration entry type |
| `src/components/cockpit/OpsStrip.jsx` | modify | Render iteration entries |
| `src/components/vision/DashboardView.jsx` | modify | Add iteration progress card |

## Acceptance Criteria

- [ ] `iterationState` in useVisionStore updated by iteration messages
- [ ] OpsStrip shows iteration progress (type + count/max) during loops
- [ ] OpsStrip iteration entry flashes green on clean, red on max_reached
- [ ] Dashboard shows iteration card with progress bar when loop is active
- [ ] Iteration card clears shortly after loop completes
- [ ] No iteration UI when no loop is running (clean state)
