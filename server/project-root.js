/**
 * project-root.js — Resolve COMPOSE_HOME and TARGET_ROOT.
 *
 * COMPOSE_HOME: where Compose's own code lives (server/, node_modules/, etc.)
 * TARGET_ROOT:  the project being developed. Resolved by:
 *   1. COMPOSE_TARGET env var (explicit override)
 *   2. Walk up from cwd looking for .compose/, .stratum.yaml, or .git
 *   3. Fall back to cwd
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findProjectRoot } from './find-root.js';

export { findProjectRoot } from './find-root.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Where Compose's own code lives. Never changes. */
export const COMPOSE_HOME = path.resolve(__dirname, '..');

/** The target project being developed. */
export const TARGET_ROOT = (() => {
  if (process.env.COMPOSE_TARGET) {
    const resolved = path.resolve(process.env.COMPOSE_TARGET);
    if (!fs.existsSync(resolved)) {
      console.error(`[project-root] COMPOSE_TARGET=${process.env.COMPOSE_TARGET} does not exist`);
      process.exit(1);
    }
    return resolved;
  }
  return findProjectRoot(process.cwd()) || process.cwd();
})();

/** Data directory for Compose state (vision, sessions, settings). Lives in the target project. */
export const DATA_DIR = path.join(TARGET_ROOT, '.compose', 'data');

/** Ensure the data directory exists. */
export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Project config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  capabilities: Object.freeze({ stratum: true, speckit: false, lifecycle: true }),
  paths: Object.freeze({ docs: 'docs', features: 'docs/features', journal: 'docs/journal' }),
});

function cloneConfig(obj) {
  return JSON.parse(JSON.stringify(obj));
}

let _configCache = null;

/**
 * Load and return the project config from .compose/compose.json.
 * Returns a fresh clone on every call — safe to mutate locally.
 * Falls back to defaults on missing or corrupt file.
 */
export function loadProjectConfig() {
  if (_configCache) return cloneConfig(_configCache);
  const configPath = path.join(TARGET_ROOT, '.compose', 'compose.json');
  try {
    _configCache = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return cloneConfig(_configCache);
  } catch {
    _configCache = DEFAULT_CONFIG;
    return cloneConfig(DEFAULT_CONFIG);
  }
}

/**
 * Resolve a project path key to an absolute path.
 * Reads from config, falls back to DEFAULT_CONFIG.
 * @param {string} key — one of 'docs', 'features', 'journal'
 * @returns {string} — absolute path
 */
export function resolveProjectPath(key) {
  const config = loadProjectConfig();
  const rel = config.paths?.[key];
  if (!rel) return path.join(TARGET_ROOT, DEFAULT_CONFIG.paths[key] || key);
  return path.join(TARGET_ROOT, rel);
}
