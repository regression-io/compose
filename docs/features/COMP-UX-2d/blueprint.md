# COMP-UX-2d: First-Class Group Field — Implementation Blueprint

**Date:** 2026-03-27
**Depends on:** Nothing (foundational change)
**Enables:** COMP-UX-2a (feature-aware filtering), COMP-UX-2c (dashboard grouping)

## Related Documents

- [Design](design.md)
- [COMP-UX-2 parent](../COMP-UX-2/design.md)

---

## Corrections Table

| Design Assumption | Reality | Impact |
|---|---|---|
| TreeView uses group prefix derivation | TreeView uses parent/child hierarchy from connections, not groups | TreeView change is optional — only add group filter if desired |
| Only GraphView derives groups | AttentionQueueSidebar (lines 173-234) has its own hardcoded KNOWN_PREFIXES list | Must update AttentionQueueSidebar too |
| `GET /api/vision/items` has filtering | Currently returns full state via `store.getState()` | Add query param filtering to existing endpoint |

---

## Task Breakdown

### Task 1: Add `group` field to vision-store.js (existing)

**File:** `server/vision-store.js`

1. **Line ~114 (`createItem` signature):** Add `group = null` parameter
2. **Line ~136 (item object):** Add `group: group || deriveGroup(title, featureCode)`
3. **Line ~166 (`updateItem` allowed array):** Add `'group'` to allowed list
4. **Migration in `_load()` (lines 52-62 area):** Add backfill block:
   ```javascript
   // Backfill group field for existing items
   if (!item.group) {
     const PREFIX_RE = /^([A-Z]+-[A-Z]+|[A-Z]+)(?=-\d)/;
     const match = (item.title || '').match(PREFIX_RE)
       || (item.featureCode || '').match(PREFIX_RE);
     if (match) { item.group = match[1]; migrated = true; }
   }
   ```
5. **Extract shared `deriveGroup(title, featureCode)` function** at module scope so both `createItem` and `_load` use it.

**Pattern:** Follow the `featureCode` migration pattern already at lines 52-62.

### Task 2: Update vision-routes.js (existing)

**File:** `server/vision-routes.js`

1. **Lines 46-49 (`GET /api/vision/items`):** Add optional `?group=` query param filter:
   ```javascript
   app.get('/api/vision/items', (req, res) => {
     let state = store.getState();
     if (req.query.group) {
       state = { ...state, items: state.items.filter(i => i.group === req.query.group) };
     }
     res.json(state);
   });
   ```
2. **POST/PATCH endpoints** already pass `req.body` through — no changes needed (group flows through allowed list).

### Task 3: Simplify GraphView.jsx (existing)

**File:** `src/components/vision/GraphView.jsx`

1. **Lines 60-75 (`deriveGroupPrefixes`):** Remove function
2. **Lines 77-91 (`getGroup`):** Replace with:
   ```javascript
   function getGroup(item) { return item.group || 'other'; }
   ```
3. **Line 434 (`knownPrefixes` memo):** Remove
4. **Lines 93-122 (`buildElements`):** Update group extraction to use `item.group` directly
5. **Lines 451-455 (filtering):** Update `hiddenGroups` filter:
   ```javascript
   if (hiddenGroups?.size > 0) {
     result = result.filter(i => !hiddenGroups.has(i.group || 'other'));
   }
   ```

### Task 4: Simplify AttentionQueueSidebar.jsx (existing)

**File:** `src/components/vision/AttentionQueueSidebar.jsx`

1. **Lines 173-234 (`GroupFilter`):** Replace hardcoded KNOWN_PREFIXES (line 181) with `item.group` field:
   ```javascript
   const counts = {};
   for (const item of items) {
     if (item.title?.startsWith('`docs/')) continue;
     const group = item.group || 'other';
     counts[group] = (counts[group] || 0) + 1;
     // ... active count logic unchanged
   }
   ```
2. **Remove line 181** hardcoded array entirely.

### Task 5: Optional — TreeView.jsx group awareness (existing)

**File:** `src/components/vision/TreeView.jsx`

- Currently hierarchy-based (parent/child from connections), not group-based
- **Skip unless explicitly requested** — TreeView's data model is orthogonal to group field
- If added: use `item.group` for an optional group filter in the toolbar alongside status/type filters

---

## Verification Checklist

- [ ] `deriveGroup()` extracted as shared function in vision-store.js
- [ ] `group` field in createItem, updateItem allowed list
- [ ] Backfill migration runs on `_load()` for existing items
- [ ] GraphView reads `item.group` directly (no regex)
- [ ] AttentionQueueSidebar reads `item.group` directly (no hardcoded list)
- [ ] `GET /api/vision/items?group=X` filters correctly
- [ ] No regression: grouping in Graph still works, sidebar filters still work
