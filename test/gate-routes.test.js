/**
 * gate-routes.test.js — Integration tests for gate-specific route behaviors
 * not covered by lifecycle-routes.test.js.
 *
 * Focuses on: visionState includes gates in initial payload,
 * gatePending broadcast omits scheduleBroadcast, gateResolved includes itemId.
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
const { attachVisionRoutes } = await import(`${REPO_ROOT}/server/vision-routes.js`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupServer() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'gr-test-'));
  const dataDir = join(tmpDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(tmpDir, 'docs', 'features', 'TEST-1'), { recursive: true });

  const store = new VisionStore(dataDir);
  const item = store.createItem({ type: 'feature', title: 'Gate Route Test' });

  let scheduleBroadcastCalls = 0;
  const broadcasts = [];
  const app = express();
  app.use(express.json());
  attachVisionRoutes(app, {
    store,
    scheduleBroadcast: () => { scheduleBroadcastCalls++; },
    broadcastMessage: (msg) => broadcasts.push(msg),
    projectRoot: tmpDir,
  });

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      resolve({ tmpDir, store, item, server, port, broadcasts, getScheduleCount: () => scheduleBroadcastCalls });
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
    req.end(data);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('visionState includes gates', () => {
  let ctx;
  beforeEach(async () => { ctx = await setupServer(); });
  afterEach(() => {
    ctx.server.close();
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  test('getState returns gates array', () => {
    const state = ctx.store.getState();
    assert.ok(Array.isArray(state.gates), 'getState().gates should be an array');
    assert.equal(state.gates.length, 0);
  });

  test('getState includes pending gate after advance on gated phase', async () => {
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/start`,
      { featureCode: 'TEST-1' });
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/advance`,
      { targetPhase: 'blueprint', outcome: 'approved' });

    const state = ctx.store.getState();
    assert.equal(state.gates.length, 1);
    assert.equal(state.gates[0].status, 'pending');
    assert.equal(state.gates[0].itemId, ctx.item.id);
    assert.equal(state.gates[0].fromPhase, 'explore_design');
    assert.equal(state.gates[0].toPhase, 'blueprint');
  });
});

describe('gatePending broadcast behavior', () => {
  let ctx;
  beforeEach(async () => { ctx = await setupServer(); });
  afterEach(() => {
    ctx.server.close();
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  test('gatePending does NOT trigger scheduleBroadcast', async () => {
    const before = ctx.getScheduleCount();
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/start`,
      { featureCode: 'TEST-1' });
    const afterStart = ctx.getScheduleCount();

    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/advance`,
      { targetPhase: 'blueprint', outcome: 'approved' });
    const afterAdvance = ctx.getScheduleCount();

    // scheduleBroadcast should NOT be called for gated advance (only broadcastMessage)
    assert.equal(afterAdvance, afterStart,
      'scheduleBroadcast should not be called on gated advance');

    // But broadcastMessage SHOULD have the gatePending
    const gateBroadcast = ctx.broadcasts.find(b => b.type === 'gatePending');
    assert.ok(gateBroadcast);
  });
});

describe('gateResolved broadcast includes itemId', () => {
  let ctx;
  beforeEach(async () => { ctx = await setupServer(); });
  afterEach(() => {
    ctx.server.close();
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  test('approved resolve includes itemId in broadcast', async () => {
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/start`,
      { featureCode: 'TEST-1' });
    const advRes = await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/advance`,
      { targetPhase: 'blueprint', outcome: 'approved' });

    ctx.broadcasts.length = 0;
    await request(ctx.port, 'POST',
      `/api/vision/gates/${advRes.body.gateId}/resolve`,
      { outcome: 'approved' });

    const resolveBroadcast = ctx.broadcasts.find(b => b.type === 'gateResolved');
    assert.ok(resolveBroadcast);
    assert.equal(resolveBroadcast.itemId, ctx.item.id);
    assert.equal(resolveBroadcast.outcome, 'approved');
  });

  test('revised resolve includes itemId in broadcast', async () => {
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/start`,
      { featureCode: 'TEST-1' });
    const advRes = await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/advance`,
      { targetPhase: 'blueprint', outcome: 'approved' });

    ctx.broadcasts.length = 0;
    await request(ctx.port, 'POST',
      `/api/vision/gates/${advRes.body.gateId}/resolve`,
      { outcome: 'revised', comment: 'Needs work' });

    const resolveBroadcast = ctx.broadcasts.find(b => b.type === 'gateResolved');
    assert.ok(resolveBroadcast);
    assert.equal(resolveBroadcast.itemId, ctx.item.id);
    assert.equal(resolveBroadcast.outcome, 'revised');
  });

  test('killed resolve includes itemId in broadcast', async () => {
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/start`,
      { featureCode: 'TEST-1' });
    const advRes = await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/advance`,
      { targetPhase: 'blueprint', outcome: 'approved' });

    ctx.broadcasts.length = 0;
    await request(ctx.port, 'POST',
      `/api/vision/gates/${advRes.body.gateId}/resolve`,
      { outcome: 'killed', comment: 'Cancelled' });

    const resolveBroadcast = ctx.broadcasts.find(b => b.type === 'gateResolved');
    assert.ok(resolveBroadcast);
    assert.equal(resolveBroadcast.itemId, ctx.item.id);
    assert.equal(resolveBroadcast.outcome, 'killed');
  });
});

describe('gate object shape in getState', () => {
  let ctx;
  beforeEach(async () => { ctx = await setupServer(); });
  afterEach(() => {
    ctx.server.close();
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  test('gate has all required fields for client rendering', async () => {
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/start`,
      { featureCode: 'TEST-1' });
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/advance`,
      { targetPhase: 'blueprint', outcome: 'approved' });

    const gate = ctx.store.getState().gates[0];
    // Fields required by GateView and ItemDetailPanel
    assert.ok(gate.id, 'gate.id');
    assert.ok(gate.itemId, 'gate.itemId');
    assert.ok(gate.fromPhase, 'gate.fromPhase');
    assert.ok(gate.toPhase, 'gate.toPhase');
    assert.equal(gate.status, 'pending');
    assert.ok(gate.createdAt, 'gate.createdAt');
    // artifactAssessment may be null (no artifact on disk), but should be present
    assert.ok('artifactAssessment' in gate, 'gate.artifactAssessment key should exist');
  });
});
