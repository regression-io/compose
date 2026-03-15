/**
 * StatusBadge — canonical 14-status colored chip.
 *
 * Canonical status map includes `ready` (not in compose-ui reference — added here per blueprint §2.1).
 * Label: status.replace(/_/g, ' ') so "in_progress" → "in progress".
 *
 * Props: { status: string, className?: string }
 */
import React from 'react';
import { cn } from '@/lib/utils.js';

const STATUS_CONFIG = {
  planned:     { bg: 'bg-slate-500/15',   text: 'text-slate-400',   dot: 'bg-slate-400'   },
  ready:       { bg: 'bg-sky-500/15',     text: 'text-sky-400',     dot: 'bg-sky-400'     },
  in_progress: { bg: 'bg-blue-500/15',    text: 'text-blue-400',    dot: 'bg-blue-400'    },
  review:      { bg: 'bg-amber-500/15',   text: 'text-amber-400',   dot: 'bg-amber-400'   },
  complete:    { bg: 'bg-emerald-500/15', text: 'text-emerald-400', dot: 'bg-emerald-400' },
  blocked:     { bg: 'bg-rose-500/15',    text: 'text-rose-400',    dot: 'bg-rose-400'    },
  parked:      { bg: 'bg-slate-500/15',   text: 'text-slate-500',   dot: 'bg-slate-500'   },
  killed:      { bg: 'bg-slate-500/15',   text: 'text-slate-600',   dot: 'bg-slate-600'   },
  pending:     { bg: 'bg-amber-500/15',   text: 'text-amber-400',   dot: 'bg-amber-400'   },
  resolved:    { bg: 'bg-emerald-500/15', text: 'text-emerald-400', dot: 'bg-emerald-400' },
  active:      { bg: 'bg-blue-500/15',    text: 'text-blue-400',    dot: 'bg-blue-400'    },
  completed:   { bg: 'bg-emerald-500/15', text: 'text-emerald-400', dot: 'bg-emerald-400' },
  failed:      { bg: 'bg-rose-500/15',    text: 'text-rose-400',    dot: 'bg-rose-400'    },
  paused:      { bg: 'bg-amber-500/15',   text: 'text-amber-400',   dot: 'bg-amber-400'   },
};

const FALLBACK = { bg: 'bg-slate-500/10', text: 'text-slate-400', dot: 'bg-slate-400' };

export default function StatusBadge({ status, className }) {
  const cfg = STATUS_CONFIG[status] || FALLBACK;
  const label = status ? status.replace(/_/g, ' ') : '—';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium',
        cfg.bg,
        cfg.text,
        className,
      )}
    >
      <span className={cn('w-1 h-1 rounded-full shrink-0', cfg.dot)} />
      {label}
    </span>
  );
}
