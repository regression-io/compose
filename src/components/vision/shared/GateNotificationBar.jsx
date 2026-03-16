/**
 * GateNotificationBar — persistent bottom bar surfacing pending gates.
 *
 * Renders nothing when no pending (undismissed) gates.
 * Carousel for >1 gates with ‹ N/total › navigation.
 * Dismiss is page-session only (does not affect store).
 * Color-coded by g.fromPhase using gateColors map.
 * Coexists with GateToast — both can mount simultaneously.
 *
 * Store access (no React Query):
 *   const { gates, items } = useVisionStore();
 *
 * Props: { onOpenGate: (gateId: string) => void }
 */
import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, X, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { useVisionStore } from '../useVisionStore.js';
import { useShallow } from 'zustand/react/shallow';
import { LIFECYCLE_PHASE_LABELS } from '../constants.js';

const GATE_COLORS = {
  explore_design:  { bg: 'bg-blue-500/5',      border: 'border-blue-500/40',    text: 'text-blue-300'    },
  prd:             { bg: 'bg-purple-500/5',    border: 'border-purple-500/40',  text: 'text-purple-300'  },
  architecture:    { bg: 'bg-cyan-500/5',      border: 'border-cyan-500/40',    text: 'text-cyan-300'    },
  blueprint:       { bg: 'bg-violet-500/5',    border: 'border-violet-500/40',  text: 'text-violet-300'  },
  plan:            { bg: 'bg-amber-500/5',     border: 'border-amber-500/40',   text: 'text-amber-300'   },
  report:          { bg: 'bg-emerald-500/5',   border: 'border-emerald-500/40', text: 'text-emerald-300' },
  ship:            { bg: 'bg-green-500/5',     border: 'border-green-500/40',   text: 'text-green-300'   },
};

const FALLBACK_COLOR = { bg: 'bg-muted/30', border: 'border-border', text: 'text-muted-foreground' };

export default function GateNotificationBar({ onOpenGate }) {
  const { gates, items } = useVisionStore(useShallow(s => ({ gates: s.gates, items: s.items })));
  const [dismissed, setDismissed] = useState(new Set());
  const [index, setIndex] = useState(0);

  const pending = gates.filter(g => g.status === 'pending' && !dismissed.has(g.id));

  if (pending.length === 0) return null;

  // Clamp index to valid range
  const safeIndex = Math.min(index, pending.length - 1);
  const gate = pending[safeIndex];
  const matchedItem = items.find(i => i.id === gate.itemId)
    || items.find(i => i.lifecycle?.featureCode && gate.featureCode && i.lifecycle.featureCode === gate.featureCode);
  // Build a readable title — avoid raw UUIDs
  let itemTitle = matchedItem?.title;
  if (!itemTitle) itemTitle = gate.featureCode;
  if (!itemTitle) itemTitle = gate.stepId?.replace(/_/g, ' ');
  if (!itemTitle) itemTitle = gate.toPhase ? `${gate.toPhase} transition` : null;
  if (!itemTitle) itemTitle = 'Pending review';
  const phaseLabel = LIFECYCLE_PHASE_LABELS[gate.fromPhase] ?? gate.fromPhase ?? 'Gate';
  const colors = GATE_COLORS[gate.fromPhase] ?? FALLBACK_COLOR;

  const handleDismiss = () => {
    setDismissed(prev => new Set([...prev, gate.id]));
    // Move to next if available
    if (safeIndex >= pending.length - 1 && safeIndex > 0) {
      setIndex(safeIndex - 1);
    }
  };

  const handlePrev = () => setIndex(Math.max(0, safeIndex - 1));
  const handleNext = () => setIndex(Math.min(pending.length - 1, safeIndex + 1));

  return (
    <div
      className={cn(
        'shrink-0 h-10 border-t flex items-center gap-2 px-3',
        colors.bg,
        colors.border,
      )}
    >
      <ShieldCheck className={cn('h-3.5 w-3.5 shrink-0', colors.text)} />

      {/* Gate info */}
      <span className={cn('text-[11px] font-medium shrink-0', colors.text)}>
        {phaseLabel} Gate
      </span>
      <span className="text-[10px] text-muted-foreground truncate flex-1 min-w-0">
        {itemTitle}
      </span>

      {/* Carousel controls */}
      {pending.length > 1 && (
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={handlePrev}
            disabled={safeIndex === 0}
            className="p-0.5 rounded hover:bg-muted/50 disabled:opacity-30 transition-colors"
          >
            <ChevronLeft className="h-3 w-3" />
          </button>
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {safeIndex + 1}/{pending.length}
          </span>
          <button
            onClick={handleNext}
            disabled={safeIndex === pending.length - 1}
            className="p-0.5 rounded hover:bg-muted/50 disabled:opacity-30 transition-colors"
          >
            <ChevronRight className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Review button */}
      <button
        onClick={() => onOpenGate?.(gate.id)}
        className={cn(
          'shrink-0 text-[10px] px-2 py-0.5 rounded border transition-colors hover:opacity-80',
          colors.border,
          colors.text,
        )}
      >
        Review
      </button>

      {/* Dismiss */}
      <button
        onClick={handleDismiss}
        className="shrink-0 p-0.5 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
        title="Dismiss (page session only)"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
