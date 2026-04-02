/**
 * verbose-stream.test.js — Tests for verbose stream toggle in AgentStream.
 *
 * Tests the shouldIncludeMessage filter and getVerboseStream/setVerboseStream
 * exported from agent-stream-helpers.js (pure JS, no JSX/jsdom required).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const {
  shouldIncludeMessage,
  getVerboseStream,
  setVerboseStream,
} = await import(`${ROOT}/src/components/agent-stream-helpers.js`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(type, extra = {}) {
  return { type, ...extra };
}

// ---------------------------------------------------------------------------
// shouldIncludeMessage — verboseStream: false (default)
// ---------------------------------------------------------------------------

describe('shouldIncludeMessage — verboseStream false', () => {
  it('returns false for tool_progress', () => {
    const result = shouldIncludeMessage(makeMsg('tool_progress'), false);
    assert.equal(result.include, false);
  });

  it('returns false for tool_use_summary', () => {
    const result = shouldIncludeMessage(makeMsg('tool_use_summary'), false);
    assert.equal(result.include, false);
  });

  it('returns false for stream_event (always filtered)', () => {
    const result = shouldIncludeMessage(makeMsg('stream_event'), false);
    assert.equal(result.include, false);
  });

  it('returns true for assistant messages', () => {
    const result = shouldIncludeMessage(makeMsg('assistant'), false);
    assert.equal(result.include, true);
  });

  it('returns true for result messages', () => {
    const result = shouldIncludeMessage(makeMsg('result'), false);
    assert.equal(result.include, true);
  });

  it('returns true for system messages', () => {
    const result = shouldIncludeMessage(makeMsg('system', { subtype: 'init' }), false);
    assert.equal(result.include, true);
  });

  it('returns true for error messages', () => {
    const result = shouldIncludeMessage(makeMsg('error', { message: 'oops' }), false);
    assert.equal(result.include, true);
  });

  it('does not tag non-verbose messages with verbose flag', () => {
    const result = shouldIncludeMessage(makeMsg('assistant'), false);
    assert.equal(result.msg.verbose, undefined);
  });
});

// ---------------------------------------------------------------------------
// shouldIncludeMessage — verboseStream: true
// ---------------------------------------------------------------------------

describe('shouldIncludeMessage — verboseStream true', () => {
  it('returns true for tool_progress', () => {
    const result = shouldIncludeMessage(makeMsg('tool_progress'), true);
    assert.equal(result.include, true);
  });

  it('returns true for tool_use_summary', () => {
    const result = shouldIncludeMessage(makeMsg('tool_use_summary'), true);
    assert.equal(result.include, true);
  });

  it('tags tool_progress with verbose: true', () => {
    const result = shouldIncludeMessage(makeMsg('tool_progress'), true);
    assert.equal(result.msg.verbose, true);
  });

  it('tags tool_use_summary with verbose: true', () => {
    const result = shouldIncludeMessage(makeMsg('tool_use_summary'), true);
    assert.equal(result.msg.verbose, true);
  });

  it('returns false for stream_event even when verboseStream is true', () => {
    const result = shouldIncludeMessage(makeMsg('stream_event'), true);
    assert.equal(result.include, false);
  });

  it('does not add verbose tag to non-verbose message types', () => {
    const result = shouldIncludeMessage(makeMsg('assistant'), true);
    assert.equal(result.msg.verbose, undefined);
  });

  it('does not mutate the original message object', () => {
    const original = makeMsg('tool_progress');
    const result = shouldIncludeMessage(original, true);
    assert.equal(original.verbose, undefined, 'original should not be mutated');
    assert.equal(result.msg.verbose, true, 'returned msg should have verbose tag');
    assert.notEqual(result.msg, original, 'returned msg should be a new object');
  });
});

// ---------------------------------------------------------------------------
// getVerboseStream / setVerboseStream
// ---------------------------------------------------------------------------

describe('getVerboseStream / setVerboseStream', () => {
  // Reset state before each test using setVerboseStream
  beforeEach(() => {
    setVerboseStream(false);
  });

  it('getVerboseStream returns false by default', () => {
    assert.equal(getVerboseStream(), false);
  });

  it('setVerboseStream(true) changes state to true', () => {
    setVerboseStream(true);
    assert.equal(getVerboseStream(), true);
  });

  it('setVerboseStream(false) changes state to false', () => {
    setVerboseStream(true);
    setVerboseStream(false);
    assert.equal(getVerboseStream(), false);
  });

  it('setVerboseStream coerces truthy values to boolean true', () => {
    setVerboseStream(1);
    assert.equal(getVerboseStream(), true);
  });

  it('setVerboseStream coerces falsy values to boolean false', () => {
    setVerboseStream(0);
    assert.equal(getVerboseStream(), false);
  });
});

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------

describe('localStorage persistence', () => {
  it('setVerboseStream persists to localStorage when available', () => {
    const stored = {};
    const mockStorage = {
      setItem: (k, v) => { stored[k] = v; },
      getItem: (k) => stored[k] ?? null,
    };

    setVerboseStream(true, mockStorage);
    assert.equal(stored['compose:verboseStream'], 'true');

    setVerboseStream(false, mockStorage);
    assert.equal(stored['compose:verboseStream'], 'false');
  });

  it('setVerboseStream does not throw when localStorage throws', () => {
    const throwingStorage = {
      setItem: () => { throw new Error('storage full'); },
      getItem: () => null,
    };
    assert.doesNotThrow(() => setVerboseStream(true, throwingStorage));
  });

  it('hydrateVerboseStream reads true from localStorage', async () => {
    const { hydrateVerboseStream } = await import(`${ROOT}/src/components/agent-stream-helpers.js`);
    const mockStorage = {
      getItem: (k) => k === 'compose:verboseStream' ? 'true' : null,
    };
    setVerboseStream(false); // reset first
    hydrateVerboseStream(mockStorage);
    assert.equal(getVerboseStream(), true);
  });

  it('hydrateVerboseStream reads false from localStorage', async () => {
    const { hydrateVerboseStream } = await import(`${ROOT}/src/components/agent-stream-helpers.js`);
    const mockStorage = {
      getItem: (k) => k === 'compose:verboseStream' ? 'false' : null,
    };
    setVerboseStream(true); // set to true first
    hydrateVerboseStream(mockStorage);
    assert.equal(getVerboseStream(), false);
  });

  it('hydrateVerboseStream does not throw when localStorage throws', async () => {
    const { hydrateVerboseStream } = await import(`${ROOT}/src/components/agent-stream-helpers.js`);
    const throwingStorage = {
      getItem: () => { throw new Error('storage unavailable'); },
    };
    assert.doesNotThrow(() => hydrateVerboseStream(throwingStorage));
  });
});
