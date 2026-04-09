/**
 * triage.js — Pre-flight feature triage.
 *
 * Analyzes the feature folder contents and assigns a complexity tier.
 * Populates the build profile (needs_prd, needs_architecture, needs_verification,
 * needs_report) in feature.json so subsequent builds can toggle skip_if on
 * pipeline steps without requiring manual intervention.
 *
 * No LLM calls — pure file analysis and heuristics.
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Tier definitions
// ---------------------------------------------------------------------------
//
// Tier 0: Config-only — dotfiles, package.json tweaks, no design docs
//         → skip prd, architecture, verification, report
// Tier 1: Single-concern — 1-2 files in plan, no security/core paths
//         → skip prd, architecture, report (keep verification)
// Tier 2: Standard feature — multiple files, design doc present
//         → skip prd, architecture (default — what most features need)
// Tier 3: Cross-component / security-sensitive
//         → enable architecture, skip prd
// Tier 4: Architecture change / shared core code
//         → enable prd and architecture
// ---------------------------------------------------------------------------

const SECURITY_PATTERNS = [
  /\bauth\b/i,
  /\bcrypto\b/i,
  /\bsession\b/i,
  /\bmiddleware\b/i,
  /\btoken\b/i,
  /\bpermission\b/i,
  /\bcredential\b/i,
  /\bjwt\b/i,
  /\boauth\b/i,
  /\bpassword\b/i,
];

const CORE_PATTERNS = [
  /\blib\//,
  /\bserver\/index\b/,
  /connector.*base/i,
  /\bbase.*connector/i,
  /\bcore\//,
  /\bshared\//,
  /stratum-mcp/i,
];

/**
 * Extract file paths mentioned in a markdown string.
 * Matches backtick-quoted paths that look like file paths (contain a dot or slash).
 *
 * @param {string} content
 * @returns {string[]}
 */
function extractFilePaths(content) {
  const matches = [];
  // Match backtick-quoted strings that look like paths
  const backtickRe = /`([^`]+)`/g;
  let m;
  while ((m = backtickRe.exec(content)) !== null) {
    const val = m[1];
    if (val.includes('/') || (val.includes('.') && !val.includes(' '))) {
      matches.push(val);
    }
  }
  return matches;
}

/**
 * Count markdown checkbox items in content.
 *
 * @param {string} content
 * @returns {number}
 */
function countTasks(content) {
  const re = /^\s*-\s*\[[ xX]\]/gm;
  return (content.match(re) ?? []).length;
}

/**
 * Check whether any path in a list matches the given patterns.
 *
 * @param {string[]} paths
 * @param {RegExp[]} patterns
 * @returns {boolean}
 */
function anyMatch(paths, patterns) {
  return paths.some(p => patterns.some(re => re.test(p)));
}

/**
 * Derive tier and profile from signal values.
 *
 * @param {{ fileCount: number, securityPaths: boolean, corePaths: boolean, taskCount: number, hasDesignDoc: boolean }} signals
 * @returns {{ tier: number, profile: object, rationale: string }}
 */
function deriveProfile(signals) {
  const { fileCount, securityPaths, corePaths, taskCount, hasDesignDoc } = signals;

  // Tier 4: core/shared code changes → needs full design review
  if (corePaths) {
    return {
      tier: 4,
      profile: {
        needs_prd: true,
        needs_architecture: true,
        needs_verification: true,
        needs_report: true,
      },
      rationale: 'Touches core/shared code — full design review required',
    };
  }

  // Tier 3: security-sensitive → architecture required
  if (securityPaths) {
    return {
      tier: 3,
      profile: {
        needs_prd: false,
        needs_architecture: true,
        needs_verification: true,
        needs_report: false,
      },
      rationale: 'References security-sensitive paths — architecture review required',
    };
  }

  // Tier 0: config-only — no design docs, at most 1 file path, very few tasks
  if (!hasDesignDoc && fileCount <= 1 && taskCount <= 5) {
    return {
      tier: 0,
      profile: {
        needs_prd: false,
        needs_architecture: false,
        needs_verification: false,
        needs_report: false,
      },
      rationale: 'Config-only change — minimal scope, no design docs',
    };
  }

  // Tier 1: single-concern — few files, no special paths
  if (fileCount <= 2 && taskCount <= 10) {
    return {
      tier: 1,
      profile: {
        needs_prd: false,
        needs_architecture: false,
        needs_verification: true,
        needs_report: false,
      },
      rationale: 'Single-concern change — verification sufficient',
    };
  }

  // Tier 2: standard feature (default)
  return {
    tier: 2,
    profile: {
      needs_prd: false,
      needs_architecture: false,
      needs_verification: true,
      needs_report: false,
    },
    rationale: 'Standard feature — default build profile',
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run triage on a feature folder.
 *
 * @param {string} featureCode - Feature code (e.g. 'FEAT-1')
 * @param {{ cwd: string }} opts
 * @returns {Promise<{ tier: number, profile: object, rationale: string, signals: object }>}
 */
export async function runTriage(featureCode, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const featureDir = join(cwd, 'docs', 'features', featureCode);

  // Collect content from key files
  const candidateFiles = ['plan.md', 'blueprint.md', 'design.md', 'prd.md', 'architecture.md'];
  let combinedContent = '';
  let hasDesignDoc = false;

  for (const fname of candidateFiles) {
    const fpath = join(featureDir, fname);
    if (existsSync(fpath)) {
      if (['design.md', 'prd.md', 'architecture.md'].includes(fname)) {
        hasDesignDoc = true;
      }
      try {
        combinedContent += readFileSync(fpath, 'utf-8') + '\n';
      } catch { /* skip unreadable */ }
    }
  }

  const filePaths = extractFilePaths(combinedContent);
  const taskCount = countTasks(combinedContent);
  const securityPaths = anyMatch(filePaths, SECURITY_PATTERNS);
  const corePaths = anyMatch(filePaths, CORE_PATTERNS);

  // Deduplicate file paths for count
  const uniquePaths = new Set(filePaths);
  const fileCount = uniquePaths.size;

  const signals = { fileCount, securityPaths, corePaths, taskCount, hasDesignDoc };
  const { tier, profile, rationale } = deriveProfile(signals);

  return {
    tier,
    profile,
    rationale,
    signals: { fileCount, securityPaths, corePaths, taskCount },
  };
}

/**
 * Check whether cached triage results are stale.
 *
 * Returns true if:
 *   - feature.json has no triageTimestamp
 *   - any file in the feature folder has an mtime newer than triageTimestamp
 *
 * @param {string} cwd - Project root
 * @param {string} featureCode - Feature code
 * @param {string} [featuresDir] - Relative path to features dir (default: docs/features)
 * @returns {boolean}
 */
export function isTriageStale(cwd, featureCode, featuresDir = 'docs/features') {
  const featureDir = join(cwd, featuresDir, featureCode);
  const featureJsonPath = join(featureDir, 'feature.json');

  if (!existsSync(featureJsonPath)) return true;

  let feature;
  try {
    feature = JSON.parse(readFileSync(featureJsonPath, 'utf-8'));
  } catch {
    return true;
  }

  if (!feature.triageTimestamp) return true;

  const triageTime = new Date(feature.triageTimestamp).getTime();
  if (isNaN(triageTime)) return true;

  // Check all files in the feature folder
  if (!existsSync(featureDir)) return true;
  try {
    const entries = readdirSync(featureDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = join(featureDir, entry.name);
      try {
        const stat = statSync(filePath);
        if (stat.mtimeMs > triageTime) return true;
      } catch { /* skip */ }
    }
  } catch {
    return true;
  }

  return false;
}
