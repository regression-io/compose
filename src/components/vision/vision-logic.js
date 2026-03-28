/**
 * vision-logic.js — Pure logic functions shared across Vision Tracker views.
 *
 * All functions are side-effect-free and DOM/JSX-free so they can be
 * imported and unit-tested directly with Node's built-in test runner.
 *
 */

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
