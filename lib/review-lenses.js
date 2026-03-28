/**
 * review-lenses.js — Review lens definitions and triage logic for STRAT-REV.
 *
 * Each lens is a specialized reviewer that focuses on one concern.
 * The triage function decides which lenses to activate based on the file list.
 */

/** Baseline lenses — always run */
export const BASELINE_LENSES = ['diff-quality', 'contract-compliance'];

/** Full lens definitions */
export const LENS_DEFINITIONS = {
  'diff-quality': {
    id: 'diff-quality',
    lens_name: 'diff-quality',
    lens_focus: 'Code style, test coverage gaps, dead code, naming, duplication. Read the git diff only.',
    confidence_gate: 6,
    exclusions: 'Style-only nits without functional impact',
  },
  'contract-compliance': {
    id: 'contract-compliance',
    lens_name: 'contract-compliance',
    lens_focus: 'Does the implementation match the blueprint? Missing acceptance criteria, wrong file paths, unimplemented items. Read blueprint + implementation.',
    confidence_gate: 7,
    exclusions: 'Items explicitly deferred in the plan',
  },
  'security': {
    id: 'security',
    lens_name: 'security',
    lens_focus: 'OWASP top 10, injection, secrets in code, insecure defaults. Focus on concrete, exploitable issues.',
    confidence_gate: 8,
    exclusions: 'DoS/rate-limiting, memory safety in memory-safe languages, theoretical risks without concrete exploit path',
  },
  'framework': {
    id: 'framework',
    lens_name: 'framework',
    lens_focus: 'Framework-specific anti-patterns, deprecated APIs, performance pitfalls for the detected framework.',
    confidence_gate: 6,
    exclusions: 'Opinions without measurable impact',
  },
};

/** File patterns that trigger the security lens */
const SECURITY_PATTERNS = [
  /auth/i, /login/i, /session/i, /token/i, /crypt/i, /password/i, /secret/i,
  /\.sql$/i, /query/i, /sanitiz/i, /escape/i, /middleware/i,
  /routes?\.(js|ts|jsx|tsx)$/i, /handler/i, /endpoint/i,
  /api\//i, /server\//i,
];

/** File patterns that trigger the framework lens */
const FRAMEWORK_PATTERNS = [
  /\.(jsx|tsx)$/i,                          // React
  /next\.config/i, /pages\//i, /app\//i,   // Next.js
  /express/i, /router/i, /middleware/i,     // Express
  /\.vue$/i, /nuxt/i,                       // Vue/Nuxt
  /angular/i,                               // Angular
];

/**
 * Triage: decide which lenses to activate.
 *
 * @param {string[]} fileList - list of changed file paths
 * @returns {Array<object>} LensTask[] for parallel_dispatch
 */
export function triageLenses(fileList) {
  const activeLensIds = [...BASELINE_LENSES];

  const hasSecurityFiles = fileList.some(f =>
    SECURITY_PATTERNS.some(p => p.test(f))
  );
  if (hasSecurityFiles) activeLensIds.push('security');

  const hasFrameworkFiles = fileList.some(f =>
    FRAMEWORK_PATTERNS.some(p => p.test(f))
  );
  if (hasFrameworkFiles) activeLensIds.push('framework');

  return activeLensIds.map(id => {
    const def = LENS_DEFINITIONS[id];
    if (!def) throw new Error(`Unknown lens: ${id}`);
    return { ...def };
  });
}
