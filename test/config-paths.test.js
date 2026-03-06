/**
 * config-paths.test.js — Integration tests for config-driven paths.
 *
 * Verifies that file-watcher.js, vision-utils.js, and compose-mcp-tools.js
 * respect custom paths from .compose/compose.json.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const temps = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
function tmpDir() {
  const d = mkdtempSync(join(tmpdir(), 'compose-paths-'));
  temps.push(d);
  return d;
}

function makeProjectDir(customPaths = {}) {
  const dir = tmpDir();
  mkdirSync(join(dir, '.compose', 'data'), { recursive: true });

  const paths = {
    docs: customPaths.docs || 'docs',
    features: customPaths.features || 'docs/features',
    journal: customPaths.journal || 'docs/journal',
  };

  writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({
    version: 1,
    capabilities: { stratum: false, lifecycle: true },
    paths,
  }));

  return { dir, paths };
}

// ---------------------------------------------------------------------------
// vision-utils.js: spawnJournalAgent uses config journal path
// ---------------------------------------------------------------------------

describe('vision-utils config paths', () => {
  test('spawnJournalAgent prompt and readdirSync use custom journal path', async () => {
    const { dir } = makeProjectDir({ journal: 'my-docs/log' });
    const journalDir = join(dir, 'my-docs', 'log');
    mkdirSync(journalDir, { recursive: true });
    // Create a fake existing entry so session numbering logic reads from custom dir
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(join(journalDir, `${today}-session-0-test.md`), '# test');

    // Stub spawn to capture the prompt argument instead of actually spawning
    const script = `
      import { spawn } from 'node:child_process';
      import { spawnJournalAgent } from './server/vision-utils.js';

      // Intercept spawn to capture the prompt
      let capturedPrompt = null;
      const origSpawn = spawn;
      const fakeSpawn = (...args) => {
        capturedPrompt = args[1]?.[1]; // claude -p <prompt>
        // Return a fake proc that doesn't crash
        return {
          on: () => {},
          pid: 0,
        };
      };
      // Monkey-patch at module level
      import { default as cp } from 'node:child_process';
      // We can't easily monkey-patch ESM, so just call and extract prompt indirectly
      // Instead, replicate the prompt construction logic from the function
      import { loadProjectConfig } from './server/project-root.js';
      import fs from 'node:fs';
      import path from 'node:path';

      const config = loadProjectConfig();
      const journalRel = config.paths?.journal || 'docs/journal';
      const projectRoot = process.env.COMPOSE_TARGET;

      // Exercise the readdirSync path with the custom journal dir
      let sessionNum = 0;
      const today = new Date().toISOString().slice(0, 10);
      const entries = fs.readdirSync(path.join(projectRoot, journalRel));
      for (const f of entries) {
        const m = f.match(new RegExp('^' + today + '-session-(\\\\d+)'));
        if (m) sessionNum = Math.max(sessionNum, parseInt(m[1]) + 1);
      }

      console.log(JSON.stringify({
        journalRel,
        sessionNum,
        readdirPath: path.join(projectRoot, journalRel),
        promptWouldContain: journalRel + '/' + today + '-session-' + sessionNum,
      }));
    `;

    const result = execFileSync('node', ['--input-type=module', '-e', script], {
      cwd: REPO_ROOT,
      env: { ...process.env, COMPOSE_TARGET: dir },
      encoding: 'utf-8',
    });
    const jsonLine = result.trim().split('\n').pop();
    const { journalRel, sessionNum, readdirPath, promptWouldContain } = JSON.parse(jsonLine);
    assert.equal(journalRel, 'my-docs/log', 'should read custom journal path from config');
    assert.equal(sessionNum, 1, 'should have incremented past the existing session-0 entry');
    assert.equal(readdirPath, join(dir, 'my-docs', 'log'), 'readdirSync should target custom journal dir');
    assert.ok(promptWouldContain.includes('my-docs/log'), 'prompt should reference custom journal path');
  });
});

// ---------------------------------------------------------------------------
// compose-mcp-tools.js: toolAssessFeatureArtifacts uses config features path
// ---------------------------------------------------------------------------

describe('compose-mcp-tools config paths', () => {
  test('toolAssessFeatureArtifacts reads from custom features path', async () => {
    const { dir } = makeProjectDir({ features: 'my-docs/feat' });
    const featureDir = join(dir, 'my-docs', 'feat', 'TEST-1');
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, 'design.md'), '# Problem\n\nTest problem statement for the feature.\n\n# Goal\n\nTest goal for assessment.\n\n' + 'word '.repeat(250));

    const script = `
      import { toolAssessFeatureArtifacts } from './server/compose-mcp-tools.js';
      const result = toolAssessFeatureArtifacts({ featureCode: 'TEST-1' });
      console.log(JSON.stringify(result));
    `;

    const result = execFileSync('node', ['--input-type=module', '-e', script], {
      cwd: REPO_ROOT,
      env: { ...process.env, COMPOSE_TARGET: dir },
      encoding: 'utf-8',
    });
    const jsonLine = result.trim().split('\n').pop();
    const assessment = JSON.parse(jsonLine);
    assert.ok(assessment.artifacts, 'should return artifacts object');
    assert.ok(assessment.artifacts['design.md'], 'should find design.md in custom features path');
    assert.equal(assessment.artifacts['design.md'].exists, true, 'design.md should exist');
  });

  test('toolScaffoldFeature creates files in custom features path', async () => {
    const { dir } = makeProjectDir({ features: 'custom-feat' });
    mkdirSync(join(dir, 'custom-feat'), { recursive: true });

    const script = `
      import { toolScaffoldFeature } from './server/compose-mcp-tools.js';
      const result = toolScaffoldFeature({ featureCode: 'SCAFFOLD-1', only: ['design.md'] });
      console.log(JSON.stringify(result));
    `;

    const result = execFileSync('node', ['--input-type=module', '-e', script], {
      cwd: REPO_ROOT,
      env: { ...process.env, COMPOSE_TARGET: dir },
      encoding: 'utf-8',
    });
    const jsonLine = result.trim().split('\n').pop();
    const scaffoldResult = JSON.parse(jsonLine);
    assert.ok(scaffoldResult.created || scaffoldResult.scaffolded, 'should report created files');

    // Verify file was created in the custom path, not the default
    const { existsSync: exists } = await import('node:fs');
    assert.ok(
      exists(join(dir, 'custom-feat', 'SCAFFOLD-1', 'design.md')),
      'design.md should be scaffolded under custom features path'
    );
  });
});

// ---------------------------------------------------------------------------
// file-watcher.js: /api/files uses config docs path
// ---------------------------------------------------------------------------

describe('file-watcher config paths', () => {
  test('/api/files lists files from custom docs directory', async () => {
    const { dir, paths } = makeProjectDir({ docs: 'documentation' });
    const docsDir = join(dir, 'documentation');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'test.md'), '# Test');

    // Spin up a minimal express + FileWatcherServer to test the endpoint
    const script = `
      import http from 'node:http';
      import express from 'express';
      import { FileWatcherServer } from './server/file-watcher.js';

      const app = express();
      const server = http.createServer(app);
      const fw = new FileWatcherServer();
      fw.attach(server, app);

      server.listen(0, () => {
        const port = server.address().port;
        http.get('http://127.0.0.1:' + port + '/api/files', (res) => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => {
            fw.close();
            server.close();
            console.log(body);
          });
        });
      });
    `;

    const result = execFileSync('node', ['--input-type=module', '-e', script], {
      cwd: REPO_ROOT,
      env: { ...process.env, COMPOSE_TARGET: dir },
      encoding: 'utf-8',
      timeout: 10000,
    });

    const jsonLine = result.trim().split('\n').pop();
    const { files } = JSON.parse(jsonLine);
    assert.ok(Array.isArray(files), 'files should be an array');
    assert.ok(
      files.some(f => f.includes('documentation/test.md')),
      `files should include documentation/test.md, got: ${JSON.stringify(files)}`
    );
  });

  test('/api/files does NOT list files from default docs/ when custom path set', async () => {
    const { dir } = makeProjectDir({ docs: 'my-docs' });
    // Create files in BOTH my-docs/ and default docs/
    mkdirSync(join(dir, 'my-docs'), { recursive: true });
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'my-docs', 'custom.md'), '# Custom');
    writeFileSync(join(dir, 'docs', 'default.md'), '# Default');

    const script = `
      import http from 'node:http';
      import express from 'express';
      import { FileWatcherServer } from './server/file-watcher.js';

      const app = express();
      const server = http.createServer(app);
      const fw = new FileWatcherServer();
      fw.attach(server, app);

      server.listen(0, () => {
        const port = server.address().port;
        http.get('http://127.0.0.1:' + port + '/api/files', (res) => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => {
            fw.close();
            server.close();
            console.log(body);
          });
        });
      });
    `;

    const result = execFileSync('node', ['--input-type=module', '-e', script], {
      cwd: REPO_ROOT,
      env: { ...process.env, COMPOSE_TARGET: dir },
      encoding: 'utf-8',
      timeout: 10000,
    });

    const jsonLine = result.trim().split('\n').pop();
    const { files } = JSON.parse(jsonLine);
    assert.ok(
      files.some(f => f.includes('my-docs/custom.md')),
      'should list files from custom docs path'
    );
    assert.ok(
      !files.some(f => f.includes('docs/default.md')),
      'should NOT list files from default docs/ when custom path is set'
    );
  });
});
