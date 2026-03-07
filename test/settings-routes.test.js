/**
 * settings-routes.test.js — Settings REST API tests.
 *
 * Spins up a real Express server on an ephemeral port with a real SettingsStore
 * backed by a temp directory.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
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

const express = (await import('express')).default;
const { SettingsStore } = await import(`${ROOT}/server/settings-store.js`);
const { attachSettingsRoutes } = await import(`${ROOT}/server/settings-routes.js`);

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

let baseUrl;
let httpServer;
let settingsStore;
const broadcasts = [];

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'settings-routes-'));
}

before(() => new Promise(res => {
  settingsStore = new SettingsStore(freshDir(), SETTINGS_DEFAULTS);

  const app = express();
  app.use(express.json());

  attachSettingsRoutes(app, {
    settingsStore,
    broadcastMessage: (msg) => broadcasts.push(msg),
  });

  httpServer = createServer(app);
  httpServer.listen(0, '127.0.0.1', () => {
    const { port } = httpServer.address();
    baseUrl = `http://127.0.0.1:${port}`;
    res();
  });
}));

after(() => new Promise(res => {
  httpServer.closeAllConnections?.();
  httpServer.close(res);
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Connection: 'close' },
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

async function patch(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

// ---------------------------------------------------------------------------
// GET /api/settings
// ---------------------------------------------------------------------------

describe('GET /api/settings', () => {
  test('returns defaults when no user settings', async () => {
    const { status, body } = await get('/api/settings');
    assert.equal(status, 200);
    assert.equal(body.policies.prd, 'skip');
    assert.equal(body.policies.blueprint, 'gate');
    assert.equal(body.ui.theme, 'system');
    assert.equal(body.ui.defaultView, 'attention');
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/settings
// ---------------------------------------------------------------------------

describe('PATCH /api/settings', () => {
  test('updates and returns merged settings', async () => {
    const { status, body } = await patch('/api/settings', {
      policies: { prd: 'gate' },
    });
    assert.equal(status, 200);
    assert.equal(body.policies.prd, 'gate');
    assert.equal(body.policies.blueprint, 'gate'); // unchanged
  });

  test('broadcasts settingsUpdated message', async () => {
    const before = broadcasts.length;
    await patch('/api/settings', { ui: { theme: 'dark' } });
    const added = broadcasts.slice(before);
    const msg = added.find(m => m.type === 'settingsUpdated');
    assert.ok(msg, 'should broadcast settingsUpdated');
    assert.equal(msg.settings.ui.theme, 'dark');
  });

  test('invalid policy returns 400', async () => {
    const { status, body } = await patch('/api/settings', {
      policies: { prd: 'bogus' },
    });
    assert.equal(status, 400);
    assert.ok(body.error.includes('Invalid policy mode'));
  });

  test('invalid iteration returns 400', async () => {
    const { status, body } = await patch('/api/settings', {
      iterations: { review: { maxIterations: 0 } },
    });
    assert.equal(status, 400);
    assert.ok(body.error.includes('must be integer 1-100'));
  });

  test('invalid theme returns 400', async () => {
    const { status, body } = await patch('/api/settings', {
      ui: { theme: 'neon' },
    });
    assert.equal(status, 400);
    assert.ok(body.error.includes('Invalid theme'));
  });

  test('unknown section returns 400', async () => {
    const { status, body } = await patch('/api/settings', {
      bogus: 'value',
    });
    assert.equal(status, 400);
    assert.ok(body.error.includes('Unknown settings section'));
  });
});

// ---------------------------------------------------------------------------
// POST /api/settings/reset
// ---------------------------------------------------------------------------

describe('POST /api/settings/reset', () => {
  test('reset clears all settings and returns defaults', async () => {
    // Set something first
    await patch('/api/settings', { models: { interactive: 'opus' } });
    const { status, body } = await post('/api/settings/reset');
    assert.equal(status, 200);
    assert.equal(body.models.interactive, 'claude-sonnet-4-6');
  });

  test('reset broadcasts settingsUpdated', async () => {
    const before = broadcasts.length;
    await post('/api/settings/reset');
    const added = broadcasts.slice(before);
    const msg = added.find(m => m.type === 'settingsUpdated');
    assert.ok(msg, 'should broadcast settingsUpdated on reset');
  });

  test('reset with section clears only that section', async () => {
    await patch('/api/settings', {
      policies: { prd: 'gate' },
      models: { interactive: 'opus' },
    });
    const { status, body } = await post('/api/settings/reset', { section: 'policies' });
    assert.equal(status, 200);
    assert.equal(body.policies.prd, 'skip'); // reset
    assert.equal(body.models.interactive, 'opus'); // unchanged
  });
});
