/**
 * opsStripLogic.js — Pure logic for OpsStrip, testable without React/JSX.
 */
import { GATE_STEP_LABELS } from '../vision/constants.js';

/**
 * Format elapsed ms as mm:ss.
 * @param {number} ms
 * @returns {string}
 */
function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Format a timeout in minutes as mm:ss.
 * @param {number} minutes
 * @returns {string}
 */
function formatTimeout(minutes) {
  const totalSec = Math.round(minutes * 60);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Derive ops entries from vision store state.
 */
export function deriveEntries({ activeBuild, gates, items, recentErrors, iterationStates, now = Date.now() }) {
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
      retries: activeBuild.retries ?? 0,
    });
  }

  // Pending gate entries
  if (Array.isArray(gates)) {
    for (const gate of gates) {
      if (gate.status === 'pending') {
        const stepLabel = GATE_STEP_LABELS[gate.stepId]
          ?? (gate.fromPhase || gate.toPhase || 'Gate');
        const item = Array.isArray(items) ? items.find(i => i.id === gate.itemId) : null;
        const name = item?.title || gate.featureCode || '';
        entries.push({
          key: `gate-${gate.id}`,
          type: 'gate',
          label: name ? `${stepLabel} — ${name}` : stepLabel,
          featureCode: gate.featureCode || '',
          gateId: gate.id,
        });
      }
    }
  }

  // Iteration loop entries (COMP-UX-9, COMP-OBS-SURFACE-4)
  if (iterationStates) {
    for (const [loopId, iter] of iterationStates) {
      if (iter.status === 'running') {
        const typeLabel = iter.loopType === 'review' ? 'review' : 'coverage';
        const countPart = `${iter.count}/${iter.maxIterations}`;

        // Budget counters: elapsed/timeout when wallClockTimeout is set
        let budgetPart = '';
        if (iter.wallClockTimeout != null && iter.startedAt) {
          const elapsedMs = now - new Date(iter.startedAt).getTime();
          budgetPart = `, ${formatElapsed(elapsedMs)}/${formatTimeout(iter.wallClockTimeout)}`;
        }

        entries.push({
          key: `iter-${loopId}`,
          type: 'iteration',
          label: `${typeLabel} ${countPart}${budgetPart}`,
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
