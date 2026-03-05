/**
 * Regression tests for extracted server pure functions.
 *
 * Covers:
 *   session-store.js   — serializeSession, persistSession, readLastSession
 *   vision-utils.js    — detectError, extractSlugFromPath, extractFilePaths
 *   block-tracker.js   — updateBlock, closeCurrentBlock, classifyBlockIntent
 *
 * No HTTP, no spawned processes, no inference. All I/O uses tmp dirs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { serializeSession, persistSession, readLastSession } = await import(
  `${REPO_ROOT}/server/session-store.js`
);
const { detectError, extractSlugFromPath, extractFilePaths } = await import(
  `${REPO_ROOT}/server/vision-utils.js`
);
const { updateBlock, closeCurrentBlock, classifyBlockIntent } = await import(
  `${REPO_ROOT}/server/block-tracker.js`
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides = {}) {
  return {
    id: 'session-123',
    startedAt: '2024-01-01T00:00:00.000Z',
    endedAt: null,
    endReason: null,
    source: 'startup',
    toolCount: 0,
    items: new Map(),
    currentBlock: null,
    blocks: [],
    commits: [],
    errors: [],
    transcriptPath: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// serializeSession
// ---------------------------------------------------------------------------

test('serializeSession converts Map items to plain object', () => {
  const session = makeSession();
  session.items.set('COMPOSE-TASK-1', { title: 'T1', reads: 1, writes: 2, summaries: [], firstTouched: '2024-01-01T00:00:00.000Z', lastTouched: '2024-01-01T00:01:00.000Z' });
  const out = serializeSession(session);
  assert.equal(typeof out.items, 'object');
  assert.ok(!('get' in out.items), 'items should not be a Map');
  assert.equal(out.items['COMPOSE-TASK-1'].title, 'T1');
});

test('serializeSession preserves scalar fields', () => {
  const session = makeSession({ toolCount: 42, source: 'resume' });
  const out = serializeSession(session);
  assert.equal(out.id, 'session-123');
  assert.equal(out.toolCount, 42);
  assert.equal(out.source, 'resume');
});

test('serializeSession fills in null for missing optional fields', () => {
  const session = makeSession();
  const out = serializeSession(session);
  assert.equal(out.endedAt, null);
  assert.equal(out.endReason, null);
  assert.equal(out.transcriptPath, null);
});

// ---------------------------------------------------------------------------
// persistSession + readLastSession (round-trip)
// ---------------------------------------------------------------------------

let tmpDir;
test('persistSession writes to file and readLastSession retrieves it', () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'compose-test-'));
  const file = join(tmpDir, 'sessions.json');

  const session = serializeSession(makeSession({ toolCount: 5 }));
  persistSession(session, file);

  const last = readLastSession(file);
  assert.ok(last, 'readLastSession should return the session');
  assert.equal(last.id, 'session-123');
  assert.equal(last.toolCount, 5);
});

test('persistSession appends multiple sessions', () => {
  const file = join(tmpDir, 'sessions.json');
  const s2 = serializeSession(makeSession({ id: 'session-456' }));
  persistSession(s2, file);

  const last = readLastSession(file);
  assert.equal(last.id, 'session-456', 'readLastSession should return the most recent');
});

test('readLastSession returns null for missing file', () => {
  const result = readLastSession('/nonexistent/path/sessions.json');
  assert.equal(result, null);
});

// Cleanup tmp dir
import { after } from 'node:test';
after(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// detectError
// ---------------------------------------------------------------------------

test('detectError returns null for empty string', () => {
  assert.equal(detectError('Bash', {}, ''), null);
});

test('detectError returns null for non-matching text', () => {
  assert.equal(detectError('Bash', {}, 'All tests passed successfully'), null);
});

test('detectError detects SyntaxError as build_error', () => {
  const result = detectError('Bash', {}, 'SyntaxError: Unexpected token');
  assert.ok(result, 'should detect error');
  assert.equal(result.type, 'build_error');
  assert.equal(result.severity, 'error');
  assert.ok(result.message.length > 0);
});

test('detectError detects npm ERR! as build_error', () => {
  const result = detectError('Bash', {}, 'npm ERR! Missing script: build');
  assert.equal(result?.type, 'build_error');
});

test('detectError detects ENOENT as not_found warning', () => {
  const result = detectError('Read', { file_path: '/foo' }, 'ENOENT: no such file or directory');
  assert.equal(result?.type, 'not_found');
  assert.equal(result?.severity, 'warning');
});

test('detectError detects CONFLICT as git_conflict', () => {
  const result = detectError('Bash', {}, 'CONFLICT (content): Merge conflict in src/app.js');
  assert.equal(result?.type, 'git_conflict');
});

test('detectError detects AssertionError as test_failure', () => {
  const result = detectError('Bash', {}, 'AssertionError [ERR_ASSERTION]: Expected 1 to equal 2');
  assert.equal(result?.type, 'test_failure');
});

test('detectError truncates long messages to 150 chars', () => {
  const long = 'SyntaxError: ' + 'x'.repeat(300);
  const result = detectError('Bash', {}, long);
  assert.ok(result?.message.length <= 153); // 150 + '...'
});

// ---------------------------------------------------------------------------
// extractSlugFromPath
// ---------------------------------------------------------------------------

test('extractSlugFromPath strips date prefix', () => {
  assert.equal(extractSlugFromPath('docs/journal/2024-03-01-my-feature.md'), 'my-feature');
});

test('extractSlugFromPath strips session prefix', () => {
  assert.equal(extractSlugFromPath('docs/journal/2024-03-01-session-0-my-feature.md'), 'my-feature');
});

test('extractSlugFromPath strips doc-type suffix', () => {
  assert.equal(extractSlugFromPath('docs/plans/2024-03-01-auth-plan.md'), 'auth');
  assert.equal(extractSlugFromPath('docs/plans/2024-03-01-auth-design.md'), 'auth');
  assert.equal(extractSlugFromPath('docs/plans/2024-03-01-auth-roadmap.md'), 'auth');
});

test('extractSlugFromPath returns non-empty string for bare filename', () => {
  const result = extractSlugFromPath('docs/something.md');
  assert.ok(typeof result === 'string' && result.length > 0);
});

// ---------------------------------------------------------------------------
// extractFilePaths
// ---------------------------------------------------------------------------

test('extractFilePaths extracts backtick paths from prose', () => {
  const md = 'Edit `src/components/App.jsx` to add the button.';
  const paths = extractFilePaths(md);
  assert.ok(paths.includes('src/components/App.jsx'));
});

test('extractFilePaths extracts (new) marker paths', () => {
  const md = '- `server/session-routes.js` (new)\n- `server/vision-utils.js` (existing)';
  const paths = extractFilePaths(md);
  assert.ok(paths.includes('server/session-routes.js'));
  assert.ok(paths.includes('server/vision-utils.js'));
});

test('extractFilePaths skips node_modules paths', () => {
  const md = 'See `node_modules/express/lib/router.js` for reference.';
  const paths = extractFilePaths(md);
  assert.equal(paths.length, 0);
});

test('extractFilePaths skips paths inside code fences', () => {
  const md = '```\n`src/app.js`\n```';
  const paths = extractFilePaths(md);
  assert.equal(paths.length, 0);
});

test('extractFilePaths deduplicates', () => {
  const md = 'Edit `src/app.js` and also `src/app.js` again.';
  const paths = extractFilePaths(md);
  assert.equal(paths.filter(p => p === 'src/app.js').length, 1);
});

// ---------------------------------------------------------------------------
// updateBlock + closeCurrentBlock
// ---------------------------------------------------------------------------

test('updateBlock creates first block', () => {
  const session = makeSession();
  updateBlock(session, ['TASK-1'], '2024-01-01T00:00:00.000Z', 'writing');
  assert.ok(session.currentBlock);
  assert.equal(session.currentBlock.toolCount, 1);
  assert.ok(session.currentBlock.itemIds.has('TASK-1'));
});

test('updateBlock increments toolCount for same item set', () => {
  const session = makeSession();
  const now = '2024-01-01T00:00:00.000Z';
  updateBlock(session, ['TASK-1'], now, 'writing');
  updateBlock(session, ['TASK-1'], now, 'reading');
  assert.equal(session.currentBlock.toolCount, 2);
  assert.ok(session.currentBlock.categories.has('reading'));
});

test('updateBlock starts new block when item set changes', () => {
  const session = makeSession();
  const now = '2024-01-01T00:00:00.000Z';
  updateBlock(session, ['TASK-1'], now, 'writing');
  updateBlock(session, ['TASK-2'], now, 'reading');
  assert.equal(session.blocks.length, 1, 'first block should be closed');
  assert.ok(session.currentBlock.itemIds.has('TASK-2'));
});

test('closeCurrentBlock pushes block to session.blocks', () => {
  const session = makeSession();
  updateBlock(session, ['TASK-1'], '2024-01-01T00:00:00.000Z', 'writing');
  closeCurrentBlock(session);
  assert.equal(session.blocks.length, 1);
  assert.equal(session.currentBlock, null);
  assert.ok(Array.isArray(session.blocks[0].itemIds));
  assert.ok(typeof session.blocks[0].intent === 'string');
});

test('closeCurrentBlock is no-op when no current block', () => {
  const session = makeSession();
  assert.doesNotThrow(() => closeCurrentBlock(session));
  assert.equal(session.blocks.length, 0);
});

// ---------------------------------------------------------------------------
// classifyBlockIntent
// ---------------------------------------------------------------------------

test('classifyBlockIntent: writing only → building', () => {
  assert.equal(classifyBlockIntent({ categories: new Set(['writing']) }), 'building');
});

test('classifyBlockIntent: writing + executing → debugging', () => {
  assert.equal(classifyBlockIntent({ categories: new Set(['writing', 'executing']) }), 'debugging');
});

test('classifyBlockIntent: executing only → testing', () => {
  assert.equal(classifyBlockIntent({ categories: new Set(['executing']) }), 'testing');
});

test('classifyBlockIntent: reading only → exploring', () => {
  assert.equal(classifyBlockIntent({ categories: new Set(['reading']) }), 'exploring');
});

test('classifyBlockIntent: searching only → exploring', () => {
  assert.equal(classifyBlockIntent({ categories: new Set(['searching']) }), 'exploring');
});

test('classifyBlockIntent: empty → thinking', () => {
  assert.equal(classifyBlockIntent({ categories: new Set() }), 'thinking');
});

test('classifyBlockIntent: fetching (no write/exec) → mixed', () => {
  assert.equal(classifyBlockIntent({ categories: new Set(['fetching']) }), 'mixed');
});
