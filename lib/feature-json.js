/**
 * feature-json.js — Read, write, and list feature.json files.
 *
 * Each feature lives at docs/features/<CODE>/feature.json.
 * feature.json is the machine-readable source of truth.
 * ROADMAP.md is generated from these files.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { readdirSync } from 'fs';

/**
 * @typedef {object} FeatureJson
 * @property {string} code
 * @property {string} description
 * @property {string} status - PLANNED | IN_PROGRESS | PARTIAL | COMPLETE | SUPERSEDED | PARKED
 * @property {string} [parent] - Parent feature/phase code (e.g., "STRAT-1", "Phase 6")
 * @property {string} [phase] - Phase heading for ROADMAP grouping
 * @property {number} [position] - Sort order within phase
 * @property {string} [complexity] - low | medium | high (from scope step)
 * @property {object} [profile] - BuildProfile from scope step
 * @property {string} [created] - ISO date
 * @property {string} [updated] - ISO date
 */

/**
 * Read a single feature.json.
 *
 * @param {string} cwd - Project root
 * @param {string} code - Feature code
 * @param {string} [featuresDir] - Relative path to features dir (default: docs/features)
 * @returns {FeatureJson|null}
 */
export function readFeature(cwd, code, featuresDir = 'docs/features') {
  const path = join(cwd, featuresDir, code, 'feature.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Write a feature.json, creating the directory if needed.
 *
 * @param {string} cwd - Project root
 * @param {FeatureJson} feature
 * @param {string} [featuresDir]
 */
export function writeFeature(cwd, feature, featuresDir = 'docs/features') {
  const dir = join(cwd, featuresDir, feature.code);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'feature.json');
  feature.updated = new Date().toISOString().slice(0, 10);
  writeFileSync(path, JSON.stringify(feature, null, 2) + '\n');
}

/**
 * List all feature.json files in the features directory.
 *
 * @param {string} cwd - Project root
 * @param {string} [featuresDir]
 * @returns {FeatureJson[]}
 */
export function listFeatures(cwd, featuresDir = 'docs/features') {
  const dir = join(cwd, featuresDir);
  if (!existsSync(dir)) return [];

  const features = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const fjPath = join(dir, entry.name, 'feature.json');
    if (!existsSync(fjPath)) continue;
    try {
      features.push(JSON.parse(readFileSync(fjPath, 'utf-8')));
    } catch { /* skip malformed */ }
  }

  // Sort by phase, then position, then code
  features.sort((a, b) => {
    if (a.phase !== b.phase) return (a.phase ?? '').localeCompare(b.phase ?? '');
    if ((a.position ?? 999) !== (b.position ?? 999)) return (a.position ?? 999) - (b.position ?? 999);
    return a.code.localeCompare(b.code);
  });

  return features;
}

/**
 * Update a feature's status (and optionally other fields).
 *
 * @param {string} cwd
 * @param {string} code
 * @param {Partial<FeatureJson>} updates
 * @param {string} [featuresDir]
 * @returns {FeatureJson|null} - Updated feature, or null if not found
 */
export function updateFeature(cwd, code, updates, featuresDir = 'docs/features') {
  const feature = readFeature(cwd, code, featuresDir);
  if (!feature) return null;
  Object.assign(feature, updates);
  writeFeature(cwd, feature, featuresDir);
  return feature;
}
