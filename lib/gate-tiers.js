/**
 * gate-tiers.js — COMP-OBS-GATES: tiered gate evaluation with short-circuit.
 *
 * Defines the five evaluation tiers used by the review pipeline.
 * Tiers are ordered cheapest → most expensive. When a tier fails, all
 * subsequent (more expensive) tiers are skipped — short-circuit.
 *
 * Tiers:
 *   T0  schema     — output contract validation (free, instant)
 *   T1  lint       — lint/format checks (fast)
 *   T2  tests      — test suite execution (medium)
 *   T3  llm-review — Claude multi-lens review (expensive)
 *   T4  cross-model — Codex cross-model review (very expensive)
 */

// ---------------------------------------------------------------------------
// Tier definitions
// ---------------------------------------------------------------------------

export const GATE_TIERS = [
  {
    id: 'T0',
    name: 'schema',
    cost: 'free',
    description: 'Output contract validation',
  },
  {
    id: 'T1',
    name: 'lint',
    cost: 'fast',
    description: 'Lint/format checks',
  },
  {
    id: 'T2',
    name: 'tests',
    cost: 'medium',
    description: 'Test suite execution',
  },
  {
    id: 'T3',
    name: 'llm-review',
    cost: 'expensive',
    description: 'Claude multi-lens review',
  },
  {
    id: 'T4',
    name: 'cross-model',
    cost: 'very-expensive',
    description: 'Codex cross-model review',
  },
];

// Map tier ID → index for fast ordering lookups
const TIER_ORDER = new Map(GATE_TIERS.map((t, i) => [t.id, i]));

// ---------------------------------------------------------------------------
// Cost estimates (rough USD per invocation)
// ---------------------------------------------------------------------------

// Base cost constants (USD)
const TIER_BASE_COST_USD = {
  T0: 0.00,   // free — purely local contract validation
  T1: 0.00,   // free — local lint process
  T2: 0.05,   // test suite: estimate varies; use conservative floor
  T3: 0.50,   // Opus multi-lens: ~$0.50 per review pass
  T4: 0.30,   // Codex synthesis: ~$0.30 per cross-model pass
};

/**
 * Estimate the cost of running a tier in USD.
 *
 * @param {string} tierId       Tier ID (e.g. 'T0', 'T3')
 * @param {object} [context]    Optional context for future scaling (e.g. file count, lens count)
 * @param {number} [context.lensCount]  Number of review lenses (scales T3 cost)
 * @returns {number}            Estimated cost in USD
 */
export function estimateTierCost(tierId, context = {}) {
  const base = TIER_BASE_COST_USD[tierId] ?? 0;
  if (tierId === 'T3' && typeof context.lensCount === 'number' && context.lensCount > 1) {
    // Each additional lens beyond 1 adds ~50% of base cost
    return base + (base * 0.5 * (context.lensCount - 1));
  }
  return base;
}

// ---------------------------------------------------------------------------
// Step → tier classification
// ---------------------------------------------------------------------------

/**
 * Map of step IDs to their tier.
 * Step IDs come from .stratum.yaml pipeline specs.
 */
const STEP_TIER_MAP = {
  // T0: schema validation — happens implicitly via Stratum output_contract
  output_contract: 'T0',
  schema_check: 'T0',
  validate: 'T0',

  // T1: lint / format
  lint: 'T1',
  format: 'T1',
  typecheck: 'T1',

  // T2: test suite
  run_tests: 'T2',
  coverage: 'T2',
  coverage_check: 'T2',
  test: 'T2',

  // T3: LLM review (Claude multi-lens)
  review: 'T3',
  parallel_review: 'T3',
  triage: 'T3',
  merge: 'T3',

  // T4: cross-model review (Codex)
  codex_review: 'T4',
  cross_model: 'T4',
  cross_model_review: 'T4',
};

/**
 * Classify a pipeline step ID as a tier.
 *
 * @param {string} stepId  Step ID from the pipeline spec
 * @returns {string|null}  Tier ID (e.g. 'T3') or null if unmapped
 */
export function classifyStepAsTier(stepId) {
  if (!stepId || typeof stepId !== 'string') return null;
  return STEP_TIER_MAP[stepId] ?? null;
}

// ---------------------------------------------------------------------------
// Tiered evaluator with short-circuit
// ---------------------------------------------------------------------------

/**
 * Evaluate tier results and short-circuit on the first failure.
 *
 * @param {object} tierResults  Map of tier IDs to pass/fail booleans or null (not run).
 *                              Example: { T0: true, T1: true, T2: false, T3: null, T4: null }
 * @param {object} [costContext]  Context for cost estimation (e.g. { lensCount: 3 })
 * @returns {{
 *   passed: boolean,
 *   tierThatFailed: string|null,
 *   tiersRun: string[],
 *   tiersSkipped: string[],
 *   costSaved: number
 * }}
 */
export function evaluateTiers(tierResults, costContext = {}) {
  // Sort tiers by their canonical order
  const orderedTiers = GATE_TIERS.map(t => t.id);

  const tiersRun = [];
  const tiersSkipped = [];
  let tierThatFailed = null;
  let shortCircuiting = false;

  for (const tierId of orderedTiers) {
    const result = tierResults[tierId];

    if (shortCircuiting || result === null || result === undefined) {
      // Either we already failed, or this tier was never run
      if (shortCircuiting) {
        tiersSkipped.push(tierId);
      }
      // null/undefined = not run, not explicitly skipped — don't count either way
      continue;
    }

    tiersRun.push(tierId);

    if (result === false) {
      tierThatFailed = tierId;
      shortCircuiting = true;
    }
  }

  // Cost saved = sum of estimated costs for skipped tiers
  const costSaved = tiersSkipped.reduce(
    (sum, tierId) => sum + estimateTierCost(tierId, costContext),
    0
  );

  return {
    passed: tierThatFailed === null,
    tierThatFailed,
    tiersRun,
    tiersSkipped,
    costSaved,
  };
}
