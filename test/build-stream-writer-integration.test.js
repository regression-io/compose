/**
 * Integration test: build.js -> BuildStreamWriter -> JSONL file.
 *
 * Runs a mock build via runBuild() and verifies the JSONL output
 * has correct event order, monotonic _seq, and valid _ts values.
 *
 * Skip if stratum-mcp is not installed.
 */

import { test, describe, before, after } from 'node:test';
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
// Spec: 2-step flow (no gates) for JSONL verification
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
// Mock connector that yields tool_use and assistant events
// ---------------------------------------------------------------------------

function mockConnectorFactory(tmpDir) {
  return function factory(_agentType, _opts) {
    return {
      async *run(prompt, _runOpts) {
        const stepMatch = prompt.match(/step "(\w+)"/);
        const stepId = stepMatch?.[1] ?? 'unknown';

        // Yield a tool_use event (should appear in JSONL via result-normalizer forwarding)
        yield { type: 'tool_use', tool: 'Read', input: { file_path: `/tmp/${stepId}.md` } };

        // Yield assistant text (should appear in JSONL)
        const result = { phase: stepId, artifact: `${stepId}.md`, outcome: 'complete' };
        yield { type: 'assistant', content: JSON.stringify(result) };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

// ---------------------------------------------------------------------------
// Error-throwing connector for build_error verification
// ---------------------------------------------------------------------------

function errorConnectorFactory() {
  let callCount = 0;
  return function factory(_agentType, _opts) {
    return {
      async *run(_prompt, _runOpts) {
        callCount++;
        if (callCount === 1) {
          // First step succeeds
          yield { type: 'assistant', content: JSON.stringify({ phase: 'design', artifact: 'design.md', outcome: 'complete' }) };
        } else {
          // Second step throws
          yield { type: 'error', message: 'Simulated connector failure' };
        }
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function setupProject(tmpDir, spec = TWO_STEP_SPEC, featureCode = 'JSONL-1') {
  const composeDir = join(tmpDir, '.compose');
  mkdirSync(join(composeDir, 'data'), { recursive: true });
  writeFileSync(
    join(composeDir, 'compose.json'),
    JSON.stringify({ version: 2, capabilities: { stratum: true } })
  );

  const featureDir = join(tmpDir, 'docs', 'features', featureCode);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'design.md'), '# JSONL Test\nIntegration test.');

  const pipeDir = join(tmpDir, 'pipelines');
  mkdirSync(pipeDir, { recursive: true });
  writeFileSync(join(pipeDir, 'build.stratum.yaml'), spec);

  return { composeDir, featureDir };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JSONL output integration', { skip: !stratumAvailable && 'stratum-mcp not installed' }, () => {
  let tmpDir;
  let jsonlPath;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jsonl-integ-'));
    const { composeDir } = setupProject(tmpDir);
    jsonlPath = join(composeDir, 'build-stream.jsonl');

    await runBuild('JSONL-1', {
      cwd: tmpDir,
      connectorFactory: mockConnectorFactory(tmpDir),
      description: 'JSONL integration test',
    });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('JSONL file exists and contains events', () => {
    assert.ok(existsSync(jsonlPath), 'build-stream.jsonl should exist');
    const events = readJsonl(jsonlPath);
    assert.ok(events.length > 0, 'should have at least one event');
  });

  test('events have monotonically increasing _seq', () => {
    const events = readJsonl(jsonlPath);
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i]._seq > events[i - 1]._seq,
        `_seq should be monotonically increasing: ${events[i - 1]._seq} -> ${events[i]._seq}`);
    }
  });

  test('all events have valid _ts within build window', () => {
    const events = readJsonl(jsonlPath);
    const first = events[0]._ts;
    const last = events[events.length - 1]._ts;

    for (const e of events) {
      assert.ok(typeof e._ts === 'number', '_ts must be a number');
      assert.ok(e._ts >= first && e._ts <= last + 1000,
        '_ts should be within the build duration window');
    }
  });

  test('event order: build_start -> steps -> build_end', () => {
    const events = readJsonl(jsonlPath);
    const types = events.map(e => e.type);

    assert.equal(types[0], 'build_start', 'first event should be build_start');
    assert.equal(types[types.length - 1], 'build_end', 'last event should be build_end');

    // Should have build_step_start for both steps
    const stepStarts = events.filter(e => e.type === 'build_step_start');
    assert.ok(stepStarts.length >= 2, 'should have at least 2 build_step_start events');

    // Step starts should have the right step IDs
    const stepIds = stepStarts.map(s => s.stepId);
    assert.ok(stepIds.includes('design'), 'should have design step');
    assert.ok(stepIds.includes('implement'), 'should have implement step');

    // Should have build_step_done for both
    const stepDones = events.filter(e => e.type === 'build_step_done');
    assert.ok(stepDones.length >= 2, 'should have at least 2 build_step_done events');
  });

  test('tool_use events forwarded from result-normalizer', () => {
    const events = readJsonl(jsonlPath);
    const toolUses = events.filter(e => e.type === 'tool_use');
    assert.ok(toolUses.length >= 2, 'should have tool_use events from both steps');
    assert.equal(toolUses[0].tool, 'Read', 'tool_use should carry tool name');
    assert.ok(toolUses[0].input, 'tool_use should carry input');
  });

  test('assistant events forwarded from result-normalizer', () => {
    const events = readJsonl(jsonlPath);
    const assistants = events.filter(e => e.type === 'assistant');
    assert.ok(assistants.length >= 2, 'should have assistant events from both steps');
    assert.ok(assistants[0].content, 'assistant should carry content');
  });

  test('build_start has correct metadata', () => {
    const events = readJsonl(jsonlPath);
    const start = events[0];
    assert.equal(start.type, 'build_start');
    assert.equal(start.featureCode, 'JSONL-1');
    assert.ok(start.flowId, 'build_start should have flowId');
    assert.equal(start.specPath, 'pipelines/build.stratum.yaml');
  });

  test('build_end has complete status', () => {
    const events = readJsonl(jsonlPath);
    const end = events[events.length - 1];
    assert.equal(end.type, 'build_end');
    assert.equal(end.status, 'complete');
    assert.equal(end.featureCode, 'JSONL-1');
  });

  test('build_step_start carries intent and agent fields', () => {
    const events = readJsonl(jsonlPath);
    const stepStart = events.find(e => e.type === 'build_step_start' && e.stepId === 'design');
    assert.ok(stepStart, 'should find design step start');
    assert.ok(stepStart.intent, 'build_step_start should carry intent');
    assert.equal(stepStart.agent, 'claude', 'should carry agent');
    assert.ok(stepStart.flowId, 'should carry flowId');
  });
});

describe('JSONL build_error integration', { skip: !stratumAvailable && 'stratum-mcp not installed' }, () => {
  let tmpDir;
  let jsonlPath;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jsonl-error-'));
    const { composeDir } = setupProject(tmpDir, TWO_STEP_SPEC, 'ERR-1');

    // Rename feature dir for ERR-1
    const featureDir = join(tmpDir, 'docs', 'features', 'ERR-1');
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, 'design.md'), '# Error Test\nError path test.');

    jsonlPath = join(composeDir, 'build-stream.jsonl');

    try {
      await runBuild('ERR-1', {
        cwd: tmpDir,
        connectorFactory: errorConnectorFactory(),
        description: 'Error integration test',
      });
    } catch {
      // Expected — the connector throws on step 2
    }
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('build_error event is written when connector throws', () => {
    const events = readJsonl(jsonlPath);
    const errors = events.filter(e => e.type === 'build_error');
    assert.ok(errors.length > 0, 'should have at least one build_error event');
    assert.ok(errors[0].message, 'build_error should have message');
  });
});

describe('JSONL writer not created before plan succeeds', { skip: !stratumAvailable && 'stratum-mcp not installed' }, () => {
  test('rejected build does not truncate existing JSONL', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'jsonl-notrunc-'));

    try {
      // Set up project
      setupProject(tmpDir, TWO_STEP_SPEC, 'NOTRUNC-1');
      const featureDir = join(tmpDir, 'docs', 'features', 'NOTRUNC-1');
      mkdirSync(featureDir, { recursive: true });
      writeFileSync(join(featureDir, 'design.md'), '# Test\nTest.');

      const jsonlPath = join(tmpDir, '.compose', 'build-stream.jsonl');

      // Pre-populate JSONL with a sentinel
      writeFileSync(jsonlPath, '{"type":"build_start","_seq":0}\n');

      // Create an active build for a DIFFERENT feature to trigger rejection
      const dataDir = join(tmpDir, '.compose', 'data');
      writeFileSync(join(dataDir, 'active-build.json'), JSON.stringify({
        featureCode: 'OTHER-1',
        flowId: 'fake-flow-id',
        status: 'running',
      }));

      try {
        await runBuild('NOTRUNC-1', {
          cwd: tmpDir,
          connectorFactory: mockConnectorFactory(tmpDir),
          description: 'Should be rejected',
        });
        assert.fail('Should have thrown due to active build conflict');
      } catch (err) {
        assert.ok(err.message.includes('Another build is active'),
          'should throw active-build conflict error');
      }

      // Original JSONL should be intact
      const content = readFileSync(jsonlPath, 'utf-8');
      assert.ok(content.includes('"build_start"'),
        'original JSONL content should be preserved');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
