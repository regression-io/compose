# Gate UI: Design

**Status:** DESIGN
**Date:** 2026-03-06
**Roadmap item:** 25 (Phase 6, L4)

## Related Documents

- [Policy Enforcement Design](../policy-enforcement/design.md) — L3 (dependency, COMPLETE)
- [Artifact Awareness Design](../artifact-awareness/design.md) — L2 (dependency, COMPLETE)
- [Lifecycle Engine Roadmap](../../plans/2026-02-15-lifecycle-engine-roadmap.md) — Layer 4 context
- [Compose Skill](../../../.claude/skills/compose/SKILL.md) — gate protocol spec

---

## Problem

The policy enforcement runtime (L3) creates gates, blocks transitions, and exposes REST/MCP/WebSocket surfaces for gate management. But the gates are invisible in the UI. The server broadcasts `gatePending` and `gateResolved` WebSocket messages and includes `gates` in the initial `visionState` payload — but the client discards all of it. `useVisionStore.js` reads only `msg.items` and `msg.connections` from `visionState` messages.

Current gaps:

1. **No gate visibility** — pending gates exist only in server state. The human must use MCP tools or curl to discover them.
2. **No resolution UI** — approving/revising/killing a gate requires `POST /api/vision/gates/:id/resolve` via terminal. No buttons, no form.
3. **No gate queue** — when multiple features have pending gates, there's no unified view.
4. **No artifact context at gates** — the `artifactAssessment` snapshot on each gate (completeness, missing sections, word count) is captured but never shown.
5. **No gate history** — resolved gates are stored server-side but have no UI surface.

## Goal

Surface pending gates in the Vision Surface so humans can see what's waiting for approval and act on it without leaving the UI. Three actions: Approve, Revise, Kill. Artifact quality context displayed inline. Gate history accessible per item.

Scope: client-side only. All server infrastructure exists (L3). This is purely UI + client state.

---

## Decision 1: New "Gates" View in Sidebar

Add a `gates` entry to the `VIEWS` array in `AppSidebar.jsx` (line 11). This creates a dedicated view in the main content area, following the same pattern as Roadmap, List, Board, Tree, Graph, Docs, and Attention views.

The Gates view is modeled after `AttentionView.jsx` — the closest existing analog (action-queue pattern with section grouping, row items, and summary bar).

**Sidebar badge:** A count badge on the Gates nav item showing the number of pending gates. Follows the existing badge pattern at `AppSidebar.jsx:177`. Badge disappears when count is 0.

---

## Decision 2: Client State for Gates

`useVisionStore.js` gets a new `gates` state variable and two event-driven handlers:

```js
// State
const [gates, setGates] = useState([]);
const gatesRef = useRef([]);
// Keep ref in sync — the WS handler (inside useEffect([], [])) reads gatesRef.current
// to avoid stale closure over initial gates state.
useEffect(() => { gatesRef.current = gates; }, [gates]);

// From visionState message (already in payload, currently ignored):
// Add alongside the existing setItems/setConnections at line 124-125:
setGates(msg.gates ?? []);

// New message handlers — these MUST update state directly:
case 'gatePending':
  // Server does NOT call scheduleBroadcast() after gatePending (vision-routes.js:160-169).
  // Only the non-gated advance path (line 172) calls scheduleBroadcast().
  // Without direct handling here, newly created gates are invisible to other clients.
  setGates(prev => {
    // Fetch the full gate object since the WS message is a summary
    fetch(`/api/vision/gates/${msg.gateId}`).then(r => r.json()).then(gate => {
      setGates(p => p.some(g => g.id === gate.id) ? p : [...p, gate]);
    });
    return prev;
  });
  // Emit toast event (see Decision 5)
  break;

case 'gateResolved':
  // Server DOES call scheduleBroadcast() after resolve (vision-routes.js:320),
  // so visionState will follow. But update immediately for responsiveness:
  setGates(prev => prev.map(g =>
    g.id === msg.gateId ? { ...g, status: msg.outcome, outcome: msg.outcome, resolvedAt: msg.timestamp } : g
  ));
  // Emit toast event (see Decision 5)
  break;
```

**Key server behavior:** `gatePending` is broadcast WITHOUT a follow-up `scheduleBroadcast()` — the advance route returns HTTP 202 and exits. `gateResolved` IS followed by `scheduleBroadcast()`. The client must handle `gatePending` directly to avoid a gap where pending gates are invisible.

**Hydration:** On initial `visionState`, gates are read from `msg.gates`. On `gatePending`, the client fetches the full gate object via `GET /api/vision/gates/:id` (the WS message only carries `gateId`, `itemId`, `fromPhase`, `toPhase`). On `gateResolved`, an optimistic status update is applied immediately; the follow-up `visionState` broadcast reconciles.

**Mutation:** `resolveGate(gateId, outcome, comment)` — calls `POST /api/vision/gates/:id/resolve`. The server broadcasts `gateResolved` + `visionState`, which update the client state via the handlers above.

---

## Decision 3: GateView Component

`src/components/vision/GateView.jsx` — the main content view when `activeView === 'gates'`.

### Layout

```
┌─────────────────────────────────────────────┐
│  N gates pending  ·  M resolved today       │  ← summary bar
├─────────────────────────────────────────────┤
│  ● PENDING                            [3]   │  ← section header
│  ┃ lifecycle-state-machine                   │
│  ┃ blueprint → verification                  │
│  ┃ design.md: 100% complete · 450 words      │
│  ┃ [Approve] [Revise] [Kill]          2m ago │
│  ┃                                           │
│  ┃ gate-ui                                   │
│  ┃ explore_design → blueprint                │
│  ┃ design.md: 80% complete (missing: Files)  │
│  ┃ [Approve] [Revise] [Kill]          5m ago │
├─────────────────────────────────────────────┤
│  ○ RESOLVED TODAY                      [4]   │  ← section header
│  ┃ policy-enforcement                        │
│  ┃ plan → execute · Approved           1h ago│
│  ┃                                           │
│  ┃ artifact-awareness                        │
│  ┃ blueprint → verification · Revised  3h ago│
└─────────────────────────────────────────────┘
```

### Sections

1. **Pending** — gates with `status === 'pending'`, sorted by `createdAt` ascending (oldest first — longest-waiting gates surface first)
2. **Resolved Today** — gates with `status !== 'pending'` and `resolvedAt` within the current day, sorted by `resolvedAt` descending

### Lifecycle Phase Labels

The existing client `constants.js` defines board-level phases (`vision`, `specification`, `planning`, etc.) which do NOT match lifecycle phases (`explore_design`, `blueprint`, `verification`, etc.). Gate payloads use lifecycle phase names from `server/lifecycle-constants.js`.

Add a `LIFECYCLE_PHASE_LABELS` map to `constants.js`:

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

// Maps lifecycle phases to their artifact filenames (mirrors server/lifecycle-constants.js:PHASE_ARTIFACTS)
export const LIFECYCLE_PHASE_ARTIFACTS = {
  explore_design: 'design.md',
  prd:            'prd.md',
  architecture:   'architecture.md',
  blueprint:      'blueprint.md',
  plan:           'plan.md',
  report:         'report.md',
};
```

`GateView` uses `LIFECYCLE_PHASE_LABELS[gate.fromPhase]` and `LIFECYCLE_PHASE_LABELS[gate.toPhase]` for display. The artifact filename for context comes from `LIFECYCLE_PHASE_ARTIFACTS[gate.fromPhase]` (the artifact of the phase being exited — the one that should be complete).

### Gate Row (Pending)

Each pending gate row shows:

- **Feature title** — the Vision item's title (looked up via `gate.itemId` from items list)
- **Transition** — `{LIFECYCLE_PHASE_LABELS[fromPhase]} → {LIFECYCLE_PHASE_LABELS[toPhase]}` (human-readable labels, not raw phase keys)
- **Artifact assessment** (when `gate.artifactAssessment` is non-null):
  - Artifact filename from `LIFECYCLE_PHASE_ARTIFACTS[gate.fromPhase]`
  - Completeness percentage and word count
  - Missing required sections listed if any (`completeness < 1.0`)
  - `meetsMinWordCount` warning if false
- **Action buttons** — Approve (green), Revise (amber), Kill (red)
- **Relative timestamp** — time since gate was created

### Gate Row (Resolved)

- Feature title
- Transition summary
- Outcome badge: Approved (green), Revised (amber), Killed (red)
- Comment text if present
- Relative timestamp of resolution

### Interaction

**Approve** — immediate call to `resolveGate(gateId, 'approved')`. No confirmation dialog — approve is the safe/expected action.

**Revise** — opens an inline text input for an optional comment, then calls `resolveGate(gateId, 'revised', comment)`. The comment tells the agent what to fix.

**Kill** — opens a confirmation dialog with a required reason field. Calls `resolveGate(gateId, 'killed', reason)`. Kill is destructive (sets feature to killed state), so it requires confirmation.

---

## Decision 4: Gate Indicator on Item Detail Panel

`ItemDetailPanel` currently has no lifecycle section — it shows header, description, connections, evidence/stratum trace, timestamps, and actions. This design adds a **Lifecycle section** between connections and evidence, visible only when `item.lifecycle` is present:

```
┌─────────────────────────────────────┐
│ LIFECYCLE                           │
│ Phase: Blueprint                    │
│ Feature: gate-ui                    │
│                                     │
│ ┌─ GATE PENDING ──────────────────┐ │
│ │ Entering: Verification          │ │
│ │ design.md: 100% complete        │ │
│ │ [Approve] [Revise] [Kill]       │ │
│ └─────────────────────────────────┘ │
│                                     │
│ Phase history:                      │
│  explore_design  ✓  12m            │
│  blueprint       ✓   8m            │
│  verification    ●  (current)      │
└─────────────────────────────────────┘
```

**Lifecycle section contents:**
- Current phase (using `LIFECYCLE_PHASE_LABELS`)
- Feature code
- **Gate banner** (only when `item.lifecycle.pendingGate` is set) — looks up the gate object from `gates` array, shows target phase, artifact assessment, and Approve/Revise/Kill buttons
- Phase history timeline — compact list from `item.lifecycle.phaseHistory`

**Gate banner interaction** duplicates GateView's action buttons — the user can resolve a gate from either location. Both call the same `resolveGate` mutation.

The lifecycle section uses the same `text-[10px] font-medium uppercase tracking-wider text-muted-foreground` label style as the existing Evidence and Stratum Trace sections (`ItemDetailPanel.jsx:383`).

---

## Decision 5: Toast Notifications for Gate Events

**Architecture:** `useVisionStore` owns the WebSocket but cannot render UI or control `activeView` (which lives in `VisionTracker`). Toasts require a callback bridge:

1. `useVisionStore` exposes `gateEvent` state — set on `gatePending`/`gateResolved`, cleared after consumption
2. `VisionTracker` watches `gateEvent` via `useEffect`, renders the toast, and handles the click-to-navigate action (setting `activeView = 'gates'`)

```js
// In useVisionStore:
const [gateEvent, setGateEvent] = useState(null);

// In gatePending handler:
setGateEvent({ type: 'pending', gateId: msg.gateId, itemId: msg.itemId,
               fromPhase: msg.fromPhase, toPhase: msg.toPhase });

// In gateResolved handler — derive itemId from a ref-backed snapshot since the
// WS handler closes over initial state (useEffect([], [])).
// gatesRef.current is updated by a separate useEffect watching gates state.
const resolvedGate = gatesRef.current.find(g => g.id === msg.gateId);
setGateEvent({ type: 'resolved', gateId: msg.gateId, outcome: msg.outcome,
               itemId: resolvedGate?.itemId ?? null });

// Returned from hook:
return { ...existing, gates, gateEvent, resolveGate };
```

```js
// In VisionTracker:
useEffect(() => {
  if (!gateEvent) return;
  // Look up item title for display
  const item = items.find(i => i.id === gateEvent.itemId);
  showToast({
    message: gateEvent.type === 'pending'
      ? `Gate pending: ${item?.title ?? 'Unknown'}`
      : `Gate ${gateEvent.outcome}: ${item?.title ?? 'Unknown'}`,
    onClick: () => setActiveView('gates'),
  });
  // Clear after showing — VisionTracker is the consumer
}, [gateEvent]);
```

**Toast rendering:** A minimal `GateToast` component rendered by `VisionTracker`, positioned bottom-right with CSS animation (fade-in, auto-dismiss after 5s). Clickable — sets `activeView = 'gates'`. No toast library.

**Self-resolution suppression:** When `resolveGate` is called from this client, set a `pendingResolveId` ref. If `gateResolved` arrives with the same `gateId`, skip the toast.

---

## Decision 6: Wiring in VisionTracker

`VisionTracker.jsx` is the orchestrator. Changes:

1. Receive `gates` and `resolveGate` from `useVisionStore`
2. Compute `pendingGates = gates.filter(g => g.status === 'pending')`
3. Pass `pendingGateCount` to `AppSidebar` for the badge
4. Pass `gates`, `items` (for title lookup), and `resolveGate` to `GateView`
5. Pass the relevant gate object to `ItemDetailPanel` when the selected item has a pending gate

---

## Decision 7: What This Does NOT Do

- **No gate auto-approval rules** — all gates require explicit human action
- **No gate timeout UI** — `stratum_check_timeouts` handles timeouts server-side; the UI just shows the result
- **No policy configuration UI** — that's L0 (User Preferences), currently PARKED
- **No gate reordering or priority** — gates are shown in creation order
- **No gate assignment** — no concept of "assign this gate to person X"
- **No server changes** — all infrastructure exists. This is purely client-side. One exception: the `gatePending` broadcast path in `vision-routes.js` does not call `scheduleBroadcast()`. This is acceptable — the client handles `gatePending` directly (Decision 2). No server fix needed.

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/components/vision/GateView.jsx` | **Create** | Main gate queue view — pending + resolved sections, action buttons, artifact assessment display |
| `src/components/vision/GateToast.jsx` | **Create** | Minimal toast component for gate events — fade-in, auto-dismiss, click-to-navigate |
| `src/components/vision/constants.js` | **Edit** | Add `LIFECYCLE_PHASE_LABELS` and `LIFECYCLE_PHASE_ARTIFACTS` maps |
| `src/components/vision/useVisionStore.js` | **Edit** | Add `gates` state from `visionState`, `gatePending`/`gateResolved` handlers with direct state updates, `gateEvent` for toast bridge, `resolveGate` mutation |
| `src/components/vision/VisionTracker.jsx` | **Edit** | Wire `gates`, `resolveGate`, `gateEvent` to GateView/ItemDetailPanel/GateToast; add `useEffect` for toast consumption and `activeView` navigation |
| `src/components/vision/AppSidebar.jsx` | **Edit** | Add `gates` entry to VIEWS array, add pending count badge |
| `src/components/vision/ItemDetailPanel.jsx` | **Edit** | Add lifecycle section (phase, feature code, phase history) with gate banner and action buttons when `item.lifecycle` is present |
| `test/gate-view.test.js` | **Create** | GateView rendering — pending/resolved sections, action button callbacks, artifact assessment display, phase label rendering |
| `test/gate-store.test.js` | **Create** | useVisionStore gate integration — `visionState` hydration of gates, `gatePending` direct state update + fetch, `gateResolved` optimistic update, `gateEvent` emission, `resolveGate` fetch call |
| `test/gate-wiring.test.js` | **Create** | VisionTracker/AppSidebar wiring — pending count badge, `activeView` switch on toast click, gate prop threading to GateView and ItemDetailPanel |
