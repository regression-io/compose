import React, { useState } from 'react';
import { ArrowRight, Bot, Cpu, User, ShieldCheck, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { PIPELINE_STEPS, PIPELINE_PHASE_CONFIG } from './constants.js';
import EmptyState from './shared/EmptyState.jsx';

/**
 * PipelineView — Visual step diagram for the Stratum build pipeline.
 *
 * Modes:
 *   Live     — activeBuild is present; steps show live status
 *   Template — activeBuild is null; shows 24-step template as reference
 *
 * Props:
 *   activeBuild  — from useVisionStore().activeBuild (may be null)
 *   onSelectStep — (stepId) => void — routes to ContextPanel
 */
export default function PipelineView({ activeBuild, onSelectStep, onRefresh }) {
  const [selectedStepId, setSelectedStepId] = useState(null);

  const handleSelect = (stepId) => {
    const next = selectedStepId === stepId ? null : stepId;
    setSelectedStepId(next);
    if (onSelectStep) onSelectStep(next);
  };

  const handleRefresh = () => {
    if (onRefresh) onRefresh();
  };

  // Build a lookup of stepId → live status from activeBuild.steps
  // (synced from stepHistory by build.js → syncStepHistory → active-build.json)
  const liveStatusMap = Array.isArray(activeBuild?.steps)
    ? Object.fromEntries(activeBuild.steps.map(s => [s.id, s.status]))
    : {};
  const currentStepId = activeBuild?.currentStepId ?? null;

  // Group steps by phase
  const phaseGroups = Object.keys(PIPELINE_PHASE_CONFIG).map(phase => ({
    phase,
    config: PIPELINE_PHASE_CONFIG[phase],
    steps: PIPELINE_STEPS.filter(s => s.phase === phase),
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

      {/* COMP-UI-5: EmptyState when no active build */}
      {!activeBuild && (
        <EmptyState
          title="No active build"
          description="Start a pipeline run to see live progress"
          className="py-8"
        />
      )}

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
