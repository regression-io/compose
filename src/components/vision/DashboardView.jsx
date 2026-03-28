import React, { useMemo, useState, useCallback } from 'react';
import { cn } from '@/lib/utils.js';
import { Badge } from '@/components/ui/badge.jsx';
import { Button } from '@/components/ui/button.jsx';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.jsx';
import { CheckCircle2, Circle, ArrowRight, Bot, FileText, Terminal, List } from 'lucide-react';
import { LIFECYCLE_PHASE_LABELS, LIFECYCLE_PHASE_ARTIFACTS } from './constants.js';
import ArtifactDiff from '../shared/ArtifactDiff.jsx';
import AgentCard from '../shared/AgentCard.jsx';
import EventTimeline from './EventTimeline.jsx';

const PHASES = ['explore_design', 'prd', 'architecture', 'blueprint', 'plan', 'execute', 'report'];

function relativeTime(isoString) {
  if (!isoString) return '';
  const diffMs = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function PhaseTimeline({ currentPhase }) {
  const currentIdx = PHASES.indexOf(currentPhase);
  return (
    <div className="space-y-1.5">
      {PHASES.map((phase, idx) => {
        const done = currentIdx > idx;
        const active = currentIdx === idx;
        const label = LIFECYCLE_PHASE_LABELS[phase] ?? phase;
        return (
          <div
            key={phase}
            className="flex items-center gap-2"
            style={{
              animation: `phase-slide-in 300ms ease-out ${idx * 50}ms both`,
            }}
          >
            {done ? (
              <CheckCircle2
                className="w-3.5 h-3.5 text-emerald-400 shrink-0"
                style={{ animation: 'phase-check-pop 400ms ease-out' }}
              />
            ) : active ? (
              <ArrowRight
                className="w-3.5 h-3.5 text-blue-400 shrink-0"
                style={{ animation: 'phase-active-pulse 2s ease-in-out infinite' }}
              />
            ) : (
              <Circle className="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />
            )}
            <span className={cn(
              'text-[11px] transition-colors duration-500',
              done && 'text-emerald-400',
              active && 'text-blue-400 font-medium',
              !done && !active && 'text-muted-foreground/50',
            )}>
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ActiveAgents({ spawnedAgents, activeBuild, sessionState, agentActivity }) {
  const running = (spawnedAgents || []).filter(a => a.status === 'running');
  const recent = (spawnedAgents || [])
    .filter(a => a.status !== 'running')
    .slice(-3)
    .reverse();

  const artifacts = useMemo(() => {
    const expected = ['design.md', 'blueprint.md', 'plan.md', 'prd.md', 'architecture.md'];
    const completedSteps = new Set(
      (activeBuild?.steps || []).filter(s => s.status === 'done' || s.status === 'completed').map(s => s.id || s.name)
    );
    return expected.map(name => ({
      name,
      done: completedSteps.has(name) ||
        (activeBuild?.steps || []).some(s =>
          (s.status === 'done' || s.status === 'completed') &&
          (s.id?.includes(name.replace('.md', '')) || s.name?.includes(name.replace('.md', '')))
        ),
    }));
  }, [activeBuild]);

  return (
    <div className="space-y-3">
      {/* Running agents */}
      <div>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Agents</span>
        {running.length === 0 && recent.length === 0 && (
          <p className="text-[11px] text-muted-foreground/50 mt-1">No agents active</p>
        )}
        <div className="mt-1 space-y-1.5">
          {running.map((a, i) => (
            <AgentCard
              key={a.agentId || i}
              agent={a}
              toolCount={sessionState?.toolCount || 0}
              errorCount={sessionState?.errorCount || 0}
              currentTool={agentActivity?.tool}
              currentCategory={agentActivity?.category}
            />
          ))}
          {recent.map((a, i) => (
            <AgentCard
              key={a.agentId || `r-${i}`}
              agent={a}
            />
          ))}
        </div>
      </div>

      {/* Artifacts */}
      <div>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Artifacts</span>
        <div className="mt-1 space-y-1">
          {artifacts.map(art => (
            <div key={art.name} className="flex items-center gap-2">
              <FileText className={cn('w-3 h-3', art.done ? 'text-emerald-400' : 'text-muted-foreground/40')} />
              <span className={cn('text-[11px] font-mono', art.done ? 'text-foreground' : 'text-muted-foreground/50')}>
                {art.name}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PendingGates({ gates, allGates, items, onResolveGate }) {
  const priorMap = useMemo(() => {
    const map = new Map();
    const resolved = (allGates || []).filter(g =>
      g.resolvedAt && (g.outcome === 'revised' || g.outcome === 'revise')
    ).sort((a, b) => new Date(b.resolvedAt) - new Date(a.resolvedAt));
    for (const pg of gates || []) {
      const prior = resolved.find(rg =>
        rg.stepId === pg.stepId && rg.itemId === pg.itemId
      );
      if (prior?.artifactSnapshot && pg.artifactSnapshot) {
        map.set(pg.id, { priorSnapshot: prior.artifactSnapshot, currentSnapshot: pg.artifactSnapshot });
      }
    }
    return map;
  }, [gates, allGates]);

  if (!gates || gates.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground/50 px-1">No gates pending.</p>
    );
  }
  return (
    <div className="space-y-2">
      {gates.map(gate => {
        const item = items.find(i => i.id === gate.itemId);
        const completeness = gate.artifactAssessment?.completeness;
        return (
          <div key={gate.id} className="px-3 py-2 rounded border border-border bg-muted/30">
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-[11px] text-foreground truncate">
                  {item?.title ?? 'Unknown'}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {gate.stepId || gate.fromPhase || 'gate'}
                  {completeness != null && ` \u00b7 ${Math.round(completeness * 100)}% complete`}
                </p>
                {priorMap.has(gate.id) && (
                  <div className="mt-1">
                    <ArtifactDiff
                      oldText={priorMap.get(gate.id).priorSnapshot}
                      newText={priorMap.get(gate.id).currentSnapshot}
                    />
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="outline" size="sm"
                  className="h-6 text-[10px] gap-1 text-success border-success/30 hover:bg-success/10"
                  onClick={() => onResolveGate(gate.id, 'approved')}
                >
                  Approve
                </Button>
                <Button
                  variant="outline" size="sm"
                  className="h-6 text-[10px] gap-1 text-amber-400 border-amber-400/30 hover:bg-amber-400/10"
                  onClick={() => onResolveGate(gate.id, 'revised')}
                >
                  Revise
                </Button>
                <Button
                  variant="outline" size="sm"
                  className="h-6 text-[10px] gap-1 text-destructive border-destructive/30 hover:bg-destructive/10"
                  onClick={() => onResolveGate(gate.id, 'killed')}
                >
                  Kill
                </Button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RecentSessions({ sessions, items, onSelect }) {
  const recent = (sessions || []).slice(-5).reverse();
  if (recent.length === 0) {
    return <p className="text-[11px] text-muted-foreground/50 px-1">No sessions yet.</p>;
  }
  return (
    <div className="space-y-1">
      {recent.map(s => {
        const fc = s.featureCode || s.feature_code;
        const featureItem = fc
          ? items.find(i => i.featureCode === fc || i.feature_code === fc || i.lifecycle?.featureCode === fc)
          : null;
        const startedAt = s.startedAt || s.created_date;
        return (
          <div
            key={s.id}
            className={cn(
              'flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50 transition-colors',
              featureItem && 'cursor-pointer',
            )}
            onClick={() => featureItem && onSelect(featureItem.id)}
          >
            <Terminal className="w-3 h-3 text-muted-foreground shrink-0" />
            <span className="text-[11px] text-foreground">{s.agent || 'agent'}</span>
            {fc && (
              <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 font-mono">
                {fc}
              </Badge>
            )}
            <span className="ml-auto text-[10px] text-muted-foreground tabular-nums shrink-0">
              {relativeTime(startedAt)}
            </span>
            <span className={cn(
              'w-1.5 h-1.5 rounded-full shrink-0',
              s.status === 'active' ? 'bg-emerald-400' : 'bg-slate-600',
            )} />
          </div>
        );
      })}
    </div>
  );
}

export default function DashboardView({
  items = [],
  gates = [],
  sessions = [],
  activeBuild,
  spawnedAgents = [],
  featureCode,
  sessionState,
  agentActivity,
  iterationStates,
  onSelect,
  onResolveGate,
  onOpenGate,
}) {
  const featureItem = useMemo(
    () => items.find(i => i.featureCode === featureCode || i.lifecycle?.featureCode === featureCode),
    [items, featureCode],
  );

  const [timelineOpen, setTimelineOpen] = useState(() => {
    try { return localStorage.getItem('compose:timeline-open') === 'true'; } catch { return false; }
  });
  const toggleTimeline = useCallback(() => {
    setTimelineOpen(prev => {
      const next = !prev;
      try { localStorage.setItem('compose:timeline-open', String(next)); } catch {}
      return next;
    });
  }, []);

  const currentPhase = featureItem?.lifecycle?.currentPhase || featureItem?.phase || activeBuild?.currentStepId || activeBuild?.currentStep || null;

  const phaseIdx = PHASES.indexOf(currentPhase);
  const progress = currentPhase ? Math.max(0, (phaseIdx + 1) / PHASES.length) : 0;

  const pendingGates = useMemo(() => {
    let pg = gates.filter(g => g.status === 'pending' || !g.resolvedAt);
    if (featureCode) {
      const featureItemIds = new Set(
        items.filter(i => i.featureCode === featureCode || i.lifecycle?.featureCode === featureCode).map(i => i.id),
      );
      pg = pg.filter(g => featureItemIds.has(g.itemId));
    }
    return pg;
  }, [gates, items, featureCode]);

  // Empty state: no feature in progress
  if (!featureCode) {
    const completedFeatures = items
      .filter(i => i.type === 'feature' && (i.status === 'complete' || i.status === 'done'))
      .slice(-5);
    return (
      <div className="flex-1 overflow-auto p-4">
        <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
          <p className="text-sm text-muted-foreground">No feature in progress.</p>
          <p className="text-[11px] text-muted-foreground/70 font-mono">
            Run /compose &lt;feature-code&gt; in the terminal to start.
          </p>
          {completedFeatures.length > 0 && (
            <div className="mt-6 w-full max-w-sm">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                Recently completed
              </span>
              <div className="mt-2 space-y-1">
                {completedFeatures.map(f => (
                  <div
                    key={f.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50 cursor-pointer transition-colors"
                    onClick={() => onSelect(f.id)}
                  >
                    <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                    <span className="text-[11px] text-foreground truncate">{f.title}</span>
                    {f.featureCode && (
                      <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 font-mono ml-auto shrink-0">
                        {f.featureCode}
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-row overflow-hidden">
      {/* Main dashboard content */}
      <div className="flex-1 overflow-auto p-4 space-y-4 min-w-0">
      {/* A. Feature Header */}
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground truncate">
            {featureItem?.title ?? featureCode}
          </h2>
          <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 font-mono shrink-0">
            {featureCode}
          </Badge>
          {currentPhase && (
            <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 shrink-0">
              {LIFECYCLE_PHASE_LABELS[currentPhase] ?? currentPhase}
            </Badge>
          )}
          <button
            className={cn(
              'ml-auto flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors shrink-0',
              timelineOpen
                ? 'bg-foreground/10 text-foreground'
                : 'text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/30',
            )}
            onClick={toggleTimeline}
          >
            <List className="w-3 h-3" />
            Timeline
          </button>
        </div>
        {/* Progress bar */}
        <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-blue-500"
            style={{
              width: `${Math.round(progress * 100)}%`,
              transition: 'width 800ms cubic-bezier(0.4, 0, 0.2, 1)',
            }}
          />
        </div>
        <p className="text-[10px] text-muted-foreground mt-1">
          {phaseIdx >= 0 ? `${phaseIdx + 1} of ${PHASES.length} phases` : 'Phase unknown'}
        </p>
      </div>

      {/* B. Two-column grid */}
      <div className="grid grid-cols-2 gap-4">
        {/* Left: Phase Timeline */}
        <Card className="bg-card border-border" style={{ animation: 'phase-card-enter 400ms ease-out' }}>
          <CardHeader className="p-3 pb-2">
            <CardTitle className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
              Phase Timeline
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <PhaseTimeline currentPhase={currentPhase} />
          </CardContent>
        </Card>

        {/* Right: Active Agents + Artifacts */}
        <Card className="bg-card border-border" style={{ animation: 'phase-card-enter 400ms ease-out 100ms both' }}>
          <CardHeader className="p-3 pb-2">
            <CardTitle className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
              Agents &amp; Artifacts
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <ActiveAgents spawnedAgents={spawnedAgents} activeBuild={activeBuild} sessionState={sessionState} agentActivity={agentActivity} />
          </CardContent>
        </Card>
      </div>

      {/* B2. Iteration Progress (COMP-UX-9) */}
      {iterationStates && iterationStates.size > 0 && (
        <div className="space-y-2">
          {[...iterationStates.values()].map(iter => (
            <div key={iter.loopId} className="px-3 py-2.5 rounded border border-blue-500/30 bg-blue-500/10">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] text-blue-400 font-medium">
                  {iter.status === 'running' ? '\u21BB' : iter.outcome === 'clean' ? '\u2713' : '\u2717'}
                  {' '}{iter.loopType === 'review' ? 'Review Loop' : 'Coverage Sweep'}
                </span>
                <span className="text-[11px] text-blue-300 font-mono">
                  {iter.count} of {iter.maxIterations}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-blue-500/20 overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.round((iter.count / iter.maxIterations) * 100)}%`,
                    transition: 'width 600ms cubic-bezier(0.4, 0, 0.2, 1)',
                    backgroundColor: iter.outcome === 'clean' ? '#22c55e' :
                      iter.outcome === 'max_reached' ? '#ef4444' : '#3b82f6',
                  }}
                />
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                {iter.status === 'running'
                  ? (iter.loopType === 'review' ? 'Waiting for clean review...' : 'Waiting for tests passing...')
                  : iter.outcome === 'clean' ? 'Clean!'
                  : iter.outcome === 'max_reached' ? 'Max iterations reached'
                  : 'Aborted'}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* C. Pending Gates */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
            Pending Gates
          </span>
          {pendingGates.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-400/15 text-amber-400 font-medium">
              {pendingGates.length}
            </span>
          )}
        </div>
        <PendingGates gates={pendingGates} allGates={gates} items={items} onResolveGate={onResolveGate} />
      </div>

      {/* D. Recent Sessions */}
      <div>
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
          Recent Sessions
        </span>
        <div className="mt-2">
          <RecentSessions sessions={sessions} items={items} onSelect={onSelect} />
        </div>
      </div>
      </div>

      {/* E. Event Timeline Panel (COMP-UX-11) */}
      {timelineOpen && (
        <div className="w-80 border-l border-border flex flex-col shrink-0">
          <div className="px-3 py-2 border-b border-border">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
              Event Timeline
            </span>
          </div>
          <EventTimeline
            featureCode={featureCode}
            itemId={featureItem?.id}
            onSelectItem={onSelect}
          />
        </div>
      )}
    </div>
  );
}
