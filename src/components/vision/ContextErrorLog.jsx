/**
 * ContextErrorLog — error entries filtered by feature code.
 *
 * Props:
 *   featureCode {string}  feature code to filter errors by
 *   errors      {array}   all agentErrors from useVisionStore
 *   items       {array}   all items (to match feature code to item ids)
 */
import React, { useState, useMemo } from 'react';
import { CheckCircle } from 'lucide-react';

function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

const MAX_DISPLAY = 10;

export default function ContextErrorLog({ featureCode, errors = [], items = [] }) {
  const [expandedIdx, setExpandedIdx] = useState(null);
  const [showAll, setShowAll] = useState(false);

  // Find item IDs belonging to this feature
  const featureItemIds = useMemo(() => {
    if (!featureCode) return new Set();
    return new Set(
      items
        .filter(i => i.featureCode === featureCode || (i.text && i.text.includes(featureCode)))
        .map(i => i.id)
    );
  }, [featureCode, items]);

  // Filter errors by feature
  const filtered = useMemo(() => {
    return errors.filter(e => {
      if (e.featureCode === featureCode) return true;
      if (e.itemId && featureItemIds.has(e.itemId)) return true;
      if (e.message && e.message.includes(featureCode)) return true;
      return false;
    });
  }, [errors, featureCode, featureItemIds]);

  if (filtered.length === 0) {
    return (
      <div className="p-3 flex flex-col items-center gap-2 text-muted-foreground">
        <CheckCircle style={{ width: 20, height: 20, color: 'hsl(var(--success, 160 60% 45%))' }} />
        <span className="text-[11px] italic">No errors for this feature.</span>
      </div>
    );
  }

  const displayErrors = showAll ? filtered : filtered.slice(0, MAX_DISPLAY);

  return (
    <div className="p-2 space-y-0.5">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground px-1 mb-1">
        Errors ({filtered.length})
      </p>
      {displayErrors.map((e, i) => {
        const isExpanded = expandedIdx === i;
        return (
          <button
            key={i}
            onClick={() => setExpandedIdx(isExpanded ? null : i)}
            className="flex flex-col w-full px-2 py-1.5 text-left rounded hover:bg-destructive/5 transition-colors"
          >
            <div className="flex items-center gap-2 w-full">
              <span className="text-[10px] text-destructive shrink-0">✕</span>
              <span className="text-[10px] font-mono text-muted-foreground shrink-0 w-16 truncate">
                {e.tool || e.toolName || 'unknown'}
              </span>
              <span className={`text-[10px] text-foreground flex-1 ${isExpanded ? '' : 'line-clamp-2'} truncate`}>
                {e.message || e.error || 'Unknown error'}
              </span>
              <span className="text-[9px] text-muted-foreground shrink-0 ml-auto">
                {relativeTime(e.timestamp || e.createdAt)}
              </span>
            </div>
            {isExpanded && (
              <div className="mt-1.5 px-5 py-1.5 text-[10px] text-foreground font-mono bg-muted/10 rounded whitespace-pre-wrap break-all">
                {e.message || e.error || e.stack || 'No additional details'}
              </div>
            )}
          </button>
        );
      })}
      {!showAll && filtered.length > MAX_DISPLAY && (
        <button
          onClick={() => setShowAll(true)}
          className="w-full text-center text-[10px] text-accent hover:underline py-1"
        >
          Show {filtered.length - MAX_DISPLAY} more
        </button>
      )}
    </div>
  );
}
