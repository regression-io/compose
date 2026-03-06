/**
 * find-root.js — Pure project-root resolution utility.
 *
 * Side-effect-free at import time. Safe to import from CLI entry points
 * (bin/compose.js) without triggering process.exit or other side effects.
 */

import path from 'node:path';
import fs from 'node:fs';

/** Markers that indicate a project root, checked in priority order. */
export const MARKERS = ['.compose', '.stratum.yaml', '.git'];

/**
 * Walk up from startDir looking for a directory containing any marker.
 * @param {string} startDir
 * @returns {string|null} — absolute path to project root, or null
 */
export function findProjectRoot(startDir) {
  let dir = path.resolve(startDir);
  const { root } = path.parse(dir);
  while (dir !== root) {
    for (const marker of MARKERS) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}
