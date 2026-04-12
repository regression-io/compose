/**
 * cert-inject.js — STRAT-CERT reasoning template injection for parallel dispatch tasks.
 *
 * Mirrors Python's inject_cert_instructions() from executor.py.
 * Used by build.js to inject structured reasoning prompts into
 * STRAT-REV lens task intents.
 *
 * See: docs/features/STRAT-CERT/design.md (Consumer Wiring addendum)
 */

export const DEFAULT_CERT_SECTIONS = [
  { id: 'premises', label: 'Premises', description: 'State every verifiable fact you are using. Each premise must cite a file:line.' },
  { id: 'trace', label: 'Trace', description: 'Walk through the logic step by step. Reference premises by [P<n>] ID.' },
  { id: 'conclusion', label: 'Conclusion', description: 'State your finding. Every claim must reference at least one premise.' },
];

/**
 * Inject structured reasoning certificate instructions into an intent string.
 *
 * @param {string} intent - The original task intent
 * @param {object} template - reasoning_template object with optional sections[] and require_citations
 * @returns {string} Intent with appended certificate structure instructions
 */
export function injectCertInstructions(intent, template) {
  if (!template) return intent;
  const sections = template.sections?.length ? template.sections : DEFAULT_CERT_SECTIONS;
  const requireCitations = template.require_citations || false;
  const lines = [intent, '', '---', '', 'You MUST structure your response with these sections:', ''];
  for (const [i, section] of sections.entries()) {
    lines.push(`## ${section.label}`);
    lines.push(section.description);
    if (section.id === 'premises' && requireCitations) lines.push('Format each fact as: [P1] <fact, citing file:line>, [P2] ..., etc.');
    else if (i > 0 && requireCitations) lines.push('Reference premises by their [P<n>] ID.');
    lines.push('');
  }
  lines.push('Include your full structured reasoning in a `reasoning` field in your JSON output.');
  return lines.join('\n');
}
