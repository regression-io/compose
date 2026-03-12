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

test('approve skips rationale prompt', async () => {
  const { input, output } = createMockIO(['a']);
  const result = await promptGate(DISPATCH, { input, output });
  assert.deepStrictEqual(result, { outcome: 'approve', rationale: 'approved' });
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

test('conversation then decision uses notes as rationale', async () => {
  // 'x' is treated as a note (conversation), then 'a' is the decision
  // Notes become the rationale; '' accepts notes as-is (no additional rationale)
  const { input, output } = createMockIO(['x', 'a', '']);
  const result = await promptGate(DISPATCH, { input, output });
  assert.deepStrictEqual(result, { outcome: 'approve', rationale: 'x' });
});

test('conversation with additional rationale', async () => {
  const { input, output } = createMockIO(['needs more tests', 'also fix linting', 'r', 'see notes']);
  const result = await promptGate(DISPATCH, { input, output });
  assert.strictEqual(result.outcome, 'revise');
  assert.ok(result.rationale.includes('needs more tests'));
  assert.ok(result.rationale.includes('also fix linting'));
  assert.ok(result.rationale.includes('see notes'));
});

test('revise with empty rationale then valid', async () => {
  const { input, output } = createMockIO(['r', '', 'actual rationale']);
  const result = await promptGate(DISPATCH, { input, output });
  assert.deepStrictEqual(result, { outcome: 'revise', rationale: 'actual rationale' });
});
