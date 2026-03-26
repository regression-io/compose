# COMP-VIS-1: Implementation Blueprint

**Status:** BLUEPRINT
**Date:** 2026-03-26
**Design:** [design.md](design.md)

---

## File Plan

| File | Action | Lines | Purpose |
|------|--------|-------|---------|
| `server/agent-spawn.js` (existing) | modify | ~106 total | Emit `agentRelay` events on spawn and complete |
| `src/components/vision/visionMessageHandler.js` (existing) | modify | ~213 total | Handle `agentRelay` message type, update store |
| `src/components/vision/useVisionStore.js` (existing) | modify | ~315 total | Add `agentRelays` state + setter, add to teardown |
| `src/components/vision/graphOpsOverlays.js` (existing) | modify | ~149 total | Add `computeAgentOverlay()` function |
| `src/components/vision/GraphView.jsx` (existing) | modify | ~797 total | Agent overlay nodes/edges, relay animation, toolbar toggle |
| `src/App.jsx` (existing) | modify | ~1020 total | Pass `spawnedAgents` + `agentRelays` to CockpitView → GraphView |

---

## Detailed Changes

### 1. `server/agent-spawn.js` — Emit `agentRelay` events

**Context:** The POST `/api/agent/spawn` route (lines 77-106) already emits `agentSpawned` and `agentComplete` via `broadcastMessage()`. Both events fire from the same route handler.

**Change:** After each existing `broadcastMessage({ type: 'agentSpawned', ... })` call, add a parallel `broadcastMessage({ type: 'agentRelay', ... })`. Same for `agentComplete`.

```javascript
// After agentSpawned broadcast (~line 90):
broadcastMessage({
  type: 'agentRelay',
  fromAgentId: parentSessionId || 'session',
  toAgentId: agentId,
  direction: 'dispatch',
  messagePreview: (prompt || '').slice(0, 80),
  timestamp: new Date().toISOString(),
});

// After agentComplete broadcast (~line 100):
broadcastMessage({
  type: 'agentRelay',
  fromAgentId: agentId,
  toAgentId: parentSessionId || 'session',
  direction: 'result',
  messagePreview: (output || '').slice(0, 80),
  timestamp: new Date().toISOString(),
});
```

**Pattern:** Follows the exact same `broadcastMessage()` pattern used by existing events. No new routes or middleware.

### 2. `src/components/vision/visionMessageHandler.js` — Handle `agentRelay`

**Context:** Message handler is a switch-like series of `if (msg.type === ...)` blocks (lines 20-213). Each block calls setter functions passed in from useVisionStore. `agentSpawned` is at lines 63-70, `agentComplete` at lines 72-77.

**Change:** Add a new handler block after the `agentComplete` handler (~line 78):

```javascript
if (msg.type === 'agentRelay') {
  setters.setAgentRelays(prev => {
    const next = [...prev, msg].slice(-50);  // Sliding window, max 50
    return next;
  });
  return;
}
```

**Pattern:** Identical to `agentActivity` handler (lines 52-61) which also appends to an array with a max cap.

### 3. `src/components/vision/useVisionStore.js` — Add state + setter

**Context:** Zustand store at line 81. State fields at lines 217-231. Setters passed to handleVisionMessage at lines 127-155.

**Changes:**

a) Add initial state (after `spawnedAgents: []` at line 225):
```javascript
agentRelays: [],
```

b) Add setter in the handleVisionMessage call (after `setSpawnedAgents` at line 151):
```javascript
setAgentRelays: (updater) => set(s => ({ agentRelays: typeof updater === 'function' ? updater(s.agentRelays) : updater })),
```

c) No new interval needed — relays are event-driven, not polled.

d) No teardown change needed — no new refs/intervals.

### 4. `src/components/vision/graphOpsOverlays.js` — Add `computeAgentOverlay()`

**Context:** File exports `computeBuildStateMap()` (lines 67-104) which is a pure function taking `(activeBuild, items, connections, gates)` and returning a `featureCode → buildState` map. Used in App.jsx line 556-557.

**Change:** Add new exported function `computeAgentOverlay()`:

```javascript
/**
 * Derive Cytoscape elements for the agent communication overlay.
 * Pure function — no side effects.
 *
 * @param {Array} spawnedAgents - From useVisionStore.spawnedAgents
 * @param {Array} agentRelays - From useVisionStore.agentRelays
 * @returns {{ nodes: Array, edges: Array, activeEdgeIds: Set }}
 */
export function computeAgentOverlay(spawnedAgents, agentRelays) {
  if (!spawnedAgents.length) return { nodes: [], edges: [], activeEdgeIds: new Set() };

  const AGENT_COLORS = {
    'compose-explorer': '#06b6d4',
    'compose-architect': '#a855f7',
    codex: '#10b981',
    claude: '#3b82f6',
  };

  const nodes = [];
  const edgeMap = new Map();

  // Root session node
  nodes.push({
    data: {
      id: 'agent-session',
      label: 'Session',
      isAgentNode: true,
      agentType: 'session',
      agentStatus: 'running',
      parent: 'agent-topology',
    },
  });

  // Compound group
  nodes.push({
    data: { id: 'agent-topology', label: 'Agent Topology', isAgentGroup: true },
  });

  // Agent nodes
  for (const agent of spawnedAgents) {
    const type = agent.agentType || 'claude';
    nodes.push({
      data: {
        id: `agent-${agent.agentId}`,
        label: `${type}\n${agent.agentId.slice(0, 6)}`,
        isAgentNode: true,
        agentType: type,
        agentStatus: agent.status || 'running',
        agentColor: AGENT_COLORS[type] || '#3b82f6',
        parent: 'agent-topology',
      },
    });

    // Static hierarchy edge (parent → child)
    const parentId = agent.parentSessionId ? `agent-${agent.parentSessionId}` : 'agent-session';
    const edgeId = `relay-${parentId}-agent-${agent.agentId}`;
    if (!edgeMap.has(edgeId)) {
      edgeMap.set(edgeId, {
        data: {
          id: edgeId,
          source: parentId,
          target: `agent-${agent.agentId}`,
          isRelayEdge: true,
        },
      });
    }
  }

  // Determine which edges are actively relaying (last 30s)
  const cutoff = Date.now() - 30_000;
  const activeEdgeIds = new Set();
  for (const relay of agentRelays) {
    if (new Date(relay.timestamp).getTime() < cutoff) continue;
    const fromId = relay.fromAgentId === 'session' ? 'agent-session' : `agent-${relay.fromAgentId}`;
    const toId = relay.toAgentId === 'session' ? 'agent-session' : `agent-${relay.toAgentId}`;
    // Edges are always parent→child direction; direction field determines animation direction
    const edgeId = relay.direction === 'dispatch' ? `relay-${fromId}-${toId}` : `relay-${toId}-${fromId}`;
    activeEdgeIds.add(edgeId);
  }

  return { nodes, edges: [...edgeMap.values()], activeEdgeIds };
}
```

**Pattern:** Same pure-function pattern as `computeBuildStateMap()`. Called from App.jsx in a `useMemo`.

### 5. `src/components/vision/GraphView.jsx` — Overlay rendering + animation

**Context:**
- Props at line 366: `{ items, connections, selectedItemId, onSelect, visibleTracks, hiddenGroups, buildStateMap, resolveGate, gates }`
- `buildElements()` at line 84 builds Cytoscape elements from items + connections
- `buildStylesheet()` at line 164 returns static Cytoscape styles
- Build state overlay applied in useEffect at lines 499-513
- Build pulse animation in useEffect at lines 515-530
- Toolbar at lines 584-607

**Changes:**

a) **New props:** Add `spawnedAgents`, `agentRelays`, `agentOverlay` to the function signature (line 366).

b) **Extend `buildElements()`** (~line 84): After building vision item nodes/edges, conditionally append agent overlay nodes and edges:
```javascript
// At end of buildElements, before return:
if (agentOverlay && agentOverlay.nodes.length > 0) {
  elements.push(...agentOverlay.nodes);
  elements.push(...agentOverlay.edges);
}
```

Actually — `buildElements` is called from a `useMemo` with `[filteredItems, filteredConnections, grouped]` deps. The agent overlay should be a **separate elements merge** to avoid recalculating vision items when only agent state changes. Better approach:

b-revised) **Merge elements in the `useMemo`** that feeds Cytoscape:
```javascript
const elements = useMemo(() => {
  const base = buildElements(filteredItems, filteredConnections, grouped);
  if (showAgentTopology && agentOverlay) {
    return [...base, ...agentOverlay.nodes, ...agentOverlay.edges];
  }
  return base;
}, [filteredItems, filteredConnections, grouped, showAgentTopology, agentOverlay]);
```

c) **Extend `buildStylesheet()`** — add agent node and relay edge styles after the build state styles (after line 224):

```javascript
// Agent overlay — nodes
{ selector: '[?isAgentGroup]', style: {
  'label': 'data(label)', 'text-valign': 'top', 'text-halign': 'center',
  'font-size': '9px', 'color': '#64748b', 'text-transform': 'uppercase',
  'background-color': '#0f1a2b', 'border-width': 1, 'border-color': '#1e3050',
  'border-style': 'dashed', 'padding': '14px',
}},
{ selector: '[?isAgentNode]', style: {
  'label': 'data(label)', 'text-valign': 'center', 'text-halign': 'center',
  'font-size': '8px', 'font-family': 'monospace', 'color': '#e2e8f0',
  'text-wrap': 'wrap', 'text-max-width': '70px',
  'width': '80px', 'height': '40px', 'shape': 'diamond',
  'background-color': '#1e293b',
  'border-style': 'solid', 'border-width': 2, 'border-color': 'data(agentColor)',
}},
{ selector: '[agentStatus="complete"]', style: { 'border-style': 'dashed', 'opacity': 0.6 }},
{ selector: '[agentStatus="failed"]', style: { 'border-color': '#ef4444', 'border-style': 'dashed', 'opacity': 0.6 }},
// Agent overlay — relay edges
{ selector: '[?isRelayEdge]', style: {
  'width': 1, 'line-color': '#475569', 'line-style': 'dashed',
  'line-dash-pattern': [8, 4],
  'target-arrow-color': '#475569', 'target-arrow-shape': 'triangle',
  'arrow-scale': 0.6, 'curve-style': 'bezier', 'opacity': 0.4,
}},
{ selector: '.relay-active', style: {
  'width': 2, 'line-color': '#3b82f6', 'opacity': 0.8,
  'target-arrow-color': '#3b82f6',
}},
{ selector: '.relay-result', style: {
  'width': 2, 'line-color': '#10b981', 'opacity': 0.8,
  'target-arrow-color': '#10b981',
}},
```

d) **Relay animation useEffect** — after the build pulse useEffect (after line 530):

```javascript
// COMP-VIS-1: Marching ants animation for active relay edges
useEffect(() => {
  const cy = cyRef.current;
  if (!cy || !agentOverlay?.activeEdgeIds?.size) return;

  // Apply/remove relay-active class
  cy.edges('[?isRelayEdge]').removeClass('relay-active relay-result');
  for (const edgeId of agentOverlay.activeEdgeIds) {
    const edge = cy.getElementById(edgeId);
    if (edge.length) {
      // Check latest relay direction for this edge
      const latestRelay = agentRelays.findLast(r => {
        const fromId = r.fromAgentId === 'session' ? 'agent-session' : `agent-${r.fromAgentId}`;
        const toId = r.toAgentId === 'session' ? 'agent-session' : `agent-${r.toAgentId}`;
        const eid = r.direction === 'dispatch' ? `relay-${fromId}-${toId}` : `relay-${toId}-${fromId}`;
        return eid === edgeId;
      });
      edge.addClass(latestRelay?.direction === 'result' ? 'relay-result' : 'relay-active');
    }
  }

  // Marching ants interval
  const interval = setInterval(() => {
    const edges = cy.edges('.relay-active, .relay-result');
    if (!edges.length) return;
    const offset = (Date.now() / 20) % 100;
    edges.style('line-dash-offset', -offset);
  }, 50);

  return () => clearInterval(interval);
}, [agentOverlay?.activeEdgeIds, agentRelays]);
```

e) **Toolbar toggle** — add to the right side of the toolbar (after the Group button at line 599):

```jsx
<FilterBtn
  active={showAgentTopology}
  onClick={() => setShowAgentTopology(v => !v)}
  title="Show/hide agent topology"
>
  Agents
</FilterBtn>
```

f) **Auto-enable state** — new state + effect:
```javascript
const [showAgentTopology, setShowAgentTopology] = useState(false);

// Auto-enable when agents spawn, auto-disable when all complete
useEffect(() => {
  if (spawnedAgents?.length > 0 && spawnedAgents.some(a => a.status === 'running')) {
    setShowAgentTopology(true);
  } else if (spawnedAgents?.every(a => a.status !== 'running')) {
    // Don't auto-disable — let user dismiss manually
  }
}, [spawnedAgents]);
```

### 6. `src/App.jsx` — Prop threading

**Context:** App.jsx renders `CockpitView` (line 206) which renders `GraphView` (line 236). `buildStateMap` is computed at line 556-557 via `useMemo` calling `computeBuildStateMap()`. `spawnedAgents` comes from useVisionStore at line 354.

**Changes:**

a) Import `computeAgentOverlay` alongside `computeBuildStateMap` (line 58):
```javascript
import { computeBuildStateMap, computeAgentOverlay } from './components/vision/graphOpsOverlays.js';
```

b) Add `agentRelays` to the store selector (after `spawnedAgents` at line 354):
```javascript
agentRelays: s.agentRelays,
```

c) Compute overlay in useMemo (after buildStateMap at line 556-557):
```javascript
const agentOverlay = useMemo(
  () => computeAgentOverlay(spawnedAgents, agentRelays),
  [spawnedAgents, agentRelays],
);
```

d) Pass new props through CockpitView → GraphView (line 236-246):
```javascript
<GraphView
  ...existing props...
  spawnedAgents={spawnedAgents}
  agentRelays={agentRelays}
  agentOverlay={agentOverlay}
/>
```

---

## Corrections Table

| Spec Assumption | Reality | Resolution |
|----------------|---------|------------|
| "53 typed IPC channels" (Meridian) | Compose uses WebSocket + REST, not Electron IPC | N/A — different architecture, WebSocket is our transport |
| Design said "new Zustand state `agentTopology`" | Not needed as separate state — `computeAgentOverlay()` derives it purely from `spawnedAgents` + `agentRelays` | Compute in App.jsx useMemo, pass as prop |
| Design said animation interval 50ms or rAF | 50ms setInterval is sufficient — rAF would couple to frame rate and add complexity | Use 50ms setInterval, same cleanup pattern as build pulse |
| Design assumed `buildElements()` takes agent overlay | `buildElements()` is a pure function of vision items — extending it would couple concerns | Merge agent overlay elements at the `useMemo` level in GraphView, keeping `buildElements()` clean |

## Verification Checklist

| Ref | File:Line | Verified |
|-----|-----------|----------|
| `broadcastMessage` in agent-spawn.js | server/agent-spawn.js:~90,~100 | From explorer: emits agentSpawned/agentComplete via broadcastMessage() |
| `handleVisionMessage` handler pattern | visionMessageHandler.js:52-77 | Read: if/return blocks with setter calls, array append with cap |
| Zustand state shape | useVisionStore.js:217-231 | Read: items, connections, spawnedAgents, etc. — agentRelays fits here |
| Setter threading | useVisionStore.js:127-155 | Read: all setters passed as object to handleVisionMessage |
| `computeBuildStateMap` pattern | graphOpsOverlays.js:67-104 | From explorer: pure function, exported, called from App.jsx useMemo |
| GraphView props | GraphView.jsx:366 | Read: destructured props, 9 current props |
| GraphView toolbar | GraphView.jsx:584-607 | Read: FilterBtn components, Sep dividers, right-side controls |
| Build pulse animation | GraphView.jsx:515-530 | Read: setInterval 800ms, cleanup in useEffect return |
| CockpitView → GraphView wiring | App.jsx:236-246 | Read: GraphView receives buildStateMap, gates, etc. |
| Store selector | App.jsx:343-354 | Read: spawnedAgents extracted from store |
| buildStateMap computation | App.jsx:556-557 | Read: useMemo with computeBuildStateMap |
| HMR teardown | useVisionStore.js:302-314 | Read: clears all refs, intervals, WS — no change needed (no new refs) |
