/**
 * health-history.js — COMP-HEALTH: Score history persistence (item 120).
 *
 * Appends health score records to .compose/data/health-scores.json.
 * Provides read and trend APIs for UI and gate integration.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Path to health-scores.json for a given project root.
 * @param {string} cwd  Project root (must contain .compose/)
 * @returns {string}
 */
function historyPath(cwd) {
  return join(cwd, '.compose', 'data', 'health-scores.json');
}

/**
 * Load the full history array from disk. Returns [] on missing/corrupt file.
 * @param {string} cwd
 * @returns {Array<object>}
 */
function _load(cwd) {
  const p = historyPath(cwd);
  if (!existsSync(p)) return [];
  try {
    const raw = readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Persist the full history array to disk (atomic-ish via direct write).
 * @param {string} cwd
 * @param {Array<object>} entries
 */
function _save(cwd, entries) {
  const p = historyPath(cwd);
  mkdirSync(join(cwd, '.compose', 'data'), { recursive: true });
  writeFileSync(p, JSON.stringify(entries, null, 2), 'utf-8');
}

/**
 * Record a health score entry for a feature.
 *
 * @param {string} cwd
 * @param {object} entry
 * @param {string} entry.featureCode    Feature code (e.g. 'FEAT-1')
 * @param {string} [entry.phase]        Build phase at scoring time
 * @param {number} entry.score          Composite score 0-100
 * @param {object} entry.breakdown      Per-dimension scores
 * @param {string} [entry.timestamp]    ISO timestamp (default: now)
 */
export function recordScore(cwd, { featureCode, phase = null, score, breakdown = {}, timestamp = null }) {
  const entries = _load(cwd);
  entries.push({
    featureCode,
    phase,
    score,
    breakdown,
    timestamp: timestamp ?? new Date().toISOString(),
  });
  _save(cwd, entries);
}

/**
 * Read all history entries for a feature, sorted chronologically (oldest first).
 *
 * @param {string} cwd
 * @param {string} featureCode
 * @returns {Array<object>}
 */
export function readHistory(cwd, featureCode) {
  const all = _load(cwd);
  return all
    .filter(e => e.featureCode === featureCode)
    .sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return ta - tb;
    });
}

/**
 * Compute the trend for a feature based on its two most recent scores.
 *
 * @param {string} cwd
 * @param {string} featureCode
 * @returns {{ latest: object|null, previous: object|null, delta: number|null, direction: 'improving'|'declining'|'stable'|null }}
 */
export function getTrend(cwd, featureCode) {
  const history = readHistory(cwd, featureCode);
  if (history.length === 0) {
    return { latest: null, previous: null, delta: null, direction: null };
  }
  if (history.length === 1) {
    return { latest: history[0], previous: null, delta: null, direction: null };
  }

  const latest   = history[history.length - 1];
  const previous = history[history.length - 2];
  const delta    = latest.score - previous.score;

  let direction;
  if (delta > 1) {
    direction = 'improving';
  } else if (delta < -1) {
    direction = 'declining';
  } else {
    direction = 'stable';
  }

  return { latest, previous, delta, direction };
}
