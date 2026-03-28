/**
 * graphOpsOverlays.js — Pure logic for COMP-UX-1c graph ops overlays.
 *
 * No React, no DOM — just data transforms for build-state visualization.
 */

import { GRAPH_AGENT_COLORS } from './constants.js';

// ─── Constants ──────────────────────────────────────────────────────────────

export const BUILD_STATES = {
  building: 'building',
  gate_pending: 'gate_pending',
  blocked_downstream: 'blocked_downstream',
  error: 'error',
};

// Edge types that propagate blocking downstream
const BLOCKING_EDGE_TYPES = new Set(['blocks', 'informs']);

/**
 * Find an item by featureCode. Checks item.featureCode first, then falls back
 * to checking if item.title starts with the code (for items where featureCode is null).
 */
function findItemByFeatureCode(items, code) {
  return items.find(i => i.featureCode === code)
    || items.find(i => i.title === code)
    || items.find(i => i.title && i.title.startsWith(code + ':'));
}

/**
 * Get the featureCode identifier for an item.
 * Prefers item.featureCode, falls back to title prefix before ':'.
 */
function getItemFeatureCode(item) {
  if (item.featureCode) return item.featureCode;
  if (item.title && item.title.includes(':')) return item.title.split(':')[0].trim();
  return item.title || item.id;
}

// ─── Functions ──────────────────────────────────────────────────────────────

/**
 * Compute a map of featureCode → buildState from the active build context.
 *
 * Priority (highest wins):
 *   1. error      — build status is 'failed'
 *   2. gate_pending — current step ends with '_gate' and has unresolved gates
 *   3. building   — build status is 'running'
 *   4. blocked_downstream — transitive successor of a building/gate_pending node
 *
 * @param {object|null} activeBuild  The activeBuild from useVisionStore
 * @param {Array} items              Vision items
 * @param {Array} connections        Vision connections
 * @param {Array} gates              Pending gates
 * @returns {Object}                 Map of featureCode → buildState string
 */
export function computeBuildStateMap(activeBuild, items, connections, gates) {
  if (!activeBuild) return {};

  const result = {};
  const { featureCode, status, currentStepId } = activeBuild;

  if (!featureCode) return {};

  // Determine primary state for the build target
  if (status === 'failed') {
    result[featureCode] = BUILD_STATES.error;
  } else if (status === 'running') {
    // Check if we're at a gate step with unresolved gates
    const isAtGate = currentStepId && currentStepId.endsWith('_gate');
    const featureItem = findItemByFeatureCode(items, featureCode);
    const hasUnresolvedGate = isAtGate && featureItem && gates.some(
      g => g.itemId === featureItem.id && !g.resolvedAt
    );

    if (hasUnresolvedGate) {
      result[featureCode] = BUILD_STATES.gate_pending;
    } else {
      result[featureCode] = BUILD_STATES.building;
    }
  }

  // Find the item ID for the build target to compute downstream blocking
  const buildItem = findItemByFeatureCode(items, featureCode);
  if (buildItem && (result[featureCode] === BUILD_STATES.building || result[featureCode] === BUILD_STATES.gate_pending)) {
    const blockerIds = new Set([buildItem.id]);
    const downstreamIds = getDownstreamBlockedIds(blockerIds, connections);

    // Build a reverse lookup: itemId → featureCode
    const idToCode = new Map(items.map(i => [i.id, getItemFeatureCode(i)]));

    for (const id of downstreamIds) {
      const code = idToCode.get(id);
      if (code && !result[code]) {
        result[code] = BUILD_STATES.blocked_downstream;
      }
    }
  }

  return result;
}

/**
 * Given a set of blocker node IDs, find all transitively downstream node IDs
 * via 'blocks' and 'informs' edges.
 *
 * Uses BFS to handle cycles safely.
 *
 * @param {Set<string>} blockerIds   IDs of nodes that are blocking
 * @param {Array} connections        All connections [{fromId, toId, type}]
 * @returns {Set<string>}            IDs of all downstream blocked nodes (excludes blockerIds)
 */
export function getDownstreamBlockedIds(blockerIds, connections) {
  if (!blockerIds.size || !connections.length) return new Set();

  // Build adjacency list for blocking edges (fromId → [toId])
  const adj = new Map();
  for (const conn of connections) {
    if (!BLOCKING_EDGE_TYPES.has(conn.type)) continue;
    if (!adj.has(conn.fromId)) adj.set(conn.fromId, []);
    adj.get(conn.fromId).push(conn.toId);
  }

  // BFS from all blocker nodes
  const visited = new Set(blockerIds);
  const queue = [...blockerIds];
  const downstream = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    const neighbors = adj.get(current) || [];
    for (const next of neighbors) {
      if (!visited.has(next)) {
        visited.add(next);
        downstream.add(next);
        queue.push(next);
      }
    }
  }

  return downstream;
}

// ─── COMP-VIS-1: Agent communication overlay ─────────────────────────────────

/**
 * Derive Cytoscape elements for the agent communication overlay.
 * Pure function — no side effects.
 *
 * @param {Array} spawnedAgents - From useVisionStore.spawnedAgents
 * @param {Array} agentRelays - From useVisionStore.agentRelays
 * @returns {{ nodes: Array, edges: Array, activeEdgeIds: Set }}
 */
export function computeAgentOverlay(spawnedAgents, agentRelays) {
  if (!spawnedAgents || !spawnedAgents.length) {
    return { nodes: [], edges: [], activeEdgeIds: new Set() };
  }

  const nodes = [];
  const edgeMap = new Map();

  // Compound group
  nodes.push({
    data: { id: 'agent-topology', label: 'Agent Topology', isAgentGroup: true },
  });

  // Root session node
  nodes.push({
    data: {
      id: 'agent-session',
      label: 'Session',
      isAgentNode: true,
      agentType: 'session',
      agentStatus: 'running',
      agentColor: '#64748b',
      parent: 'agent-topology',
    },
  });

  // Build set of known agent IDs for parent lookup
  const agentIdSet = new Set(spawnedAgents.map(a => a.agentId));

  // Agent nodes
  for (const agent of spawnedAgents) {
    const type = agent.agentType || 'claude';
    const color = GRAPH_AGENT_COLORS[type] || '#3b82f6';
    nodes.push({
      data: {
        id: `agent-${agent.agentId}`,
        label: `${type}\n${agent.agentId.slice(0, 6)}`,
        isAgentNode: true,
        agentType: type,
        agentStatus: agent.status || 'running',
        agentColor: color,
        parent: 'agent-topology',
      },
    });

    // Hierarchy edge (parent → child)
    // parentSessionId may be a session ID (not an agent) — fall back to root if not a known agent
    const parentIsAgent = agent.parentSessionId && agentIdSet.has(agent.parentSessionId);
    const parentId = parentIsAgent ? `agent-${agent.parentSessionId}` : 'agent-session';
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
  const resolveNodeId = (id) => {
    if (id === 'session') return 'agent-session';
    // If the ID is a known agent, use agent-<id>; otherwise treat as root session
    return agentIdSet.has(id) ? `agent-${id}` : 'agent-session';
  };
  for (const relay of (agentRelays || [])) {
    if (new Date(relay.timestamp).getTime() < cutoff) continue;
    const fromId = resolveNodeId(relay.fromAgentId);
    const toId = resolveNodeId(relay.toAgentId);
    // Edges are always parent→child; direction determines animation style
    const edgeId = relay.direction === 'dispatch'
      ? `relay-${fromId}-${toId}`
      : `relay-${toId}-${fromId}`;
    activeEdgeIds.add(edgeId);
  }

  return { nodes, edges: [...edgeMap.values()], activeEdgeIds };
}
