/**
 * comp-ui-4.test.js — COMP-UI-4 view upgrade tests.
 *
 * Tests pure logic and constants integrity.
 * Dead view tests (BoardView, ItemListView, RoadmapView) removed in COMP-UI-6.
 *
 * All tests run with Node's built-in test runner — no browser/DOM required.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
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
