/**
 * agent-templates.js — Agent capability profiles for COMP-AGENT-CAPS.
 *
 * Defines which tools each agent role is allowed or denied.
 * Violations are informational in v1 — logged but not blocking.
 */

/**
 * @type {Map<string, {allowedTools: string[]|null, disallowedTools: string[]|null, description: string}>}
 */
export const AGENT_TEMPLATES = new Map([
  ['read-only-reviewer', {
    allowedTools: ['Read', 'Grep', 'Glob', 'Agent'],
    disallowedTools: ['Edit', 'Write', 'Bash'],
    description: 'Read-only review agent',
  }],
  ['read-only-researcher', {
    allowedTools: ['Read', 'Grep', 'Glob', 'Agent', 'WebSearch', 'WebFetch'],
    disallowedTools: ['Edit', 'Write', 'Bash'],
    description: 'Read-only research agent with web access',
  }],
  ['implementer', {
    allowedTools: null,
    disallowedTools: null,
    description: 'Full access implementation agent',
  }],
  ['orchestrator', {
    allowedTools: ['Read', 'Grep', 'Glob', 'Agent', 'Bash'],
    disallowedTools: ['Edit', 'Write'],
    description: 'Meta-config orchestrator',
  }],
  ['security-auditor', {
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    disallowedTools: ['Edit', 'Write'],
    description: 'Security audit agent',
  }],
]);

/**
 * Resolve a template by name.
 * @param {string|null|undefined} templateName
 * @returns {{ allowedTools: string[]|null, disallowedTools: string[]|null, description: string }|null}
 *   Returns null if templateName is unknown — callers fall back to no restrictions.
 */
export function resolveTemplate(templateName) {
  if (!templateName) return null;
  return AGENT_TEMPLATES.get(templateName) ?? null;
}

/**
 * Check whether a given tool is allowed under a template.
 * @param {{ allowedTools: string[]|null, disallowedTools: string[]|null }|null} template
 * @param {string} toolName
 * @returns {{ allowed: boolean, reason: string }}
 */
export function validateCapabilities(template, toolName) {
  if (!template) {
    return { allowed: true, reason: 'No template — all tools permitted' };
  }

  const { allowedTools, disallowedTools } = template;

  // Explicit deny list takes priority
  if (disallowedTools && disallowedTools.includes(toolName)) {
    return { allowed: false, reason: `Tool "${toolName}" is in disallowedTools` };
  }

  // If allowedTools is set, tool must appear in it
  if (allowedTools !== null) {
    if (allowedTools.includes(toolName)) {
      return { allowed: true, reason: `Tool "${toolName}" is in allowedTools` };
    }
    return { allowed: false, reason: `Tool "${toolName}" is not in allowedTools` };
  }

  return { allowed: true, reason: 'No restrictions defined' };
}
