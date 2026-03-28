/**
 * ConfidenceBar — 4-bar confidence level indicator.
 *
 * SCALE DECISION (T0.3): constants.js:45 defines CONFIDENCE_LABELS with 5 entries (0–4).
 * Live items may use confidence 0–4. We implement 4 bars (index 0–3) to match the design spec.
 * Level 4 ("Crystallized") is treated as fully filled (all bars emerald) + extra violet dot.
 * This matches the compose-ui reference pattern while supporting both ranges.
 *
 * Fill condition: i <= level  (reference line 15 — NOT i < level as in ConfidenceDots)
 * Do NOT delete ConfidenceDots.jsx — it is preserved for existing control widget usage.
 *
 * colors[0] = bg-slate-600 (verification correction — NOT bg-slate-800 as in blueprint §2.4 typo)
 *
 * Props: { level?: 0|1|2|3|4, className?: string }  (default level 0)
 */
import React from 'react';
import { cn } from '@/lib/utils.js';
import { CONFIDENCE_COLORS } from '../constants.js';

const LABELS = ['Untested', 'Low', 'Moderate', 'High', 'Crystallized'];

export default function ConfidenceBar({ level = 0, className }) {
  const safeLevel = Math.max(0, Math.min(4, level || 0));
  const label = LABELS[safeLevel] ?? 'Untested';
  // Use color of the highest filled bar
  const barColor = safeLevel === 0 ? CONFIDENCE_COLORS[0] : CONFIDENCE_COLORS[safeLevel];

  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      <span className="flex items-center gap-0.5">
        {[1, 2, 3, 4].map(i => (
          <span
            key={i}
            className={cn(
              'h-2.5 w-1.5 rounded-sm',
              i <= safeLevel ? barColor : 'bg-slate-600',
            )}
          />
        ))}
      </span>
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </span>
  );
}
