/**
 * Shared constants for Compose CLI and frontend.
 *
 * Single canonical source for step/gate labels.
 * Importable by both CLI (lib/build.js, lib/new.js) and frontend (if bundled).
 */

/**
 * Canonical labels for lifecycle steps and gates.
 * Used in summary fallback chains and UI rendering.
 */
export const STEP_LABELS = {
  // Lifecycle steps
  explore_design: 'Design',
  prd: 'PRD',
  architecture: 'Architecture',
  blueprint: 'Blueprint',
  verification: 'Verification',
  plan: 'Plan',
  execute: 'Execute',
  report: 'Report',
  docs: 'Docs',
  ship: 'Ship',

  // Gate steps
  design_gate: 'Design Gate',
  prd_gate: 'PRD Gate',
  plan_gate: 'Plan Gate',
  architecture_gate: 'Architecture Gate',
  report_gate: 'Report Gate',
  ship_gate: 'Ship Gate',
};

/**
 * Map gate step IDs to their artifact filenames.
 * Used to derive artifact paths for gate enrichment.
 */
export const GATE_ARTIFACTS = {
  design_gate: 'design.md',
  prd_gate: 'prd.md',
  architecture_gate: 'architecture.md',
  plan_gate: 'plan.md',
  report_gate: 'report.md',
};

/**
 * Title-case a step ID for display when no label exists.
 * e.g. "some_step" -> "Some Step"
 */
export function titleCase(stepId) {
  if (!stepId) return 'Unknown';
  return stepId
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Build a human-readable summary for a gate step.
 * Fallback chain: response.summary -> STEP_LABELS + featureCode -> titleCase -> "Gate: stepId"
 */
export function buildGateSummary(stepId, featureCode, responseSummary) {
  if (responseSummary) return responseSummary;
  const label = STEP_LABELS[stepId];
  if (label && featureCode) return `${label} for ${featureCode}`;
  if (label) return label;
  const titled = titleCase(stepId);
  if (titled !== 'Unknown') return titled;
  return `Gate: ${stepId}`;
}
