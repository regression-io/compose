/**
 * budget-ledger.js — Cumulative iteration budget tracking across sessions.
 *
 * Ledger file: .compose/data/budget-ledger.json
 * Shape: { features: { [featureCode]: { totalIterations, totalActions, totalTimeMs, sessions[] } } }
 */

import fs from 'node:fs';
import path from 'node:path';

const LEDGER_FILE = 'budget-ledger.json';

function ledgerPath(composeDir) {
  return path.join(composeDir, 'data', LEDGER_FILE);
}

/**
 * Read the ledger file. Returns empty structure if missing.
 * @param {string} composeDir — path to .compose directory
 */
export function readLedger(composeDir) {
  const filePath = ledgerPath(composeDir);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { features: {} };
    }
    throw err;
  }
}

/**
 * Record an iteration completion event for a feature.
 * Creates the ledger file if it does not exist.
 *
 * @param {string} composeDir
 * @param {string} featureCode
 * @param {{ iterations: number, actions: number, timeMs: number }} entry
 */
export function recordIteration(composeDir, featureCode, { iterations = 1, actions = 0, timeMs = 0 } = {}) {
  const filePath = ledgerPath(composeDir);
  const ledger = readLedger(composeDir);

  if (!ledger.features[featureCode]) {
    ledger.features[featureCode] = { totalIterations: 0, totalActions: 0, totalTimeMs: 0, sessions: [] };
  }
  const feat = ledger.features[featureCode];
  feat.totalIterations += iterations;
  feat.totalActions += actions;
  feat.totalTimeMs += timeMs;
  feat.sessions.push({ recordedAt: new Date().toISOString(), iterations, actions, timeMs });

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(ledger, null, 2), 'utf-8');
  return feat;
}

/**
 * Check whether a feature has exceeded its cumulative budget.
 *
 * @param {string} composeDir
 * @param {string} featureCode
 * @param {{ maxTotalIterations?: number, maxTotalActions?: number }} limits
 * @returns {{ exceeded: boolean, reason: string|null, usage: object }}
 */
export function checkCumulativeBudget(composeDir, featureCode, limits = {}) {
  const ledger = readLedger(composeDir);
  const feat = ledger.features[featureCode] ?? { totalIterations: 0, totalActions: 0, totalTimeMs: 0, sessions: [] };

  const usage = {
    totalIterations: feat.totalIterations,
    totalActions: feat.totalActions,
    totalTimeMs: feat.totalTimeMs,
  };

  if (limits.maxTotalIterations != null && feat.totalIterations >= limits.maxTotalIterations) {
    return { exceeded: true, reason: `Cumulative iteration limit reached (${feat.totalIterations}/${limits.maxTotalIterations})`, usage };
  }
  if (limits.maxTotalActions != null && feat.totalActions >= limits.maxTotalActions) {
    return { exceeded: true, reason: `Cumulative action limit reached (${feat.totalActions}/${limits.maxTotalActions})`, usage };
  }

  return { exceeded: false, reason: null, usage };
}
