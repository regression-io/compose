/**
 * policy-engine.js — Policy evaluation for lifecycle phase transitions.
 *
 * Stateless — takes a target phase and optional overrides, returns the
 * policy mode (gate/flag/skip). No persistence, no side effects.
 *
 * DEFAULT_POLICIES and VALID_GATE_OUTCOMES are derived from
 * contracts/lifecycle.json via lifecycle-constants.js.
 */

import { DEFAULT_POLICIES, VALID_GATE_OUTCOMES, CONTRACT } from './lifecycle-constants.js';
export { DEFAULT_POLICIES, VALID_GATE_OUTCOMES };

/** Valid policy modes, derived from contract. */
const VALID_MODES = new Set(CONTRACT.policyModes);

/**
 * Evaluate the policy mode for entering a target phase.
 *
 * @param {string} targetPhase — the phase being entered
 * @param {object|null|undefined} overrides — per-feature policy overrides
 * @param {object|null|undefined} settingsPolicies — user settings policies (middle fallback)
 * @returns {'gate'|'flag'|'skip'}
 */
export function evaluatePolicy(targetPhase, overrides, settingsPolicies) {
  const ov = overrides || {};
  const sp = settingsPolicies || {};
  const mode = ov[targetPhase] ?? sp[targetPhase] ?? DEFAULT_POLICIES[targetPhase] ?? 'skip';
  if (!VALID_MODES.has(mode)) {
    throw new Error(`Invalid policy mode: ${mode}`);
  }
  return mode;
}
