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

  const ctxLines = [
    `Working directory: ${context.cwd}`,
    `Feature: ${context.featureCode}`,
  ];
  if (context.featureDir) {
    ctxLines.push(`Feature docs: ${context.featureDir}`);
  }
  sections.push(`## Context\n${ctxLines.join('\n')}`);

  // Inject prior step results so the agent doesn't re-explore from scratch
  if (Array.isArray(context.stepHistory) && context.stepHistory.length > 0) {
    const historyLines = context.stepHistory.map(h => {
      let line = `- **${h.stepId}**: ${h.summary}`;
      if (h.artifact) line += ` → \`${h.artifact}\``;
      return line;
    });
    sections.push(`## Prior Steps\n${historyLines.join('\n')}`);

    // If any prior step captured a file manifest, include it for downstream steps
    // (context.filesChanged is maintained as a pre-deduplicated array in build.js)
    if (context.filesChanged?.length > 0) {
      sections.push(`## Files Changed by This Feature\n${context.filesChanged.map(f => '- ' + f).join('\n')}`);
    }
  }

  return sections.join('\n\n');
}

/**
 * Build a "File Ownership Conflicts" section for decompose-step retry prompts.
 *
 * @param {Array<{task_a: string, task_b: string, files: string[]}>} conflicts
 * @returns {string}
 */
function buildConflictSection(conflicts) {
  const lines = [
    '## File Ownership Conflicts — Resolution Required',
    '',
    'The following task pairs share `files_owned` entries but have no `depends_on`',
    'relationship. Independent tasks may not both claim the same file.',
    'Add a `depends_on` edge from the later task to the earlier task to resolve each conflict:',
    '',
  ];

  for (const { task_a, task_b, files } of conflicts) {
    lines.push(`- **${task_a}** and **${task_b}** both own:`);
    for (const f of files) lines.push(`    - \`${f}\``);
    lines.push(`  → Add \`depends_on: [${task_a}]\` to \`${task_b}\` (or vice versa).`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build a retry prompt when postconditions failed.
 *
 * @param {object}   stepDispatch - Original step dispatch
 * @param {string[]} violations   - List of postcondition violations
 * @param {object}   context      - Execution context
 * @param {Array<{task_a, task_b, files}>} [conflicts] - Structured file conflicts (optional)
 * @returns {string}
 */
export function buildRetryPrompt(stepDispatch, violations, context, conflicts) {
  const violationLines = violations.map(v => `- ${v}`).join('\n');
  const header = `RETRY — Previous attempt failed postconditions:\n${violationLines}\n\nFix these issues and try again.`;

  const sections = [header, buildStepPrompt(stepDispatch, context)];

  if (conflicts && conflicts.length > 0) {
    sections.push(buildConflictSection(conflicts));
  }

  return sections.join('\n\n');
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

/**
 * Build context preamble for a gate Q&A agent.
 *
 * Assembles the same execution context that regular steps get so the agent
 * answering gate questions knows what feature is being built, what just
 * completed, what files were touched, and what the gate controls.
 *
 * @param {object} gateDispatch - Stratum gate dispatch (step_id, on_approve, on_revise, on_kill)
 * @param {object} context      - Execution context (cwd, featureCode, featureDir, stepHistory, filesChanged)
 * @param {object} [gateExtras] - Optional enrichment (fromPhase, toPhase, summary)
 * @returns {string}
 */
export function buildGateContext(gateDispatch, context, gateExtras) {
  const sections = [];

  sections.push(
    `You are answering questions about a gate review in a Compose build workflow.\n` +
    `Gate: "${gateDispatch.step_id}"`,
  );

  // Feature identity
  const ctxLines = [
    `Working directory: ${context.cwd}`,
    `Feature: ${context.featureCode}`,
  ];
  if (context.featureDir) {
    ctxLines.push(`Feature docs: ${context.featureDir}`);
  }
  sections.push(`## Feature\n${ctxLines.join('\n')}`);

  // Phase transition
  if (gateExtras?.fromPhase || gateExtras?.toPhase) {
    const from = gateExtras.fromPhase ?? '(unknown)';
    const to = gateExtras.toPhase ?? '(unknown)';
    sections.push(`## Phase Transition\n${from} → ${to}`);
  }

  // Gate summary (from stratum dispatch enrichment)
  if (gateExtras?.summary) {
    sections.push(`## Gate Summary\n${gateExtras.summary}`);
  }

  // Routing — what happens on each decision
  const routing = [];
  routing.push(`- **Approve** → ${gateDispatch.on_approve ?? '(complete flow)'}`);
  routing.push(`- **Revise** → re-run from \`${gateDispatch.on_revise ?? '(kill)'}\``);
  routing.push(`- **Kill** → ${gateDispatch.on_kill ?? '(terminate flow)'}`);
  sections.push(`## Gate Routing\n${routing.join('\n')}`);

  // Prior step history
  if (Array.isArray(context.stepHistory) && context.stepHistory.length > 0) {
    const historyLines = context.stepHistory.map(h => {
      let line = `- **${h.stepId}**: ${h.summary}`;
      if (h.artifact) line += ` → \`${h.artifact}\``;
      return line;
    });
    sections.push(`## Prior Steps\n${historyLines.join('\n')}`);
  }

  // Files changed
  if (context.filesChanged?.length > 0) {
    sections.push(`## Files Changed by This Feature\n${context.filesChanged.map(f => '- ' + f).join('\n')}`);
  }

  return sections.join('\n\n');
}
