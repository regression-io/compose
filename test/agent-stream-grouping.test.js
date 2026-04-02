import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { groupToolResults } from '../src/components/agent-stream-helpers.js';

describe('groupToolResults', () => {
  it('pairs tool_use message with following tool_use_summary', () => {
    const toolUse = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read' }] },
    };
    const summary = { type: 'tool_use_summary', summary: 'Read 245 lines', output: 'file content...' };

    const result = groupToolResults([toolUse, summary]);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0]._toolResult, summary);
    assert.equal(result[0].type, 'assistant');
  });

  it('pairs with subtype-based tool_use_summary from bridge', () => {
    const toolUse = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Grep' }] },
    };
    const summary = { type: 'assistant', subtype: 'tool_use_summary', summary: 'found 3 matches', output: 'match1\nmatch2\nmatch3' };

    const result = groupToolResults([toolUse, summary]);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0]._toolResult, summary);
  });

  it('does not pair when next message is not a summary', () => {
    const toolUse = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read' }] },
    };
    const text = { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } };

    const result = groupToolResults([toolUse, text]);
    assert.equal(result.length, 2);
    assert.equal(result[0]._toolResult, undefined);
  });

  it('passes through standalone summary', () => {
    const summary = { type: 'tool_use_summary', summary: 'orphaned summary' };
    const result = groupToolResults([summary]);
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'tool_use_summary');
  });

  it('handles multiple consecutive pairs', () => {
    const tu1 = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } };
    const s1 = { type: 'tool_use_summary', summary: 'read file' };
    const tu2 = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep' }] } };
    const s2 = { type: 'tool_use_summary', summary: 'grep results' };

    const result = groupToolResults([tu1, s1, tu2, s2]);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0]._toolResult, s1);
    assert.deepEqual(result[1]._toolResult, s2);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(groupToolResults([]), []);
  });

  it('does not mutate original messages', () => {
    const toolUse = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read' }] },
    };
    const summary = { type: 'tool_use_summary', summary: 'read' };

    groupToolResults([toolUse, summary]);
    assert.equal(toolUse._toolResult, undefined);
  });

  it('does not pair text-only assistant messages', () => {
    const textMsg = { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } };
    const summary = { type: 'tool_use_summary', summary: 'orphan' };

    const result = groupToolResults([textMsg, summary]);
    assert.equal(result.length, 2);
    assert.equal(result[0]._toolResult, undefined);
  });

  it('handles tool_use at end of array with no following summary', () => {
    const toolUse = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read' }] },
    };

    const result = groupToolResults([toolUse]);
    assert.equal(result.length, 1);
    assert.equal(result[0]._toolResult, undefined);
  });
});
