/**
 * Unit tests for server/agent-registry.js
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AgentRegistry } from '../server/agent-registry.js';

describe('AgentRegistry', () => {
  let tmpDir;
  let registry;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-registry-'));
    registry = new AgentRegistry(tmpDir);
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('register creates a running agent record', () => {
    const record = registry.register('agent-1', {
      parentSessionId: 'session-abc',
      agentType: 'compose-explorer',
      prompt: 'Find features similar to auth',
      pid: 12345,
    });
    assert.equal(record.agentId, 'agent-1');
    assert.equal(record.parentSessionId, 'session-abc');
    assert.equal(record.agentType, 'compose-explorer');
    assert.equal(record.status, 'running');
    assert.equal(record.pid, 12345);
    assert.ok(record.startedAt);
    assert.equal(record.completedAt, null);
  });

  test('get retrieves registered agent', () => {
    const record = registry.get('agent-1');
    assert.ok(record);
    assert.equal(record.agentType, 'compose-explorer');
  });

  test('get returns null for unknown agent', () => {
    assert.equal(registry.get('nonexistent'), null);
  });

  test('complete updates status and completedAt', () => {
    const record = registry.complete('agent-1', { status: 'complete', exitCode: 0 });
    assert.equal(record.status, 'complete');
    assert.equal(record.exitCode, 0);
    assert.ok(record.completedAt);
  });

  test('complete returns null for unknown agent', () => {
    assert.equal(registry.complete('nonexistent', { status: 'failed' }), null);
  });

  test('getChildren returns agents for a parent session', () => {
    registry.register('agent-2', { parentSessionId: 'session-abc', agentType: 'compose-architect' });
    registry.register('agent-3', { parentSessionId: 'session-xyz', agentType: 'claude' });

    const children = registry.getChildren('session-abc');
    assert.equal(children.length, 2); // agent-1 + agent-2
    assert.ok(children.every(c => c.parentSessionId === 'session-abc'));
  });

  test('getAll returns all agents', () => {
    const all = registry.getAll();
    assert.equal(all.length, 3); // agent-1, agent-2, agent-3
  });

  test('persists to disk and survives reload', () => {
    const registry2 = new AgentRegistry(tmpDir);
    const record = registry2.get('agent-1');
    assert.ok(record);
    assert.equal(record.agentType, 'compose-explorer');
    assert.equal(record.status, 'complete');
  });

  test('prune keeps only N most recent', () => {
    // Register 5 more agents
    for (let i = 10; i < 15; i++) {
      registry.register(`agent-${i}`, { parentSessionId: 'session-abc', agentType: 'claude' });
    }
    const beforeCount = registry.getAll().length;
    registry.prune(3);
    const afterCount = registry.getAll().length;
    assert.equal(afterCount, 3);
    assert.ok(afterCount < beforeCount);
  });

  test('prompt is truncated to 200 chars', () => {
    const longPrompt = 'x'.repeat(500);
    const record = registry.register('agent-long', { prompt: longPrompt });
    assert.equal(record.prompt.length, 200);
  });

  test('defaults for missing fields', () => {
    const record = registry.register('agent-defaults', {});
    assert.equal(record.parentSessionId, null);
    assert.equal(record.agentType, 'unknown');
    assert.equal(record.pid, null);
    assert.equal(record.prompt, '');
  });
});
