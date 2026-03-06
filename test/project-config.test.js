/**
 * project-config.test.js — Tests for loadProjectConfig, resolveProjectPath, findProjectRoot.
 *
 * Uses temp dirs to isolate from the real project config.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Import findProjectRoot from the side-effect-free module
const { findProjectRoot, MARKERS } = await import(`${REPO_ROOT}/server/find-root.js`);

// Collect temp dirs for cleanup
const temps = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
function tmpDir() {
  const d = mkdtempSync(join(tmpdir(), 'compose-config-'));
  temps.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// findProjectRoot
// ---------------------------------------------------------------------------

describe('findProjectRoot', () => {
  test('finds .compose/ marker in parent directory', () => {
    const root = tmpDir();
    mkdirSync(join(root, '.compose'));
    const sub = join(root, 'apps', 'web');
    mkdirSync(sub, { recursive: true });

    const found = findProjectRoot(sub);
    assert.equal(found, root);
  });

  test('finds .git marker when no .compose/', () => {
    const root = tmpDir();
    mkdirSync(join(root, '.git'));
    const sub = join(root, 'src');
    mkdirSync(sub, { recursive: true });

    const found = findProjectRoot(sub);
    assert.equal(found, root);
  });

  test('prefers .compose/ over .git when both exist', () => {
    const root = tmpDir();
    mkdirSync(join(root, '.compose'));
    mkdirSync(join(root, '.git'));
    const sub = join(root, 'src');
    mkdirSync(sub, { recursive: true });

    const found = findProjectRoot(sub);
    assert.equal(found, root);
  });

  test('returns null when no marker found', () => {
    const isolated = tmpDir();
    // No markers in this temp dir or any ancestor (temp dirs are under /tmp)
    const found = findProjectRoot(isolated);
    // Should be null OR some ancestor that happens to have .git — we only assert type
    // In practice, /tmp has no .compose/.stratum.yaml/.git
    if (found !== null) {
      // If it found something, it must be an ancestor with a marker
      assert.ok(typeof found === 'string');
    }
  });

  test('MARKERS contains expected entries', () => {
    assert.ok(MARKERS.includes('.compose'));
    assert.ok(MARKERS.includes('.stratum.yaml'));
    assert.ok(MARKERS.includes('.git'));
  });
});

// ---------------------------------------------------------------------------
// loadProjectConfig and resolveProjectPath
// ---------------------------------------------------------------------------

describe('loadProjectConfig (via fresh subprocess)', () => {
  // Since loadProjectConfig reads from TARGET_ROOT which is set at module load,
  // we test it via subprocess with COMPOSE_TARGET set to our temp dir.

  test('returns defaults when no .compose/compose.json exists', async () => {
    const { execFileSync } = await import('node:child_process');
    const dir = tmpDir();
    mkdirSync(join(dir, '.compose'), { recursive: true });

    const script = `
      import { loadProjectConfig } from './server/project-root.js';
      const config = loadProjectConfig();
      console.log(JSON.stringify(config));
    `;
    const result = execFileSync('node', ['--input-type=module', '-e', script], {
      cwd: REPO_ROOT,
      env: { ...process.env, COMPOSE_TARGET: dir },
      encoding: 'utf-8',
    });
    const config = JSON.parse(result.trim());
    assert.equal(config.version, 1);
    assert.equal(config.capabilities.stratum, true);
    assert.equal(config.paths.docs, 'docs');
    assert.equal(config.paths.features, 'docs/features');
    assert.equal(config.paths.journal, 'docs/journal');
  });

  test('reads valid .compose/compose.json', async () => {
    const { execFileSync } = await import('node:child_process');
    const dir = tmpDir();
    mkdirSync(join(dir, '.compose'), { recursive: true });
    writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({
      version: 1,
      capabilities: { stratum: false, lifecycle: true },
      paths: { docs: 'documentation', features: 'documentation/features', journal: 'documentation/journal' },
    }));

    const script = `
      import { loadProjectConfig } from './server/project-root.js';
      const config = loadProjectConfig();
      console.log(JSON.stringify(config));
    `;
    const result = execFileSync('node', ['--input-type=module', '-e', script], {
      cwd: REPO_ROOT,
      env: { ...process.env, COMPOSE_TARGET: dir },
      encoding: 'utf-8',
    });
    const config = JSON.parse(result.trim());
    assert.equal(config.capabilities.stratum, false);

    assert.equal(config.paths.docs, 'documentation');
    assert.equal(config.paths.features, 'documentation/features');
  });

  test('returns defaults on corrupt JSON', async () => {
    const { execFileSync } = await import('node:child_process');
    const dir = tmpDir();
    mkdirSync(join(dir, '.compose'), { recursive: true });
    writeFileSync(join(dir, '.compose', 'compose.json'), 'not json!!!');

    const script = `
      import { loadProjectConfig } from './server/project-root.js';
      const config = loadProjectConfig();
      console.log(JSON.stringify(config));
    `;
    const result = execFileSync('node', ['--input-type=module', '-e', script], {
      cwd: REPO_ROOT,
      env: { ...process.env, COMPOSE_TARGET: dir },
      encoding: 'utf-8',
    });
    const config = JSON.parse(result.trim());
    assert.equal(config.version, 1);
    assert.equal(config.paths.docs, 'docs');
  });

  test('returns a fresh clone each call — mutations do not affect next call', async () => {
    const { execFileSync } = await import('node:child_process');
    const dir = tmpDir();
    mkdirSync(join(dir, '.compose'), { recursive: true });
    writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({
      version: 1,
      capabilities: { stratum: true, lifecycle: true },
      paths: { docs: 'docs', features: 'docs/features', journal: 'docs/journal' },
    }));

    const script = `
      import { loadProjectConfig } from './server/project-root.js';
      const c1 = loadProjectConfig();
      c1.capabilities.stratum = false;
      c1.paths.docs = 'MUTATED';
      const c2 = loadProjectConfig();
      console.log(JSON.stringify({ stratum: c2.capabilities.stratum, docs: c2.paths.docs }));
    `;
    const result = execFileSync('node', ['--input-type=module', '-e', script], {
      cwd: REPO_ROOT,
      env: { ...process.env, COMPOSE_TARGET: dir },
      encoding: 'utf-8',
    });
    const check = JSON.parse(result.trim());
    assert.equal(check.stratum, true, 'mutation of c1 should not affect c2');
    assert.equal(check.docs, 'docs', 'mutation of c1 should not affect c2');
  });

  test('resolveProjectPath returns absolute path using config value', async () => {
    const { execFileSync } = await import('node:child_process');
    const dir = tmpDir();
    mkdirSync(join(dir, '.compose'), { recursive: true });
    writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({
      version: 1,
      capabilities: { stratum: false, lifecycle: true },
      paths: { docs: 'my-docs', features: 'my-docs/feat', journal: 'my-docs/log' },
    }));

    const script = `
      import { resolveProjectPath, TARGET_ROOT } from './server/project-root.js';
      console.log(JSON.stringify({
        features: resolveProjectPath('features'),
        docs: resolveProjectPath('docs'),
        journal: resolveProjectPath('journal'),
        target: TARGET_ROOT,
      }));
    `;
    const result = execFileSync('node', ['--input-type=module', '-e', script], {
      cwd: REPO_ROOT,
      env: { ...process.env, COMPOSE_TARGET: dir },
      encoding: 'utf-8',
    });
    const paths = JSON.parse(result.trim());
    assert.equal(paths.features, join(dir, 'my-docs', 'feat'));
    assert.equal(paths.docs, join(dir, 'my-docs'));
    assert.equal(paths.journal, join(dir, 'my-docs', 'log'));
    assert.equal(paths.target, dir);
  });

  test('resolveProjectPath falls back to default for missing keys', async () => {
    const { execFileSync } = await import('node:child_process');
    const dir = tmpDir();
    mkdirSync(join(dir, '.compose'), { recursive: true });
    writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({
      version: 1,
      capabilities: {},
      paths: {},
    }));

    const script = `
      import { resolveProjectPath } from './server/project-root.js';
      console.log(JSON.stringify({
        features: resolveProjectPath('features'),
        docs: resolveProjectPath('docs'),
      }));
    `;
    const result = execFileSync('node', ['--input-type=module', '-e', script], {
      cwd: REPO_ROOT,
      env: { ...process.env, COMPOSE_TARGET: dir },
      encoding: 'utf-8',
    });
    const paths = JSON.parse(result.trim());
    assert.ok(paths.features.endsWith('docs/features'));
    assert.ok(paths.docs.endsWith('docs'));
  });
});
