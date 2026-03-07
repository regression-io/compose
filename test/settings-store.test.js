/**
 * settings-store.test.js — SettingsStore unit tests.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Inlined defaults (previously from contracts/lifecycle.json, now baked in). */
const SETTINGS_DEFAULTS = {
  phases: [
    { id: 'explore_design', defaultPolicy: null },
    { id: 'prd', defaultPolicy: 'skip' },
    { id: 'architecture', defaultPolicy: 'skip' },
    { id: 'blueprint', defaultPolicy: 'gate' },
    { id: 'verification', defaultPolicy: 'gate' },
    { id: 'plan', defaultPolicy: 'gate' },
    { id: 'execute', defaultPolicy: 'flag' },
    { id: 'report', defaultPolicy: 'skip' },
    { id: 'docs', defaultPolicy: 'flag' },
    { id: 'ship', defaultPolicy: 'gate' },
  ],
  iterationDefaults: {
    review: { maxIterations: 10 },
    coverage: { maxIterations: 15 },
  },
  policyModes: ['gate', 'flag', 'skip'],
};

const { SettingsStore } = await import(`${ROOT}/server/settings-store.js`);

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'settings-test-'));
}

function makeStore(dir) {
  return new SettingsStore(dir || freshDir(), SETTINGS_DEFAULTS);
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe('defaults', () => {
  test('get() returns contract policy defaults when no settings file', () => {
    const store = makeStore();
    const settings = store.get();
    assert.equal(settings.policies.explore_design, null);
    assert.equal(settings.policies.prd, 'skip');
    assert.equal(settings.policies.blueprint, 'gate');
    assert.equal(settings.policies.execute, 'flag');
  });

  test('get() returns contract iteration defaults', () => {
    const store = makeStore();
    const settings = store.get();
    assert.equal(settings.iterations.review.maxIterations, 10);
    assert.equal(settings.iterations.coverage.maxIterations, 15);
  });

  test('get() returns model defaults', () => {
    const store = makeStore();
    const settings = store.get();
    assert.equal(settings.models.interactive, 'claude-sonnet-4-6');
    assert.ok(settings.models.summarizer);
  });

  test('get() returns ui defaults', () => {
    const store = makeStore();
    const settings = store.get();
    assert.equal(settings.ui.theme, 'system');
    assert.equal(settings.ui.defaultView, 'attention');
  });
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

describe('update', () => {
  test('update policies persists and returns merged', () => {
    const store = makeStore();
    const result = store.update({ policies: { prd: 'gate' } });
    assert.equal(result.policies.prd, 'gate');
    // Other policies unchanged
    assert.equal(result.policies.blueprint, 'gate');
    assert.equal(result.policies.execute, 'flag');
  });

  test('update iterations persists and returns merged', () => {
    const store = makeStore();
    const result = store.update({ iterations: { review: { maxIterations: 5 } } });
    assert.equal(result.iterations.review.maxIterations, 5);
    assert.equal(result.iterations.coverage.maxIterations, 15);
  });

  test('update models persists', () => {
    const store = makeStore();
    const result = store.update({ models: { interactive: 'claude-haiku-4-5-20251001' } });
    assert.equal(result.models.interactive, 'claude-haiku-4-5-20251001');
  });

  test('update ui persists', () => {
    const store = makeStore();
    const result = store.update({ ui: { theme: 'dark', defaultView: 'gates' } });
    assert.equal(result.ui.theme, 'dark');
    assert.equal(result.ui.defaultView, 'gates');
  });

  test('update with invalid policy mode throws', () => {
    const store = makeStore();
    assert.throws(() => store.update({ policies: { prd: 'bogus' } }), /Invalid policy mode/);
  });

  test('update with null policy mode is valid', () => {
    const store = makeStore();
    const result = store.update({ policies: { prd: null } });
    assert.equal(result.policies.prd, null);
  });

  test('update with invalid iteration count throws', () => {
    const store = makeStore();
    assert.throws(() => store.update({ iterations: { review: { maxIterations: 0 } } }), /must be integer 1-100/);
    assert.throws(() => store.update({ iterations: { review: { maxIterations: 101 } } }), /must be integer 1-100/);
    assert.throws(() => store.update({ iterations: { review: { maxIterations: 2.5 } } }), /must be integer 1-100/);
  });

  test('update with empty model string throws', () => {
    const store = makeStore();
    assert.throws(() => store.update({ models: { interactive: '' } }), /must be non-empty string/);
  });

  test('update with invalid theme throws', () => {
    const store = makeStore();
    assert.throws(() => store.update({ ui: { theme: 'neon' } }), /Invalid theme/);
  });

  test('update with invalid defaultView throws', () => {
    const store = makeStore();
    assert.throws(() => store.update({ ui: { defaultView: 'nonexistent' } }), /Invalid defaultView/);
  });

  test('unknown top-level key throws', () => {
    const store = makeStore();
    assert.throws(() => store.update({ bogus: 'value' }), /Unknown settings section/);
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe('reset', () => {
  test('reset() clears all user settings', () => {
    const store = makeStore();
    store.update({ policies: { prd: 'gate' }, models: { interactive: 'opus' } });
    const result = store.reset();
    assert.equal(result.policies.prd, 'skip'); // back to contract default
    assert.equal(result.models.interactive, 'claude-sonnet-4-6');
  });

  test('reset(section) clears only that section', () => {
    const store = makeStore();
    store.update({ policies: { prd: 'gate' }, models: { interactive: 'opus' } });
    const result = store.reset('policies');
    assert.equal(result.policies.prd, 'skip'); // reset to default
    assert.equal(result.models.interactive, 'opus'); // unchanged
  });
});

// ---------------------------------------------------------------------------
// Corrupt file
// ---------------------------------------------------------------------------

describe('corrupt settings file', () => {
  test('malformed JSON falls back to defaults', () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'settings.json'), '{not valid json!!!', 'utf-8');
    const store = new SettingsStore(dir, SETTINGS_DEFAULTS);
    const settings = store.get();
    assert.equal(settings.ui.theme, 'system');
    assert.equal(settings.policies.prd, 'skip');
  });

  test('empty file falls back to defaults', () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'settings.json'), '', 'utf-8');
    const store = new SettingsStore(dir, SETTINGS_DEFAULTS);
    const settings = store.get();
    assert.equal(settings.ui.theme, 'system');
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('persistence', () => {
  test('file round-trip: update, new store from same dir', () => {
    const dir = freshDir();
    const store1 = makeStore(dir);
    store1.update({ policies: { prd: 'gate' } });

    const store2 = new SettingsStore(dir, SETTINGS_DEFAULTS);
    assert.equal(store2.get().policies.prd, 'gate');
  });

  test('no file on disk until first update', () => {
    const dir = freshDir();
    makeStore(dir);
    assert.throws(() => readFileSync(join(dir, 'settings.json')), { code: 'ENOENT' });
  });
});
