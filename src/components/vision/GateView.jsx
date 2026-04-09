import React, { useMemo, useState } from 'react';
import { cn } from '@/lib/utils.js';
import { Badge } from '@/components/ui/badge.jsx';
import { Button } from '@/components/ui/button.jsx';
import { LIFECYCLE_PHASE_LABELS, LIFECYCLE_PHASE_ARTIFACTS, GATE_STEP_LABELS } from './constants.js';
import FeatureFocusToggle from '../shared/FeatureFocusToggle.jsx';
import ArtifactDiff from '../shared/ArtifactDiff.jsx';

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

function ArtifactAssessment({ gate }) {
  const assessment = gate.artifactAssessment;
  if (!assessment) return null;

  const artifactName = LIFECYCLE_PHASE_ARTIFACTS[gate.fromPhase];

  if (!assessment.exists) {
    return (
      <p className="text-[10px] text-muted-foreground">
        {artifactName ?? 'Artifact'} not found
      </p>
    );
  }

  return (
    <p className="text-[10px] text-muted-foreground">
      {artifactName && <span className="font-mono">{artifactName}</span>}
      {artifactName && ': '}
      {Math.round(assessment.completeness * 100)}% complete
      {' · '}{assessment.wordCount} words
      {assessment.sections?.missing?.length > 0 && (
        <span className="text-amber-400"> (missing: {assessment.sections.missing.join(', ')})</span>
      )}
      {!assessment.meetsMinWordCount && (
        <span className="text-amber-400"> (below min word count)</span>
      )}
    </p>
  );
}

// COMP-UX-3b: Derive a recommendation from the artifact assessment
function deriveRecommendation(gate) {
  const assessment = gate.artifactAssessment;
  const summary = gate.summary;

  if (summary) {
    const isRevise = /critical|error|fail|missing/i.test(summary);
    return { sentence: summary, outcome: isRevise ? 'revise' : 'approve' };
  }

  if (!assessment || !assessment.exists) return null;

  const { completeness, wordCount, sections, meetsMinWordCount, findings } = assessment;
  const criticalCount = (findings ?? []).filter(
    f => /critical|error|fatal/i.test(f.severity ?? f.level ?? '')
  ).length;
  const missingCount = sections?.missing?.length ?? 0;

  if (criticalCount > 0) {
    return { sentence: `${criticalCount} critical finding${criticalCount > 1 ? 's' : ''}`, outcome: 'revise' };
  }
  if (!meetsMinWordCount && wordCount !== undefined) {
    return { sentence: `Thin artifact (${wordCount} words)`, outcome: 'revise' };
  }
  if (missingCount > 0) {
    return { sentence: `Missing ${missingCount} section${missingCount > 1 ? 's' : ''}`, outcome: 'revise' };
  }
  const pct = completeness !== undefined ? `${Math.round(completeness * 100)}% complete` : null;
  const wc = wordCount !== undefined ? `${wordCount}w` : null;
  const detail = [pct, wc].filter(Boolean).join(', ');
  return { sentence: detail || 'Ready', outcome: 'approve' };
}

function RecommendationBadge({ gate }) {
  const rec = deriveRecommendation(gate);
  if (!rec) return null;
  const isApprove = rec.outcome === 'approve';
  return (
    <div className={`text-[10px] px-2 py-0.5 rounded font-medium ${
      isApprove
        ? 'bg-success/10 text-success border border-success/20'
        : 'bg-amber-400/10 text-amber-400 border border-amber-400/20'
    }`}>
      {isApprove ? 'Recommended: approve' : 'Recommended: revise'} — {rec.sentence}
    </div>
  );
}

function Section({ title, count, color, children }) {
  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</span>
        <span className="text-[10px] text-muted-foreground">{count}</span>
      </div>
      {children}
    </div>
  );
}

function PendingGateRow({ gate, item, priorRevision, isExpanded, expandedAction, onExpand, onResolve, onSelect }) {
  const [comment, setComment] = useState('');

  const handleSubmitRevise = () => {
    onResolve(gate.id, 'revised', comment || undefined);
    onExpand(null, null);
    setComment('');
  };

  const handleSubmitKill = () => {
    if (!comment.trim()) return;
    onResolve(gate.id, 'killed', comment);
    onExpand(null, null);
    setComment('');
  };

  return (
    <div className="px-3 py-2 border-l-2 border-l-transparent hover:bg-muted/50 transition-colors">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0 space-y-1">
          <button
            onClick={() => onSelect(gate.itemId)}
            className="text-sm text-foreground hover:text-accent transition-colors truncate block"
          >
            {item?.title ?? 'Unknown'}
          </button>
          <p className="text-[10px] text-muted-foreground">
            {GATE_STEP_LABELS[gate.stepId] ?? `${LIFECYCLE_PHASE_LABELS[gate.fromPhase] ?? gate.fromPhase} → ${LIFECYCLE_PHASE_LABELS[gate.toPhase] ?? gate.toPhase}`}
          </p>
          <ArtifactAssessment gate={gate} />
          {priorRevision ? (
            <div className="space-y-1">
              <div className="text-[10px] px-2 py-1 rounded bg-amber-400/10 border border-amber-400/20 text-amber-400">
                Prior revision: {priorRevision.comment || 'No comment'}
              </div>
              {priorRevision.priorSnapshot && priorRevision.currentSnapshot && (
                <div className="px-2">
                  <ArtifactDiff oldText={priorRevision.priorSnapshot} newText={priorRevision.currentSnapshot} />
                </div>
              )}
            </div>
          ) : null}
        </div>
        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
          {relativeTime(gate.createdAt)}
        </span>
      </div>

      {/* COMP-UX-3b: Recommendation badge */}
      <div className="mt-1.5">
        <RecommendationBadge gate={gate} />
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-1.5 mt-1.5">
        <Button
          variant="outline" size="sm"
          className="h-6 text-[10px] gap-1 text-success border-success/30 hover:bg-success/10"
          onClick={() => onResolve(gate.id, 'approved')}
        >
          Approve
        </Button>
        <Button
          variant="outline" size="sm"
          className={cn(
            'h-6 text-[10px] gap-1 text-amber-400 border-amber-400/30 hover:bg-amber-400/10',
            isExpanded && expandedAction === 'revise' && 'bg-amber-400/10',
          )}
          onClick={() => {
            if (isExpanded && expandedAction === 'revise') {
              onExpand(null, null);
            } else {
              onExpand(gate.id, 'revise');
              setComment('');
            }
          }}
        >
          Revise
        </Button>
        <Button
          variant="outline" size="sm"
          className={cn(
            'h-6 text-[10px] gap-1 text-destructive border-destructive/30 hover:bg-destructive/10',
            isExpanded && expandedAction === 'kill' && 'bg-destructive/10',
          )}
          onClick={() => {
            if (isExpanded && expandedAction === 'kill') {
              onExpand(null, null);
            } else {
              onExpand(gate.id, 'kill');
              setComment('');
            }
          }}
        >
          Kill
        </Button>
      </div>

      {/* Inline input for revise/kill */}
      {isExpanded && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            className="flex-1 text-xs bg-muted text-foreground px-2 py-1 rounded border border-border outline-none"
            placeholder={expandedAction === 'revise' ? 'Feedback (optional)...' : 'Kill reason (required)...'}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (expandedAction === 'revise') handleSubmitRevise();
                else if (expandedAction === 'kill') handleSubmitKill();
              }
              if (e.key === 'Escape') onExpand(null, null);
            }}
            autoFocus
          />
          <Button
            variant="outline" size="sm"
            className="h-6 text-[10px]"
            disabled={expandedAction === 'kill' && !comment.trim()}
            onClick={expandedAction === 'revise' ? handleSubmitRevise : handleSubmitKill}
          >
            {expandedAction === 'revise' ? 'Submit' : 'Confirm Kill'}
          </Button>
        </div>
      )}
    </div>
  );
}

function resolvedByLabel(gate) {
  if (gate.resolvedBy === 'system') {
    const mode = gate.policyMode;
    if (mode === 'flag') return 'auto (flag)';
    if (mode === 'skip') return 'auto (skip)';
    return 'auto';
  }
  return gate.resolvedBy ?? 'human';
}

function ResolvedGateRow({ gate, item }) {
  const outcomeColors = {
    approved: { color: 'text-success', border: 'border-success/30' },
    approve: { color: 'text-success', border: 'border-success/30' },
    revised: { color: 'text-amber-400', border: 'border-amber-400/30' },
    revise: { color: 'text-amber-400', border: 'border-amber-400/30' },
    killed: { color: 'text-destructive', border: 'border-destructive/30' },
    kill: { color: 'text-destructive', border: 'border-destructive/30' },
  };
  const style = outcomeColors[gate.outcome] || outcomeColors.approved;
  const byLabel = resolvedByLabel(gate);

  return (
    <div className="px-3 py-2 border-l-2 border-l-transparent">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-sm text-muted-foreground truncate">
          {item?.title ?? 'Unknown'}
        </span>
        <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0 h-4', style.color, style.border)}>
          {gate.outcome}
        </Badge>
        {byLabel !== 'human' && (
          <span className="text-[9px] px-1 py-0 rounded bg-muted text-muted-foreground">
            {byLabel}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
          {relativeTime(gate.resolvedAt)}
        </span>
      </div>
      <p className="text-[10px] text-muted-foreground mt-0.5">
        {GATE_STEP_LABELS[gate.stepId] ?? `${LIFECYCLE_PHASE_LABELS[gate.fromPhase] ?? gate.fromPhase} → ${LIFECYCLE_PHASE_LABELS[gate.toPhase] ?? gate.toPhase}`}
      </p>
      {gate.comment && (
        <p className="text-[10px] text-muted-foreground mt-0.5 truncate italic">
          {gate.comment}
        </p>
      )}
    </div>
  );
}

export default function GateView({ gates, items, onResolve, onSelect, featureCode, focusActive, onToggleFocus }) {
  const [expandedGateId, setExpandedGateId] = useState(null);
  const [expandedAction, setExpandedAction] = useState(null);

  // COMP-UX-2a: Feature focus filter
  const displayGates = useMemo(() => {
    if (!focusActive || !featureCode) return gates;
    const featureItemIds = new Set(
      items.filter(i => i.featureCode === featureCode || i.lifecycle?.featureCode === featureCode).map(i => i.id)
    );
    return gates.filter(g => featureItemIds.has(g.itemId));
  }, [gates, items, focusActive, featureCode]);

  const handleExpand = (gateId, action) => {
    setExpandedGateId(gateId);
    setExpandedAction(action);
  };

  const { pending, resolved, priorRevisions } = useMemo(() => {
    const p = [];
    const r = [];
    for (const gate of displayGates) {
      if (gate.status === 'pending') {
        p.push(gate);
      } else if (gate.resolvedAt) {
        r.push(gate);
      }
    }
    p.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    r.sort((a, b) => new Date(b.resolvedAt) - new Date(a.resolvedAt));

    // Find prior revision comments for pending gates (same stepId, outcome=revised/revise)
    const revisions = new Map();
    for (const pg of p) {
      const prior = r.find(rg =>
        rg.stepId === pg.stepId &&
        rg.itemId === pg.itemId &&
        (rg.outcome === 'revised' || rg.outcome === 'revise') &&
        rg.comment
      );
      if (prior) {
        revisions.set(pg.id, {
          comment: prior.comment,
          priorSnapshot: prior.artifactSnapshot || null,
          currentSnapshot: pg.artifactSnapshot || null,
        });
      }
    }

    return { pending: p, resolved: r, priorRevisions: revisions };
  }, [displayGates]);

  const [showAllHistory, setShowAllHistory] = useState(false);
  const itemMap = useMemo(() => new Map(items.map(i => [i.id, i])), [items]);

  return (
    <div className="flex-1 overflow-auto flex flex-col">
      {/* Summary bar */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-border shrink-0">
        <FeatureFocusToggle featureCode={featureCode} active={focusActive} onToggle={onToggleFocus} />
        <span className="text-xs font-medium text-foreground">Gates</span>
        {pending.length > 0 ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-400/15 text-amber-400 font-medium">
            {pending.length} pending
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground">No gates pending</span>
        )}
        {resolved.length > 0 && (
          <span className="text-[10px] text-muted-foreground">
            · {resolved.length} resolved
          </span>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        {/* Pending gates */}
        {pending.length > 0 && (
          <Section title="Pending" count={pending.length} color="#f59e0b">
            {pending.map(gate => (
              <PendingGateRow
                key={gate.id}
                gate={gate}
                item={itemMap.get(gate.itemId)}
                priorRevision={priorRevisions.get(gate.id)}
                isExpanded={expandedGateId === gate.id}
                expandedAction={expandedGateId === gate.id ? expandedAction : null}
                onExpand={handleExpand}
                onResolve={onResolve}
                onSelect={onSelect}
              />
            ))}
          </Section>
        )}

        {/* Gate history */}
        {resolved.length > 0 && (
          <Section title="History" count={resolved.length} color="#22c55e">
            {(showAllHistory ? resolved.slice(0, 50) : resolved.slice(0, 10)).map(gate => (
              <ResolvedGateRow
                key={gate.id}
                gate={gate}
                item={itemMap.get(gate.itemId)}
              />
            ))}
            {resolved.length > 10 && !showAllHistory && (
              <button
                className="w-full px-3 py-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setShowAllHistory(true)}
              >
                Show all {resolved.length} resolved gates
              </button>
            )}
          </Section>
        )}

        {/* Empty state */}
        {pending.length === 0 && resolved.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No gates pending.
          </div>
        )}
      </div>
    </div>
  );
}
