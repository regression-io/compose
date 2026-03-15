/**
 * comp-ui-4.test.js — COMP-UI-4 view upgrade tests.
 *
 * Tests pure logic extracted from all six upgraded views:
 *   BoardView      — gate-aware drag guard
 *   ItemListView   — filter, sort, group
 *   RoadmapView    — tree helpers (getChildren, countDescendants, rollupStatus)
 *   SessionsView   — session filter + sort
 *   PipelineView   — pipeline step structure integrity (via constants)
 *   GraphView      — (behavior tested via constants; Cytoscape requires DOM)
 *
 * All tests run with Node's built-in test runner — no browser/DOM required.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isGateBlocked,
  filterItems,
  sortItems,
  groupItems,
  groupLabel,
  getChildren,
  countDescendants,
  rollupStatus,
  filterSessions,
} from '../src/components/vision/vision-logic.js';

import {
  PIPELINE_STEPS,
  PIPELINE_PHASE_CONFIG,
  GATED_STATUSES,
  AGENTS,
  WORK_TYPE_COLORS,
  STATUSES,
  PHASES,
} from '../src/components/vision/constants.js';

// ─── Constants integrity ─────────────────────────────────────────────────────

describe('Constants', () => {
  it('GATED_STATUSES contains complete', () => {
    assert.ok(GATED_STATUSES.has('complete'));
  });

  it('AGENTS includes claude, codex, gemini, human, unassigned', () => {
    for (const a of ['claude', 'codex', 'gemini', 'human', 'unassigned']) {
      assert.ok(AGENTS.includes(a), `AGENTS should include ${a}`);
    }
  });

  it('WORK_TYPE_COLORS has six work types', () => {
    const types = ['building', 'debugging', 'testing', 'exploring', 'thinking', 'reviewing'];
    for (const t of types) {
      assert.ok(WORK_TYPE_COLORS[t], `WORK_TYPE_COLORS should include ${t}`);
    }
  });

  it('PIPELINE_STEPS has 24 steps', () => {
    assert.equal(PIPELINE_STEPS.length, 24);
  });

  it('PIPELINE_STEPS covers exactly four phases', () => {
    const phases = new Set(PIPELINE_STEPS.map(s => s.phase));
    assert.deepEqual([...phases].sort(), ['blueprint', 'design', 'implementation', 'ship']);
  });

  it('every PIPELINE_STEP has required fields', () => {
    for (const step of PIPELINE_STEPS) {
      assert.ok(step.id,          `step ${step.id}: missing id`);
      assert.ok(step.name,        `step ${step.id}: missing name`);
      assert.ok(step.agent,       `step ${step.id}: missing agent`);
      assert.ok(step.phase,       `step ${step.id}: missing phase`);
      assert.equal(typeof step.hasGate, 'boolean', `step ${step.id}: hasGate must be boolean`);
    }
  });

  it('gate steps have agent=human', () => {
    const gateSteps = PIPELINE_STEPS.filter(s => s.hasGate);
    assert.ok(gateSteps.length > 0, 'there should be gate steps');
    for (const s of gateSteps) {
      assert.equal(s.agent, 'human', `gate step ${s.id} should have agent=human`);
    }
  });

  it('PIPELINE_PHASE_CONFIG keys match pipeline phases', () => {
    const phases = new Set(PIPELINE_STEPS.map(s => s.phase));
    for (const phase of phases) {
      assert.ok(PIPELINE_PHASE_CONFIG[phase], `PIPELINE_PHASE_CONFIG missing phase: ${phase}`);
    }
  });

  it('each phase config has label and color', () => {
    for (const [phase, cfg] of Object.entries(PIPELINE_PHASE_CONFIG)) {
      assert.ok(cfg.label, `${phase} config missing label`);
      assert.ok(cfg.color, `${phase} config missing color`);
    }
  });
});

// ─── BoardView: isGateBlocked ────────────────────────────────────────────────

describe('isGateBlocked', () => {
  const gated = new Set(['complete']);

  it('blocks move to gated status when pending gate exists for item', () => {
    const gates = [{ itemId: 'item-1', status: 'pending' }];
    assert.equal(isGateBlocked('item-1', 'complete', gated, gates), true);
  });

  it('allows move to gated status when no gate exists', () => {
    assert.equal(isGateBlocked('item-2', 'complete', gated, []), false);
  });

  it('allows move to gated status when gate is resolved', () => {
    const gates = [{ itemId: 'item-1', status: 'resolved' }];
    assert.equal(isGateBlocked('item-1', 'complete', gated, gates), false);
  });

  it('allows move to non-gated status even with pending gate', () => {
    const gates = [{ itemId: 'item-1', status: 'pending' }];
    assert.equal(isGateBlocked('item-1', 'in_progress', gated, gates), false);
  });

  it('only blocks the specific item — other items are not blocked', () => {
    const gates = [{ itemId: 'item-1', status: 'pending' }];
    assert.equal(isGateBlocked('item-2', 'complete', gated, gates), false);
  });

  it('handles undefined gates gracefully', () => {
    assert.equal(isGateBlocked('item-1', 'complete', gated, undefined), false);
  });
});

// ─── ItemListView: filterItems ───────────────────────────────────────────────

describe('filterItems', () => {
  const items = [
    { id: '1', title: 'Alpha Feature', status: 'planned',     phase: 'vision',         type: 'feature', assigned_to: 'claude'      },
    { id: '2', title: 'Beta Task',     status: 'in_progress', phase: 'implementation', type: 'task',    assigned_to: 'codex'       },
    { id: '3', title: 'Gamma Spec',    status: 'complete',    phase: 'planning',       type: 'spec',    assigned_to: 'unassigned'  },
    { id: '4', title: 'Delta Idea',    status: 'blocked',     phase: 'vision',         type: 'idea',    assigned_to: 'claude'      },
    { id: '5', title: 'Epsilon',       status: 'planned',     phase: 'implementation', type: 'task',    assigned_to: 'gemini'      },
  ];

  it('returns all items when no filters', () => {
    assert.equal(filterItems(items).length, 5);
  });

  it('filters by search term (title match)', () => {
    const result = filterItems(items, { search: 'beta' });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, '2');
  });

  it('filters by status', () => {
    const result = filterItems(items, { statusFilter: 'planned' });
    assert.equal(result.length, 2);
    assert.ok(result.every(i => i.status === 'planned'));
  });

  it('filters by phase', () => {
    const result = filterItems(items, { phaseFilter: 'vision' });
    assert.equal(result.length, 2);
    assert.ok(result.every(i => i.phase === 'vision'));
  });

  it('filters by type', () => {
    const result = filterItems(items, { typeFilter: 'task' });
    assert.equal(result.length, 2);
    assert.ok(result.every(i => i.type === 'task'));
  });

  it('filters by agent', () => {
    const result = filterItems(items, { agentFilter: 'claude' });
    assert.equal(result.length, 2);
    assert.ok(result.every(i => i.assigned_to === 'claude'));
  });

  it('filters unassigned items', () => {
    const result = filterItems(items, { agentFilter: 'unassigned' });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, '3');
  });

  it('combines multiple filters', () => {
    const result = filterItems(items, { phaseFilter: 'implementation', typeFilter: 'task' });
    assert.equal(result.length, 2);
  });

  it('returns empty array when nothing matches', () => {
    const result = filterItems(items, { search: 'nonexistent_xyz' });
    assert.equal(result.length, 0);
  });

  it('search is case-insensitive', () => {
    const result = filterItems(items, { search: 'ALPHA' });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, '1');
  });
});

// ─── ItemListView: sortItems ─────────────────────────────────────────────────

describe('sortItems', () => {
  const items = [
    { id: 'a', title: 'Zebra',   confidence: 3, status: 'in_progress', updatedAt: '2024-01-10T00:00:00Z' },
    { id: 'b', title: 'Apple',   confidence: 1, status: 'planned',     updatedAt: '2024-01-12T00:00:00Z' },
    { id: 'c', title: 'Mango',   confidence: 4, status: 'complete',    updatedAt: '2024-01-08T00:00:00Z' },
    { id: 'd', title: 'Banana',  confidence: 0, status: 'blocked',     updatedAt: '2024-01-15T00:00:00Z' },
  ];

  it('sorts by confidence ascending (default)', () => {
    const result = sortItems(items, 'confidence');
    assert.equal(result[0].id, 'd'); // confidence 0
    assert.equal(result[result.length - 1].id, 'c'); // confidence 4
  });

  it('sorts by alpha (title A-Z)', () => {
    const result = sortItems(items, 'alpha');
    assert.equal(result[0].title, 'Apple');
    assert.equal(result[result.length - 1].title, 'Zebra');
  });

  it('sorts by updated (most recent first)', () => {
    const result = sortItems(items, 'updated');
    assert.equal(result[0].id, 'd'); // 2024-01-15
    assert.equal(result[result.length - 1].id, 'c'); // 2024-01-08
  });

  it('sorts by status (canonical STATUSES order)', () => {
    const result = sortItems(items, 'status');
    // planned (idx 0), in_progress (idx 2), complete (idx 4), blocked (idx 5)
    const statusOrder = result.map(i => i.status);
    assert.equal(statusOrder[0], 'planned');
  });

  it('does not mutate original array', () => {
    const original = [...items];
    sortItems(items, 'alpha');
    assert.deepEqual(items, original);
  });
});

// ─── ItemListView: groupItems / groupLabel ───────────────────────────────────

describe('groupItems', () => {
  const items = [
    { id: '1', phase: 'vision',  type: 'feature', status: 'planned'     },
    { id: '2', phase: 'vision',  type: 'task',    status: 'in_progress' },
    { id: '3', phase: 'planning',type: 'task',    status: 'planned'     },
    { id: '4', phase: 'release', type: 'feature', status: 'complete'    },
  ];

  it('groups by phase — all PHASES keys present', () => {
    const groups = groupItems(items, 'phase');
    for (const p of PHASES) {
      assert.ok(groups.has(p), `phase group '${p}' should exist`);
    }
  });

  it('groups by phase — items in correct bucket', () => {
    const groups = groupItems(items, 'phase');
    assert.equal(groups.get('vision').length, 2);
    assert.equal(groups.get('planning').length, 1);
  });

  it('groups by type — task bucket has 2', () => {
    const groups = groupItems(items, 'type');
    assert.equal(groups.get('task').length, 2);
    assert.equal(groups.get('feature').length, 2);
  });

  it('groups by status — in_progress bucket has 1', () => {
    const groups = groupItems(items, 'status');
    assert.equal(groups.get('in_progress').length, 1);
    assert.equal(groups.get('complete').length, 1);
  });

  it('groups by none — single "all" bucket with all items', () => {
    const groups = groupItems(items, 'none');
    assert.ok(groups.has('all'));
    assert.equal(groups.get('all').length, 4);
  });
});

describe('groupLabel', () => {
  it('phase: returns PHASE_LABELS value', () => {
    assert.equal(groupLabel('phase', 'vision'), 'Vision');
    assert.equal(groupLabel('phase', 'implementation'), 'Implementation');
  });

  it('type: capitalizes key', () => {
    assert.equal(groupLabel('type', 'feature'), 'Feature');
    assert.equal(groupLabel('type', 'task'), 'Task');
  });

  it('status: humanizes snake_case', () => {
    assert.equal(groupLabel('status', 'in_progress'), 'In Progress');
  });

  it('none: returns "All Items"', () => {
    assert.equal(groupLabel('none', 'all'), 'All Items');
  });
});

// ─── RoadmapView: getChildren ────────────────────────────────────────────────

describe('getChildren', () => {
  const items = [
    { id: 'parent',  title: 'Parent',   parentId: null    },
    { id: 'child-1', title: 'Child 1',  parentId: 'parent'},
    { id: 'child-2', title: 'Child 2',  parentId: 'parent'},
    { id: 'other',   title: 'Other',    parentId: null    },
    { id: 'conn-child', title: 'Conn',  parentId: null    },
  ];
  const connections = [
    { id: 'c1', fromId: 'conn-child', toId: 'parent', type: 'implements' },
    { id: 'c2', fromId: 'other', toId: 'parent', type: 'informs' }, // not a child edge type
  ];

  it('finds children via parentId field', () => {
    const children = getChildren('parent', items, []);
    const ids = children.map(c => c.id);
    assert.ok(ids.includes('child-1'));
    assert.ok(ids.includes('child-2'));
  });

  it('finds children via implements connection', () => {
    const children = getChildren('parent', items, connections);
    const ids = children.map(c => c.id);
    assert.ok(ids.includes('conn-child'));
  });

  it('does not include items connected with non-child edge types', () => {
    const children = getChildren('parent', items, connections);
    const ids = children.map(c => c.id);
    assert.ok(!ids.includes('other'));
  });

  it('returns empty array for item with no children', () => {
    const children = getChildren('other', items, connections);
    assert.equal(children.length, 0);
  });

  it('deduplicates when item has both parentId and connection', () => {
    const dupeItems = [
      { id: 'parent',  parentId: null    },
      { id: 'child',   parentId: 'parent'},
    ];
    const dupeConns = [
      { id: 'c1', fromId: 'child', toId: 'parent', type: 'implements' },
    ];
    const children = getChildren('parent', dupeItems, dupeConns);
    assert.equal(children.length, 1);
  });
});

// ─── RoadmapView: countDescendants ──────────────────────────────────────────

describe('countDescendants', () => {
  const items = [
    { id: 'feat',    parentId: null,   status: 'in_progress' },
    { id: 'track-1', parentId: 'feat', status: 'complete'    },
    { id: 'track-2', parentId: 'feat', status: 'planned'     },
    { id: 'task-1',  parentId: 'track-1', status: 'complete' },
    { id: 'task-2',  parentId: 'track-1', status: 'complete' },
  ];
  const connections = [];

  it('counts direct children', () => {
    const { total, done } = countDescendants('feat', items, connections);
    assert.equal(total, 4); // track-1, track-2, task-1, task-2
    assert.equal(done, 3);  // track-1, task-1, task-2
  });

  it('returns { total: 0, done: 0 } for leaf node', () => {
    const { total, done } = countDescendants('task-1', items, connections);
    assert.equal(total, 0);
    assert.equal(done, 0);
  });

  it('handles cycle guard — does not infinite-loop on circular refs', () => {
    const cycleItems = [
      { id: 'A', parentId: 'B', status: 'planned' },
      { id: 'B', parentId: 'A', status: 'planned' },
    ];
    // Should complete without hanging
    const result = countDescendants('A', cycleItems, []);
    assert.ok(result.total >= 0);
  });
});

// ─── RoadmapView: rollupStatus ───────────────────────────────────────────────

describe('rollupStatus', () => {
  it('returns "planned" for empty array', () => {
    assert.equal(rollupStatus([]), 'planned');
  });

  it('returns "complete" when all items are complete', () => {
    const items = [
      { status: 'complete' },
      { status: 'complete' },
    ];
    assert.equal(rollupStatus(items), 'complete');
  });

  it('returns "complete" when all items are approved', () => {
    assert.equal(rollupStatus([{ status: 'approved' }, { status: 'approved' }]), 'complete');
  });

  it('returns "in_progress" when any item is in_progress', () => {
    const items = [{ status: 'planned' }, { status: 'in_progress' }];
    assert.equal(rollupStatus(items), 'in_progress');
  });

  it('returns "in_progress" when mix of complete + planned', () => {
    const items = [{ status: 'complete' }, { status: 'planned' }];
    assert.equal(rollupStatus(items), 'in_progress');
  });

  it('returns "planned" when all items are planned', () => {
    const items = [{ status: 'planned' }, { status: 'planned' }];
    assert.equal(rollupStatus(items), 'planned');
  });

  it('treats review as active (returns in_progress)', () => {
    const items = [{ status: 'planned' }, { status: 'review' }];
    assert.equal(rollupStatus(items), 'in_progress');
  });

  it('treats ready as active (returns in_progress)', () => {
    const items = [{ status: 'planned' }, { status: 'ready' }];
    assert.equal(rollupStatus(items), 'in_progress');
  });
});

// ─── SessionsView: filterSessions ───────────────────────────────────────────

describe('filterSessions', () => {
  const now = Date.now();
  const sessions = [
    { id: 's1', agent: 'claude', status: 'active',    featureCode: 'FEAT-1', summary: 'building auth',   startedAt: new Date(now - 1000).toISOString()  },
    { id: 's2', agent: 'codex',  status: 'completed', featureCode: 'FEAT-2', summary: 'reviewing tests', startedAt: new Date(now - 5000).toISOString()  },
    { id: 's3', agent: 'claude', status: 'failed',    featureCode: 'FEAT-3', summary: 'exploring api',   startedAt: new Date(now - 3000).toISOString()  },
    { id: 's4', agent: 'gemini', status: 'active',    featureCode: 'FEAT-4', summary: 'designing flow',  startedAt: new Date(now - 500).toISOString()   },
  ];

  it('returns all sessions with no filters', () => {
    assert.equal(filterSessions(sessions).length, 4);
  });

  it('sorts active sessions first', () => {
    const result = filterSessions(sessions);
    assert.equal(result[0].status, 'active');
    assert.equal(result[1].status, 'active');
  });

  it('filters by agent', () => {
    const result = filterSessions(sessions, { agentFilter: 'claude' });
    assert.equal(result.length, 2);
    assert.ok(result.every(s => s.agent === 'claude'));
  });

  it('filters by status', () => {
    const result = filterSessions(sessions, { statusFilter: 'active' });
    assert.equal(result.length, 2);
    assert.ok(result.every(s => s.status === 'active'));
  });

  it('filters by search — matches featureCode', () => {
    const result = filterSessions(sessions, { search: 'FEAT-2' });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 's2');
  });

  it('filters by search — matches summary', () => {
    const result = filterSessions(sessions, { search: 'auth' });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 's1');
  });

  it('filters by search — matches agent', () => {
    const result = filterSessions(sessions, { search: 'gemini' });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 's4');
  });

  it('search is case-insensitive', () => {
    const result = filterSessions(sessions, { search: 'BUILDING' });
    assert.equal(result.length, 1);
  });

  it('returns empty when nothing matches', () => {
    const result = filterSessions(sessions, { search: 'nonexistent_xyz' });
    assert.equal(result.length, 0);
  });

  it('does not mutate input array', () => {
    const copy = [...sessions];
    filterSessions(sessions, { statusFilter: 'active' });
    assert.deepEqual(sessions, copy);
  });
});
