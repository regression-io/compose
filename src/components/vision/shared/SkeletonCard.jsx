/**
 * SkeletonCard — animated loading skeleton primitives.
 *
 * Three named exports (no default):
 *   SkeletonRow       — list row skeleton (1–2 lines of varying width)
 *   SkeletonCard      — board card skeleton (header + 2 lines + footer)
 *   SkeletonStatCard  — sidebar stat card (icon + 2 text lines)
 *
 * Uses animate-pulse on bg-slate-800/70 blocks.
 * tailwindcss-animate is installed (compose/package.json:46).
 */
import React from 'react';
import { cn } from '@/lib/utils.js';

function Shimmer({ className }) {
  return (
    <div className={cn('animate-pulse rounded bg-slate-800/70', className)} />
  );
}

export function SkeletonRow({ className }) {
  return (
    <div className={cn('flex items-center gap-2 px-3 py-2', className)}>
      <Shimmer className="w-2 h-2 rounded-full shrink-0" />
      <Shimmer className="w-12 h-2.5 shrink-0" />
      <Shimmer className="flex-1 h-2.5" />
      <Shimmer className="w-8 h-2" />
    </div>
  );
}

export function SkeletonCard({ className }) {
  return (
    <div className={cn('rounded-lg border border-border/40 bg-card p-2.5 space-y-2', className)}>
      {/* Header row */}
      <div className="flex items-center justify-between">
        <Shimmer className="h-2.5 w-20" />
        <Shimmer className="h-2 w-10" />
      </div>
      {/* Title line 1 */}
      <Shimmer className="h-3 w-full" />
      {/* Title line 2 (shorter) */}
      <Shimmer className="h-3 w-3/4" />
      {/* Footer row */}
      <div className="flex items-center gap-1.5 pt-0.5">
        <Shimmer className="h-3.5 w-12 rounded-full" />
        <Shimmer className="h-3.5 w-16 rounded-full ml-auto" />
      </div>
    </div>
  );
}

export function SkeletonStatCard({ className }) {
  return (
    <div className={cn('flex items-center gap-2 px-3 py-2', className)}>
      <Shimmer className="w-8 h-8 rounded-md shrink-0" />
      <div className="flex-1 space-y-1.5">
        <Shimmer className="h-2.5 w-16" />
        <Shimmer className="h-2 w-10" />
      </div>
    </div>
  );
}
