/**
 * vision-logic.js — Pure logic functions shared across Vision Tracker views.
 *
 * All functions are side-effect-free and DOM/JSX-free so they can be
 * imported and unit-tested directly with Node's built-in test runner.
 *
 * Consumers:
 *   BoardView.jsx      → (GATED_STATUSES from constants; gate check inlined)
 *   ItemListView.jsx   → filterItems, sortItems, groupItems, groupLabel, relativeTime
 *   RoadmapView.jsx    → getChildren, countDescendants, rollupStatus, CHILD_EDGE_TYPES
 *   SessionsView.jsx   → filterSessions, relativeTime
 */

import { STATUSES, PHASES, PHASE_LABELS } from './constants.js';

// ─── Shared utilities ─────────────────────────────────────────────────────────

/**
 * Formats an ISO timestamp as a relative time string (e.g. "5m", "3h", "2d").
 * For dates older than 7 days, falls back to a locale date string.
 *
 * @param {string|null} isoString
 * @returns {string}
 */
export function relativeTime(isoString) {
  if (!isoString) return '';
  const diffMs = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return new Date(isoString).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ─── BoardView ────────────────────────────────────────────────────────────────

/**
 * Returns true when the drag should be blocked.
 *
 * @param {string}   itemId       - ID of the item being dragged
 * @param {string}   newStatus    - Target column status
 * @param {Set}      gatedStatuses - Set of statuses that require a gate (e.g. GATED_STATUSES)
 * @param {Array}    gates        - All gate objects from the vision store
 * @returns {boolean}
 */
export function isGateBlocked(itemId, newStatus, gatedStatuses, gates = []) {
  if (!gatedStatuses.has(newStatus)) return false;
  return (gates || []).some(g => g.itemId === itemId && g.status === 'pending');
}

// ─── ItemListView ─────────────────────────────────────────────────────────────

const STATUS_ORDER = Object.fromEntries(STATUSES.map((s, i) => [s, i]));

/**
 * Returns a new array sorted by the given dimension.
 *
 * @param {Array}  items
 * @param {string} sortBy - 'confidence' | 'updated' | 'status' | 'alpha'
 * @returns {Array}
 */
export function sortItems(items, sortBy) {
  const sorted = [...items];
  switch (sortBy) {
    case 'confidence':
      sorted.sort((a, b) => (a.confidence || 0) - (b.confidence || 0));
      break;
    case 'updated':
      sorted.sort((a, b) => {
        const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return tb - ta;
      });
      break;
    case 'status':
      sorted.sort((a, b) => (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99));
      break;
    case 'alpha':
      sorted.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      break;
    default:
      sorted.sort((a, b) => (a.confidence || 0) - (b.confidence || 0));
  }
  return sorted;
}

/**
 * Groups items into a Map keyed by group value.
 *
 * @param {Array}  items
 * @param {string} groupBy - 'phase' | 'type' | 'status' | 'none'
 * @returns {Map}
 */
export function groupItems(items, groupBy) {
  const map = new Map();
  switch (groupBy) {
    case 'phase':
      for (const phase of PHASES) map.set(phase, []);
      for (const item of items) {
        const key = item.phase || 'vision';
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(item);
      }
      break;
    case 'type':
      for (const item of items) {
        const key = item.type || 'task';
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(item);
      }
      break;
    case 'status':
      for (const s of STATUSES) map.set(s, []);
      for (const item of items) {
        const key = item.status || 'planned';
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(item);
      }
      break;
    case 'none':
      map.set('all', [...items]);
      break;
    default:
      map.set('all', [...items]);
  }
  return map;
}

/**
 * Returns a human-readable label for a group key.
 *
 * @param {string} groupBy
 * @param {string} key
 * @returns {string}
 */
export function groupLabel(groupBy, key) {
  switch (groupBy) {
    case 'phase': return PHASE_LABELS[key] || key;
    case 'type':  return key.charAt(0).toUpperCase() + key.slice(1);
    case 'status': return key.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
    case 'none':   return 'All Items';
    default:       return key;
  }
}

/**
 * Filters items by all active filter dimensions.
 *
 * @param {Array} items
 * @param {Object} filters
 * @param {string} [filters.search='']
 * @param {string} [filters.statusFilter='all']
 * @param {string} [filters.phaseFilter='all']
 * @param {string} [filters.typeFilter='all']
 * @param {string} [filters.agentFilter='all']
 * @returns {Array}
 */
export function filterItems(items, {
  search = '',
  statusFilter = 'all',
  phaseFilter  = 'all',
  typeFilter   = 'all',
  agentFilter  = 'all',
} = {}) {
  let out = items;
  if (search) {
    const q = search.toLowerCase();
    out = out.filter(i =>
      i.title?.toLowerCase().includes(q) ||
      i.featureCode?.toLowerCase().includes(q) ||
      i.feature_code?.toLowerCase().includes(q) ||
      i.lifecycle?.featureCode?.toLowerCase().includes(q)
    );
  }
  if (statusFilter !== 'all') out = out.filter(i => i.status === statusFilter);
  if (phaseFilter  !== 'all') out = out.filter(i => i.phase  === phaseFilter);
  if (typeFilter   !== 'all') out = out.filter(i => i.type   === typeFilter);
  if (agentFilter  !== 'all') {
    out = out.filter(i => (i.assignedTo || i.assigned_to || 'unassigned') === agentFilter);
  }
  return out;
}

// ─── RoadmapView ──────────────────────────────────────────────────────────────

/** Edge types that define parent-child hierarchy (child→parent direction) */
export const CHILD_EDGE_TYPES = new Set(['implements', 'supports', 'contradicts']);

/**
 * Returns all direct children of a parent item.
 * Children are discovered via parentId field and via CHILD_EDGE_TYPES connections.
 *
 * @param {string} parentId
 * @param {Array}  items
 * @param {Array}  connections
 * @returns {Array}
 */
export function getChildren(parentId, items, connections) {
  const childIds = new Set();

  // Via parentId field
  for (const item of items) {
    if (item.parentId === parentId) childIds.add(item.id);
  }

  // Via child-edge connections (child → parent)
  for (const conn of connections) {
    if (conn.toId === parentId && CHILD_EDGE_TYPES.has(conn.type)) {
      childIds.add(conn.fromId);
    }
  }

  const itemsById = new Map(items.map(i => [i.id, i]));
  return [...childIds].map(id => itemsById.get(id)).filter(Boolean);
}

/**
 * Recursively counts total and done descendants.
 * Includes cycle protection via the visited set.
 *
 * @param {string} parentId
 * @param {Array}  items
 * @param {Array}  connections
 * @param {Set}    [visited=new Set()]
 * @returns {{ total: number, done: number }}
 */
export function countDescendants(parentId, items, connections, visited = new Set()) {
  if (visited.has(parentId)) return { total: 0, done: 0 };
  visited.add(parentId);

  const children = getChildren(parentId, items, connections);
  let total = children.length;
  let done  = children.filter(c => c.status === 'complete' || c.status === 'approved').length;

  for (const child of children) {
    const sub = countDescendants(child.id, items, connections, visited);
    total += sub.total;
    done  += sub.done;
  }

  return { total, done };
}

/**
 * Computes the rolled-up status for a set of child items.
 *
 * Rules:
 *   all complete/approved  → 'complete'
 *   any active (in_progress/review/ready) or partial complete → 'in_progress'
 *   otherwise → 'planned'
 *
 * @param {Array} items
 * @returns {string}
 */
export function rollupStatus(items) {
  if (items.length === 0) return 'planned';
  const complete = items.filter(i => i.status === 'complete' || i.status === 'approved').length;
  if (complete === items.length) return 'complete';
  const active = items.some(i =>
    i.status === 'in_progress' || i.status === 'review' || i.status === 'ready'
  );
  if (active || complete > 0) return 'in_progress';
  return 'planned';
}

// ─── SessionsView ─────────────────────────────────────────────────────────────

/**
 * Filters and sorts sessions.
 * Active sessions always sort first; then by most-recent startedAt.
 *
 * @param {Array} sessions
 * @param {Object} filters
 * @param {string} [filters.search='']
 * @param {string} [filters.agentFilter='all']
 * @param {string} [filters.statusFilter='all']
 * @returns {Array}
 */
export function filterSessions(sessions, {
  search       = '',
  agentFilter  = 'all',
  statusFilter = 'all',
} = {}) {
  let out = sessions;
  if (search) {
    const q = search.toLowerCase();
    out = out.filter(s =>
      s.featureCode?.toLowerCase().includes(q) ||
      s.feature_code?.toLowerCase().includes(q) ||
      s.summary?.toLowerCase().includes(q) ||
      s.agent?.toLowerCase().includes(q)
    );
  }
  if (agentFilter  !== 'all') out = out.filter(s => s.agent  === agentFilter);
  if (statusFilter !== 'all') out = out.filter(s => s.status === statusFilter);

  return [...out].sort((a, b) => {
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (b.status === 'active' && a.status !== 'active') return 1;
    return new Date(b.startedAt || b.created_date || 0) - new Date(a.startedAt || a.created_date || 0);
  });
}
