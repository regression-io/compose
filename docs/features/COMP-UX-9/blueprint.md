# COMP-UX-9: Iteration Progress Strip — Implementation Blueprint

**Date:** 2026-03-28

## Related Documents

- [Design](design.md)

---

## Corrections Table

| Design Assumption | Reality | Impact |
|---|---|---|
| Need to add setIterationState callback | Store uses `set()` directly in message handler via setter callbacks pattern (lines 139-151 of useVisionStore) | Follow the existing `setAgentActivity` pattern — add `setIterationState` setter |
| OpsStrip receives iterationStates as prop | OpsStrip reads from useVisionStore directly (line 15-17) | Add `iterationStates` to OpsStrip's store selector — no prop threading needed |
| Dashboard needs iterationStates threaded from App | Dashboard already receives `agentActivity` but not `iterationStates` | Need to add `iterationStates` to CockpitView props and Dashboard case |
| deriveEntries is pure function | Confirmed — takes `{ activeBuild, gates, recentErrors }`, returns entries array | Add `iterationStates` parameter |
| Singleton iterationStates is NOT sufficient | Server stores iteration state per item (`item.lifecycle.iterationStates`). Multiple features can have concurrent loops (parallel agents, multiple builds). | Use a Map keyed by loopId: `iterationStatess: new Map()`. OpsStrip and Dashboard iterate over all active entries. |
| setTimeout for clearing is safe | Bare setTimeout can be raced by a new loop starting before the timer fires | Use a dedicated timer ref (`iterClearTimerRef`) and cancel stale timers — follow `changeTimerRef`/`sessionEndTimerRef` pattern |

---

## Task Breakdown

### Task 1: Add iterationStatess (Map) to useVisionStore

**File:** `src/components/vision/useVisionStore.js` (existing)

1. **Line ~237 (initial state):** Add `iterationStatess: new Map(),` alongside `agentActivity`, `agentErrors`
2. **Lines ~139-151 (setter callbacks):** Add:
   ```javascript
   setIterationStates: (updater) => set(s => ({ iterationStatess: typeof updater === 'function' ? updater(s.iterationStatess) : updater })),
   ```
3. **Selector in App.jsx (lines ~139-151):** Add `iterationStatess: s.iterationStatess` to the useShallow selector

### Task 2: Populate iterationStatess from messages

**File:** `src/components/vision/visionMessageHandler.js` (existing)

The iteration handler block is at lines 166-197. It receives `setAgentActivity`, `setAgentErrors`, `setSessionState` as callback params from the store.

1. Add `setIterationStates` to the destructured params
2. Declare a `iterClearTimers` Map (or object) in the module/closure scope to track per-loopId clear timers
3. After the existing `setAgentActivity` call in each iteration branch:

   - **iterationStarted (line ~170):**
     ```javascript
     // Cancel any stale clear timer for this loopId
     if (iterClearTimers.has(msg.loopId)) {
       clearTimeout(iterClearTimers.get(msg.loopId));
       iterClearTimers.delete(msg.loopId);
     }
     setIterationStates(prev => {
       const next = new Map(prev);
       next.set(msg.loopId, {
         loopId: msg.loopId, itemId: msg.itemId, loopType: msg.loopType,
         count: 0, maxIterations: msg.maxIterations,
         status: 'running', outcome: null, startedAt: msg.timestamp,
       });
       return next;
     });
     ```

   - **iterationUpdate (line ~174):**
     ```javascript
     setIterationStates(prev => {
       const entry = prev.get(msg.loopId);
       if (!entry) return prev;
       const next = new Map(prev);
       next.set(msg.loopId, { ...entry, count: msg.count, maxIterations: msg.maxIterations });
       return next;
     });
     ```

   - **iterationComplete (line ~172):**
     ```javascript
     setIterationStates(prev => {
       const entry = prev.get(msg.loopId);
       if (!entry) return prev;
       const next = new Map(prev);
       next.set(msg.loopId, { ...entry, status: 'complete', outcome: msg.outcome, count: msg.finalCount ?? entry.count });
       return next;
     });
     // Remove completed entry after 5s, keyed by loopId
     const timer = setTimeout(() => {
       setIterationStates(prev => { const next = new Map(prev); next.delete(msg.loopId); return next; });
       iterClearTimers.delete(msg.loopId);
     }, 5000);
     iterClearTimers.set(msg.loopId, timer);
     ```

### Task 3: Add iteration entry to opsStripLogic.js

**File:** `src/components/cockpit/opsStripLogic.js` (existing)

1. **Line 8 (function signature):** Add `iterationStates` to params:
   ```javascript
   export function deriveEntries({ activeBuild, gates, recentErrors, iterationStates })
   ```

2. **After error entries (line ~65):** Add iteration entries from Map:
   ```javascript
   if (iterationStatess) {
     for (const [loopId, iter] of iterationStatess) {
       if (iter.status === 'running') {
         const typeLabel = iter.loopType === 'review' ? 'review' : 'coverage';
         entries.push({
           key: `iter-${loopId}`,
           type: 'iteration',
           label: `${typeLabel} ${iter.count}/${iter.maxIterations}`,
         });
       }
     }
   }
   ```

### Task 4: Render iteration entries in OpsStrip.jsx

**File:** `src/components/cockpit/OpsStrip.jsx` (existing)

1. **Lines 15-17 (store selector):** Add `iterationStates: s.iterationStates`
2. **Lines 44-47 (deriveEntries call):** Add `iterationStates`:
   ```javascript
   deriveEntries({ activeBuild: effectiveBuild, gates, recentErrors, iterationStates })
   ```
   Add `iterationStates` to the useMemo deps array.
3. **OpsStripEntry rendering:** Find where entry types map to styles. Add `'iteration'` type with blue pill styling (`bg-blue-500/20 text-blue-400 border-blue-500/30`).

### Task 5: Thread iterationStates to DashboardView

**File:** `src/App.jsx` (existing)

1. **Selector (~line 139):** Add `iterationStates: s.iterationStates`
2. **CockpitView function params:** Add `iterationStates`
3. **CockpitView dashboard case (~line 130):** Pass `iterationStates={iterationStates}` to DashboardView

### Task 6: Add iteration card to DashboardView

**File:** `src/components/vision/DashboardView.jsx` (existing)

1. **Props:** Add `iterationStates` to DashboardView props
2. **Between two-column grid and Pending Gates section:** Add iteration progress card (only when `iterationStates` is not null)
3. Card shows: loop type label, count/max, progress bar (blue for running, green for clean, red for max_reached), status message

---

## Verification Checklist

- [ ] `iterationStates` field in useVisionStore initial state
- [ ] `setIterationState` setter callback exposed
- [ ] visionMessageHandler populates iterationStates from iteration messages
- [ ] Stale clear timer cancelled when new loop starts (no race)
- [ ] iterationStates cleared 5s after iterationComplete via timer ref
- [ ] opsStripLogic produces iteration entry when loop is running
- [ ] OpsStrip renders iteration entry with blue styling
- [ ] Dashboard shows iteration card with progress bar
- [ ] Update `test/iteration-client.test.js` for new iterationStates behavior
- [ ] Update `test/ops-strip.test.js` for iteration entry derivation
- [ ] Build passes
