/**
 * design-routes.test.js — Design conversation REST + SSE API tests.
 *
 * Spins up a real Express server on an ephemeral port with a real
 * DesignSessionManager backed by a temp directory.
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

const express = (await import('express')).default;
const { DesignSessionManager } = await import(`${ROOT}/server/design-session.js`);
const { attachDesignRoutes, designListeners } = await import(`${ROOT}/server/design-routes.js`);

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

let baseUrl;
let httpServer;
let sessionManager;

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'design-routes-'));
}

before(() => new Promise(res => {
  sessionManager = new DesignSessionManager(freshDir());

  const app = express();
  app.use(express.json());

  attachDesignRoutes(app, {
    getSessionManager: () => sessionManager,
    getConnector: () => null,
    getProjectRoot: () => freshDir(),
  });

  httpServer = createServer(app);
  httpServer.listen(0, '127.0.0.1', () => {
    const { port } = httpServer.address();
    baseUrl = `http://127.0.0.1:${port}`;
    res();
  });
}));

after(() => new Promise(res => {
  sessionManager.destroy();
  httpServer.closeAllConnections?.();
  httpServer.close(res);
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function get(path) {
  const r = await fetch(`${baseUrl}${path}`, {
    headers: { Connection: 'close' },
  });
  const json = await r.json();
  return { status: r.status, body: json };
}

async function post(path, body) {
  const r = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify(body || {}),
  });
  const json = await r.json();
  return { status: r.status, body: json };
}

// ---------------------------------------------------------------------------
// POST /api/design/start
// ---------------------------------------------------------------------------

describe('POST /api/design/start', () => {
  test('creates a product session', async () => {
    const { status, body } = await post('/api/design/start', { scope: 'product' });
    assert.equal(status, 200);
    assert.ok(body.session);
    assert.equal(body.session.scope, 'product');
    assert.equal(body.session.status, 'active');
    assert.ok(body.session.id);
  });

  test('returns 409 when session already active', async () => {
    // product session was started above
    const { status, body } = await post('/api/design/start', { scope: 'product' });
    assert.equal(status, 409);
    assert.ok(body.error.includes('already active'));
  });

  test('returns 400 for invalid scope', async () => {
    const { status, body } = await post('/api/design/start', { scope: 'bogus' });
    assert.equal(status, 400);
    assert.ok(body.error);
  });

  test('returns 400 for feature scope without featureCode', async () => {
    const { status, body } = await post('/api/design/start', { scope: 'feature' });
    assert.equal(status, 400);
    assert.ok(body.error.includes('featureCode'));
  });
});

// ---------------------------------------------------------------------------
// POST /api/design/message
// ---------------------------------------------------------------------------

describe('POST /api/design/message', () => {
  test('appends a text message', async () => {
    const { status, body } = await post('/api/design/message', {
      scope: 'product',
      type: 'text',
      content: 'Hello design',
    });
    assert.equal(status, 200);
    assert.ok(body.session);
    const msgs = body.session.messages;
    assert.ok(msgs.length >= 1);
    const last = msgs[msgs.length - 1];
    assert.equal(last.type, 'text');
    assert.equal(last.content, 'Hello design');
    assert.equal(last.role, 'human');
  });

  test('appends a card_select message and records decision', async () => {
    const { status, body } = await post('/api/design/message', {
      scope: 'product',
      type: 'card_select',
      cardId: 'card-1',
      comment: 'Looks good',
    });
    assert.equal(status, 200);
    assert.ok(body.session);
    const msgs = body.session.messages;
    const last = msgs[msgs.length - 1];
    assert.equal(last.type, 'card_select');
    assert.deepEqual(last.content, { cardId: 'card-1', comment: 'Looks good' });
    // Decision should be recorded
    const decisions = body.session.decisions;
    assert.ok(decisions.length >= 1);
    const lastDec = decisions[decisions.length - 1];
    assert.deepEqual(lastDec.selectedOption, { id: 'card-1' });
    assert.equal(lastDec.comment, 'Looks good');
  });

  test('returns 404 when no session exists', async () => {
    const { status, body } = await post('/api/design/message', {
      scope: 'feature',
      featureCode: 'NONEXISTENT',
      type: 'text',
      content: 'hello',
    });
    assert.equal(status, 404);
    assert.ok(body.error.includes('No session'));
  });

  test('returns 400 for invalid type', async () => {
    const { status, body } = await post('/api/design/message', {
      scope: 'product',
      type: 'invalid',
      content: 'hello',
    });
    assert.equal(status, 400);
    assert.ok(body.error);
  });
});

// ---------------------------------------------------------------------------
// GET /api/design/session
// ---------------------------------------------------------------------------

describe('GET /api/design/session', () => {
  test('returns null when no session exists', async () => {
    const { status, body } = await get('/api/design/session?scope=feature&featureCode=NOPE');
    assert.equal(status, 200);
    assert.equal(body.session, null);
  });

  test('returns session when active', async () => {
    // product session is active from earlier tests
    const { status, body } = await get('/api/design/session?scope=product');
    assert.equal(status, 200);
    assert.ok(body.session);
    assert.equal(body.session.scope, 'product');
    assert.equal(body.session.status, 'active');
  });
});

// ---------------------------------------------------------------------------
// POST /api/design/revise
// ---------------------------------------------------------------------------

describe('POST /api/design/revise', () => {
  test('marks a decision as superseded', async () => {
    // Start a feature session for this test
    await post('/api/design/start', { scope: 'feature', featureCode: 'REVISE-TEST' });
    // Record a decision via card_select
    await post('/api/design/message', {
      scope: 'feature',
      featureCode: 'REVISE-TEST',
      type: 'card_select',
      cardId: 'opt-A',
      comment: 'First choice',
    });

    const { status, body } = await post('/api/design/revise', {
      scope: 'feature',
      featureCode: 'REVISE-TEST',
      decisionIndex: 0,
    });
    assert.equal(status, 200);
    assert.ok(body.session);
    assert.equal(body.session.decisions[0].superseded, true);
  });

  test('returns 400 for missing decisionIndex', async () => {
    const { status, body } = await post('/api/design/revise', {
      scope: 'feature',
      featureCode: 'REVISE-TEST',
    });
    assert.equal(status, 400);
    assert.ok(body.error.includes('decisionIndex'));
  });

  test('returns 404 when no session exists', async () => {
    const { status, body } = await post('/api/design/revise', {
      scope: 'feature',
      featureCode: 'NONEXISTENT',
      decisionIndex: 0,
    });
    assert.equal(status, 404);
    assert.ok(body.error.includes('No session'));
  });
});

// ---------------------------------------------------------------------------
// POST /api/design/complete
// ---------------------------------------------------------------------------

describe('POST /api/design/complete', () => {
  test('completes an active session (no connector — skips doc generation)', async () => {
    const { status, body } = await post('/api/design/complete', { scope: 'product' });
    assert.equal(status, 200);
    assert.ok(body.session);
    assert.equal(body.session.status, 'complete');
    // Without a connector, no designDocPath is returned
    assert.equal(body.designDocPath, undefined);
  });

  test('returns 404 when no session exists', async () => {
    const { status, body } = await post('/api/design/complete', {
      scope: 'feature',
      featureCode: 'NOPE',
    });
    assert.equal(status, 404);
    assert.ok(body.error);
  });
});

// ---------------------------------------------------------------------------
// Completed session guards (Finding 2)
// ---------------------------------------------------------------------------

describe('Completed session guards', () => {
  // product session was completed in the previous describe block

  test('POST /api/design/message returns 409 on completed session', async () => {
    const { status, body } = await post('/api/design/message', {
      scope: 'product',
      type: 'text',
      content: 'This should be rejected',
    });
    assert.equal(status, 409);
    assert.ok(body.error.includes('complete'));
  });

  test('POST /api/design/revise returns 409 on completed session', async () => {
    // Start and complete a feature session for this test
    await post('/api/design/start', { scope: 'feature', featureCode: 'GUARD-TEST' });
    await post('/api/design/message', {
      scope: 'feature',
      featureCode: 'GUARD-TEST',
      type: 'card_select',
      cardId: 'opt-X',
      comment: 'pick',
    });
    await post('/api/design/complete', { scope: 'feature', featureCode: 'GUARD-TEST' });

    const { status, body } = await post('/api/design/revise', {
      scope: 'feature',
      featureCode: 'GUARD-TEST',
      decisionIndex: 0,
    });
    assert.equal(status, 409);
    assert.ok(body.error.includes('completed'));
  });
});

// ---------------------------------------------------------------------------
// GET /api/design/stream
// ---------------------------------------------------------------------------

describe('GET /api/design/stream', () => {
  test('sets correct SSE headers', async () => {
    const controller = new AbortController();
    const r = fetch(`${baseUrl}/api/design/stream`, {
      signal: controller.signal,
      headers: { Connection: 'close' },
    });
    const res = await r;
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    controller.abort();
  });
});
