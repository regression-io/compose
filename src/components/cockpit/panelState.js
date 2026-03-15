/**
 * panelState.js
 *
 * Persistence helpers for the cockpit's boolean panel-visibility flags:
 *   compose:sidebarOpen       — left sidebar (default: true)
 *   compose:contextPanelOpen  — right context panel (default: false)
 *
 * No React imports; fully testable in Node.js.
 * Follows the same load/save convention as agentBarState.js and viewTabsState.js.
 */

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

/**
 * Loads a boolean flag from localStorage.
 * Returns `fallback` when the key is absent, the environment has no
 * localStorage (SSR/test), or the stored value cannot be parsed.
 *
 * Serialisation convention: stored as the string "true" or "false".
 * Any value that is not the string "false" is treated as true (i.e. the
 * falsy sentinel is explicit).
 */
export function loadPanelOpen(key, fallback) {
  try {
    const v = globalThis.localStorage?.getItem(key);
    if (v === null || v === undefined) return fallback;
    return v !== 'false';
  } catch {
    return fallback;
  }
}

/**
 * Persists a boolean panel-visibility flag.
 * Stores the canonical string "true" or "false".
 * Silent no-op if localStorage is unavailable.
 */
export function savePanelOpen(key, value) {
  try {
    globalThis.localStorage?.setItem(key, String(Boolean(value)));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Named keys (single source of truth)
// ---------------------------------------------------------------------------

export const SIDEBAR_OPEN_KEY  = 'compose:sidebarOpen';
export const CONTEXT_OPEN_KEY  = 'compose:contextPanelOpen';

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

export function loadSidebarOpen()          { return loadPanelOpen(SIDEBAR_OPEN_KEY,  true);  }
export function saveSidebarOpen(value)     { return savePanelOpen(SIDEBAR_OPEN_KEY,  value); }

export function loadContextOpen()          { return loadPanelOpen(CONTEXT_OPEN_KEY, false); }
export function saveContextOpen(value)     { return savePanelOpen(CONTEXT_OPEN_KEY, value); }
