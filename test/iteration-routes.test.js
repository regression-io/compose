/**
 * iteration-routes.test.js — Integration tests for iteration orchestration REST endpoints.
 *
 * Tests: start loop, report results (clean/dirty/max), abort, conflict handling.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { VisionStore } = await import(`${REPO_ROOT}/server/vision-store.js`);
const { SettingsStore } = await import(`${REPO_ROOT}/server/settings-store.js`);
const { attachVisionRoutes } = await import(`${REPO_ROOT}/server/vision-routes.js`);

function setupServer() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'iter-test-'));
  const dataDir = join(tmpDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(tmpDir, 'docs', 'features', 'TEST-1'), { recursive: true });

  const store = new VisionStore(dataDir);
  const settingsStore = new SettingsStore(dataDir, {
    phases: [{ id: 'execute', defaultPolicy: null }],
    iterationDefaults: { review: { maxIterations: 4 }, coverage: { maxIterations: 15 } },
    policyModes: ['gate', 'flag', 'skip'],
  });

  // Create item with lifecycle
  const item = store.createItem({ type: 'feature', title: 'Iteration Test' });
  store.updateLifecycle(item.id, {
    featureCode: 'TEST-1',
    currentPhase: 'execute',
    startedAt: new Date().toISOString(),
  });

  const broadcasts = [];
  const app = express();
  app.use(express.json());
  attachVisionRoutes(app, {
    store,
    scheduleBroadcast: () => {},
    broadcastMessage: (msg) => broadcasts.push(msg),
    projectRoot: tmpDir,
    settingsStore,
  });

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      resolve({ tmpDir, store, item, server, port, broadcasts });
    });
  });
}

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', (c) => buf += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode, body: buf }); }
        });
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

describe('iteration routes', () => {
  let ctx;

  beforeEach(async () => { ctx = await setupServer(); });
  afterEach(() => { ctx.server.close(); rmSync(ctx.tmpDir, { recursive: true, force: true }); });

  test('start review loop', async () => {
    const res = await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`, { loopType: 'review' });
    assert.equal(res.status, 200);
    assert.equal(res.body.loopType, 'review');
    assert.equal(res.body.status, 'running');
    assert.equal(res.body.count, 0);
    assert.equal(res.body.maxIterations, 4); // from settings
    assert.ok(ctx.broadcasts.find(b => b.type === 'iterationStarted'));
  });

  test('start with invalid loopType returns 400', async () => {
    const res = await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`, { loopType: 'invalid' });
    assert.equal(res.status, 400);
  });

  test('start while loop running returns 409', async () => {
    await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`, { loopType: 'review' });
    const res = await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`, { loopType: 'review' });
    assert.equal(res.status, 409);
  });

  test('report clean result completes loop', async () => {
    await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`, { loopType: 'review' });
    const res = await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/report`, {
      result: { clean: true, summary: 'All good', findings: [] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.continue, false);
    assert.equal(res.body.outcome, 'clean');
    assert.equal(res.body.count, 1);
    assert.ok(ctx.broadcasts.find(b => b.type === 'iterationComplete' && b.outcome === 'clean'));
  });

  test('report dirty result continues loop', async () => {
    await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`, { loopType: 'review' });
    const res = await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/report`, {
      result: { clean: false, summary: 'Issues found', findings: ['bug1'] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.continue, true);
    assert.equal(res.body.count, 1);
    assert.equal(res.body.outcome, null);
    assert.ok(ctx.broadcasts.find(b => b.type === 'iterationUpdate'));
  });

  test('report past max iterations returns max_reached', async () => {
    await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`, { loopType: 'review', maxIterations: 2 });
    await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/report`, { result: { clean: false } });
    const res = await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/report`, { result: { clean: false } });
    assert.equal(res.status, 200);
    assert.equal(res.body.continue, false);
    assert.equal(res.body.outcome, 'max_reached');
    assert.ok(ctx.broadcasts.find(b => b.type === 'iterationComplete' && b.outcome === 'max_reached'));
  });

  test('abort running loop', async () => {
    await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`, { loopType: 'coverage' });
    const res = await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/abort`, { reason: 'manual' });
    assert.equal(res.status, 200);
    assert.equal(res.body.aborted, true);
    assert.ok(ctx.broadcasts.find(b => b.type === 'iterationComplete' && b.outcome === 'aborted'));
  });

  test('report on completed loop returns 409', async () => {
    await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`, { loopType: 'review' });
    await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/report`, { result: { clean: true } });
    const res = await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/report`, { result: { clean: true } });
    assert.equal(res.status, 409);
  });

  test('coverage loop uses passing exit criteria', async () => {
    await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`, { loopType: 'coverage' });
    const res = await post(ctx.port, `/api/vision/items/${ctx.item.id}/lifecycle/iteration/report`, {
      result: { passing: true, summary: 'All tests pass', failures: [] },
    });
    assert.equal(res.body.continue, false);
    assert.equal(res.body.outcome, 'clean');
  });
});
