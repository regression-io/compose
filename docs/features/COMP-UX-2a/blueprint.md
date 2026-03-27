# COMP-UX-2a: Feature-Aware Filtering — Implementation Blueprint

**Date:** 2026-03-27
**Depends on:** COMP-UX-2d (group field — cleaner filtering with proper data model)
**Enables:** COMP-UX-2c (dashboard can reuse focus state)

## Related Documents

- [Design](design.md)
- [COMP-UX-2 parent](../COMP-UX-2/design.md)

---

## Corrections Table

| Design Assumption | Reality | Impact |
|---|---|---|
| `sessionState.featureCode` available everywhere | Lives in `useVisionStore()`, flows to App.jsx via selector at line 352. Available as `sessionState?.featureCode`. | Need to thread featureCode through CockpitView props to views |
| Gates have featureCode | Gates link through `gate.itemId` → item lookup → `item.featureCode` | Focus filter for gates needs item lookup, not direct gate.featureCode |
| Shared toolbar component needed | Each view has its own inline toolbar with local FilterBtn components | Create shared FeatureFocusToggle that fits each view's toolbar pattern |
| DocsView has configurable root | Root is hardcoded to `'docs'` dir, tree built from `/api/files` response | Focus = filter file list to `docs/features/<featureCode>/` prefix |

---

## Data Flow

```
useVisionStore().sessionState.featureCode
  → App.jsx (selector at line 352)
    → CockpitView props (new: featureCode, focusActive)
      → Each view component
        → FeatureFocusToggle in toolbar
        → Local useMemo filter on featureCode
```

## Task Breakdown

### Task 1: Create FeatureFocusToggle.jsx (new)

**File:** `src/components/shared/FeatureFocusToggle.jsx`

Shared toggle that drops into any view's toolbar. Follows the `FilterBtn` inline-style pattern from GraphView (lines 311-337).

```jsx
export default function FeatureFocusToggle({ featureCode, active, onToggle }) {
  if (!featureCode) return null;
  return (
    <button onClick={onToggle} style={{
      fontSize: 11, padding: '3px 9px', borderRadius: 4, cursor: 'pointer',
      transition: 'all 0.15s',
      border: `1px solid ${active ? '#f59e0b' : '#334155'}`,
      background: active ? '#f59e0b20' : '#1e293b',
      color: active ? '#f59e0b' : '#94a3b8',
    }}>
      Focus: {featureCode}
    </button>
  );
}
```

Uses amber (#f59e0b) to distinguish from blue status filters.

### Task 2: Thread featureCode + focus state through App.jsx (existing)

**File:** `src/App.jsx`

1. **Add focus state** near line 393 (alongside hiddenGroups):
   ```javascript
   const [focusFeature, setFocusFeature] = useState(false);
   const activeFeatureCode = sessionState?.featureCode || null;
   ```
2. **Pass to CockpitView** (around line 660):
   ```javascript
   featureCode={activeFeatureCode}
   focusActive={focusFeature}
   onToggleFocus={() => setFocusFeature(f => !f)}
   ```
3. **CockpitView function signature** (line 183): Add `featureCode, focusActive, onToggleFocus` params
4. **Pass to each view** in the switch statement (lines 223-305)

### Task 3: GraphView focus — dim non-feature items (existing)

**File:** `src/components/vision/GraphView.jsx`

1. **Props:** Add `featureCode, focusActive, onToggleFocus`
2. **Toolbar (line ~700):** Add `<FeatureFocusToggle>` between existing filter buttons
3. **Filtering (line ~436):** When `focusActive && featureCode`:
   - Don't remove items — dim them instead
   - Add a `dimmed` flag to non-matching items
   - In `buildElements()`: set `classes: 'dimmed'` for items where `item.group !== featureCode's group`
4. **Stylesheet:** Add dimmed style:
   ```javascript
   { selector: '.dimmed', style: { opacity: 0.2 } }
   ```
5. **Keep 1-hop connections:** Items connected to focused items stay visible (not dimmed)

### Task 4: TreeView focus — filter to feature items (existing)

**File:** `src/components/vision/TreeView.jsx`

1. **Props:** Add `featureCode, focusActive, onToggleFocus`
2. **Toolbar (line ~328):** Add `<FeatureFocusToggle>` after type filters
3. **Filter logic (line ~160):** When `focusActive && featureCode`:
   ```javascript
   if (focusActive && featureCode) {
     result = result.filter(i =>
       i.featureCode === featureCode ||
       i.lifecycle?.featureCode === featureCode ||
       (i.group && featureCode.startsWith(i.group + '-'))
     );
   }
   ```

### Task 5: GateView focus — filter to feature gates (existing)

**File:** `src/components/vision/GateView.jsx`

1. **Props:** Add `featureCode, focusActive, onToggleFocus, items` (items needed for lookup)
2. **Toolbar:** Add `<FeatureFocusToggle>`
3. **Filter logic:** When focused, filter gates where the linked item belongs to the feature:
   ```javascript
   const featureItemIds = new Set(
     items.filter(i => i.featureCode === featureCode).map(i => i.id)
   );
   const filteredGates = focusActive
     ? gates.filter(g => featureItemIds.has(g.itemId))
     : gates;
   ```

### Task 6: SessionsView focus — filter to feature sessions (existing)

**File:** `src/components/vision/SessionsView.jsx`

1. **Props:** Add `featureCode, focusActive, onToggleFocus`
2. **Toolbar (line ~53):** Add `<FeatureFocusToggle>`
3. **Filter logic:** When focused:
   ```javascript
   if (focusActive && featureCode) {
     result = result.filter(s =>
       s.featureCode === featureCode || s.feature_code === featureCode
     );
   }
   ```

### Task 7: DocsView focus — default to feature folder (existing)

**File:** `src/components/vision/DocsView.jsx`

1. **Props:** Add `featureCode, focusActive, onToggleFocus`
2. **Toolbar:** Add `<FeatureFocusToggle>`
3. **File list filter (line ~249):** When focused, filter files to `features/<featureCode>/` prefix:
   ```javascript
   const displayFiles = focusActive && featureCode
     ? files.filter(f => f.includes(`features/${featureCode}/`))
     : files;
   ```
4. **Auto-expand:** When focus activates, expand the feature's folder in the tree

---

## Verification Checklist

- [ ] FeatureFocusToggle renders in Graph, Tree, Gates, Sessions, Docs toolbars
- [ ] Toggle disabled/hidden when no featureCode bound
- [ ] Graph: focused items at full opacity, others dimmed to 0.2 (not hidden)
- [ ] Graph: 1-hop connections of focused items also visible
- [ ] Tree: filtered to items matching featureCode
- [ ] Gates: filtered to gates whose items match featureCode
- [ ] Sessions: filtered to sessions with matching featureCode
- [ ] Docs: filtered to feature folder files
- [ ] Focus persists across tab switches (single state in App.jsx)
- [ ] Unfocused mode: all views show everything (no regressions)
