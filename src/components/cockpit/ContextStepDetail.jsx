/**
 * ContextStepDetail — shows build step detail inside the cockpit ContextPanel.
 *
 * Fetches from /api/build/state and displays info for the given step ID.
 * Also shows all steps with per-step token/cost breakdown when showing
 * the full build summary (COMP-OBS-COST).
 *
 * COMP-OBS-GATES: also renders a tier pipeline visualization when tier data
 * is available from build-stream events.
 *
 * Props:
 *   stepId      {string}   the build step ID to display
 *   tierEvents  {Array}    optional array of gate_tier_result/gate_tier_summary events
 *                          from the parent build stream consumer
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

// ---------------------------------------------------------------------------
// COMP-OBS-GATES: Tier pipeline constants
// ---------------------------------------------------------------------------

const ALL_TIERS = [
  { id: 'T0', name: 'schema', label: 'T0' },
  { id: 'T1', name: 'lint',   label: 'T1' },
  { id: 'T2', name: 'tests',  label: 'T2' },
  { id: 'T3', name: 'review', label: 'T3' },
  { id: 'T4', name: 'codex',  label: 'T4' },
];

/**
 * TierPipeline — renders a horizontal dot-chain showing tier pass/fail/skipped status.
 * Green dot = passed, red dot = failed, gray dot = skipped/not run.
 * Clicking a dot expands inline details for that tier.
 */
function TierPipeline({ tierMap, tierSummary }) {
  const [expanded, setExpanded] = useState(null);

  const toggle = (tierId) => setExpanded(prev => prev === tierId ? null : tierId);

  return (
    <div>
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1.5">
        Tier Pipeline
      </p>
      <div className="flex items-center gap-1.5">
        {ALL_TIERS.map((tier, i) => {
          const result = tierMap[tier.id];
          const skipped = tierSummary?.tiersSkipped?.includes(tier.id);

          let dotColor, title;
          if (skipped) {
            dotColor = 'bg-muted-foreground/40';
            title = `${tier.id} (${tier.name}): skipped`;
          } else if (result === true) {
            dotColor = 'bg-success';
            title = `${tier.id} (${tier.name}): passed`;
          } else if (result === false) {
            dotColor = 'bg-destructive';
            title = `${tier.id} (${tier.name}): failed`;
          } else {
            dotColor = 'bg-muted-foreground/20';
            title = `${tier.id} (${tier.name}): not run`;
          }

          return (
            <React.Fragment key={tier.id}>
              {i > 0 && (
                <div className="h-px w-3 bg-muted-foreground/20 shrink-0" />
              )}
              <button
                className="flex flex-col items-center gap-0.5 group"
                onClick={() => toggle(tier.id)}
                title={title}
              >
                <div className={`w-2.5 h-2.5 rounded-full transition-all group-hover:scale-125 ${dotColor} ${expanded === tier.id ? 'ring-1 ring-foreground/40' : ''}`} />
                <span className="text-[8px] text-muted-foreground leading-none">{tier.label}</span>
              </button>
            </React.Fragment>
          );
        })}
        {tierSummary?.costSaved > 0 && (
          <span className="ml-2 text-[9px] text-success/80">
            saved ~${tierSummary.costSaved.toFixed(2)}
          </span>
        )}
      </div>
      {/* Expanded tier detail */}
      {expanded && (
        <div className="mt-1.5 px-2 py-1 rounded bg-muted/20 text-[9px] text-muted-foreground">
          {(() => {
            const result = tierMap[expanded];
            const skipped = tierSummary?.tiersSkipped?.includes(expanded);
            const tierInfo = ALL_TIERS.find(t => t.id === expanded);
            if (skipped) return `${expanded} (${tierInfo?.name}): skipped — short-circuited by earlier failure`;
            if (result === true) return `${expanded} (${tierInfo?.name}): passed`;
            if (result === false) return `${expanded} (${tierInfo?.name}): failed`;
            return `${expanded} (${tierInfo?.name}): not run this build`;
          })()}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// COMP-HEALTH: Health score color helpers
// ---------------------------------------------------------------------------

/**
 * Return a Tailwind color class for a health score.
 * Green >= 80, Yellow 60-79, Red < 60.
 */
function healthScoreColor(score) {
  if (score >= 80) return 'text-success';
  if (score >= 60) return 'text-amber-400';
  return 'text-destructive';
}

/**
 * Trend direction indicator arrow.
 */
function trendArrow(direction) {
  if (direction === 'improving') return '\u2191'; // up arrow
  if (direction === 'declining') return '\u2193'; // down arrow
  return '\u2192'; // right arrow (stable)
}

const DIMENSION_LABELS = {
  test_coverage:       'Tests',
  review_findings:     'Review',
  contract_compliance: 'Contracts',
  runtime_errors:      'Runtime',
  doc_freshness:       'Docs',
  plan_completion:     'Plan',
};

export default function ContextStepDetail({ stepId, tierEvents = [], healthEvents = [] }) {
  const [step, setStep] = useState(null);
  const [allSteps, setAllSteps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [costSortAsc, setCostSortAsc] = useState(false);

  // COMP-HEALTH: derive latest health score from stream events
  const healthScore = useMemo(() => {
    if (!healthEvents || healthEvents.length === 0) return null;
    // Last health_score event wins
    for (let i = healthEvents.length - 1; i >= 0; i--) {
      const ev = healthEvents[i];
      if (ev.subtype === 'health_score' && typeof ev.score === 'number') {
        return ev;
      }
    }
    return null;
  }, [healthEvents]);

  // COMP-OBS-GATES: derive tier state from stream events passed via props
  const { tierMap, tierSummary } = useMemo(() => {
    if (!tierEvents || tierEvents.length === 0) return { tierMap: {}, tierSummary: null };
    const map = {};
    let summary = null;
    for (const ev of tierEvents) {
      if (ev.subtype === 'gate_tier_result') {
        map[ev.tierId] = ev.passed;
      } else if (ev.subtype === 'gate_tier_summary') {
        summary = ev;
      }
    }
    return { tierMap: map, tierSummary: summary };
  }, [tierEvents]);

  const hasTierData = Object.keys(tierMap).length > 0 || tierSummary !== null;

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

      {/* COMP-OBS-GATES: Tier pipeline visualization */}
      {hasTierData && (
        <div>
          <TierPipeline tierMap={tierMap} tierSummary={tierSummary} />
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

      {/* COMP-HEALTH: Build health score panel */}
      {healthScore != null && (
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1.5">
            Health Score
          </p>
          <div className="flex items-baseline gap-2 mb-2">
            <span className={`text-2xl font-bold font-mono tabular-nums ${healthScoreColor(healthScore.score)}`}>
              {healthScore.score}
            </span>
            <span className="text-[10px] text-muted-foreground">/100</span>
            {healthScore.trend && (
              <span className={`text-sm font-mono ${healthScoreColor(healthScore.score)}`}>
                {trendArrow(healthScore.trend.direction)}
                {healthScore.trend.delta != null && (
                  <span className="text-[10px] ml-0.5">
                    {healthScore.trend.delta > 0 ? '+' : ''}{Math.round(healthScore.trend.delta)}
                  </span>
                )}
              </span>
            )}
          </div>
          {healthScore.breakdown && Object.keys(healthScore.breakdown).length > 0 && (
            <div className="space-y-1">
              {Object.entries(healthScore.breakdown).map(([dim, dimScore]) => (
                <div key={dim} className="flex items-center gap-2">
                  <span className="text-[9px] text-muted-foreground w-16 shrink-0">
                    {DIMENSION_LABELS[dim] ?? dim}
                  </span>
                  <div className="flex-1 h-1.5 rounded-full bg-muted-foreground/20 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${dimScore >= 80 ? 'bg-success' : dimScore >= 60 ? 'bg-amber-400' : 'bg-destructive'}`}
                      style={{ width: `${dimScore}%` }}
                    />
                  </div>
                  <span className={`text-[9px] font-mono w-6 text-right ${healthScoreColor(dimScore)}`}>
                    {dimScore}
                  </span>
                </div>
              ))}
              {healthScore.missing && healthScore.missing.length > 0 && (
                <p className="text-[9px] text-muted-foreground/60 mt-0.5">
                  No data: {healthScore.missing.map(d => DIMENSION_LABELS[d] ?? d).join(', ')}
                </p>
              )}
            </div>
          )}
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
