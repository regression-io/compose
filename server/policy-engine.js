/**
 * policy-engine.js — Policy evaluation for lifecycle phase transitions.
 *
 * Stateless — takes a target phase and optional overrides, returns the
 * policy mode (gate/flag/skip). No persistence, no side effects.
 */

// explore_design is omitted — it's the entry phase, never a transition target.
// Policy applies to the phase being *entered*, not the phase being *left*.
export const DEFAULT_POLICIES = {
  prd:            'skip',
  architecture:   'skip',
  blueprint:      'gate',
  verification:   'gate',
  plan:           'gate',
  execute:        'flag',
  report:         'skip',
  docs:           'flag',
  ship:           'gate',
};

export const VALID_GATE_OUTCOMES = ['approved', 'revised', 'killed'];

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
