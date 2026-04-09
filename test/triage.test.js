/**
 * triage.test.js — Tests for the pre-build triage engine.
 *
 * Run with: node --test test/triage.test.js
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runTriage, isTriageStale } from '../lib/triage.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject() {
  const root = mkdtempSync(join(tmpdir(), 'triage-test-'));
  return root;
}

function writeFeatureFile(root, code, filename, content) {
  const dir = join(root, 'docs', 'features', code);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content);
}

function writeFeatureJson(root, code, data) {
  const dir = join(root, 'docs', 'features', code);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'feature.json'), JSON.stringify(data, null, 2));
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tier detection tests
// ---------------------------------------------------------------------------

describe('runTriage — tier classification', () => {
  test('config-only feature folder (no plan.md, no blueprint.md) → tier 0, all needs_* false', async () => {
    const root = makeTmpProject();
    try {
      // Create empty feature folder with only a stub file
      const dir = join(root, 'docs', 'features', 'CFG-1');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'notes.md'), '# Notes\nJust some notes.');

      const result = await runTriage('CFG-1', { cwd: root });
      assert.equal(result.tier, 0);
      assert.equal(result.profile.needs_prd, false);
      assert.equal(result.profile.needs_architecture, false);
      assert.equal(result.profile.needs_verification, false);
      assert.equal(result.profile.needs_report, false);
    } finally {
      cleanup(root);
    }
  });

  test('single-file plan with no security paths → tier 1, needs_verification true, rest false', async () => {
    const root = makeTmpProject();
    try {
      const planContent = `
# Plan

- [ ] Update \`src/utils/format.js\` to handle edge case
- [ ] Add unit tests in \`test/format.test.js\`
`.trim();
      writeFeatureFile(root, 'SIMPLE-1', 'plan.md', planContent);

      const result = await runTriage('SIMPLE-1', { cwd: root });
      assert.equal(result.tier, 1, `Expected tier 1, got ${result.tier}: ${result.rationale}`);
      assert.equal(result.profile.needs_prd, false);
      assert.equal(result.profile.needs_architecture, false);
      assert.equal(result.profile.needs_verification, true);
      assert.equal(result.profile.needs_report, false);
    } finally {
      cleanup(root);
    }
  });

  test('multi-file plan, standard complexity → tier 2, needs_verification true, rest false', async () => {
    const root = makeTmpProject();
    try {
      const planContent = `
# Plan

- [ ] Create \`src/components/Button.jsx\`
- [ ] Update \`src/components/Header.jsx\`
- [ ] Add styles in \`src/styles/button.css\`
- [ ] Write tests in \`test/button.test.js\`
- [ ] Update \`src/App.jsx\` to import new component
- [ ] Add \`src/hooks/useButton.js\` custom hook
- [ ] Document in \`docs/components/button.md\`
- [ ] Update \`src/index.js\` exports
- [ ] Add e2e test in \`test/e2e/button.e2e.js\`
- [ ] Review \`src/theme.js\` tokens
- [ ] Update \`CHANGELOG.md\`
`.trim();
      writeFeatureFile(root, 'MULTI-1', 'plan.md', planContent);

      const result = await runTriage('MULTI-1', { cwd: root });
      assert.equal(result.tier, 2, `Expected tier 2, got ${result.tier}: ${result.rationale}`);
      assert.equal(result.profile.needs_prd, false);
      assert.equal(result.profile.needs_architecture, false);
      assert.equal(result.profile.needs_verification, true);
      assert.equal(result.profile.needs_report, false);
    } finally {
      cleanup(root);
    }
  });

  test('plan references auth/crypto paths → tier 3+, needs_architecture true', async () => {
    const root = makeTmpProject();
    try {
      const planContent = `
# Plan

- [ ] Update \`src/auth/session.js\` to rotate tokens
- [ ] Modify \`src/middleware/auth.js\` for new flow
- [ ] Add \`src/crypto/hash.js\` for password hashing
`.trim();
      writeFeatureFile(root, 'AUTH-1', 'plan.md', planContent);

      const result = await runTriage('AUTH-1', { cwd: root });
      assert.ok(result.tier >= 3, `Expected tier >= 3, got ${result.tier}: ${result.rationale}`);
      assert.equal(result.profile.needs_architecture, true);
    } finally {
      cleanup(root);
    }
  });

  test('plan references core/shared code → tier 4, needs_prd and needs_architecture true', async () => {
    const root = makeTmpProject();
    try {
      const planContent = `
# Plan

- [ ] Refactor \`lib/connector-base.js\` for new interface
- [ ] Update \`server/index.js\` to use new connector
- [ ] Migrate \`shared/types.js\` to TypeScript
`.trim();
      writeFeatureFile(root, 'CORE-1', 'plan.md', planContent);

      const result = await runTriage('CORE-1', { cwd: root });
      assert.equal(result.tier, 4, `Expected tier 4, got ${result.tier}: ${result.rationale}`);
      assert.equal(result.profile.needs_prd, true);
      assert.equal(result.profile.needs_architecture, true);
    } finally {
      cleanup(root);
    }
  });
});

// ---------------------------------------------------------------------------
// Cache invalidation tests
// ---------------------------------------------------------------------------

describe('isTriageStale', () => {
  test('returns true when triageTimestamp is missing', () => {
    const root = makeTmpProject();
    try {
      writeFeatureJson(root, 'FEAT-1', { code: 'FEAT-1', description: 'test', status: 'PLANNED' });
      assert.equal(isTriageStale(root, 'FEAT-1'), true);
    } finally {
      cleanup(root);
    }
  });

  test('returns true when feature.json does not exist', () => {
    const root = makeTmpProject();
    try {
      const dir = join(root, 'docs', 'features', 'FEAT-X');
      mkdirSync(dir, { recursive: true });
      assert.equal(isTriageStale(root, 'FEAT-X'), true);
    } finally {
      cleanup(root);
    }
  });

  test('returns true when plan.md mtime > triageTimestamp', () => {
    const root = makeTmpProject();
    try {
      // Write feature.json with old triageTimestamp
      const oldTimestamp = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
      writeFeatureJson(root, 'FEAT-2', { code: 'FEAT-2', description: 'test', status: 'PLANNED', triageTimestamp: oldTimestamp });
      // Write plan.md with current mtime (newer than timestamp)
      writeFeatureFile(root, 'FEAT-2', 'plan.md', '# Plan\n- [ ] Do something');

      assert.equal(isTriageStale(root, 'FEAT-2'), true);
    } finally {
      cleanup(root);
    }
  });

  test('returns false when triageTimestamp is newer than all files', () => {
    const root = makeTmpProject();
    try {
      // Write plan.md first
      writeFeatureFile(root, 'FEAT-3', 'plan.md', '# Plan\n- [ ] Do something');

      // Now set triageTimestamp to future
      const futureTimestamp = new Date(Date.now() + 60_000).toISOString(); // 1 min from now
      writeFeatureJson(root, 'FEAT-3', { code: 'FEAT-3', description: 'test', status: 'PLANNED', triageTimestamp: futureTimestamp });

      // Set plan.md mtime to past so it's definitely older than the timestamp
      const pastDate = new Date(Date.now() - 120_000);
      const planPath = join(root, 'docs', 'features', 'FEAT-3', 'plan.md');
      utimesSync(planPath, pastDate, pastDate);

      assert.equal(isTriageStale(root, 'FEAT-3'), false);
    } finally {
      cleanup(root);
    }
  });
});

// ---------------------------------------------------------------------------
// feature.json creation / update tests
// ---------------------------------------------------------------------------

describe('runTriage — feature.json persistence (via build.js logic)', () => {
  test('triage returns signals and rationale', async () => {
    const root = makeTmpProject();
    try {
      writeFeatureFile(root, 'SIG-1', 'plan.md', '# Plan\n- [ ] Update `src/utils.js`\n- [ ] Write tests\n');

      const result = await runTriage('SIG-1', { cwd: root });
      assert.ok(typeof result.rationale === 'string' && result.rationale.length > 0);
      assert.ok(typeof result.signals.fileCount === 'number');
      assert.ok(typeof result.signals.taskCount === 'number');
      assert.ok(typeof result.signals.securityPaths === 'boolean');
      assert.ok(typeof result.signals.corePaths === 'boolean');
    } finally {
      cleanup(root);
    }
  });

  test('triage profile has all required boolean fields', async () => {
    const root = makeTmpProject();
    try {
      writeFeatureFile(root, 'PROF-1', 'plan.md', '# Plan\n- [ ] Do a thing\n');

      const result = await runTriage('PROF-1', { cwd: root });
      assert.ok('needs_prd' in result.profile);
      assert.ok('needs_architecture' in result.profile);
      assert.ok('needs_verification' in result.profile);
      assert.ok('needs_report' in result.profile);
      assert.equal(typeof result.profile.needs_prd, 'boolean');
      assert.equal(typeof result.profile.needs_architecture, 'boolean');
      assert.equal(typeof result.profile.needs_verification, 'boolean');
      assert.equal(typeof result.profile.needs_report, 'boolean');
    } finally {
      cleanup(root);
    }
  });
});

// ---------------------------------------------------------------------------
// Build integration: spec YAML mutation (unit-level test of the logic)
// ---------------------------------------------------------------------------

describe('build.js spec YAML mutation — skip_if toggling', () => {
  test('needs_prd true → skip_if removed from prd step', async () => {
    // Simulate the logic in build.js that mutates the YAML spec
    const YAML = (await import('yaml')).default;

    const specYaml = `
flows:
  build:
    steps:
      - id: prd
        agent: claude
        skip_if: "true"
        skip_reason: "Old reason"
      - id: blueprint
        agent: claude
`.trim();

    const profile = { needs_prd: true, needs_architecture: false, needs_verification: true, needs_report: false };
    const specObj = YAML.parse(specYaml);
    const steps = specObj.flows.build.steps;
    const skippableSteps = ['prd', 'architecture', 'verification', 'report'];
    for (const step of steps) {
      if (!skippableSteps.includes(step.id)) continue;
      const needsKey = `needs_${step.id}`;
      if (profile[needsKey] === true) {
        delete step.skip_if;
        delete step.skip_reason;
      } else if (profile[needsKey] === false) {
        step.skip_if = 'true';
        step.skip_reason = 'Skipped by triage (tier 2)';
      }
    }

    const prdStep = steps.find(s => s.id === 'prd');
    assert.ok(!('skip_if' in prdStep), 'prd step should not have skip_if when needs_prd is true');
    assert.ok(!('skip_reason' in prdStep), 'prd step should not have skip_reason when needs_prd is true');
  });

  test('needs_architecture false → skip_if set on architecture step', async () => {
    const YAML = (await import('yaml')).default;

    const specYaml = `
flows:
  build:
    steps:
      - id: architecture
        agent: claude
      - id: blueprint
        agent: claude
`.trim();

    const profile = { needs_prd: false, needs_architecture: false, needs_verification: true, needs_report: false };
    const specObj = YAML.parse(specYaml);
    const steps = specObj.flows.build.steps;
    const skippableSteps = ['prd', 'architecture', 'verification', 'report'];
    for (const step of steps) {
      if (!skippableSteps.includes(step.id)) continue;
      const needsKey = `needs_${step.id}`;
      if (profile[needsKey] === true) {
        delete step.skip_if;
        delete step.skip_reason;
      } else if (profile[needsKey] === false) {
        step.skip_if = 'true';
        step.skip_reason = 'Skipped by triage (tier 2)';
      }
    }

    const archStep = steps.find(s => s.id === 'architecture');
    assert.equal(archStep.skip_if, 'true');
    assert.ok(archStep.skip_reason.includes('triage'));
  });
});
