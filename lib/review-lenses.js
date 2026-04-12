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
    reasoning_template: {
      require_citations: true,
      sections: [
        { id: 'premises', label: 'Premises', description: 'List each changed function/block from the diff. Cite file:line for each.' },
        { id: 'trace', label: 'Quality Trace', description: 'For each premise, evaluate: naming clarity, duplication, error handling, dead code. Reference premises by ID.' },
        { id: 'findings', label: 'Findings', description: 'List LensFinding items. Each must reference the premise it came from.' },
      ],
    },
  },
  'contract-compliance': {
    id: 'contract-compliance',
    lens_name: 'contract-compliance',
    lens_focus: 'Does the implementation match the blueprint? Missing acceptance criteria, wrong file paths, unimplemented items. Read blueprint + implementation.',
    confidence_gate: 7,
    exclusions: 'Items explicitly deferred in the plan',
    reasoning_template: {
      require_citations: true,
      sections: [
        { id: 'premises', label: 'Premises', description: 'List each blueprint requirement and the file:line that implements it. List any blueprint item with NO matching implementation.' },
        { id: 'trace', label: 'Compliance Trace', description: 'For each premise pair (requirement <-> implementation), verify: correct path, correct signature, correct behavior. For unmatched items, confirm they are truly missing.' },
        { id: 'findings', label: 'Findings', description: 'List compliance gaps as LensFinding items. Each must cite the blueprint requirement [P<n>] and the implementation (or lack thereof).' },
      ],
    },
  },
  'security': {
    id: 'security',
    lens_name: 'security',
    lens_focus: 'OWASP top 10, injection, secrets in code, insecure defaults. Focus on concrete, exploitable issues.',
    confidence_gate: 8,
    exclusions: 'DoS/rate-limiting, memory safety in memory-safe languages, theoretical risks without concrete exploit path',
    reasoning_template: {
      require_citations: true,
      sections: [
        { id: 'premises', label: 'Premises', description: 'List each security-sensitive operation in the diff: auth checks, SQL queries, user input handling, crypto, secrets. Cite file:line.' },
        { id: 'trace', label: 'Threat Trace', description: 'For each premise, trace the data flow from source to sink. Identify: is input validated? Is output escaped? Are secrets hardcoded? Reference premises by ID.' },
        { id: 'findings', label: 'Findings', description: 'List vulnerabilities as LensFinding items with OWASP category. Each must trace back to a specific premise and data flow.' },
      ],
    },
  },
  'framework': {
    id: 'framework',
    lens_name: 'framework',
    lens_focus: 'Framework-specific anti-patterns, deprecated APIs, performance pitfalls for the detected framework.',
    confidence_gate: 6,
    exclusions: 'Opinions without measurable impact',
    reasoning_template: {
      require_citations: true,
      sections: [
        { id: 'premises', label: 'Premises', description: 'List each framework API call or pattern used in the diff. Cite file:line. Note the framework version from package.json/requirements.txt.' },
        { id: 'trace', label: 'Pattern Trace', description: 'For each premise, check: is this API deprecated? Is there a preferred alternative? Does usage match framework conventions for this version?' },
        { id: 'findings', label: 'Findings', description: 'List anti-patterns and deprecations as LensFinding items. Each must reference the specific API call [P<n>] and the framework docs justification.' },
      ],
    },
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

// ---------------------------------------------------------------------------
// Diff-size classification (STRAT-REV-7)
// ---------------------------------------------------------------------------

/**
 * Classify a diff by number of changed files.
 *
 * @param {string[]} filesChanged - list of changed file paths
 * @returns {'small'|'medium'|'large'}
 */
export function classifyDiffSize(filesChanged) {
  const count = Array.isArray(filesChanged) ? filesChanged.length : 0;
  if (count <= 2) return 'small';
  if (count <= 8) return 'medium';
  return 'large';
}

/**
 * Whether cross-model (Codex) review should run for this diff.
 * Only triggers for large diffs (≥9 files).
 *
 * @param {string[]} filesChanged - list of changed file paths
 * @returns {boolean}
 */
export function shouldRunCrossModel(filesChanged) {
  return classifyDiffSize(filesChanged) === 'large';
}

// ---------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------

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
