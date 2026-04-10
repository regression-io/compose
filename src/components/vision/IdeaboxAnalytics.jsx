/**
 * IdeaboxAnalytics — collapsible analytics section in the IdeaboxView header (Item 189).
 *
 * Renders:
 *   - Source breakdown bar chart (count by source)
 *   - Status funnel: NEW → DISCUSSING → PROMOTED with kill rate
 *   - Cluster health: ideas per cluster, promotion rate
 *
 * All derived from props (ideas + killed arrays). No API calls.
 */

import React, { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, BarChart2 } from 'lucide-react';
import { cn } from '@/lib/utils.js';

// ---------------------------------------------------------------------------
// MiniBar — small inline bar for relative comparison
// ---------------------------------------------------------------------------

function MiniBar({ value, max, color = 'bg-primary/60' }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex-1 h-1.5 bg-muted/50 rounded-full overflow-hidden">
      <div
        className={cn('h-full rounded-full transition-all', color)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// IdeaboxAnalytics
// ---------------------------------------------------------------------------

export default function IdeaboxAnalytics({ ideas, killed }) {
  const [open, setOpen] = useState(false);

  const analytics = useMemo(() => {
    const all = [...ideas, ...(killed || [])];

    // Source breakdown
    const sourceCounts = {};
    for (const idea of all) {
      const src = idea.source?.trim() || '(no source)';
      // Truncate long source strings to a label
      const label = src.length > 30 ? src.slice(0, 30) + '…' : src;
      sourceCounts[label] = (sourceCounts[label] || 0) + 1;
    }
    const sourceEntries = Object.entries(sourceCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    const maxSourceCount = sourceEntries[0]?.[1] || 1;

    // Status funnel
    const newCount = all.filter(i => i.status === 'NEW').length;
    const discussingCount = all.filter(i => i.status === 'DISCUSSING').length;
    const promotedCount = all.filter(i => i.status?.startsWith('PROMOTED')).length;
    const killedCount = (killed || []).length;
    const totalActive = ideas.length;
    const killRate = all.length > 0
      ? Math.round((killedCount / all.length) * 100)
      : 0;

    // Cluster health
    const clusterMap = {};
    for (const idea of all) {
      const cluster = idea.cluster || '(unclustered)';
      if (!clusterMap[cluster]) clusterMap[cluster] = { total: 0, promoted: 0 };
      clusterMap[cluster].total += 1;
      if (idea.status?.startsWith('PROMOTED')) clusterMap[cluster].promoted += 1;
    }
    const clusterEntries = Object.entries(clusterMap)
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 5);
    const maxClusterTotal = clusterEntries[0]?.[1].total || 1;

    return {
      sourceEntries, maxSourceCount,
      newCount, discussingCount, promotedCount, killedCount, killRate, totalActive,
      clusterEntries, maxClusterTotal,
    };
  }, [ideas, killed]);

  if (ideas.length === 0 && (!killed || killed.length === 0)) return null;

  return (
    <div className="mt-1.5">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 text-[10px] text-muted-foreground/70 hover:text-muted-foreground transition-colors"
      >
        {open
          ? <ChevronDown className="w-3 h-3" />
          : <ChevronRight className="w-3 h-3" />}
        <BarChart2 className="w-3 h-3" />
        <span>Analytics</span>
      </button>

      {open && (
        <div className="mt-2 space-y-3 border border-border/30 rounded-lg p-3 bg-muted/10">

          {/* Status funnel */}
          <div>
            <p className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1.5 font-semibold">
              Status Funnel
            </p>
            <div className="space-y-1">
              {[
                { label: 'NEW', count: analytics.newCount, color: 'bg-emerald-400/60' },
                { label: 'DISCUSSING', count: analytics.discussingCount, color: 'bg-amber-400/60' },
                { label: 'PROMOTED', count: analytics.promotedCount, color: 'bg-blue-400/60' },
                { label: 'KILLED', count: analytics.killedCount, color: 'bg-muted-foreground/40' },
              ].map(({ label, count, color }) => (
                <div key={label} className="flex items-center gap-2">
                  <span className="w-16 text-[9px] text-muted-foreground shrink-0">{label}</span>
                  <MiniBar
                    value={count}
                    max={Math.max(analytics.newCount, analytics.discussingCount, analytics.promotedCount, analytics.killedCount, 1)}
                    color={color}
                  />
                  <span className="w-5 text-right text-[9px] text-muted-foreground shrink-0">{count}</span>
                </div>
              ))}
            </div>
            {analytics.killRate > 0 && (
              <p className="text-[9px] text-muted-foreground/60 mt-1">
                Kill rate: {analytics.killRate}%
              </p>
            )}
          </div>

          {/* Source breakdown */}
          {analytics.sourceEntries.length > 0 && (
            <div>
              <p className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1.5 font-semibold">
                By Source
              </p>
              <div className="space-y-1">
                {analytics.sourceEntries.map(([label, count]) => (
                  <div key={label} className="flex items-center gap-2">
                    <span className="w-24 text-[9px] text-muted-foreground truncate shrink-0" title={label}>{label}</span>
                    <MiniBar value={count} max={analytics.maxSourceCount} color="bg-violet-400/50" />
                    <span className="w-5 text-right text-[9px] text-muted-foreground shrink-0">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Cluster health */}
          {analytics.clusterEntries.length > 0 && (
            <div>
              <p className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1.5 font-semibold">
                Cluster Health
              </p>
              <div className="space-y-1">
                {analytics.clusterEntries.map(([cluster, { total, promoted }]) => {
                  const rate = total > 0 ? Math.round((promoted / total) * 100) : 0;
                  return (
                    <div key={cluster} className="flex items-center gap-2">
                      <span className="w-24 text-[9px] text-muted-foreground truncate shrink-0" title={cluster}>
                        {cluster}
                      </span>
                      <MiniBar value={total} max={analytics.maxClusterTotal} color="bg-cyan-400/50" />
                      <span className="w-5 text-right text-[9px] text-muted-foreground shrink-0">{total}</span>
                      {rate > 0 && (
                        <span className="text-[9px] text-blue-400 shrink-0">{rate}%</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

        </div>
      )}
    </div>
  );
}
