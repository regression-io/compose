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

// ── COMP-UI-6: Consolidated color tokens ─────────────────────────────────────

/** Tool category colors — HSL strings for inline style (from MessageCard) */
export const TOOL_CATEGORY_COLORS = {
  reading:   'hsl(210 70% 60%)',
  writing:   'hsl(142 60% 50%)',
  executing: 'hsl(38 90% 60%)',
  searching: 'hsl(270 60% 65%)',
  fetching:  'hsl(190 70% 55%)',
  delegating:'hsl(330 60% 65%)',
  thinking:  'hsl(240 30% 70%)',
};

/** Pipeline dot status colors — CSS var refs (from ContextPipelineDots) */
export const PIPELINE_STATUS_COLORS = {
  complete: 'hsl(var(--success, 160 60% 45%))',
  active: 'hsl(var(--accent))',
  failed: 'hsl(var(--destructive))',
  pending: 'hsl(var(--muted-foreground) / 0.3)',
};

/** Template category colors — Tailwind class strings (from TemplateSelector) */
export const TEMPLATE_CATEGORY_COLORS = {
  development:    'border-blue-500/30 bg-blue-500/5 text-blue-400',
  quality:        'border-emerald-500/30 bg-emerald-500/5 text-emerald-400',
  maintenance:    'border-amber-500/30 bg-amber-500/5 text-amber-400',
  documentation:  'border-violet-500/30 bg-violet-500/5 text-violet-400',
  exploration:    'border-cyan-500/30 bg-cyan-500/5 text-cyan-400',
};

/** Gate notification colors by fromPhase — Tailwind class objects (from GateNotificationBar) */
export const GATE_COLORS = {
  explore_design:  { bg: 'bg-blue-500/5',      border: 'border-blue-500/40',    text: 'text-blue-300'    },
  prd:             { bg: 'bg-purple-500/5',    border: 'border-purple-500/40',  text: 'text-purple-300'  },
  architecture:    { bg: 'bg-cyan-500/5',      border: 'border-cyan-500/40',    text: 'text-cyan-300'    },
  blueprint:       { bg: 'bg-violet-500/5',    border: 'border-violet-500/40',  text: 'text-violet-300'  },
  plan:            { bg: 'bg-amber-500/5',     border: 'border-amber-500/40',   text: 'text-amber-300'   },
  report:          { bg: 'bg-emerald-500/5',   border: 'border-emerald-500/40', text: 'text-emerald-300' },
  ship:            { bg: 'bg-green-500/5',     border: 'border-green-500/40',   text: 'text-green-300'   },
};

export const GATE_FALLBACK_COLOR = { bg: 'bg-muted/30', border: 'border-border', text: 'text-muted-foreground' };

/** Confidence bar colors — Tailwind class strings, indexed 0–4 (from ConfidenceBar) */
// colors[0] = bg-slate-600 (verification correction — NOT bg-slate-800 as in blueprint §2.4 typo)
export const CONFIDENCE_COLORS = ['bg-slate-600', 'bg-rose-500', 'bg-amber-500', 'bg-emerald-500', 'bg-emerald-500'];

/** Timeline event severity colors — Tailwind class strings (from TimelineEvent) */
export const SEVERITY_COLORS = {
  info: 'text-zinc-400',
  success: 'text-emerald-400',
  warning: 'text-amber-400',
  error: 'text-red-400',
};

/** Timeline event category colors — Tailwind class strings (from TimelineEvent) */
export const TIMELINE_CATEGORY_COLORS = {
  phase: 'text-blue-400',
  gate: 'text-purple-400',
  session: 'text-zinc-400',
  iteration: 'text-blue-300',
  error: 'text-red-400',
};

/** Session status colors — Tailwind class strings (from SessionsView) */
export const SESSION_STATUS_COLORS = {
  active:    'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  completed: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
  failed:    'bg-red-500/10 text-red-400 border-red-500/20',
  paused:    'bg-amber-500/10 text-amber-400 border-amber-500/20',
};

/** Session agent colors — Tailwind class strings (from SessionsView) */
export const SESSION_AGENT_COLORS = {
  claude:  'bg-orange-500/15 text-orange-400',
  codex:   'bg-emerald-500/15 text-emerald-400',
  gemini:  'bg-blue-500/15 text-blue-400',
  human:   'bg-slate-500/15 text-slate-400',
};

/** Build state colors — hex for Cytoscape (from graphOpsOverlays) */
export const BUILD_STATE_COLORS = {
  building: '#3b82f6',           // blue-500
  gate_pending: '#f59e0b',       // amber-500
  blocked_downstream: '#94a3b8', // slate-400
  error: '#ef4444',              // red-500
};

/** Graph agent colors — hex for Cytoscape (from graphOpsOverlays) */
export const GRAPH_AGENT_COLORS = {
  'compose-explorer': '#06b6d4',
  'compose-architect': '#a855f7',
  codex: '#10b981',
  claude: '#3b82f6',
};

/** Agent panel category colors — CSS var refs (from AgentPanel) */
export const AGENT_CATEGORY_COLORS = {
  reading: 'var(--color-category-reading)',
  writing: 'var(--color-category-writing)',
  executing: 'var(--color-category-executing)',
  searching: 'var(--color-category-searching)',
  fetching: 'var(--color-category-fetching)',
  delegating: 'var(--color-category-delegating)',
  thinking: 'hsl(var(--muted-foreground))',
};
