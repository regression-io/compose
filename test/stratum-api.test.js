/**
 * Tests for stratum-api.js — Express router (transport adapter).
 *
 * Passes stub client functions directly into createStratumRouter(client).
 * Verifies HTTP status code mapping matches the documented contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Import once — stubs injected per-test via createStratumRouter(client)
// ---------------------------------------------------------------------------

const express = (await import('express')).default;
const { createStratumRouter } = await import(`${REPO_ROOT}/server/stratum-api.js`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp(clientStubs) {
  const app = express();
  app.use(express.json());
  app.use('/api/stratum', createStratumRouter(clientStubs));
  return app;
}

function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      const bodyStr = body ? JSON.stringify(body) : undefined;
      const options = {
        hostname: '127.0.0.1',
        port,
        path,
        method: method.toUpperCase(),
        headers: {
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', d => { data += d; });
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        });
      });
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  });
}

const FLOW_SUMMARY = { _schema_version: '1', flow_id: 'f1', flow_name: 'main', status: 'running', round: 0, step_count: 2, completed_steps: 1 };
const GATE_ITEM = { _schema_version: '1', flow_id: 'f1', flow_name: 'main', step_id: 's2', function: 'review', on_approve: null, on_revise: 's1', on_kill: null, timeout: null };
const MUTATION_OK = { _schema_version: '1', ok: true, flow_id: 'f1', step_id: 's2', outcome: 'approve', result: 'complete' };

// ---------------------------------------------------------------------------
// GET /api/stratum/flows
// ---------------------------------------------------------------------------

test('GET /api/stratum/flows → 200 with flow array', async () => {
  const app = makeApp({ queryFlows: async () => [FLOW_SUMMARY] });
  const res = await request(app, 'GET', '/api/stratum/flows');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body[0].flow_id, 'f1');
});

test('GET /api/stratum/flows → 504 on TIMEOUT', async () => {
  const app = makeApp({ queryFlows: async () => ({ error: { code: 'TIMEOUT', message: 'timed out', detail: '' } }) });
  const res = await request(app, 'GET', '/api/stratum/flows');
  assert.equal(res.status, 504);
});

// ---------------------------------------------------------------------------
// GET /api/stratum/flows/:flowId
// ---------------------------------------------------------------------------

test('GET /api/stratum/flows/:flowId → 200 on success', async () => {
  const flowState = { ...FLOW_SUMMARY, current_idx: 1, rounds_count: 0, terminal_status: null, step_outputs: {}, records: [], rounds: [], ordered_steps: [] };
  const app = makeApp({ queryFlow: async () => flowState });
  const res = await request(app, 'GET', '/api/stratum/flows/f1');
  assert.equal(res.status, 200);
  assert.equal(res.body.flow_id, 'f1');
});

test('GET /api/stratum/flows/:flowId → 404 on NOT_FOUND', async () => {
  const app = makeApp({ queryFlow: async () => ({ error: { code: 'NOT_FOUND', message: 'not found', detail: '' } }) });
  const res = await request(app, 'GET', '/api/stratum/flows/missing');
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// GET /api/stratum/gates
// ---------------------------------------------------------------------------

test('GET /api/stratum/gates → 200 with gate array', async () => {
  const app = makeApp({ queryGates: async () => [GATE_ITEM] });
  const res = await request(app, 'GET', '/api/stratum/gates');
  assert.equal(res.status, 200);
  assert.equal(res.body[0].step_id, 's2');
});

// ---------------------------------------------------------------------------
// POST /api/stratum/gates/:flowId/:stepId/approve
// ---------------------------------------------------------------------------

test('POST .../approve → 200 on success', async () => {
  const app = makeApp({ gateApprove: async () => MUTATION_OK });
  const res = await request(app, 'POST', '/api/stratum/gates/f1/s2/approve', { note: 'LGTM' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('POST .../approve → 409 on conflict', async () => {
  const app = makeApp({ gateApprove: async () => ({ conflict: true, flow_id: 'f1', step_id: 's2', detail: 'already resolved' }) });
  const res = await request(app, 'POST', '/api/stratum/gates/f1/s2/approve', {});
  assert.equal(res.status, 409);
  assert.equal(res.body.conflict, true);
});

test('POST .../approve → 504 on TIMEOUT', async () => {
  const app = makeApp({ gateApprove: async () => ({ error: { code: 'TIMEOUT', message: 'timed out', detail: '' } }) });
  const res = await request(app, 'POST', '/api/stratum/gates/f1/s2/approve', {});
  assert.equal(res.status, 504);
});

// ---------------------------------------------------------------------------
// POST /api/stratum/gates/:flowId/:stepId/reject
// ---------------------------------------------------------------------------

test('POST .../reject → 200 on success', async () => {
  const app = makeApp({ gateReject: async () => ({ ...MUTATION_OK, outcome: 'kill', result: 'killed' }) });
  const res = await request(app, 'POST', '/api/stratum/gates/f1/s2/reject', { note: 'not ready' });
  assert.equal(res.status, 200);
  assert.equal(res.body.result, 'killed');
});

test('POST .../reject → 409 on conflict', async () => {
  const app = makeApp({ gateReject: async () => ({ conflict: true, detail: '' }) });
  const res = await request(app, 'POST', '/api/stratum/gates/f1/s2/reject', {});
  assert.equal(res.status, 409);
});

// ---------------------------------------------------------------------------
// Thrown error (e.g. ENOENT) → 503 via error middleware
// ---------------------------------------------------------------------------

test('GET /api/stratum/flows → 503 when stratum-client throws', async () => {
  const app = makeApp({ queryFlows: async () => { throw new Error('stratum-mcp not found'); } });
  const res = await request(app, 'GET', '/api/stratum/flows');
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'UNAVAILABLE');
});

test('POST .../approve → 503 when stratum-client throws', async () => {
  const app = makeApp({ gateApprove: async () => { throw new Error('stratum-mcp not found'); } });
  const res = await request(app, 'POST', '/api/stratum/gates/f1/s2/approve', {});
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'UNAVAILABLE');
});
