/**
 * agent-string.js — Centralized agent string parsing for COMP-AGENT-CAPS.
 *
 * The agent string format is "provider:template:tier" (e.g. "claude:read-only-reviewer:critical").
 * All three segments are optional after the provider:
 *   "claude"                          → provider only
 *   "claude:read-only-reviewer"       → provider + template
 *   "claude:read-only-reviewer:fast"  → provider + template + tier
 *   "claude::fast"                    → provider + tier (no template)
 *
 * Tiers: critical | standard | fast  (maps to Opus / Sonnet / Haiku via model-tiers.js)
 */

import { resolveTemplate } from '../server/agent-templates.js';
import { resolveTierModel } from '../server/model-tiers.js';

/**
 * Parse a raw agent string into provider, template, and tier parts.
 *
 * @param {string|null|undefined} raw
 * @returns {{ provider: string, template: string|null, tier: string|null }}
 *
 * Examples:
 *   "claude:read-only-reviewer"          → { provider: 'claude', template: 'read-only-reviewer', tier: null }
 *   "claude"                             → { provider: 'claude', template: null, tier: null }
 *   "claude:read-only-reviewer:critical" → { provider: 'claude', template: 'read-only-reviewer', tier: 'critical' }
 *   "claude::fast"                       → { provider: 'claude', template: null, tier: 'fast' }
 *   "codex"                              → { provider: 'codex', template: null, tier: null }
 *   null / undefined                     → { provider: 'claude', template: null, tier: null }  (backward compat)
 */
export function parseAgentString(raw) {
  if (!raw) {
    return { provider: 'claude', template: null, tier: null };
  }

  const parts = raw.split(':');
  const provider = parts[0] || 'claude';
  const template = parts[1] || null;
  const tier = parts[2] || null;

  return { provider, template, tier };
}

/**
 * Resolve an agent string to a full config including capability restrictions and model ID.
 *
 * @param {string|null|undefined} raw
 * @returns {{ provider: string, template: string|null, tier: string|null, modelID: string|null, allowedTools: string[]|null, disallowedTools: string[]|null }}
 */
export function resolveAgentConfig(raw) {
  const { provider, template, tier } = parseAgentString(raw);
  const resolved = resolveTemplate(template);
  const modelID = resolveTierModel(tier);

  return {
    provider,
    template,
    tier,
    modelID,
    allowedTools: resolved?.allowedTools ?? null,
    disallowedTools: resolved?.disallowedTools ?? null,
  };
}
