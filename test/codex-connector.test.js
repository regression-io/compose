/**
 * Tests for CodexConnector model validation guards.
 * These tests do NOT require opencode — they only test construction-time validation.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CodexConnector, CODEX_MODEL_IDS } from '../server/connectors/codex-connector.js';

describe('CodexConnector', () => {
  test('rejects unknown model ID at construction', () => {
    assert.throws(
      () => new CodexConnector({ modelID: 'gpt-4o' }),
      /not a supported Codex model/
    );
  });

  test('rejects empty model ID', () => {
    assert.throws(
      () => new CodexConnector({ modelID: '' }),
      /not a supported Codex model/
    );
  });

  test('accepts all declared CODEX_MODEL_IDS', () => {
    for (const modelID of CODEX_MODEL_IDS) {
      // Should not throw — just constructing, not running
      const c = new CodexConnector({ modelID });
      assert.ok(c, `should construct with ${modelID}`);
    }
  });

  test('default model is accepted when CODEX_MODEL env is not set', () => {
    // Default constructor should not throw
    assert.doesNotThrow(() => new CodexConnector());
  });

  test('CODEX_MODEL_IDS contains expected model families', () => {
    const ids = [...CODEX_MODEL_IDS];
    assert.ok(ids.some(id => id.startsWith('gpt-5.4')), 'should have gpt-5.4');
    assert.ok(ids.some(id => id.startsWith('gpt-5.2-codex')), 'should have gpt-5.2-codex');
    assert.ok(ids.some(id => id.startsWith('gpt-5.1-codex')), 'should have gpt-5.1-codex');
    assert.ok(ids.some(id => id.includes('/low')), 'should have effort suffixes');
    assert.ok(ids.some(id => id.includes('/high')), 'should have effort suffixes');
  });
});
