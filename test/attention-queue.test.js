/**
 * attention-queue.test.js
 *
 * TDD tests for COMP-UI-2: Attention-queue sidebar logic.
 * Tests cover the pure-logic module that backs the new AttentionQueueSidebar:
 *   - attentionQueueState.js — attention queue computation, build progress,
 *                              compact stats, and phase-filter helpers
 *
 * Tests use node:test (the project's existing test runner).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// These imports FAIL until the module is created (red phase).
import {
  computeAttentionQueue,
  buildProgress,
  compactStats,
  togglePhase,
  ATTENTION_PRIORITY,
} from '../src/components/vision/attentionQueueState.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeItem(overrides = {}) {
  return {
    id: overrides.id || 'item-1',
    type: overrides.type || 'task',
    title: overrides.title || 'Test Item',
    status: overrides.status || 'planned',
    phase: overrides.phase || null,
    confidence: overrides.confidence ?? 2,
    ...overrides,
  };
}

function makeGate(overrides = {}) {
  return {
    id: overrides.id || 'gate-1',
    itemId: overrides.itemId || 'item-1',
    status: overrides.status || 'pending',
    fromPhase: overrides.fromPhase || 'plan',
    toPhase: overrides.toPhase || 'execute',
    createdAt: overrides.createdAt || new Date().toISOString(),
    ...overrides,
  };
}

function makeActiveBuild(overrides = {}) {
  return {
    featureCode: overrides.featureCode || 'TEST-1',
    currentStepId: overrides.currentStepId || 'execute',
    stepNum: overrides.stepNum ?? 3,
    totalSteps: overrides.totalSteps ?? 10,
    status: overrides.status || 'running',
    startedAt: overrides.startedAt || new Date().toISOString(),
    retries: overrides.retries ?? 0,
    violations: overrides.violations || [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ATTENTION_PRIORITY constants
// ---------------------------------------------------------------------------

describe('attentionQueueState — ATTENTION_PRIORITY', () => {
  it('exports BLOCKED as the highest numeric priority', () => {
    assert.ok(typeof ATTENTION_PRIORITY.BLOCKED === 'number');
    assert.ok(ATTENTION_PRIORITY.BLOCKED > ATTENTION_PRIORITY.PENDING_GATE);
    assert.ok(ATTENTION_PRIORITY.BLOCKED > ATTENTION_PRIORITY.DECISION);
  });

  it('exports PENDING_GATE as higher than DECISION', () => {
    assert.ok(ATTENTION_PRIORITY.PENDING_GATE > ATTENTION_PRIORITY.DECISION);
  });

  it('exports DECISION as a positive number', () => {
    assert.ok(ATTENTION_PRIORITY.DECISION > 0);
  });
});

// ---------------------------------------------------------------------------
// computeAttentionQueue
// ---------------------------------------------------------------------------

describe('computeAttentionQueue — empty inputs', () => {
  it('returns an empty array for empty items and gates', () => {
    const result = computeAttentionQueue([], []);
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 0);
  });

  it('returns empty for items with no attention-worthy status', () => {
    const items = [
      makeItem({ status: 'planned' }),
      makeItem({ id: 'item-2', status: 'complete' }),
      makeItem({ id: 'item-3', status: 'in_progress' }),
    ];
    const result = computeAttentionQueue(items, []);
    assert.equal(result.length, 0);
  });
});

describe('computeAttentionQueue — blocked items', () => {
  it('includes blocked items with BLOCKED priority', () => {
    const item = makeItem({ id: 'b1', status: 'blocked' });
    const result = computeAttentionQueue([item], []);
    assert.equal(result.length, 1);
    assert.equal(result[0].item.id, 'b1');
    assert.equal(result[0].priority, ATTENTION_PRIORITY.BLOCKED);
  });

  it('includes reason for blocked items', () => {
    const item = makeItem({ status: 'blocked' });
    const result = computeAttentionQueue([item], []);
    assert.ok(typeof result[0].reason === 'string');
    assert.ok(result[0].reason.length > 0);
  });
});

describe('computeAttentionQueue — unresolved decisions', () => {
  it('includes pending decisions with DECISION priority', () => {
    const item = makeItem({ id: 'd1', type: 'decision', status: 'planned' });
    const result = computeAttentionQueue([item], []);
    assert.equal(result.length, 1);
    assert.equal(result[0].item.id, 'd1');
    assert.equal(result[0].priority, ATTENTION_PRIORITY.DECISION);
  });

  it('excludes complete decisions', () => {
    const item = makeItem({ type: 'decision', status: 'complete' });
    const result = computeAttentionQueue([item], []);
    assert.equal(result.length, 0);
  });

  it('excludes killed decisions', () => {
    const item = makeItem({ type: 'decision', status: 'killed' });
    const result = computeAttentionQueue([item], []);
    assert.equal(result.length, 0);
  });

  it('excludes parked decisions', () => {
    const item = makeItem({ type: 'decision', status: 'parked' });
    const result = computeAttentionQueue([item], []);
    assert.equal(result.length, 0);
  });
});

describe('computeAttentionQueue — pending gates', () => {
  it('includes items with pending gates at PENDING_GATE priority', () => {
    const item = makeItem({ id: 'g1', status: 'in_progress' });
    const gate = makeGate({ itemId: 'g1', status: 'pending' });
    const result = computeAttentionQueue([item], [gate]);
    assert.equal(result.length, 1);
    assert.equal(result[0].item.id, 'g1');
    assert.equal(result[0].priority, ATTENTION_PRIORITY.PENDING_GATE);
  });

  it('does not duplicate items that are both blocked and have pending gates', () => {
    const item = makeItem({ id: 'combo', status: 'blocked' });
    const gate = makeGate({ itemId: 'combo', status: 'pending' });
    const result = computeAttentionQueue([item], [gate]);
    // Should appear once, with highest priority (BLOCKED)
    assert.equal(result.length, 1);
    assert.equal(result[0].priority, ATTENTION_PRIORITY.BLOCKED);
  });

  it('ignores resolved gates', () => {
    const item = makeItem({ id: 'r1', status: 'in_progress' });
    const gate = makeGate({ itemId: 'r1', status: 'resolved' });
    const result = computeAttentionQueue([item], [gate]);
    assert.equal(result.length, 0);
  });
});

describe('computeAttentionQueue — sort order', () => {
  it('sorts blocked before pending_gate before decision', () => {
    const blocked = makeItem({ id: 'a', status: 'blocked' });
    const decision = makeItem({ id: 'b', type: 'decision', status: 'planned' });
    const gateItem = makeItem({ id: 'c', status: 'in_progress' });
    const gate = makeGate({ itemId: 'c', status: 'pending' });

    const result = computeAttentionQueue([decision, gateItem, blocked], [gate]);
    assert.equal(result.length, 3);
    assert.equal(result[0].priority, ATTENTION_PRIORITY.BLOCKED);
    assert.equal(result[1].priority, ATTENTION_PRIORITY.PENDING_GATE);
    assert.equal(result[2].priority, ATTENTION_PRIORITY.DECISION);
  });
});

// ---------------------------------------------------------------------------
// buildProgress
// ---------------------------------------------------------------------------

describe('buildProgress — null / no build', () => {
  it('returns isRunning=false for null activeBuild', () => {
    const result = buildProgress(null);
    assert.equal(result.isRunning, false);
    assert.equal(result.pct, 0);
  });

  it('returns isRunning=false for undefined activeBuild', () => {
    const result = buildProgress(undefined);
    assert.equal(result.isRunning, false);
  });
});

describe('buildProgress — running build', () => {
  it('returns isRunning=true for status=running', () => {
    const build = makeActiveBuild({ status: 'running' });
    const result = buildProgress(build);
    assert.equal(result.isRunning, true);
  });

  it('computes pct as stepNum/totalSteps * 100', () => {
    const build = makeActiveBuild({ stepNum: 5, totalSteps: 10 });
    const result = buildProgress(build);
    assert.equal(result.pct, 50);
  });

  it('clamps pct to 0-100', () => {
    const over = makeActiveBuild({ stepNum: 15, totalSteps: 10 });
    assert.equal(buildProgress(over).pct, 100);

    const negative = makeActiveBuild({ stepNum: -1, totalSteps: 10 });
    assert.equal(buildProgress(negative).pct, 0);
  });

  it('returns stepLabel from currentStepId', () => {
    const build = makeActiveBuild({ currentStepId: 'execute' });
    const result = buildProgress(build);
    assert.ok(typeof result.stepLabel === 'string');
    assert.ok(result.stepLabel.length > 0);
  });

  it('returns featureCode', () => {
    const build = makeActiveBuild({ featureCode: 'FEAT-42' });
    const result = buildProgress(build);
    assert.equal(result.featureCode, 'FEAT-42');
  });

  it('returns stepNum and totalSteps', () => {
    const build = makeActiveBuild({ stepNum: 3, totalSteps: 15 });
    const result = buildProgress(build);
    assert.equal(result.stepNum, 3);
    assert.equal(result.totalSteps, 15);
  });
});

describe('buildProgress — non-running build', () => {
  it('returns isRunning=false for status=complete', () => {
    const build = makeActiveBuild({ status: 'complete' });
    const result = buildProgress(build);
    assert.equal(result.isRunning, false);
  });

  it('returns isRunning=false for status=failed', () => {
    const build = makeActiveBuild({ status: 'failed' });
    const result = buildProgress(build);
    assert.equal(result.isRunning, false);
  });
});

// ---------------------------------------------------------------------------
// compactStats
// ---------------------------------------------------------------------------

describe('compactStats — empty', () => {
  it('returns zero counts for empty inputs', () => {
    const result = compactStats([], []);
    assert.equal(result.total, 0);
    assert.equal(result.inProgress, 0);
    assert.equal(result.blocked, 0);
    assert.equal(result.pendingGates, 0);
    assert.equal(result.attentionCount, 0);
  });
});

describe('compactStats — item counts', () => {
  it('counts total items', () => {
    const items = [makeItem(), makeItem({ id: '2' }), makeItem({ id: '3' })];
    assert.equal(compactStats(items, []).total, 3);
  });

  it('counts in_progress items', () => {
    const items = [
      makeItem({ status: 'in_progress' }),
      makeItem({ id: '2', status: 'in_progress' }),
      makeItem({ id: '3', status: 'planned' }),
    ];
    assert.equal(compactStats(items, []).inProgress, 2);
  });

  it('counts blocked items', () => {
    const items = [
      makeItem({ status: 'blocked' }),
      makeItem({ id: '2', status: 'in_progress' }),
    ];
    assert.equal(compactStats(items, []).blocked, 1);
  });
});

describe('compactStats — gate and attention counts', () => {
  it('counts pending gates', () => {
    const gates = [
      makeGate({ id: 'g1', status: 'pending' }),
      makeGate({ id: 'g2', status: 'pending' }),
      makeGate({ id: 'g3', status: 'resolved' }),
    ];
    assert.equal(compactStats([], gates).pendingGates, 2);
  });

  it('computes attentionCount as blocked + unresolved decisions', () => {
    const items = [
      makeItem({ status: 'blocked' }),
      makeItem({ id: '2', type: 'decision', status: 'planned' }),
      makeItem({ id: '3', status: 'in_progress' }),
    ];
    assert.equal(compactStats(items, []).attentionCount, 2);
  });

  it('includes pending-gate items in attentionCount', () => {
    const items = [makeItem({ id: 'gate-item', status: 'in_progress' })];
    const gates = [makeGate({ itemId: 'gate-item', status: 'pending' })];
    assert.equal(compactStats(items, gates).attentionCount, 1);
  });

  it('deduplicates blocked items that also have pending gates', () => {
    const items = [makeItem({ id: 'combo', status: 'blocked' })];
    const gates = [makeGate({ itemId: 'combo', status: 'pending' })];
    assert.equal(compactStats(items, gates).attentionCount, 1);
  });
});

// ---------------------------------------------------------------------------
// togglePhase
// ---------------------------------------------------------------------------

describe('togglePhase — activation', () => {
  it('returns the phaseKey when no phase is currently selected', () => {
    assert.equal(togglePhase(null, 'implementation'), 'implementation');
    assert.equal(togglePhase(undefined, 'vision'), 'vision');
  });

  it('returns the phaseKey when a different phase is selected', () => {
    assert.equal(togglePhase('vision', 'planning'), 'planning');
  });
});

describe('togglePhase — deactivation', () => {
  it('returns null when the same phase is toggled off', () => {
    assert.equal(togglePhase('implementation', 'implementation'), null);
  });
});

describe('togglePhase — edge cases', () => {
  it('handles empty string as no selection', () => {
    assert.equal(togglePhase('', 'vision'), 'vision');
  });
});
