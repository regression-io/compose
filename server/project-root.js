/**
 * project-root.js — Resolve COMPOSE_HOME and TARGET_ROOT.
 *
 * COMPOSE_HOME: where Compose's own code lives (server/, node_modules/, etc.)
 * TARGET_ROOT:  the project being developed. Resolved by:
 *   1. COMPOSE_TARGET env var (explicit override)
 *   2. Walk up from cwd looking for .compose/, .stratum.yaml, or .git
 *   3. Fall back to cwd
 *
 * All project paths are accessed via getTargetRoot() / getDataDir() so they
 * update when switchProject() is called at runtime.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findProjectRoot } from './find-root.js';

export { findProjectRoot } from './find-root.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Where Compose's own code lives. Never changes. */
export const COMPOSE_HOME = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Mutable project binding
// ---------------------------------------------------------------------------

let _targetRoot = (() => {
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

let _dataDir = path.join(_targetRoot, '.compose', 'data');
let _configCache = null;

/** The target project being developed. */
export function getTargetRoot() { return _targetRoot; }

/** Data directory for Compose state. Lives in the target project. */
export function getDataDir() { return _dataDir; }

// ---------------------------------------------------------------------------
// Switch project at runtime
// ---------------------------------------------------------------------------

const _switchListeners = [];

/**
 * Register a callback for project switches.
 * @param {(targetRoot: string, dataDir: string) => void} fn
 */
export function onProjectSwitch(fn) {
  _switchListeners.push(fn);
}

/**
 * Switch to a different project directory.
 * @param {string} newRoot — absolute path to the new project
 * @returns {{ targetRoot: string, dataDir: string }}
 */
export function switchProject(newRoot) {
  const resolved = path.resolve(newRoot);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Project path does not exist: ${resolved}`);
  }
  _targetRoot = resolved;
  _dataDir = path.join(resolved, '.compose', 'data');
  _configCache = null;
  fs.mkdirSync(_dataDir, { recursive: true });
  console.log(`[project-root] Switched to: ${resolved}`);
  for (const fn of _switchListeners) {
    try { fn(_targetRoot, _dataDir); } catch (e) { console.error('[project-root] Switch listener error:', e.message); }
  }
  return { targetRoot: _targetRoot, dataDir: _dataDir };
}

/** Ensure the data directory exists. */
export function ensureDataDir() {
  fs.mkdirSync(getDataDir(), { recursive: true });
}

// ---------------------------------------------------------------------------
// Project config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  capabilities: Object.freeze({ stratum: true, lifecycle: true }),
  paths: Object.freeze({ docs: 'docs', features: 'docs/features', journal: 'docs/journal' }),
});

function cloneConfig(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export function loadProjectConfig() {
  if (_configCache) return cloneConfig(_configCache);
  const configPath = path.join(getTargetRoot(), '.compose', 'compose.json');
  try {
    _configCache = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return cloneConfig(_configCache);
  } catch {
    _configCache = DEFAULT_CONFIG;
    return cloneConfig(DEFAULT_CONFIG);
  }
}

export function resolveProjectPath(key) {
  const config = loadProjectConfig();
  const rel = config.paths?.[key];
  if (!rel) return path.join(getTargetRoot(), DEFAULT_CONFIG.paths[key] || key);
  return path.join(getTargetRoot(), rel);
}
