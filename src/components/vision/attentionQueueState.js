/**
 * attentionQueueState.js
 *
 * Pure logic for the AttentionQueueSidebar (COMP-UI-2).
 * All functions are stateless and importable in both browser and Node.js
 * (no DOM / React dependencies), enabling straightforward unit-testing.
 */

// ---------------------------------------------------------------------------
// Priority constants — higher number = higher urgency
// ---------------------------------------------------------------------------

export const ATTENTION_PRIORITY = {
  DECISION: 1,
  PENDING_GATE: 2,
  BLOCKED: 3,
};

// ---------------------------------------------------------------------------
// computeAttentionQueue
// ---------------------------------------------------------------------------

/**
 * Derives a priority-sorted attention queue from items + gates.
 *
 * Rules:
 *   • blocked items            → BLOCKED priority
 *   • items with pending gates → PENDING_GATE priority
 *   • unresolved decisions     → DECISION priority (unless complete/killed/parked)
 *
 * An item appears at most once, at its highest applicable priority.
 *
 * @param {object[]} items  VisionItem array
 * @param {object[]} gates  Gate array
 * @returns {{ item: object, priority: number, reason: string }[]}
 */
export function computeAttentionQueue(items, gates) {
  // Build a set of itemIds that have at least one pending gate
  const pendingGateItemIds = new Set(
    (gates || []).filter(g => g.status === 'pending').map(g => g.itemId)
  );

  /** @type {Map<string, { item: object, priority: number, reason: string }>} */
  const queue = new Map();

  const setPriority = (item, priority, reason) => {
    const existing = queue.get(item.id);
    if (!existing || priority > existing.priority) {
      queue.set(item.id, { item, priority, reason });
    }
  };

  for (const item of items || []) {
    // Blocked items — highest priority
    if (item.status === 'blocked') {
      setPriority(item, ATTENTION_PRIORITY.BLOCKED, 'Blocked');
    }

    // Items with pending gates — second highest
    if (pendingGateItemIds.has(item.id)) {
      setPriority(item, ATTENTION_PRIORITY.PENDING_GATE, 'Pending gate');
    }

    // Unresolved decisions — third priority
    if (
      item.type === 'decision' &&
      item.status !== 'complete' &&
      item.status !== 'killed' &&
      item.status !== 'parked'
    ) {
      setPriority(item, ATTENTION_PRIORITY.DECISION, 'Open decision');
    }
  }

  // Sort descending by priority (highest urgency first)
  return Array.from(queue.values()).sort((a, b) => b.priority - a.priority);
}

// ---------------------------------------------------------------------------
// buildProgress
// ---------------------------------------------------------------------------

/**
 * Normalises an activeBuild record into display-ready metrics.
 *
 * @param {object|null|undefined} activeBuild  The activeBuild from useVisionStore
 * @returns {{
 *   isRunning: boolean,
 *   pct: number,
 *   stepLabel: string,
 *   featureCode: string,
 *   stepNum: number,
 *   totalSteps: number,
 *   status: string,
 * }}
 */
export function buildProgress(activeBuild) {
  if (!activeBuild) {
    return {
      isRunning: false,
      pct: 0,
      stepLabel: '',
      featureCode: '',
      stepNum: 0,
      totalSteps: 0,
      status: '',
    };
  }

  const { currentStepId, stepNum, totalSteps, status, featureCode } = activeBuild;
  const isRunning = status === 'running';
  const raw = totalSteps > 0 ? (stepNum / totalSteps) * 100 : 0;
  const pct = Math.min(100, Math.max(0, Math.round(raw)));

  // Human-readable step label: capitalise and replace underscores
  const stepLabel = currentStepId
    ? currentStepId.charAt(0).toUpperCase() + currentStepId.slice(1).replace(/_/g, ' ')
    : '';

  return {
    isRunning,
    pct,
    stepLabel,
    featureCode: featureCode || '',
    stepNum: stepNum ?? 0,
    totalSteps: totalSteps ?? 0,
    status: status || '',
  };
}

// ---------------------------------------------------------------------------
// compactStats
// ---------------------------------------------------------------------------

/**
 * Aggregates key metrics from items + gates for the compact stats header.
 *
 * @param {object[]} items  VisionItem array
 * @param {object[]} gates  Gate array
 * @returns {{
 *   total: number,
 *   inProgress: number,
 *   blocked: number,
 *   pendingGates: number,
 *   attentionCount: number,
 * }}
 */
export function compactStats(items, gates) {
  const safeItems = items || [];
  const safeGates = gates || [];

  let inProgress = 0;
  let blocked = 0;
  let attentionCount = 0;

  for (const item of safeItems) {
    if (item.status === 'in_progress') inProgress++;
    if (item.status === 'blocked') blocked++;
  }

  const pendingGates = safeGates.filter(g => g.status === 'pending' || g.status === 'awaiting').length;
  attentionCount = computeAttentionQueue(safeItems, safeGates).length;

  return {
    total: safeItems.length,
    inProgress,
    blocked,
    pendingGates,
    attentionCount,
  };
}

// ---------------------------------------------------------------------------
// togglePhase
// ---------------------------------------------------------------------------

/**
 * Toggles a phase filter selection.
 * Clicking an already-active phase deselects it (returns null).
 * Clicking a different phase selects it.
 *
 * @param {string|null|undefined} current  Currently selected phase key, or null/falsy
 * @param {string} phaseKey                Phase key to activate
 * @returns {string|null}
 */
export function togglePhase(current, phaseKey) {
  if (current && current === phaseKey) return null;
  return phaseKey;
}
