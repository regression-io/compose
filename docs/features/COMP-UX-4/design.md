# COMP-UX-4: Artifact Revision Diff

**Status:** DESIGN
**Date:** 2026-03-27

## Related Documents

- [COMP-UX-2 design](../COMP-UX-2/design.md) — Parent roadmap (Tier 1 polish)

---

## Problem

When a gate is revised, the agent rewrites the artifact and a new gate (round N+1) is created. The reviewer sees the new artifact but has no way to see what changed. They must re-read the entire document, guessing what was updated based on the revision comment alone. This makes review cycles slow and error-prone.

## Goal

Show a visual diff between artifact revisions at each gate round. When a gate has prior revisions, the reviewer can expand a diff panel to see exactly what changed.

---

## Decision 1: Snapshot Strategy

**Snapshot artifact content when a gate is created.** Store the full text as `artifactSnapshot` on the gate record.

Why on creation (not resolution):
- Creation captures "what the agent produced for this round"
- Resolution captures "the reviewer's decision" — the artifact hasn't changed yet
- Diffing round N vs round N+1 shows what the agent changed in response to revision feedback

**Storage:** Inline on the gate object in `vision-state.json`. Artifacts are small markdown files (typically 200-2000 words). The storage overhead is negligible.

**Null snapshots:** If the artifact path doesn't exist or isn't readable at gate creation time, `artifactSnapshot` stays null. The UI handles this gracefully.

## Decision 2: Diff Computation

Client-side using the `diff` npm package (`diffWords` or `diffLines`). No server-side diff endpoint needed.

- `diffLines` for structural changes (sections added/removed)
- Color coding: green for additions, red for removals, gray for unchanged context
- Unified diff format (not side-by-side) — fits the narrow gate panel

## Decision 3: UI Integration

Add an expandable "Show changes" button on any gate that has a prior revision with a snapshot. Located in GateView's pending gate rows and resolved gate history.

```
┌──────────────────────────────────────────────┐
│ AUTH-3 · blueprint_gate                       │
│ Prior revision: "Missing error handling..."   │
│ [Show changes]  [Approve] [Revise] [Kill]    │
├──────────────────────────────────────────────┤
│ - ## Error Handling                           │ (red)
│ + ## Error Handling & Recovery                │ (green)
│   This section covers...                      │ (gray)
│ + ### Retry Logic                             │ (green)
│ + When a step fails, the executor...          │ (green)
└──────────────────────────────────────────────┘
```

Collapsed by default. Toggle button shows diff inline below the gate info. Context: 3 lines around each change.

## Decision 4: Dashboard Integration

The DashboardView's PendingGates section also shows gates. Add the same diff toggle there — reuse the component.

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `server/vision-store.js` | modify | Add `artifactSnapshot` to gate schema |
| `server/vision-routes.js` | modify | Read artifact file on gate creation, attach snapshot |
| `src/components/vision/GateView.jsx` | modify | Add expandable diff panel |
| `src/components/vision/DashboardView.jsx` | modify | Add diff toggle to PendingGates |
| `src/components/shared/ArtifactDiff.jsx` | new | Shared diff rendering component |

## Acceptance Criteria

- [ ] Gate creation snapshots artifact content when artifact path is provided
- [ ] Gates with prior revisions show "Show changes" toggle
- [ ] Diff shows line-by-line additions (green) and removals (red) with 3-line context
- [ ] Diff works in both GateView and DashboardView
- [ ] Gates without prior revisions or without snapshots show no diff button
- [ ] Existing gates (no snapshot) degrade gracefully — no diff available
