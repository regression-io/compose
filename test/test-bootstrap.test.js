/**
 * Tests for lib/test-bootstrap.js (COMP-TEST-BOOTSTRAP)
 * Run with: node --test test/test-bootstrap.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { detectTestFramework, scaffoldTestFramework } from '../lib/test-bootstrap.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary directory for each test scenario.
 * Returns the path; caller is responsible for cleanup.
 */
function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'compose-test-bootstrap-'));
}

// ---------------------------------------------------------------------------
// Item 125: detectTestFramework
// ---------------------------------------------------------------------------

describe('detectTestFramework', () => {

  it('returns null for an empty directory', () => {
    const dir = makeTmpDir();
    try {
      assert.equal(detectTestFramework(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects vitest from vitest.config.js', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'vitest.config.js'), '// vitest', 'utf-8');
      const result = detectTestFramework(dir);
      assert.ok(result, 'should detect a framework');
      assert.equal(result.framework, 'vitest');
      assert.equal(result.runner, 'vitest');
      assert.equal(result.command, 'npx vitest run');
      assert.equal(result.configFile, 'vitest.config.js');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects vitest from vitest.config.ts', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'vitest.config.ts'), '// vitest', 'utf-8');
      const result = detectTestFramework(dir);
      assert.ok(result);
      assert.equal(result.framework, 'vitest');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects jest from jest.config.js', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'jest.config.js'), '// jest', 'utf-8');
      const result = detectTestFramework(dir);
      assert.ok(result);
      assert.equal(result.framework, 'jest');
      assert.equal(result.command, 'npx jest');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects mocha from .mocharc.json', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, '.mocharc.json'), '{}', 'utf-8');
      const result = detectTestFramework(dir);
      assert.ok(result);
      assert.equal(result.framework, 'mocha');
      assert.equal(result.command, 'npx mocha');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects pytest from pytest.ini', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'pytest.ini'), '[pytest]\n', 'utf-8');
      const result = detectTestFramework(dir);
      assert.ok(result);
      assert.equal(result.framework, 'pytest');
      assert.equal(result.command, 'pytest');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects pytest from conftest.py', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'conftest.py'), '# conftest\n', 'utf-8');
      const result = detectTestFramework(dir);
      assert.ok(result);
      assert.equal(result.framework, 'pytest');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects pytest from setup.cfg with [tool:pytest]', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'setup.cfg'), '[tool:pytest]\naddopts = -v\n', 'utf-8');
      const result = detectTestFramework(dir);
      assert.ok(result);
      assert.equal(result.framework, 'pytest');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT detect pytest from setup.cfg without [tool:pytest]', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'setup.cfg'), '[metadata]\nname = myapp\n', 'utf-8');
      const result = detectTestFramework(dir);
      assert.equal(result, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects pytest from pyproject.toml [tool.pytest]', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'pyproject.toml'), '[tool.pytest.ini_options]\n', 'utf-8');
      const result = detectTestFramework(dir);
      assert.ok(result);
      assert.equal(result.framework, 'pytest');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects go-test from go.mod', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'go.mod'), 'module example.com/myapp\ngo 1.21\n', 'utf-8');
      const result = detectTestFramework(dir);
      assert.ok(result);
      assert.equal(result.framework, 'go-test');
      assert.equal(result.command, 'go test ./...');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects cargo-test from Cargo.toml', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "myapp"\n', 'utf-8');
      const result = detectTestFramework(dir);
      assert.ok(result);
      assert.equal(result.framework, 'cargo-test');
      assert.equal(result.command, 'cargo test');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects vitest from package.json devDependencies', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        devDependencies: { vitest: '^1.0.0' },
      }), 'utf-8');
      const result = detectTestFramework(dir);
      assert.ok(result);
      assert.equal(result.framework, 'vitest');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects jest from package.json devDependencies', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        devDependencies: { jest: '^29.0.0' },
      }), 'utf-8');
      const result = detectTestFramework(dir);
      assert.ok(result);
      assert.equal(result.framework, 'jest');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects mocha from package.json devDependencies', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        devDependencies: { mocha: '^10.0.0' },
      }), 'utf-8');
      const result = detectTestFramework(dir);
      assert.ok(result);
      assert.equal(result.framework, 'mocha');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects ava from package.json devDependencies', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        devDependencies: { ava: '^6.0.0' },
      }), 'utf-8');
      const result = detectTestFramework(dir);
      assert.ok(result);
      assert.equal(result.framework, 'ava');
      assert.equal(result.command, 'npx ava');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects tap from package.json devDependencies', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        devDependencies: { tap: '^18.0.0' },
      }), 'utf-8');
      const result = detectTestFramework(dir);
      assert.ok(result);
      assert.equal(result.framework, 'tap');
      assert.equal(result.command, 'npx tap');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('config file takes precedence over package.json deps', () => {
    const dir = makeTmpDir();
    try {
      // Both jest config file and vitest in devDeps — config file wins
      writeFileSync(join(dir, 'jest.config.js'), '// jest', 'utf-8');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        devDependencies: { vitest: '^1.0.0' },
      }), 'utf-8');
      const result = detectTestFramework(dir);
      assert.ok(result);
      assert.equal(result.framework, 'jest');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Item 126: scaffoldTestFramework
// ---------------------------------------------------------------------------

describe('scaffoldTestFramework', () => {

  it('returns existing detection if framework already present', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'vitest.config.js'), '// vitest', 'utf-8');
      const result = scaffoldTestFramework(dir, 'node');
      assert.equal(result.framework, 'vitest');
      // Should not create test/setup.js since it detected, not scaffolded
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scaffolds vitest for node when no framework detected', () => {
    const dir = makeTmpDir();
    try {
      const result = scaffoldTestFramework(dir, 'node');
      assert.equal(result.framework, 'vitest');
      assert.equal(result.configFile, 'vitest.config.js');
      assert.equal(result.testDir, 'test');
      assert.equal(result.command, 'npx vitest run');

      assert.ok(existsSync(join(dir, 'vitest.config.js')), 'vitest.config.js created');
      assert.ok(existsSync(join(dir, 'test', 'setup.js')), 'test/setup.js created');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns detected jest when package.json already has jest dependency', () => {
    // When jest is in package.json deps, detectTestFramework finds it first —
    // scaffoldTestFramework short-circuits and returns the detected result.
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        dependencies: { jest: '^29.0.0' },
      }), 'utf-8');
      const result = scaffoldTestFramework(dir, 'node');
      assert.equal(result.framework, 'jest');
      // configFile comes from detection (package.json), not a scaffolded jest.config.js
      assert.equal(result.configFile, 'package.json');
      assert.equal(result.command, 'npx jest');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scaffolds pytest for python', () => {
    const dir = makeTmpDir();
    try {
      const result = scaffoldTestFramework(dir, 'python');
      assert.equal(result.framework, 'pytest');
      assert.equal(result.configFile, 'conftest.py');
      assert.equal(result.testDir, 'tests');
      assert.equal(result.command, 'pytest');

      assert.ok(existsSync(join(dir, 'conftest.py')), 'conftest.py created');
      assert.ok(existsSync(join(dir, 'tests', 'test_golden.py')), 'tests/test_golden.py created');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scaffolds go test stub', () => {
    const dir = makeTmpDir();
    try {
      const result = scaffoldTestFramework(dir, 'go');
      assert.equal(result.framework, 'go-test');
      assert.equal(result.command, 'go test ./...');

      assert.ok(existsSync(join(dir, 'golden_test.go')), 'golden_test.go created');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scaffolds rust test dir', () => {
    const dir = makeTmpDir();
    try {
      const result = scaffoldTestFramework(dir, 'rust');
      assert.equal(result.framework, 'cargo-test');
      assert.equal(result.command, 'cargo test');

      assert.ok(existsSync(join(dir, 'tests', 'golden.rs')), 'tests/golden.rs created');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent — does not overwrite existing scaffold files', () => {
    const dir = makeTmpDir();
    try {
      // First scaffold creates conftest.py
      scaffoldTestFramework(dir, 'python');
      // Overwrite conftest.py with a marker
      writeFileSync(join(dir, 'conftest.py'), '# MARKER\n', 'utf-8');
      // Second scaffold should detect conftest.py exists and skip re-creation
      scaffoldTestFramework(dir, 'python');
      const content = readFileSync(join(dir, 'conftest.py'), 'utf-8');
      assert.ok(content.includes('# MARKER'), 'existing conftest.py not overwritten');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
