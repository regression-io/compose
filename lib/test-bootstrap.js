/**
 * test-bootstrap.js — Framework detection and test scaffold generation.
 *
 * Item 125: detectTestFramework(cwd) — inspect config files, package.json devDeps,
 *           and pyproject.toml to identify the active test framework.
 *
 * Item 126: scaffoldTestFramework(cwd, language) — create minimal test scaffolding
 *           when no framework is detected.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _readJSON(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function _readText(filePath) {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Item 125: detectTestFramework
// ---------------------------------------------------------------------------

/**
 * Detect which test framework is configured in the given directory.
 *
 * Checks (in order):
 *   1. Well-known config file names on disk
 *   2. package.json devDependencies / dependencies
 *   3. pyproject.toml [tool.pytest]
 *
 * @param {string} cwd - Directory to inspect
 * @returns {{ framework: string, runner: string, configFile: string|null, command: string }|null}
 */
export function detectTestFramework(cwd) {
  // --- Config-file checks ---

  const configChecks = [
    // Vitest
    {
      files: ['vitest.config.js', 'vitest.config.ts', 'vitest.config.mjs', 'vitest.config.cjs'],
      framework: 'vitest',
      runner: 'vitest',
      command: 'npx vitest run',
    },
    // Jest
    {
      files: [
        'jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.cjs',
        'jest.config.json',
      ],
      framework: 'jest',
      runner: 'jest',
      command: 'npx jest',
    },
    // Mocha
    {
      files: ['.mocharc.js', '.mocharc.cjs', '.mocharc.yaml', '.mocharc.yml', '.mocharc.json'],
      framework: 'mocha',
      runner: 'mocha',
      command: 'npx mocha',
    },
    // pytest — config file forms
    {
      files: ['pytest.ini', 'conftest.py'],
      framework: 'pytest',
      runner: 'pytest',
      command: 'pytest',
    },
    // setup.cfg with [tool:pytest]
    {
      files: ['setup.cfg'],
      framework: 'pytest',
      runner: 'pytest',
      command: 'pytest',
      // validated below — only if [tool:pytest] section present
      contentCheck: (content) => content.includes('[tool:pytest]'),
    },
  ];

  for (const check of configChecks) {
    for (const filename of check.files) {
      const fullPath = join(cwd, filename);
      if (!existsSync(fullPath)) continue;

      if (check.contentCheck) {
        const content = _readText(fullPath);
        if (!content || !check.contentCheck(content)) continue;
      }

      return {
        framework: check.framework,
        runner: check.runner,
        configFile: filename,
        command: check.command,
      };
    }
  }

  // --- Go: *_test.go files ---
  {
    const goMod = join(cwd, 'go.mod');
    if (existsSync(goMod)) {
      return {
        framework: 'go-test',
        runner: 'go',
        configFile: 'go.mod',
        command: 'go test ./...',
      };
    }
  }

  // --- Rust: Cargo.toml ---
  {
    const cargoToml = join(cwd, 'Cargo.toml');
    if (existsSync(cargoToml)) {
      const content = _readText(cargoToml);
      if (content) {
        return {
          framework: 'cargo-test',
          runner: 'cargo',
          configFile: 'Cargo.toml',
          command: 'cargo test',
        };
      }
    }
  }

  // --- pyproject.toml with [tool.pytest] ---
  {
    const pyproject = join(cwd, 'pyproject.toml');
    const content = _readText(pyproject);
    if (content && content.includes('[tool.pytest')) {
      return {
        framework: 'pytest',
        runner: 'pytest',
        configFile: 'pyproject.toml',
        command: 'pytest',
      };
    }
  }

  // --- package.json devDependencies / dependencies ---
  {
    const pkgPath = join(cwd, 'package.json');
    const pkg = _readJSON(pkgPath);
    if (pkg) {
      const allDeps = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      };

      // Ordered: prefer vitest > jest > mocha > ava > tap
      if (allDeps['vitest']) {
        return {
          framework: 'vitest',
          runner: 'vitest',
          configFile: 'package.json',
          command: 'npx vitest run',
        };
      }
      if (allDeps['jest'] || allDeps['ts-jest'] || allDeps['babel-jest']) {
        return {
          framework: 'jest',
          runner: 'jest',
          configFile: 'package.json',
          command: 'npx jest',
        };
      }
      if (allDeps['mocha']) {
        return {
          framework: 'mocha',
          runner: 'mocha',
          configFile: 'package.json',
          command: 'npx mocha',
        };
      }
      if (allDeps['ava']) {
        return {
          framework: 'ava',
          runner: 'ava',
          configFile: 'package.json',
          command: 'npx ava',
        };
      }
      if (allDeps['tap']) {
        return {
          framework: 'tap',
          runner: 'tap',
          configFile: 'package.json',
          command: 'npx tap',
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Item 126: scaffoldTestFramework
// ---------------------------------------------------------------------------

/**
 * Create a minimal test scaffold if no framework is detected.
 * Only runs when detectTestFramework(cwd) returns null.
 *
 * @param {string} cwd      - Project root directory
 * @param {string} language - 'node' | 'python' | 'go' | 'rust'
 * @returns {{ framework: string, configFile: string, testDir: string, command: string }}
 */
export function scaffoldTestFramework(cwd, language) {
  const existing = detectTestFramework(cwd);
  if (existing) return existing;

  switch (language) {
    case 'python': {
      const testDir = join(cwd, 'tests');
      mkdirSync(testDir, { recursive: true });

      const conftest = join(cwd, 'conftest.py');
      if (!existsSync(conftest)) {
        writeFileSync(conftest, [
          '# conftest.py — pytest configuration and shared fixtures',
          'import pytest',
          '',
          '# Add project root to sys.path so tests can import the package.',
          'import sys, os',
          'sys.path.insert(0, os.path.dirname(__file__))',
          '',
        ].join('\n'), 'utf-8');
      }

      const initTest = join(testDir, 'test_golden.py');
      if (!existsSync(initTest)) {
        writeFileSync(initTest, [
          '"""Golden flow placeholder — replace with real lifecycle tests."""',
          '',
          'def test_placeholder():',
          '    """Minimal placeholder that passes until real tests are written."""',
          '    assert True',
          '',
        ].join('\n'), 'utf-8');
      }

      return {
        framework: 'pytest',
        configFile: 'conftest.py',
        testDir: 'tests',
        command: 'pytest',
      };
    }

    case 'go': {
      // Find first .go file to derive the package name, defaulting to 'main'
      let packageName = 'main';
      try {
        const goFiles = readdirSync(cwd).filter(
          f => f.endsWith('.go') && !f.endsWith('_test.go')
        );
        if (goFiles.length > 0) {
          const src = _readText(join(cwd, goFiles[0]));
          const m = src?.match(/^package\s+(\w+)/m);
          if (m) packageName = m[1];
        }
      } catch { /* use default */ }

      const testFile = join(cwd, 'golden_test.go');
      if (!existsSync(testFile)) {
        writeFileSync(testFile, [
          `package ${packageName}`,
          '',
          'import "testing"',
          '',
          '// TestGoldenFlow is a placeholder — replace with real lifecycle tests.',
          'func TestGoldenFlow(t *testing.T) {',
          '  // TODO: implement golden flow test',
          '}',
          '',
        ].join('\n'), 'utf-8');
      }

      return {
        framework: 'go-test',
        configFile: 'golden_test.go',
        testDir: '.',
        command: 'go test ./...',
      };
    }

    case 'rust': {
      const testDir = join(cwd, 'tests');
      mkdirSync(testDir, { recursive: true });

      const testFile = join(testDir, 'golden.rs');
      if (!existsSync(testFile)) {
        writeFileSync(testFile, [
          '//! Golden flow placeholder — replace with real lifecycle tests.',
          '',
          '#[test]',
          'fn placeholder() {',
          '    // TODO: implement golden flow test',
          '}',
          '',
        ].join('\n'), 'utf-8');
      }

      return {
        framework: 'cargo-test',
        configFile: 'tests/golden.rs',
        testDir: 'tests',
        command: 'cargo test',
      };
    }

    case 'node':
    default: {
      const testDir = join(cwd, 'test');
      mkdirSync(testDir, { recursive: true });

      // Prefer vitest if package.json exists; otherwise scaffold bare vitest config
      const pkgPath = join(cwd, 'package.json');
      const pkg = _readJSON(pkgPath);
      const useVitest = !pkg?.devDependencies?.jest && !pkg?.dependencies?.jest;

      if (useVitest) {
        const configPath = join(cwd, 'vitest.config.js');
        if (!existsSync(configPath)) {
          writeFileSync(configPath, [
            '// vitest.config.js — generated by Compose test-bootstrap',
            "import { defineConfig } from 'vitest/config';",
            '',
            'export default defineConfig({',
            '  test: {',
            "    include: ['test/**/*.test.{js,ts}'],",
            '  },',
            '});',
            '',
          ].join('\n'), 'utf-8');
        }

        const setupPath = join(testDir, 'setup.js');
        if (!existsSync(setupPath)) {
          writeFileSync(setupPath, [
            '// test/setup.js — shared test helpers',
            "// Import this in tests via: import './setup.js'",
            '',
            '// Example: assert helpers, fixtures, shared state',
            '',
          ].join('\n'), 'utf-8');
        }

        return {
          framework: 'vitest',
          configFile: 'vitest.config.js',
          testDir: 'test',
          command: 'npx vitest run',
        };
      }

      // Jest fallback
      const configPath = join(cwd, 'jest.config.js');
      if (!existsSync(configPath)) {
        writeFileSync(configPath, [
          '// jest.config.js — generated by Compose test-bootstrap',
          "export default { testMatch: ['**/test/**/*.test.js'] };",
          '',
        ].join('\n'), 'utf-8');
      }

      const setupPath = join(testDir, 'setup.js');
      if (!existsSync(setupPath)) {
        writeFileSync(setupPath, [
          '// test/setup.js — shared test helpers',
          '',
        ].join('\n'), 'utf-8');
      }

      return {
        framework: 'jest',
        configFile: 'jest.config.js',
        testDir: 'test',
        command: 'npx jest',
      };
    }
  }
}
