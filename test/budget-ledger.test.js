/**
 * budget-ledger.test.js — Unit + integration tests for COMP-BUDGET.
 *
 * Run: node --test test/budget-ledger.test.js 2>&1 | tail -20
 *
 * Coverage:
 *   - readLedger returns empty on missing file
 *   - recordIteration creates ledger and appends
 *   - checkCumulativeBudget returns exceeded when over limit
 *   - wall-clock timeout triggers at report time (route integration)
 *   - action count ceiling triggers at report time (route integration)
 *   - cumulative budget blocks iteration start when exceeded (route integration)
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { readLedger, recordIteration, checkCumulativeBudget } = await import(`${REPO_ROOT}/lib/budget-ledger.js`);
const { VisionStore } = await import(`${REPO_ROOT}/server/vision-store.js`);
const { SettingsStore } = await import(`${REPO_ROOT}/server/settings-store.js`);
const { attachVisionRoutes } = await import(`${REPO_ROOT}/server/vision-routes.js`);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Make a temporary .compose directory (what budget-ledger functions accept).
 * Returns the composeDir path.
 */
function makeLedgerDir() {
  const composeDir = mkdtempSync(join(tmpdir(), 'ledger-test-'));
  mkdirSync(join(composeDir, 'data'), { recursive: true });
  return composeDir;
}

/**
 * Make a full projectRoot with .compose/ subdirectory for route integration tests.
 * Returns { projectRoot, composeDir }.
 */
function makeProjectRoot() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'route-test-'));
  const composeDir = join(projectRoot, '.compose');
  mkdirSync(join(composeDir, 'data'), { recursive: true });
  mkdirSync(join(projectRoot, 'docs', 'features', 'TEST-1'), { recursive: true });
  return { projectRoot, composeDir };
}

function setupServer(projectRoot, settingsContract) {
  const composeDir = join(projectRoot, '.compose');
  const dataDir = join(composeDir, 'data');

  const store = new VisionStore(dataDir);
  const contract = settingsContract ?? {
    phases: [{ id: 'execute', defaultPolicy: null }],
    iterationDefaults: {
      review: { maxIterations: 4, timeout: 15, maxTotal: 20 },
      coverage: { maxIterations: 15, timeout: 30, maxTotal: 50 },
    },
    policyModes: ['gate', 'flag', 'skip'],
  };
  const settingsStore = new SettingsStore(dataDir, contract);

  const app = express();
  app.use(express.json());

  let lastBroadcast = null;
  const broadcastMessage = (msg) => { lastBroadcast = msg; };
  const scheduleBroadcast = () => {};

  attachVisionRoutes(app, {
    store, scheduleBroadcast, broadcastMessage,
    projectRoot, settingsStore,
  });

  const server = http.createServer(app);
  return new Promise(resolve => server.listen(0, () => resolve({ server, store, get lastBroadcast() { return lastBroadcast; } })));
}

function post(server, urlPath, body = {}) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', d => buf += d);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode, body: buf }); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function addItem(store) {
  const item = store.createItem({ type: 'feature', title: 'Test Item', status: 'planned' });
  store.updateLifecycle(item.id, {
    featureCode: 'TEST-1',
    currentPhase: 'execute',
    startedAt: new Date().toISOString(),
  });
  return item.id;
}

// ── Unit Tests: budget-ledger.js ─────────────────────────────────────────────

describe('readLedger', () => {
  test('returns empty structure when file is missing', () => {
    const dir = makeLedgerDir();
    try {
      const ledger = readLedger(dir);
      assert.deepEqual(ledger, { features: {} });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reads existing ledger file', () => {
    const dir = makeLedgerDir();
    try {
      recordIteration(dir, 'FEAT-1', { iterations: 2, actions: 10, timeMs: 5000 });
      const ledger = readLedger(dir);
      assert.ok(ledger.features['FEAT-1']);
      assert.equal(ledger.features['FEAT-1'].totalIterations, 2);
      assert.equal(ledger.features['FEAT-1'].totalActions, 10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('recordIteration', () => {
  test('creates ledger file on first call', () => {
    const dir = makeLedgerDir();
    try {
      const ledgerFile = join(dir, 'data', 'budget-ledger.json');
      assert.ok(!existsSync(ledgerFile), 'ledger should not exist yet');
      recordIteration(dir, 'FEAT-A', { iterations: 1, actions: 5, timeMs: 1000 });
      assert.ok(existsSync(ledgerFile), 'ledger should now exist');
      const raw = JSON.parse(readFileSync(ledgerFile, 'utf-8'));
      assert.equal(raw.features['FEAT-A'].totalIterations, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('appends to existing ledger', () => {
    const dir = makeLedgerDir();
    try {
      recordIteration(dir, 'FEAT-B', { iterations: 2, actions: 8, timeMs: 2000 });
      recordIteration(dir, 'FEAT-B', { iterations: 3, actions: 12, timeMs: 3000 });
      const ledger = readLedger(dir);
      const feat = ledger.features['FEAT-B'];
      assert.equal(feat.totalIterations, 5);
      assert.equal(feat.totalActions, 20);
      assert.equal(feat.totalTimeMs, 5000);
      assert.equal(feat.sessions.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('accumulates across different features independently', () => {
    const dir = makeLedgerDir();
    try {
      recordIteration(dir, 'FEAT-X', { iterations: 3, actions: 0, timeMs: 0 });
      recordIteration(dir, 'FEAT-Y', { iterations: 7, actions: 0, timeMs: 0 });
      const ledger = readLedger(dir);
      assert.equal(ledger.features['FEAT-X'].totalIterations, 3);
      assert.equal(ledger.features['FEAT-Y'].totalIterations, 7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checkCumulativeBudget', () => {
  test('returns not exceeded when under limits', () => {
    const dir = makeLedgerDir();
    try {
      recordIteration(dir, 'FEAT-C', { iterations: 5, actions: 50, timeMs: 0 });
      const result = checkCumulativeBudget(dir, 'FEAT-C', { maxTotalIterations: 10, maxTotalActions: 100 });
      assert.equal(result.exceeded, false);
      assert.equal(result.reason, null);
      assert.equal(result.usage.totalIterations, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns exceeded when totalIterations >= maxTotalIterations', () => {
    const dir = makeLedgerDir();
    try {
      recordIteration(dir, 'FEAT-D', { iterations: 10, actions: 0, timeMs: 0 });
      const result = checkCumulativeBudget(dir, 'FEAT-D', { maxTotalIterations: 10 });
      assert.equal(result.exceeded, true);
      assert.ok(result.reason.includes('10/10'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns exceeded when totalActions >= maxTotalActions', () => {
    const dir = makeLedgerDir();
    try {
      recordIteration(dir, 'FEAT-E', { iterations: 1, actions: 200, timeMs: 0 });
      const result = checkCumulativeBudget(dir, 'FEAT-E', { maxTotalActions: 200 });
      assert.equal(result.exceeded, true);
      assert.ok(result.reason.includes('action'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns not exceeded for unknown feature', () => {
    const dir = makeLedgerDir();
    try {
      const result = checkCumulativeBudget(dir, 'FEAT-NEW', { maxTotalIterations: 20 });
      assert.equal(result.exceeded, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Route Integration Tests ───────────────────────────────────────────────────

describe('wall-clock timeout enforcement', () => {
  let server;
  afterEach(() => server?.close());

  test('triggers timeout outcome when elapsed exceeds wallClockTimeout', async () => {
    const { projectRoot, composeDir } = makeProjectRoot();
    try {
      const ctx = await setupServer(projectRoot);
      server = ctx.server;
      const itemId = addItem(ctx.store);

      // wallClockTimeout=0 means 0 minutes = already expired
      const startRes = await post(ctx.server, `/api/vision/items/${itemId}/lifecycle/iteration/start`, {
        loopType: 'review', maxIterations: 10, wallClockTimeout: 0,
      });
      assert.equal(startRes.status, 200);

      // Small delay to ensure elapsed > 0ms
      await new Promise(r => setTimeout(r, 10));

      const reportRes = await post(ctx.server, `/api/vision/items/${itemId}/lifecycle/iteration/report`, {
        result: { clean: false, findings: [] },
      });
      assert.equal(reportRes.status, 200);
      assert.equal(reportRes.body.outcome, 'timeout', `expected timeout, got: ${reportRes.body.outcome}`);
      assert.equal(reportRes.body.continue, false);
    } finally {
      server?.close();
      server = null;
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('does not trigger timeout when within window', async () => {
    const { projectRoot } = makeProjectRoot();
    try {
      const ctx = await setupServer(projectRoot);
      server = ctx.server;
      const itemId = addItem(ctx.store);

      await post(ctx.server, `/api/vision/items/${itemId}/lifecycle/iteration/start`, {
        loopType: 'review', maxIterations: 10, wallClockTimeout: 60,
      });

      const reportRes = await post(ctx.server, `/api/vision/items/${itemId}/lifecycle/iteration/report`, {
        result: { clean: false, findings: [] },
      });
      assert.equal(reportRes.status, 200);
      assert.notEqual(reportRes.body.outcome, 'timeout');
      assert.equal(reportRes.body.continue, true);
    } finally {
      server?.close();
      server = null;
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('action count ceiling', () => {
  let server;
  afterEach(() => server?.close());

  test('triggers action_limit outcome when totalActions >= maxActions', async () => {
    const { projectRoot } = makeProjectRoot();
    try {
      const ctx = await setupServer(projectRoot);
      server = ctx.server;
      const itemId = addItem(ctx.store);

      await post(ctx.server, `/api/vision/items/${itemId}/lifecycle/iteration/start`, {
        loopType: 'review', maxIterations: 10, maxActions: 5,
      });

      const reportRes = await post(ctx.server, `/api/vision/items/${itemId}/lifecycle/iteration/report`, {
        result: { clean: false, findings: [], actionCount: 5 },
      });
      assert.equal(reportRes.status, 200);
      assert.equal(reportRes.body.outcome, 'action_limit', `expected action_limit, got: ${reportRes.body.outcome}`);
      assert.equal(reportRes.body.continue, false);
    } finally {
      server?.close();
      server = null;
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('accumulates actionCount across multiple reports', async () => {
    const { projectRoot } = makeProjectRoot();
    try {
      const ctx = await setupServer(projectRoot);
      server = ctx.server;
      const itemId = addItem(ctx.store);

      await post(ctx.server, `/api/vision/items/${itemId}/lifecycle/iteration/start`, {
        loopType: 'review', maxIterations: 10, maxActions: 10,
      });

      // First report: 4 actions (under limit)
      const r1 = await post(ctx.server, `/api/vision/items/${itemId}/lifecycle/iteration/report`, {
        result: { clean: false, findings: [], actionCount: 4 },
      });
      assert.equal(r1.body.continue, true);

      // Second report: 6 more actions (total 10, hits limit)
      const r2 = await post(ctx.server, `/api/vision/items/${itemId}/lifecycle/iteration/report`, {
        result: { clean: false, findings: [], actionCount: 6 },
      });
      assert.equal(r2.body.outcome, 'action_limit');
      assert.equal(r2.body.continue, false);
    } finally {
      server?.close();
      server = null;
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('cumulative budget blocks iteration start', () => {
  let server;
  afterEach(() => server?.close());

  test('rejects start with 429 when cumulative budget exceeded', async () => {
    const { projectRoot, composeDir } = makeProjectRoot();
    try {
      const ctx = await setupServer(projectRoot);
      server = ctx.server;

      // Seed ledger so TEST-1 already has 20 iterations (maxTotal = 20)
      recordIteration(composeDir, 'TEST-1', { iterations: 20, actions: 0, timeMs: 0 });

      const itemId = addItem(ctx.store);
      const startRes = await post(ctx.server, `/api/vision/items/${itemId}/lifecycle/iteration/start`, {
        loopType: 'review', maxIterations: 4,
      });
      assert.equal(startRes.status, 429, `expected 429, got: ${startRes.status} — ${JSON.stringify(startRes.body)}`);
      assert.ok(startRes.body.error.includes('Cumulative'), `expected "Cumulative" in: ${startRes.body.error}`);
    } finally {
      server?.close();
      server = null;
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('allows start when cumulative budget not exceeded', async () => {
    const { projectRoot, composeDir } = makeProjectRoot();
    try {
      const ctx = await setupServer(projectRoot);
      server = ctx.server;

      recordIteration(composeDir, 'TEST-1', { iterations: 5, actions: 0, timeMs: 0 });

      const itemId = addItem(ctx.store);
      const startRes = await post(ctx.server, `/api/vision/items/${itemId}/lifecycle/iteration/start`, {
        loopType: 'review', maxIterations: 4,
      });
      assert.equal(startRes.status, 200);
    } finally {
      server?.close();
      server = null;
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
