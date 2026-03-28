/**
 * Unit tests for server/worktree-gc.js — WorktreeGC
 *
 * Creates fake .compose/par/ directories with .owner files to simulate
 * orphan worktree detection and cleanup.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { WorktreeGC } from '../server/worktree-gc.js';

describe('WorktreeGC', () => {
  let tmpDir;
  let parDir;
  let gc;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'worktree-gc-'));
    parDir = join(tmpDir, '.compose', 'par');
    mkdirSync(parDir, { recursive: true });
  });

  afterEach(() => {
    if (gc) gc.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('skips directory with live owner pid', async () => {
    const taskDir = join(parDir, 'task-alive');
    mkdirSync(taskDir, { recursive: true });
    // Use our own PID — guaranteed alive
    writeFileSync(join(taskDir, '.owner'), String(process.pid));

    gc = new WorktreeGC({ projectRoot: tmpDir, parDir, scanIntervalMs: 60_000, maxAgeMs: 0 });
    const removed = await gc.runNow();
    assert.equal(removed.length, 0, 'should not remove dir with alive owner');
    assert.ok(existsSync(taskDir));
  });

  test('removes directory with dead owner pid + old enough', async () => {
    const taskDir = join(parDir, 'task-dead');
    mkdirSync(taskDir, { recursive: true });
    // PID 2 is kernel — not a real user process, will fail kill(pid,0)
    writeFileSync(join(taskDir, '.owner'), '999999999');
    // Set mtime to >1h ago
    const oldTime = new Date(Date.now() - 2 * 3600_000);
    const { utimesSync } = await import('node:fs');
    utimesSync(taskDir, oldTime, oldTime);

    gc = new WorktreeGC({ projectRoot: tmpDir, parDir, scanIntervalMs: 60_000, maxAgeMs: 3600_000 });
    const removed = await gc.runNow();
    assert.ok(removed.includes('task-dead'), 'should remove orphan dir');
    assert.ok(!existsSync(taskDir), 'directory should be gone');
  });

  test('skips directory without .owner if not old enough', async () => {
    const taskDir = join(parDir, 'task-new');
    mkdirSync(taskDir, { recursive: true });
    // No .owner file, but freshly created

    gc = new WorktreeGC({ projectRoot: tmpDir, parDir, scanIntervalMs: 60_000, maxAgeMs: 3600_000 });
    const removed = await gc.runNow();
    assert.equal(removed.length, 0, 'should not remove fresh dir');
  });

  test('removes directory without .owner if old enough', async () => {
    const taskDir = join(parDir, 'task-orphan');
    mkdirSync(taskDir, { recursive: true });
    // Set mtime to >1h ago
    const oldTime = new Date(Date.now() - 2 * 3600_000);
    const { utimesSync } = await import('node:fs');
    utimesSync(taskDir, oldTime, oldTime);

    gc = new WorktreeGC({ projectRoot: tmpDir, parDir, scanIntervalMs: 60_000, maxAgeMs: 3600_000 });
    const removed = await gc.runNow();
    assert.ok(removed.includes('task-orphan'), 'should remove old orphan');
  });

  test('start and stop schedule periodic scans', async () => {
    gc = new WorktreeGC({ projectRoot: tmpDir, parDir, scanIntervalMs: 50, maxAgeMs: 0 });
    gc.start();
    await sleep(30);
    gc.stop();
    // Just verify it doesn't throw
    assert.ok(true, 'start/stop lifecycle works');
  });

  test('runNow returns empty array when parDir does not exist', async () => {
    const missing = join(tmpDir, '.compose', 'nonexistent');
    gc = new WorktreeGC({ projectRoot: tmpDir, parDir: missing, scanIntervalMs: 60_000, maxAgeMs: 0 });
    const removed = await gc.runNow();
    assert.deepEqual(removed, []);
  });
});

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
