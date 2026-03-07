/**
 * Step Prompt Builder — constructs agent prompts from Stratum step dispatch responses.
 */

/**
 * Build an agent prompt from a step dispatch and execution context.
 *
 * @param {object} stepDispatch - Stratum step dispatch (step_id, intent, inputs, output_fields, ensure)
 * @param {object} context      - Execution context (cwd, featureCode)
 * @returns {string}
 */
export function buildStepPrompt(stepDispatch, context) {
  const sections = [];

  sections.push(`You are executing step "${stepDispatch.step_id}" in a Stratum workflow.`);

  sections.push(`## Intent\n${stepDispatch.intent}`);

  sections.push(`## Inputs\n${JSON.stringify(stepDispatch.inputs, null, 2)}`);

  if (Array.isArray(stepDispatch.output_fields) && stepDispatch.output_fields.length > 0) {
    const fieldLines = stepDispatch.output_fields
      .map(f => `- ${f.name} (${f.type})`)
      .join('\n');
    sections.push(`## Expected Output\nReturn a JSON object with these fields:\n${fieldLines}`);
  }

  if (Array.isArray(stepDispatch.ensure) && stepDispatch.ensure.length > 0) {
    const ensureLines = stepDispatch.ensure.map(e => `- ${e}`).join('\n');
    sections.push(`## Postconditions\nYour result must satisfy:\n${ensureLines}`);
  }

  sections.push(
    `## Context\nWorking directory: ${context.cwd}\nFeature: ${context.featureCode}`
  );

  return sections.join('\n\n');
}

/**
 * Build a retry prompt when postconditions failed.
 *
 * @param {object}   stepDispatch - Original step dispatch
 * @param {string[]} violations   - List of postcondition violations
 * @param {object}   context      - Execution context
 * @returns {string}
 */
export function buildRetryPrompt(stepDispatch, violations, context) {
  const violationLines = violations.map(v => `- ${v}`).join('\n');
  const header = `RETRY — Previous attempt failed postconditions:\n${violationLines}\n\nFix these issues and try again.`;
  return `${header}\n\n${buildStepPrompt(stepDispatch, context)}`;
}

/**
 * Build a prompt for a child flow step within a larger workflow.
 *
 * @param {object} flowDispatch - Flow dispatch (child_flow_name, child_step)
 * @param {object} context      - Execution context
 * @returns {string}
 */
export function buildFlowStepPrompt(flowDispatch, context) {
  const header = `You are executing a sub-workflow "${flowDispatch.child_flow_name}" as part of a larger workflow.`;
  return `${header}\n\n${buildStepPrompt(flowDispatch.child_step, context)}`;
}
