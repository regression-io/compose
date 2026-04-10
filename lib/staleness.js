/**
 * staleness.js — Artifact staleness detection for COMP-CTX (item 101).
 *
 * Artifacts embed a phase marker in their first 5 lines:
 *   <!-- phase: explore_design -->
 *
 * If the feature's current phase is past the artifact's written phase,
 * the artifact is flagged stale.
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Canonical phase order — earlier index = earlier phase
const PHASE_ORDER = [
  'explore_design',
  'blueprint',
  'plan',
  'build',
  'ship',
  'done',
];

/**
 * Return numeric index of phase (lower = earlier).
 * Unknown phases return -1 so they're never considered stale.
 */
function phaseIndex(phase) {
  return PHASE_ORDER.indexOf(phase);
}

/**
 * Extract the <!-- phase: <name> --> marker from the first 5 lines of text.
 * Returns the phase name or null if not found.
 *
 * @param {string} content
 * @returns {string|null}
 */
export function extractPhaseMarker(content) {
  const lines = content.split('\n').slice(0, 5);
  for (const line of lines) {
    const m = line.match(/<!--\s*phase:\s*([\w_-]+)\s*-->/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Check staleness of tracked artifacts in a feature folder.
 *
 * Scans for design.md, blueprint.md, plan.md in featureDir.
 * For each file that exists and has a phase marker, compares its
 * phase to currentPhase. If currentPhase is strictly later in
 * PHASE_ORDER, the artifact is stale.
 *
 * @param {string} featureDir   - Absolute path to the feature folder
 * @param {string} currentPhase - Feature's current phase name
 * @returns {Array<{ file: string, writtenPhase: string, currentPhase: string, stale: boolean }>}
 */
export function checkStaleness(featureDir, currentPhase) {
  const TRACKED = ['design.md', 'blueprint.md', 'plan.md'];
  const results = [];

  const currentIdx = phaseIndex(currentPhase);

  for (const filename of TRACKED) {
    const filePath = join(featureDir, filename);
    if (!existsSync(filePath)) continue;

    let content;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const writtenPhase = extractPhaseMarker(content);
    if (!writtenPhase) continue;

    const writtenIdx = phaseIndex(writtenPhase);
    const stale = writtenIdx !== -1 && currentIdx !== -1 && currentIdx > writtenIdx;

    results.push({ file: filename, writtenPhase, currentPhase, stale });
  }

  return results;
}
