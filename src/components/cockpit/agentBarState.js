/**
 * agentBarState.js
 *
 * Pure state-machine logic for the cockpit's collapsible Agent Bar.
 *
 * The agent bar has three states:
 *   collapsed  — single status-line strip at the bottom (≈28 px)
 *   expanded   — message stream + chat input (~40 vh)
 *   maximized  — fills the entire main-area (flex-1)
 *
 * No React imports; fully testable in Node.js.
 */

// ---------------------------------------------------------------------------
// State constants
// ---------------------------------------------------------------------------

export const AGENT_BAR_STATES = {
  COLLAPSED: 'collapsed',
  EXPANDED: 'expanded',
  MAXIMIZED: 'maximized',
};

// ---------------------------------------------------------------------------
// Cycle: collapsed → expanded → maximized → collapsed
// ---------------------------------------------------------------------------

const CYCLE = {
  [AGENT_BAR_STATES.COLLAPSED]: AGENT_BAR_STATES.EXPANDED,
  [AGENT_BAR_STATES.EXPANDED]:  AGENT_BAR_STATES.MAXIMIZED,
  [AGENT_BAR_STATES.MAXIMIZED]: AGENT_BAR_STATES.COLLAPSED,
};

/**
 * Returns the next state in the collapse/expand/maximize cycle.
 * Unknown states fall back to 'collapsed'.
 */
export function nextAgentBarState(current) {
  return CYCLE[current] ?? AGENT_BAR_STATES.COLLAPSED;
}

// ---------------------------------------------------------------------------
// Direct transitions
// ---------------------------------------------------------------------------

export function collapseAgentBar(_current) {
  return AGENT_BAR_STATES.COLLAPSED;
}

export function expandAgentBar(_current) {
  return AGENT_BAR_STATES.EXPANDED;
}

export function maximizeAgentBar(_current) {
  return AGENT_BAR_STATES.MAXIMIZED;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_STATES = new Set(Object.values(AGENT_BAR_STATES));

/**
 * Returns true if `state` is one of the three canonical AgentBar states.
 */
export function isValidAgentBarState(state) {
  return VALID_STATES.has(state);
}

// ---------------------------------------------------------------------------
// Height / layout descriptors (Tailwind class strings)
// ---------------------------------------------------------------------------

/**
 * Returns a Tailwind height class string for the given state.
 * Components use this to size the agent-bar container.
 *
 *   collapsed → fixed strip  (h-7)
 *   expanded  → partial pane (h-[40vh])
 *   maximized → flex fill   (flex-1)  — outer container handles this
 */
export function agentBarHeightClass(state) {
  switch (state) {
    case AGENT_BAR_STATES.COLLAPSED: return 'h-7';
    case AGENT_BAR_STATES.EXPANDED:  return 'h-[40vh]';
    case AGENT_BAR_STATES.MAXIMIZED: return 'flex-1';
    default:                         return 'h-7';
  }
}

// ---------------------------------------------------------------------------
// Persistence helpers (localStorage)
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'compose:agentBarState';

/**
 * Loads the persisted agent-bar state, falling back to 'collapsed'.
 * Safe to call in SSR/test environments (no-op if localStorage is absent).
 */
export function loadAgentBarState() {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isValidAgentBarState(v) ? v : AGENT_BAR_STATES.COLLAPSED;
  } catch {
    return AGENT_BAR_STATES.COLLAPSED;
  }
}

/**
 * Persists the current agent-bar state.
 * Silent no-op if localStorage is unavailable.
 */
export function saveAgentBarState(state) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, state);
  } catch {
    // ignore
  }
}
