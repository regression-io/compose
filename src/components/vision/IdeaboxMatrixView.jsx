/**
 * IdeaboxMatrixView — 2x2 impact/effort scatter plot for ideas (Item 187).
 *
 * X-axis: effort (S / M / L)
 * Y-axis: impact (low / medium / high)
 * Quadrants:
 *   high impact + S effort  → Quick Wins
 *   high impact + L effort  → Big Bets
 *   low  impact + S effort  → Fill-ins
 *   low  impact + L effort  → Money Pits
 *
 * Ideas without effort/impact are shown in the "Unassigned" tray below the matrix.
 * Click a dot → selects the idea (opens detail panel).
 * Click an unassigned idea → inline form to assign effort/impact.
 */

import React, { useState, useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils.js';
import { Badge } from '@/components/ui/badge.jsx';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EFFORT_LEVELS = ['S', 'M', 'L'];
const IMPACT_LEVELS = ['high', 'medium', 'low']; // top to bottom on Y axis

const QUADRANT_LABELS = {
  'high-S': 'Quick Wins',
  'high-M': 'Quick Wins',
  'high-L': 'Big Bets',
  'medium-S': 'Fill-ins',
  'medium-M': 'Fill-ins',
  'medium-L': 'Money Pits',
  'low-S': 'Fill-ins',
  'low-M': 'Fill-ins',
  'low-L': 'Money Pits',
};

// Color by quadrant type
const QUADRANT_BG = {
  'Quick Wins': 'bg-emerald-400/8 border-emerald-400/20',
  'Big Bets': 'bg-blue-400/8 border-blue-400/20',
  'Fill-ins': 'bg-amber-400/8 border-amber-400/20',
  'Money Pits': 'bg-red-400/8 border-red-400/20',
};

// Dot colors by cluster index (cycle through)
const CLUSTER_COLORS = [
  'bg-blue-400',
  'bg-violet-400',
  'bg-emerald-400',
  'bg-amber-400',
  'bg-rose-400',
  'bg-cyan-400',
  'bg-orange-400',
  'bg-pink-400',
];

// ---------------------------------------------------------------------------
// EffortImpactForm — inline form to assign effort + impact to an idea
// ---------------------------------------------------------------------------

function EffortImpactForm({ idea, onSubmit, onCancel }) {
  const [effort, setEffort] = useState(idea.effort || '');
  const [impact, setImpact] = useState(idea.impact || '');

  return (
    <div className="p-2 bg-card border border-border rounded-lg shadow-md w-52">
      <p className="text-[10px] text-muted-foreground mb-2 truncate font-medium">{idea.id}: {idea.title}</p>

      <div className="mb-2">
        <p className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1">Effort</p>
        <div className="flex gap-1">
          {EFFORT_LEVELS.map(e => (
            <button
              key={e}
              onClick={() => setEffort(e)}
              className={cn(
                'flex-1 text-[10px] py-0.5 rounded border transition-colors',
                effort === e
                  ? 'bg-primary/20 border-primary/50 text-primary'
                  : 'border-border/40 text-muted-foreground hover:border-border',
              )}
            >
              {e}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-2.5">
        <p className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1">Impact</p>
        <div className="flex gap-1">
          {['high', 'medium', 'low'].map(i => (
            <button
              key={i}
              onClick={() => setImpact(i)}
              className={cn(
                'flex-1 text-[9px] py-0.5 rounded border transition-colors capitalize',
                impact === i
                  ? 'bg-primary/20 border-primary/50 text-primary'
                  : 'border-border/40 text-muted-foreground hover:border-border',
              )}
            >
              {i}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-1">
        <button
          onClick={onCancel}
          className="flex-1 text-[10px] py-1 rounded border border-border/40 text-muted-foreground hover:border-border transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => effort && impact && onSubmit(idea.id, { effort, impact })}
          disabled={!effort || !impact}
          className="flex-1 text-[10px] py-1 rounded border border-primary/50 bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-40 transition-colors"
        >
          Save
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// IdeaboxMatrixView
// ---------------------------------------------------------------------------

export default function IdeaboxMatrixView({ ideas, selectedIdeaId, onSelectIdea, onUpdateIdea }) {
  const [assigningIdea, setAssigningIdea] = useState(null);

  // Build cluster color map for consistent dot coloring
  const clusterColorMap = useMemo(() => {
    const clusters = [...new Set(ideas.map(i => i.cluster || '__none__'))];
    const map = {};
    clusters.forEach((c, i) => { map[c] = CLUSTER_COLORS[i % CLUSTER_COLORS.length]; });
    return map;
  }, [ideas]);

  const placed = useMemo(
    () => ideas.filter(i => i.effort && i.impact),
    [ideas],
  );

  const unassigned = useMemo(
    () => ideas.filter(i => !i.effort || !i.impact),
    [ideas],
  );

  const handleUpdateIdea = useCallback(async (ideaId, fields) => {
    await onUpdateIdea(ideaId, fields);
    setAssigningIdea(null);
  }, [onUpdateIdea]);

  return (
    <div className="flex flex-col gap-4">
      {/* Matrix grid */}
      <div>
        {/* Column headers (effort) */}
        <div className="flex mb-1 ml-12">
          {EFFORT_LEVELS.map(e => (
            <div key={e} className="flex-1 text-center text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
              {e}
            </div>
          ))}
        </div>

        {/* Row headers (impact) + cells */}
        {IMPACT_LEVELS.map(impact => (
          <div key={impact} className="flex mb-1">
            {/* Row label */}
            <div className="w-12 shrink-0 flex items-center justify-end pr-2">
              <span className="text-[9px] text-muted-foreground capitalize">{impact}</span>
            </div>
            {/* Cells */}
            {EFFORT_LEVELS.map(effort => {
              const key = `${impact}-${effort}`;
              const label = QUADRANT_LABELS[key];
              const cellIdeas = placed.filter(i => i.impact === impact && i.effort === effort);
              return (
                <div
                  key={effort}
                  className={cn(
                    'flex-1 min-h-[90px] rounded border p-1.5 mr-1 relative transition-colors',
                    QUADRANT_BG[label] || 'border-border/30',
                  )}
                >
                  {/* Quadrant label — top corner */}
                  <span className="absolute top-1 right-1 text-[8px] text-muted-foreground/50 italic">
                    {label}
                  </span>

                  {/* Idea dots */}
                  <div className="flex flex-wrap gap-1 pt-1">
                    {cellIdeas.map(idea => {
                      const dotColor = clusterColorMap[idea.cluster || '__none__'] || 'bg-muted-foreground';
                      const isSelected = idea.id === selectedIdeaId;
                      return (
                        <button
                          key={idea.id}
                          onClick={() => onSelectIdea?.(idea.id)}
                          title={`${idea.id}: ${idea.title}`}
                          className={cn(
                            'w-5 h-5 rounded-full border-2 transition-all hover:scale-110 flex items-center justify-center',
                            dotColor,
                            isSelected ? 'border-foreground ring-1 ring-foreground' : 'border-transparent',
                          )}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        ))}

        {/* X-axis label */}
        <div className="flex ml-12">
          <div className="flex-1 text-center text-[9px] text-muted-foreground/60 mt-0.5">
            Effort (S = small, M = medium, L = large)
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 text-[10px]">
        {Object.entries(QUADRANT_BG).map(([name, cls]) => (
          <div key={name} className="flex items-center gap-1">
            <div className={cn('w-2.5 h-2.5 rounded-sm border', cls)} />
            <span className="text-muted-foreground">{name}</span>
          </div>
        ))}
      </div>

      {/* Unassigned tray */}
      {unassigned.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            Unassigned ({unassigned.length}) — click to assign effort/impact
          </p>
          <div className="flex flex-wrap gap-2">
            {unassigned.map(idea => (
              <div key={idea.id} className="relative">
                <button
                  onClick={() => setAssigningIdea(assigningIdea?.id === idea.id ? null : idea)}
                  className={cn(
                    'text-[10px] px-2 py-1 rounded border transition-colors',
                    assigningIdea?.id === idea.id
                      ? 'border-accent bg-accent/10 text-foreground'
                      : 'border-border/50 text-muted-foreground hover:border-border hover:text-foreground',
                  )}
                >
                  <span className="font-mono text-[9px] mr-1 opacity-60">{idea.id}</span>
                  {idea.title.slice(0, 30)}{idea.title.length > 30 ? '…' : ''}
                </button>

                {/* Inline form */}
                {assigningIdea?.id === idea.id && (
                  <div className="absolute left-0 top-full mt-1 z-10">
                    <EffortImpactForm
                      idea={idea}
                      onSubmit={handleUpdateIdea}
                      onCancel={() => setAssigningIdea(null)}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
