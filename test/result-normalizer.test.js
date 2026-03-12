/**
 * Tests for lib/result-normalizer.js
 *
 * Covers:
 *   outputFieldsToJsonSchema  — flat type map to JSON Schema conversion
 *   runAndNormalize           — connector stream → structured result
 *   ResultParseError          — thrown when schema expected but no JSON found
 *   AgentError                — thrown on error events from connector
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const {
  outputFieldsToJsonSchema,
  runAndNormalize,
  ResultParseError,
  AgentError,
} = await import(`${REPO_ROOT}/lib/result-normalizer.js`);

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

// ---------------------------------------------------------------------------
// outputFieldsToJsonSchema
// ---------------------------------------------------------------------------

test('outputFieldsToJsonSchema converts typed fields to JSON Schema', () => {
  const schema = outputFieldsToJsonSchema({
    clean: 'boolean',
    findings: 'array',
  });

  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['clean', 'findings']);
  assert.deepEqual(schema.properties.clean, { type: 'boolean' });
  assert.deepEqual(schema.properties.findings, { type: 'array' });
});

test('outputFieldsToJsonSchema maps "any" type to unconstrained {}', () => {
  const schema = outputFieldsToJsonSchema({
    data: 'any',
    extra: 'unknown',
  });

  assert.deepEqual(schema.properties.data, {});
  assert.deepEqual(schema.properties.extra, {});
  assert.deepEqual(schema.required, ['data', 'extra']);
});

// ---------------------------------------------------------------------------
// runAndNormalize — JSON extraction strategies
// ---------------------------------------------------------------------------

test('normalizes clean JSON text to parsed result', async () => {
  const connector = mockConnector([
    { type: 'assistant', content: '{"clean": true}' },
  ]);

  const { text, result } = await runAndNormalize(
    connector,
    'check code',
    { output_fields: { clean: 'boolean' } },
  );

  assert.equal(text, '{"clean": true}');
  assert.deepEqual(result, { clean: true });
});

test('extracts JSON from fenced ```json block', async () => {
  const connector = mockConnector([
    { type: 'assistant', content: 'Here is the result:\n```json\n{"clean": true, "findings": []}\n```\nDone.' },
  ]);

  const { result } = await runAndNormalize(
    connector,
    'check code',
    { output_fields: { clean: 'boolean', findings: 'array' } },
  );

  assert.deepEqual(result, { clean: true, findings: [] });
});

test('extracts JSON from text with surrounding prose', async () => {
  const connector = mockConnector([
    { type: 'assistant', content: 'Here is the result: {"clean": true} done' },
  ]);

  const { result } = await runAndNormalize(
    connector,
    'check code',
    { output_fields: { clean: 'boolean' } },
  );

  assert.deepEqual(result, { clean: true });
});

// ---------------------------------------------------------------------------
// runAndNormalize — error cases
// ---------------------------------------------------------------------------

test('returns fallback result when schema expected but no JSON found', async () => {
  const connector = mockConnector([
    { type: 'assistant', content: 'I could not produce JSON' },
  ]);

  const { text, result } = await runAndNormalize(
    connector,
    'check code',
    { output_fields: { clean: 'boolean' } },
  );

  assert.equal(text, 'I could not produce JSON');
  assert.ok(result.summary, 'fallback result should have a summary');
});

test('returns { text, result: null } when no schema expected', async () => {
  const connector = mockConnector([
    { type: 'assistant', content: 'All good, no issues found.' },
  ]);

  const { text, result } = await runAndNormalize(
    connector,
    'check code',
    { output_fields: {} },
  );

  assert.equal(text, 'All good, no issues found.');
  assert.equal(result, null);
});

test('throws AgentError on error events', async () => {
  const connector = mockConnector([
    { type: 'error', message: 'fail' },
  ]);

  await assert.rejects(
    () => runAndNormalize(
      connector,
      'check code',
      { output_fields: { clean: 'boolean' } },
    ),
    (err) => {
      assert.ok(err instanceof AgentError);
      assert.equal(err.message, 'fail');
      return true;
    },
  );
});
