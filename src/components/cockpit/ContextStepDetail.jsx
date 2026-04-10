/**
 * ContextStepDetail — shows build step detail inside the cockpit ContextPanel.
 *
 * Fetches from /api/build/state and displays info for the given step ID.
 * Also shows all steps with per-step token/cost breakdown when showing
 * the full build summary (COMP-OBS-COST).
 *
 * Props:
 *   stepId  {string}  the build step ID to display
 */
import React, { useState, useEffect, useMemo } from 'react';

/**
 * Format USD cost for display.
 * @param {number} cost
 * @returns {string}
 */
function formatCost(cost) {
  if (!cost || cost <= 0) return '$0.00';
  return `$${cost.toFixed(4)}`;
}

export default function ContextStepDetail({ stepId }) {
  const [step, setStep] = useState(null);
  const [allSteps, setAllSteps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [costSortAsc, setCostSortAsc] = useState(false);

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
          setAllSteps([]);
          setLoading(false);
          return;
        }
        const found = build.steps.find(s => s.id === stepId || s.step_id === stepId);
        setStep(found || null);
        setAllSteps(build.steps || []);
        setLoading(false);
      })
      .catch(err => {
        if (controller.signal.aborted) return;
        setError(err.message);
        setLoading(false);
      });

    return () => controller.abort();
  }, [stepId]);

  // COMP-OBS-COST: compute sorted step cost table
  const stepsWithCost = useMemo(() => {
    const withCost = allSteps.filter(s => s.cost_usd != null);
    if (withCost.length === 0) return [];
    return [...withCost].sort((a, b) =>
      costSortAsc ? (a.cost_usd ?? 0) - (b.cost_usd ?? 0) : (b.cost_usd ?? 0) - (a.cost_usd ?? 0)
    );
  }, [allSteps, costSortAsc]);

  const mostExpensiveStepId = stepsWithCost.length > 0 ? stepsWithCost[0].id : null;

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

      {/* Per-step token/cost data */}
      {(step.input_tokens > 0 || step.output_tokens > 0 || step.cost_usd > 0) && (
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1">
            Tokens &amp; Cost
          </p>
          <div className="grid grid-cols-3 gap-1 text-[10px]">
            <span className="text-muted-foreground">Input</span>
            <span className="text-muted-foreground">Output</span>
            <span className="text-muted-foreground">Cost</span>
            <span className="text-foreground font-mono">{(step.input_tokens ?? 0).toLocaleString()}</span>
            <span className="text-foreground font-mono">{(step.output_tokens ?? 0).toLocaleString()}</span>
            <span className="text-foreground font-mono">{formatCost(step.cost_usd)}</span>
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

      {/* COMP-OBS-COST: Per-step cost breakdown table (all steps) */}
      {stepsWithCost.length > 1 && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Build Cost Breakdown
            </p>
            <button
              className="text-[9px] text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setCostSortAsc(a => !a)}
            >
              {costSortAsc ? 'cost asc' : 'cost desc'}
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[10px] border-collapse">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="text-left pr-2 pb-0.5 font-medium">Step</th>
                  <th className="text-right pr-2 pb-0.5 font-medium">In</th>
                  <th className="text-right pr-2 pb-0.5 font-medium">Out</th>
                  <th className="text-right pb-0.5 font-medium">Cost</th>
                  <th className="text-right pb-0.5 pl-2 font-medium">Dur</th>
                </tr>
              </thead>
              <tbody>
                {stepsWithCost.map((s) => {
                  const isExpensive = s.id === mostExpensiveStepId;
                  const isCurrent = s.id === stepId;
                  const dur = s.durationMs != null
                    ? s.durationMs < 1000 ? `${s.durationMs}ms`
                      : s.durationMs < 60000 ? `${(s.durationMs / 1000).toFixed(1)}s`
                      : `${(s.durationMs / 60000).toFixed(1)}m`
                    : '—';
                  return (
                    <tr
                      key={s.id}
                      className={`${isExpensive ? 'text-amber-400' : 'text-foreground'} ${isCurrent ? 'font-semibold' : ''}`}
                    >
                      <td className="pr-2 py-0.5 font-mono truncate max-w-[80px]">{s.id}</td>
                      <td className="text-right pr-2 py-0.5 font-mono">{((s.input_tokens ?? 0) / 1000).toFixed(1)}k</td>
                      <td className="text-right pr-2 py-0.5 font-mono">{((s.output_tokens ?? 0) / 1000).toFixed(1)}k</td>
                      <td className="text-right py-0.5 font-mono">{formatCost(s.cost_usd)}</td>
                      <td className="text-right pl-2 py-0.5 text-muted-foreground">{dur}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
