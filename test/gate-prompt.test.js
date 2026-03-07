/**
 * gate-prompt.test.js — Tests for the CLI gate prompt interface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { promptGate } = await import(`${REPO_ROOT}/lib/gate-prompt.js`);

function createMockIO(inputs) {
  const input = new PassThrough();
  const output = new PassThrough();
  let delay = 10;
  for (const line of inputs) {
    setTimeout(() => input.write(line + '\n'), delay);
    delay += 10;
  }
  return { input, output };
}

const DISPATCH = {
  step_id: 'review-design',
  on_approve: 'implement',
  on_revise: 'redesign',
  on_kill: 'abort',
};

test('approve with rationale', async () => {
  const { input, output } = createMockIO(['a', 'looks good']);
  const result = await promptGate(DISPATCH, { input, output });
  assert.deepStrictEqual(result, { outcome: 'approve', rationale: 'looks good' });
});

test('kill with rationale', async () => {
  const { input, output } = createMockIO(['k', 'wrong approach']);
  const result = await promptGate(DISPATCH, { input, output });
  assert.deepStrictEqual(result, { outcome: 'kill', rationale: 'wrong approach' });
});

test('full word works', async () => {
  const { input, output } = createMockIO(['revise', 'needs changes']);
  const result = await promptGate(DISPATCH, { input, output });
  assert.deepStrictEqual(result, { outcome: 'revise', rationale: 'needs changes' });
});

test('invalid input then valid', async () => {
  const { input, output } = createMockIO(['x', 'a', 'approved']);
  const result = await promptGate(DISPATCH, { input, output });
  assert.deepStrictEqual(result, { outcome: 'approve', rationale: 'approved' });
});

test('empty rationale then valid', async () => {
  const { input, output } = createMockIO(['a', '', 'actual rationale']);
  const result = await promptGate(DISPATCH, { input, output });
  assert.deepStrictEqual(result, { outcome: 'approve', rationale: 'actual rationale' });
});
