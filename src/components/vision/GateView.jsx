import React, { useMemo, useState } from 'react';
import { cn } from '@/lib/utils.js';
import { Badge } from '@/components/ui/badge.jsx';
import { Button } from '@/components/ui/button.jsx';
import { LIFECYCLE_PHASE_LABELS, LIFECYCLE_PHASE_ARTIFACTS } from './constants.js';

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

function PendingGateRow({ gate, item, isExpanded, expandedAction, onExpand, onResolve, onSelect }) {
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
            {LIFECYCLE_PHASE_LABELS[gate.fromPhase] ?? gate.fromPhase}
            {' → '}
            {LIFECYCLE_PHASE_LABELS[gate.toPhase] ?? gate.toPhase}
          </p>
          <ArtifactAssessment gate={gate} />
        </div>
        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
          {relativeTime(gate.createdAt)}
        </span>
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

function ResolvedGateRow({ gate, item }) {
  const outcomeColors = {
    approved: { color: 'text-success', border: 'border-success/30' },
    revised: { color: 'text-amber-400', border: 'border-amber-400/30' },
    killed: { color: 'text-destructive', border: 'border-destructive/30' },
  };
  const style = outcomeColors[gate.outcome] || outcomeColors.approved;

  return (
    <div className="px-3 py-2 border-l-2 border-l-transparent">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-sm text-muted-foreground truncate">
          {item?.title ?? 'Unknown'}
        </span>
        <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0 h-4', style.color, style.border)}>
          {gate.outcome}
        </Badge>
        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
          {relativeTime(gate.resolvedAt)}
        </span>
      </div>
      <p className="text-[10px] text-muted-foreground mt-0.5">
        {LIFECYCLE_PHASE_LABELS[gate.fromPhase] ?? gate.fromPhase}
        {' → '}
        {LIFECYCLE_PHASE_LABELS[gate.toPhase] ?? gate.toPhase}
      </p>
      {gate.comment && (
        <p className="text-[10px] text-muted-foreground mt-0.5 truncate italic">
          {gate.comment}
        </p>
      )}
    </div>
  );
}

export default function GateView({ gates, items, onResolve, onSelect }) {
  const [expandedGateId, setExpandedGateId] = useState(null);
  const [expandedAction, setExpandedAction] = useState(null);

  const handleExpand = (gateId, action) => {
    setExpandedGateId(gateId);
    setExpandedAction(action);
  };

  const { pending, resolvedToday } = useMemo(() => {
    const p = [];
    const r = [];
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    for (const gate of gates) {
      if (gate.status === 'pending') {
        p.push(gate);
      } else if (gate.resolvedAt && new Date(gate.resolvedAt) >= todayStart) {
        r.push(gate);
      }
    }
    p.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    r.sort((a, b) => new Date(b.resolvedAt) - new Date(a.resolvedAt));
    return { pending: p, resolvedToday: r };
  }, [gates]);

  const itemMap = useMemo(() => new Map(items.map(i => [i.id, i])), [items]);

  return (
    <div className="flex-1 overflow-auto flex flex-col">
      {/* Summary bar */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-border shrink-0">
        <span className="text-xs font-medium text-foreground">Gates</span>
        {pending.length > 0 ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-400/15 text-amber-400 font-medium">
            {pending.length} pending
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground">No gates pending</span>
        )}
        {resolvedToday.length > 0 && (
          <span className="text-[10px] text-muted-foreground">
            · {resolvedToday.length} resolved today
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
                isExpanded={expandedGateId === gate.id}
                expandedAction={expandedGateId === gate.id ? expandedAction : null}
                onExpand={handleExpand}
                onResolve={onResolve}
                onSelect={onSelect}
              />
            ))}
          </Section>
        )}

        {/* Resolved today */}
        {resolvedToday.length > 0 && (
          <Section title="Resolved Today" count={resolvedToday.length} color="#22c55e">
            {resolvedToday.map(gate => (
              <ResolvedGateRow
                key={gate.id}
                gate={gate}
                item={itemMap.get(gate.itemId)}
              />
            ))}
          </Section>
        )}

        {/* Empty state */}
        {pending.length === 0 && resolvedToday.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No gates pending.
          </div>
        )}
      </div>
    </div>
  );
}
