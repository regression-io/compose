/**
 * ContextSessionsTable — sessions table filtered to a specific feature.
 *
 * Props:
 *   featureCode {string}  feature code to filter sessions by
 *   sessions    {array}   all sessions from useVisionStore
 *   items       {array}   all items (to match feature code to item ids)
 */
import React, { useState, useMemo } from 'react';

function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function formatDuration(ms) {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export default function ContextSessionsTable({ featureCode, sessions = [], items = [] }) {
  const [expandedId, setExpandedId] = useState(null);

  // Find item IDs belonging to this feature
  const featureItemIds = useMemo(() => {
    if (!featureCode) return new Set();
    return new Set(
      items
        .filter(i => i.lifecycle?.featureCode === featureCode || i.featureCode === featureCode || i.feature_code === featureCode)
        .map(i => i.id)
    );
  }, [featureCode, items]);

  // Filter sessions that touch any of this feature's items
  const filtered = useMemo(() => {
    if (featureItemIds.size === 0) return sessions.slice(0, 20); // fallback: show recent
    return sessions.filter(s => {
      if (s.featureCode === featureCode) return true;
      if (s.itemsWorked && s.itemsWorked.some(id => featureItemIds.has(id))) return true;
      if (s.summary && s.summary.includes(featureCode)) return true;
      return false;
    });
  }, [sessions, featureCode, featureItemIds]);

  if (filtered.length === 0) {
    return (
      <div className="p-3 text-[11px] text-muted-foreground italic">
        No sessions for this feature.
      </div>
    );
  }

  return (
    <div className="p-2 space-y-0.5">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground px-1 mb-1">
        Sessions ({filtered.length})
      </p>
      {filtered.map(s => {
        const isExpanded = expandedId === s.id;
        return (
          <div key={s.id}>
            <button
              onClick={() => setExpandedId(isExpanded ? null : s.id)}
              className="flex items-center gap-2 w-full px-2 py-1.5 text-left rounded hover:bg-muted/30 transition-colors"
            >
              {/* Agent source */}
              <span className="text-[10px] font-mono text-accent shrink-0 w-12 truncate">
                {s.source || 'agent'}
              </span>
              {/* Work type */}
              <span className="text-[10px] text-muted-foreground shrink-0 w-16 truncate">
                {s.classification || s.workType || '—'}
              </span>
              {/* Stats */}
              <span className="text-[9px] text-muted-foreground tabular-nums flex gap-1.5 shrink-0">
                <span title="reads">{s.reads || 0}r</span>
                <span title="writes">{s.writes || 0}w</span>
                <span title="errors" style={s.errors > 0 ? { color: 'hsl(var(--destructive))' } : {}}>{s.errors || 0}e</span>
              </span>
              {/* Duration */}
              <span className="text-[9px] text-muted-foreground tabular-nums shrink-0">
                {formatDuration(s.durationMs)}
              </span>
              {/* Time */}
              <span className="text-[9px] text-muted-foreground ml-auto shrink-0">
                {relativeTime(s.startedAt || s.createdAt)}
              </span>
            </button>
            {isExpanded && s.summary && (
              <div className="px-3 py-1.5 text-[10px] text-muted-foreground bg-muted/10 rounded mx-1 mb-1">
                {s.summary}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
