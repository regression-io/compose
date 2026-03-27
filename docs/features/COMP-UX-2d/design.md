# COMP-UX-2d: First-Class Group Field for Vision Items

**Status:** DESIGN
**Date:** 2026-03-27

## Related Documents

- [COMP-UX-2 design](../COMP-UX-2/design.md) — Parent feature
- [COMP-UX-2b](../COMP-UX-2b/) — Fix 5 introduced dynamic regex prefix derivation (interim solution)

---

## Problem

Vision items are grouped in the Graph view by regex-parsing uppercase prefixes from titles (`COMP-UX`, `STRAT-ENG`, `TEST`). This is brittle:
- Lowercase or underscore-separated codes don't match
- Prose titles fall to "other" even when they belong to a feature
- The regex `^([A-Z]+-[A-Z]+|[A-Z]+)(?=-\d)` is a heuristic, not a data model
- No canonical way to say "this item belongs to group X" — it's inferred from string patterns

## Goal

Add a first-class `group` field to vision items. The server assigns it on creation (derived from prefix or user-specified). The UI reads the field directly instead of regex-parsing. GraphView, TreeView, and filtering all use the field.

---

## Decision 1: Schema Change

Add `group` field to vision item schema:

```javascript
{
  id, title, type, status, phase, confidence, description,
  group: string | null,  // NEW — e.g. "COMP-UX", "STRAT-ENG", "TEST"
}
```

**On creation:** Server derives `group` from title/featureCode using the same regex currently in GraphView. If no match, `group` remains `null` (not "other" — null means unassigned).

**On update:** If title changes and group was auto-derived, re-derive. If group was manually set, preserve it.

**Migration:** Backfill existing items by running the derivation function once on existing data.

## Decision 2: API Surface

- `POST /api/vision/items` — accepts optional `group` field; auto-derives if absent
- `PATCH /api/vision/items/:id` — accepts `group` to manually override
- `GET /api/vision/items?group=COMP-UX` — filter by group

## Decision 3: GraphView Simplification

Replace `deriveGroupPrefixes()` + `getGroup(item, knownPrefixes)` with:
```javascript
const group = item.group || 'other';
```

Remove all regex from GraphView. The server is the source of truth.

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `server/vision-store.js` | modify | Add group field to item schema, auto-derive on create/update |
| `server/vision-routes.js` | modify | Accept group in create/update, add group query param |
| `src/components/vision/GraphView.jsx` | modify | Read item.group directly, remove regex derivation |
| `src/components/vision/TreeView.jsx` | modify | Use item.group for grouping if present |

## Acceptance Criteria

- [ ] New items get `group` auto-derived from title/featureCode
- [ ] Existing items backfilled with group on server startup
- [ ] `PATCH` allows manual group override
- [ ] GraphView uses `item.group` directly (no regex)
- [ ] `GET /api/vision/items?group=X` filters by group
- [ ] Items with no recognizable prefix get `group: null` (shown as "other" in UI)
