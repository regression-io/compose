/**
 * PhaseTag — mono-font colored pill for compose board phases.
 *
 * Phases from constants.js: vision, specification, planning, implementation, verification, release.
 * (Do NOT include compose-ui board phases like "requirements" or "design".)
 *
 * Props: { phase: string, className?: string }
 */
import React from 'react';
import { cn } from '@/lib/utils.js';

const PHASE_CONFIG = {
  vision:         'text-violet-400 bg-violet-500/10 border-violet-500/20',
  specification:  'text-purple-400 bg-purple-500/10 border-purple-500/20',
  planning:       'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
  implementation: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  verification:   'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  release:        'text-green-400 bg-green-500/10 border-green-500/20',
};

const FALLBACK = 'text-slate-400 bg-slate-500/10 border-slate-500/20';

export default function PhaseTag({ phase, className }) {
  const cfg = PHASE_CONFIG[phase] || FALLBACK;

  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-mono',
        cfg,
        className,
      )}
    >
      {phase || '—'}
    </span>
  );
}
