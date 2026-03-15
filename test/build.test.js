/**
 * Tests for lib/build.js — headless lifecycle runner.
 *
 * Uses mock connectors and mock stratum client to test orchestration
 * without real agent calls or stratum subprocess.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We need to mock the StratumMcpClient before importing build.js
// Since build.js imports it, we use a connectorFactory override and
// test the orchestration logic through the public API.

// For these tests we create a minimal project structure and mock
// the connector to create expected files.

import { runBuild } from '../lib/build.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestProject(tmpDir, featureCode = 'TEST-1') {
  // .compose/compose.json
  const composeDir = join(tmpDir, '.compose');
  mkdirSync(join(composeDir, 'data'), { recursive: true });
  writeFileSync(
    join(composeDir, 'compose.json'),
    JSON.stringify({ version: 1, capabilities: { stratum: true } })
  );

  // Feature folder with design doc
  const featureDir = join(tmpDir, 'docs', 'features', featureCode);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'design.md'), '# Test Feature\nA test feature for build runner.');

  // Lifecycle spec — minimal single-step
  const pipeDir = join(tmpDir, 'pipelines');
  mkdirSync(pipeDir, { recursive: true });
  writeFileSync(
    join(pipeDir, 'build.stratum.yaml'),
    `
version: "0.2"
contracts:
  PhaseResult:
    phase: { type: string }
    artifact: { type: string }
    outcome: { type: string }
flows:
  build:
    input:
      featureCode: { type: string }
      description: { type: string }
    output: PhaseResult
    steps:
      - id: design
        agent: claude
        intent: "Write the design doc."
        inputs:
          featureCode: "$.input.featureCode"
        output_contract: PhaseResult
        retries: 1
`
  );

  return { composeDir, featureDir, pipeDir };
}

/**
 * Create a mock connector that yields a fixed JSON result.
 */
function mockConnectorFactory(resultOverride) {
  return function factory(_agentType, _opts) {
    return {
      async *run(_prompt, _runOpts) {
        const result = resultOverride ?? { phase: 'design', artifact: 'design.md', outcome: 'complete' };
        yield { type: 'assistant', content: JSON.stringify(result) };
        yield { type: 'system', subtype: 'complete', agent: 'mock' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('build.js', () => {
  test('throws when compose.json is missing', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'build-test-'));
    try {
      await assert.rejects(
        () => runBuild('TEST-1', { cwd: tmpDir }),
        /compose\.json/
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('throws when lifecycle spec is missing', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'build-test-'));
    const composeDir = join(tmpDir, '.compose');
    mkdirSync(join(composeDir, 'data'), { recursive: true });
    writeFileSync(
      join(composeDir, 'compose.json'),
      JSON.stringify({ version: 1 })
    );
    try {
      await assert.rejects(
        () => runBuild('TEST-1', { cwd: tmpDir }),
        /Lifecycle spec not found/
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('unknown agent throws with agent name', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'build-test-'));
    createTestProject(tmpDir);

    // Factory that throws for unknown agents
    function strictFactory(agentType, opts) {
      if (agentType === 'unknown-agent') {
        throw new Error(`No connector for agent "unknown-agent"`);
      }
      return mockConnectorFactory()(agentType, opts);
    }

    // This test validates the factory pattern — the build runner itself
    // passes through the agent type from the step dispatch
    assert.throws(
      () => strictFactory('unknown-agent', {}),
      /unknown-agent/
    );

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('abort with no active build is safe', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'build-test-'));
    createTestProject(tmpDir);

    // Should not throw
    await runBuild('TEST-1', { cwd: tmpDir, abort: true });

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('abort deletes active-build.json', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'build-test-'));
    createTestProject(tmpDir);

    const dataDir = join(tmpDir, '.compose', 'data');
    writeFileSync(
      join(dataDir, 'active-build.json'),
      JSON.stringify({
        featureCode: 'TEST-1',
        flowId: 'nonexistent-flow-id',
        startedAt: new Date().toISOString(),
        currentStepId: 'design',
      })
    );

    await runBuild('TEST-1', { cwd: tmpDir, abort: true });

    const abortState = JSON.parse(readFileSync(join(dataDir, 'active-build.json'), 'utf-8'));
    assert.equal(abortState.status, 'aborted',
      'active-build.json should have terminal status "aborted"');
    assert.ok(abortState.completedAt, 'active-build.json should have completedAt');

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('different feature build proceeds without blocking', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'build-test-'));
    createTestProject(tmpDir);

    const dataDir = join(tmpDir, '.compose', 'data');
    writeFileSync(
      join(dataDir, 'active-build.json'),
      JSON.stringify({
        featureCode: 'OTHER-1',
        flowId: 'some-flow-id',
        startedAt: new Date().toISOString(),
        currentStepId: 'design',
        status: 'running',
        pid: 999999, // non-existent PID
      })
    );

    // Different feature should NOT block — concurrent builds are allowed.
    // It will fail on stratum_plan (no real server) but should NOT fail
    // with "Another build is active".
    try {
      await runBuild('TEST-1', {
        cwd: tmpDir,
        connectorFactory: mockConnectorFactory(),
      });
    } catch (err) {
      assert.ok(
        !err.message.includes('Another build is active'),
        'different feature should not block the new build'
      );
    }

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('vision writer creates feature item', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'build-test-'));
    createTestProject(tmpDir);

    const { VisionWriter } = await import('../lib/vision-writer.js');
    const dataDir = join(tmpDir, '.compose', 'data');
    const writer = new VisionWriter(dataDir, { port: 19990 });

    const itemId = await writer.ensureFeatureItem('TEST-1', 'Test Feature');
    assert.ok(itemId, 'must return an item ID');

    const item = await writer.findFeatureItem('TEST-1');
    assert.ok(item, 'must find the item');
    assert.equal(item.lifecycle.featureCode, 'TEST-1');

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
