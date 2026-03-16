/**
 * vision-store.test.js
 *
 * Tests for the Zustand vision store lifecycle: state shape,
 * recentErrors recompute, and teardown/disposed guard.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Test the message handler directly (store internals are module-scoped singletons,
// so we test the handler logic that feeds into it)
import { handleVisionMessage } from '../src/components/vision/visionMessageHandler.js';

// Test opsStripLogic (derives entries from store state)
import { deriveEntries, filterRecentErrors } from '../src/components/cockpit/opsStripLogic.js';

// ---------------------------------------------------------------------------
// recentErrors derivation
// ---------------------------------------------------------------------------

describe('filterRecentErrors', () => {
  it('returns errors within the last 60s', () => {
    const now = Date.now();
    const errors = [
      { timestamp: new Date(now - 30_000).toISOString(), message: 'recent' },
      { timestamp: new Date(now - 90_000).toISOString(), message: 'old' },
    ];
    const result = filterRecentErrors(errors, now);
    assert.equal(result.length, 1);
    assert.equal(result[0].message, 'recent');
  });

  it('caps at 5 entries', () => {
    const now = Date.now();
    const errors = Array.from({ length: 10 }, (_, i) => ({
      timestamp: new Date(now - i * 1000).toISOString(),
      message: `err-${i}`,
    }));
    const result = filterRecentErrors(errors, now);
    assert.equal(result.length, 5);
  });

  it('returns empty for no errors', () => {
    assert.deepEqual(filterRecentErrors([], Date.now()), []);
  });
});

// ---------------------------------------------------------------------------
// deriveEntries — build completion
// ---------------------------------------------------------------------------

describe('deriveEntries — build completion', () => {
  it('returns done type when build status is complete', () => {
    const entries = deriveEntries({
      activeBuild: { featureCode: 'FEAT-1', status: 'complete', currentStep: 'ship', flowId: 'f1' },
      gates: [],
      recentErrors: [],
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, 'done');
    assert.ok(entries[0].label.includes('FEAT-1'));
  });

  it('returns build type when build is running', () => {
    const entries = deriveEntries({
      activeBuild: { featureCode: 'FEAT-1', status: 'running', currentStep: 'execute', flowId: 'f1' },
      gates: [],
      recentErrors: [],
    });
    assert.equal(entries[0].type, 'build');
  });

  it('returns no build entry when activeBuild is null', () => {
    const entries = deriveEntries({ activeBuild: null, gates: [], recentErrors: [] });
    assert.equal(entries.filter(e => e.type === 'build' || e.type === 'done').length, 0);
  });
});

// ---------------------------------------------------------------------------
// deriveEntries — gates
// ---------------------------------------------------------------------------

describe('deriveEntries — gates', () => {
  it('derives gate entry from pending gate with stepId', () => {
    const entries = deriveEntries({
      activeBuild: null,
      gates: [{ id: 'g1', status: 'pending', stepId: 'design_gate', featureCode: 'FEAT-1' }],
      recentErrors: [],
    });
    const gate = entries.find(e => e.type === 'gate');
    assert.ok(gate);
    assert.ok(gate.label.includes('design gate'));
    assert.ok(!gate.label.includes('gate gate')); // no duplication
  });

  it('does not duplicate "gate" in label when stepId ends with gate', () => {
    const entries = deriveEntries({
      activeBuild: null,
      gates: [{ id: 'g1', status: 'pending', stepId: 'plan_gate' }],
      recentErrors: [],
    });
    const gate = entries.find(e => e.type === 'gate');
    assert.equal(gate.label, 'plan gate');
  });

  it('skips resolved gates', () => {
    const entries = deriveEntries({
      activeBuild: null,
      gates: [{ id: 'g1', status: 'resolved' }],
      recentErrors: [],
    });
    assert.equal(entries.filter(e => e.type === 'gate').length, 0);
  });
});

// ---------------------------------------------------------------------------
// handleVisionMessage — gateResolved itemId fallback
// ---------------------------------------------------------------------------

describe('handleVisionMessage — gateResolved itemId fallback', () => {
  let calls, refs, setters;

  beforeEach(() => {
    calls = { setGates: [], setGateEvent: [] };
    refs = {
      prevItemMapRef: { current: null },
      snapshotProviderRef: { current: null },
      gatesRef: { current: [] },
      pendingResolveIdsRef: { current: new Set() },
      changeTimerRef: { current: null },
      sessionEndTimerRef: { current: null },
      wsRef: { current: null },
      collectDOMSnapshot: () => ({}),
    };
    setters = {
      setItems: () => {},
      setConnections: () => {},
      setGates: (fn) => { calls.setGates.push(fn); },
      setGateEvent: (v) => { calls.setGateEvent.push(v); },
      setRecentChanges: () => {},
      setUICommand: () => {},
      setAgentActivity: () => {},
      setAgentErrors: () => {},
      setSessionState: () => {},
      setSettings: () => {},
      setActiveBuild: () => {},
      setSessions: () => {},
      EMPTY_CHANGES: { newIds: new Set(), changedIds: new Set() },
    };
  });

  it('falls back to gateId when gatesRef is empty and no msg.itemId', () => {
    refs.gatesRef.current = [];
    handleVisionMessage(
      { type: 'gateResolved', gateId: 'g1', outcome: 'approve', timestamp: '2026-01-01' },
      refs, setters,
    );
    assert.equal(calls.setGateEvent.length, 1);
    assert.equal(calls.setGateEvent[0].itemId, 'g1'); // gateId fallback, never null
  });

  it('uses msg.itemId when available', () => {
    refs.gatesRef.current = [];
    handleVisionMessage(
      { type: 'gateResolved', gateId: 'g1', outcome: 'approve', timestamp: '2026-01-01', itemId: 'item-42' },
      refs, setters,
    );
    assert.equal(calls.setGateEvent[0].itemId, 'item-42');
  });
});
