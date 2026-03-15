/**
 * DetailTabs — compact tab strip for the context panel detail view.
 *
 * Renders inside ContextItemDetail to switch between Overview, Pipeline,
 * Sessions, Errors, and Files sections.
 *
 * Props:
 *   activeTab   {string}  currently active detail tab id
 *   onTabChange {fn}      called with (tabId) when a tab is clicked
 *   errorCount  {number}  badge count for the errors tab (0 = hidden)
 */
import React from 'react';
import { FileText, GitBranch, Clock, AlertTriangle, Folder } from 'lucide-react';
import { DETAIL_TABS } from './contextPanelState.js';

const ICONS = {
  overview: FileText,
  pipeline: GitBranch,
  sessions: Clock,
  errors: AlertTriangle,
  files: Folder,
};

export default function DetailTabs({ activeTab = 'overview', onTabChange, errorCount = 0 }) {
  return (
    <div
      className="flex items-center gap-0 shrink-0"
      style={{
        height: '28px',
        borderBottom: '1px solid hsl(var(--border))',
        background: 'hsl(var(--muted) / 0.3)',
      }}
      role="tablist"
      aria-label="Detail sections"
    >
      {DETAIL_TABS.map(({ id, label }) => {
        const Icon = ICONS[id];
        const isActive = id === activeTab;
        const badge = id === 'errors' ? errorCount : 0;
        return (
          <button
            key={id}
            role="tab"
            aria-selected={isActive}
            className={[
              'flex items-center gap-1 px-2 h-full text-[10px] uppercase tracking-wider font-medium transition-colors',
              'border-b-2 -mb-px',
              isActive
                ? 'border-accent text-accent'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border',
            ].join(' ')}
            onClick={() => onTabChange?.(id)}
          >
            <Icon style={{ width: 10, height: 10 }} />
            {label}
            {badge > 0 && (
              <span
                className="text-[8px] min-w-[14px] h-3.5 flex items-center justify-center rounded-full px-0.5 tabular-nums"
                style={{ background: 'hsl(var(--destructive) / 0.15)', color: 'hsl(var(--destructive))' }}
              >
                {badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
