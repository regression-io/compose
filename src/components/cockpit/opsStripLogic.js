/**
 * opsStripLogic.js — Pure logic for OpsStrip, testable without React/JSX.
 */

/**
 * Derive ops entries from vision store state.
 */
export function deriveEntries({ activeBuild, gates, recentErrors, iterationStates }) {
  const entries = [];

  // Active build entry
  if (activeBuild && activeBuild.featureCode) {
    const stepLabel = activeBuild.currentStep
      ? `${activeBuild.currentStep}`
      : 'building';
    const progress = activeBuild.totalSteps
      ? ` \u00B7 step ${activeBuild.currentStepIndex ?? '?'}/${activeBuild.totalSteps}`
      : '';
    // Include startedAt or flowId in key so subsequent builds for the same feature get unique keys
    const buildId = activeBuild.flowId || activeBuild.startedAt || activeBuild.featureCode;
    entries.push({
      key: `build-${activeBuild.featureCode}-${buildId}`,
      type: activeBuild.status === 'complete' ? 'done' : 'build',
      label: `${activeBuild.featureCode} \u00B7 ${stepLabel}${progress}`,
      featureCode: activeBuild.featureCode,
    });
  }

  // Pending gate entries
  if (Array.isArray(gates)) {
    for (const gate of gates) {
      if (gate.status === 'pending') {
        // Build a readable label — stepId like "design_gate" already contains "gate"
        const stepLabel = gate.stepId
          ? gate.stepId.replace(/_/g, ' ')
          : gate.fromPhase || gate.toPhase || 'review';
        // Don't append "gate" if stepLabel already ends with it
        const label = stepLabel.toLowerCase().endsWith('gate')
          ? stepLabel
          : `${stepLabel} gate`;
        const featureCode = gate.featureCode || '';
        entries.push({
          key: `gate-${gate.id}`,
          type: 'gate',
          label: featureCode ? `${featureCode} ${label}` : label,
          featureCode,
          gateId: gate.id,
        });
      }
    }
  }

  // Iteration loop entries (COMP-UX-9)
  if (iterationStates) {
    for (const [loopId, iter] of iterationStates) {
      if (iter.status === 'running') {
        const typeLabel = iter.loopType === 'review' ? 'review' : 'coverage';
        entries.push({
          key: `iter-${loopId}`,
          type: 'iteration',
          label: `${typeLabel} ${iter.count}/${iter.maxIterations}`,
        });
      }
    }
  }

  // Recent error entries
  if (Array.isArray(recentErrors)) {
    for (const err of recentErrors) {
      const featureCode = err.featureCode || 'system';
      const summary = (err.message || err.errorType || 'error').substring(0, 60);
      entries.push({
        key: `error-${err.timestamp}-${summary.substring(0, 10)}`,
        type: 'error',
        label: `${featureCode} \u00B7 ${summary}`,
        featureCode,
        timestamp: err.timestamp,
      });
    }
  }

  return entries;
}

/**
 * Filter errors to last 60s, max 5.
 */
export function filterRecentErrors(agentErrors, now = Date.now()) {
  const cutoff = now - 60_000;
  return agentErrors
    .filter(e => new Date(e.timestamp).getTime() > cutoff)
    .slice(-5);
}
