/**
 * DesignSidebar.jsx
 *
 * COMP-DESIGN-1: Decision log sidebar for the Design tab.
 * COMP-DESIGN-1d: Added Decisions/Research tab bar.
 *
 * Replaces AttentionQueueSidebar when the Design tab is active.
 * Shows the running log of design decisions made during the
 * design conversation, with superseded decisions dimmed.
 * Research tab shows codebase refs, web searches, and topic outline.
 *
 * Props:
 *   decisions        Decision[]  — array of design decisions
 *   onReviseDecision (index: number) => void — callback for revision flow
 */

import React, { useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area.jsx';
import { useDesignStore } from './useDesignStore.js';
import ResearchTab from './ResearchTab.jsx';

export default function DesignSidebar({ decisions = [], onReviseDecision, sessionComplete = false, widthPx }) {
  const [activeTab, setActiveTab] = useState('decisions');
  const activeCount = decisions.filter(d => !d.superseded).length;
  const researchItems = useDesignStore(s => s.researchItems) || [];
  const topicOutline = useDesignStore(s => s.topicOutline) || [];

  return (
    <aside className="shrink-0 flex flex-col bg-sidebar border-r border-sidebar-border" style={{ width: widthPx ?? 208 }}>

      {/* Header */}
      <div className="p-3 pb-0">
        <h3
          className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: 'hsl(var(--foreground))' }}
        >
          Design
        </h3>
      </div>

      {/* Tab bar */}
      <div className="flex px-2 pt-2 gap-1" style={{ borderBottom: '1px solid hsl(var(--sidebar-border))' }}>
        <button
          onClick={() => setActiveTab('decisions')}
          className="flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium transition-colors"
          style={{
            color: activeTab === 'decisions' ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
            borderBottom: activeTab === 'decisions' ? '2px solid hsl(var(--accent))' : '2px solid transparent',
            marginBottom: '-1px',
          }}
        >
          Decisions
          {activeCount > 0 && (
            <span
              className="text-[9px] min-w-[14px] h-3.5 flex items-center justify-center rounded-full px-1 tabular-nums"
              style={{
                background: 'hsl(var(--accent) / 0.15)',
                color: 'hsl(var(--accent))',
              }}
            >
              {activeCount}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('research')}
          className="flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium transition-colors"
          style={{
            color: activeTab === 'research' ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
            borderBottom: activeTab === 'research' ? '2px solid hsl(var(--accent))' : '2px solid transparent',
            marginBottom: '-1px',
          }}
        >
          Research
          {researchItems.length > 0 && (
            <span
              className="text-[9px] min-w-[14px] h-3.5 flex items-center justify-center rounded-full px-1 tabular-nums"
              style={{
                background: 'hsl(var(--accent) / 0.15)',
                color: 'hsl(var(--accent))',
              }}
            >
              {researchItems.length}
            </span>
          )}
        </button>
      </div>

      {/* Tab content */}
      {activeTab === 'decisions' && (
        <ScrollArea className="flex-1">
          {decisions.length === 0 ? (
            <div
              className="px-3 py-6 text-center text-[11px]"
              style={{ color: 'hsl(var(--muted-foreground))' }}
            >
              No decisions yet
            </div>
          ) : (
            <div className="px-2 pb-2 pt-1">
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
                      color: 'hsl(var(--foreground))',
                      textDecoration: decision.superseded ? 'line-through' : undefined,
                    }}
                  >
                    {decision.selectedOption?.title || decision.question}
                  </span>

                  {decision.comment && (
                    <span
                      className="text-[10px] leading-snug mt-0.5"
                      style={{ color: 'hsl(var(--muted-foreground))' }}
                    >
                      {decision.comment}
                    </span>
                  )}

                  {decision.superseded && (
                    <span
                      className="text-[9px] mt-0.5 uppercase tracking-wider font-medium"
                      style={{ color: 'hsl(var(--muted-foreground))' }}
                    >
                      superseded
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
      )}

      {activeTab === 'research' && (
        <ResearchTab researchItems={researchItems} topicOutline={topicOutline} />
      )}
    </aside>
  );
}
