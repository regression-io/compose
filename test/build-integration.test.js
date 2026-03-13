/**
 * Integration test for the build runner.
 *
 * Uses a real stratum-mcp subprocess with a mock agent connector.
 * The test validates the runner orchestration, not agent inference.
 *
 * Skip if stratum-mcp is not installed.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { runBuild } from '../lib/build.js';

// ---------------------------------------------------------------------------
// Skip guard
// ---------------------------------------------------------------------------

let stratumAvailable = false;
try {
  execFileSync('stratum-mcp', ['--help'], { timeout: 5000, stdio: 'pipe' });
  stratumAvailable = true;
} catch { /* not installed */ }

// ---------------------------------------------------------------------------
// Spec: 2-step inline flow with no gates (for fast testing)
// ---------------------------------------------------------------------------

const TWO_STEP_SPEC = `\
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
        intent: "Write the design doc for the feature."
        inputs:
          featureCode: "$.input.featureCode"
        output_contract: PhaseResult
        retries: 1

      - id: implement
        agent: claude
        intent: "Implement the feature based on the design."
        inputs:
          featureCode: "$.input.featureCode"
        output_contract: PhaseResult
        retries: 1
        depends_on: [design]
`;

// ---------------------------------------------------------------------------
// Spec: flow composition — parent flow delegates to a sub-flow via `flow:`
// ---------------------------------------------------------------------------

const SUBFLOW_SPEC = `\
version: "0.2"

contracts:
  PhaseResult:
    phase: { type: string }
    artifact: { type: string }
    outcome: { type: string }

  ReviewResult:
    clean: { type: boolean }
    summary: { type: string }

flows:
  review_fix:
    input:
      task: { type: string }
    output: ReviewResult
    steps:
      - id: review
        agent: claude
        intent: "Review the implementation. Return clean=true if no issues."
        inputs:
          task: "$.input.task"
        output_contract: ReviewResult
        retries: 1

      - id: fix
        agent: claude
        intent: "Fix any issues found during review."
        inputs:
          task: "$.input.task"
        output_contract: ReviewResult
        retries: 1
        depends_on: [review]

  build:
    input:
      featureCode: { type: string }
      description: { type: string }
    output: PhaseResult
    steps:
      - id: implement
        agent: claude
        intent: "Implement the feature."
        inputs:
          featureCode: "$.input.featureCode"
        output_contract: PhaseResult
        retries: 1

      - id: review
        flow: review_fix
        inputs:
          task: "$.input.description"
        depends_on: [implement]

      - id: ship
        agent: claude
        intent: "Ship the feature."
        inputs:
          featureCode: "$.input.featureCode"
        output_contract: PhaseResult
        retries: 1
        depends_on: [review]
`;

// ---------------------------------------------------------------------------
// Mock connector factories
// ---------------------------------------------------------------------------

/**
 * Generic mock connector that extracts step_id from the prompt,
 * writes a marker file, and returns a result matching the expected contract.
 * `contractMap` maps step_id → result object. Falls back to PhaseResult shape.
 */
function mockConnectorFactory(tmpDir, contractMap = {}) {
  return function factory(_agentType, _opts) {
    return {
      async *run(prompt, _runOpts) {
        // Extract step_id from prompt to determine what to return
        const stepMatch = prompt.match(/step "(\w+)"/);
        const stepId = stepMatch?.[1] ?? 'unknown';

        // Create a file to prove the connector ran
        const markerDir = join(tmpDir, '.compose', 'data', 'markers');
        mkdirSync(markerDir, { recursive: true });
        writeFileSync(join(markerDir, `${stepId}.done`), 'completed');

        const result = contractMap[stepId] ?? {
          phase: stepId,
          artifact: `${stepId}.md`,
          outcome: 'complete',
        };

        yield { type: 'assistant', content: JSON.stringify(result) };
        yield { type: 'system', subtype: 'complete', agent: 'mock' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function setupProject(tmpDir) {
  // .compose/
  const composeDir = join(tmpDir, '.compose');
  mkdirSync(join(composeDir, 'data'), { recursive: true });
  writeFileSync(
    join(composeDir, 'compose.json'),
    JSON.stringify({ version: 2, capabilities: { stratum: true } })
  );

  // Feature folder
  const featureDir = join(tmpDir, 'docs', 'features', 'TEST-1');
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'design.md'), '# Test Feature\nIntegration test feature.');

  // Lifecycle spec
  const pipeDir = join(tmpDir, 'pipelines');
  mkdirSync(pipeDir, { recursive: true });
  writeFileSync(join(pipeDir, 'build.stratum.yaml'), TWO_STEP_SPEC);

  return { composeDir, featureDir, pipeDir };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('build integration', { skip: !stratumAvailable && 'stratum-mcp not installed' }, () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'build-integ-'));
    setupProject(tmpDir);
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('full build: 2-step flow completes with audit trace', async () => {
    await runBuild('TEST-1', {
      cwd: tmpDir,
      connectorFactory: mockConnectorFactory(tmpDir),
      description: 'Integration test feature',
    });

    // active-build.json retained with terminal status (per STRAT-COMP-4)
    const activePath = join(tmpDir, '.compose', 'data', 'active-build.json');
    assert.ok(existsSync(activePath),
      'active-build.json should be retained after completion');
    const activeState = JSON.parse(readFileSync(activePath, 'utf-8'));
    assert.equal(activeState.status, 'complete',
      'active-build.json should have terminal status "complete"');
    assert.ok(activeState.completedAt, 'active-build.json should have completedAt');

    // audit.json should be written
    const auditPath = join(tmpDir, 'docs', 'features', 'TEST-1', 'audit.json');
    assert.ok(existsSync(auditPath), 'audit.json should be written');
    const audit = JSON.parse(readFileSync(auditPath, 'utf-8'));
    assert.ok(audit.flow_id, 'audit must have flow_id');
    assert.equal(audit.status, 'complete', 'audit must show complete status');
    assert.ok(Array.isArray(audit.trace), 'audit must have trace array');

    // vision-state.json should have the feature item
    const visionPath = join(tmpDir, '.compose', 'data', 'vision-state.json');
    assert.ok(existsSync(visionPath), 'vision-state.json should exist');
    const vision = JSON.parse(readFileSync(visionPath, 'utf-8'));
    const item = vision.items.find(i => i.featureCode === 'feature:TEST-1');
    assert.ok(item, 'must have feature item');
    assert.equal(item.status, 'complete', 'item status should be complete');

    // Both steps should have run (marker files)
    const markerDir = join(tmpDir, '.compose', 'data', 'markers');
    assert.ok(existsSync(join(markerDir, 'design.done')), 'design step should have run');
    assert.ok(existsSync(join(markerDir, 'implement.done')), 'implement step should have run');
  });
});

// ---------------------------------------------------------------------------
// Sub-flow (execute_flow) integration test
// ---------------------------------------------------------------------------

describe('build integration: sub-flow dispatch', { skip: !stratumAvailable && 'stratum-mcp not installed' }, () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'build-subflow-'));

    // .compose/
    const composeDir = join(tmpDir, '.compose');
    mkdirSync(join(composeDir, 'data'), { recursive: true });
    writeFileSync(
      join(composeDir, 'compose.json'),
      JSON.stringify({ version: 2, capabilities: { stratum: true } })
    );

    // Feature folder
    const featureDir = join(tmpDir, 'docs', 'features', 'SUB-1');
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, 'design.md'), '# Sub-flow Test\nTests execute_flow dispatch.');

    // Lifecycle spec with sub-flow
    const pipeDir = join(tmpDir, 'pipelines');
    mkdirSync(pipeDir, { recursive: true });
    writeFileSync(join(pipeDir, 'build.stratum.yaml'), SUBFLOW_SPEC);
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('flow with sub-flow: parent completes after child flow finishes', async () => {
    // The review_fix sub-flow steps need ReviewResult-shaped output
    const contractMap = {
      review: { clean: true, summary: 'All clear' },
      fix: { clean: true, summary: 'Fixed' },
    };

    await runBuild('SUB-1', {
      cwd: tmpDir,
      connectorFactory: mockConnectorFactory(tmpDir, contractMap),
      description: 'Sub-flow integration test',
    });

    // active-build.json retained with terminal status (per STRAT-COMP-4)
    const activePath = join(tmpDir, '.compose', 'data', 'active-build.json');
    assert.ok(existsSync(activePath),
      'active-build.json should be retained after completion');
    const activeState = JSON.parse(readFileSync(activePath, 'utf-8'));
    assert.equal(activeState.status, 'complete',
      'active-build.json should have terminal status "complete"');

    // audit.json should exist with complete status
    const auditPath = join(tmpDir, 'docs', 'features', 'SUB-1', 'audit.json');
    assert.ok(existsSync(auditPath), 'audit.json should be written');
    const audit = JSON.parse(readFileSync(auditPath, 'utf-8'));
    assert.equal(audit.status, 'complete', 'parent flow must complete');
    assert.ok(Array.isArray(audit.trace), 'audit must have trace array');

    // The parent flow's steps should all have run:
    // implement (direct step), review (sub-flow), ship (direct step after sub-flow)
    const markerDir = join(tmpDir, '.compose', 'data', 'markers');
    assert.ok(existsSync(join(markerDir, 'implement.done')),
      'implement step (before sub-flow) should have run');
    assert.ok(existsSync(join(markerDir, 'ship.done')),
      'ship step (after sub-flow) should have run — proves parent continued after child completed');

    // Sub-flow's own steps should also have run
    assert.ok(existsSync(join(markerDir, 'review.done')),
      'review step (inside sub-flow) should have run');

    // vision-state should show complete
    const visionPath = join(tmpDir, '.compose', 'data', 'vision-state.json');
    const vision = JSON.parse(readFileSync(visionPath, 'utf-8'));
    const item = vision.items.find(i => i.featureCode === 'feature:SUB-1');
    assert.ok(item, 'must have feature item');
    assert.equal(item.status, 'complete', 'item status should be complete');
  });
});

// ---------------------------------------------------------------------------
// Resume-path integration tests
// ---------------------------------------------------------------------------

function interruptingConnectorFactory(tmpDir) {
  return function factory(_agentType, _opts) {
    return {
      async *run(prompt, _runOpts) {
        const stepMatch = prompt.match(/step "(\w+)"/);
        const stepId = stepMatch?.[1] ?? 'unknown';

        if (stepId === 'implement') {
          throw new Error('simulated crash');
        }

        const markerDir = join(tmpDir, '.compose', 'data', 'markers');
        mkdirSync(markerDir, { recursive: true });
        writeFileSync(join(markerDir, `${stepId}.done`), 'completed');

        yield { type: 'assistant', content: JSON.stringify({
          phase: stepId, artifact: `${stepId}.md`, outcome: 'complete',
        }) };
        yield { type: 'system', subtype: 'complete', agent: 'mock' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

describe('build integration: resume', { skip: !stratumAvailable && 'stratum-mcp not installed' }, () => {

  // -------------------------------------------------------------------------
  // Test 1: resume continues from correct step after interruption
  // -------------------------------------------------------------------------
  describe('resume continues from correct step after interruption', () => {
    let tmpDir;

    before(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'build-resume-'));
      setupProject(tmpDir);
    });

    after(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    test('interrupted build resumes and completes', async () => {
      const activePath = join(tmpDir, '.compose', 'data', 'active-build.json');
      const markerDir = join(tmpDir, '.compose', 'data', 'markers');

      // First run — crashes on implement step
      try {
        await runBuild('TEST-1', {
          cwd: tmpDir,
          connectorFactory: interruptingConnectorFactory(tmpDir),
          description: 'test',
        });
        assert.fail('Expected runBuild to throw due to simulated crash');
      } catch (err) {
        assert.ok(err.message.includes('simulated crash') || err,
          'should throw from the interrupting connector');
      }

      // active-build.json should exist (flow was in progress when it crashed)
      assert.ok(existsSync(activePath),
        'active-build.json should exist after interrupted build');

      // Read it and verify structure
      const activeBuild = JSON.parse(readFileSync(activePath, 'utf-8'));
      assert.ok(activeBuild.flowId, 'active-build.json must have flowId');
      assert.equal(activeBuild.featureCode, 'TEST-1',
        'active-build.json featureCode should be TEST-1');

      // design step completed before crash
      assert.ok(existsSync(join(markerDir, 'design.done')),
        'design.done marker should exist (step 1 completed before crash)');

      // implement step did NOT complete
      assert.equal(existsSync(join(markerDir, 'implement.done')), false,
        'implement.done marker should NOT exist (step 2 crashed)');

      // Second run — resume with working connector
      await runBuild('TEST-1', {
        cwd: tmpDir,
        connectorFactory: mockConnectorFactory(tmpDir),
        description: 'test',
      });

      // implement step should now be done
      assert.ok(existsSync(join(markerDir, 'implement.done')),
        'implement.done marker should exist after resume');

      // active-build.json retained with terminal status (per STRAT-COMP-4)
      assert.ok(existsSync(activePath),
        'active-build.json should be retained after completion');
      const activeState2 = JSON.parse(readFileSync(activePath, 'utf-8'));
      assert.equal(activeState2.status, 'complete',
        'active-build.json should have terminal status "complete"');

      // audit.json should exist with complete status
      const auditPath = join(tmpDir, 'docs', 'features', 'TEST-1', 'audit.json');
      assert.ok(existsSync(auditPath), 'audit.json should be written');
      const audit = JSON.parse(readFileSync(auditPath, 'utf-8'));
      assert.equal(audit.status, 'complete', 'audit must show complete status');
    });
  });

  // -------------------------------------------------------------------------
  // Test 2: resume with completed flow starts fresh
  // -------------------------------------------------------------------------
  describe('resume with completed flow starts fresh', () => {
    let tmpDir;

    before(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'build-resume-fresh-'));
      setupProject(tmpDir);
    });

    after(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    test('stale active-build.json is discarded and fresh build succeeds', async () => {
      const activePath = join(tmpDir, '.compose', 'data', 'active-build.json');

      // First run — completes normally
      await runBuild('TEST-1', {
        cwd: tmpDir,
        connectorFactory: mockConnectorFactory(tmpDir),
        description: 'test',
      });

      // active-build.json retained with terminal status (per STRAT-COMP-4)
      assert.ok(existsSync(activePath),
        'active-build.json should be retained after first build');
      const firstState = JSON.parse(readFileSync(activePath, 'utf-8'));
      assert.equal(firstState.status, 'complete', 'first build should be complete');

      // Manually write a stale active-build.json with a non-existent flowId
      const dataDir = join(tmpDir, '.compose', 'data');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(activePath, JSON.stringify({
        featureCode: 'TEST-1',
        flowId: 'stale-nonexistent-uuid',
        startedAt: new Date().toISOString(),
      }));

      assert.ok(existsSync(activePath),
        'stale active-build.json should exist before second run');

      // Run again — should discard stale state and start fresh
      await runBuild('TEST-1', {
        cwd: tmpDir,
        connectorFactory: mockConnectorFactory(tmpDir),
        description: 'test',
      });

      // active-build.json retained with terminal status (per STRAT-COMP-4)
      assert.ok(existsSync(activePath),
        'active-build.json should be retained after fresh build');
      const freshState = JSON.parse(readFileSync(activePath, 'utf-8'));
      assert.equal(freshState.status, 'complete',
        'fresh build should have terminal status "complete"');

      // audit.json should exist with complete status
      const auditPath = join(tmpDir, 'docs', 'features', 'TEST-1', 'audit.json');
      assert.ok(existsSync(auditPath), 'audit.json should be written');
      const audit = JSON.parse(readFileSync(auditPath, 'utf-8'));
      assert.equal(audit.status, 'complete', 'audit must show complete status');
    });
  });
});
