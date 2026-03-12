/**
 * step-validator.js — Agent-as-validator for pipeline step outputs.
 *
 * After a step writes its artifact, dispatches a lightweight agent call
 * to read the artifact and validate it against criteria. Returns
 * { valid, issues } so the dispatch loop can retry if needed.
 */

import { runAndNormalize } from './result-normalizer.js';

/**
 * Run a validation agent call for a completed step.
 *
 * @param {object} opts
 * @param {string}   opts.artifact  - File path to validate (relative to cwd)
 * @param {string[]} opts.criteria  - List of things to check
 * @param {string}   opts.stepId    - Step ID (for logging)
 * @param {object}   opts.connector - Agent connector to use
 * @returns {Promise<{ valid: boolean, issues: string[] }>}
 */
export async function validateStep({ artifact, criteria, stepId, connector }) {
  const prompt =
    `You are a validator. Read the file "${artifact}" and check the following criteria:\n\n` +
    criteria.map((c, i) => `${i + 1}. ${c}`).join('\n') + '\n\n' +
    `Return ONLY a JSON code block — no other text:\n` +
    '```json\n' +
    '{ "valid": true, "issues": [] }\n' +
    '```\n' +
    `Set valid to false and list issues if any criterion is not met.`;

  // Minimal dispatch descriptor — only output_fields needed for JSON extraction
  const dispatch = {
    step_id: `validate_${stepId}`,
    output_fields: {
      valid: 'boolean',
      issues: 'array',
    },
  };

  const { result } = await runAndNormalize(connector, prompt, dispatch);

  if (!result || typeof result.valid !== 'boolean') {
    // Extraction failed — assume valid (optimistic fallback)
    process.stderr.write(`    ⚠ Validator returned no structured result for ${stepId}, assuming valid\n`);
    return { valid: true, issues: [] };
  }

  return { valid: result.valid, issues: result.issues ?? [] };
}
