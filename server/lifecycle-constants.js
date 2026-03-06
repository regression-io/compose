/**
 * lifecycle-constants.js — Shared constants for lifecycle and artifact modules.
 *
 * Extracted to break the circular dependency between lifecycle-manager.js
 * and artifact-manager.js (both need PHASE_ARTIFACTS).
 */

export const PHASES = [
  'explore_design', 'prd', 'architecture', 'blueprint',
  'verification', 'plan', 'execute', 'report', 'docs', 'ship',
];

export const TERMINAL = new Set(['complete', 'killed']);
export const SKIPPABLE = new Set(['prd', 'architecture', 'report']);

export const TRANSITIONS = {
  explore_design: ['prd', 'architecture', 'blueprint'],
  prd:            ['architecture', 'blueprint'],
  architecture:   ['blueprint'],
  blueprint:      ['verification'],
  verification:   ['plan', 'blueprint'],  // blueprint = revision loop
  plan:           ['execute'],
  execute:        ['report', 'docs'],
  report:         ['docs'],
  docs:           ['ship'],
  ship:           [],  // terminal via completeFeature()
};

export const PHASE_ARTIFACTS = {
  explore_design: 'design.md',
  prd:            'prd.md',
  architecture:   'architecture.md',
  blueprint:      'blueprint.md',
  plan:           'plan.md',
  report:         'report.md',
};
