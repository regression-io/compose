# COMP-VIS-1: Live Agent Communication Graph

**Status:** DESIGN
**Date:** 2026-03-26

## Related Documents

- [Compose Roadmap](../../ROADMAP.md) — Phase 4, COMP-VIS-1
- [GraphView.jsx](../../../src/components/vision/GraphView.jsx) — Existing graph visualization
- [graphOpsOverlays.js](../../../src/components/vision/graphOpsOverlays.js) — Build state overlay system
- [agent-registry.js](../../../server/agent-registry.js) — Agent tracking
- [visionMessageHandler.js](../../../src/components/vision/visionMessageHandler.js) — WebSocket message dispatch

---

## Problem

Compose's Vision Surface shows what agents *are* (status, activity category) but not what they're *saying to each other*. When a compose session spawns 3-5 parallel agents, the human has no visibility into which agent is communicating with which, what direction messages flow, or whether a relay is active or stalled.

AgentPanel shows a flat list. GraphView shows vision items with build overlays. Neither shows agent communication as a live, animated topology.

Inspired by Meridian's visual agent topology — animated connection lines showing real-time message flow between agents.

---

## Goal

1. Visualize active agent-to-agent communication as animated edges on the existing GraphView
2. Show message direction and recency (packets flowing along edges)
3. Overlay agent nodes onto the vision graph without replacing existing item nodes
4. Reuse existing infrastructure: Cytoscape, WebSocket, AgentRegistry, useVisionStore

**Non-goals:** P2P agent messaging, replacing AgentPanel, multi-machine topology, agent marketplace.

---

## Decision 1: Overlay on GraphView vs Separate Topology View

**Options:**
1. **Overlay on existing GraphView** — agent nodes as a compound group alongside vision items
2. **New dedicated topology view** — separate Cytoscape instance, agent-only

**Choice: Overlay (#1)**

Reuses the existing Cytoscape instance and stylesheet system. Agents appear in spatial context with the vision items they're working on. No new view tab to maintain. The graph toolbar gets a toggle to show/hide the overlay.

---

## Decision 2: Animation Technique — Marching Ants

**Options:**
1. **Marching ants** — animate `line-dash-offset` on Cytoscape edges (native API)
2. **Canvas particle overlay** — draw moving dots on a canvas layer above Cytoscape
3. **WebGL shader** — custom edge renderer

**Choice: Marching ants (#1)**

Native Cytoscape styling. No additional rendering layer. `line-dash-offset` animated via shared interval produces smooth directional packet flow. Performant with <20 edges.

```javascript
// Animation: continuous forward motion on active relay edges
const offset = (Date.now() / 20) % 100;
edge.style('line-dash-offset', -offset);  // Negative = toward target
```

---

## Decision 3: Ephemeral Relay Events

Relay events are transient WebSocket messages, not persisted. AgentRegistry already stores the hierarchy (parentSessionId). The new `agentRelay` event captures the *communication moment* — spawn dispatches and result returns.

```javascript
// New WebSocket event
{
  type: 'agentRelay',
  fromAgentId: string,     // Parent (or 'session' for root)
  toAgentId: string,
  direction: 'dispatch' | 'result',
  messagePreview: string,  // First 80 chars
  timestamp: string
}
```

---

## Decision 4: Auto-Enable Behavior

- **Off** when no agents running
- **Auto-enables** when `spawnedAgents.length > 0`
- **Manual toggle** in graph toolbar
- When disabled, overlay nodes hidden but not destroyed (fast re-show)

---

## Architecture

### Data Flow

```
agent-spawn.js (emit agentRelay on spawn/complete)
    ↓ WebSocket
visionMessageHandler.js (handle agentRelay → update store)
    ↓ Zustand
useVisionStore.js (agentRelays[], agentTopologyEnabled)
    ↓ props
GraphView.jsx (overlay nodes + animated edges in Cytoscape)
    ↓ Cytoscape
graphOpsOverlays.js (computeAgentOverlay() — new, alongside computeBuildStateMap())
```

### Agent Node Styling

- Shape: `diamond` (distinct from round-rectangle vision items)
- Size: 80x40 (smaller than 120x48 vision items)
- Color by type: explorer = `#06b6d4`, architect = `#a855f7`, codex = `#10b981`, claude = `#3b82f6`
- Status: running = solid 2px border, complete = dashed, failed = red
- Label: agent type + short ID

### Relay Edge Styling

| State | Line | Color | Width | Animation |
|-------|------|-------|-------|-----------|
| Idle | dashed | `#475569` | 1px | None |
| Active dispatch | dashed, animated | `#3b82f6` | 2px | Marching toward child |
| Active result | dashed, animated | `#10b981` | 2px | Marching toward parent |
| Stale (>30s) | fading | `#475569` | 1px | Fade transition |

### Animation Budget

Current: build pulse (800ms interval), badge repositioning (render events).
Adding: relay animation (50ms interval or rAF, updates `line-dash-offset` on active edges).
Total well within frame budget for <20 agent nodes.

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `server/agent-spawn.js` | modify | Emit `agentRelay` events on spawn and complete |
| `src/components/vision/visionMessageHandler.js` | modify | Handle `agentRelay` message type |
| `src/components/vision/useVisionStore.js` | modify | Add `agentRelays`, `agentTopologyEnabled` state |
| `src/components/vision/graphOpsOverlays.js` | modify | Add `computeAgentOverlay()` function |
| `src/components/vision/GraphView.jsx` | modify | Agent overlay nodes/edges, relay animation interval, toolbar toggle |

## Open Questions

- [ ] Should agent nodes be positioned relative to the vision items they're working on? (Deferred — start with separate compound group, iterate based on UX)
- [ ] Should relay history be scrollable in a side panel? (Deferred — AgentPanel already shows activity)

## Acceptance Criteria

- [ ] Agent nodes appear on GraphView when `spawnedAgents.length > 0`
- [ ] Edges animate (marching ants) on `agentRelay` dispatch events
- [ ] Edges reverse-animate on `agentRelay` result events
- [ ] Relay edges fade to idle after 30s of no activity
- [ ] Toggle in graph toolbar to show/hide agent overlay
- [ ] Auto-enables when agents spawn, auto-disables when all complete
- [ ] No performance regression on graph with 100+ vision items + 10 agent nodes
- [ ] Existing build state animations (pulse, gate popover) unaffected
