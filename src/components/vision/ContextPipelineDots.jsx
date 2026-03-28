/**
 * ContextPipelineDots — horizontal dot-line pipeline visualization.
 *
 * Shows lifecycle steps as connected dots with status colors.
 * Click a dot to show inline step detail below.
 *
 * Props:
 *   item        {object}  vision item with phaseHistory
 *   activeBuild {object}  current build state (or null)
 */
import React, { useState } from 'react';
import { PIPELINE_STATUS_COLORS } from './constants.js';

const LIFECYCLE_STEPS = [
  { id: 'design', label: 'Design' },
  { id: 'blueprint', label: 'Blueprint' },
  { id: 'execute', label: 'Execute' },
  { id: 'review', label: 'Review' },
  { id: 'coverage', label: 'Coverage' },
  { id: 'ship', label: 'Ship' },
];

function getStepStatus(stepId, phaseHistory, activeBuild, featureCode) {
  // Check if this step is the active build step
  if (activeBuild && activeBuild.featureCode === featureCode && activeBuild.currentStep === stepId) {
    return 'active';
  }
  // Check phase history for completion
  if (phaseHistory && Array.isArray(phaseHistory)) {
    const entry = phaseHistory.find(p => p.phase === stepId || p.step === stepId);
    if (entry) {
      if (entry.status === 'failed') return 'failed';
      return 'complete';
    }
  }
  return 'pending';
}

export default function ContextPipelineDots({ item, activeBuild }) {
  const [selectedStep, setSelectedStep] = useState(null);
  const phaseHistory = item?.phaseHistory || [];
  const featureCode = item?.featureCode || item?.text || '';

  return (
    <div className="p-3">
      {/* Dot line */}
      <div className="flex items-center gap-0 mb-3">
        {LIFECYCLE_STEPS.map((step, i) => {
          const status = getStepStatus(step.id, phaseHistory, activeBuild, featureCode);
          const color = PIPELINE_STATUS_COLORS[status];
          const isSelected = selectedStep === step.id;
          return (
            <React.Fragment key={step.id}>
              {i > 0 && (
                <div
                  className="flex-1 h-px"
                  style={{
                    background: status === 'pending'
                      ? 'hsl(var(--muted-foreground) / 0.2)'
                      : color,
                    minWidth: '8px',
                  }}
                />
              )}
              <button
                onClick={() => setSelectedStep(isSelected ? null : step.id)}
                className="relative flex flex-col items-center group"
                title={step.label}
              >
                <div
                  className={[
                    'w-3 h-3 rounded-full border-2 transition-all',
                    status === 'active' ? 'animate-pulse' : '',
                    isSelected ? 'ring-2 ring-accent/30' : '',
                  ].join(' ')}
                  style={{
                    borderColor: color,
                    background: status === 'complete' || status === 'failed' ? color : 'transparent',
                  }}
                />
                <span className="text-[8px] text-muted-foreground mt-1 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                  {step.label}
                </span>
              </button>
            </React.Fragment>
          );
        })}
      </div>

      {/* Labels row (always visible) */}
      <div className="flex justify-between px-0.5">
        {LIFECYCLE_STEPS.map(step => {
          const status = getStepStatus(step.id, phaseHistory, activeBuild, featureCode);
          return (
            <span
              key={step.id}
              className="text-[8px] font-medium uppercase tracking-wider"
              style={{ color: status === 'pending' ? 'hsl(var(--muted-foreground) / 0.4)' : PIPELINE_STATUS_COLORS[status] }}
            >
              {step.label}
            </span>
          );
        })}
      </div>

      {/* Selected step detail */}
      {selectedStep && (
        <div className="mt-3 p-2 rounded border border-border/50 bg-muted/20">
          <StepDetail stepId={selectedStep} phaseHistory={phaseHistory} activeBuild={activeBuild} featureCode={featureCode} />
        </div>
      )}
    </div>
  );
}

function StepDetail({ stepId, phaseHistory, activeBuild, featureCode }) {
  const status = getStepStatus(stepId, phaseHistory, activeBuild, featureCode);
  const entry = phaseHistory?.find(p => p.phase === stepId || p.step === stepId);

  const statusColors = {
    complete: 'text-success',
    active: 'text-accent',
    failed: 'text-destructive',
    pending: 'text-muted-foreground',
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-foreground capitalize">{stepId}</span>
        <span className={`text-[10px] font-medium ${statusColors[status]}`}>{status}</span>
      </div>
      {entry?.summary && (
        <p className="text-[10px] text-muted-foreground">{entry.summary}</p>
      )}
      {entry?.durationMs != null && (
        <p className="text-[10px] text-muted-foreground">
          Duration: {entry.durationMs < 1000 ? `${entry.durationMs}ms` : `${(entry.durationMs / 1000).toFixed(1)}s`}
        </p>
      )}
      {entry?.agent && (
        <p className="text-[10px] text-muted-foreground">Agent: {entry.agent}</p>
      )}
      {status === 'active' && activeBuild && (
        <p className="text-[10px] text-accent">Running...</p>
      )}
      {status === 'pending' && (
        <p className="text-[10px] text-muted-foreground italic">Not started</p>
      )}
    </div>
  );
}
