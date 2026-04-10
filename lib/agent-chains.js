/**
 * agent-chains.js — Hybrid chain presets for STRAT-TIER.
 *
 * Chain presets define a named pattern of tier assignments across a set of
 * logical roles (plan, execute, review, fix, audit). They let callers say
 * "use the plan-execute-review chain" instead of hard-coding model tiers on
 * each step.
 *
 * applyChain() takes a preset name and an array of step objects and returns
 * new step objects with the tier field set from the preset's role map.
 * Steps whose role doesn't appear in the preset are left unchanged.
 */

/**
 * Named chain presets.
 * Keys are role names; values are tier strings (critical | standard | fast).
 *
 * @type {Record<string, Record<string, string>>}
 */
export const CHAIN_PRESETS = {
  'plan-execute-review': {
    plan: 'critical',
    execute: 'fast',
    review: 'standard',
  },
  'review-fix': {
    review: 'standard',
    fix: 'fast',
  },
  'security-audit': {
    audit: 'critical',
    fix: 'critical',
  },
};

/**
 * Apply a chain preset to a list of steps.
 *
 * Each step must have an `id` field. The step's id is matched against the
 * preset role map — if the id matches a role key the tier is set; otherwise
 * the step is returned unchanged.
 *
 * @param {string} presetName  Key from CHAIN_PRESETS
 * @param {Array<{id: string, [key: string]: unknown}>} steps
 * @returns {Array<{id: string, tier: string|undefined, [key: string]: unknown}>}
 */
export function applyChain(presetName, steps) {
  const preset = CHAIN_PRESETS[presetName];
  if (!preset) {
    throw new Error(`agent-chains: unknown preset "${presetName}". Known presets: ${Object.keys(CHAIN_PRESETS).join(', ')}`);
  }

  return steps.map((step) => {
    const tier = preset[step.id];
    if (tier === undefined) return step;
    // Rewrite the agent string to include the tier so the runtime actually routes
    // to the selected model. Preserves existing provider and template.
    const currentAgent = step.agent || 'claude';
    const parts = currentAgent.split(':');
    const provider = parts[0] || 'claude';
    const template = parts[1] || '';
    const newAgent = `${provider}:${template}:${tier}`;
    return { ...step, agent: newAgent, tier };
  });
}
