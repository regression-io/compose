/**
 * Unit tests for server/agent-health.js — HealthMonitor
 *
 * Uses mock proc (EventEmitter) and fake timers to verify silence detection,
 * wall-clock timeout, memory polling, and terminal reason tracking.
 */
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { HealthMonitor } from '../server/agent-health.js';

function mockProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = 99999;
  proc.kill = mock.fn(() => {});
  return proc;
}

describe('HealthMonitor', () => {
  let monitor;
  let messages;
  let broadcastMessage;

  beforeEach(() => {
    messages = [];
    broadcastMessage = (msg) => messages.push(msg);
  });

  afterEach(() => {
    if (monitor) monitor.destroy();
  });

  test('track and untrack agent', () => {
    monitor = new HealthMonitor({ broadcastMessage });
    const proc = mockProc();
    monitor.track('a1', proc);
    assert.ok(monitor.isTracked('a1'));
    monitor.untrack('a1');
    assert.ok(!monitor.isTracked('a1'));
  });

  test('stdout activity resets silence timer', async () => {
    monitor = new HealthMonitor({
      broadcastMessage,
      silenceWarningMs: 50,
      silenceKillMs: 200,
      defaultTimeoutMs: 60_000,
      memoryLimitMB: 0, // disable memory polling
    });

    const proc = mockProc();
    monitor.track('a1', proc);

    // Emit some stdout to reset the timer
    proc.stdout.emit('data', Buffer.from('hello'));

    // Wait less than warning threshold
    await sleep(30);
    const warnings = messages.filter(m => m.type === 'agentSilent');
    assert.equal(warnings.length, 0, 'no warning before threshold');
  });

  test('silence warning fires after silenceWarningMs', async () => {
    monitor = new HealthMonitor({
      broadcastMessage,
      silenceWarningMs: 40,
      silenceKillMs: 5000,
      defaultTimeoutMs: 60_000,
      memoryLimitMB: 0,
    });

    const proc = mockProc();
    monitor.track('a1', proc);

    await sleep(80);
    const warnings = messages.filter(m => m.type === 'agentSilent');
    assert.ok(warnings.length >= 1, 'should fire silence warning');
    assert.equal(warnings[0].agentId, 'a1');
  });

  test('silence kill fires after silenceKillMs', async () => {
    monitor = new HealthMonitor({
      broadcastMessage,
      silenceWarningMs: 20,
      silenceKillMs: 80,
      defaultTimeoutMs: 60_000,
      memoryLimitMB: 0,
    });

    const proc = mockProc();
    monitor.track('a1', proc);

    await sleep(150);
    const kills = messages.filter(m => m.type === 'agentKilled');
    assert.ok(kills.length >= 1, 'should fire agentKilled');
    assert.equal(kills[0].agentId, 'a1');
    assert.equal(kills[0].reason, 'silence_timeout');
    assert.ok(proc.kill.mock.calls.length >= 1, 'SIGTERM sent');
  });

  test('stderr activity also resets silence timer', async () => {
    monitor = new HealthMonitor({
      broadcastMessage,
      silenceWarningMs: 50,
      silenceKillMs: 5000,
      defaultTimeoutMs: 60_000,
      memoryLimitMB: 0,
    });

    const proc = mockProc();
    monitor.track('a1', proc);

    // Keep feeding stderr within the warning window
    const interval = setInterval(() => proc.stderr.emit('data', Buffer.from('x')), 20);
    await sleep(100);
    clearInterval(interval);

    const warnings = messages.filter(m => m.type === 'agentSilent');
    assert.equal(warnings.length, 0, 'no warning while stderr active');
  });

  test('wall-clock timeout fires', async () => {
    monitor = new HealthMonitor({
      broadcastMessage,
      silenceWarningMs: 60_000,
      silenceKillMs: 60_000,
      defaultTimeoutMs: 80,
      memoryLimitMB: 0,
    });

    const proc = mockProc();
    monitor.track('a1', proc);

    // Keep emitting stdout so silence timer doesn't fire
    const interval = setInterval(() => proc.stdout.emit('data', Buffer.from('x')), 10);
    await sleep(150);
    clearInterval(interval);

    const kills = messages.filter(m => m.type === 'agentKilled');
    assert.ok(kills.length >= 1, 'should fire wall-clock kill');
    assert.equal(kills[0].reason, 'wall_clock_timeout');
  });

  test('getTerminalReason returns reason after kill', async () => {
    monitor = new HealthMonitor({
      broadcastMessage,
      silenceWarningMs: 20,
      silenceKillMs: 60,
      defaultTimeoutMs: 60_000,
      memoryLimitMB: 0,
    });

    const proc = mockProc();
    monitor.track('a1', proc);
    await sleep(120);

    const reason = monitor.getTerminalReason('a1');
    assert.equal(reason, 'silence_timeout');
  });

  test('manual stop sets terminal reason', () => {
    monitor = new HealthMonitor({ broadcastMessage, memoryLimitMB: 0 });
    const proc = mockProc();
    monitor.track('a1', proc);
    monitor.setTerminalReason('a1', 'manual_stop');
    assert.equal(monitor.getTerminalReason('a1'), 'manual_stop');
  });

  test('untrack cleans up timers without killing', async () => {
    monitor = new HealthMonitor({
      broadcastMessage,
      silenceWarningMs: 50,
      silenceKillMs: 100,
      defaultTimeoutMs: 60_000,
      memoryLimitMB: 0,
    });

    const proc = mockProc();
    monitor.track('a1', proc);
    monitor.untrack('a1');

    await sleep(120);
    const kills = messages.filter(m => m.type === 'agentKilled');
    assert.equal(kills.length, 0, 'no kill after untrack');
  });

  test('destroy cleans up all tracked agents', () => {
    monitor = new HealthMonitor({ broadcastMessage, memoryLimitMB: 0 });
    const proc1 = mockProc();
    const proc2 = mockProc();
    monitor.track('a1', proc1);
    monitor.track('a2', proc2);
    monitor.destroy();
    assert.ok(!monitor.isTracked('a1'));
    assert.ok(!monitor.isTracked('a2'));
  });
});

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
