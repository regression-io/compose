# Gate UI: Implementation Blueprint

**Status:** BLUEPRINT
**Date:** 2026-03-06
**Design:** [design.md](./design.md)

---

## File Plan

### 1. `src/components/vision/constants.js` (existing)

**What:** Add lifecycle phase labels and artifact filename mappings.

**Insert after line 45** (after `CONFIDENCE_LABELS`):

```js
export const LIFECYCLE_PHASE_LABELS = {
  explore_design: 'Design',
  prd:            'PRD',
  architecture:   'Architecture',
  blueprint:      'Blueprint',
  verification:   'Verification',
  plan:           'Plan',
  execute:        'Execute',
  report:         'Report',
  docs:           'Docs',
  ship:           'Ship',
  complete:       'Complete',
  killed:         'Killed',
};

export const LIFECYCLE_PHASE_ARTIFACTS = {
  explore_design: 'design.md',
  prd:            'prd.md',
  architecture:   'architecture.md',
  blueprint:      'blueprint.md',
  plan:           'plan.md',
  report:         'report.md',
};
```

**Pattern:** Mirrors `server/lifecycle-constants.js:8-11` (PHASES) and `server/lifecycle-constants.js:29-36` (PHASE_ARTIFACTS). Board-level `PHASES` and `PHASE_LABELS` remain untouched — they serve a different purpose (Vision board columns vs lifecycle state).

---

### 2. `src/components/vision/useVisionStore.js` (existing)

**What:** Add gates state, WS handlers for `gatePending`/`gateResolved`, gate event bridge for toasts, and `resolveGate` mutation.

#### 2a. New state declarations (insert after line 81, after `sessionState`)

```js
const [gates, setGates] = useState([]);
const [gateEvent, setGateEvent] = useState(null);
const gatesRef = useRef([]);
const pendingResolveIdsRef = useRef(new Set());
```

Pattern: follows existing `[agentActivity, setAgentActivity]` at line 79 and `sessionEndTimerRef` at line 87.

#### 2b. Keep gatesRef in sync (insert after line 87, before the WS useEffect)

```js
useEffect(() => { gatesRef.current = gates; }, [gates]);
```

Pattern: same as `prevItemMapRef` at line 85 — a ref that shadows state for use inside the closed-over WS handler.

#### 2c. Read gates from visionState (edit line 125)

Current line 125:
```js
setConnections(msg.connections || []);
```

Add after it:
```js
setGates(msg.gates || []);
```

#### 2d. Handle gatePending (insert new else-if after `agentError` handler, around line 174)

```js
} else if (msg.type === 'gatePending') {
  // Server does NOT call scheduleBroadcast() after gatePending
  // (vision-routes.js:160-169). Must fetch full gate and add to state.
  fetch(`/api/vision/gates/${msg.gateId}`)
    .then(r => r.ok ? r.json() : null)
    .then(gate => {
      if (gate) setGates(prev => prev.some(g => g.id === gate.id) ? prev : [...prev, gate]);
    })
    .catch(() => {});
  setGateEvent({ type: 'pending', gateId: msg.gateId, itemId: msg.itemId,
                 fromPhase: msg.fromPhase, toPhase: msg.toPhase });
```

**Why fetch instead of inline:** The `gatePending` WS message only carries `gateId`, `itemId`, `fromPhase`, `toPhase`, `timestamp`. The full gate object also has `operation`, `operationArgs`, `artifactAssessment`, `status`, `comment`. The GateView and ItemDetailPanel need the full object.

#### 2e. Handle gateResolved (insert after gatePending handler)

```js
} else if (msg.type === 'gateResolved') {
  // Optimistic update — scheduleBroadcast() follows, visionState will reconcile
  setGates(prev => prev.map(g =>
    g.id === msg.gateId
      ? { ...g, status: msg.outcome, outcome: msg.outcome, resolvedAt: msg.timestamp }
      : g
  ));
  // Toast — skip if this client triggered the resolve
  if (pendingResolveIdsRef.current.has(msg.gateId)) {
    pendingResolveIdsRef.current.delete(msg.gateId);
  } else {
    const resolvedGate = gatesRef.current.find(g => g.id === msg.gateId);
    setGateEvent({ type: 'resolved', gateId: msg.gateId, outcome: msg.outcome,
                   itemId: resolvedGate?.itemId ?? null });
  }
```

**Self-suppression:** `pendingResolveIdsRef` is a `Set` that tracks all in-flight resolve calls from this client. `resolveGate` adds the gateId before fetching; the handler checks membership and removes it. A Set (not a single ref) is required because multiple gates can be resolved back-to-back before the first WS response arrives.

#### 2f. resolveGate mutation (insert after `registerSnapshotProvider` at line 282)

```js
const resolveGate = useCallback(async (gateId, outcome, comment) => {
  pendingResolveIdsRef.current.add(gateId);
  try {
    const res = await fetch(`/api/vision/gates/${gateId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome, comment }),
    });
    const data = await handleResponse(res);
    if (data.error) pendingResolveIdsRef.current.delete(gateId);
    return data;
  } catch {
    pendingResolveIdsRef.current.delete(gateId);
    return { error: 'Network error' };
  }
}, [handleResponse]);
```

Pattern: identical to `createItem`/`updateItem` at lines 234-250.

#### 2g. Return additions (edit line 284-301)

Add to the return object:
```js
gates,
gateEvent,
resolveGate,
```

---

### 3. `src/components/vision/GateToast.jsx` (new)

**What:** Minimal toast for gate events. Renders bottom-right, auto-dismisses after 5s, clickable.

```jsx
import React, { useEffect, useState } from 'react';
import { LIFECYCLE_PHASE_LABELS } from './constants.js';

export default function GateToast({ event, items, onNavigate }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!event) return;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 5000);
    return () => clearTimeout(timer);
  }, [event]);

  if (!visible || !event) return null;

  const item = items.find(i => i.id === event.itemId);
  const title = item?.title ?? 'Unknown';
  const message = event.type === 'pending'
    ? `Gate pending: ${title} — ${LIFECYCLE_PHASE_LABELS[event.fromPhase] ?? event.fromPhase} → ${LIFECYCLE_PHASE_LABELS[event.toPhase] ?? event.toPhase}`
    : `Gate ${event.outcome}: ${title}`;

  return (
    <button
      onClick={() => { onNavigate(); setVisible(false); }}
      className="fixed bottom-4 right-4 z-50 max-w-sm px-4 py-3 rounded-lg border border-border bg-card shadow-lg text-sm text-foreground animate-in fade-in slide-in-from-bottom-2 cursor-pointer hover:bg-muted/50 transition-colors"
    >
      {message}
    </button>
  );
}
```

**Pattern:** No toast library. Uses Tailwind `animate-in` from the existing CSS setup. Same `border-border bg-card shadow-lg` pattern as `ConnectPopover` in `ItemDetailPanel.jsx:137`.

**Props:**
- `event` — `{ type, gateId, itemId, fromPhase?, toPhase?, outcome? }` from `useVisionStore.gateEvent`
- `items` — full items array for title lookup
- `onNavigate` — `() => setActiveView('gates')` from VisionTracker

---

### 4. `src/components/vision/GateView.jsx` (new)

**What:** Main gate queue view. Two sections: Pending and Resolved Today.

**Structure follows `AttentionView.jsx` exactly:**
- Summary bar at top (line 146-155 pattern)
- `Section` component with color dot + uppercase label + count (line 214-224 pattern)
- Row component with item lookup, badges, timestamps (line 21-62 pattern)
- `useMemo` for derivation from props (line 76-139 pattern)
- `relativeTime` helper — import from a shared location or duplicate (it's 7 lines)

**Props:**
```
gates: Gate[]       — full gates array from useVisionStore
items: Item[]       — for title lookup via gate.itemId
onResolve: (gateId, outcome, comment?) => void
onSelect: (itemId) => void  — to navigate to item detail
```

**Key sections:**

```jsx
// Derive pending and resolved-today via useMemo
const { pending, resolvedToday } = useMemo(() => {
  const p = [];
  const r = [];
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  for (const gate of gates) {
    if (gate.status === 'pending') p.push(gate);
    else if (gate.resolvedAt && new Date(gate.resolvedAt) >= todayStart) r.push(gate);
  }
  p.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));  // oldest first
  r.sort((a, b) => new Date(b.resolvedAt) - new Date(a.resolvedAt)); // newest first
  return { pending: p, resolvedToday: r };
}, [gates]);
```

**Pending gate row** — each row contains:
1. Feature title (from `items.find(i => i.id === gate.itemId)?.title`), clickable via `onSelect(gate.itemId)`
2. Transition label: `LIFECYCLE_PHASE_LABELS[gate.fromPhase] → LIFECYCLE_PHASE_LABELS[gate.toPhase]`
3. Artifact assessment block (conditionally rendered when `gate.artifactAssessment` non-null):
   - `LIFECYCLE_PHASE_ARTIFACTS[gate.fromPhase]` filename
   - `${Math.round(assessment.completeness * 100)}% complete`
   - `· ${assessment.wordCount} words`
   - If `assessment.sections.missing.length > 0`: `(missing: ${missing.join(', ')})`
   - If `!assessment.meetsMinWordCount`: amber warning text
4. Action buttons and inline forms:
   - **Approve** — `<Button>` with `text-success border-success/30`, calls `onResolve(gate.id, 'approved')` directly. No confirmation — approve is the expected action.
   - **Revise** — `<Button>` with `text-amber-400 border-amber-400/30`. Clicking toggles a per-row `revising` state that shows an inline `<input>` + Submit button below the action row. The input is optional (empty submit is valid). Submit calls `onResolve(gate.id, 'revised', comment)` and clears the revising state. Escape or clicking Revise again hides the input. This is the design's "inline text input" — not `window.prompt`.
   - **Kill** — `<Button>` with `text-destructive border-destructive/30`. Clicking toggles a per-row `killing` state that shows an inline `<input>` (required, submit disabled when empty) + Confirm Kill button. Submit calls `onResolve(gate.id, 'killed', reason)`. This avoids `window.confirm`/`window.prompt` which block the UI and cannot preserve partial input.

   **Per-row state:** `GateView` uses `const [expandedGateId, setExpandedGateId] = useState(null)` and `const [expandedAction, setExpandedAction] = useState(null)` — at most one gate row can have its inline input open at a time. Clicking Revise/Kill on a different row switches to that row.
5. Relative timestamp: `relativeTime(gate.createdAt)`

**Resolved gate row** — simpler:
1. Feature title
2. Transition label
3. Outcome badge: uses `Badge` component with outcome-appropriate color (approved=success, revised=amber, killed=destructive)
4. Comment text if present (truncated, `text-xs text-muted-foreground`)
5. Relative timestamp of resolution

**Empty state:** "No gates pending." centered text, matching `AttentionView.jsx:204-208`.

**Imports:**
```js
import { cn } from '@/lib/utils.js';
import { Badge } from '@/components/ui/badge.jsx';
import { Button } from '@/components/ui/button.jsx';
import { LIFECYCLE_PHASE_LABELS, LIFECYCLE_PHASE_ARTIFACTS } from './constants.js';
```

---

### 5. `src/components/vision/AppSidebar.jsx` (existing)

**What:** Add gates view entry with pending count badge.

#### 5a. Import icon (edit line 2)

Add `ShieldCheck` to the lucide-react import:
```js
import { List, Columns3, GitBranch, Network, Map, FileText, Search, CircleDot, Sun, Moon, Bell, ShieldCheck } from 'lucide-react';
```

#### 5b. Add gates entry to VIEWS array (edit line 11-19)

Insert after the `attention` entry (line 12):
```js
{ key: 'gates', label: 'Gates', icon: ShieldCheck },
```

#### 5c. Add `pendingGateCount` prop

Add to the function signature at line 68-80:
```js
pendingGateCount,
```

#### 5d. Add badge for gates view (edit lines 177-187)

The badge rendering switch currently handles `attention` and `list`. Add a case for `gates`:

```js
{view.key === 'gates' && pendingGateCount > 0 ? (
  <Badge variant="outline" className="ml-auto text-[10px] px-1.5 py-0 h-4 text-amber-400 border-amber-400/30">
    {pendingGateCount}
  </Badge>
) : view.key === 'attention' && attentionCount > 0 ? (
```

This goes at the start of the ternary chain inside the VIEWS map (before the attention case).

---

### 6. `src/components/vision/VisionTracker.jsx` (existing)

**What:** Wire gates, resolveGate, gateEvent through to GateView, GateToast, AppSidebar, and ItemDetailPanel.

#### 6a. Imports (add after line 12-14)

```js
import GateView from './GateView.jsx';
import GateToast from './GateToast.jsx';
```

#### 6b. Destructure gates from store (edit line 17-21)

Add `gates`, `gateEvent`, `resolveGate` to the destructuring:
```js
const {
  items, connections, connected, uiCommand, clearUICommand, recentChanges,
  createItem, updateItem, deleteItem, createConnection, deleteConnection,
  agentActivity, agentErrors, sessionState, registerSnapshotProvider,
  gates, gateEvent, resolveGate,
} = useVisionStore();
```

#### 6c. Derive pending gate count (insert after `filteredConnections` useMemo, around line 68)

```js
const pendingGateCount = useMemo(
  () => gates.filter(g => g.status === 'pending').length,
  [gates]
);
```

#### 6d. Pass pendingGateCount to AppSidebar (edit line 125-137)

Add prop:
```jsx
<AppSidebar
  ...existing props...
  pendingGateCount={pendingGateCount}
/>
```

#### 6e. Add GateView to view switch (insert after attention view, around line 208)

```jsx
{activeView === 'gates' && (
  <GateView
    gates={gates}
    items={items}
    onResolve={resolveGate}
    onSelect={handleSelect}
  />
)}
```

#### 6f. Pass gates and resolveGate to ItemDetailPanel (edit line 212-225)

Add props:
```jsx
<ItemDetailPanel
  ...existing props...
  gates={gates}
  onResolveGate={resolveGate}
/>
```

#### 6g. Add GateToast (insert before closing `</div>` of the main container, around line 241)

```jsx
<GateToast
  event={gateEvent}
  items={items}
  onNavigate={() => setActiveView('gates')}
/>
```

---

### 7. `src/components/vision/ItemDetailPanel.jsx` (existing)

**What:** Add lifecycle section with gate banner between connections and evidence sections.

#### 7a. Add imports (edit line 8)

```js
import { TYPE_COLORS, STATUS_COLORS, PHASES, PHASE_LABELS, STATUSES, CONFIDENCE_LABELS, LIFECYCLE_PHASE_LABELS } from './constants.js';
```

Add to lucide import (line 2):
```js
import { X, Link2, Pencil, Trash2, ChevronRight, ChevronDown, Search, Zap, ShieldCheck, Check, RotateCcw, Ban } from 'lucide-react';
```

#### 7b. Add `gates` and `onResolveGate` props (edit line 188)

```js
export default function ItemDetailPanel({ item, items, connections, onUpdate, onDelete, onCreateConnection, onDeleteConnection, onSelect, onClose, onPressureTest, gates, onResolveGate }) {
```

#### 7c. Add lifecycle section (insert after `ConnectionGraph` at line 358, before evidence section at line 360)

```jsx
{/* Lifecycle section — visible only when item has lifecycle data */}
{item.lifecycle && (() => {
  const lc = item.lifecycle;
  const pendingGate = lc.pendingGate
    ? (gates || []).find(g => g.id === lc.pendingGate)
    : null;

  return (
    <div className="space-y-2">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Lifecycle
      </p>

      {/* Phase + feature code */}
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
          {LIFECYCLE_PHASE_LABELS[lc.currentPhase] ?? lc.currentPhase}
        </Badge>
        {lc.featureCode && (
          <span className="text-[10px] font-mono text-muted-foreground">{lc.featureCode}</span>
        )}
      </div>

      {/* Gate banner */}
      {pendingGate && (
        <div className="rounded-md border border-amber-400/30 bg-amber-400/5 p-2 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="h-3 w-3 text-amber-400" />
            <span className="text-[10px] font-medium text-amber-400">
              Gate pending: {LIFECYCLE_PHASE_LABELS[pendingGate.toPhase] ?? pendingGate.toPhase}
            </span>
          </div>
          {pendingGate.artifactAssessment && (
            <p className="text-[10px] text-muted-foreground">
              {pendingGate.artifactAssessment.exists
                ? `${Math.round(pendingGate.artifactAssessment.completeness * 100)}% complete · ${pendingGate.artifactAssessment.wordCount} words`
                : 'Artifact not found'}
              {pendingGate.artifactAssessment.sections?.missing?.length > 0 && (
                <span className="text-amber-400"> (missing: {pendingGate.artifactAssessment.sections.missing.join(', ')})</span>
              )}
            </p>
          )}
          <GateBannerActions gate={pendingGate} onResolve={onResolveGate} />
        </div>
      )}

      {/* Phase history timeline */}
      {lc.phaseHistory?.length > 0 && (
        <div className="space-y-0.5">
          {lc.phaseHistory.map((entry, i) => {
            const durationMs = entry.exitedAt
              ? new Date(entry.exitedAt) - new Date(entry.enteredAt)
              : Date.now() - new Date(entry.enteredAt);
            const durationStr = durationMs < 60000
              ? `${Math.round(durationMs / 1000)}s`
              : durationMs < 3600000
                ? `${Math.round(durationMs / 60000)}m`
                : `${(durationMs / 3600000).toFixed(1)}h`;
            const isCurrent = !entry.exitedAt;
            return (
              <div key={i} className="flex items-center gap-2 px-2 py-1 rounded bg-muted/30">
                <div
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ background: isCurrent ? 'var(--color-accent)' : 'var(--color-success)' }}
                />
                <span className="text-[10px] text-foreground flex-1">
                  {LIFECYCLE_PHASE_LABELS[entry.phase] ?? entry.phase}
                </span>
                <span className="text-[10px] text-muted-foreground shrink-0">{durationStr}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
})()}
```

**`GateBannerActions` helper component** (defined in `ItemDetailPanel.jsx`, not exported):

A small stateful component that renders the three action buttons plus inline input expansion for Revise/Kill. Same interaction model as GateView rows: Approve is direct, Revise/Kill toggle an inline `<input>`. Uses local `useState` for expanded state. This avoids lifting revise/kill input state up to `ItemDetailPanel`.

```jsx
function GateBannerActions({ gate, onResolve }) {
  const [action, setAction] = useState(null); // null | 'revise' | 'kill'
  const [comment, setComment] = useState('');
  // Renders: [Approve] [Revise] [Kill]
  // When action is 'revise': inline input (optional) + Submit
  // When action is 'kill': inline input (required) + Confirm Kill
  // Submit clears action state. Escape clears action state.
}
```

**Pattern:** Follows the exact same structure as the Stratum Trace section at lines 380-406 — `text-[10px] font-medium uppercase tracking-wider text-muted-foreground` label, rows in `bg-muted/30` with 1.5px dots.

**Insertion point:** Between `ConnectionGraph` (line 353-358) and the evidence section (line 360). This places lifecycle info before audit evidence, which is the logical order (lifecycle context → evidence of execution).

---

## Corrections Table

| Design Assumption | Actual Code | Correction Needed? |
|---|---|---|
| `visionState` includes `gates` array | `vision-store.js:72-78` — `getState()` returns `{ items, connections, gates }` | No — confirmed |
| `gatePending` WS has no follow-up `scheduleBroadcast` | `vision-routes.js:160-169` — only `broadcastMessage`, no `scheduleBroadcast` | No — confirmed, design already accounts for this |
| `gateResolved` WS has follow-up `scheduleBroadcast` | `vision-routes.js:320` — calls `scheduleBroadcast()` before `broadcastMessage` | No — confirmed |
| Gate object shape includes `artifactAssessment` | `lifecycle-manager.js:353-367` — `#createGate` adds it | No — confirmed |
| `GET /api/vision/gates/:id` returns full gate object | `vision-routes.js:305-312` — reads from `store.gates.get(id)`, returns full object | No — confirmed |
| `useVisionStore` uses `useEffect([], [])` for WS | `useVisionStore.js:89-206` — empty dep array | No — confirmed; gatesRef pattern addresses stale closure |
| `AttentionView` uses `Section` + row pattern | `AttentionView.jsx:214-225` and `21-62` | No — confirmed |
| `ItemDetailPanel` has no lifecycle section | Lines 280-482 — shows status/confidence, phase, description, connections, graph, evidence, timestamps, actions | No — confirmed; lifecycle section is new |
| Badge component available | `AppSidebar.jsx:4` imports from `@/components/ui/badge.jsx` | No — confirmed |
| Button component available | `ItemDetailPanel.jsx:5` imports from `@/components/ui/button.jsx` | No — confirmed |
| Board phases differ from lifecycle phases | `constants.js:34` — `['vision', 'specification', 'planning', ...]` vs `lifecycle-constants.js:8-10` — `['explore_design', 'prd', ...]` | No — confirmed; `LIFECYCLE_PHASE_LABELS` added separately |
| `window.confirm`/`window.prompt` pattern used in codebase | `ItemDetailPanel.jsx:471` — `window.confirm(...)` | No — confirmed; using prompt for Kill/Revise comments follows existing pattern |
| Test framework is `node:test` | `lifecycle-routes.test.js:8` — `import { test, describe, beforeEach, afterEach } from 'node:test'` | No — confirmed |

---

## Test Plan

### `test/gate-routes.test.js` (new)

Integration test following `lifecycle-routes.test.js` pattern (Express + ephemeral port + in-memory store + broadcast capture).

1. **Gate hydration from visionState** — create a gate via store, connect WS, verify `visionState` message includes `gates` array with the gate
2. **gatePending broadcast** — advance a lifecycle into a gated phase, verify `gatePending` broadcast contains `gateId`, `itemId`, `fromPhase`, `toPhase`; verify NO `scheduleBroadcast` call (broadcasts array should not contain a follow-up `visionState`)
3. **gateResolved broadcast** — resolve a gate, verify `gateResolved` broadcast contains `gateId`, `outcome`; verify `scheduleBroadcast` IS called
4. **GET /api/vision/gates/:id** — create gate, fetch by ID, verify full object shape including `artifactAssessment`
5. **POST /api/vision/gates/:id/resolve** — table-driven test for each outcome (approved/revised/killed), verify response shapes and side effects (approved = phase advances, revised = phase stays, killed = item killed)

### `test/gate-logic.test.js` (new)

Pure logic tests for derivation and state management patterns. Uses `node:test` + `assert`, no jsdom.

1. **Pending/resolved partitioning** — given a mixed array of gates with various statuses and timestamps, verify: pending sorted by `createdAt` ascending, resolved-today filtered correctly (boundary: midnight), resolved sorted by `resolvedAt` descending
2. **Phase label completeness** — verify `LIFECYCLE_PHASE_LABELS` has an entry for every phase in `server/lifecycle-constants.js:PHASES` plus terminal states
3. **Artifact assessment display derivation** — given assessments with completeness=1.0, completeness=0.5 with missing sections, meetsMinWordCount=false, and null assessment, verify the expected conditional display logic
4. **Self-suppression with Set** — simulate: add gateId-A to set, add gateId-B, receive WS for A (should suppress + remove), receive WS for B (should suppress + remove), receive WS for C (should NOT suppress). Verify set is empty after A and B are consumed.
5. **pendingGateCount derivation** — given gates array with mixed statuses, verify filter count

### `test/gate-client.test.js` (new)

Hook and component behavior tests. Uses a lightweight test harness that simulates WS messages by directly calling the message handler logic extracted from `useVisionStore`.

**Approach:** Extract the WS message dispatch logic from `useVisionStore`'s `ws.onmessage` handler into a testable pure function `handleVisionMessage(msg, state, setters)` that takes the parsed message, current state refs, and setter functions. This function is tested directly without React or jsdom.

1. **visionState hydration** — send `{ type: 'visionState', items: [...], connections: [...], gates: [...] }`, verify `setGates` called with the gates array
2. **gatePending handler** — send `gatePending` message, verify: `setGateEvent` called with `{ type: 'pending', ... }`, fetch initiated for `/api/vision/gates/:id`
3. **gateResolved handler** — send `gateResolved` message, verify: `setGates` called with mapper that updates the matching gate's status/outcome/resolvedAt
4. **gateResolved self-suppression** — add gateId to `pendingResolveIdsRef`, send `gateResolved`, verify `setGateEvent` NOT called, gateId removed from set
5. **gateResolved toast for external resolve** — send `gateResolved` without gateId in set, verify `setGateEvent` called with correct shape including `itemId` from `gatesRef`

**Note:** Full React rendering tests (GateView, GateToast, ItemDetailPanel lifecycle section) are deferred to manual verification during Phase 7 E2E. The codebase has no jsdom/testing-library setup, and adding one is out of scope for L4. The extracted handler function covers the highest-risk logic paths.
