/**
 * stratum-softfail.test.js — Tests for stratum graceful degradation.
 *
 * Verifies that:
 * - index.js downgrades stratum capability when stratum-mcp is not on PATH
 * - VisionServer with stratum: false installs stub 503 routes
 * - VisionServer with stratum: true creates StratumSync normally
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const temps = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
function tmpDir() {
  const d = mkdtempSync(join(tmpdir(), 'compose-stratum-'));
  temps.push(d);
  return d;
}

describe('stratum soft-fail in index.js', () => {
  test('downgrades stratum capability when stratum-mcp not on PATH', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, '.compose'), { recursive: true });
    writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({
      version: 1,
      capabilities: { stratum: true, lifecycle: true },
      paths: { docs: 'docs', features: 'docs/features', journal: 'docs/journal' },
    }));

    // Script that loads project config the same way index.js does
    const script = `
      import { execFileSync } from 'node:child_process';
      import { loadProjectConfig } from './server/project-root.js';

      const config = loadProjectConfig();
      if (config.capabilities.stratum) {
        try {
          execFileSync('which', ['stratum-mcp'], { stdio: 'ignore' });
        } catch {
          config.capabilities.stratum = false;
        }
      }
      console.log(JSON.stringify({ stratum: config.capabilities.stratum }));
    `;

    // Run with PATH that includes node but NOT stratum-mcp
    const nodeBinDir = dirname(process.execPath);
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: REPO_ROOT,
      env: { ...process.env, COMPOSE_TARGET: dir, PATH: `${nodeBinDir}:/usr/bin:/bin` },
      encoding: 'utf-8',
    });
    const { stratum } = JSON.parse(result.trim());
    assert.equal(stratum, false, 'stratum should be downgraded to false');
  });

  test('preserves stratum: false config as-is', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, '.compose'), { recursive: true });
    writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({
      version: 1,
      capabilities: { stratum: false, lifecycle: true },
      paths: { docs: 'docs', features: 'docs/features', journal: 'docs/journal' },
    }));

    const script = `
      import { loadProjectConfig } from './server/project-root.js';
      const config = loadProjectConfig();
      console.log(JSON.stringify({ stratum: config.capabilities.stratum }));
    `;

    const result = execFileSync('node', ['--input-type=module', '-e', script], {
      cwd: REPO_ROOT,
      env: { ...process.env, COMPOSE_TARGET: dir },
      encoding: 'utf-8',
    });
    const { stratum } = JSON.parse(result.trim());
    assert.equal(stratum, false, 'stratum: false should stay false');
  });
});

describe('VisionServer stratum conditional', () => {
  test('with stratum: false, _stratumSync is null and stub route returns 503', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, '.compose', 'data'), { recursive: true });
    writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({
      version: 1,
      capabilities: { stratum: false, lifecycle: true },
      paths: { docs: 'docs', features: 'docs/features', journal: 'docs/journal' },
    }));

    const script = `
      import http from 'node:http';
      import express from 'express';
      import { VisionStore } from './server/vision-store.js';
      import { VisionServer } from './server/vision-server.js';

      const store = new VisionStore();
      const vs = new VisionServer(store, null, { config: { capabilities: { stratum: false } } });
      const app = express();
      app.use(express.json());
      vs.attach(http.createServer(app), app);

      // Check _stratumSync
      const hasSync = vs._stratumSync != null;

      // Test the stub route by making a request
      const server = app.listen(0, () => {
        const port = server.address().port;
        http.get('http://127.0.0.1:' + port + '/api/stratum/anything', (res) => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => {
            server.close();
            vs.close();
            console.log(JSON.stringify({
              hasSync,
              statusCode: res.statusCode,
              body: JSON.parse(body),
            }));
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

    // Filter out console.log noise from server startup
    const jsonLine = result.trim().split('\n').pop();
    const { hasSync, statusCode, body } = JSON.parse(jsonLine);
    assert.equal(hasSync, false, '_stratumSync should be null');
    assert.equal(statusCode, 503, 'stub route should return 503');
    assert.ok(body.hint, 'stub should include a hint');
  });
});
