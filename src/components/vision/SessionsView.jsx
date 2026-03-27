import React, { useState, useMemo } from 'react';
import { Search, Activity } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { WORK_TYPE_COLORS, AGENTS } from './constants.js';
import { filterSessions, relativeTime } from './vision-logic.js';
import StatusBadge from './shared/StatusBadge.jsx';
import AgentAvatar from './shared/AgentAvatar.jsx';
import RelativeTime from './shared/RelativeTime.jsx';
import EmptyState from './shared/EmptyState.jsx';
import FeatureFocusToggle from '../shared/FeatureFocusToggle.jsx';

const STATUS_COLORS_SESSION = {
  active:    'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  completed: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
  failed:    'bg-red-500/10 text-red-400 border-red-500/20',
  paused:    'bg-amber-500/10 text-amber-400 border-amber-500/20',
};

const AGENT_COLORS = {
  claude:  'bg-orange-500/15 text-orange-400',
  codex:   'bg-emerald-500/15 text-emerald-400',
  gemini:  'bg-blue-500/15 text-blue-400',
  human:   'bg-slate-500/15 text-slate-400',
};

/**
 * SessionsView — Browse and filter agent sessions.
 *
 * Props:
 *   sessions     — from useVisionStore().sessions
 *   items        — from useVisionStore().items (for feature-code → item lookup)
 *   onSelectItem — (itemId) => void
 *
 * Note: visionState WS payload does not yet include sessions. This component
 * renders an empty state gracefully until server-side broadcast is extended.
 */
export default function SessionsView({ sessions = [], items = [], onSelectItem, featureCode, focusActive, onToggleFocus }) {
  const [search, setSearch] = useState('');
  const [agentFilter, setAgentFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const activeCount = useMemo(
    () => sessions.filter(s => s.status === 'active').length,
    [sessions]
  );

  const filtered = useMemo(() => {
    let result = filterSessions(sessions, { search, agentFilter, statusFilter });
    // COMP-UX-2a: Feature focus filter
    if (focusActive && featureCode) {
      result = result.filter(s =>
        s.featureCode === featureCode || s.feature_code === featureCode
      );
    }
    return result;
  }, [sessions, search, agentFilter, statusFilter, focusActive, featureCode]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b border-border shrink-0">
        <FeatureFocusToggle featureCode={featureCode} active={focusActive} onToggle={onToggleFocus} />
        {/* Active count */}
        <div className="flex items-center gap-1 text-[10px]">
          <span className={cn(
            'w-2 h-2 rounded-full',
            activeCount > 0 ? 'bg-emerald-400' : 'bg-slate-600'
          )} />
          <span className="text-muted-foreground">{activeCount} active</span>
        </div>

        <div className="h-4 w-px bg-border" />

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="text-xs pl-5 pr-2 py-0.5 h-6 rounded bg-muted text-foreground border border-border w-32"
          />
        </div>

        {/* Agent filter */}
        <select
          value={agentFilter}
          onChange={e => setAgentFilter(e.target.value)}
          className="text-xs px-1.5 py-0.5 h-6 rounded bg-muted text-foreground border border-border cursor-pointer"
        >
          <option value="all">All agents</option>
          {AGENTS.filter(a => a !== 'unassigned').map(a => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>

        {/* Status filter */}
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="text-xs px-1.5 py-0.5 h-6 rounded bg-muted text-foreground border border-border cursor-pointer"
        >
          <option value="all">All status</option>
          {['active', 'completed', 'failed', 'paused'].map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <span className="ml-auto text-[10px] text-muted-foreground">
          {filtered.length}/{sessions.length}
        </span>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-auto">
        {filtered.length === 0 && (
          <EmptyState
            icon={Activity}
            title="No sessions"
            description="Sessions appear when agents start working"
            className="py-8"
          />
        )}
        {filtered.map(session => (
          <SessionRow
            key={session.id}
            session={session}
            items={items}
            onSelectItem={onSelectItem}
          />
        ))}
      </div>
    </div>
  );
}

function SessionRow({ session, items, onSelectItem }) {
  const workType = session.workType || session.work_type;
  const featureCode = session.featureCode || session.feature_code;
  const startedAt = session.startedAt || session.created_date;
  const workTypeCls = WORK_TYPE_COLORS[workType] || WORK_TYPE_COLORS.exploring;

  // Find matching vision item for feature code
  const featureItem = featureCode
    ? items.find(i => i.featureCode === featureCode || i.feature_code === featureCode || i.lifecycle?.featureCode === featureCode)
    : null;

  return (
    <div className="flex flex-col gap-1 px-3 py-2.5 border-b border-border/50 hover:bg-muted/30 transition-colors">
      {/* Row 1: agent avatar + status badge + work type + feature code + relative time */}
      <div className="flex items-center gap-2">
        <AgentAvatar agent={session.agent} size="sm" className="shrink-0" />
        <StatusBadge status={session.status} className="shrink-0" />
        {workType && (
          <span className={cn('text-[10px] px-1.5 py-0.5 rounded', workTypeCls)}>
            {workType}
          </span>
        )}
        {featureCode && (
          <button
            onClick={() => featureItem && onSelectItem?.(featureItem.id)}
            className={cn(
              'text-[10px] font-mono',
              featureItem
                ? 'text-blue-400 hover:underline cursor-pointer'
                : 'text-muted-foreground cursor-default'
            )}
          >
            {featureCode}
          </button>
        )}
        <RelativeTime date={startedAt} className="ml-auto text-[10px] shrink-0" />
      </div>

      {/* Row 2: summary */}
      {session.summary && (
        <p className="text-[11px] text-muted-foreground truncate">{session.summary}</p>
      )}

      {/* Row 3: counters */}
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span>📄 {session.reads ?? 0}</span>
        <span>📤 {session.writes ?? 0}</span>
        <span className={(session.errors ?? 0) > 0 ? 'text-red-400' : undefined}>
          ⚠ {session.errors ?? 0}
        </span>
      </div>
    </div>
  );
}
