/**
 * lifecycle-routes.test.js — Integration tests for lifecycle REST endpoints.
 *
 * Spins up Express with in-memory VisionStore on an ephemeral port,
 * hits endpoints via http.request, verifies responses and broadcasts.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { VisionStore } = await import(`${REPO_ROOT}/server/vision-store.js`);
const { attachVisionRoutes } = await import(`${REPO_ROOT}/server/vision-routes.js`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupServer() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lr-test-'));
  const dataDir = join(tmpDir, 'data');
  mkdirSync(dataDir, { recursive: true });

  const featureRoot = join(tmpDir, 'docs', 'features');
  mkdirSync(join(featureRoot, 'TEST-1'), { recursive: true });

  const store = new VisionStore(dataDir);
  const item = store.createItem({ type: 'feature', title: 'Integration Test Feature' });

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
      const port = server.address().port;
      resolve({ tmpDir, store, item, server, port, broadcasts });
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

describe('lifecycle REST endpoints', () => {
  let ctx;
  beforeEach(async () => { ctx = await setupServer(); });
  afterEach(() => {
    ctx.server.close();
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  test('start lifecycle', async () => {
    const res = await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/start`,
      { featureCode: 'TEST-1' });
    assert.equal(res.status, 200);
    assert.equal(res.body.currentPhase, 'explore_design');
    assert.equal(res.body.featureCode, 'TEST-1');
  });

  test('start lifecycle — missing featureCode', async () => {
    const res = await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/start`, {});
    assert.equal(res.status, 400);
  });

  test('advance phase', async () => {
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/start`,
      { featureCode: 'TEST-1' });

    const res = await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/advance`,
      { targetPhase: 'blueprint', outcome: 'approved' });
    assert.equal(res.status, 200);
    assert.equal(res.body.from, 'explore_design');
    assert.equal(res.body.to, 'blueprint');
  });

  test('skip phase', async () => {
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/start`,
      { featureCode: 'TEST-1' });
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/advance`,
      { targetPhase: 'prd', outcome: 'approved' });

    const res = await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/skip`,
      { targetPhase: 'blueprint', reason: 'Internal feature' });
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'skipped');
  });

  test('kill feature', async () => {
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/start`,
      { featureCode: 'TEST-1' });

    const res = await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/kill`,
      { reason: 'No longer needed' });
    assert.equal(res.status, 200);
    assert.equal(res.body.phase, 'explore_design');

    const item = ctx.store.items.get(ctx.item.id);
    assert.equal(item.status, 'killed');
  });

  test('complete feature', async () => {
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/start`,
      { featureCode: 'TEST-1' });

    // Advance to ship
    for (const phase of ['blueprint', 'verification', 'plan', 'execute', 'docs', 'ship']) {
      await request(ctx.port, 'POST',
        `/api/vision/items/${ctx.item.id}/lifecycle/advance`,
        { targetPhase: phase, outcome: 'approved' });
    }

    const res = await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/complete`, {});
    assert.equal(res.status, 200);
    assert.ok(res.body.completedAt);

    const item = ctx.store.items.get(ctx.item.id);
    assert.equal(item.status, 'complete');
  });

  test('invalid transition → 400', async () => {
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/start`,
      { featureCode: 'TEST-1' });

    const res = await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/advance`,
      { targetPhase: 'execute', outcome: 'approved' });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  test('GET lifecycle', async () => {
    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/start`,
      { featureCode: 'TEST-1' });

    const res = await request(ctx.port, 'GET',
      `/api/vision/items/${ctx.item.id}/lifecycle`);
    assert.equal(res.status, 200);
    assert.equal(res.body.currentPhase, 'explore_design');
  });

  test('GET lifecycle — no lifecycle → 404', async () => {
    const res = await request(ctx.port, 'GET',
      `/api/vision/items/${ctx.item.id}/lifecycle`);
    assert.equal(res.status, 404);
  });

  test('broadcasts emitted with correct shapes', async () => {
    ctx.broadcasts.length = 0;

    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/start`,
      { featureCode: 'TEST-1' });

    assert.equal(ctx.broadcasts.length, 1);
    assert.equal(ctx.broadcasts[0].type, 'lifecycleStarted');
    assert.equal(ctx.broadcasts[0].itemId, ctx.item.id);
    assert.equal(ctx.broadcasts[0].phase, 'explore_design');
    assert.ok(ctx.broadcasts[0].timestamp);

    await request(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/advance`,
      { targetPhase: 'blueprint', outcome: 'approved' });

    assert.equal(ctx.broadcasts.length, 2);
    assert.equal(ctx.broadcasts[1].type, 'lifecycleTransition');
    assert.equal(ctx.broadcasts[1].from, 'explore_design');
    assert.equal(ctx.broadcasts[1].to, 'blueprint');
    assert.equal(ctx.broadcasts[1].outcome, 'approved');
  });
});

// ---------------------------------------------------------------------------
// MCP tool schema validation
// ---------------------------------------------------------------------------

describe('MCP tool schemas', () => {
  test('compose-mcp.js contains all lifecycle + gate tool names', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(join(REPO_ROOT, 'server', 'compose-mcp.js'), 'utf-8');
    const expected = [
      'get_feature_lifecycle',
      'kill_feature',
      'complete_feature',
      'approve_gate',
      'get_pending_gates',
    ];
    for (const name of expected) {
      assert.ok(source.includes(`name: '${name}'`), `Missing tool definition: ${name}`);
      assert.ok(source.includes(`case '${name}'`), `Missing switch case: ${name}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Gate REST endpoints
// ---------------------------------------------------------------------------

describe('gate REST endpoints', () => {
  let ctx;
  beforeEach(async () => { ctx = await setupServer(); });
  afterEach(() => {
    ctx.server.close();
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  /** Helper: start lifecycle and insert a pending gate directly. */
  function startAndCreateGate() {
    const now = new Date().toISOString();
    ctx.store.updateLifecycle(ctx.item.id, {
      currentPhase: 'explore_design',
      featureCode: 'TEST-1',
      startedAt: now,
      completedAt: null,
      killedAt: null,
      killReason: null,
    });
    const gateId = randomUUID();
    ctx.store.createGate({
      id: gateId,
      itemId: ctx.item.id,
      fromPhase: 'explore_design',
      toPhase: 'blueprint',
      status: 'pending',
      createdAt: now,
    });
    return gateId;
  }

  test('GET /api/vision/gates returns pending gates', async () => {
    const gateId = startAndCreateGate();

    const res = await request(ctx.port, 'GET', '/api/vision/gates');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.gates));
    assert.equal(res.body.gates.length, 1);
    assert.equal(res.body.gates[0].status, 'pending');
  });

  test('GET /api/vision/gates/:id returns single gate', async () => {
    const gateId = startAndCreateGate();

    const res = await request(ctx.port, 'GET',
      `/api/vision/gates/${gateId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, gateId);
    assert.equal(res.body.status, 'pending');
    assert.equal(res.body.toPhase, 'blueprint');
  });

  test('POST resolve with approved advances phase', async () => {
    const gateId = startAndCreateGate();

    const res = await request(ctx.port, 'POST',
      `/api/vision/gates/${gateId}/resolve`,
      { outcome: 'approved' });
    assert.equal(res.status, 200);
    assert.equal(res.body.gateOutcome, 'approved');

    const lcRes = await request(ctx.port, 'GET',
      `/api/vision/items/${ctx.item.id}/lifecycle`);
    assert.equal(lcRes.body.currentPhase, 'blueprint');
  });

  test('POST resolve with revised keeps phase', async () => {
    const gateId = startAndCreateGate();

    const res = await request(ctx.port, 'POST',
      `/api/vision/gates/${gateId}/resolve`,
      { outcome: 'revised', comment: 'Needs work' });
    assert.equal(res.status, 200);
    assert.equal(res.body.gateOutcome, 'revised');

    const lcRes = await request(ctx.port, 'GET',
      `/api/vision/items/${ctx.item.id}/lifecycle`);
    assert.equal(lcRes.body.currentPhase, 'explore_design');
  });

  test('POST resolve with killed kills feature', async () => {
    const gateId = startAndCreateGate();

    const res = await request(ctx.port, 'POST',
      `/api/vision/gates/${gateId}/resolve`,
      { outcome: 'killed', comment: 'Cancelled' });
    assert.equal(res.status, 200);
    assert.equal(res.body.gateOutcome, 'killed');

    const item = ctx.store.items.get(ctx.item.id);
    assert.equal(item.status, 'killed');
  });

  test('gateResolved broadcast emitted on resolve', async () => {
    const gateId = startAndCreateGate();
    ctx.broadcasts.length = 0;

    await request(ctx.port, 'POST',
      `/api/vision/gates/${gateId}/resolve`,
      { outcome: 'approved' });

    const resolveBroadcast = ctx.broadcasts.find(b => b.type === 'gateResolved');
    assert.ok(resolveBroadcast, 'Expected gateResolved broadcast');
    assert.equal(resolveBroadcast.gateId, gateId);
    assert.equal(resolveBroadcast.itemId, ctx.item.id);
    assert.equal(resolveBroadcast.outcome, 'approved');
    assert.ok(resolveBroadcast.timestamp);
  });
});
