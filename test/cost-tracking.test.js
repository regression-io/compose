/**
 * Tests for cost tracking integration:
 *   - result-normalizer accumulates usage events
 *   - build-stream-writer writeUsage event shape
 *   - build-end aggregates totals
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { runAndNormalize } = await import(`${REPO_ROOT}/lib/result-normalizer.js`);
const { BuildStreamWriter } = await import(`${REPO_ROOT}/lib/build-stream-writer.js`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock connector from an array of events. */
function mockConnector(events) {
  async function* gen(_prompt, _opts) {
    for (const event of events) yield event;
  }
  return { run: gen };
}

/** Create a temporary directory for test stream files. */
function makeTempDir() {
  const dir = join(tmpdir(), `compose-cost-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// result-normalizer: accumulates usage events
// ---------------------------------------------------------------------------

test('runAndNormalize: returns usage totals when connector emits usage events', async () => {
  const events = [
    { type: 'assistant', content: 'Hello' },
    {
      type: 'usage',
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      model: 'claude-sonnet-4-6',
    },
  ];
  const connector = mockConnector(events);
  const { text, usage } = await runAndNormalize(connector, 'prompt', {});

  assert.equal(text, 'Hello');
  assert.ok(usage, 'usage should be returned');
  assert.equal(usage.input_tokens, 1000);
  assert.equal(usage.output_tokens, 500);
  assert.equal(usage.model, 'claude-sonnet-4-6');
  // cost_usd: 1000 × $3/MTok + 500 × $15/MTok = 0.003 + 0.0075 = $0.0105
  assert.ok(usage.cost_usd > 0, 'cost_usd should be positive');
  assert.ok(Math.abs(usage.cost_usd - 0.0105) < 0.0001, `expected ~$0.0105 got ${usage.cost_usd}`);
});

test('runAndNormalize: accumulates multiple usage events', async () => {
  const events = [
    { type: 'assistant', content: 'Part 1' },
    {
      type: 'usage',
      input_tokens: 500,
      output_tokens: 200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      model: 'claude-sonnet-4-6',
    },
    { type: 'assistant', content: ' Part 2' },
    {
      type: 'usage',
      input_tokens: 300,
      output_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      model: 'claude-sonnet-4-6',
    },
  ];
  const connector = mockConnector(events);
  const { usage } = await runAndNormalize(connector, 'prompt', {});

  assert.equal(usage.input_tokens, 800);
  assert.equal(usage.output_tokens, 300);
});

test('runAndNormalize: returns zero usage when no usage events', async () => {
  const events = [{ type: 'assistant', content: 'response' }];
  const connector = mockConnector(events);
  const { usage } = await runAndNormalize(connector, 'prompt', {});

  assert.ok(usage, 'usage should always be returned');
  assert.equal(usage.input_tokens, 0);
  assert.equal(usage.output_tokens, 0);
  assert.equal(usage.cost_usd, 0);
});

test('runAndNormalize: uses connector-provided cost_usd when present', async () => {
  // opencode connector pre-computes cost — should be used directly
  const events = [
    { type: 'assistant', content: 'done' },
    {
      type: 'usage',
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0.1234,
      model: 'openai/codex',
    },
  ];
  const connector = mockConnector(events);
  const { usage } = await runAndNormalize(connector, 'prompt', {});

  assert.ok(Math.abs(usage.cost_usd - 0.1234) < 0.0001, `expected 0.1234 got ${usage.cost_usd}`);
});

// ---------------------------------------------------------------------------
// BuildStreamWriter.writeUsage — event shape
// ---------------------------------------------------------------------------

test('BuildStreamWriter.writeUsage emits step_usage event with correct shape', () => {
  const tempDir = makeTempDir();
  try {
    const writer = new BuildStreamWriter(tempDir, 'TEST-1', { truncate: true });

    writer.writeUsage('execute', {
      input_tokens: 2000,
      output_tokens: 800,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 50,
      cost_usd: 0.018,
      model: 'claude-sonnet-4-6',
    });

    const lines = readFileSync(join(tempDir, 'build-stream.jsonl'), 'utf-8')
      .trim().split('\n').map(l => JSON.parse(l));

    assert.equal(lines.length, 1);
    const ev = lines[0];
    assert.equal(ev.type, 'step_usage');
    assert.equal(ev.stepId, 'execute');
    assert.equal(ev.input_tokens, 2000);
    assert.equal(ev.output_tokens, 800);
    assert.equal(ev.cache_creation_input_tokens, 100);
    assert.equal(ev.cache_read_input_tokens, 50);
    assert.equal(ev.cost_usd, 0.018);
    assert.equal(ev.model, 'claude-sonnet-4-6');
    assert.ok(typeof ev._seq === 'number', '_seq should be set');
    assert.ok(typeof ev._ts === 'number', '_ts should be set');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// BuildStreamWriter.close — build_end aggregates totals
// ---------------------------------------------------------------------------

test('BuildStreamWriter.close emits build_end with cost totals', () => {
  const tempDir = makeTempDir();
  try {
    const writer = new BuildStreamWriter(tempDir, 'TEST-2', { truncate: true });

    const costTotals = {
      input_tokens: 15000,
      output_tokens: 6000,
      cost_usd: 0.135,
    };
    writer.close('complete', costTotals);

    const lines = readFileSync(join(tempDir, 'build-stream.jsonl'), 'utf-8')
      .trim().split('\n').map(l => JSON.parse(l));

    assert.equal(lines.length, 1);
    const ev = lines[0];
    assert.equal(ev.type, 'build_end');
    assert.equal(ev.status, 'complete');
    assert.equal(ev.featureCode, 'TEST-2');
    assert.equal(ev.total_input_tokens, 15000);
    assert.equal(ev.total_output_tokens, 6000);
    assert.equal(ev.total_cost_usd, 0.135);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('BuildStreamWriter.close without cost totals emits build_end without cost fields', () => {
  const tempDir = makeTempDir();
  try {
    const writer = new BuildStreamWriter(tempDir, 'TEST-3', { truncate: true });
    writer.close('complete');

    const lines = readFileSync(join(tempDir, 'build-stream.jsonl'), 'utf-8')
      .trim().split('\n').map(l => JSON.parse(l));

    const ev = lines[0];
    assert.equal(ev.type, 'build_end');
    assert.equal(ev.total_input_tokens, undefined);
    assert.equal(ev.total_output_tokens, undefined);
    assert.equal(ev.total_cost_usd, undefined);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('BuildStreamWriter.close is idempotent — only one build_end written', () => {
  const tempDir = makeTempDir();
  try {
    const writer = new BuildStreamWriter(tempDir, 'TEST-4', { truncate: true });
    const totals = { input_tokens: 1000, output_tokens: 500, cost_usd: 0.01 };
    writer.close('complete', totals);
    writer.close('complete', totals); // second call should be no-op

    const lines = readFileSync(join(tempDir, 'build-stream.jsonl'), 'utf-8')
      .trim().split('\n').filter(Boolean);

    assert.equal(lines.length, 1, 'should have exactly one build_end');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// build-stream-writer: writeUsage + close integration
// ---------------------------------------------------------------------------

test('BuildStreamWriter: writeUsage events followed by close with totals', () => {
  const tempDir = makeTempDir();
  try {
    const writer = new BuildStreamWriter(tempDir, 'TEST-5', { truncate: true });

    writer.writeUsage('scope', { input_tokens: 1000, output_tokens: 400, cost_usd: 0.009, model: 'claude-sonnet-4-6' });
    writer.writeUsage('execute', { input_tokens: 5000, output_tokens: 2000, cost_usd: 0.045, model: 'claude-sonnet-4-6' });
    writer.close('complete', { input_tokens: 6000, output_tokens: 2400, cost_usd: 0.054 });

    const lines = readFileSync(join(tempDir, 'build-stream.jsonl'), 'utf-8')
      .trim().split('\n').map(l => JSON.parse(l));

    assert.equal(lines.length, 3);
    assert.equal(lines[0].type, 'step_usage');
    assert.equal(lines[0].stepId, 'scope');
    assert.equal(lines[1].type, 'step_usage');
    assert.equal(lines[1].stepId, 'execute');
    assert.equal(lines[2].type, 'build_end');
    assert.equal(lines[2].total_cost_usd, 0.054);

    // _seq should be monotonically increasing
    assert.equal(lines[0]._seq, 0);
    assert.equal(lines[1]._seq, 1);
    assert.equal(lines[2]._seq, 2);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
