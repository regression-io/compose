/**
 * DesignSidebar.jsx
 *
 * COMP-DESIGN-1: Decision log sidebar for the Design tab.
 *
 * Replaces AttentionQueueSidebar when the Design tab is active.
 * Shows the running log of design decisions made during the
 * design conversation, with superseded decisions dimmed.
 *
 * Props:
 *   decisions        Decision[]  — array of design decisions
 *   onReviseDecision (index: number) => void — callback for revision flow
 */

import React from 'react';
import { ScrollArea } from '@/components/ui/scroll-area.jsx';

export default function DesignSidebar({ decisions = [], onReviseDecision, sessionComplete = false }) {
  const activeCount = decisions.filter(d => !d.superseded).length;

  return (
    <aside className="w-52 shrink-0 flex flex-col bg-sidebar border-r border-sidebar-border">

      {/* Header */}
      <div className="p-3 pb-2">
        <div className="flex items-center justify-between">
          <h3
            className="text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: 'var(--color-text-primary)' }}
          >
            Decisions
          </h3>
          <span
            className="text-[9px] min-w-[16px] h-4 flex items-center justify-center rounded-full px-1 tabular-nums"
            style={{
              background: 'hsl(var(--accent) / 0.15)',
              color: 'hsl(var(--accent))',
            }}
          >
            {activeCount}
          </span>
        </div>
      </div>

      {/* Decision list */}
      <ScrollArea className="flex-1">
        {decisions.length === 0 ? (
          <div
            className="px-3 py-6 text-center text-[11px]"
            style={{ color: 'var(--color-text-tertiary)' }}
          >
            No decisions yet
          </div>
        ) : (
          <div className="px-2 pb-2">
            {decisions.map((decision, i) => (
              <button
                key={i}
                disabled={decision.superseded || sessionComplete}
                onClick={() => !decision.superseded && !sessionComplete && onReviseDecision?.(i)}
                className={`flex flex-col w-full text-left rounded-md px-2 py-1.5 transition-colors ${decision.superseded || sessionComplete ? 'cursor-not-allowed opacity-40' : 'cursor-pointer hover:bg-sidebar-accent/50'}`}
              >
                <span
                  className="text-[11px] font-medium leading-tight"
                  style={{
                    color: 'var(--color-text-primary)',
                    textDecoration: decision.superseded ? 'line-through' : undefined,
                  }}
                >
                  {decision.selectedOption?.title || decision.question}
                </span>

                {decision.comment && (
                  <span
                    className="text-[10px] leading-snug mt-0.5"
                    style={{ color: 'var(--color-text-tertiary)' }}
                  >
                    {decision.comment}
                  </span>
                )}

                {decision.superseded && (
                  <span
                    className="text-[9px] mt-0.5 uppercase tracking-wider font-medium"
                    style={{ color: 'var(--color-text-tertiary)' }}
                  >
                    superseded
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </ScrollArea>
    </aside>
  );
}
