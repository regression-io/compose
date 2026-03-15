/**
 * contextPanelState.js — Pure logic for context panel width computation.
 *
 * View-dependent defaults and localStorage-backed overrides.
 */

/** Default width fractions per view */
export const CONTEXT_WIDTH_DEFAULTS = {
  graph: 0.4,
  tree: 0.5,
  gates: 0.4,
  pipeline: 0.4,
  sessions: 0.4,
};

/** Views where context panel is hidden */
export const CONTEXT_HIDDEN_VIEWS = new Set(['docs']);

/** Min/max fraction bounds */
export const CONTEXT_MIN_FRACTION = 0.2;
export const CONTEXT_MAX_FRACTION = 0.6;
export const CONTEXT_MIN_PX = 280;

const STORAGE_KEY = 'compose:contextWidths';

/**
 * Load per-view width overrides from localStorage.
 * Returns plain object { viewKey: fraction }.
 */
export function loadContextWidths() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

/**
 * Save per-view width overrides to localStorage.
 */
export function saveContextWidths(overrides) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // localStorage unavailable
  }
}

/**
 * Compute effective width fraction for a view.
 * Returns 0 for hidden views.
 */
export function getContextWidth(view, overrides = {}) {
  if (CONTEXT_HIDDEN_VIEWS.has(view)) return 0;
  const override = overrides[view];
  if (override != null) return clampFraction(override);
  return CONTEXT_WIDTH_DEFAULTS[view] || 0.4;
}

/**
 * Clamp a fraction to [min, max].
 */
export function clampFraction(f) {
  return Math.max(CONTEXT_MIN_FRACTION, Math.min(CONTEXT_MAX_FRACTION, f));
}

/** Detail tab definitions */
export const DETAIL_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'errors', label: 'Errors' },
  { id: 'files', label: 'Files' },
];

export const DETAIL_TAB_IDS = DETAIL_TABS.map(t => t.id);

export function isValidDetailTab(id) {
  return DETAIL_TAB_IDS.includes(id);
}
