/**
 * artifact-manager.test.js — Assessment, scaffold, path safety, and
 * integration tests for artifact awareness.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { ArtifactManager, ARTIFACT_SCHEMAS } =
  await import(`${REPO_ROOT}/server/artifact-manager.js`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setup() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'am-test-'));
  const featureRoot = join(tmpDir, 'features');
  mkdirSync(join(featureRoot, 'TEST-1'), { recursive: true });
  const manager = new ArtifactManager(featureRoot);
  return { tmpDir, featureRoot, manager };
}

function cleanup(tmpDir) {
  rmSync(tmpDir, { recursive: true, force: true });
}

function makeDesign(dir, content) {
  writeFileSync(join(dir, 'TEST-1', 'design.md'), content, 'utf-8');
}

// Generate filler text of ~n words
function filler(n) {
  return Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
}

// ---------------------------------------------------------------------------
// Assessment tests
// ---------------------------------------------------------------------------

describe('assessOne', () => {
  let ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => cleanup(ctx.tmpDir));

  test('file does not exist', () => {
    const result = ctx.manager.assessOne('TEST-1', 'design.md');
    assert.equal(result.exists, false);
    assert.equal(result.completeness, 0);
    assert.equal(result.wordCount, 0);
    assert.equal(result.meetsMinWordCount, false);
    assert.deepEqual(result.sections.missing, ['Problem', 'Goal']);
    assert.equal(result.lastModified, null);
  });

  test('stub file — headings only, below min word count', () => {
    makeDesign(ctx.featureRoot, '## Problem\n\nShort.\n\n## Goal\n\nAlso short.\n');
    const result = ctx.manager.assessOne('TEST-1', 'design.md');
    assert.equal(result.exists, true);
    assert.equal(result.completeness, 1.0);
    assert.equal(result.meetsMinWordCount, false);
    assert.deepEqual(result.sections.found, ['Problem', 'Goal']);
    assert.deepEqual(result.sections.missing, []);
  });

  test('complete file — all sections, above min word count', () => {
    const content = `## Problem\n\n${filler(130)}\n\n## Goal\n\n${filler(130)}\n`;
    makeDesign(ctx.featureRoot, content);
    const result = ctx.manager.assessOne('TEST-1', 'design.md');
    assert.equal(result.exists, true);
    assert.equal(result.completeness, 1.0);
    assert.equal(result.meetsMinWordCount, true);
    assert.ok(result.lastModified);
  });

  test('missing required section', () => {
    makeDesign(ctx.featureRoot, `## Problem\n\n${filler(250)}\n`);
    const result = ctx.manager.assessOne('TEST-1', 'design.md');
    assert.equal(result.completeness, 0.5);
    assert.deepEqual(result.sections.missing, ['Goal']);
    assert.deepEqual(result.sections.found, ['Problem']);
  });

  test('regex pattern matching — Decision \\d+', () => {
    const content = `## Problem\n\n${filler(100)}\n\n## Goal\n\n${filler(100)}\n\n## Decision 1\n\nFoo\n\n## Decision 2\n\nBar\n`;
    makeDesign(ctx.featureRoot, content);
    const result = ctx.manager.assessOne('TEST-1', 'design.md');
    assert.ok(result.sections.optional.includes('Decision \\d+'));
  });

  test('heading level agnostic', () => {
    const content = `#### Problem\n\n${filler(130)}\n\n# Goal\n\n${filler(130)}\n`;
    makeDesign(ctx.featureRoot, content);
    const result = ctx.manager.assessOne('TEST-1', 'design.md');
    assert.equal(result.completeness, 1.0);
    assert.deepEqual(result.sections.found, ['Problem', 'Goal']);
  });

  test('trailing punctuation stripped', () => {
    const content = `## Problem:\n\n${filler(130)}\n\n## Goal —\n\n${filler(130)}\n`;
    makeDesign(ctx.featureRoot, content);
    const result = ctx.manager.assessOne('TEST-1', 'design.md');
    assert.equal(result.completeness, 1.0);
    assert.deepEqual(result.sections.found, ['Problem', 'Goal']);
  });
});

describe('assess (full)', () => {
  let ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => cleanup(ctx.tmpDir));

  test('returns signals for all 6 artifacts', () => {
    const dir = join(ctx.featureRoot, 'TEST-1');
    writeFileSync(join(dir, 'design.md'), `## Problem\n\n${filler(250)}\n\n## Goal\n\nDone.\n`);
    writeFileSync(join(dir, 'blueprint.md'), `## File Plan\n\n${filler(350)}\n`);

    const result = ctx.manager.assess('TEST-1');
    assert.equal(Object.keys(result.artifacts).length, 6);
    assert.equal(result.artifacts['design.md'].exists, true);
    assert.equal(result.artifacts['blueprint.md'].exists, true);
    assert.equal(result.artifacts['prd.md'].exists, false);
    assert.equal(result.artifacts['architecture.md'].exists, false);
    assert.equal(result.artifacts['plan.md'].exists, false);
    assert.equal(result.artifacts['report.md'].exists, false);
  });
});

// ---------------------------------------------------------------------------
// Scaffold tests
// ---------------------------------------------------------------------------

describe('scaffold', () => {
  let ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => cleanup(ctx.tmpDir));

  test('empty folder — creates all templates + sessions dir', () => {
    const result = ctx.manager.scaffold('TEST-1');
    assert.equal(result.created.length, 6);
    assert.equal(result.skipped.length, 0);
    assert.ok(existsSync(join(ctx.featureRoot, 'TEST-1', 'sessions')));
    for (const filename of Object.keys(ARTIFACT_SCHEMAS)) {
      assert.ok(existsSync(join(ctx.featureRoot, 'TEST-1', filename)));
    }
  });

  test('existing files preserved', () => {
    const custom = '# My custom design\n\nCustom content.\n';
    writeFileSync(join(ctx.featureRoot, 'TEST-1', 'design.md'), custom);

    const result = ctx.manager.scaffold('TEST-1');
    assert.ok(result.skipped.includes('design.md'));
    assert.ok(result.created.includes('prd.md'));
    assert.equal(result.created.length, 5);
    assert.equal(result.skipped.length, 1);
    assert.equal(readFileSync(join(ctx.featureRoot, 'TEST-1', 'design.md'), 'utf-8'), custom);
  });

  test('options.only limits scaffolding', () => {
    const result = ctx.manager.scaffold('TEST-1', { only: ['design.md', 'plan.md'] });
    assert.equal(result.created.length, 2);
    assert.ok(result.created.includes('design.md'));
    assert.ok(result.created.includes('plan.md'));
    assert.ok(!existsSync(join(ctx.featureRoot, 'TEST-1', 'prd.md')));
  });
});

// ---------------------------------------------------------------------------
// Path safety tests
// ---------------------------------------------------------------------------

describe('path safety', () => {
  let ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => cleanup(ctx.tmpDir));

  const invalidCodes = ['../etc', 'foo/bar', 'foo\\bar', '..', ''];

  test('invalid featureCode — table-driven', () => {
    for (const code of invalidCodes) {
      assert.throws(() => ctx.manager.assess(code), /Invalid featureCode/);
      assert.throws(() => ctx.manager.assessOne(code, 'design.md'), /Invalid featureCode/);
      assert.throws(() => ctx.manager.scaffold(code), /Invalid featureCode/);
    }
  });

  const invalidFilenames = ['../../etc/passwd', 'nonexistent.md', '../design.md', ''];

  test('invalid filename in assessOne — table-driven', () => {
    for (const filename of invalidFilenames) {
      assert.throws(() => ctx.manager.assessOne('TEST-1', filename), /Unknown artifact/);
    }
  });

  test('symlink escape — directory level', () => {
    const outside = join(ctx.tmpDir, 'outside');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(ctx.featureRoot, 'SYMLINK-1'));

    assert.throws(() => ctx.manager.assess('SYMLINK-1'), /Symlink escapes feature root/);
    assert.throws(() => ctx.manager.scaffold('SYMLINK-1'), /Symlink escapes feature root/);
  });

  test('symlink escape — file level', () => {
    const outside = join(ctx.tmpDir, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'design.md'), '# Stolen data\n');
    symlinkSync(join(outside, 'design.md'), join(ctx.featureRoot, 'TEST-1', 'design.md'));

    assert.throws(() => ctx.manager.assessOne('TEST-1', 'design.md'), /Symlink escapes feature root/);
  });
});

// ---------------------------------------------------------------------------
// getSchema / getTemplate tests
// ---------------------------------------------------------------------------

describe('getSchema', () => {
  let ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => cleanup(ctx.tmpDir));

  test('known artifact returns schema', () => {
    const schema = ctx.manager.getSchema('design.md');
    assert.ok(schema);
    assert.ok(Array.isArray(schema.requiredSections));
    assert.ok(schema.requiredSections.includes('Problem'));
  });

  test('unknown artifact returns null', () => {
    assert.equal(ctx.manager.getSchema('nonexistent.md'), null);
  });
});

describe('getTemplate', () => {
  let ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => cleanup(ctx.tmpDir));

  test('known template returns content', () => {
    const content = ctx.manager.getTemplate('design.md');
    assert.ok(content.includes('## Problem'));
  });

  test('unknown template throws', () => {
    assert.throws(() => ctx.manager.getTemplate('nonexistent.md'), /Unknown artifact/);
  });

  test('traversal attempt in getTemplate throws', () => {
    assert.throws(() => ctx.manager.getTemplate('../../etc/passwd'), /Unknown artifact/);
  });
});

// ---------------------------------------------------------------------------
// Schema-artifact invariant
// ---------------------------------------------------------------------------

describe('schema-artifact invariant', () => {
  test('module loaded without error — invariant passed', () => {
    assert.ok(ARTIFACT_SCHEMAS);
    assert.equal(Object.keys(ARTIFACT_SCHEMAS).length, 6);
  });
});

// ---------------------------------------------------------------------------
// REST endpoint tests
// ---------------------------------------------------------------------------

import http from 'node:http';
import express from 'express';

const { VisionStore } = await import(`${REPO_ROOT}/server/vision-store.js`);
const { attachVisionRoutes } = await import(`${REPO_ROOT}/server/vision-routes.js`);

function setupServer() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'am-route-'));
  const dataDir = join(tmpDir, 'data');
  mkdirSync(dataDir, { recursive: true });

  const featureRoot = join(tmpDir, 'docs', 'features');
  mkdirSync(join(featureRoot, 'TEST-1'), { recursive: true });

  const store = new VisionStore(dataDir);
  const item = store.createItem({ type: 'feature', title: 'Artifact Test Feature' });

  const app = express();
  app.use(express.json());
  attachVisionRoutes(app, {
    store,
    scheduleBroadcast: () => {},
    broadcastMessage: () => {},
    projectRoot: tmpDir,
  });

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      resolve({ tmpDir, store, item, server, port, featureRoot });
    });
  });
}

function req(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const r = http.request(
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
    r.on('error', reject);
    r.end(data);
  });
}

describe('artifact REST endpoints', () => {
  let ctx;
  beforeEach(async () => { ctx = await setupServer(); });
  afterEach(() => {
    ctx.server.close();
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  test('GET artifacts — returns assessment after lifecycle start', async () => {
    await req(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/start`,
      { featureCode: 'TEST-1' });

    const res = await req(ctx.port, 'GET',
      `/api/vision/items/${ctx.item.id}/artifacts`);
    assert.equal(res.status, 200);
    assert.ok(res.body.artifacts);
    assert.equal(Object.keys(res.body.artifacts).length, 6);
    assert.equal(res.body.artifacts['design.md'].exists, false);
  });

  test('POST scaffold — creates templates', async () => {
    await req(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/lifecycle/start`,
      { featureCode: 'TEST-1' });

    const res = await req(ctx.port, 'POST',
      `/api/vision/items/${ctx.item.id}/artifacts/scaffold`, {});
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.created));
    assert.equal(res.body.created.length, 6);
    assert.equal(res.body.skipped.length, 0);
    assert.ok(existsSync(join(ctx.featureRoot, 'TEST-1', 'design.md')));
  });

  test('GET artifacts — 400 when no lifecycle', async () => {
    const res = await req(ctx.port, 'GET',
      `/api/vision/items/${ctx.item.id}/artifacts`);
    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes('no lifecycle'));
  });
});

// ---------------------------------------------------------------------------
// MCP tool wiring tests
// ---------------------------------------------------------------------------

describe('MCP artifact tool schemas', () => {
  test('compose-mcp.js contains both artifact tool names', async () => {
    const source = readFileSync(join(REPO_ROOT, 'server', 'compose-mcp.js'), 'utf-8');
    for (const name of ['assess_feature_artifacts', 'scaffold_feature']) {
      assert.ok(source.includes(`name: '${name}'`), `Missing tool definition: ${name}`);
      assert.ok(source.includes(`case '${name}'`), `Missing switch case: ${name}`);
    }
  });

  test('toolAssessFeatureArtifacts returns correct shape', async () => {
    const { toolAssessFeatureArtifacts } = await import(`${REPO_ROOT}/server/compose-mcp-tools.js`);
    const result = toolAssessFeatureArtifacts({ featureCode: 'artifact-awareness' });
    assert.ok(result.artifacts);
    assert.equal(typeof result.artifacts['design.md'], 'object');
    assert.equal(typeof result.artifacts['design.md'].exists, 'boolean');
    assert.equal(typeof result.artifacts['design.md'].completeness, 'number');
  });
});
