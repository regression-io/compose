/**
 * HTTP regression tests for activity-routes.js (POST /api/agent/activity,
 * POST /api/agent/error) and agent-spawn.js (GET /api/agents, GET /api/agent/:id).
 *
 * Spins up a real Express server on an ephemeral port; no mocking framework.
 * Uses Node 18+ built-in fetch.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Dynamic imports
const express = (await import('express')).default;
const { attachActivityRoutes } = await import(`${REPO_ROOT}/server/activity-routes.js`);
const { attachAgentSpawnRoutes } = await import(`${REPO_ROOT}/server/agent-spawn.js`);

// ---------------------------------------------------------------------------
// Test server setup
// ---------------------------------------------------------------------------

let baseUrl;
let httpServer;

/** Captured broadcasts */
const broadcasts = [];

/** Minimal fake store */
const fakeStore = {
  items: new Map([
    ['COMPOSE-TASK-1', { id: 'COMPOSE-TASK-1', title: 'Task One', status: 'planned', files: ['src/app.js'], slug: null, updatedAt: new Date().toISOString() }],
    ['COMPOSE-TASK-2', { id: 'COMPOSE-TASK-2', title: 'Task Two', status: 'in_progress', files: ['src/lib/'], slug: null, updatedAt: new Date().toISOString() }],
  ]),
  updateItem(id, patch) {
    const item = this.items.get(id);
    if (item) Object.assign(item, patch);
  },
};

/** Minimal fake sessionManager */
const fakeSM = {
  activities: [],
  errors: [],
  recordActivity(...args) { this.activities.push(args); },
  recordError(...args)   { this.errors.push(args); },
};

/** Fake resolveItems: returns items whose files include the path */
function resolveItems(filePath) {
  const rel = filePath.replace(/^\.\//, '');
  const out = [];
  for (const item of fakeStore.items.values()) {
    for (const pattern of item.files || []) {
      if (pattern.endsWith('/') ? rel.startsWith(pattern) : rel === pattern) {
        out.push(item);
        break;
      }
    }
  }
  return out;
}

before(() => new Promise(res => {
  const app = express();
  app.use(express.json());

  attachActivityRoutes(app, {
    store: fakeStore,
    sessionManager: fakeSM,
    scheduleBroadcast: () => {},
    broadcastMessage: (msg) => broadcasts.push(msg),
    resolveItems,
  });

  // requireSensitiveToken: always approve in tests
  attachAgentSpawnRoutes(app, {
    projectRoot: REPO_ROOT,
    broadcastMessage: (msg) => broadcasts.push(msg),
    requireSensitiveToken: (_req, _res, next) => next(),
  });

  httpServer = createServer(app);
  httpServer.listen(0, '127.0.0.1', () => {
    const { port } = httpServer.address();
    baseUrl = `http://127.0.0.1:${port}`;
    res();
  });
}));

after(() => new Promise(res => httpServer.close(res)));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function post(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function get(path) {
  return fetch(`${baseUrl}${path}`);
}

// ---------------------------------------------------------------------------
// POST /api/agent/activity
// ---------------------------------------------------------------------------

test('POST /api/agent/activity — missing tool returns 400', async () => {
  const res = await post('/api/agent/activity', {});
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'tool is required');
});

test('POST /api/agent/activity — Read tool returns 200 and ok:true', async () => {
  const res = await post('/api/agent/activity', {
    tool: 'Read',
    input: { file_path: 'src/app.js' },
    timestamp: new Date().toISOString(),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test('POST /api/agent/activity — records activity in sessionManager', async () => {
  const before = fakeSM.activities.length;
  await post('/api/agent/activity', {
    tool: 'Edit',
    input: { file_path: 'src/app.js' },
  });
  assert.equal(fakeSM.activities.length, before + 1);
  const last = fakeSM.activities.at(-1);
  assert.equal(last[0], 'Edit');   // tool
  assert.equal(last[1], 'writing'); // category
});

test('POST /api/agent/activity — broadcasts agentActivity message', async () => {
  const before = broadcasts.length;
  await post('/api/agent/activity', {
    tool: 'Bash',
    input: { command: 'npm test' },
  });
  const added = broadcasts.slice(before);
  const activity = added.find(m => m.type === 'agentActivity');
  assert.ok(activity, 'should broadcast agentActivity');
  assert.equal(activity.tool, 'Bash');
  assert.equal(activity.category, 'executing');
});

test('POST /api/agent/activity — Write on planned item auto-updates to in_progress', async () => {
  // Reset to planned (earlier tests may have already promoted this item)
  fakeStore.items.get('COMPOSE-TASK-1').status = 'planned';
  await post('/api/agent/activity', {
    tool: 'Write',
    input: { file_path: 'src/app.js' },
  });
  assert.equal(fakeStore.items.get('COMPOSE-TASK-1').status, 'in_progress');
});

test('POST /api/agent/activity — detects error in response text', async () => {
  const before = broadcasts.length;
  await post('/api/agent/activity', {
    tool: 'Bash',
    input: { command: 'node build.js' },
    response: 'SyntaxError: Unexpected token } in JSON',
  });
  const added = broadcasts.slice(before);
  const errMsg = added.find(m => m.type === 'agentError');
  assert.ok(errMsg, 'should broadcast agentError');
  assert.equal(errMsg.errorType, 'build_error');
  assert.equal(errMsg.severity, 'error');
  // sessionManager should also have it
  const lastErr = fakeSM.errors.at(-1);
  assert.ok(lastErr, 'sessionManager should record error');
});

test('POST /api/agent/activity — non-error response broadcasts no agentError', async () => {
  const before = broadcasts.length;
  await post('/api/agent/activity', {
    tool: 'Bash',
    input: { command: 'echo hello' },
    response: 'hello',
  });
  const added = broadcasts.slice(before);
  assert.equal(added.filter(m => m.type === 'agentError').length, 0);
});

test('POST /api/agent/activity — unrecognized tool gets thinking category', async () => {
  const before = broadcasts.length;
  await post('/api/agent/activity', { tool: 'SomeNewTool', input: {} });
  const added = broadcasts.slice(before);
  const activity = added.find(m => m.type === 'agentActivity');
  assert.equal(activity?.category, 'thinking');
});

// ---------------------------------------------------------------------------
// POST /api/agent/error
// ---------------------------------------------------------------------------

test('POST /api/agent/error — missing tool returns 400', async () => {
  const res = await post('/api/agent/error', {});
  assert.equal(res.status, 400);
});

test('POST /api/agent/error — records in sessionManager', async () => {
  const before = fakeSM.errors.length;
  await post('/api/agent/error', {
    tool: 'Write',
    input: { file_path: 'src/app.js' },
    error: 'EACCES: permission denied',
  });
  assert.equal(fakeSM.errors.length, before + 1);
});

test('POST /api/agent/error — broadcasts agentError message', async () => {
  const before = broadcasts.length;
  await post('/api/agent/error', {
    tool: 'Bash',
    error: 'npm ERR! code ENOENT',
  });
  const added = broadcasts.slice(before);
  const errMsg = added.find(m => m.type === 'agentError');
  assert.ok(errMsg, 'should broadcast agentError');
  assert.ok(errMsg.errorType);
  assert.ok(errMsg.severity);
});

test('POST /api/agent/error — returns ok:true with detected error info', async () => {
  const res = await post('/api/agent/error', {
    tool: 'Bash',
    error: 'SyntaxError: unexpected token',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.detected?.type);
});

// ---------------------------------------------------------------------------
// GET /api/agents (agent-spawn)
// ---------------------------------------------------------------------------

test('GET /api/agents returns empty array initially', async () => {
  const res = await get('/api/agents');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.agents));
});

test('GET /api/agent/:id returns 404 for unknown agent', async () => {
  const res = await get('/api/agent/nonexistent-id');
  assert.equal(res.status, 404);
});
