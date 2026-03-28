import React, { useState } from 'react';
import { ArrowRight, Bot, Cpu, User, ShieldCheck, RefreshCw, Check, X } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { PIPELINE_STEPS, PIPELINE_PHASE_CONFIG } from './constants.js';
import EmptyState from './shared/EmptyState.jsx';
import TemplateSelector from './TemplateSelector.jsx';

/**
 * PipelineView — Visual step diagram for the Stratum build pipeline.
 *
 * Modes:
 *   Empty    — no activeBuild, no draft: show TemplateSelector
 *   Draft    — pipelineDraft exists: show read-only steps with Approve/Reject
 *   Active   — activeBuild exists: existing live pipeline view
 *
 * Props:
 *   activeBuild    — from useVisionStore().activeBuild (may be null)
 *   pipelineDraft  — from useVisionStore().pipelineDraft (may be null)
 *   onSelectStep   — (stepId) => void — routes to ContextPanel
 *   onRefresh      — () => void
 *
 * COMP-PIPE-1-3: Pipeline authoring loop — three-mode view.
 */
export default function PipelineView({ activeBuild, pipelineDraft, onSelectStep, onRefresh }) {
  const [selectedStepId, setSelectedStepId] = useState(null);
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const handleSelect = (stepId) => {
    const next = selectedStepId === stepId ? null : stepId;
    setSelectedStepId(next);
    if (onSelectStep) onSelectStep(next);
  };

  const handleRefresh = () => {
    if (onRefresh) onRefresh();
  };

  const handleApprove = async () => {
    if (!pipelineDraft?.draftId) return;
    setApproving(true);
    try {
      await fetch('/api/pipeline/draft/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: pipelineDraft.draftId }),
      });
    } catch (err) {
      console.error('[PipelineView] Approve failed:', err);
    }
    setApproving(false);
  };

  const handleReject = async () => {
    if (!pipelineDraft?.draftId) return;
    setRejecting(true);
    try {
      await fetch('/api/pipeline/draft/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: pipelineDraft.draftId }),
      });
    } catch (err) {
      console.error('[PipelineView] Reject failed:', err);
    }
    setRejecting(false);
  };

  // ── Mode: Empty — show template selector ──────────────────────────────
  if (!activeBuild && !pipelineDraft) {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex items-center gap-3 px-3 py-2 border-b border-border shrink-0 h-9">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Pipeline Templates
          </span>
          <div className="ml-auto">
            <button
              onClick={handleRefresh}
              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground px-2 py-0.5 rounded border border-border"
            >
              <RefreshCw className="w-3 h-3" /> Refresh
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto">
          <TemplateSelector />
        </div>
      </div>
    );
  }

  // ── Mode: Draft — show read-only steps with Approve/Reject ────────────
  if (pipelineDraft && !activeBuild) {
    const draftSteps = pipelineDraft.steps || [];
    const draftMeta = pipelineDraft.metadata || {};
    return (
      <div className="flex-1 flex flex-col min-h-0">
        {/* Toolbar */}
        <div className="flex items-center gap-3 px-3 py-2 border-b border-border shrink-0 h-9">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Draft Review
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={handleReject}
              disabled={rejecting || approving}
              className={cn(
                'flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border',
                'text-red-400 border-red-500/30 hover:bg-red-500/10',
                rejecting && 'opacity-60',
              )}
            >
              <X className="w-3 h-3" /> Reject
            </button>
            <button
              onClick={handleApprove}
              disabled={approving || rejecting}
              className={cn(
                'flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border',
                'text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10',
                approving && 'opacity-60',
              )}
            >
              <Check className="w-3 h-3" /> Approve
            </button>
          </div>
        </div>

        {/* Draft banner */}
        <div className="mx-3 mt-3 px-3 py-2 rounded-lg border ring-1 ring-amber-500/30 border-amber-500/20 bg-amber-500/5 text-[11px]">
          <span className="text-amber-400 font-medium">Draft: {draftMeta.label || draftMeta.id || 'Pipeline'}</span>
          <span className="text-muted-foreground ml-2">
            {draftMeta.description || ''}
          </span>
          {draftMeta.category && (
            <span className="text-muted-foreground ml-2">
              · {draftMeta.category}
            </span>
          )}
        </div>

        {/* Read-only step list */}
        <div className="flex-1 overflow-auto p-3">
          <div className="space-y-1">
            {draftSteps.map((step, i) => (
              <div
                key={step.id || i}
                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-800/40 bg-card"
              >
                <div className="w-5 h-5 rounded flex items-center justify-center shrink-0 bg-slate-500/15 text-slate-400 text-[10px] font-mono">
                  {i + 1}
                </div>
                <span className="text-xs text-foreground">{step.id}</span>
                {step.agent && (
                  <span className="text-[10px] text-muted-foreground ml-auto">{step.agent}</span>
                )}
                {step.function && (
                  <span className="text-[10px] text-muted-foreground ml-auto">fn:{step.function}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── Mode: Active — existing live pipeline view ────────────────────────
  // Build a lookup of stepId → live status from activeBuild.steps
  const liveStatusMap = Array.isArray(activeBuild?.steps)
    ? Object.fromEntries(activeBuild.steps.map(s => [s.id, s.status]))
    : {};
  const currentStepId = activeBuild?.currentStepId ?? null;

  // COMP-UX-2b: Always show full template; merge live status from activeBuild.steps
  const liveStepMap = Array.isArray(activeBuild?.steps)
    ? Object.fromEntries(activeBuild.steps.map(s => [s.id, s]))
    : {};
  const stepSource = PIPELINE_STEPS.map(t => {
    const live = liveStepMap[t.id];
    return live ? { ...t, ...live } : t;
  });
  // Append any dynamic steps not in the template (custom Stratum steps)
  if (activeBuild?.steps) {
    for (const s of activeBuild.steps) {
      if (!PIPELINE_STEPS.find(t => t.id === s.id)) {
        stepSource.push({ id: s.id, name: s.id.replace(/_/g, ' '), agent: 'claude', phase: 'implementation', ...s });
      }
    }
  }

  // Group steps by phase
  const phaseGroups = Object.keys(PIPELINE_PHASE_CONFIG).map(phase => ({
    phase,
    config: PIPELINE_PHASE_CONFIG[phase],
    steps: stepSource.filter(s => s.phase === phase),
  }));

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-border shrink-0 h-9">
        {/* Legend */}
        <div className="flex items-center gap-2">
          <LegendChip icon={Bot} color="text-orange-400 bg-orange-500/10" label="Claude" />
          <LegendChip icon={Cpu} color="text-emerald-400 bg-emerald-500/10" label="Codex" />
          <LegendChip icon={User} color="text-slate-300 bg-slate-500/10" label="Human" />
          <LegendChip icon={ShieldCheck} color="text-amber-400 bg-amber-500/10" label="Gate" />
        </div>
        <div className="ml-auto flex items-center gap-2">
          {activeBuild && (
            <span className="text-[10px] text-muted-foreground">
              Live: <span className="text-blue-400 font-medium">{activeBuild.featureCode}</span>
            </span>
          )}
          <button
            onClick={handleRefresh}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground px-2 py-0.5 rounded border border-border"
          >
            <RefreshCw className="w-3 h-3" /> Refresh
          </button>
        </div>
      </div>

      {/* Live banner */}
      {activeBuild && (
        <div className="mx-3 mt-3 px-3 py-2 rounded-lg border ring-1 ring-blue-500/30 border-blue-500/20 bg-blue-500/5 text-[11px]">
          <span className="text-blue-400 font-medium">Active Build: {activeBuild.featureCode}</span>
          <span className="text-muted-foreground ml-2">
            status: {activeBuild.status} · step {activeBuild.stepNum ?? '?'}/{activeBuild.totalSteps ?? PIPELINE_STEPS.length}
          </span>
          {currentStepId && (
            <span className="text-foreground ml-2">
              · Current: <span className="font-medium">{currentStepId}</span>
            </span>
          )}
        </div>
      )}

      {/* Phase groups */}
      <div className="flex-1 overflow-auto p-3 space-y-3">
        {phaseGroups.map(({ phase, config, steps }) => (
          <div
            key={phase}
            className={cn('rounded-lg border p-3', config.color)}
          >
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              {config.label}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {steps.map((step, i) => {
                const liveStatus = liveStatusMap[step.id] ?? null;
                const isCurrent = step.id === currentStepId;
                const isSelected = step.id === selectedStepId;
                return (
                  <React.Fragment key={step.id}>
                    <StepNode
                      step={step}
                      liveStatus={liveStatus}
                      isCurrent={isCurrent}
                      isSelected={isSelected}
                      onClick={() => handleSelect(step.id)}
                    />
                    {i < steps.length - 1 && (
                      <ArrowRight className="h-3 w-3 self-center text-muted-foreground/40" />
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StepNode({ step, liveStatus, isCurrent, isSelected, onClick }) {
  const Icon = step.hasGate ? ShieldCheck
             : step.agent === 'claude' ? Bot
             : step.agent === 'codex'  ? Cpu
             : User;

  const statusRing = {
    active:  'border-blue-500/80  bg-blue-500/10',
    done:    'border-emerald-500/50 bg-emerald-500/5',
    failed:  'border-red-500/60   bg-red-500/10',
    pending: 'border-slate-800/60  bg-card',
  }[liveStatus] ?? 'border-slate-800/40 bg-card';

  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 px-2 py-1.5 rounded-lg border text-left transition-all min-w-[120px]',
        isSelected ? 'border-accent/80 bg-accent/10' : statusRing,
        step.hasGate && !liveStatus && 'border-amber-500/30 bg-amber-500/5',
        isCurrent && 'ring-1 ring-blue-400/40',
      )}
    >
      <div className={cn(
        'w-5 h-5 rounded flex items-center justify-center shrink-0',
        step.hasGate        ? 'bg-amber-500/15 text-amber-400'
          : step.agent === 'claude' ? 'bg-orange-500/15 text-orange-400'
          : step.agent === 'codex'  ? 'bg-emerald-500/15 text-emerald-400'
          : 'bg-slate-500/15 text-slate-400'
      )}>
        <Icon className="w-3 h-3" />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] font-medium text-foreground truncate leading-tight">{step.name}</p>
        {liveStatus && (
          <p className="text-[8px] text-muted-foreground capitalize">{liveStatus}</p>
        )}
      </div>
    </button>
  );
}

function LegendChip({ icon: Icon, color, label }) {
  return (
    <div className={cn('flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]', color)}>
      <Icon className="w-3 h-3" />
      <span>{label}</span>
    </div>
  );
}
