/**
 * ContextStepDetail — shows build step detail inside the cockpit ContextPanel.
 *
 * Fetches from /api/build/state and displays info for the given step ID.
 *
 * Props:
 *   stepId  {string}  the build step ID to display
 */
import React, { useState, useEffect } from 'react';

export default function ContextStepDetail({ stepId }) {
  const [step, setStep] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetch('/api/build/state', { signal: controller.signal })
      .then(r => r.json())
      .then(data => {
        if (controller.signal.aborted) return;
        const build = data.state;
        if (!build || !build.steps) {
          setStep(null);
          setLoading(false);
          return;
        }
        const found = build.steps.find(s => s.id === stepId || s.step_id === stepId);
        setStep(found || null);
        setLoading(false);
      })
      .catch(err => {
        if (controller.signal.aborted) return;
        setError(err.message);
        setLoading(false);
      });

    return () => controller.abort();
  }, [stepId]);

  if (loading) {
    return (
      <div className="p-3 text-[11px] text-muted-foreground italic">
        Loading step...
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-3 text-[11px] text-destructive">
        Error: {error}
      </div>
    );
  }

  if (!step) {
    return (
      <div className="p-3 text-[11px] text-muted-foreground italic">
        Step &ldquo;{stepId}&rdquo; not found in active build.
      </div>
    );
  }

  const statusColors = {
    done: 'text-success',
    running: 'text-accent',
    failed: 'text-destructive',
    pending: 'text-muted-foreground',
    skipped: 'text-muted-foreground',
  };

  return (
    <div className="p-3 space-y-3">
      {/* Header */}
      <div>
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1">
          Build Step
        </p>
        <p className="text-sm font-semibold text-foreground font-mono">
          {step.id || step.step_id}
        </p>
      </div>

      {/* Status */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground">Status:</span>
        <span className={`text-xs font-medium ${statusColors[step.status] || 'text-foreground'}`}>
          {step.status || 'unknown'}
        </span>
      </div>

      {/* Retries */}
      {(step.retries != null && step.retries > 0) && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">Retries:</span>
          <span className="text-xs text-amber-400">{step.retries}</span>
        </div>
      )}

      {/* Duration */}
      {step.durationMs != null && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">Duration:</span>
          <span className="text-xs text-foreground">
            {step.durationMs < 1000 ? `${step.durationMs}ms` : step.durationMs < 60000 ? `${(step.durationMs / 1000).toFixed(1)}s` : `${(step.durationMs / 60000).toFixed(1)}m`}
          </span>
        </div>
      )}

      {/* Summary */}
      {step.summary && (
        <div>
          <span className="text-[10px] text-muted-foreground">Summary:</span>
          <p className="text-xs text-foreground mt-0.5">{step.summary}</p>
        </div>
      )}

      {/* Artifact */}
      {step.artifact && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">Artifact:</span>
          <span className="text-xs text-foreground font-mono truncate">{step.artifact}</span>
        </div>
      )}

      {/* Agent type */}
      {step.agent && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">Agent:</span>
          <span className="text-xs text-foreground font-mono">{step.agent}</span>
        </div>
      )}

      {/* Files changed */}
      {step.filesChanged && step.filesChanged.length > 0 && (
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1">
            Files Changed ({step.filesChanged.length})
          </p>
          <div className="space-y-0.5 max-h-32 overflow-y-auto">
            {step.filesChanged.map((f, i) => (
              <p key={i} className="text-[10px] text-foreground font-mono truncate">{f}</p>
            ))}
          </div>
        </div>
      )}

      {/* Violations */}
      {step.violations && step.violations.length > 0 && (
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-destructive mb-1">
            Violations
          </p>
          <div className="space-y-0.5">
            {step.violations.map((v, i) => (
              <div key={i} className="flex items-start gap-2 px-2 py-1 rounded bg-destructive/10">
                <div className="w-1.5 h-1.5 rounded-full shrink-0 mt-1" style={{ background: 'hsl(var(--destructive))' }} />
                <span className="text-[10px] text-destructive leading-relaxed">{typeof v === 'string' ? v : v.message || JSON.stringify(v)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
