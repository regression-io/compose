/**
 * IdeaboxView — main view for the ideabox feature.
 *
 * Layout:
 *   Header: digest summary + Triage button
 *   Filter bar: tag, status, priority dropdowns + search
 *   Body: ideas grouped by cluster, sorted by priority
 *   Each idea = a card: ID badge, title, tags, priority badge, source, status dot
 *   Graveyard: collapsible killed ideas section with resurrect button
 *   Drag-and-drop between priority lanes (P0/P1/P2/untriaged) — HTML5 drag API
 *   Click card → opens context panel with full details
 */

import React, { useState, useMemo, useCallback } from 'react';
import { Lightbulb, Filter, Search, ChevronDown, ChevronRight, RefreshCw, LayoutGrid, Grid2X2, MessageSquare, Send } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { Badge } from '@/components/ui/badge.jsx';
import { Button } from '@/components/ui/button.jsx';
import { useIdeaboxStore } from './useIdeaboxStore.js';
import IdeaboxTriagePanel from './IdeaboxTriagePanel.jsx';
import IdeaboxPromoteDialog from './IdeaboxPromoteDialog.jsx';
import IdeaboxMatrixView from './IdeaboxMatrixView.jsx';
import IdeaboxAnalytics from './IdeaboxAnalytics.jsx';

// ---------------------------------------------------------------------------
// Priority lane config
// ---------------------------------------------------------------------------

const PRIORITY_LANES = [
  { key: 'P0', label: 'P0', color: 'text-red-400', bg: 'bg-red-400/10', border: 'border-red-400/30' },
  { key: 'P1', label: 'P1', color: 'text-amber-400', bg: 'bg-amber-400/10', border: 'border-amber-400/30' },
  { key: 'P2', label: 'P2', color: 'text-blue-400', bg: 'bg-blue-400/10', border: 'border-blue-400/30' },
  { key: '—',  label: 'Untriaged', color: 'text-muted-foreground', bg: 'bg-muted/20', border: 'border-border/50' },
];

function priorityOrder(p) {
  if (p === 'P0') return 0;
  if (p === 'P1') return 1;
  if (p === 'P2') return 2;
  return 3;
}

// ---------------------------------------------------------------------------
// Status dot
// ---------------------------------------------------------------------------

function StatusDot({ status }) {
  const cls = status === 'NEW'
    ? 'bg-emerald-400'
    : status === 'DISCUSSING'
    ? 'bg-amber-400'
    : status?.startsWith('PROMOTED')
    ? 'bg-blue-400'
    : 'bg-muted-foreground/40';
  return <span className={cn('inline-block w-2 h-2 rounded-full shrink-0', cls)} title={status} />;
}

// ---------------------------------------------------------------------------
// Priority badge
// ---------------------------------------------------------------------------

function PriorityBadge({ priority }) {
  if (!priority || priority === '—') {
    return (
      <span className="text-[9px] px-1 py-0.5 rounded border border-border/40 text-muted-foreground/60">
        untriaged
      </span>
    );
  }
  const colorMap = {
    P0: 'bg-red-400/15 text-red-400 border-red-400/30',
    P1: 'bg-amber-400/15 text-amber-400 border-amber-400/30',
    P2: 'bg-blue-400/15 text-blue-400 border-blue-400/30',
  };
  return (
    <span className={cn('text-[9px] px-1.5 py-0.5 rounded border font-mono font-semibold', colorMap[priority] || 'border-border/40 text-muted-foreground')}>
      {priority}
    </span>
  );
}

// ---------------------------------------------------------------------------
// IdeaCard
// ---------------------------------------------------------------------------

function IdeaCard({ idea, selected, onClick, onDragStart, onDragEnd }) {
  return (
    <div
      draggable
      onDragStart={(e) => onDragStart?.(e, idea.id)}
      onDragEnd={onDragEnd}
      onClick={() => onClick?.(idea.id)}
      className={cn(
        'group px-3 py-2.5 rounded border cursor-pointer transition-colors select-none',
        'hover:border-accent/50',
        selected
          ? 'border-accent/60 bg-accent/5'
          : 'border-border/50 bg-card/60',
      )}
    >
      {/* Top row: ID badge + status dot + priority */}
      <div className="flex items-center gap-1.5 mb-1">
        <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 font-mono shrink-0">
          {idea.id}
        </Badge>
        <StatusDot status={idea.status} />
        <div className="flex-1" />
        <PriorityBadge priority={idea.priority} />
      </div>

      {/* Title */}
      <p className="text-[12px] text-foreground font-medium leading-snug mb-1 line-clamp-2">
        {idea.title}
      </p>

      {/* Tags */}
      {idea.tags?.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1">
          {idea.tags.slice(0, 4).map(tag => (
            <span key={tag} className="text-[9px] text-muted-foreground/70 font-mono">
              {tag}
            </span>
          ))}
          {idea.tags.length > 4 && (
            <span className="text-[9px] text-muted-foreground/50">+{idea.tags.length - 4}</span>
          )}
        </div>
      )}

      {/* Source */}
      {idea.source && (
        <p className="text-[10px] text-muted-foreground/60 truncate">
          {idea.source}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// IdeaDetailPanel (side panel shown on card click)
// ---------------------------------------------------------------------------

function IdeaDetailPanel({ idea, onClose, onPromote, onKill, onSetPriority, onAddDiscussion }) {
  const [killReason, setKillReason] = useState('');
  const [showKillForm, setShowKillForm] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [discussionText, setDiscussionText] = useState('');
  const [submittingDiscussion, setSubmittingDiscussion] = useState(false);

  if (!idea) return null;

  const handleSubmitDiscussion = async () => {
    const text = discussionText.trim();
    if (!text) return;
    setSubmittingDiscussion(true);
    try {
      await onAddDiscussion(idea.id, 'human', text);
      setDiscussionText('');
    } finally {
      setSubmittingDiscussion(false);
    }
  };

  return (
    <div className="w-80 border-l border-border flex flex-col shrink-0 overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border flex items-center gap-2">
        <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 font-mono">
          {idea.id}
        </Badge>
        <StatusDot status={idea.status} />
        <span className="text-[11px] text-muted-foreground flex-1 truncate">{idea.status}</span>
        <button
          onClick={onClose}
          className="text-muted-foreground/60 hover:text-foreground text-xs px-1"
        >
          x
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-3 space-y-3">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Title</p>
          <p className="text-[13px] text-foreground font-medium leading-snug">{idea.title}</p>
        </div>

        {idea.description && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Description</p>
            <p className="text-[11px] text-muted-foreground leading-relaxed">{idea.description}</p>
          </div>
        )}

        {idea.source && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Source</p>
            <p className="text-[11px] text-muted-foreground">{idea.source}</p>
          </div>
        )}

        {idea.cluster && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Cluster</p>
            <p className="text-[11px] text-muted-foreground">{idea.cluster}</p>
          </div>
        )}

        {idea.tags?.length > 0 && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Tags</p>
            <div className="flex flex-wrap gap-1">
              {idea.tags.map(tag => (
                <span key={tag} className="text-[10px] bg-muted/50 px-1.5 py-0.5 rounded font-mono text-muted-foreground">
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}

        {idea.mapsTo && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Maps To</p>
            <p className="text-[11px] text-muted-foreground font-mono">{idea.mapsTo}</p>
          </div>
        )}

        {/* Discussion thread */}
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
            <MessageSquare className="w-3 h-3" />
            Discussion
            {idea.discussion?.length > 0 && (
              <span className="text-muted-foreground/50">({idea.discussion.length})</span>
            )}
          </p>
          {idea.discussion?.length > 0 && (
            <div className="space-y-1.5 mb-2">
              {idea.discussion.map((entry, i) => (
                <div key={i} className="px-2 py-1.5 rounded bg-muted/30 border border-border/30">
                  <div className="flex items-center gap-1 mb-0.5">
                    <span className={cn(
                      'text-[9px] font-mono font-semibold',
                      entry.author === 'agent' ? 'text-blue-400' : 'text-emerald-400'
                    )}>
                      {entry.author}
                    </span>
                    <span className="text-[9px] text-muted-foreground/50">{entry.date}</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">{entry.text}</p>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-1.5 items-end">
            <input
              type="text"
              placeholder="Add comment…"
              value={discussionText}
              onChange={e => setDiscussionText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSubmitDiscussion()}
              className="flex-1 text-[11px] bg-muted text-foreground px-2 py-1.5 rounded border border-border outline-none focus:border-ring"
              disabled={submittingDiscussion}
            />
            <button
              onClick={handleSubmitDiscussion}
              disabled={!discussionText.trim() || submittingDiscussion}
              className="shrink-0 p-1.5 rounded border border-border/50 text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors"
            >
              <Send className="w-3 h-3" />
            </button>
          </div>
        </div>

        {/* Priority selector */}
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Priority</p>
          <div className="flex gap-1.5">
            {['P0', 'P1', 'P2', '—'].map(p => (
              <button
                key={p}
                onClick={() => onSetPriority(idea.id, p)}
                className={cn(
                  'flex-1 text-[10px] px-1.5 py-1 rounded border transition-colors',
                  idea.priority === p
                    ? p === 'P0' ? 'bg-red-400/20 text-red-400 border-red-400/50'
                    : p === 'P1' ? 'bg-amber-400/20 text-amber-400 border-amber-400/50'
                    : p === 'P2' ? 'bg-blue-400/20 text-blue-400 border-blue-400/50'
                    : 'bg-muted text-muted-foreground border-border'
                    : 'border-border/40 text-muted-foreground hover:border-border',
                )}
              >
                {p === '—' ? 'none' : p}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Actions */}
      {!idea.status?.startsWith('PROMOTED') && idea.status !== 'KILLED' && (
        <div className="p-3 border-t border-border space-y-2">
          <Button
            size="sm"
            className="w-full h-7 text-[11px]"
            onClick={() => onPromote(idea)}
          >
            Promote to Feature
          </Button>

          {!showKillForm ? (
            <Button
              size="sm"
              variant="outline"
              className="w-full h-7 text-[11px] text-destructive border-destructive/30 hover:bg-destructive/10"
              onClick={() => setShowKillForm(true)}
            >
              Kill
            </Button>
          ) : (
            <div className="space-y-1.5">
              <input
                autoFocus
                type="text"
                placeholder="Reason for killing…"
                value={killReason}
                onChange={e => setKillReason(e.target.value)}
                className="w-full text-[11px] bg-muted text-foreground px-2 py-1.5 rounded border border-border outline-none focus:border-ring"
              />
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 h-7 text-[10px]"
                  onClick={() => { setShowKillForm(false); setKillReason(''); }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="flex-1 h-7 text-[10px] bg-destructive/80 hover:bg-destructive text-destructive-foreground"
                  onClick={() => { onKill(idea.id, killReason); setShowKillForm(false); setKillReason(''); }}
                >
                  Confirm Kill
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GraveyardSection
// ---------------------------------------------------------------------------

function GraveyardSection({ killed, onResurrect }) {
  const [open, setOpen] = useState(false);

  if (killed.length === 0) return null;

  return (
    <div className="mt-4 border border-border/40 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-4 py-2.5 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
      >
        {open ? <ChevronDown className="w-3 h-3 text-muted-foreground" /> : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
          Graveyard
        </span>
        <span className="text-[10px] text-muted-foreground/60 ml-1">({killed.length})</span>
      </button>

      {open && (
        <div className="p-3 grid grid-cols-1 gap-2 bg-muted/10">
          {killed.map(idea => (
            <div key={idea.id} className="px-3 py-2 rounded border border-border/40 bg-card/40">
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 font-mono shrink-0 opacity-60">
                      {idea.id}
                    </Badge>
                    <p className="text-[11px] text-muted-foreground/70 line-clamp-1 font-medium">
                      {idea.title}
                    </p>
                  </div>
                  {idea.killedDate && (
                    <p className="text-[10px] text-muted-foreground/50">
                      Killed {idea.killedDate}{idea.killedReason ? ` — ${idea.killedReason}` : ''}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => onResurrect(idea.id)}
                  className="shrink-0 text-[10px] text-muted-foreground/60 hover:text-foreground border border-border/40 px-1.5 py-0.5 rounded transition-colors"
                  title="Resurrect"
                >
                  Resurrect
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// IdeaboxView
// ---------------------------------------------------------------------------

export default function IdeaboxView() {
  const {
    ideas, killed, loading, error, selectedIdeaId, filters,
    hydrate, setPriority, killIdea, resurrectIdea,
    setSelectedIdea, updateFilters, addDiscussion, updateIdea,
  } = useIdeaboxStore();

  const [triageOpen, setTriageOpen] = useState(false);
  const [promoteIdea, setPromoteIdea] = useState(null); // idea to promote
  const [dragIdeaId, setDragIdeaId] = useState(null);
  const [dragOverLane, setDragOverLane] = useState(null);
  const [viewMode, setViewMode] = useState('cards'); // 'cards' | 'matrix'

  // ── Digest summary ────────────────────────────────────────────────────────

  const digest = useMemo(() => {
    const newCount = ideas.filter(i => i.status === 'NEW').length;
    const untriaged = ideas.filter(i => !i.priority || i.priority === '—').length;
    const p0Count = ideas.filter(i => i.priority === 'P0').length;

    // Top P0 cluster (by count)
    const clusterCounts = {};
    ideas.filter(i => i.priority === 'P0' && i.cluster).forEach(i => {
      clusterCounts[i.cluster] = (clusterCounts[i.cluster] || 0) + 1;
    });
    const topCluster = Object.entries(clusterCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    return { newCount, untriaged, p0Count, topCluster };
  }, [ideas]);

  // ── All available tags (for filter dropdown) ──────────────────────────────

  const allTags = useMemo(() => {
    const set = new Set();
    ideas.forEach(i => (i.tags || []).forEach(t => set.add(t)));
    return [...set].sort();
  }, [ideas]);

  // ── Filtered ideas ────────────────────────────────────────────────────────

  const filteredIdeas = useMemo(() => {
    return ideas.filter(idea => {
      if (filters.tag && !idea.tags?.includes(filters.tag)) return false;
      if (filters.status) {
        // Status may be plain (NEW, DISCUSSING) or annotated (PROMOTED (→ FEAT-X))
        // Use prefix match so "PROMOTED" filter catches all promoted statuses
        const ideaStatusPrefix = (idea.status || '').split(/\s+/)[0];
        if (ideaStatusPrefix !== filters.status) return false;
      }
      if (filters.priority && idea.priority !== filters.priority) return false;
      if (filters.search) {
        const q = filters.search.toLowerCase();
        const haystack = `${idea.title} ${idea.description} ${idea.id} ${(idea.tags || []).join(' ')}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [ideas, filters]);

  // ── Group by cluster, then sort by priority within each cluster ───────────

  const grouped = useMemo(() => {
    const clusterMap = new Map();
    const unclustered = [];

    filteredIdeas.forEach(idea => {
      if (idea.cluster) {
        if (!clusterMap.has(idea.cluster)) clusterMap.set(idea.cluster, []);
        clusterMap.get(idea.cluster).push(idea);
      } else {
        unclustered.push(idea);
      }
    });

    const sortByPriority = (arr) => [...arr].sort((a, b) => priorityOrder(a.priority) - priorityOrder(b.priority));

    const result = [];
    for (const [cluster, clusterIdeas] of clusterMap) {
      result.push({ cluster, ideas: sortByPriority(clusterIdeas) });
    }
    if (unclustered.length > 0) {
      result.push({ cluster: null, ideas: sortByPriority(unclustered) });
    }
    return result;
  }, [filteredIdeas]);

  // ── Selected idea object ──────────────────────────────────────────────────

  const selectedIdea = useMemo(
    () => ideas.find(i => i.id === selectedIdeaId) || killed.find(i => i.id === selectedIdeaId) || null,
    [ideas, killed, selectedIdeaId],
  );

  // ── Drag-and-drop handlers ────────────────────────────────────────────────

  const handleDragStart = useCallback((e, ideaId) => {
    setDragIdeaId(ideaId);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragEnd = useCallback(() => {
    setDragIdeaId(null);
    setDragOverLane(null);
  }, []);

  const handleDragOver = useCallback((e, laneKey) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverLane(laneKey);
  }, []);

  const handleDrop = useCallback(async (e, laneKey) => {
    e.preventDefault();
    if (dragIdeaId) {
      await setPriority(dragIdeaId, laneKey);
    }
    setDragIdeaId(null);
    setDragOverLane(null);
  }, [dragIdeaId, setPriority]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 flex flex-row overflow-hidden">
      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Header */}
        <div className="px-4 py-2.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2 mb-1">
            <Lightbulb className="w-4 h-4 text-amber-400 shrink-0" />
            <h2 className="text-sm font-semibold text-foreground">Ideabox</h2>
            {loading && (
              <RefreshCw className="w-3 h-3 text-muted-foreground animate-spin" />
            )}
            <div className="flex-1" />
            {/* View mode toggle */}
            <div className="flex items-center gap-0.5 border border-border/50 rounded-md p-0.5">
              <button
                onClick={() => setViewMode('cards')}
                className={cn(
                  'text-[10px] px-2 py-0.5 rounded transition-colors',
                  viewMode === 'cards'
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                Cards
              </button>
              <button
                onClick={() => setViewMode('matrix')}
                className={cn(
                  'text-[10px] px-2 py-0.5 rounded transition-colors',
                  viewMode === 'matrix'
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                Matrix
              </button>
            </div>
            <button
              onClick={() => hydrate()}
              className="text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
              title="Refresh"
            >
              <RefreshCw className="w-3 h-3" />
            </button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[10px] gap-1"
              onClick={() => setTriageOpen(true)}
              disabled={digest.untriaged === 0}
            >
              Triage ({digest.untriaged})
            </Button>
          </div>

          {/* Digest */}
          <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
            {digest.newCount > 0 && (
              <span className="text-emerald-400">{digest.newCount} new</span>
            )}
            <span>{digest.untriaged} untriaged</span>
            {digest.p0Count > 0 && (
              <span className="text-red-400">{digest.p0Count} P0</span>
            )}
            {digest.topCluster && (
              <span>top cluster: <span className="text-foreground">{digest.topCluster}</span></span>
            )}
            <span className="text-muted-foreground/40">{ideas.length} total</span>
          </div>

          {/* Analytics section (collapsible) */}
          <IdeaboxAnalytics ideas={ideas} killed={killed} />
        </div>

        {/* Filter bar */}
        <div className="px-4 py-2 border-b border-border shrink-0 flex items-center gap-2 flex-wrap">
          <Filter className="w-3 h-3 text-muted-foreground/60 shrink-0" />

          {/* Tag filter */}
          <select
            value={filters.tag}
            onChange={e => updateFilters({ tag: e.target.value })}
            className="text-[11px] bg-muted text-foreground px-2 py-1 rounded border border-border/50 cursor-pointer h-6"
          >
            <option value="">All tags</option>
            {allTags.map(t => <option key={t} value={t}>{t}</option>)}
          </select>

          {/* Status filter */}
          <select
            value={filters.status}
            onChange={e => updateFilters({ status: e.target.value })}
            className="text-[11px] bg-muted text-foreground px-2 py-1 rounded border border-border/50 cursor-pointer h-6"
          >
            <option value="">All statuses</option>
            <option value="NEW">New</option>
            <option value="DISCUSSING">Discussing</option>
            <option value="PROMOTED">Promoted</option>
          </select>

          {/* Priority filter */}
          <select
            value={filters.priority}
            onChange={e => updateFilters({ priority: e.target.value })}
            className="text-[11px] bg-muted text-foreground px-2 py-1 rounded border border-border/50 cursor-pointer h-6"
          >
            <option value="">All priorities</option>
            <option value="P0">P0</option>
            <option value="P1">P1</option>
            <option value="P2">P2</option>
            <option value="—">Untriaged</option>
          </select>

          {/* Search */}
          <div className="flex items-center gap-1 flex-1 min-w-[120px]">
            <Search className="w-3 h-3 text-muted-foreground/60 shrink-0" />
            <input
              type="text"
              placeholder="Search…"
              value={filters.search}
              onChange={e => updateFilters({ search: e.target.value })}
              className="flex-1 text-[11px] bg-transparent text-foreground outline-none placeholder:text-muted-foreground/40 min-w-0"
            />
          </div>

          {/* Clear */}
          {(filters.tag || filters.status || filters.priority || filters.search) && (
            <button
              onClick={() => useIdeaboxStore.getState().clearFilters()}
              className="text-[10px] text-muted-foreground/60 hover:text-foreground transition-colors"
            >
              Clear
            </button>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-4">
          {error && (
            <div className="mb-4 px-3 py-2 rounded border border-destructive/30 bg-destructive/10">
              <p className="text-[11px] text-destructive">{error}</p>
            </div>
          )}

          {/* Matrix view */}
          {viewMode === 'matrix' && (
            <IdeaboxMatrixView
              ideas={filteredIdeas}
              selectedIdeaId={selectedIdeaId}
              onSelectIdea={setSelectedIdea}
              onUpdateIdea={updateIdea}
            />
          )}

          {viewMode === 'cards' && filteredIdeas.length === 0 && !loading && (
            <div className="flex flex-col items-center justify-center py-16 text-center gap-2">
              <Lightbulb className="w-8 h-8 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">No ideas yet.</p>
              <p className="text-[11px] text-muted-foreground/60">
                Use the CLI: <span className="font-mono">compose idea "Your idea title"</span>
              </p>
            </div>
          )}

          {viewMode === 'cards' && grouped.map(({ cluster, ideas: clusterIdeas }) => (
            <div key={cluster || '__unclustered__'} className="mb-6">
              {cluster && (
                <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-3 flex items-center gap-2">
                  <span>{cluster}</span>
                  <span className="text-muted-foreground/40 normal-case tracking-normal font-normal">({clusterIdeas.length})</span>
                </h3>
              )}

              {/* Priority lanes */}
              <div className="grid grid-cols-4 gap-3">
                {PRIORITY_LANES.map(lane => {
                  const laneIdeas = clusterIdeas.filter(i => i.priority === lane.key);
                  const isDragTarget = dragOverLane === lane.key && dragIdeaId;
                  return (
                    <div
                      key={lane.key}
                      className={cn(
                        'rounded-lg border p-2 min-h-[80px] transition-colors',
                        lane.bg, lane.border,
                        isDragTarget && 'ring-1 ring-accent',
                      )}
                      onDragOver={(e) => handleDragOver(e, lane.key)}
                      onDrop={(e) => handleDrop(e, lane.key)}
                    >
                      <div className="flex items-center gap-1.5 mb-2">
                        <span className={cn('text-[10px] font-semibold uppercase tracking-wider', lane.color)}>
                          {lane.label}
                        </span>
                        <span className="text-[9px] text-muted-foreground/50">({laneIdeas.length})</span>
                      </div>
                      <div className="space-y-1.5">
                        {laneIdeas.map(idea => (
                          <IdeaCard
                            key={idea.id}
                            idea={idea}
                            selected={selectedIdeaId === idea.id}
                            onClick={setSelectedIdea}
                            onDragStart={handleDragStart}
                            onDragEnd={handleDragEnd}
                          />
                        ))}
                        {laneIdeas.length === 0 && (
                          <p className="text-[10px] text-muted-foreground/30 text-center py-2">
                            Drop here
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Graveyard — cards mode only */}
          {viewMode === 'cards' && (
            <GraveyardSection killed={killed} onResurrect={resurrectIdea} />
          )}
        </div>
      </div>

      {/* Detail panel */}
      {selectedIdea && (
        <IdeaDetailPanel
          idea={selectedIdea}
          onClose={() => setSelectedIdea(null)}
          onPromote={(idea) => setPromoteIdea(idea)}
          onKill={killIdea}
          onSetPriority={setPriority}
          onAddDiscussion={addDiscussion}
        />
      )}

      {/* Triage panel */}
      {triageOpen && (
        <IdeaboxTriagePanel
          ideas={ideas.filter(i => !i.priority || i.priority === '—')}
          onClose={() => setTriageOpen(false)}
        />
      )}

      {/* Promote dialog */}
      {promoteIdea && (
        <IdeaboxPromoteDialog
          idea={promoteIdea}
          onClose={() => setPromoteIdea(null)}
        />
      )}
    </div>
  );
}
