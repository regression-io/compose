import React, { useMemo } from 'react';
import { cn } from '@/lib/utils.js';
import { Badge } from '@/components/ui/badge.jsx';
import { Button } from '@/components/ui/button.jsx';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.jsx';
import { CheckCircle2, Circle, ArrowRight, Bot, FileText, Terminal } from 'lucide-react';
import { LIFECYCLE_PHASE_LABELS, LIFECYCLE_PHASE_ARTIFACTS } from './constants.js';

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
          <div key={phase} className="flex items-center gap-2">
            {done ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            ) : active ? (
              <ArrowRight className="w-3.5 h-3.5 text-blue-400 shrink-0" />
            ) : (
              <Circle className="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />
            )}
            <span className={cn(
              'text-[11px]',
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

function ActiveAgents({ spawnedAgents, activeBuild }) {
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
        <div className="mt-1 space-y-1">
          {running.map((a, i) => (
            <div key={i} className="flex items-center gap-2">
              <Bot className="w-3 h-3 text-emerald-400" />
              <span className="text-[11px] text-foreground">{a.type || a.agent || 'agent'}</span>
              <span className="text-[10px] text-emerald-400">running</span>
            </div>
          ))}
          {recent.map((a, i) => (
            <div key={`r-${i}`} className="flex items-center gap-2">
              <Bot className="w-3 h-3 text-muted-foreground/50" />
              <span className="text-[11px] text-muted-foreground">{a.type || a.agent || 'agent'}</span>
              <span className="text-[10px] text-muted-foreground/50">{a.status}</span>
            </div>
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

function PendingGates({ gates, items, onResolveGate }) {
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
  onSelect,
  onResolveGate,
  onOpenGate,
}) {
  const featureItem = useMemo(
    () => items.find(i => i.featureCode === featureCode || i.lifecycle?.featureCode === featureCode),
    [items, featureCode],
  );

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
    <div className="flex-1 overflow-auto p-4 space-y-4">
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
        </div>
        {/* Progress bar */}
        <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-blue-500 transition-all duration-300"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
        <p className="text-[10px] text-muted-foreground mt-1">
          {phaseIdx >= 0 ? `${phaseIdx + 1} of ${PHASES.length} phases` : 'Phase unknown'}
        </p>
      </div>

      {/* B. Two-column grid */}
      <div className="grid grid-cols-2 gap-4">
        {/* Left: Phase Timeline */}
        <Card className="bg-card border-border">
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
        <Card className="bg-card border-border">
          <CardHeader className="p-3 pb-2">
            <CardTitle className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
              Agents &amp; Artifacts
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <ActiveAgents spawnedAgents={spawnedAgents} activeBuild={activeBuild} />
          </CardContent>
        </Card>
      </div>

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
        <PendingGates gates={pendingGates} items={items} onResolveGate={onResolveGate} />
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
  );
}
