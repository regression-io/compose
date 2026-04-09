/**
 * agent-string.js — Centralized agent string parsing for COMP-AGENT-CAPS.
 *
 * The agent string format "provider:template" (e.g. "claude:read-only-reviewer")
 * is used in pipeline specs and build.js. All parsing happens here — not inline
 * at each call site.
 */

import { resolveTemplate } from '../server/agent-templates.js';

/**
 * Parse a raw agent string into provider and template parts.
 *
 * @param {string|null|undefined} raw
 * @returns {{ provider: string, template: string|null }}
 *
 * Examples:
 *   "claude:read-only-reviewer" → { provider: 'claude', template: 'read-only-reviewer' }
 *   "claude"                   → { provider: 'claude', template: null }
 *   "codex"                    → { provider: 'codex', template: null }
 *   null / undefined           → { provider: 'claude', template: null }  (backward compat)
 */
export function parseAgentString(raw) {
  if (!raw) {
    return { provider: 'claude', template: null };
  }

  const idx = raw.indexOf(':');
  if (idx === -1) {
    return { provider: raw, template: null };
  }

  const provider = raw.slice(0, idx);
  const template = raw.slice(idx + 1) || null;
  return { provider, template };
}

/**
 * Resolve an agent string to a full config including capability restrictions.
 *
 * @param {string|null|undefined} raw
 * @returns {{ provider: string, template: string|null, allowedTools: string[]|null, disallowedTools: string[]|null }}
 */
export function resolveAgentConfig(raw) {
  const { provider, template } = parseAgentString(raw);
  const resolved = resolveTemplate(template);

  return {
    provider,
    template,
    allowedTools: resolved?.allowedTools ?? null,
    disallowedTools: resolved?.disallowedTools ?? null,
  };
}
