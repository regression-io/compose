/**
 * RelativeTime — render a timestamp as "3 hours ago" with full datetime in native title.
 *
 * Uses date-fns formatDistanceToNow + format.
 * Native title attribute only — do NOT use @radix-ui/react-tooltip (design.md:467).
 *
 * Props: { date: string|Date|null, className?: string }
 */
import React from 'react';
import { formatDistanceToNow, format } from 'date-fns';
import { cn } from '@/lib/utils.js';

export default function RelativeTime({ date, className }) {
  if (!date) return <span className={cn('text-muted-foreground', className)}>—</span>;

  let parsed;
  try {
    parsed = typeof date === 'string' ? new Date(date) : date;
    if (isNaN(parsed.getTime())) {
      return <span className={cn('text-muted-foreground', className)}>—</span>;
    }
  } catch {
    return <span className={cn('text-muted-foreground', className)}>—</span>;
  }

  const relative = formatDistanceToNow(parsed, { addSuffix: true });
  const full = format(parsed, 'PPpp');

  return (
    <time
      dateTime={parsed.toISOString()}
      title={full}
      className={cn('text-muted-foreground tabular-nums', className)}
    >
      {relative}
    </time>
  );
}
