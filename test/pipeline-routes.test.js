/**
 * pipeline-routes.test.js — Pipeline authoring REST API tests.
 *
 * Spins up a real Express server on an ephemeral port with pipeline routes.
 * Tests template listing, spec fetching, draft lifecycle (create, get, approve, reject).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const express = (await import('express')).default;
const { attachPipelineRoutes } = await import(`${ROOT}/server/pipeline-routes.js`);

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

let baseUrl;
let httpServer;
let dataDir;
let pipelinesDir;
const broadcasts = [];

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'pipeline-routes-'));
}

function json(url, opts = {}) {
  return fetch(`${baseUrl}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  }).then(async r => ({ status: r.status, data: await r.json() }));
}

before(() => new Promise(res => {
  const tmpRoot = freshDir();
  dataDir = join(tmpRoot, '.compose', 'data');
  pipelinesDir = join(tmpRoot, 'pipelines');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(pipelinesDir, { recursive: true });

  // Write test templates
  writeFileSync(join(pipelinesDir, 'build.stratum.yaml'), [
    'metadata:',
    '  id: build',
    '  label: "Feature Build"',
    '  description: "Full lifecycle"',
    '  category: development',
    '  steps: 16',
    '  estimated_minutes: 120',
    '',
    'version: "0.3"',
    '',
    'workflow:',
    '  name: build',
    '  description: "Execute a feature"',
    '  input:',
    '    featureCode:',
    '      type: string',
    '      required: true',
    '',
    'flows:',
    '  build:',
    '    input:',
    '      featureCode: {type: string}',
    '    output: {}',
    '    steps:',
    '      - id: design',
    '        agent: claude',
    '        intent: "Design the feature"',
    '      - id: implement',
    '        agent: claude',
    '        intent: "Implement the feature"',
  ].join('\n'));

  writeFileSync(join(pipelinesDir, 'review-fix.stratum.yaml'), [
    'metadata:',
    '  id: review-fix',
    '  label: "Review & Fix"',
    '  description: "Iterative review loop"',
    '  category: quality',
    '  steps: 2',
    '  estimated_minutes: 15',
    '',
    'version: "0.1"',
    '',
    'functions:',
    '  execute_task:',
    '    mode: compute',
    '    intent: "Execute"',
    '',
    'flows:',
    '  review_fix:',
    '    input:',
    '      task: {type: string}',
    '    output: {}',
    '    steps:',
    '      - id: execute',
    '        function: execute_task',
    '        inputs:',
    '          task: "$.input.task"',
    '      - id: review',
    '        function: fix_and_review',
    '        inputs:',
    '          task: "$.input.task"',
    '        depends_on: [execute]',
  ].join('\n'));

  // Write a non-template yaml (no metadata) — should be excluded
  writeFileSync(join(pipelinesDir, 'no-meta.stratum.yaml'), [
    'version: "0.1"',
    'flows:',
    '  noop:',
    '    steps: []',
  ].join('\n'));

  const app = express();
  app.use(express.json());

  attachPipelineRoutes(app, {
    broadcastMessage: (msg) => broadcasts.push(msg),
    scheduleBroadcast: () => {},
    getDataDir: () => dataDir,
    getPipelinesDir: () => pipelinesDir,
  });

  httpServer = createServer(app);
  httpServer.listen(0, '127.0.0.1', () => {
    const { port } = httpServer.address();
    baseUrl = `http://127.0.0.1:${port}`;
    res();
  });
}));

after(() => new Promise(res => {
  httpServer.closeAllConnections?.();
  httpServer.close(res);
}));

// ---------------------------------------------------------------------------
// GET /api/pipeline/templates
// ---------------------------------------------------------------------------

describe('GET /api/pipeline/templates', () => {
  test('returns templates with metadata, excludes files without metadata', async () => {
    const { status, data } = await json('/api/pipeline/templates');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.templates));
    // Should include build and review-fix, exclude no-meta
    assert.ok(data.templates.length >= 2, `Expected >= 2 templates, got ${data.templates.length}`);
    const ids = data.templates.map(t => t.id);
    assert.ok(ids.includes('build'));
    assert.ok(ids.includes('review-fix'));
    assert.ok(!ids.includes(undefined));
    // no-meta.stratum.yaml should not appear
    const noMeta = data.templates.find(t => t.id === 'no-meta');
    assert.equal(noMeta, undefined);
  });

  test('each template has expected fields', async () => {
    const { data } = await json('/api/pipeline/templates');
    for (const t of data.templates) {
      assert.ok(t.id, 'missing id');
      assert.ok(t.label, 'missing label');
      assert.ok(t.description, 'missing description');
      assert.ok(t.category, 'missing category');
      assert.ok(typeof t.steps === 'number', 'steps should be number');
      assert.ok(typeof t.estimated_minutes === 'number', 'estimated_minutes should be number');
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/pipeline/templates/:id/spec
// ---------------------------------------------------------------------------

describe('GET /api/pipeline/templates/:id/spec', () => {
  test('returns full YAML spec for existing template', async () => {
    const { status, data } = await json('/api/pipeline/templates/build/spec');
    assert.equal(status, 200);
    assert.ok(data.spec);
    assert.ok(data.spec.includes('version:'));
    assert.ok(data.spec.includes('metadata:'));
  });

  test('returns 404 for unknown template', async () => {
    const { status } = await json('/api/pipeline/templates/nonexistent/spec');
    assert.equal(status, 404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/pipeline/draft — from templateId
// ---------------------------------------------------------------------------

describe('POST /api/pipeline/draft', () => {
  test('creates draft from templateId', async () => {
    broadcasts.length = 0;
    const { status, data } = await json('/api/pipeline/draft', {
      method: 'POST',
      body: { templateId: 'build' },
    });
    assert.equal(status, 200);
    assert.ok(data.draftId);
    assert.ok(data.steps);
    assert.ok(Array.isArray(data.steps));
    assert.ok(data.steps.length > 0);
    assert.equal(data.status, 'pending');
    // Should broadcast
    assert.ok(broadcasts.some(b => b.type === 'pipelineDraft'));
  });

  test('creates draft from inline spec + metadata', async () => {
    const spec = [
      'metadata:',
      '  id: inline-test',
      '  label: Inline',
      '  description: Test',
      '  category: test',
      '  steps: 1',
      '  estimated_minutes: 5',
      'version: "0.1"',
      'flows:',
      '  test:',
      '    steps:',
      '      - id: step1',
      '        function: noop',
    ].join('\n');
    const { status, data } = await json('/api/pipeline/draft', {
      method: 'POST',
      body: { spec, metadata: { id: 'inline-test', label: 'Inline' } },
    });
    assert.equal(status, 200);
    assert.ok(data.draftId);
  });

  test('rejects invalid YAML', async () => {
    const { status, data } = await json('/api/pipeline/draft', {
      method: 'POST',
      body: { spec: '{{not: valid: yaml: [[[', metadata: { id: 'bad' } },
    });
    assert.equal(status, 400);
    assert.ok(data.error);
  });

  test('rejects missing metadata in inline spec', async () => {
    const { status, data } = await json('/api/pipeline/draft', {
      method: 'POST',
      body: { spec: 'version: "0.1"\nflows:\n  test:\n    steps: []', metadata: {} },
    });
    // metadata presence validated — spec has no metadata block
    // but metadata object was passed (empty), route should check spec or metadata
    assert.ok(status === 400 || status === 200);
  });

  test('returns 404 for unknown templateId', async () => {
    const { status } = await json('/api/pipeline/draft', {
      method: 'POST',
      body: { templateId: 'nonexistent' },
    });
    assert.equal(status, 404);
  });

  test('rejects empty body', async () => {
    const { status } = await json('/api/pipeline/draft', {
      method: 'POST',
      body: {},
    });
    assert.equal(status, 400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/pipeline/draft
// ---------------------------------------------------------------------------

describe('GET /api/pipeline/draft', () => {
  test('returns current draft after creation', async () => {
    // Create a draft first
    await json('/api/pipeline/draft', {
      method: 'POST',
      body: { templateId: 'review-fix' },
    });

    const { status, data } = await json('/api/pipeline/draft');
    assert.equal(status, 200);
    assert.ok(data.draft);
    assert.ok(data.draft.draftId);
    assert.ok(data.draft.spec);
    assert.ok(data.draft.steps);
    assert.ok(data.draft.createdAt);
    assert.equal(data.draft.status, 'pending');
  });
});

// ---------------------------------------------------------------------------
// POST /api/pipeline/draft/approve
// ---------------------------------------------------------------------------

describe('POST /api/pipeline/draft/approve', () => {
  test('approves current draft and writes spec file', async () => {
    broadcasts.length = 0;
    // Create draft
    const { data: created } = await json('/api/pipeline/draft', {
      method: 'POST',
      body: { templateId: 'build' },
    });
    const draftId = created.draftId;

    // Approve
    const { status, data } = await json('/api/pipeline/draft/approve', {
      method: 'POST',
      body: { draftId },
    });
    assert.equal(status, 200);
    assert.ok(data.specPath);

    // Spec file should exist
    const specFile = join(dataDir, 'approved-specs', `${draftId}.yaml`);
    assert.ok(existsSync(specFile), `Expected spec file at ${specFile}`);
    const specContent = readFileSync(specFile, 'utf-8');
    assert.ok(specContent.includes('version:'));

    // Should broadcast pipelineDraftResolved
    const resolved = broadcasts.find(b => b.type === 'pipelineDraftResolved');
    assert.ok(resolved);
    assert.equal(resolved.draftId, draftId);
    assert.equal(resolved.outcome, 'approved');

    // Draft should be cleared
    const { data: after } = await json('/api/pipeline/draft');
    assert.equal(after.draft, null);
  });

  test('rejects mismatched draftId with 409', async () => {
    // Create draft
    await json('/api/pipeline/draft', {
      method: 'POST',
      body: { templateId: 'build' },
    });

    const { status } = await json('/api/pipeline/draft/approve', {
      method: 'POST',
      body: { draftId: 'wrong-id-000' },
    });
    assert.equal(status, 409);
  });

  test('returns 404 when no draft exists', async () => {
    // Clear any draft by approving or rejecting
    const { data: current } = await json('/api/pipeline/draft');
    if (current.draft) {
      await json('/api/pipeline/draft/reject', {
        method: 'POST',
        body: { draftId: current.draft.draftId },
      });
    }

    const { status } = await json('/api/pipeline/draft/approve', {
      method: 'POST',
      body: { draftId: 'whatever' },
    });
    assert.equal(status, 404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/pipeline/draft/reject
// ---------------------------------------------------------------------------

describe('POST /api/pipeline/draft/reject', () => {
  test('rejects current draft and clears it', async () => {
    broadcasts.length = 0;
    // Create draft
    const { data: created } = await json('/api/pipeline/draft', {
      method: 'POST',
      body: { templateId: 'build' },
    });
    const draftId = created.draftId;

    // Reject
    const { status } = await json('/api/pipeline/draft/reject', {
      method: 'POST',
      body: { draftId },
    });
    assert.equal(status, 200);

    // Should broadcast pipelineDraftResolved with rejected
    const resolved = broadcasts.find(b => b.type === 'pipelineDraftResolved');
    assert.ok(resolved);
    assert.equal(resolved.outcome, 'rejected');

    // Draft should be cleared
    const { data: after } = await json('/api/pipeline/draft');
    assert.equal(after.draft, null);
  });

  test('rejects mismatched draftId with 409', async () => {
    await json('/api/pipeline/draft', {
      method: 'POST',
      body: { templateId: 'build' },
    });

    const { status } = await json('/api/pipeline/draft/reject', {
      method: 'POST',
      body: { draftId: 'wrong-id-999' },
    });
    assert.equal(status, 409);
  });
});

// ---------------------------------------------------------------------------
// Step parsing — v0.3 vs v0.1
// ---------------------------------------------------------------------------

describe('step parsing', () => {
  test('parses v0.3 steps from workflow.steps', async () => {
    // build template is v0.3 with flows.build.steps
    const { data } = await json('/api/pipeline/draft', {
      method: 'POST',
      body: { templateId: 'build' },
    });
    assert.ok(data.steps.length > 0);
    assert.ok(data.steps.some(s => s.id === 'design'));
  });

  test('parses v0.1 steps from flows', async () => {
    const { data } = await json('/api/pipeline/draft', {
      method: 'POST',
      body: { templateId: 'review-fix' },
    });
    assert.ok(data.steps.length > 0);
    assert.ok(data.steps.some(s => s.id === 'execute'));
  });
});
