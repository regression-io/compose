/**
 * design-session.test.js — DesignSessionManager unit tests.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { DesignSessionManager } = await import(`${ROOT}/server/design-session.js`);

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'design-session-test-'));
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('constructor', () => {
  test('creates fresh state when no file exists', () => {
    const dir = freshDir();
    const mgr = new DesignSessionManager(dir);
    assert.equal(mgr.getSession('product'), null);
    mgr.destroy();
  });

  test('loads from existing file', () => {
    const dir = freshDir();
    const existing = {
      product: {
        id: 'abc', scope: 'product', featureCode: null,
        messages: [], decisions: [], status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      features: {},
    };
    writeFileSync(join(dir, 'design-sessions.json'), JSON.stringify(existing), 'utf-8');
    const mgr = new DesignSessionManager(dir);
    const session = mgr.getSession('product');
    assert.equal(session.id, 'abc');
    assert.equal(session.status, 'active');
    mgr.destroy();
  });
});

// ---------------------------------------------------------------------------
// startSession
// ---------------------------------------------------------------------------

describe('startSession', () => {
  test('creates product session', () => {
    const dir = freshDir();
    const mgr = new DesignSessionManager(dir);
    const session = mgr.startSession('product');
    assert.ok(session.id);
    assert.equal(session.scope, 'product');
    assert.equal(session.featureCode, null);
    assert.equal(session.status, 'active');
    assert.ok(Array.isArray(session.messages));
    assert.ok(Array.isArray(session.decisions));
    assert.ok(session.createdAt);
    mgr.destroy();
  });

  test('creates feature session with featureCode', () => {
    const dir = freshDir();
    const mgr = new DesignSessionManager(dir);
    const session = mgr.startSession('feature', 'FEAT-1');
    assert.ok(session.id);
    assert.equal(session.scope, 'feature');
    assert.equal(session.featureCode, 'FEAT-1');
    assert.equal(session.status, 'active');
    mgr.destroy();
  });

  test('throws when session already active for that scope', () => {
    const dir = freshDir();
    const mgr = new DesignSessionManager(dir);
    mgr.startSession('product');
    assert.throws(() => mgr.startSession('product'), /already.*active/i);
    mgr.destroy();
  });

  test('throws when feature session already active for same featureCode', () => {
    const dir = freshDir();
    const mgr = new DesignSessionManager(dir);
    mgr.startSession('feature', 'FEAT-1');
    assert.throws(() => mgr.startSession('feature', 'FEAT-1'), /already.*active/i);
    mgr.destroy();
  });

  test('allows different feature sessions concurrently', () => {
    const dir = freshDir();
    const mgr = new DesignSessionManager(dir);
    mgr.startSession('feature', 'FEAT-1');
    const s2 = mgr.startSession('feature', 'FEAT-2');
    assert.equal(s2.featureCode, 'FEAT-2');
    mgr.destroy();
  });
});

// ---------------------------------------------------------------------------
// getSession
// ---------------------------------------------------------------------------

describe('getSession', () => {
  test('returns null when no session', () => {
    const dir = freshDir();
    const mgr = new DesignSessionManager(dir);
    assert.equal(mgr.getSession('product'), null);
    assert.equal(mgr.getSession('feature', 'FEAT-X'), null);
    mgr.destroy();
  });

  test('returns session when it exists', () => {
    const dir = freshDir();
    const mgr = new DesignSessionManager(dir);
    mgr.startSession('product');
    const session = mgr.getSession('product');
    assert.ok(session);
    assert.equal(session.scope, 'product');
    mgr.destroy();
  });

  test('returns feature session by featureCode', () => {
    const dir = freshDir();
    const mgr = new DesignSessionManager(dir);
    mgr.startSession('feature', 'FEAT-1');
    const session = mgr.getSession('feature', 'FEAT-1');
    assert.ok(session);
    assert.equal(session.featureCode, 'FEAT-1');
    mgr.destroy();
  });
});

// ---------------------------------------------------------------------------
// appendMessage
// ---------------------------------------------------------------------------

describe('appendMessage', () => {
  test('adds to messages array', () => {
    const dir = freshDir();
    const mgr = new DesignSessionManager(dir);
    mgr.startSession('product');
    const msg = { role: 'user', type: 'text', content: 'Hello' };
    const updated = mgr.appendMessage('product', null, msg);
    assert.equal(updated.messages.length, 1);
    assert.equal(updated.messages[0].role, 'user');
    assert.equal(updated.messages[0].content, 'Hello');
    assert.ok(updated.messages[0].timestamp);
    mgr.destroy();
  });
});

// ---------------------------------------------------------------------------
// recordDecision
// ---------------------------------------------------------------------------

describe('recordDecision', () => {
  test('adds to decisions array', () => {
    const dir = freshDir();
    const mgr = new DesignSessionManager(dir);
    mgr.startSession('product');
    const updated = mgr.recordDecision('product', null, 'Which DB?', { label: 'Postgres' }, 'Best fit');
    assert.equal(updated.decisions.length, 1);
    assert.equal(updated.decisions[0].question, 'Which DB?');
    assert.deepEqual(updated.decisions[0].selectedOption, { label: 'Postgres' });
    assert.equal(updated.decisions[0].comment, 'Best fit');
    assert.equal(updated.decisions[0].superseded, false);
    assert.ok(updated.decisions[0].timestamp);
    mgr.destroy();
  });

  test('records decision with no comment', () => {
    const dir = freshDir();
    const mgr = new DesignSessionManager(dir);
    mgr.startSession('feature', 'F-1');
    const updated = mgr.recordDecision('feature', 'F-1', 'Color?', { label: 'Blue' });
    assert.equal(updated.decisions[0].comment, null);
    mgr.destroy();
  });
});

// ---------------------------------------------------------------------------
// reviseDecision
// ---------------------------------------------------------------------------

describe('reviseDecision', () => {
  test('marks decision as superseded', () => {
    const dir = freshDir();
    const mgr = new DesignSessionManager(dir);
    mgr.startSession('product');
    mgr.recordDecision('product', null, 'Which DB?', { label: 'Postgres' });
    const updated = mgr.reviseDecision('product', null, 0);
    assert.equal(updated.decisions[0].superseded, true);
    mgr.destroy();
  });
});

// ---------------------------------------------------------------------------
// completeSession
// ---------------------------------------------------------------------------

describe('completeSession', () => {
  test('sets status to complete', () => {
    const dir = freshDir();
    const mgr = new DesignSessionManager(dir);
    mgr.startSession('product');
    const updated = mgr.completeSession('product');
    assert.equal(updated.status, 'complete');
    mgr.destroy();
  });

  test('allows starting new session after completing previous', () => {
    const dir = freshDir();
    const mgr = new DesignSessionManager(dir);
    mgr.startSession('product');
    mgr.completeSession('product');
    const s2 = mgr.startSession('product');
    assert.equal(s2.status, 'active');
    mgr.destroy();
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('persistence', () => {
  test('startSession persists to disk', () => {
    const dir = freshDir();
    const mgr = new DesignSessionManager(dir);
    mgr.startSession('product');
    mgr._saveNow();
    const raw = JSON.parse(readFileSync(join(dir, 'design-sessions.json'), 'utf-8'));
    assert.ok(raw.product);
    assert.equal(raw.product.scope, 'product');
    mgr.destroy();
  });

  test('round-trip: new manager reads persisted state', () => {
    const dir = freshDir();
    const mgr1 = new DesignSessionManager(dir);
    mgr1.startSession('product');
    mgr1.appendMessage('product', null, { role: 'user', type: 'text', content: 'Hi' });
    mgr1._saveNow();
    mgr1.destroy();

    const mgr2 = new DesignSessionManager(dir);
    const session = mgr2.getSession('product');
    assert.equal(session.messages.length, 1);
    assert.equal(session.messages[0].content, 'Hi');
    mgr2.destroy();
  });

  test('completeSession persists immediately', () => {
    const dir = freshDir();
    const mgr = new DesignSessionManager(dir);
    mgr.startSession('feature', 'F-1');
    mgr.completeSession('feature', 'F-1');
    // Should be on disk without calling _saveNow
    const raw = JSON.parse(readFileSync(join(dir, 'design-sessions.json'), 'utf-8'));
    assert.equal(raw.features['F-1'].status, 'complete');
    mgr.destroy();
  });

  test('destroy flushes pending saves', () => {
    const dir = freshDir();
    const mgr = new DesignSessionManager(dir);
    mgr.startSession('product');
    mgr.appendMessage('product', null, { role: 'user', type: 'text', content: 'pending' });
    // Don't call _saveNow — destroy should flush
    mgr.destroy();
    const raw = JSON.parse(readFileSync(join(dir, 'design-sessions.json'), 'utf-8'));
    assert.equal(raw.product.messages[0].content, 'pending');
  });
});
