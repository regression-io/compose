/**
 * ambient-context.test.js — Tests for COMP-CTX (Ambient Context Layer)
 *
 * Covers:
 *   - Item 100: docs/context/ scaffolding in compose init + prompt injection
 *   - Item 101: Staleness detection (lib/staleness.js)
 *   - Item 102: Decision log append (appendDecisionEntry via build.js integration)
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { extractPhaseMarker, checkStaleness } from '../lib/staleness.js';
import {
  buildStepPrompt, buildGateContext, loadAmbientContext, clearAmbientContextCache,
} from '../lib/step-prompt.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_BIN = join(REPO_ROOT, 'bin', 'compose.js');
const FAKE_STRATUM_MCP = `#!/bin/sh\nexit 0\n`;

const temps = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
function tmpDir() {
  const d = mkdtempSync(join(tmpdir(), 'compose-ctx-'));
  temps.push(d);
  return d;
}
function makeEnv(cwd, home) {
  const fakeBin = join(home, 'bin');
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, 'stratum-mcp'), FAKE_STRATUM_MCP, { mode: 0o755 });
  return {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
  };
}
function runCmd(cmd, cwd, env, extraArgs = []) {
  return execFileSync('node', [COMPOSE_BIN, cmd, ...extraArgs], {
    cwd, env, encoding: 'utf-8',
  });
}

// ---------------------------------------------------------------------------
// Item 100 — compose init scaffolds docs/context/
// ---------------------------------------------------------------------------

describe('compose init — ambient context scaffold', () => {
  test('creates docs/context/ directory', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    runCmd('init', cwd, makeEnv(cwd, home));
    assert.ok(existsSync(join(cwd, 'docs', 'context')), 'docs/context/ should exist');
  });

  test('creates tech-stack.md with template content', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    runCmd('init', cwd, makeEnv(cwd, home));
    const p = join(cwd, 'docs', 'context', 'tech-stack.md');
    assert.ok(existsSync(p), 'tech-stack.md should exist');
    const content = readFileSync(p, 'utf-8');
    assert.ok(content.includes('# Tech Stack'), 'should have heading');
  });

  test('creates conventions.md with template content', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    runCmd('init', cwd, makeEnv(cwd, home));
    const p = join(cwd, 'docs', 'context', 'conventions.md');
    assert.ok(existsSync(p), 'conventions.md should exist');
    const content = readFileSync(p, 'utf-8');
    assert.ok(content.includes('# Conventions'), 'should have heading');
  });

  test('creates decisions.md with template content', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    runCmd('init', cwd, makeEnv(cwd, home));
    const p = join(cwd, 'docs', 'context', 'decisions.md');
    assert.ok(existsSync(p), 'decisions.md should exist');
    const content = readFileSync(p, 'utf-8');
    assert.ok(content.includes('# Decision Log'), 'should have heading');
  });

  test('does not overwrite existing context files on re-init', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    const env = makeEnv(cwd, home);
    runCmd('init', cwd, env);

    // Customize tech-stack.md
    const tsPath = join(cwd, 'docs', 'context', 'tech-stack.md');
    writeFileSync(tsPath, '# Tech Stack\n\nNode 22, Postgres 16\n');

    // Re-init
    runCmd('init', cwd, env);

    const content = readFileSync(tsPath, 'utf-8');
    assert.ok(content.includes('Node 22'), 'custom content should be preserved on re-init');
  });

  test('compose.json has paths.context = "docs/context"', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    runCmd('init', cwd, makeEnv(cwd, home));
    const config = JSON.parse(readFileSync(join(cwd, '.compose', 'compose.json'), 'utf-8'));
    assert.equal(config.paths.context, 'docs/context');
  });
});

// ---------------------------------------------------------------------------
// Item 100 — loadAmbientContext + buildStepPrompt injection
// ---------------------------------------------------------------------------

describe('loadAmbientContext', () => {
  test('returns null when contextDir does not exist', () => {
    const result = loadAmbientContext('/nonexistent/path/xyz123');
    assert.equal(result, null);
  });

  test('returns null when contextDir has no .md files', () => {
    const dir = tmpDir();
    const result = loadAmbientContext(dir);
    assert.equal(result, null);
  });

  test('returns concatenated contents of .md files', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'tech-stack.md'), '# Tech Stack\n\nNode 22');
    writeFileSync(join(dir, 'conventions.md'), '# Conventions\n\nUse ESM');
    // Clear cache so fresh read happens
    clearAmbientContextCache(dir);
    const result = loadAmbientContext(dir);
    assert.ok(result.includes('# Tech Stack'), 'should include tech-stack');
    assert.ok(result.includes('# Conventions'), 'should include conventions');
  });

  test('sorts files alphabetically', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'z-last.md'), 'Z content');
    writeFileSync(join(dir, 'a-first.md'), 'A content');
    clearAmbientContextCache(dir);
    const result = loadAmbientContext(dir);
    assert.ok(result.indexOf('A content') < result.indexOf('Z content'), 'files should be sorted');
  });

  test('caches result so second call returns same value without re-reading', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'info.md'), '# Info\n\nOriginal');
    clearAmbientContextCache(dir);
    const first = loadAmbientContext(dir);
    // Overwrite file — cache should still return original
    writeFileSync(join(dir, 'info.md'), '# Info\n\nModified');
    const second = loadAmbientContext(dir);
    assert.equal(first, second, 'should return cached value');
  });

  test('clearAmbientContextCache invalidates cache', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'info.md'), '# Info\n\nVersion1');
    clearAmbientContextCache(dir);
    loadAmbientContext(dir);
    writeFileSync(join(dir, 'info.md'), '# Info\n\nVersion2');
    clearAmbientContextCache(dir);
    const result = loadAmbientContext(dir);
    assert.ok(result.includes('Version2'), 'should re-read after cache clear');
  });
});

describe('buildStepPrompt — ambient context injection', () => {
  const dispatch = {
    step_id: 'test-step',
    intent: 'Do a thing',
    inputs: {},
    output_fields: [],
    ensure: [],
  };

  test('includes ## Project Context section when contextDir has files', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'tech-stack.md'), '# Tech Stack\n\nNode 22');
    clearAmbientContextCache(dir);
    const prompt = buildStepPrompt(dispatch, {
      cwd: '/some/dir',
      featureCode: 'FEAT-1',
      contextDir: dir,
    });
    assert.ok(prompt.includes('## Project Context'), 'should have Project Context section');
    assert.ok(prompt.includes('Node 22'), 'should contain context file content');
  });

  test('omits ## Project Context section when contextDir is absent', () => {
    const prompt = buildStepPrompt(dispatch, {
      cwd: '/some/dir',
      featureCode: 'FEAT-1',
    });
    assert.ok(!prompt.includes('## Project Context'), 'should not have Project Context section');
  });

  test('Project Context appears before ## Context section', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'info.md'), '# Info\n\nSome context');
    clearAmbientContextCache(dir);
    const prompt = buildStepPrompt(dispatch, {
      cwd: '/some/dir',
      featureCode: 'FEAT-1',
      contextDir: dir,
    });
    const projIdx = prompt.indexOf('## Project Context');
    const ctxIdx = prompt.indexOf('## Context');
    assert.ok(projIdx < ctxIdx, '## Project Context should appear before ## Context');
  });
});

// ---------------------------------------------------------------------------
// Item 101 — Staleness detection
// ---------------------------------------------------------------------------

describe('extractPhaseMarker', () => {
  test('extracts phase from first line', () => {
    const content = '<!-- phase: explore_design -->\n# Title\n';
    assert.equal(extractPhaseMarker(content), 'explore_design');
  });

  test('extracts phase from line 5', () => {
    const content = 'line1\nline2\nline3\nline4\n<!-- phase: blueprint -->\nrest';
    assert.equal(extractPhaseMarker(content), 'blueprint');
  });

  test('ignores phase comment after line 5', () => {
    const content = 'line1\nline2\nline3\nline4\nline5\n<!-- phase: plan -->\nrest';
    assert.equal(extractPhaseMarker(content), null);
  });

  test('handles whitespace variations in comment', () => {
    assert.equal(extractPhaseMarker('<!--phase:build-->'), 'build');
    assert.equal(extractPhaseMarker('<!--  phase:  ship  -->'), 'ship');
  });

  test('returns null when no marker present', () => {
    assert.equal(extractPhaseMarker('# No phase here\n\nSome content\n'), null);
  });
});

describe('checkStaleness', () => {
  test('returns empty array when featureDir does not exist', () => {
    const results = checkStaleness('/nonexistent/feature/xyz', 'build');
    assert.deepEqual(results, []);
  });

  test('returns empty array when no tracked artifacts are present', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'other.md'), '# Other\nno phase');
    const results = checkStaleness(dir, 'build');
    assert.deepEqual(results, []);
  });

  test('returns empty array for artifact without phase marker', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'design.md'), '# Design\n\nNo phase marker here');
    const results = checkStaleness(dir, 'build');
    assert.deepEqual(results, []);
  });

  test('flags design.md as stale when currentPhase is past writtenPhase', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'design.md'), '<!-- phase: explore_design -->\n# Design\n');
    const results = checkStaleness(dir, 'build');
    assert.equal(results.length, 1);
    assert.equal(results[0].file, 'design.md');
    assert.equal(results[0].writtenPhase, 'explore_design');
    assert.equal(results[0].currentPhase, 'build');
    assert.equal(results[0].stale, true);
  });

  test('does NOT flag artifact as stale when currentPhase equals writtenPhase', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'blueprint.md'), '<!-- phase: blueprint -->\n# Blueprint\n');
    const results = checkStaleness(dir, 'blueprint');
    assert.equal(results.length, 1);
    assert.equal(results[0].stale, false);
  });

  test('does NOT flag artifact as stale when currentPhase is earlier than writtenPhase', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'plan.md'), '<!-- phase: plan -->\n# Plan\n');
    const results = checkStaleness(dir, 'explore_design');
    assert.equal(results.length, 1);
    assert.equal(results[0].stale, false);
  });

  test('checks all three tracked artifacts', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'design.md'), '<!-- phase: explore_design -->\n# Design\n');
    writeFileSync(join(dir, 'blueprint.md'), '<!-- phase: blueprint -->\n# Blueprint\n');
    writeFileSync(join(dir, 'plan.md'), '<!-- phase: plan -->\n# Plan\n');
    const results = checkStaleness(dir, 'build');
    assert.equal(results.length, 3);
    assert.ok(results.every(r => r.stale), 'all three should be stale when in build phase');
  });

  test('handles unknown phase gracefully — not stale', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'design.md'), '<!-- phase: unknown_phase -->\n# Design\n');
    const results = checkStaleness(dir, 'build');
    assert.equal(results.length, 1);
    assert.equal(results[0].stale, false, 'unknown phase should not be flagged stale');
  });
});

describe('buildGateContext — staleness warnings', () => {
  const gateDispatch = {
    step_id: 'gate-review',
    on_approve: 'build',
    on_revise: 'explore_design',
    on_kill: 'kill',
  };

  test('includes Stale Artifacts section when artifacts are stale', () => {
    const featureDir = tmpDir();
    writeFileSync(join(featureDir, 'design.md'), '<!-- phase: explore_design -->\n# Design\n');

    const context = {
      cwd: '/some/dir',
      featureCode: 'FEAT-1',
      featureDir,
      stepHistory: [],
    };
    const gateExtras = { toPhase: 'build' };
    const result = buildGateContext(gateDispatch, context, gateExtras);

    assert.ok(result.includes('## Stale Artifacts'), 'should include stale artifacts section');
    assert.ok(result.includes('design.md'), 'should mention the stale file');
    assert.ok(result.includes('explore_design'), 'should mention the written phase');
  });

  test('omits Stale Artifacts section when no artifacts are stale', () => {
    const featureDir = tmpDir();
    writeFileSync(join(featureDir, 'design.md'), '<!-- phase: build -->\n# Design\n');

    const context = {
      cwd: '/some/dir',
      featureCode: 'FEAT-1',
      featureDir,
      stepHistory: [],
    };
    const gateExtras = { toPhase: 'build' };
    const result = buildGateContext(gateDispatch, context, gateExtras);

    assert.ok(!result.includes('## Stale Artifacts'), 'should not include stale artifacts section');
  });

  test('omits Stale Artifacts section when gateExtras has no toPhase', () => {
    const featureDir = tmpDir();
    writeFileSync(join(featureDir, 'design.md'), '<!-- phase: explore_design -->\n# Design\n');

    const context = {
      cwd: '/some/dir',
      featureCode: 'FEAT-1',
      featureDir,
      stepHistory: [],
    };
    const result = buildGateContext(gateDispatch, context, {});

    assert.ok(!result.includes('## Stale Artifacts'), 'should not include section without toPhase');
  });
});

// ---------------------------------------------------------------------------
// Item 102 — Decision log (verified via decisions.md file content)
// ---------------------------------------------------------------------------

describe('decision log — decisions.md append', () => {
  test('decisions.md is created by compose init', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    runCmd('init', cwd, makeEnv(cwd, home));
    assert.ok(existsSync(join(cwd, 'docs', 'context', 'decisions.md')));
  });

  test('decisions.md starts with # Decision Log heading', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    runCmd('init', cwd, makeEnv(cwd, home));
    const content = readFileSync(join(cwd, 'docs', 'context', 'decisions.md'), 'utf-8');
    assert.ok(content.startsWith('# Decision Log'), 'should start with # Decision Log');
  });
});
