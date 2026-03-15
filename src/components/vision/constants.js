/**
 * Shared constants for Vision Tracker components.
 * Single source of truth for types, statuses, phases, and their colors.
 */

export const VALID_TYPES = ['feature', 'track', 'idea', 'decision', 'question', 'thread', 'artifact', 'task', 'spec', 'evaluation'];

export const TYPE_COLORS = {
  feature: '#3b82f6',     // blue — top-level container
  track: '#06b6d4',       // cyan — deliverable unit
  decision: '#22c55e',    // emerald — resolved decisions
  task: '#94a3b8',        // slate — work items
  spec: '#8b5cf6',        // violet — specifications
  idea: '#f59e0b',        // amber — ideas and proposals
  question: '#ec4899',    // pink — open questions
  evaluation: '#f97316',  // orange — assessments
  thread: '#64748b',      // dim slate — discussions
  artifact: '#a855f7',    // purple — documents
};

export const STATUS_COLORS = {
  planned: '#64748b',     // slate — not started
  ready: '#0ea5e9',       // sky — ready to pick up
  in_progress: '#3b82f6', // blue — actively working
  review: '#f59e0b',      // amber — needs review
  complete: '#22c55e',    // emerald — done
  blocked: '#ef4444',     // rose — blocked
  parked: '#475569',      // dim slate — on hold
  killed: '#1e293b',      // near-bg — cancelled
};

export const STATUSES = ['planned', 'ready', 'in_progress', 'review', 'complete', 'blocked', 'parked', 'killed'];

export const PHASES = ['vision', 'specification', 'planning', 'implementation', 'verification', 'release'];

export const PHASE_LABELS = {
  vision: 'Vision',
  specification: 'Specification',
  planning: 'Planning',
  implementation: 'Implementation',
  verification: 'Verification',
  release: 'Release',
};

export const CONFIDENCE_LABELS = ['Untested', 'Low', 'Moderate', 'High', 'Crystallized'];

// Lifecycle phases (from server/lifecycle-constants.js) — distinct from board-level PHASES above
export const LIFECYCLE_PHASE_LABELS = {
  explore_design: 'Design',
  prd:            'PRD',
  architecture:   'Architecture',
  blueprint:      'Blueprint',
  verification:   'Verification',
  plan:           'Plan',
  execute:        'Execute',
  report:         'Report',
  docs:           'Docs',
  ship:           'Ship',
  complete:       'Complete',
  killed:         'Killed',
};

export const LIFECYCLE_PHASE_ARTIFACTS = {
  explore_design: 'design.md',
  prd:            'prd.md',
  architecture:   'architecture.md',
  blueprint:      'blueprint.md',
  plan:           'plan.md',
  report:         'report.md',
};

// ── COMP-UI-4 additions ─────────────────────────────────────────────────────

export const AGENTS = ['claude', 'codex', 'gemini', 'human', 'unassigned'];

export const GATED_STATUSES = new Set(['complete']);

export const WORK_TYPE_COLORS = {
  building:  'bg-blue-500/10 text-blue-400',
  debugging: 'bg-rose-500/10 text-rose-400',
  testing:   'bg-amber-500/10 text-amber-400',
  exploring: 'bg-purple-500/10 text-purple-400',
  thinking:  'bg-cyan-500/10 text-cyan-400',
  reviewing: 'bg-emerald-500/10 text-emerald-400',
};

export const PIPELINE_STEPS = [
  { id: 'explore_design',      name: 'Explore Design',  agent: 'claude', phase: 'design',         hasGate: false },
  { id: 'design_review',       name: 'Design Review',   agent: 'codex',  phase: 'design',         hasGate: false },
  { id: 'design_gate',         name: 'Design Gate',     agent: 'human',  phase: 'design',         hasGate: true  },
  { id: 'prd',                 name: 'PRD',             agent: 'claude', phase: 'design',         hasGate: false },
  { id: 'prd_review',          name: 'PRD Review',      agent: 'codex',  phase: 'design',         hasGate: false },
  { id: 'prd_gate',            name: 'PRD Gate',        agent: 'human',  phase: 'design',         hasGate: true  },
  { id: 'architecture',        name: 'Architecture',    agent: 'claude', phase: 'design',         hasGate: false },
  { id: 'architecture_review', name: 'Arch Review',     agent: 'codex',  phase: 'design',         hasGate: false },
  { id: 'architecture_gate',   name: 'Arch Gate',       agent: 'human',  phase: 'design',         hasGate: true  },
  { id: 'blueprint',           name: 'Blueprint',       agent: 'claude', phase: 'blueprint',      hasGate: false },
  { id: 'verification',        name: 'Verification',    agent: 'claude', phase: 'blueprint',      hasGate: false },
  { id: 'blueprint_review',    name: 'BP Review',       agent: 'codex',  phase: 'blueprint',      hasGate: false },
  { id: 'plan',                name: 'Plan',            agent: 'claude', phase: 'implementation', hasGate: false },
  { id: 'plan_review',         name: 'Plan Review',     agent: 'codex',  phase: 'implementation', hasGate: false },
  { id: 'plan_gate',           name: 'Plan Gate',       agent: 'human',  phase: 'implementation', hasGate: true  },
  { id: 'execute',             name: 'Execute',         agent: 'claude', phase: 'implementation', hasGate: false },
  { id: 'review',              name: 'Review Loop',     agent: 'codex',  phase: 'implementation', hasGate: false },
  { id: 'coverage',            name: 'Coverage Sweep',  agent: 'claude', phase: 'implementation', hasGate: false },
  { id: 'report',              name: 'Report',          agent: 'claude', phase: 'ship',           hasGate: false },
  { id: 'report_review',       name: 'Report Review',   agent: 'codex',  phase: 'ship',           hasGate: false },
  { id: 'report_gate',         name: 'Report Gate',     agent: 'human',  phase: 'ship',           hasGate: true  },
  { id: 'docs',                name: 'Docs',            agent: 'claude', phase: 'ship',           hasGate: false },
  { id: 'ship',                name: 'Ship',            agent: 'claude', phase: 'ship',           hasGate: false },
  { id: 'ship_gate',           name: 'Ship Gate',       agent: 'human',  phase: 'ship',           hasGate: true  },
];

export const PIPELINE_PHASE_CONFIG = {
  design:         { label: 'Phase 1: Design',      color: 'border-blue-500/30 bg-blue-500/5'      },
  blueprint:      { label: 'Phase 2: Blueprint',   color: 'border-violet-500/30 bg-violet-500/5'  },
  implementation: { label: 'Phase 3: Implement',   color: 'border-amber-500/30 bg-amber-500/5'    },
  ship:           { label: 'Phase 4: Ship',        color: 'border-emerald-500/30 bg-emerald-500/5'},
};
