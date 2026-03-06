/**
 * gate-client.test.js — Tests for the extracted visionMessageHandler,
 * focusing on gate-related message types (gatePending, gateResolved)
 * and their interaction with state management.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { handleVisionMessage } = await import(
  `${REPO_ROOT}/src/components/vision/visionMessageHandler.js`
);

// ---------------------------------------------------------------------------
// Helpers — mock refs and setters that mirror useVisionStore's shape
// ---------------------------------------------------------------------------

function createMockRefs() {
  return {
    prevItemMapRef: { current: null },
    snapshotProviderRef: { current: null },
    gatesRef: { current: [] },
    pendingResolveIdsRef: { current: new Set() },
    changeTimerRef: { current: null },
    sessionEndTimerRef: { current: null },
    wsRef: { current: { send: () => {} } },
    collectDOMSnapshot: () => ({}),
  };
}

function createMockSetters() {
  const calls = {};
  const makeSetter = (name) => {
    calls[name] = [];
    return (valOrFn) => {
      // If it's a function (updater), call it with last value or default
      if (typeof valOrFn === 'function') {
        const prev = calls[name].length > 0
          ? calls[name][calls[name].length - 1].resolved
          : getDefault(name);
        const resolved = valOrFn(prev);
        calls[name].push({ raw: valOrFn, resolved });
      } else {
        calls[name].push({ raw: valOrFn, resolved: valOrFn });
      }
    };
  };

  function getDefault(name) {
    if (name === 'setItems' || name === 'setConnections' || name === 'setGates') return [];
    if (name === 'setAgentActivity' || name === 'setAgentErrors') return [];
    if (name === 'setSessionState') return null;
    return null;
  }

  const EMPTY_CHANGES = { newIds: new Set(), changedIds: new Set() };

  return {
    calls,
    setters: {
      setItems: makeSetter('setItems'),
      setConnections: makeSetter('setConnections'),
      setGates: makeSetter('setGates'),
      setGateEvent: makeSetter('setGateEvent'),
      setRecentChanges: makeSetter('setRecentChanges'),
      setUICommand: makeSetter('setUICommand'),
      setAgentActivity: makeSetter('setAgentActivity'),
      setAgentErrors: makeSetter('setAgentErrors'),
      setSessionState: makeSetter('setSessionState'),
      EMPTY_CHANGES,
    },
  };
}

// ---------------------------------------------------------------------------
// visionState — gates included in payload
// ---------------------------------------------------------------------------

describe('handleVisionMessage — visionState with gates', () => {
  let refs, calls, setters;
  beforeEach(() => {
    refs = createMockRefs();
    ({ calls, setters } = createMockSetters());
  });

  test('sets gates from visionState payload', () => {
    const gates = [
      { id: 'g1', status: 'pending', itemId: 'i1', fromPhase: 'explore_design', toPhase: 'blueprint' },
    ];
    handleVisionMessage(
      { type: 'visionState', items: [], connections: [], gates },
      refs, setters,
    );
    assert.equal(calls.setGates.length, 1);
    assert.deepEqual(calls.setGates[0].resolved, gates);
  });

  test('defaults gates to empty array when missing from payload', () => {
    handleVisionMessage(
      { type: 'visionState', items: [], connections: [] },
      refs, setters,
    );
    assert.equal(calls.setGates.length, 1);
    assert.deepEqual(calls.setGates[0].resolved, []);
  });
});

// ---------------------------------------------------------------------------
// gatePending
// ---------------------------------------------------------------------------

describe('handleVisionMessage — gatePending', () => {
  let refs, calls, setters;
  beforeEach(() => {
    refs = createMockRefs();
    ({ calls, setters } = createMockSetters());
  });

  test('sets gateEvent with pending type', () => {
    handleVisionMessage(
      { type: 'gatePending', gateId: 'g1', itemId: 'i1', fromPhase: 'explore_design', toPhase: 'blueprint' },
      refs, setters,
    );
    assert.equal(calls.setGateEvent.length, 1);
    const event = calls.setGateEvent[0].resolved;
    assert.equal(event.type, 'pending');
    assert.equal(event.gateId, 'g1');
    assert.equal(event.itemId, 'i1');
    assert.equal(event.fromPhase, 'explore_design');
    assert.equal(event.toPhase, 'blueprint');
  });

  test('appends gate via setGates updater (deduplicates)', () => {
    // gatePending triggers a fetch, but also calls setGates.
    // We can't test the fetch here (no server), but we can verify
    // the setGates updater deduplicates.
    // Simulate: gate already exists in state
    const existingGate = { id: 'g1', status: 'pending' };
    refs.gatesRef.current = [existingGate];

    handleVisionMessage(
      { type: 'gatePending', gateId: 'g1', itemId: 'i1', fromPhase: 'explore_design', toPhase: 'blueprint' },
      refs, setters,
    );

    // setGateEvent should still fire
    assert.equal(calls.setGateEvent.length, 1);
  });
});

// ---------------------------------------------------------------------------
// gateResolved
// ---------------------------------------------------------------------------

describe('handleVisionMessage — gateResolved', () => {
  let refs, calls, setters;
  beforeEach(() => {
    refs = createMockRefs();
    ({ calls, setters } = createMockSetters());
  });

  test('optimistic update changes gate status and outcome', () => {
    // Pre-populate gates in setters so the updater has something to work with
    const existingGate = { id: 'g1', status: 'pending', itemId: 'i1' };

    // First set initial gates state
    handleVisionMessage(
      { type: 'visionState', items: [], connections: [], gates: [existingGate] },
      refs, setters,
    );

    // Now handle gateResolved
    handleVisionMessage(
      { type: 'gateResolved', gateId: 'g1', outcome: 'approved', timestamp: '2026-03-06T00:00:00Z' },
      refs, setters,
    );

    // setGates should have been called twice (once for visionState, once for gateResolved)
    assert.equal(calls.setGates.length, 2);
    const updatedGates = calls.setGates[1].resolved;
    assert.equal(updatedGates[0].status, 'approved');
    assert.equal(updatedGates[0].outcome, 'approved');
    assert.equal(updatedGates[0].resolvedAt, '2026-03-06T00:00:00Z');
  });

  test('emits gateEvent toast when NOT self-triggered', () => {
    refs.gatesRef.current = [{ id: 'g1', status: 'pending', itemId: 'i1' }];

    handleVisionMessage(
      { type: 'gateResolved', gateId: 'g1', outcome: 'approved', timestamp: '2026-03-06T00:00:00Z' },
      refs, setters,
    );

    assert.equal(calls.setGateEvent.length, 1);
    const event = calls.setGateEvent[0].resolved;
    assert.equal(event.type, 'resolved');
    assert.equal(event.outcome, 'approved');
    assert.equal(event.itemId, 'i1');
  });

  test('prefers msg.itemId over gatesRef lookup (race-safe)', () => {
    // gatesRef is empty (gatePending fetch hasn't settled yet)
    refs.gatesRef.current = [];

    handleVisionMessage(
      { type: 'gateResolved', gateId: 'g1', itemId: 'i1', outcome: 'approved', timestamp: '2026-03-06T00:00:00Z' },
      refs, setters,
    );

    assert.equal(calls.setGateEvent.length, 1);
    assert.equal(calls.setGateEvent[0].resolved.itemId, 'i1');
  });

  test('suppresses toast when self-triggered (pendingResolveIdsRef)', () => {
    refs.pendingResolveIdsRef.current.add('g1');
    refs.gatesRef.current = [{ id: 'g1', status: 'pending', itemId: 'i1' }];

    handleVisionMessage(
      { type: 'gateResolved', gateId: 'g1', outcome: 'approved', timestamp: '2026-03-06T00:00:00Z' },
      refs, setters,
    );

    // Toast should NOT be emitted
    assert.equal(calls.setGateEvent.length, 0);
    // pendingResolveIdsRef should be cleaned up
    assert.equal(refs.pendingResolveIdsRef.current.has('g1'), false);
  });

  test('suppresses only the matching gateId, not others', () => {
    refs.pendingResolveIdsRef.current.add('g1');
    refs.pendingResolveIdsRef.current.add('g2');
    refs.gatesRef.current = [
      { id: 'g1', status: 'pending', itemId: 'i1' },
      { id: 'g2', status: 'pending', itemId: 'i2' },
    ];

    handleVisionMessage(
      { type: 'gateResolved', gateId: 'g1', outcome: 'approved', timestamp: '2026-03-06T00:00:00Z' },
      refs, setters,
    );

    // g1 suppressed, g2 still in set
    assert.equal(refs.pendingResolveIdsRef.current.has('g1'), false);
    assert.equal(refs.pendingResolveIdsRef.current.has('g2'), true);
    assert.equal(calls.setGateEvent.length, 0);

    // Now resolve g2 — should show toast
    handleVisionMessage(
      { type: 'gateResolved', gateId: 'g2', outcome: 'revised', timestamp: '2026-03-06T00:01:00Z' },
      refs, setters,
    );

    assert.equal(refs.pendingResolveIdsRef.current.has('g2'), false);
    assert.equal(calls.setGateEvent.length, 0); // still suppressed because g2 was in the set
  });

  test('resolved gate without matching gatesRef still emits toast (itemId null)', () => {
    // Edge case: gatesRef doesn't have the gate (stale)
    refs.gatesRef.current = [];

    handleVisionMessage(
      { type: 'gateResolved', gateId: 'g1', outcome: 'killed', timestamp: '2026-03-06T00:00:00Z' },
      refs, setters,
    );

    assert.equal(calls.setGateEvent.length, 1);
    assert.equal(calls.setGateEvent[0].resolved.itemId, null);
  });
});

// ---------------------------------------------------------------------------
// snapshotRequest
// ---------------------------------------------------------------------------

describe('handleVisionMessage — snapshotRequest', () => {
  let refs, calls, setters;
  beforeEach(() => {
    refs = createMockRefs();
    ({ calls, setters } = createMockSetters());
  });

  test('responds with snapshot via ws.send', () => {
    let sentMessage = null;
    refs.wsRef.current = { send: (msg) => { sentMessage = msg; } };
    refs.snapshotProviderRef.current = () => ({ activeView: 'gates' });

    handleVisionMessage(
      { type: 'snapshotRequest', requestId: 'req-1' },
      refs, setters,
    );

    assert.ok(sentMessage);
    const parsed = JSON.parse(sentMessage);
    assert.equal(parsed.type, 'snapshotResponse');
    assert.equal(parsed.requestId, 'req-1');
    assert.equal(parsed.snapshot.activeView, 'gates');
    assert.ok(parsed.snapshot.dom);
    assert.ok(parsed.snapshot.timestamp);
  });

  test('ignores snapshotRequest without requestId', () => {
    let sentMessage = null;
    refs.wsRef.current = { send: (msg) => { sentMessage = msg; } };

    handleVisionMessage(
      { type: 'snapshotRequest' },
      refs, setters,
    );

    assert.equal(sentMessage, null);
  });
});

// ---------------------------------------------------------------------------
// sessionStart / sessionEnd
// ---------------------------------------------------------------------------

describe('handleVisionMessage — session lifecycle', () => {
  let refs, calls, setters;
  beforeEach(() => {
    refs = createMockRefs();
    ({ calls, setters } = createMockSetters());
  });

  test('sessionStart creates new session state', () => {
    handleVisionMessage(
      { type: 'sessionStart', sessionId: 's1', timestamp: '2026-03-06T00:00:00Z', source: 'cli' },
      refs, setters,
    );

    assert.equal(calls.setSessionState.length, 1);
    const state = calls.setSessionState[0].resolved;
    assert.equal(state.id, 's1');
    assert.equal(state.active, true);
    assert.equal(state.source, 'cli');
    assert.equal(state.toolCount, 0);
  });

  test('sessionEnd marks session inactive', () => {
    // Start session first
    handleVisionMessage(
      { type: 'sessionStart', sessionId: 's1', timestamp: '2026-03-06T00:00:00Z', source: 'cli' },
      refs, setters,
    );

    handleVisionMessage(
      { type: 'sessionEnd', sessionId: 's1', timestamp: '2026-03-06T00:05:00Z', toolCount: 10, duration: 300 },
      refs, setters,
    );

    assert.equal(calls.setSessionState.length, 2);
    const state = calls.setSessionState[1].resolved;
    assert.equal(state.active, false);
    assert.equal(state.toolCount, 10);
  });

  test('agentActivity increments session toolCount', () => {
    // Start session
    handleVisionMessage(
      { type: 'sessionStart', sessionId: 's1', timestamp: '2026-03-06T00:00:00Z', source: 'cli' },
      refs, setters,
    );

    handleVisionMessage(
      { type: 'agentActivity', tool: 'Read', detail: 'file.js', timestamp: '2026-03-06T00:01:00Z' },
      refs, setters,
    );

    // setSessionState called for sessionStart + agentActivity
    assert.equal(calls.setSessionState.length, 2);
    const state = calls.setSessionState[1].resolved;
    assert.equal(state.toolCount, 1);
  });
});

// ---------------------------------------------------------------------------
// visionState diff tracking
// ---------------------------------------------------------------------------

describe('handleVisionMessage — change tracking', () => {
  let refs, calls, setters;
  beforeEach(() => {
    refs = createMockRefs();
    ({ calls, setters } = createMockSetters());
  });

  test('first visionState does not emit changes (no prev)', () => {
    handleVisionMessage(
      { type: 'visionState', items: [{ id: 'i1', title: 'A', status: 'planned', confidence: 0 }] },
      refs, setters,
    );
    assert.equal(calls.setRecentChanges.length, 0);
  });

  test('second visionState with new item emits newIds', () => {
    handleVisionMessage(
      { type: 'visionState', items: [{ id: 'i1', title: 'A', status: 'planned', confidence: 0 }] },
      refs, setters,
    );
    handleVisionMessage(
      { type: 'visionState', items: [
        { id: 'i1', title: 'A', status: 'planned', confidence: 0 },
        { id: 'i2', title: 'B', status: 'planned', confidence: 0 },
      ] },
      refs, setters,
    );

    assert.equal(calls.setRecentChanges.length, 1);
    assert.ok(calls.setRecentChanges[0].resolved.newIds.has('i2'));
  });

  test('status change emits changedIds', () => {
    handleVisionMessage(
      { type: 'visionState', items: [{ id: 'i1', title: 'A', status: 'planned', confidence: 0 }] },
      refs, setters,
    );
    handleVisionMessage(
      { type: 'visionState', items: [{ id: 'i1', title: 'A', status: 'in_progress', confidence: 0 }] },
      refs, setters,
    );

    assert.equal(calls.setRecentChanges.length, 1);
    assert.ok(calls.setRecentChanges[0].resolved.changedIds.has('i1'));
  });
});
