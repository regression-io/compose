/**
 * health-score.js — COMP-HEALTH: Quantified Quality Score for Gates (items 117-120).
 *
 * Aggregates signals from existing build artifacts into a 0-100 composite
 * health score. No new data sources — only aggregates what already exists:
 *   - Review findings from parallel_review's MergedReviewResult
 *   - Test pass/fail from coverage_check result
 *   - Contract compliance from Stratum ensure results
 *   - Doc freshness from lib/staleness.js
 *   - Plan completion from plan_completion ensure builtin
 *   - Runtime errors from build_step_done violations
 */

// ---------------------------------------------------------------------------
// Dimension definitions
// ---------------------------------------------------------------------------

/**
 * Default dimension weights. Weights sum to 1.0.
 * @type {Record<string, {weight: number, name: string}>}
 */
export const DIMENSIONS = {
  test_coverage:      { weight: 0.25, name: 'Test Coverage' },
  review_findings:    { weight: 0.25, name: 'Review Findings' },
  contract_compliance:{ weight: 0.15, name: 'Contract Compliance' },
  runtime_errors:     { weight: 0.15, name: 'Runtime Errors' },
  doc_freshness:      { weight: 0.10, name: 'Doc Freshness' },
  plan_completion:    { weight: 0.10, name: 'Plan Completion' },
};

// ---------------------------------------------------------------------------
// Per-dimension scorers
// ---------------------------------------------------------------------------

/**
 * Score test coverage from a coverage_check result.
 *
 * @param {object|null} testResult  Coverage result: { passing, failures }
 * @returns {number} 0-100
 */
export function scoreTestCoverage(testResult) {
  if (testResult == null) return 50; // neutral — no data
  // Truthy passing with no failures = full pass
  if (testResult.passing === true && (!testResult.failures || testResult.failures.length === 0)) {
    return 100;
  }
  // Explicitly failing
  if (testResult.passing === false) return 0;
  // Mixed or unknown — treat partial
  return 50;
}

/**
 * Score review findings from a MergedReviewResult.
 *
 * Severity breakdown:
 *   must-fix  → -20 per finding
 *   should-fix → -5 per finding
 *   nit        → -1 per finding
 *
 * @param {object|null} mergedResult  { findings: [{severity, ...}] }
 * @returns {number} 0-100 (floored at 0)
 */
export function scoreReviewFindings(mergedResult) {
  if (mergedResult == null) return 50; // neutral — no data
  const findings = mergedResult.findings ?? mergedResult.all_findings ?? [];
  if (findings.length === 0) return 100;

  let score = 100;
  for (const f of findings) {
    const sev = (f.severity ?? '').toLowerCase();
    if (sev === 'must-fix' || sev === 'must_fix') {
      score -= 20;
    } else if (sev === 'should-fix' || sev === 'should_fix') {
      score -= 5;
    } else if (sev === 'nit') {
      score -= 1;
    }
  }
  return Math.max(0, score);
}

/**
 * Score contract compliance from Stratum ensure results.
 * Each failed ensure costs -10 points.
 *
 * @param {Array<{passed: boolean}>|null} ensureResults
 * @returns {number} 0-100 (floored at 0)
 */
export function scoreContractCompliance(ensureResults) {
  if (ensureResults == null || !Array.isArray(ensureResults)) return 50;
  if (ensureResults.length === 0) return 100;

  const failed = ensureResults.filter(e => !e.passed).length;
  return Math.max(0, 100 - failed * 10);
}

/**
 * Score runtime errors from capability violations or build violations.
 * Each violation costs -15 points.
 *
 * @param {Array<string|object>|null} violations
 * @returns {number} 0-100 (floored at 0)
 */
export function scoreRuntimeErrors(violations) {
  if (violations == null || !Array.isArray(violations)) return 50;
  if (violations.length === 0) return 100;
  return Math.max(0, 100 - violations.length * 15);
}

/**
 * Score doc freshness from staleness check results.
 * Each stale doc costs -20 points.
 *
 * @param {Array<{stale: boolean}>|null} stalenessResults
 * @returns {number} 0-100 (floored at 0)
 */
export function scoreDocFreshness(stalenessResults) {
  if (stalenessResults == null || !Array.isArray(stalenessResults)) return 50;
  if (stalenessResults.length === 0) return 100;

  const staleCount = stalenessResults.filter(r => r.stale).length;
  if (staleCount === 0) return 100;
  return Math.max(0, 100 - staleCount * 20);
}

/**
 * Score plan completion from a plan_completion ensure result.
 * Uses planCompletionPct directly, or 50 if no plan data is available.
 *
 * @param {object|null} planResult  { planCompletionPct: number } or null
 * @returns {number} 0-100
 */
export function scorePlanCompletion(planResult) {
  if (planResult == null) return 50;
  const pct = planResult.planCompletionPct ?? planResult.completion_pct;
  if (typeof pct !== 'number') return 50;
  return Math.max(0, Math.min(100, pct));
}

// ---------------------------------------------------------------------------
// Composite scorer
// ---------------------------------------------------------------------------

/**
 * Compute a composite health score from a set of signals.
 *
 * Missing dimensions are scored as 50 (neutral) but their weight is
 * re-normalized out so they don't artificially lower the score — we only
 * penalize for data we actually have.
 *
 * @param {object} signals   Map of dimension key → raw signal data
 * @param {object} [weights] Override weights (same shape as DIMENSIONS)
 * @returns {{ score: number, breakdown: Record<string,number>, missing: string[] }}
 */
export function computeCompositeScore(signals = {}, weights = {}) {
  const dimWeights = { ...DIMENSIONS };
  // Apply any user-supplied weight overrides
  for (const [key, w] of Object.entries(weights)) {
    if (dimWeights[key] != null && typeof w === 'number') {
      dimWeights[key] = { ...dimWeights[key], weight: w };
    }
  }

  const scorers = {
    test_coverage:       () => scoreTestCoverage(signals.test_coverage),
    review_findings:     () => scoreReviewFindings(signals.review_findings),
    contract_compliance: () => scoreContractCompliance(signals.contract_compliance),
    runtime_errors:      () => scoreRuntimeErrors(signals.runtime_errors),
    doc_freshness:       () => scoreDocFreshness(signals.doc_freshness),
    plan_completion:     () => scorePlanCompletion(signals.plan_completion),
  };

  const breakdown = {};
  const missing = [];

  // Score each dimension. A dimension is "present" if its key is in signals.
  for (const dim of Object.keys(dimWeights)) {
    if (Object.prototype.hasOwnProperty.call(signals, dim)) {
      breakdown[dim] = scorers[dim]();
    } else {
      missing.push(dim);
      // Score neutral — excluded from weight normalization below
    }
  }

  const presentDims = Object.keys(breakdown);

  if (presentDims.length === 0) {
    // No signals at all — return neutral
    return { score: 50, breakdown: {}, missing };
  }

  // Re-normalize: sum weights of present dimensions only
  const totalWeight = presentDims.reduce((s, d) => s + dimWeights[d].weight, 0);
  const score = presentDims.reduce((s, d) => {
    return s + (breakdown[d] * dimWeights[d].weight) / totalWeight;
  }, 0);

  return {
    score: Math.round(score * 10) / 10, // 1 decimal
    breakdown,
    missing,
  };
}
