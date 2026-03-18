# ITEM-24: Gate UI Polish — Design

## Scope

Four focused enhancements to the existing GateView. No new components — all changes in GateView.jsx and ResolvedGateRow.

### 1. policyMode badge on resolved gates

Show how a gate was resolved: `human`, `system (flag)`, `system (skip)`.
Resolved gates already show outcome (approved/revised/killed). Add a second badge for resolvedBy.

### 2. Gate history section (all-time, not just today)

Replace "Resolved Today" with a full chronological history, grouped by feature.
Collapse older gates by default, expand on click.

### 3. Revise feedback visibility

When a gate was previously revised, show the revision comment prominently on the re-created pending gate so the user knows what to fix.

### 4. resolvedBy on resolved gate rows

Show who resolved it (human vs system) and when. Currently only shows outcome + relative time.

## Files Modified

| File | Change |
|------|--------|
| `src/components/vision/GateView.jsx` (existing) | All 4 enhancements |
