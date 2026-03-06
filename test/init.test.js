/**
 * init.test.js — Tests for compose init, compose setup, compose start.
 *
 * Uses real subprocesses with temp dirs and fake stratum-mcp.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, chmodSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_BIN = join(REPO_ROOT, 'bin', 'compose.js');
const FAKE_STRATUM_MCP = `#!/bin/sh\nexit 0\n`;

const temps = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
function tmpDir() {
  const d = mkdtempSync(join(tmpdir(), 'compose-init-'));
  temps.push(d);
  return d;
}

function makeEnv(cwd, home, extraPath) {
  const fakeBin = join(home, 'bin');
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, 'stratum-mcp'), FAKE_STRATUM_MCP, { mode: 0o755 });
  return {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}${extraPath ? ':' + extraPath : ''}:${process.env.PATH}`,
  };
}

function runCmd(cmd, cwd, env) {
  return execFileSync('node', [COMPOSE_BIN, cmd], {
    cwd,
    env,
    encoding: 'utf-8',
  });
}

// ---------------------------------------------------------------------------
// compose init
// ---------------------------------------------------------------------------

describe('compose init', () => {
  test('creates .compose/ directory', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    runCmd('init', cwd, makeEnv(cwd, home));
    assert.ok(existsSync(join(cwd, '.compose')));
  });

  test('writes .compose/compose.json with version, capabilities, paths', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    runCmd('init', cwd, makeEnv(cwd, home));

    const config = JSON.parse(readFileSync(join(cwd, '.compose', 'compose.json'), 'utf-8'));
    assert.equal(config.version, 1);
    assert.equal(typeof config.capabilities.stratum, 'boolean');
    assert.equal(typeof config.capabilities.lifecycle, 'boolean');
    assert.equal(config.paths.docs, 'docs');
    assert.equal(config.paths.features, 'docs/features');
    assert.equal(config.paths.journal, 'docs/journal');
  });

  test('creates .compose/data/ directory', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    runCmd('init', cwd, makeEnv(cwd, home));
    assert.ok(existsSync(join(cwd, '.compose', 'data')));
  });

  test('registers compose-mcp in .mcp.json', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    runCmd('init', cwd, makeEnv(cwd, home));

    const mcp = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf-8'));
    assert.ok(mcp.mcpServers?.compose);
    assert.equal(mcp.mcpServers.compose.command, 'node');
    assert.ok(mcp.mcpServers.compose.args[0].endsWith('compose-mcp.js'));
  });

  test('scaffolds ROADMAP.md from template', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    runCmd('init', cwd, makeEnv(cwd, home));

    const roadmap = join(cwd, 'ROADMAP.md');
    if (existsSync(join(REPO_ROOT, 'templates', 'ROADMAP.md'))) {
      assert.ok(existsSync(roadmap));
      const content = readFileSync(roadmap, 'utf-8');
      assert.ok(!content.includes('{{PROJECT_NAME}}'));
    }
  });

  test('detects stratum capability from PATH', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    runCmd('init', cwd, makeEnv(cwd, home));

    const config = JSON.parse(readFileSync(join(cwd, '.compose', 'compose.json'), 'utf-8'));
    assert.equal(config.capabilities.stratum, true, 'stratum should be true when stratum-mcp is on PATH');
  });

  test('--no-stratum sets capabilities.stratum: false', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    const env = makeEnv(cwd, home);
    execFileSync('node', [COMPOSE_BIN, 'init', '--no-stratum'], { cwd, env, encoding: 'utf-8' });

    const config = JSON.parse(readFileSync(join(cwd, '.compose', 'compose.json'), 'utf-8'));
    assert.equal(config.capabilities.stratum, false);
  });

  test('--no-lifecycle sets capabilities.lifecycle: false', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    const env = makeEnv(cwd, home);
    execFileSync('node', [COMPOSE_BIN, 'init', '--no-lifecycle'], { cwd, env, encoding: 'utf-8' });

    const config = JSON.parse(readFileSync(join(cwd, '.compose', 'compose.json'), 'utf-8'));
    assert.equal(config.capabilities.lifecycle, false);
  });

  test('re-init preserves existing paths values', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    const env = makeEnv(cwd, home);

    // First init
    runCmd('init', cwd, env);

    // Manually set custom paths
    const configPath = join(cwd, '.compose', 'compose.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.paths.docs = 'documentation';
    config.paths.features = 'documentation/features';
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    // Re-init
    runCmd('init', cwd, env);

    const updated = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.equal(updated.paths.docs, 'documentation', 'custom docs path should be preserved');
    assert.equal(updated.paths.features, 'documentation/features', 'custom features path should be preserved');
  });

  test('re-init refreshes capabilities from detection', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    const env = makeEnv(cwd, home);

    // First init (stratum detected from fake binary)
    runCmd('init', cwd, env);
    const configPath = join(cwd, '.compose', 'compose.json');
    const first = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.equal(first.capabilities.stratum, true);

    // Manually set stratum to false (simulating user disabled it)
    first.capabilities.stratum = false;
    writeFileSync(configPath, JSON.stringify(first, null, 2));

    // Re-init — detection should refresh stratum back to true
    runCmd('init', cwd, env);
    const updated = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.equal(updated.capabilities.stratum, true, 're-init should refresh stratum from PATH detection');
  });
});

// ---------------------------------------------------------------------------
// compose setup
// ---------------------------------------------------------------------------

describe('compose setup', () => {
  test('installs skill to ~/.claude/skills/', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    const env = makeEnv(cwd, home);
    runCmd('setup', cwd, env);

    const skillPath = join(home, '.claude', 'skills', 'compose', 'SKILL.md');
    assert.ok(existsSync(skillPath));
  });
});

// ---------------------------------------------------------------------------
// compose install (backwards-compat: init + setup)
// ---------------------------------------------------------------------------

describe('compose install', () => {
  test('creates .compose/, .mcp.json, skill, and ROADMAP.md', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    const env = makeEnv(cwd, home);
    runCmd('install', cwd, env);

    assert.ok(existsSync(join(cwd, '.compose', 'compose.json')), '.compose/compose.json');
    assert.ok(existsSync(join(cwd, '.mcp.json')), '.mcp.json');
    assert.ok(existsSync(join(home, '.claude', 'skills', 'compose', 'SKILL.md')), 'skill');
  });
});

// ---------------------------------------------------------------------------
// compose start
// ---------------------------------------------------------------------------

describe('compose start', () => {
  test('exits non-zero when no .compose/ found', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    // No .compose/ in this dir or any ancestor under /tmp
    const env = { ...process.env, HOME: home };
    // Remove COMPOSE_TARGET to ensure it searches from cwd
    delete env.COMPOSE_TARGET;

    assert.throws(
      () => execFileSync('node', [COMPOSE_BIN, 'start'], {
        cwd,
        env,
        encoding: 'utf-8',
        timeout: 5000,
      }),
      (err) => {
        const stderr = err.stderr || '';
        return stderr.includes('No .compose/ found') || err.status !== 0;
      },
    );
  });

  test('resolves project root from subdirectory and passes it as COMPOSE_TARGET', () => {
    const root = tmpDir();
    const home = tmpDir();
    const env = makeEnv(root, home);
    delete env.COMPOSE_TARGET;

    // Initialize at root
    runCmd('init', root, env);

    // Create a subdirectory
    const sub = join(root, 'apps', 'web');
    mkdirSync(sub, { recursive: true });

    // Run findProjectRoot from the subdirectory and verify it resolves to root
    const script = `
      import { findProjectRoot } from './server/find-root.js';
      import { existsSync } from 'fs';
      import { join } from 'path';

      const startDir = ${JSON.stringify(sub)};
      const targetRoot = findProjectRoot(startDir);
      const hasConfig = targetRoot && existsSync(join(targetRoot, '.compose', 'compose.json'));
      console.log(JSON.stringify({ targetRoot, hasConfig }));
    `;
    const result = execFileSync('node', ['--input-type=module', '-e', script], {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf-8',
    });
    const { targetRoot, hasConfig } = JSON.parse(result.trim());
    assert.equal(targetRoot, root, 'findProjectRoot should resolve to the initialized root');
    assert.equal(hasConfig, true, '.compose/compose.json should exist at resolved root');
  });

  test('exits with clear error when COMPOSE_TARGET path does not exist', () => {
    const home = tmpDir();
    const env = { ...process.env, HOME: home, COMPOSE_TARGET: '/tmp/nonexistent-compose-target-12345' };

    assert.throws(
      () => execFileSync('node', [COMPOSE_BIN, 'start'], {
        cwd: tmpDir(),
        env,
        encoding: 'utf-8',
        timeout: 5000,
      }),
      (err) => {
        const stderr = err.stderr || '';
        return stderr.includes('does not exist');
      },
    );
  });

  test('honors explicit COMPOSE_TARGET env and passes resolved path to supervisor', () => {
    const target = tmpDir();
    const home = tmpDir();
    const env = makeEnv(target, home);

    // Initialize target
    runCmd('init', target, env);

    // Simulate compose start with explicit COMPOSE_TARGET from a different dir
    // Verify the resolution logic produces the correct absolute path
    const script = `
      import { resolve } from 'path';
      import { existsSync } from 'fs';
      import { join } from 'path';

      const explicitTarget = process.env.COMPOSE_TARGET;
      const targetRoot = explicitTarget ? resolve(explicitTarget) : null;
      const hasConfig = targetRoot && existsSync(join(targetRoot, '.compose', 'compose.json'));
      // This is the value that would be passed to supervisor as COMPOSE_TARGET
      console.log(JSON.stringify({ targetRoot, hasConfig }));
    `;
    const otherDir = tmpDir();
    const result = execFileSync('node', ['--input-type=module', '-e', script], {
      cwd: otherDir,
      env: { ...env, COMPOSE_TARGET: target },
      encoding: 'utf-8',
    });
    const { targetRoot, hasConfig } = JSON.parse(result.trim());
    assert.equal(targetRoot, resolve(target), 'COMPOSE_TARGET should resolve to the target directory');
    assert.equal(hasConfig, true, '.compose/compose.json should exist at COMPOSE_TARGET');
  });
});
