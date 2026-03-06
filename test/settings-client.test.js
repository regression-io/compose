/**
 * settings-client.test.js — Tests for settings WS message handling.
 *
 * Tests the pure handleVisionMessage function directly (no React/jsdom).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { handleVisionMessage } = await import(`${ROOT}/src/components/vision/visionMessageHandler.js`);

const EMPTY_CHANGES = { newIds: new Set(), changedIds: new Set() };

function makeRefs() {
  return {
    prevItemMapRef: { current: null },
    snapshotProviderRef: { current: null },
    gatesRef: { current: [] },
    pendingResolveIdsRef: { current: new Set() },
    changeTimerRef: { current: null },
    sessionEndTimerRef: { current: null },
    wsRef: { current: null },
  };
}

function makeSetters(overrides = {}) {
  return {
    setItems: () => {},
    setConnections: () => {},
    setGates: () => {},
    setGateEvent: () => {},
    setRecentChanges: () => {},
    setUICommand: () => {},
    setAgentActivity: () => {},
    setAgentErrors: () => {},
    setSessionState: () => {},
    setSettings: overrides.setSettings || null,
    EMPTY_CHANGES,
  };
}

describe('settings WS messages', () => {
  test('settingsState calls setSettings with payload', () => {
    let captured = undefined;
    const setters = makeSetters({
      setSettings: (val) => { captured = val; },
    });
    handleVisionMessage(
      { type: 'settingsState', settings: { ui: { theme: 'dark' } } },
      makeRefs(),
      setters,
    );
    assert.deepEqual(captured, { ui: { theme: 'dark' } });
  });

  test('settingsUpdated calls setSettings with payload', () => {
    let captured = undefined;
    const setters = makeSetters({
      setSettings: (val) => { captured = val; },
    });
    handleVisionMessage(
      { type: 'settingsUpdated', settings: { models: { interactive: 'opus' } } },
      makeRefs(),
      setters,
    );
    assert.deepEqual(captured, { models: { interactive: 'opus' } });
  });

  test('missing setSettings does not crash', () => {
    const setters = makeSetters(); // setSettings is null
    assert.doesNotThrow(() => {
      handleVisionMessage(
        { type: 'settingsState', settings: { ui: { theme: 'light' } } },
        makeRefs(),
        setters,
      );
    });
  });
});
