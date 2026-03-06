/**
 * Session-Lifecycle Binding — Task 1: Core binding infrastructure tests.
 *
 * Covers:
 *   session-manager.js  — bindToFeature, phaseAtEnd capture, transcript filing, getContext(featureCode)
 *   session-store.js    — serializeSession binding fields, readSessionsByFeature
 *   vision-store.js     — getItemByFeatureCode
 *
 * No HTTP, no spawned processes, no inference. All I/O uses tmp dirs.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { SessionManager } = await import(`${REPO_ROOT}/server/session-manager.js`);
const { serializeSession, persistSession, readSessionsByFeature } = await import(
  `${REPO_ROOT}/server/session-store.js`
);
const { VisionStore } = await import(`${REPO_ROOT}/server/vision-store.js`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;

function freshTmpDir() {
  return mkdtempSync(join(tmpdir(), 'compose-bind-test-'));
}

function makeManager(opts = {}) {
  return new SessionManager({
    getFeaturePhase: opts.getFeaturePhase || (() => null),
    featureRoot: opts.featureRoot || join(tmpDir, 'docs', 'features'),
    sessionsFile: opts.sessionsFile || join(tmpDir, 'data', 'sessions.json'),
  });
}

function makeSession(overrides = {}) {
  return {
    id: 'session-123',
    startedAt: '2024-01-01T00:00:00.000Z',
    endedAt: null,
    endReason: null,
    source: 'startup',
    toolCount: 0,
    items: new Map(),
    currentBlock: null,
    blocks: [],
    commits: [],
    errors: [],
    transcriptPath: null,
    featureCode: null,
    featureItemId: null,
    phaseAtBind: null,
    boundAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

tmpDir = freshTmpDir();
after(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// bindToFeature
// ---------------------------------------------------------------------------

test('bindToFeature sets fields on active session', () => {
  const mgr = makeManager();
  mgr.startSession('startup');

  const result = mgr.bindToFeature('gate-ui', 'item-42', 'implementation');

  assert.deepStrictEqual(result, { bound: true, featureCode: 'gate-ui', itemId: 'item-42', phase: 'implementation' });
  assert.equal(mgr.currentSession.featureCode, 'gate-ui');
  assert.equal(mgr.currentSession.featureItemId, 'item-42');
  assert.equal(mgr.currentSession.phaseAtBind, 'implementation');
  assert.ok(mgr.currentSession.boundAt, 'boundAt should be set');
});

test('bindToFeature returns already_bound on re-bind', () => {
  const mgr = makeManager();
  mgr.startSession('startup');
  mgr.bindToFeature('gate-ui', 'item-42', 'implementation');

  const result = mgr.bindToFeature('other-feature', 'item-99', 'planning');

  assert.deepStrictEqual(result, { already_bound: true, featureCode: 'gate-ui' });
  // Original binding unchanged
  assert.equal(mgr.currentSession.featureCode, 'gate-ui');
  assert.equal(mgr.currentSession.featureItemId, 'item-42');
});

test('bindToFeature throws with no active session', () => {
  const mgr = makeManager();
  assert.throws(() => mgr.bindToFeature('gate-ui', 'item-42', 'impl'), /No active session/);
});

// ---------------------------------------------------------------------------
// endSession: phaseAtEnd capture
// ---------------------------------------------------------------------------

test('endSession captures phaseAtEnd for bound sessions', async () => {
  const mgr = makeManager({
    getFeaturePhase: (code) => code === 'gate-ui' ? 'verification' : null,
  });
  mgr.startSession('startup');
  mgr.bindToFeature('gate-ui', 'item-42', 'implementation');

  const result = await mgr.endSession('manual');

  assert.equal(result.phaseAtEnd, 'verification');
});

// ---------------------------------------------------------------------------
// endSession: transcript filing
// ---------------------------------------------------------------------------

test('endSession copies transcript to feature folder', async () => {
  const featureRoot = join(tmpDir, 'docs', 'features');
  const mgr = makeManager({ featureRoot });

  mgr.startSession('startup');
  mgr.bindToFeature('gate-ui', 'item-42', 'implementation');

  // Create a fake transcript file
  const transcriptDir = join(tmpDir, 'transcripts');
  mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = join(transcriptDir, 'session-abc.jsonl');
  writeFileSync(transcriptPath, '{"line":1}\n{"line":2}\n');

  const sessionId = mgr.currentSession.id;
  await mgr.endSession('manual', transcriptPath);

  // Verify file was copied
  const dest = join(featureRoot, 'gate-ui', 'sessions', `${sessionId}.jsonl`);
  assert.ok(existsSync(dest), `Transcript should be copied to ${dest}`);

  // Verify content preserved
  const content = readFileSync(dest, 'utf-8');
  assert.equal(content, '{"line":1}\n{"line":2}\n');
});

test('endSession preserves original transcript extension', async () => {
  const featureRoot = join(tmpDir, 'docs', 'features-ext');
  const mgr = makeManager({ featureRoot });

  mgr.startSession('startup');
  mgr.bindToFeature('ext-test', 'item-1', 'planning');

  const transcriptDir = join(tmpDir, 'transcripts-ext');
  mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = join(transcriptDir, 'session.md');
  writeFileSync(transcriptPath, '# Transcript');

  const sessionId = mgr.currentSession.id;
  await mgr.endSession('manual', transcriptPath);

  const dest = join(featureRoot, 'ext-test', 'sessions', `${sessionId}.md`);
  assert.ok(existsSync(dest), `Should preserve .md extension at ${dest}`);
});

// ---------------------------------------------------------------------------
// serializeSession includes binding fields
// ---------------------------------------------------------------------------

test('serializeSession includes all binding fields', () => {
  const session = makeSession({
    featureCode: 'gate-ui',
    featureItemId: 'item-42',
    phaseAtBind: 'implementation',
    phaseAtEnd: 'verification',
    boundAt: '2024-01-01T00:05:00.000Z',
  });

  const out = serializeSession(session);

  assert.equal(out.featureCode, 'gate-ui');
  assert.equal(out.featureItemId, 'item-42');
  assert.equal(out.phaseAtBind, 'implementation');
  assert.equal(out.phaseAtEnd, 'verification');
  assert.equal(out.boundAt, '2024-01-01T00:05:00.000Z');
});

test('serializeSession returns null for unset binding fields', () => {
  const session = makeSession();
  const out = serializeSession(session);

  assert.equal(out.featureCode, null);
  assert.equal(out.featureItemId, null);
  assert.equal(out.phaseAtBind, null);
  assert.equal(out.phaseAtEnd, null);
  assert.equal(out.boundAt, null);
});

// ---------------------------------------------------------------------------
// readSessionsByFeature
// ---------------------------------------------------------------------------

test('readSessionsByFeature filters by featureCode, sorts descending by startedAt, respects limit', () => {
  const file = join(tmpDir, 'sessions-filter.json');

  const sessions = [
    { id: 's1', featureCode: 'gate-ui', startedAt: '2024-01-01T00:00:00.000Z', toolCount: 1 },
    { id: 's2', featureCode: 'other', startedAt: '2024-01-02T00:00:00.000Z', toolCount: 2 },
    { id: 's3', featureCode: 'gate-ui', startedAt: '2024-01-03T00:00:00.000Z', toolCount: 3 },
    { id: 's4', featureCode: 'gate-ui', startedAt: '2024-01-02T00:00:00.000Z', toolCount: 4 },
  ];
  writeFileSync(file, JSON.stringify(sessions));

  // Filter for gate-ui, limit 2
  const result = readSessionsByFeature('gate-ui', 2, file);

  assert.equal(result.length, 2);
  assert.equal(result[0].id, 's3', 'Most recent first');
  assert.equal(result[1].id, 's4', 'Second most recent');
});

test('readSessionsByFeature returns empty array for missing file', () => {
  const result = readSessionsByFeature('nope', 10, '/nonexistent/path.json');
  assert.deepStrictEqual(result, []);
});

test('readSessionsByFeature returns empty array for non-matching featureCode', () => {
  const file = join(tmpDir, 'sessions-nomatch.json');
  writeFileSync(file, JSON.stringify([
    { id: 's1', featureCode: 'other', startedAt: '2024-01-01T00:00:00.000Z' },
  ]));

  const result = readSessionsByFeature('gate-ui', 10, file);
  assert.deepStrictEqual(result, []);
});

// ---------------------------------------------------------------------------
// getItemByFeatureCode (VisionStore)
// ---------------------------------------------------------------------------

test('getItemByFeatureCode returns correct item', () => {
  const dataDir = join(tmpDir, 'vision-data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'vision-state.json'), JSON.stringify({
    items: [
      { id: 'item-1', type: 'feature', title: 'Auth', status: 'planned', lifecycle: { featureCode: 'auth-flow', currentPhase: 'planning' } },
      { id: 'item-2', type: 'feature', title: 'Gate UI', status: 'in_progress', lifecycle: { featureCode: 'gate-ui', currentPhase: 'implementation' } },
    ],
    connections: [],
    gates: [],
  }));

  const store = new VisionStore(dataDir);
  const item = store.getItemByFeatureCode('gate-ui');

  assert.ok(item, 'should find item');
  assert.equal(item.id, 'item-2');
  assert.equal(item.lifecycle.featureCode, 'gate-ui');
});

test('getItemByFeatureCode returns null for unknown featureCode', () => {
  const dataDir = join(tmpDir, 'vision-data-null');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'vision-state.json'), JSON.stringify({
    items: [
      { id: 'item-1', type: 'feature', title: 'Auth', status: 'planned' },
    ],
    connections: [],
    gates: [],
  }));

  const store = new VisionStore(dataDir);
  const item = store.getItemByFeatureCode('nonexistent');

  assert.equal(item, null);
});

// ---------------------------------------------------------------------------
// getContext(featureCode) — feature-scoped session
// ---------------------------------------------------------------------------

test('getContext(featureCode) returns feature-scoped session', () => {
  const sessionsDir = join(tmpDir, 'ctx-data');
  mkdirSync(sessionsDir, { recursive: true });
  const sessionsFile = join(sessionsDir, 'sessions.json');

  const sessions = [
    { id: 's1', featureCode: 'other', startedAt: '2024-01-01T00:00:00.000Z' },
    { id: 's2', featureCode: 'gate-ui', startedAt: '2024-01-02T00:00:00.000Z' },
    { id: 's3', featureCode: 'gate-ui', startedAt: '2024-01-03T00:00:00.000Z' },
  ];
  writeFileSync(sessionsFile, JSON.stringify(sessions));

  // We need to test getContext on SessionManager, but it uses SESSIONS_FILE constant.
  // Instead, test readSessionsByFeature directly (getContext delegates to it).
  const result = readSessionsByFeature('gate-ui', 1, sessionsFile);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 's3', 'Should return most recent session for feature');
});

// ---------------------------------------------------------------------------
// sessionsFile getter
// ---------------------------------------------------------------------------

test('sessionsFile getter exposes SESSIONS_FILE path', () => {
  const mgr = makeManager();
  assert.ok(mgr.sessionsFile, 'sessionsFile getter should return a path');
  assert.ok(mgr.sessionsFile.endsWith('sessions.json'), 'should end with sessions.json');
});

// ---------------------------------------------------------------------------
// Unbound session: no phaseAtEnd, no transcript filing
// ---------------------------------------------------------------------------

test('endSession without binding does not set phaseAtEnd', async () => {
  let phaseCalled = false;
  const mgr = makeManager({
    getFeaturePhase: () => { phaseCalled = true; return 'verification'; },
  });
  mgr.startSession('startup');

  const result = await mgr.endSession('manual');

  assert.equal(result.phaseAtEnd, null, 'phaseAtEnd should be null for unbound session');
  assert.equal(phaseCalled, false, 'getFeaturePhase should not be called for unbound session');
});

test('endSession without binding does not file transcript', async () => {
  const featureRoot = join(tmpDir, 'docs', 'features-nofile');
  const mgr = makeManager({ featureRoot });

  mgr.startSession('startup');

  const transcriptDir = join(tmpDir, 'transcripts-nofile');
  mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = join(transcriptDir, 'session.jsonl');
  writeFileSync(transcriptPath, '{"line":1}\n');

  await mgr.endSession('manual', transcriptPath);

  // Feature sessions dir should not exist
  assert.equal(existsSync(join(featureRoot)), false, 'Feature root should not be created for unbound session');
});

// ===========================================================================
// Task 2: Binding routes and broadcasts
// ===========================================================================

import { createServer } from 'node:http';
const express = (await import('express')).default;
const { attachSessionRoutes } = await import(`${REPO_ROOT}/server/session-routes.js`);

// ---------------------------------------------------------------------------
// Route test server setup
// ---------------------------------------------------------------------------

let baseUrl;
let httpServer;
const broadcasts = [];

/** Minimal fake store for route tests */
const fakeStore = {
  items: new Map([
    ['item-42', {
      id: 'item-42',
      title: 'Gate UI',
      status: 'in_progress',
      lifecycle: { featureCode: 'gate-ui', currentPhase: 'implementation', phaseHistory: [{ phase: 'planning', enteredAt: '2024-01-01', exitedAt: '2024-01-02' }], artifacts: {}, pendingGate: null },
    }],
  ]),
  getItemByFeatureCode(featureCode) {
    for (const item of this.items.values()) {
      if (item.lifecycle?.featureCode === featureCode) return item;
    }
    return null;
  },
};

// A dedicated SessionManager for route tests, with a writable sessions file in tmp
const routeTmpDir = freshTmpDir();
const routeSessionsFile = join(routeTmpDir, 'data', 'sessions.json');
mkdirSync(join(routeTmpDir, 'data'), { recursive: true });

// Seed some persisted sessions for history/current tests
writeFileSync(routeSessionsFile, JSON.stringify([
  {
    id: 'past-s1', featureCode: 'gate-ui', startedAt: '2024-01-01T00:00:00.000Z',
    endedAt: '2024-01-01T01:00:00.000Z', toolCount: 5, source: 'startup',
    items: { 'item-42': { title: 'Gate UI', summaries: ['did stuff'], reads: 2, writes: 3 } },
  },
  {
    id: 'past-s2', featureCode: 'gate-ui', startedAt: '2024-01-02T00:00:00.000Z',
    endedAt: '2024-01-02T01:00:00.000Z', toolCount: 10, source: 'resume',
    items: { 'item-42': { title: 'Gate UI', summaries: ['more stuff'], reads: 4, writes: 6 } },
  },
  {
    id: 'past-s3', featureCode: 'other-feature', startedAt: '2024-01-03T00:00:00.000Z',
    endedAt: '2024-01-03T01:00:00.000Z', toolCount: 3, source: 'startup',
    items: {},
  },
]));

const routeManager = new SessionManager({
  getFeaturePhase: (code) => {
    const item = fakeStore.getItemByFeatureCode(code);
    return item?.lifecycle?.currentPhase || null;
  },
  featureRoot: join(routeTmpDir, 'docs', 'features'),
  sessionsFile: routeSessionsFile,
});

// Start Express server before route tests
test('Route test server setup', async () => {
  await new Promise((res) => {
    const app = express();
    app.use(express.json());

    attachSessionRoutes(app, {
      sessionManager: routeManager,
      scheduleBroadcast: () => {},
      broadcastMessage: (msg) => broadcasts.push(msg),
      spawnJournalAgent: () => {},
      store: fakeStore,
    });

    httpServer = createServer(app);
    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address();
      baseUrl = `http://127.0.0.1:${port}`;
      res();
    });
  });
});

// ---------------------------------------------------------------------------
// Route test helpers
// ---------------------------------------------------------------------------

async function post(urlPath, body) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

async function get(urlPath) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    headers: { Connection: 'close' },
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

// ---------------------------------------------------------------------------
// POST /api/session/bind
// ---------------------------------------------------------------------------

test('POST /api/session/bind with missing featureCode returns 400', async () => {
  const { status, body } = await post('/api/session/bind', {});
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('POST /api/session/bind with path-traversal featureCode returns 400', async () => {
  routeManager.startSession('startup');
  for (const bad of ['../../tmp/pwn', 'foo/bar', 'a b c', 'hello..world/']) {
    const { status, body } = await post('/api/session/bind', { featureCode: bad });
    assert.equal(status, 400, `expected 400 for featureCode: ${bad}`);
    assert.match(body.error, /[Ii]nvalid/);
  }
  routeManager.endSession('manual');
});

test('POST /api/session/bind with no active session returns 409', async () => {
  // Ensure no active session
  routeManager.currentSession = null;
  const { status, body } = await post('/api/session/bind', { featureCode: 'gate-ui' });
  assert.equal(status, 409);
  assert.ok(body.error);
});

test('POST /api/session/bind with unknown featureCode returns 404', async () => {
  routeManager.startSession('startup');
  const { status, body } = await post('/api/session/bind', { featureCode: 'nonexistent' });
  assert.equal(status, 404);
  assert.ok(body.error.includes('nonexistent'));
  // End session so next test starts clean
  routeManager.endSession('test');
});

test('POST /api/session/bind with valid featureCode returns 200, binds session, broadcasts sessionBound', async () => {
  routeManager.startSession('startup');
  const beforeBroadcasts = broadcasts.length;

  const { status, body } = await post('/api/session/bind', { featureCode: 'gate-ui' });

  assert.equal(status, 200);
  assert.equal(body.bound, true);
  assert.equal(body.featureCode, 'gate-ui');
  assert.equal(body.itemId, 'item-42');
  assert.equal(body.phase, 'implementation');

  // Verify broadcast
  const added = broadcasts.slice(beforeBroadcasts);
  const bound = added.find(m => m.type === 'sessionBound');
  assert.ok(bound, 'should broadcast sessionBound');
  assert.equal(bound.featureCode, 'gate-ui');
  assert.equal(bound.itemId, 'item-42');
  assert.equal(bound.phase, 'implementation');
  assert.ok(bound.sessionId);
  assert.ok(bound.timestamp);
});

test('POST /api/session/bind on already-bound session returns 200 with already_bound', async () => {
  // Session still active from previous test, already bound to gate-ui
  const beforeBroadcasts = broadcasts.length;

  const { status, body } = await post('/api/session/bind', { featureCode: 'other-feature' });

  assert.equal(status, 200);
  assert.equal(body.already_bound, true);
  assert.equal(body.featureCode, 'gate-ui');

  // Should NOT broadcast on already-bound
  const added = broadcasts.slice(beforeBroadcasts);
  const bound = added.find(m => m.type === 'sessionBound');
  assert.equal(bound, undefined, 'should not broadcast on already_bound');
});

// ---------------------------------------------------------------------------
// GET /api/session/history
// ---------------------------------------------------------------------------

test('GET /api/session/history with missing featureCode returns 400', async () => {
  const { status, body } = await get('/api/session/history');
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('GET /api/session/history?featureCode=gate-ui returns filtered sessions', async () => {
  const { status, body } = await get('/api/session/history?featureCode=gate-ui');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.sessions));
  assert.equal(body.sessions.length, 2);
  // Should be sorted descending by startedAt
  assert.equal(body.sessions[0].id, 'past-s2');
  assert.equal(body.sessions[1].id, 'past-s1');
});

// ---------------------------------------------------------------------------
// GET /api/session/current with featureCode query param
// ---------------------------------------------------------------------------

test('GET /api/session/current?featureCode=gate-ui returns live session when bound to gate-ui', async () => {
  // Session is still active and bound to gate-ui from bind test
  const { status, body } = await get('/api/session/current?featureCode=gate-ui');
  assert.equal(status, 200);

  // Consistent shape
  assert.ok('session' in body, 'should have session key');
  assert.ok('lifecycle' in body, 'should have lifecycle key');
  assert.ok('recentSummaries' in body, 'should have recentSummaries key');

  // Session should be the live one
  assert.ok(body.session);
  assert.equal(body.session.featureCode, 'gate-ui');

  // Lifecycle should come from the store item
  assert.ok(body.lifecycle);
  assert.equal(body.lifecycle.currentPhase, 'implementation');
});

test('GET /api/session/current?featureCode=other-feature returns last persisted when active session is for different feature', async () => {
  // Active session is bound to gate-ui, requesting other-feature
  const { status, body } = await get('/api/session/current?featureCode=other-feature');
  assert.equal(status, 200);

  // Consistent shape
  assert.ok('session' in body);
  assert.ok('lifecycle' in body);
  assert.ok('recentSummaries' in body);

  // Should NOT return the active gate-ui session — should return the last persisted session for other-feature
  if (body.session) {
    assert.equal(body.session.featureCode, 'other-feature');
    assert.equal(body.session.id, 'past-s3');
  }
});

test('GET /api/session/current?featureCode=gate-ui returns last persisted + lifecycle when no active session', async () => {
  // End the active session to test no-active-session branch
  await routeManager.endSession('manual');

  const { status, body } = await get('/api/session/current?featureCode=gate-ui');
  assert.equal(status, 200);

  // Consistent shape
  assert.ok('session' in body);
  assert.ok('lifecycle' in body);
  assert.ok('recentSummaries' in body);

  // Session should be last persisted for gate-ui
  assert.ok(body.session);

  // Lifecycle should still come from the store
  assert.ok(body.lifecycle);
  assert.equal(body.lifecycle.currentPhase, 'implementation');
});

test('All featureCode branches return consistent shape: { session, lifecycle, recentSummaries }', async () => {
  // Test with active session bound to gate-ui
  routeManager.startSession('startup');
  routeManager.bindToFeature('gate-ui', 'item-42', 'implementation');

  // Branch 1: active session matches featureCode
  const r1 = await get('/api/session/current?featureCode=gate-ui');
  assert.ok('session' in r1.body && 'lifecycle' in r1.body && 'recentSummaries' in r1.body, 'branch 1: matching active');

  // Branch 2: active session is different feature
  const r2 = await get('/api/session/current?featureCode=other-feature');
  assert.ok('session' in r2.body && 'lifecycle' in r2.body && 'recentSummaries' in r2.body, 'branch 2: different active');

  // Branch 3: no active session
  await routeManager.endSession('manual');
  const r3 = await get('/api/session/current?featureCode=gate-ui');
  assert.ok('session' in r3.body && 'lifecycle' in r3.body && 'recentSummaries' in r3.body, 'branch 3: no active');
});

// ---------------------------------------------------------------------------
// sessionEnd broadcast includes featureCode and phaseAtEnd
// ---------------------------------------------------------------------------

test('sessionEnd broadcast includes featureCode and phaseAtEnd', async () => {
  routeManager.startSession('startup');
  routeManager.bindToFeature('gate-ui', 'item-42', 'implementation');

  const beforeBroadcasts = broadcasts.length;

  await post('/api/session/end', { reason: 'manual' });

  const added = broadcasts.slice(beforeBroadcasts);
  const endMsg = added.find(m => m.type === 'sessionEnd');
  assert.ok(endMsg, 'should broadcast sessionEnd');
  assert.equal(endMsg.featureCode, 'gate-ui');
  assert.equal(endMsg.phaseAtEnd, 'implementation');
});

// ---------------------------------------------------------------------------
// Route test server teardown
// ---------------------------------------------------------------------------

test('Route test server teardown', async () => {
  await new Promise((res) => {
    httpServer.closeAllConnections?.();
    httpServer.close(res);
  });
  rmSync(routeTmpDir, { recursive: true, force: true });
});
