# COMP-UX-4: Artifact Revision Diff — Implementation Blueprint

**Date:** 2026-03-27

## Related Documents

- [Design](design.md)

---

## Corrections Table

| Design Assumption | Reality | Impact |
|---|---|---|
| `artifactAssessment` is populated on gates | Field referenced in UI but never populated server-side | Not blocking — we add `artifactSnapshot` as a new field alongside it |
| ArtifactManager needs to be imported in routes | Already imported at line 33 and instantiated at line 354 | Can reuse existing instance |
| Gate creation uses `fromPhase` to find artifact | `fromPhase` is often null. The `artifact` field on the gate directly names the file path | Use `gate.artifact` path directly when available, fall back to PHASE_ARTIFACTS[fromPhase] |

---

## Task Breakdown

### Task 1: Add artifactSnapshot to gate creation (server)

**File:** `server/vision-routes.js` (existing)

At the `POST /api/vision/gates` endpoint (lines 403-440):

1. After destructuring `req.body` (line 406), resolve and read the artifact file:
   ```javascript
   let artifactSnapshot = null;
   if (artifact) {
     try {
       const fullPath = path.join(projectRoot, artifact);
       if (fs.existsSync(fullPath)) {
         artifactSnapshot = fs.readFileSync(fullPath, 'utf-8');
       }
     } catch (e) { /* silent — snapshot is best-effort */ }
   }
   ```
   Note: `artifact` field contains a relative path like `docs/features/COMP-UX-4/design.md`. Resolve against `projectRoot`.

2. Add `artifactSnapshot` to the gate object (line ~428):
   ```javascript
   artifactSnapshot: artifactSnapshot || null,
   ```

**File:** `server/vision-store.js` (existing)

In `createGate()` (line 270): add default:
```javascript
gate.artifactSnapshot = gate.artifactSnapshot ?? null;
```

### Task 2: Create ArtifactDiff component (new)

**File:** `src/components/shared/ArtifactDiff.jsx` (new)

Uses `diff` npm library to compute and render a line diff between two strings.

Props: `{ oldText, newText, collapsed, onToggle }`

- If `collapsed`, show only a "Show changes (N lines)" button
- If expanded, show unified diff with:
  - Green background for added lines
  - Red background for removed lines
  - 3 lines of context around each change
  - Line count summary at top

Style: match the amber revision theme from GateView (`bg-amber-400/10`, `border-amber-400/20`).

### Task 3: Enhance priorRevisions to include snapshots (GateView)

**File:** `src/components/vision/GateView.jsx` (existing)

In the `priorRevisions` useMemo (lines 254-279):

Currently builds `Map<gateId, commentString>`. Change to build `Map<gateId, { comment, priorSnapshot, currentSnapshot }>`:

```javascript
const revisions = new Map();
for (const pg of p) {
  const prior = r.find(rg =>
    rg.stepId === pg.stepId &&
    rg.itemId === pg.itemId &&
    (rg.outcome === 'revised' || rg.outcome === 'revise')
  );
  if (prior) {
    revisions.set(pg.id, {
      comment: prior.comment,
      priorSnapshot: prior.artifactSnapshot || null,
      currentSnapshot: pg.artifactSnapshot || null,
    });
  }
}
```

### Task 4: Add diff panel to PendingGateRow (GateView)

**File:** `src/components/vision/GateView.jsx` (existing)

In PendingGateRow (around line 82-88 where "Prior revision" is shown):

1. Add local state: `const [showDiff, setShowDiff] = useState(false)`
2. Replace the static "Prior revision" text with a clickable toggle
3. When expanded, render `<ArtifactDiff oldText={priorSnapshot} newText={currentSnapshot} />`
4. Only show toggle when both snapshots exist

### Task 5: Add diff to DashboardView PendingGates

**File:** `src/components/vision/DashboardView.jsx` (existing)

The PendingGates component (lines 133-185) needs:

1. Accept `allGates` prop (all gates, not just pending) to find prior revisions
2. For each pending gate, look up prior revised gate with matching stepId/itemId
3. If both have snapshots, show a "Changes" toggle that expands ArtifactDiff
4. Keep the UI compact — diff is below the gate row, collapsed by default

---

## Verification Checklist

- [ ] `artifactSnapshot` stored on gate creation when artifact path provided
- [ ] Gates without artifact path get `artifactSnapshot: null`
- [ ] GateView shows "Show changes" on gates with prior revision snapshots
- [ ] Diff renders additions (green) and removals (red)
- [ ] DashboardView gates also show diff toggle
- [ ] Existing gates (no snapshot) show no diff button
- [ ] Build passes
