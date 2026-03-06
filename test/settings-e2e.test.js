/**
 * settings-e2e.test.js — End-to-end smoke test for the settings feature.
 *
 * Starts a real Express server with VisionServer attached (including
 * SettingsStore, settings routes, and WS broadcast). Verifies the full
 * round-trip: REST API + WebSocket broadcast.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const express = (await import('express')).default;
const { VisionStore } = await import(`${ROOT}/server/vision-store.js`);
const { VisionServer } = await import(`${ROOT}/server/vision-server.js`);

let baseUrl;
let wsUrl;
let httpServer;
let visionServer;

before(() => new Promise((res) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'settings-e2e-'));
  const dataDir = join(tmpDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(tmpDir, 'docs', 'features'), { recursive: true });

  const store = new VisionStore(dataDir);
  visionServer = new VisionServer(store);

  const app = express();
  app.use(express.json());
  httpServer = createServer(app);

  visionServer.attach(httpServer, app);

  // Wire WS upgrade
  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url === '/ws/vision') {
      visionServer.wss.handleUpgrade(req, socket, head, (ws) => {
        visionServer.wss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  httpServer.listen(0, '127.0.0.1', () => {
    const { port } = httpServer.address();
    baseUrl = `http://127.0.0.1:${port}`;
    wsUrl = `ws://127.0.0.1:${port}/ws/vision`;
    res();
  });
}));

after(() => new Promise((res) => {
  visionServer.close();
  httpServer.closeAllConnections?.();
  httpServer.close(res);
}));

async function get(path) {
  const r = await fetch(`${baseUrl}${path}`, { headers: { Connection: 'close' } });
  return { status: r.status, body: await r.json() };
}

async function patch(path, body) {
  const r = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

async function post(path, body) {
  const r = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json() };
}

function connectWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const messages = [];
    ws.on('message', (data) => {
      messages.push(JSON.parse(typeof data === 'string' ? data : data.toString()));
    });
    ws.on('open', () => {
      ws._buffered = messages;
      resolve(ws);
    });
    ws.on('error', reject);
  });
}

/** Wait for a message of the given type, checking buffered messages first. */
function waitForMessage(ws, type, timeoutMs = 3000) {
  // Check buffered messages from connection setup
  if (ws._buffered) {
    const idx = ws._buffered.findIndex(m => m.type === type);
    if (idx >= 0) {
      const msg = ws._buffered.splice(idx, 1)[0];
      return Promise.resolve(msg);
    }
  }
  return nextMessage(ws, type, timeoutMs);
}

function nextMessage(ws, type, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
    const handler = (data) => {
      const msg = JSON.parse(typeof data === 'string' ? data : data.toString());
      if (msg.type === type) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

// ---------------------------------------------------------------------------
// Smoke tests
// ---------------------------------------------------------------------------

describe('settings E2E', () => {
  test('GET /api/settings returns valid structure after reset', async () => {
    // Reset to ensure clean state (project data/ dir may have stale settings)
    await post('/api/settings/reset');
    const { status, body } = await get('/api/settings');
    assert.equal(status, 200);
    assert.equal(body.ui.theme, 'system');
    assert.equal(body.ui.defaultView, 'attention');
    assert.ok(body.policies);
    assert.ok(body.iterations);
    assert.ok(body.models);
  });

  test('PATCH /api/settings updates and round-trips via GET', async () => {
    const { status, body } = await patch('/api/settings', { ui: { theme: 'dark' } });
    assert.equal(status, 200);
    assert.equal(body.ui.theme, 'dark');

    const { body: fetched } = await get('/api/settings');
    assert.equal(fetched.ui.theme, 'dark');
  });

  test('PATCH /api/settings broadcasts settingsUpdated over WS', async () => {
    const ws = await connectWs();
    // Drain initial settingsState (may be buffered)
    await waitForMessage(ws, 'settingsState');

    // Now trigger an update and listen for broadcast
    const updatePromise = nextMessage(ws, 'settingsUpdated');
    await patch('/api/settings', { models: { interactive: 'test-model' } });
    const msg = await updatePromise;
    assert.equal(msg.settings.models.interactive, 'test-model');

    ws.close();
  });

  test('WS connection receives settingsState on connect', async () => {
    const ws = await connectWs();
    const msg = await waitForMessage(ws, 'settingsState');
    assert.ok(msg.settings);
    assert.ok(msg.settings.policies);
    assert.ok(msg.settings.ui);
    ws.close();
  });

  test('POST /api/settings/reset restores defaults and broadcasts', async () => {
    // Set something first
    await patch('/api/settings', { ui: { theme: 'dark' }, models: { interactive: 'opus' } });

    const ws = await connectWs();
    await waitForMessage(ws, 'settingsState'); // drain init

    const updatePromise = nextMessage(ws, 'settingsUpdated');
    const { status, body } = await post('/api/settings/reset');
    assert.equal(status, 200);
    assert.equal(body.ui.theme, 'system'); // back to default
    assert.equal(body.models.interactive, 'claude-sonnet-4-6');

    const msg = await updatePromise;
    assert.equal(msg.settings.ui.theme, 'system');

    ws.close();
  });

  test('PATCH validation errors return 400', async () => {
    const { status, body } = await patch('/api/settings', { ui: { theme: 'neon' } });
    assert.equal(status, 400);
    assert.ok(body.error.includes('Invalid theme'));
  });
});
