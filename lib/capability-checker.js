/**
 * capability-checker.js — Runtime capability violation detection (COMP-CAPS-ENFORCE).
 *
 * Compares observed tool names against agent template restrictions.
 * Called after each step to identify policy violations for audit or enforcement.
 */

import { resolveTemplate, validateCapabilities } from '../server/agent-templates.js';
import { parseAgentString } from './agent-string.js';

/**
 * Check whether a tool use constitutes a capability violation under an agent's template.
 *
 * Violation  = tool is in disallowedTools (explicit deny)
 * Warning    = tool is not in allowedTools and allowedTools is a non-null list
 *              (not explicitly permitted, but not explicitly denied)
 * No issue   = tool is permitted or template has no restrictions
 *
 * @param {string} toolName       The tool that was observed being used
 * @param {string|null|undefined} agentString  Agent string, e.g. "claude:read-only-reviewer"
 * @returns {{ violation: boolean, severity: 'violation'|'warning'|'none', reason: string }}
 */
export function checkCapabilityViolation(toolName, agentString) {
  const { template: templateName } = parseAgentString(agentString);
  const template = resolveTemplate(templateName);

  if (!template) {
    return { violation: false, severity: 'none', reason: 'No template — all tools permitted' };
  }

  const { allowedTools, disallowedTools } = template;

  // Explicit deny → violation
  if (disallowedTools && disallowedTools.includes(toolName)) {
    return {
      violation: true,
      severity: 'violation',
      reason: `Tool "${toolName}" is in disallowedTools for template "${templateName}"`,
    };
  }

  // Not in allowedTools (when allowedTools is set) → warning
  if (allowedTools !== null && !allowedTools.includes(toolName)) {
    return {
      violation: true,
      severity: 'warning',
      reason: `Tool "${toolName}" is not in allowedTools for template "${templateName}"`,
    };
  }

  const { reason } = validateCapabilities(template, toolName);
  return { violation: false, severity: 'none', reason };
}
