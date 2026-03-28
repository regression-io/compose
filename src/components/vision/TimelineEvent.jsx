/**
 * TimelineEvent.jsx — Single event row in the feature event timeline.
 * COMP-UX-11
 */
import React from 'react';
import { cn } from '@/lib/utils.js';
import { SEVERITY_COLORS, TIMELINE_CATEGORY_COLORS } from './constants.js';

const CATEGORY_ICONS = {
  phase: '\u2192',     // →
  gate: '\u25C8',      // ◈
  session: '\u25CF',   // ●
  iteration: '\u21BB', // ↻
  error: '\u26A0',     // ⚠
};

function relativeTime(isoString) {
  if (!isoString) return '';
  const diffMs = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

export default function TimelineEvent({ event, onSelectItem, style }) {
  const icon = CATEGORY_ICONS[event.category] || '\u25CF';
  const iconColor = TIMELINE_CATEGORY_COLORS[event.category] || 'text-zinc-400';
  const severityColor = SEVERITY_COLORS[event.severity] || 'text-zinc-400';
  return (
    <div
      className="flex items-start gap-2 px-2 py-1.5 rounded"
      style={style}
    >
      <span className={cn('text-[11px] shrink-0 w-4 text-center leading-4', iconColor)}>
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <p className={cn('text-[11px] truncate', severityColor)}>
          {event.title}
        </p>
        {event.detail && (
          <p className="text-[10px] text-muted-foreground/60 truncate">
            {event.detail}
          </p>
        )}
      </div>
      <span className="text-[10px] text-muted-foreground/50 tabular-nums shrink-0 leading-4">
        {relativeTime(event.timestamp)}
      </span>
    </div>
  );
}
