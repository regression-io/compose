/**
 * Policy Evaluator — determines gate behavior for phase transitions.
 *
 * Pure function, no state, no side effects. Reads from the merged
 * settings object (SettingsStore.get() shape).
 *
 * Policy modes:
 *   gate — human approval required (default)
 *   flag — auto-approve, emit stream event for audit
 *   skip — silent pass-through, no gate record
 */

/**
 * Evaluate the policy for a phase transition.
 *
 * @param {object} settings — merged settings (must have .policies object)
 * @param {string} stepId   — the Stratum step ID
 * @param {object} [opts]
 * @param {string} [opts.toPhase]   — target phase (takes precedence over stepId for lookup)
 * @param {string} [opts.fromPhase] — source phase (informational, not used for lookup)
 * @returns {{ mode: 'gate'|'flag'|'skip', reason: string }}
 */
export function evaluatePolicy(settings, stepId, opts = {}) {
  const phase = opts.toPhase ?? stepId;
  const mode = settings?.policies?.[phase] ?? null;

  if (mode === null || mode === undefined) {
    return { mode: 'gate', reason: `no policy for '${phase}', defaulting to gate` };
  }

  if (mode !== 'gate' && mode !== 'flag' && mode !== 'skip') {
    return { mode: 'gate', reason: `unknown policy '${mode}' for '${phase}', defaulting to gate` };
  }

  return { mode, reason: `phase '${phase}' policy is '${mode}'` };
}
