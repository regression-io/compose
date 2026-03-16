/**
 * design-session-state.test.js — Pure logic tests for designSessionState.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const {
  createSession,
  appendMessage,
  recordDecision,
  reviseDecision,
  parseDecisionBlocks,
  isSessionComplete,
} = await import(`${ROOT}/src/components/vision/designSessionState.js`);

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

describe('createSession', () => {
  test('product scope with no featureCode', () => {
    const session = createSession('product');
    assert.equal(session.scope, 'product');
    assert.equal(session.featureCode, null);
    assert.ok(typeof session.id === 'string' && session.id.length > 0);
    assert.deepEqual(session.messages, []);
    assert.deepEqual(session.decisions, []);
    assert.equal(session.status, 'active');
    assert.ok(session.createdAt); // ISO string
  });

  test('feature scope with featureCode', () => {
    const session = createSession('feature', 'FEAT-42');
    assert.equal(session.scope, 'feature');
    assert.equal(session.featureCode, 'FEAT-42');
    assert.equal(session.status, 'active');
  });
});

// ---------------------------------------------------------------------------
// appendMessage
// ---------------------------------------------------------------------------

describe('appendMessage', () => {
  test('appends message and is immutable', () => {
    const session = createSession('product');
    const msg = {
      role: 'human',
      type: 'text',
      content: 'Hello',
      timestamp: new Date().toISOString(),
    };
    const updated = appendMessage(session, msg);

    // Original unchanged
    assert.equal(session.messages.length, 0);
    // Updated has the message
    assert.equal(updated.messages.length, 1);
    assert.deepEqual(updated.messages[0], msg);
    // Rest of session preserved
    assert.equal(updated.id, session.id);
    assert.equal(updated.scope, session.scope);
  });
});

// ---------------------------------------------------------------------------
// recordDecision
// ---------------------------------------------------------------------------

describe('recordDecision', () => {
  test('appends decision correctly', () => {
    const session = createSession('feature', 'F-1');
    const updated = recordDecision(session, 'Which DB?', { label: 'Postgres' }, 'Fast and reliable');

    assert.equal(updated.decisions.length, 1);
    const d = updated.decisions[0];
    assert.equal(d.question, 'Which DB?');
    assert.deepEqual(d.selectedOption, { label: 'Postgres' });
    assert.equal(d.comment, 'Fast and reliable');
    assert.equal(d.superseded, false);
    assert.ok(d.timestamp);
    // Original unchanged
    assert.equal(session.decisions.length, 0);
  });

  test('appends decision with null comment', () => {
    const session = createSession('product');
    const updated = recordDecision(session, 'Color?', { label: 'Blue' });

    assert.equal(updated.decisions[0].comment, null);
  });
});

// ---------------------------------------------------------------------------
// reviseDecision
// ---------------------------------------------------------------------------

describe('reviseDecision', () => {
  test('marks decision as superseded', () => {
    let session = createSession('product');
    session = recordDecision(session, 'Q1?', { label: 'A' });
    session = recordDecision(session, 'Q2?', { label: 'B' });

    const revised = reviseDecision(session, 0);
    assert.equal(revised.decisions[0].superseded, true);
    assert.equal(revised.decisions[1].superseded, false);
    // Original unchanged
    assert.equal(session.decisions[0].superseded, false);
  });
});

// ---------------------------------------------------------------------------
// parseDecisionBlocks
// ---------------------------------------------------------------------------

describe('parseDecisionBlocks', () => {
  test('no decision blocks returns text only', () => {
    const result = parseDecisionBlocks('Just some markdown text.');
    assert.equal(result.parts.length, 1);
    assert.equal(result.parts[0].type, 'text');
    assert.equal(result.parts[0].content, 'Just some markdown text.');
  });

  test('one decision block', () => {
    const text = 'Before\n```decision\n{"question":"Pick one","options":["A","B"]}\n```\nAfter';
    const result = parseDecisionBlocks(text);

    assert.equal(result.parts.length, 3);
    assert.equal(result.parts[0].type, 'text');
    assert.equal(result.parts[0].content, 'Before\n');
    assert.equal(result.parts[1].type, 'decision');
    assert.deepEqual(result.parts[1].content, { question: 'Pick one', options: ['A', 'B'] });
    assert.equal(result.parts[2].type, 'text');
    assert.equal(result.parts[2].content, '\nAfter');
  });

  test('multiple decision blocks', () => {
    const text = 'Intro\n```decision\n{"q":1}\n```\nMiddle\n```decision\n{"q":2}\n```\nEnd';
    const result = parseDecisionBlocks(text);

    assert.equal(result.parts.length, 5);
    assert.equal(result.parts[0].type, 'text');
    assert.equal(result.parts[1].type, 'decision');
    assert.deepEqual(result.parts[1].content, { q: 1 });
    assert.equal(result.parts[2].type, 'text');
    assert.equal(result.parts[3].type, 'decision');
    assert.deepEqual(result.parts[3].content, { q: 2 });
    assert.equal(result.parts[4].type, 'text');
  });

  test('malformed JSON degrades to text part', () => {
    const text = 'Before\n```decision\n{not valid json}\n```\nAfter';
    const result = parseDecisionBlocks(text);

    assert.equal(result.parts.length, 3);
    assert.equal(result.parts[0].type, 'text');
    assert.equal(result.parts[1].type, 'text');
    assert.equal(result.parts[1].content, '{not valid json}');
    assert.equal(result.parts[2].type, 'text');
  });
});

// ---------------------------------------------------------------------------
// isSessionComplete
// ---------------------------------------------------------------------------

describe('isSessionComplete', () => {
  test('returns false for active session', () => {
    const session = createSession('product');
    assert.equal(isSessionComplete(session), false);
  });

  test('returns true for complete session', () => {
    const session = { ...createSession('product'), status: 'complete' };
    assert.equal(isSessionComplete(session), true);
  });
});
