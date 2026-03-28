/**
 * AttentionQueueSidebar.jsx
 *
 * COMP-UI-2: Live attention-queue sidebar.
 *
 * Replaces AppSidebar with a focused layout that surfaces:
 *   • Active build status (step + progress bar)
 *   • Pending gates queue
 *   • Blocked items queue
 *   • Compact stats row
 *   • Global phase filter (wired to useVisionStore — affects all views)
 *   • View navigation (all existing views preserved)
 *   • Agent telemetry panel (preserved from AppSidebar)
 */

import React from 'react';
import {
  Search, CircleDot, Sun, Moon, Bell,
  Zap, AlertTriangle, Shield, Plus,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge.jsx';
import { Input } from '@/components/ui/input.jsx';
import { ScrollArea } from '@/components/ui/scroll-area.jsx';
import { Separator } from '@/components/ui/separator.jsx';
import { PHASE_LABELS, PHASES } from './constants.js';
import AgentPanel from './AgentPanel.jsx';
import { computeAttentionQueue, buildProgress, compactStats, togglePhase, ATTENTION_PRIORITY } from './attentionQueueState.js';
import StatusBadge from './shared/StatusBadge.jsx';
import PhaseTag from './shared/PhaseTag.jsx';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * BuildStatusWidget — shows active build step + progress bar.
 * Hidden when no build is running.
 */
function BuildStatusWidget({ activeBuild }) {
  const bp = buildProgress(activeBuild);
  if (!activeBuild) return null;

  const barColor = bp.isRunning
    ? 'hsl(var(--primary))'
    : bp.status === 'complete'
      ? 'hsl(var(--success))'
      : bp.status === 'failed' || bp.status === 'killed'
        ? 'hsl(var(--destructive))'
        : 'hsl(var(--muted-foreground))';

  return (
    <div className="mx-3 mb-2 rounded-md p-2" style={{ background: 'hsl(var(--accent))' }}>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5">
          <Zap
            className="h-3 w-3 shrink-0"
            style={{ color: barColor }}
          />
          <span className="text-[10px] font-medium truncate max-w-[100px]" style={{ color: 'hsl(var(--foreground))' }}>
            {bp.featureCode || 'Build'}
          </span>
        </div>
        <span className="text-[10px] tabular-nums" style={{ color: 'hsl(var(--muted-foreground))' }}>
          {bp.stepNum}/{bp.totalSteps}
        </span>
      </div>
      {/* Progress bar */}
      <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${bp.pct}%`, background: barColor }}
        />
      </div>
      <div className="flex items-center justify-between mt-1">
        <span className="text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
          {bp.stepLabel}
        </span>
        {bp.isRunning && (
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{
              background: 'hsl(var(--primary))',
              animation: 'pulse 1.5s ease-in-out infinite',
            }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * AttentionQueueSection — inline queue of blocked + pending-gate + decision items.
 * Clicking an item navigates to it.
 */
function AttentionQueueSection({ items, gates, onSelectItem, onViewChange }) {
  const queue = React.useMemo(() => computeAttentionQueue(items, gates), [items, gates]);

  if (queue.length === 0) return null;

  // Show up to 5 items; more → link to Attention view
  const visible = queue.slice(0, 5);
  const overflow = queue.length - visible.length;

  const iconFor = (priority) => {
    if (priority === ATTENTION_PRIORITY.BLOCKED) return <AlertTriangle className="h-3 w-3 shrink-0" style={{ color: 'hsl(var(--destructive))' }} />;
    if (priority === ATTENTION_PRIORITY.PENDING_GATE) return <Shield className="h-3 w-3 shrink-0" style={{ color: 'hsl(var(--warning))' }} />;
    return <Bell className="h-3 w-3 shrink-0" style={{ color: 'hsl(var(--muted-foreground))' }} />;
  };

  return (
    <div className="px-2 mb-2">
      <p
        className="text-[10px] font-medium uppercase tracking-wider px-2 mb-1"
        style={{ color: 'hsl(var(--muted-foreground))' }}
      >
        Needs Attention
      </p>
      {visible.map(({ item, priority, reason }) => (
        <button
          key={item.id}
          onClick={() => onSelectItem?.(item.id)}
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors hover:bg-sidebar-accent/50"
          style={{ color: 'hsl(var(--muted-foreground))' }}
          title={reason}
        >
          {iconFor(priority)}
          <span className="truncate flex-1 text-left">{item.title}</span>
          {item.phase && <PhaseTag phase={item.phase} className="shrink-0 text-[9px] px-1.5 py-0 h-4" />}
          <StatusBadge status={item.status} className="shrink-0" />
        </button>
      ))}
      {overflow > 0 && (
        <button
          onClick={() => onViewChange?.('attention')}
          className="flex w-full items-center px-2 py-0.5 text-[10px] rounded-md hover:bg-sidebar-accent/50 transition-colors"
          style={{ color: 'hsl(var(--muted-foreground))' }}
        >
          +{overflow} more
        </button>
      )}
    </div>
  );
}

/**
 * CompactStatsRow — small horizontal stats bar below the header.
 */
function CompactStatsRow({ items, gates }) {
  const stats = React.useMemo(() => compactStats(items, gates), [items, gates]);
  if (stats.total === 0) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap px-3 pb-1">
      <span className="text-xs text-muted-foreground">{stats.total} items</span>
      {stats.inProgress > 0 && (
        <span className="text-xs" style={{ color: 'hsl(var(--primary))' }}>{stats.inProgress} active</span>
      )}
      {stats.blocked > 0 && (
        <span className="text-xs" style={{ color: 'hsl(var(--destructive))' }}>{stats.blocked} blocked</span>
      )}
      {stats.pendingGates > 0 && (
        <span className="text-xs" style={{ color: 'hsl(var(--warning))' }}>{stats.pendingGates} gates</span>
      )}
    </div>
  );
}

/**
 * GroupFilter — feature code prefix groups with counts.
 * Only shows groups that are visible (not hidden).
 */
function GroupFilter({ items, hiddenGroups, onToggleGroup }) {
  const groups = React.useMemo(() => {
    const counts = {};
    const activeCount = {};
    for (const item of items) {
      const title = item.title || '';
      if (title.startsWith('`docs/') || title.startsWith('docs/')) continue;
      const group = item.group || 'other';
      counts[group] = (counts[group] || 0) + 1;
      if (['in_progress', 'review', 'ready'].includes(item.status)) {
        activeCount[group] = (activeCount[group] || 0) + 1;
      }
    }
    return Object.entries(counts)
      .sort((a, b) => (activeCount[b[0]] || 0) - (activeCount[a[0]] || 0) || b[1] - a[1])
      .map(([group, count]) => ({ group, count, active: activeCount[group] || 0 }));
  }, [items]);

  if (groups.length <= 1) return null;

  return (
    <>
      {groups.map(({ group, count, active }) => {
        const isHidden = hiddenGroups?.has(group);
        return (
          <button
            key={group}
            onClick={() => onToggleGroup?.(group)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors hover:bg-sidebar-accent/50"
            style={{
              color: isHidden ? 'hsl(var(--muted-foreground))' : 'hsl(var(--muted-foreground))',
              opacity: isHidden ? 0.4 : 1,
              fontWeight: active > 0 ? 500 : 400,
            }}
          >
            <span className="truncate flex-1 text-left">{group}</span>
            {active > 0 && (
              <span className="text-[10px] tabular-nums" style={{ color: 'hsl(var(--primary))' }}>{active}</span>
            )}
            <span className="text-[10px] tabular-nums shrink-0" style={{ color: 'hsl(var(--muted-foreground))' }}>{count}</span>
          </button>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// AttentionQueueSidebar
// ---------------------------------------------------------------------------

/**
 * AttentionQueueSidebar
 *
 * Props:
 *   items            VisionItem[]
 *   gates            Gate[]
 *   activeBuild      ActiveBuild | null
 *   onViewChange     (viewKey: string) => void  ← used by attention overflow link
 *   selectedPhase    string | null          ← from useVisionStore (global)
 *   onPhaseSelect    (phase: string|null) => void  ← calls store's setSelectedPhase
 *   searchQuery      string
 *   onSearchChange   (query: string) => void
 *   connected        boolean
 *   agentActivity    Activity[]
 *   agentErrors      Error[]
 *   sessionState     SessionState | null
 *   onSelectItem     (itemId: string) => void
 *   onThemeChange    (settings: object) => void
 *   onNewItem        () => void  ← COMP-UI-5: opens ItemFormDialog
 */
function AttentionQueueSidebar({
  items,
  gates,
  activeBuild,
  onViewChange,
  selectedPhase,
  onPhaseSelect,
  selectedTrack: selectedTrackProp,
  onTrackSelect,
  visibleTracks,
  onToggleVisibleTrack,
  onShowAllTracks,
  hiddenGroups,
  onToggleGroup,
  searchQuery,
  onSearchChange,
  connected,
  agentActivity,
  agentErrors,
  spawnedAgents,
  agentRelays,
  sessionState,
  onSelectItem,
  onThemeChange,
  onNewItem,
}) {
  const safeItems = items || [];
  const safeGates = gates || [];

  const stats = React.useMemo(() => compactStats(safeItems, safeGates), [safeItems, safeGates]);

  const [isDark, setIsDark] = React.useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  );

  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const toggleTheme = React.useCallback(() => {
    const next = !isDark;
    const theme = next ? 'dark' : 'light';
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', next);
    }
    try { localStorage.setItem('compose:theme', theme); } catch { /* ignore */ }
    if (onThemeChange) onThemeChange({ ui: { theme } });
  }, [isDark, onThemeChange]);

  const handlePhaseClick = React.useCallback((phaseKey) => {
    if (onPhaseSelect) onPhaseSelect(togglePhase(selectedPhase, phaseKey));
  }, [onPhaseSelect, selectedPhase]);

  return (
    <aside className="w-52 shrink-0 flex flex-col bg-sidebar border-r border-sidebar-border">

      {/* ── Header ── */}
      <div className="p-3 pb-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-sidebar-foreground">Compose</h2>
          <div className="flex items-center gap-1.5">
            {!connected && (
              <span className="text-[10px] text-destructive">disconnected</span>
            )}
            {/* COMP-UI-5: + New button → opens ItemFormDialog */}
            {onNewItem && (
              <button
                onClick={onNewItem}
                className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-sidebar-accent transition-colors"
                title="New item (⌘N)"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              onClick={toggleTheme}
              className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-sidebar-accent transition-colors"
              title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

        {/* Compact stats */}
        <CompactStatsRow items={safeItems} gates={safeGates} />
      </div>

      {/* ── Active build status ── */}
      <BuildStatusWidget activeBuild={activeBuild} />

      {/* ── Agent telemetry (isolated to avoid re-render churn) ── */}
      <AgentPanel
        agentActivity={agentActivity}
        agentErrors={agentErrors}
        sessionState={sessionState}
        onSelectItem={onSelectItem}
        spawnedAgents={spawnedAgents}
        agentRelays={agentRelays}
      />

      {/* ── Attention queue (blocked + pending gates + decisions) ── */}
      {stats.attentionCount > 0 && (
        <>
          <Separator className="bg-sidebar-border" />
          <AttentionQueueSection
            items={safeItems}
            gates={safeGates}
            onSelectItem={onSelectItem}
            onViewChange={onViewChange}
          />
        </>
      )}

      {/* ── Search ── */}
      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="h-7 pl-7 text-xs bg-sidebar"
          />
        </div>
      </div>

      <Separator className="bg-sidebar-border" />

      {/* ── Group filter (by feature code prefix) ── */}
      <ScrollArea className="flex-1">
        <div className="p-2">
          <p
            className="text-[10px] font-medium uppercase tracking-wider px-2 mb-1"
            style={{ color: 'hsl(var(--muted-foreground))' }}
          >
            Groups
          </p>
          <GroupFilter items={safeItems} hiddenGroups={hiddenGroups} onToggleGroup={onToggleGroup} />
        </div>
      </ScrollArea>
    </aside>
  );
}

export default AttentionQueueSidebar;
