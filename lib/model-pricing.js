/**
 * model-pricing.js — Token cost lookup and USD calculation.
 *
 * Prices are per-million tokens (MTok) as of 2025.
 * Input price includes standard prompt tokens.
 * Cache write tokens (cache_creation_input_tokens) are billed at 1.25x input rate.
 * Cache read tokens (cache_read_input_tokens) are billed at 0.1x input rate.
 */

/**
 * Pricing map: modelID → { inputPerMTok, outputPerMTok } in USD.
 * Keys are matched by prefix so 'claude-sonnet-4-6' matches 'claude-sonnet-4-6-20250514' etc.
 */
export const MODEL_PRICING = {
  'claude-opus-4-6':    { inputPerMTok: 15,  outputPerMTok: 75 },
  'claude-sonnet-4-6':  { inputPerMTok: 3,   outputPerMTok: 15 },
  'claude-haiku-4-5':   { inputPerMTok: 1,   outputPerMTok: 5  },
};

/**
 * Look up pricing for a model ID.
 * Tries exact match first, then prefix match (handles dated variants).
 *
 * @param {string} modelID
 * @returns {{ inputPerMTok: number, outputPerMTok: number } | null}
 */
function lookupPricing(modelID) {
  if (!modelID) return null;

  // Exact match
  if (MODEL_PRICING[modelID]) return MODEL_PRICING[modelID];

  // Prefix match — handles e.g. 'claude-sonnet-4-6-20250514'
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (modelID.startsWith(key)) return pricing;
  }

  return null;
}

/**
 * Calculate the USD cost for a single agent call.
 *
 * @param {string} modelID
 * @param {number} inputTokens         Standard prompt tokens
 * @param {number} outputTokens        Completion tokens
 * @param {number} [cacheWriteTokens]  cache_creation_input_tokens (billed at 1.25x input)
 * @param {number} [cacheReadTokens]   cache_read_input_tokens (billed at 0.1x input)
 * @returns {number} USD cost (0 for unknown models or zero-token calls)
 */
export function calculateCost(modelID, inputTokens, outputTokens, cacheWriteTokens = 0, cacheReadTokens = 0) {
  const pricing = lookupPricing(modelID);
  if (!pricing) return 0;

  const totalInput = (inputTokens ?? 0) + (cacheWriteTokens ?? 0) + (cacheReadTokens ?? 0);
  const totalOutput = outputTokens ?? 0;

  if (totalInput === 0 && totalOutput === 0) return 0;

  const inputCost  = ((inputTokens ?? 0) / 1_000_000) * pricing.inputPerMTok;
  const writeCost  = ((cacheWriteTokens ?? 0) / 1_000_000) * pricing.inputPerMTok * 1.25;
  const readCost   = ((cacheReadTokens ?? 0) / 1_000_000) * pricing.inputPerMTok * 0.1;
  const outputCost = ((outputTokens ?? 0) / 1_000_000) * pricing.outputPerMTok;

  return inputCost + writeCost + readCost + outputCost;
}
