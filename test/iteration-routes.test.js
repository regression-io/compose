/**
 * iteration-routes.test.js — Integration tests for iteration REST endpoints
 * and MCP tool wiring.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { VisionStore } = await import(`${REPO_ROOT}/server/vision-store.js`);
const { attachVisionRoutes } = await import(`${REPO_ROOT}/server/vision-routes.js`);

const ALL_SKIP = {
  prd: 'skip', architecture: 'skip', blueprint: 'skip',
  verification: 'skip', plan: 'skip', execute: 'skip',
  report: 'skip', docs: 'skip', ship: 'skip',
};

function setupServer() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'iter-rt-'));
  const dataDir = join(tmpDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const featureRoot = join(tmpDir, 'docs', 'features');
  mkdirSync(join(featureRoot, 'TEST-1'), { recursive: true });

  const store = new VisionStore(dataDir);
  const item = store.createItem({ type: 'feature', title: 'Iter Route Test' });

  const broadcasts = [];
  const app = express();
  app.use(express.json());
  attachVisionRoutes(app, {
    store,
    scheduleBroadcast: () => {},
    broadcastMessage: (msg) => broadcasts.push(msg),
    projectRoot: tmpDir,
  });

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({ tmpDir, store, item, server, port: server.address().port, broadcasts });
    });
  });
}

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', (chunk) => buf += chunk);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode, body: buf }); }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function bypassAndAdvanceToExecute(store, port, itemId) {
  return request(port, 'POST', `/api/vision/items/${itemId}/lifecycle/start`, { featureCode: 'TEST-1' })
    .then(() => {
      const item = store.items.get(itemId);
      item.lifecycle.policyOverrides = ALL_SKIP;
      store.updateLifecycle(itemId, item.lifecycle);
    })
    .then(() => request(port, 'POST', `/api/vision/items/${itemId}/lifecycle/advance`, { targetPhase: 'blueprint', outcome: 'approved' }))
    .then(() => request(port, 'POST', `/api/vision/items/${itemId}/lifecycle/advance`, { targetPhase: 'verification', outcome: 'approved' }))
    .then(() => request(port, 'POST', `/api/vision/items/${itemId}/lifecycle/advance`, { targetPhase: 'plan', outcome: 'approved' }))
    .then(() => request(port, 'POST', `/api/vision/items/${itemId}/lifecycle/advance`, { targetPhase: 'execute', outcome: 'approved' }));
}

// ---------------------------------------------------------------------------

describe('iteration routes', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await setupServer();
    await bypassAndAdvanceToExecute(ctx.store, ctx.port, ctx.item.id);
    ctx.broadcasts.length = 0; // clear setup broadcasts
  });

  afterEach(() => ctx.server.close());

  test('POST iteration/start returns loopId', async () => {
    const res = await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`,
      { loopType: 'review' });
    assert.equal(res.status, 200);
    assert.ok(res.body.loopId.startsWith('iter-'));
    assert.equal(res.body.loopType, 'review');
    assert.equal(res.body.maxIterations, 10);
  });

  test('POST iteration/start requires loopType', async () => {
    const res = await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`, {});
    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes('loopType'));
  });

  test('POST iteration/start rejects outside execute phase', async () => {
    // Create a new item that hasn't been advanced to execute
    const item2 = ctx.store.createItem({ type: 'feature', title: 'Not in execute' });
    await request(ctx.port, 'POST', `/api/vision/items/${item2.id}/lifecycle/start`, { featureCode: 'TEST-1' });
    const res = await request(ctx.port, 'POST',
      `/api/vision/items/${item2.id}/lifecycle/iteration/start`,
      { loopType: 'review' });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes('outside execute'));
  });

  test('POST iteration/report returns continueLoop', async () => {
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`,
      { loopType: 'review' });
    const res = await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/iteration/report`,
      { clean: false, summary: 'found issues' });
    assert.equal(res.status, 200);
    assert.equal(res.body.continueLoop, true);
    assert.equal(res.body.count, 1);
  });

  test('POST iteration/report with clean=true returns continueLoop=false', async () => {
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`,
      { loopType: 'review' });
    const res = await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/iteration/report`,
      { clean: true, summary: 'all clean' });
    assert.equal(res.body.continueLoop, false);
    assert.equal(res.body.outcome, 'clean');
  });

  test('POST iteration/report at max returns outcome max_reached', async () => {
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`,
      { loopType: 'review', maxIterations: 2 });
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/iteration/report`,
      { clean: false });
    const res = await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/iteration/report`,
      { clean: false });
    assert.equal(res.body.outcome, 'max_reached');
    assert.equal(res.body.continueLoop, false);
  });

  test('GET iteration returns current state', async () => {
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`,
      { loopType: 'coverage' });
    const res = await request(ctx.port, 'GET',
      `/api/vision/items/${ctx.item.id}/lifecycle/iteration`);
    assert.equal(res.status, 200);
    assert.equal(res.body.loopType, 'coverage');
    assert.equal(res.body.count, 0);
  });

  test('GET iteration returns 404 when no iteration', async () => {
    // Remove iteration state by not starting one
    const item2 = ctx.store.createItem({ type: 'feature', title: 'No iter' });
    await request(ctx.port, 'POST', `/api/vision/items/${item2.id}/lifecycle/start`, { featureCode: 'TEST-1' });
    const it = ctx.store.items.get(item2.id);
    it.lifecycle.policyOverrides = ALL_SKIP;
    ctx.store.updateLifecycle(item2.id, it.lifecycle);
    await request(ctx.port, 'POST', `/api/vision/items/${item2.id}/lifecycle/advance`, { targetPhase: 'execute', outcome: 'approved' });
    const res = await request(ctx.port, 'GET',
      `/api/vision/items/${item2.id}/lifecycle/iteration`);
    assert.equal(res.status, 404);
  });

  test('broadcast iterationStarted includes loopType and maxIterations', async () => {
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`,
      { loopType: 'review' });
    const started = ctx.broadcasts.find(b => b.type === 'iterationStarted');
    assert.ok(started);
    assert.equal(started.loopType, 'review');
    assert.equal(started.maxIterations, 10);
    assert.equal(started.itemId, ctx.item.id);
  });

  test('broadcast iterationUpdate includes loopType and count', async () => {
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`,
      { loopType: 'review' });
    ctx.broadcasts.length = 0;
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/iteration/report`,
      { clean: false, summary: 'issues' });
    const update = ctx.broadcasts.find(b => b.type === 'iterationUpdate');
    assert.ok(update);
    assert.equal(update.loopType, 'review');
    assert.equal(update.count, 1);
  });

  test('broadcast iterationComplete sent on loop end with outcome and finalCount', async () => {
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`,
      { loopType: 'review' });
    ctx.broadcasts.length = 0;
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/iteration/report`,
      { clean: true, summary: 'clean' });
    const complete = ctx.broadcasts.find(b => b.type === 'iterationComplete');
    assert.ok(complete, 'iterationComplete broadcast should be sent');
    assert.equal(complete.outcome, 'clean');
    assert.equal(complete.finalCount, 1);
    assert.equal(complete.loopType, 'review');
  });

  test('iterationComplete not sent when loop continues', async () => {
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/iteration/start`,
      { loopType: 'review' });
    ctx.broadcasts.length = 0;
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/iteration/report`,
      { clean: false });
    const complete = ctx.broadcasts.find(b => b.type === 'iterationComplete');
    assert.equal(complete, undefined, 'iterationComplete should not be sent mid-loop');
  });
});

describe('MCP tool definitions', () => {
  test('compose-mcp.js TOOLS contains all 3 iteration tool names', async () => {
    // Read compose-mcp.js source and check for tool names
    const fs = await import('node:fs');
    const src = fs.readFileSync(join(REPO_ROOT, 'server', 'compose-mcp.js'), 'utf8');
    assert.ok(src.includes("'start_iteration_loop'"), 'missing start_iteration_loop');
    assert.ok(src.includes("'report_iteration_result'"), 'missing report_iteration_result');
    assert.ok(src.includes("'get_iteration_status'"), 'missing get_iteration_status');
  });
});
