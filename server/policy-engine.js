/**
 * policy-engine.js — Policy evaluation for lifecycle phase transitions.
 *
 * Stateless — takes a target phase and optional overrides, returns the
 * policy mode (gate/flag/skip). No persistence, no side effects.
 *
 * DEFAULT_POLICIES and VALID_GATE_OUTCOMES are derived from
 * contracts/lifecycle.json via lifecycle-constants.js.
 */

import { DEFAULT_POLICIES, VALID_GATE_OUTCOMES } from './lifecycle-constants.js';
export { DEFAULT_POLICIES, VALID_GATE_OUTCOMES };

/**
 * Evaluate the policy mode for entering a target phase.
 *
 * @param {string} targetPhase — the phase being entered
 * @param {object|null|undefined} overrides — per-phase mode overrides
 * @returns {'gate'|'flag'|'skip'}
 */
export function evaluatePolicy(targetPhase, overrides) {
  const ov = overrides || {};
  const mode = ov[targetPhase] ?? DEFAULT_POLICIES[targetPhase] ?? 'skip';
  if (!['gate', 'flag', 'skip'].includes(mode)) {
    throw new Error(`Invalid policy mode: ${mode}`);
  }
  return mode;
}
