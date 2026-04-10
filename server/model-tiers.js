/**
 * model-tiers.js — Model tier routing for STRAT-TIER.
 *
 * Maps symbolic tier names to concrete Anthropic model IDs.
 * Tiers let pipeline specs declare intent (critical / standard / fast)
 * without hard-coding model strings — the map here is the single source of truth.
 */

/** @type {Record<string, string>} */
export const MODEL_TIERS = {
  critical: 'claude-opus-4-6',
  standard: 'claude-sonnet-4-6',
  fast: 'claude-haiku-4-5-20251001',
};

/**
 * Resolve a tier name to a concrete model ID.
 *
 * @param {string|null|undefined} tier
 * @returns {string|null}  Model ID, or null if tier is unknown / not provided.
 */
export function resolveTierModel(tier) {
  if (!tier) return null;
  return MODEL_TIERS[tier] ?? null;
}
