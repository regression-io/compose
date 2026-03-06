/**
 * iteration-client.test.js — Client handler tests for iteration WS messages.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { handleVisionMessage } = await import(`${REPO_ROOT}/src/components/vision/visionMessageHandler.js`);

function makeTestHarness() {
  const state = {
    agentActivity: [],
    agentErrors: [],
    sessionState: { active: true, errorCount: 0 },
  };

  const refs = {
    wsRef: { current: null },
    gatesRef: { current: [] },
    pendingResolveIdsRef: { current: new Set() },
    snapshotProviderRef: { current: null },
    collectDOMSnapshot: null,
  };

  const setters = {
    setItems: () => {},
    setConnections: () => {},
    setGates: () => {},
    setGateEvent: () => {},
    setRecentChanges: () => {},
    setUICommand: () => {},
    setAgentActivity: (fn) => { state.agentActivity = fn(state.agentActivity); },
    setAgentErrors: (fn) => { state.agentErrors = fn(state.agentErrors); },
    setSessionState: (fn) => { state.sessionState = fn(state.sessionState); },
    EMPTY_CHANGES: { added: [], updated: [], removed: [] },
  };

  return { state, refs, setters };
}

describe('iteration client messages', () => {
  test('iterationStarted adds activity entry with loop type and max', () => {
    const { state, refs, setters } = makeTestHarness();
    handleVisionMessage({
      type: 'iterationStarted',
      loopType: 'review',
      maxIterations: 10,
      loopId: 'iter-abc',
      itemId: 'item-1',
      timestamp: '2026-03-06T12:00:00Z',
    }, refs, setters);

    assert.equal(state.agentActivity.length, 1);
    const entry = state.agentActivity[0];
    assert.equal(entry.tool, 'iteration');
    assert.equal(entry.category, 'review');
    assert.ok(entry.detail.includes('review loop started'));
    assert.ok(entry.detail.includes('0/10'));
    assert.deepEqual(entry.items, []);
  });

  test('iterationUpdate adds activity entry with count', () => {
    const { state, refs, setters } = makeTestHarness();
    handleVisionMessage({
      type: 'iterationUpdate',
      loopType: 'review',
      count: 3,
      maxIterations: 10,
      exitCriteriaMet: false,
      continueLoop: true,
      loopId: 'iter-abc',
      itemId: 'item-1',
      timestamp: '2026-03-06T12:01:00Z',
    }, refs, setters);

    assert.equal(state.agentActivity.length, 1);
    assert.ok(state.agentActivity[0].detail.includes('3/10'));
  });

  test('iterationComplete with clean outcome adds completion activity', () => {
    const { state, refs, setters } = makeTestHarness();
    handleVisionMessage({
      type: 'iterationComplete',
      loopType: 'review',
      outcome: 'clean',
      finalCount: 4,
      loopId: 'iter-abc',
      itemId: 'item-1',
      timestamp: '2026-03-06T12:02:00Z',
    }, refs, setters);

    assert.equal(state.agentActivity.length, 1);
    assert.ok(state.agentActivity[0].detail.includes('loop complete'));
    assert.ok(state.agentActivity[0].detail.includes('clean'));
    assert.ok(state.agentActivity[0].detail.includes('4 iterations'));
    assert.equal(state.agentErrors.length, 0);
  });

  test('iterationComplete with max_reached calls setAgentErrors and increments errorCount', () => {
    const { state, refs, setters } = makeTestHarness();
    handleVisionMessage({
      type: 'iterationComplete',
      loopType: 'review',
      outcome: 'max_reached',
      finalCount: 10,
      loopId: 'iter-abc',
      itemId: 'item-1',
      timestamp: '2026-03-06T12:03:00Z',
    }, refs, setters);

    assert.equal(state.agentActivity.length, 1);
    assert.equal(state.agentErrors.length, 1);
    assert.equal(state.agentErrors[0].errorType, 'iteration_limit');
    assert.equal(state.agentErrors[0].severity, 'warning');
    assert.ok(state.agentErrors[0].message.includes('max iterations'));
    assert.equal(state.sessionState.errorCount, 1);
  });

  test('activity entries have empty items array', () => {
    const { state, refs, setters } = makeTestHarness();

    handleVisionMessage({
      type: 'iterationStarted', loopType: 'coverage', maxIterations: 15,
      loopId: 'iter-1', itemId: 'item-1', timestamp: '2026-03-06T12:00:00Z',
    }, refs, setters);

    handleVisionMessage({
      type: 'iterationUpdate', loopType: 'coverage', count: 1, maxIterations: 15,
      exitCriteriaMet: false, continueLoop: true,
      loopId: 'iter-1', itemId: 'item-1', timestamp: '2026-03-06T12:01:00Z',
    }, refs, setters);

    handleVisionMessage({
      type: 'iterationComplete', loopType: 'coverage', outcome: 'clean', finalCount: 2,
      loopId: 'iter-1', itemId: 'item-1', timestamp: '2026-03-06T12:02:00Z',
    }, refs, setters);

    for (const entry of state.agentActivity) {
      assert.deepEqual(entry.items, [], `entry "${entry.detail}" should have empty items`);
    }
  });
});
