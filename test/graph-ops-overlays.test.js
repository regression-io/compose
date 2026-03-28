/**
 * graph-ops-overlays.test.js
 *
 * Tests for COMP-UX-1c: Graph ops overlays pure logic.
 * Covers computeBuildStateMap and getDownstreamBlockedIds.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILD_STATES,
  computeBuildStateMap,
  getDownstreamBlockedIds,
} from '../src/components/vision/graphOpsOverlays.js';

import { BUILD_STATE_COLORS } from '../src/components/vision/constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('BUILD_STATES', () => {
  it('exports the four canonical build states', () => {
    assert.equal(BUILD_STATES.building, 'building');
    assert.equal(BUILD_STATES.gate_pending, 'gate_pending');
    assert.equal(BUILD_STATES.blocked_downstream, 'blocked_downstream');
    assert.equal(BUILD_STATES.error, 'error');
  });
});

describe('BUILD_STATE_COLORS', () => {
  it('has a color for each build state', () => {
    assert.equal(BUILD_STATE_COLORS.building, '#3b82f6');
    assert.equal(BUILD_STATE_COLORS.gate_pending, '#f59e0b');
    assert.equal(BUILD_STATE_COLORS.blocked_downstream, '#94a3b8');
    assert.equal(BUILD_STATE_COLORS.error, '#ef4444');
  });
});

// ---------------------------------------------------------------------------
// computeBuildStateMap
// ---------------------------------------------------------------------------

describe('computeBuildStateMap — null/empty inputs', () => {
  it('returns empty object when activeBuild is null', () => {
    const result = computeBuildStateMap(null, [], [], []);
    assert.deepEqual(result, {});
  });

  it('returns empty object when activeBuild is undefined', () => {
    const result = computeBuildStateMap(undefined, [], [], []);
    assert.deepEqual(result, {});
  });

  it('returns empty object when items is empty', () => {
    const build = { featureCode: 'F-1', status: 'running', currentStepId: 'execute' };
    const result = computeBuildStateMap(build, [], [], []);
    // featureCode not found in items — still returns building for it
    assert.equal(result['F-1'], 'building');
  });
});

describe('computeBuildStateMap — building state', () => {
  it('marks the active feature as building when status=running', () => {
    const build = { featureCode: 'F-1', status: 'running', currentStepId: 'execute' };
    const items = [{ id: '1', title: 'F-1', featureCode: 'F-1' }];
    const result = computeBuildStateMap(build, items, [], []);
    assert.equal(result['F-1'], 'building');
  });

  it('does not mark feature as building when status=complete', () => {
    const build = { featureCode: 'F-1', status: 'complete', currentStepId: 'ship' };
    const items = [{ id: '1', title: 'F-1', featureCode: 'F-1' }];
    const result = computeBuildStateMap(build, items, [], []);
    assert.notEqual(result['F-1'], 'building');
  });
});

describe('computeBuildStateMap — gate_pending state', () => {
  it('marks feature as gate_pending when build is awaiting gate', () => {
    const build = { featureCode: 'F-1', status: 'running', currentStepId: 'design_gate' };
    const items = [{ id: '1', title: 'F-1', featureCode: 'F-1' }];
    const gates = [{ id: 'g1', itemId: '1', resolvedAt: null }];
    const result = computeBuildStateMap(build, items, [], gates);
    assert.equal(result['F-1'], 'gate_pending');
  });

  it('does not mark as gate_pending when gate is resolved', () => {
    const build = { featureCode: 'F-1', status: 'running', currentStepId: 'execute' };
    const items = [{ id: '1', title: 'F-1', featureCode: 'F-1' }];
    const gates = [{ id: 'g1', itemId: '1', resolvedAt: '2026-01-01' }];
    const result = computeBuildStateMap(build, items, [], gates);
    assert.equal(result['F-1'], 'building');
  });
});

describe('computeBuildStateMap — error state', () => {
  it('marks feature as error when build status is failed', () => {
    const build = { featureCode: 'F-1', status: 'failed', currentStepId: 'execute' };
    const items = [{ id: '1', title: 'F-1', featureCode: 'F-1' }];
    const result = computeBuildStateMap(build, items, [], []);
    assert.equal(result['F-1'], 'error');
  });
});

describe('computeBuildStateMap — blocked_downstream from gate_pending', () => {
  it('marks downstream nodes as blocked when upstream is gate_pending', () => {
    const build = { featureCode: 'F-1', status: 'running', currentStepId: 'design_gate' };
    const items = [
      { id: '1', title: 'F-1', featureCode: 'F-1' },
      { id: '2', title: 'F-2', featureCode: 'F-2' },
    ];
    const connections = [
      { id: 'c1', fromId: '1', toId: '2', type: 'blocks' },
    ];
    const gates = [{ id: 'g1', itemId: '1', resolvedAt: null }];
    const result = computeBuildStateMap(build, items, connections, gates);
    assert.equal(result['F-1'], 'gate_pending');
    assert.equal(result['F-2'], 'blocked_downstream');
  });
});

describe('computeBuildStateMap — blocked_downstream', () => {
  it('marks downstream nodes as blocked when upstream is building', () => {
    const build = { featureCode: 'F-1', status: 'running', currentStepId: 'execute' };
    const items = [
      { id: '1', title: 'F-1', featureCode: 'F-1' },
      { id: '2', title: 'F-2', featureCode: 'F-2' },
      { id: '3', title: 'F-3', featureCode: 'F-3' },
    ];
    const connections = [
      { id: 'c1', fromId: '1', toId: '2', type: 'blocks' },
      { id: 'c2', fromId: '2', toId: '3', type: 'informs' },
    ];
    const result = computeBuildStateMap(build, items, connections, []);
    assert.equal(result['F-1'], 'building');
    assert.equal(result['F-2'], 'blocked_downstream');
    assert.equal(result['F-3'], 'blocked_downstream');
  });

  it('does not mark upstream nodes as blocked', () => {
    const build = { featureCode: 'F-2', status: 'running', currentStepId: 'execute' };
    const items = [
      { id: '1', title: 'F-1', featureCode: 'F-1' },
      { id: '2', title: 'F-2', featureCode: 'F-2' },
    ];
    const connections = [
      { id: 'c1', fromId: '1', toId: '2', type: 'blocks' },
    ];
    const result = computeBuildStateMap(build, items, connections, []);
    assert.equal(result['F-2'], 'building');
    assert.ok(!result['F-1'], 'F-1 should not be in the map');
  });
});

// ---------------------------------------------------------------------------
// getDownstreamBlockedIds
// ---------------------------------------------------------------------------

describe('getDownstreamBlockedIds', () => {
  it('returns empty set for empty inputs', () => {
    const result = getDownstreamBlockedIds(new Set(), []);
    assert.equal(result.size, 0);
  });

  it('returns direct downstream via blocks edges', () => {
    const connections = [
      { fromId: 'A', toId: 'B', type: 'blocks' },
    ];
    const result = getDownstreamBlockedIds(new Set(['A']), connections);
    assert.ok(result.has('B'));
    assert.ok(!result.has('A'), 'should not include the blocker itself');
  });

  it('returns transitive downstream', () => {
    const connections = [
      { fromId: 'A', toId: 'B', type: 'blocks' },
      { fromId: 'B', toId: 'C', type: 'informs' },
      { fromId: 'C', toId: 'D', type: 'blocks' },
    ];
    const result = getDownstreamBlockedIds(new Set(['A']), connections);
    assert.ok(result.has('B'));
    assert.ok(result.has('C'));
    assert.ok(result.has('D'));
  });

  it('handles cycles without infinite loop', () => {
    const connections = [
      { fromId: 'A', toId: 'B', type: 'blocks' },
      { fromId: 'B', toId: 'A', type: 'informs' },
    ];
    const result = getDownstreamBlockedIds(new Set(['A']), connections);
    assert.ok(result.has('B'));
    // Should not throw or hang
  });

  it('only follows blocks and informs edges', () => {
    const connections = [
      { fromId: 'A', toId: 'B', type: 'blocks' },
      { fromId: 'A', toId: 'C', type: 'supports' },
      { fromId: 'A', toId: 'D', type: 'contradicts' },
    ];
    const result = getDownstreamBlockedIds(new Set(['A']), connections);
    assert.ok(result.has('B'));
    assert.ok(!result.has('C'), 'supports edges should not propagate blocking');
    assert.ok(!result.has('D'), 'contradicts edges should not propagate blocking');
  });
});
