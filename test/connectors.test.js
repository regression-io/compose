/**
 * Unit tests for server/connectors/ — no inference backend required.
 *
 * Covers:
 *   - AgentConnector.run() throws (base class contract)
 *   - AgentConnector.isRunning returns false
 *   - injectSchema: prompt + schema formatting
 *   - CODEX_MODEL_IDS: set membership
 *   - CodexConnector: constructor rejects unknown models
 *   - CodexConnector: constructor accepts valid models
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Dynamic imports so test file can be discovered even if connector files have
// syntax errors in unrelated connectors.
const { AgentConnector, injectSchema } = await import(
  `${REPO_ROOT}/server/connectors/agent-connector.js`
);
const { CodexConnector, CODEX_MODEL_IDS } = await import(
  `${REPO_ROOT}/server/connectors/codex-connector.js`
);

// ---------------------------------------------------------------------------
// AgentConnector base
// ---------------------------------------------------------------------------

test('AgentConnector.run() throws not-implemented', async () => {
  const conn = new AgentConnector();
  const gen = conn.run('hello');
  await assert.rejects(
    () => gen.next(),
    /AgentConnector\.run\(\) not implemented/,
  );
});

test('AgentConnector.isRunning returns false', () => {
  assert.equal(new AgentConnector().isRunning, false);
});

test('AgentConnector.interrupt() is a no-op', () => {
  assert.doesNotThrow(() => new AgentConnector().interrupt());
});

// ---------------------------------------------------------------------------
// injectSchema
// ---------------------------------------------------------------------------

test('injectSchema appends schema block to prompt', () => {
  const schema = { type: 'object', properties: { x: { type: 'number' } } };
  const result = injectSchema('Do the thing', schema);
  assert.ok(result.startsWith('Do the thing\n\n'));
  assert.ok(result.includes('include a JSON code block'));
  assert.ok(result.includes('"type": "object"'));
});

test('injectSchema preserves original prompt verbatim', () => {
  const schema = { type: 'string' };
  const prompt = 'My prompt with special chars: <>&"\'';
  const result = injectSchema(prompt, schema);
  assert.ok(result.startsWith(prompt));
});

test('injectSchema handles empty schema object', () => {
  const result = injectSchema('prompt', {});
  assert.ok(result.includes('{}'));
});

// ---------------------------------------------------------------------------
// CODEX_MODEL_IDS
// ---------------------------------------------------------------------------

test('CODEX_MODEL_IDS is a non-empty Set', () => {
  assert.ok(CODEX_MODEL_IDS instanceof Set);
  assert.ok(CODEX_MODEL_IDS.size > 0);
});

test('CODEX_MODEL_IDS contains expected base models', () => {
  assert.ok(CODEX_MODEL_IDS.has('gpt-5.2-codex'));
  assert.ok(CODEX_MODEL_IDS.has('gpt-5.1-codex'));
  assert.ok(CODEX_MODEL_IDS.has('gpt-5.1-codex-max'));
  assert.ok(CODEX_MODEL_IDS.has('gpt-5.1-codex-mini'));
});

test('CODEX_MODEL_IDS contains reasoning variants', () => {
  assert.ok(CODEX_MODEL_IDS.has('gpt-5.2-codex/low'));
  assert.ok(CODEX_MODEL_IDS.has('gpt-5.2-codex/high'));
  assert.ok(CODEX_MODEL_IDS.has('gpt-5.1-codex-max/xhigh'));
});

// ---------------------------------------------------------------------------
// CodexConnector construction
// ---------------------------------------------------------------------------

test('CodexConnector rejects unknown modelID at construction', () => {
  assert.throws(
    () => new CodexConnector({ modelID: 'gpt-4o' }),
    /CodexConnector:.*not a supported Codex model/,
  );
});

test('CodexConnector rejects empty string modelID', () => {
  assert.throws(
    () => new CodexConnector({ modelID: '' }),
    /CodexConnector/,
  );
});

test('CodexConnector accepts valid modelID from CODEX_MODEL_IDS', () => {
  // Pick any valid model — construction should not throw
  const model = [...CODEX_MODEL_IDS][0];
  assert.doesNotThrow(() => new CodexConnector({ modelID: model }));
});

test('CodexConnector.isRunning is false before any run()', () => {
  const model = [...CODEX_MODEL_IDS][0];
  const conn = new CodexConnector({ modelID: model });
  assert.equal(conn.isRunning, false);
});
