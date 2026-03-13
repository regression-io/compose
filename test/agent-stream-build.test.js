import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deriveStatus, mergeSourceStatus, CATEGORY_LABELS } from '../src/components/agent-stream-helpers.js';

describe('deriveStatus — build events', () => {
  it('returns working/thinking for build_step', () => {
    const result = deriveStatus({ type: 'system', subtype: 'build_step', _source: 'build' });
    assert.deepEqual(result, { status: 'working', tool: null, category: 'thinking', _source: 'build' });
  });

  it('returns working/thinking for build_step_done', () => {
    const result = deriveStatus({ type: 'system', subtype: 'build_step_done', _source: 'build' });
    assert.deepEqual(result, { status: 'working', tool: null, category: 'thinking', _source: 'build' });
  });

  it('returns working/waiting for build_gate', () => {
    const result = deriveStatus({ type: 'system', subtype: 'build_gate', _source: 'build' });
    assert.deepEqual(result, { status: 'working', tool: null, category: 'waiting', _source: 'build' });
  });

  it('returns working/thinking for build_gate_resolved', () => {
    const result = deriveStatus({ type: 'system', subtype: 'build_gate_resolved', _source: 'build' });
    assert.deepEqual(result, { status: 'working', tool: null, category: 'thinking', _source: 'build' });
  });

  it('returns idle for build_end', () => {
    const result = deriveStatus({ type: 'system', subtype: 'build_end', _source: 'build' });
    assert.deepEqual(result, { status: 'idle', tool: null, category: null, _source: 'build' });
  });

  it('returns working/thinking for build_error', () => {
    const result = deriveStatus({ type: 'error', source: 'build', message: 'fail', _source: 'build' });
    assert.deepEqual(result, { status: 'working', tool: null, category: 'thinking', _source: 'build' });
  });

  it('returns working with tool for build tool_use events', () => {
    const result = deriveStatus({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read' }] },
      _source: 'build',
    });
    assert.equal(result.status, 'working');
    assert.equal(result.tool, 'Read');
    assert.equal(result.category, 'reading');
    assert.equal(result._source, 'build');
  });

  it('returns working/thinking for build text events', () => {
    const result = deriveStatus({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
      _source: 'build',
    });
    assert.deepEqual(result, { status: 'working', tool: null, category: 'thinking', _source: 'build' });
  });

  it('never returns system/init for any build event type', () => {
    const buildEvents = [
      { type: 'system', subtype: 'build_start', _source: 'build' },
      { type: 'system', subtype: 'build_step', _source: 'build' },
      { type: 'system', subtype: 'build_step_done', _source: 'build' },
      { type: 'system', subtype: 'build_gate', _source: 'build' },
      { type: 'system', subtype: 'build_gate_resolved', _source: 'build' },
      { type: 'system', subtype: 'build_end', _source: 'build' },
      { type: 'error', source: 'build', message: 'x', _source: 'build' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] }, _source: 'build' },
    ];
    for (const evt of buildEvents) {
      const result = deriveStatus(evt);
      if (result) {
        // Must never produce a result that looks like system/init
        assert.notEqual(result.subtype, 'init', `Event ${evt.subtype} should not produce init`);
      }
    }
  });
});

describe('deriveStatus — interactive events', () => {
  it('returns working with tool for interactive tool_use', () => {
    const result = deriveStatus({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash' }] },
    });
    assert.equal(result.status, 'working');
    assert.equal(result.tool, 'Bash');
    assert.equal(result._source, undefined); // no build source
  });

  it('returns idle for result', () => {
    const result = deriveStatus({ type: 'result' });
    assert.deepEqual(result, { status: 'idle', tool: null, category: null });
  });
});

describe('mergeSourceStatus', () => {
  it('build idle does not clear interactive working', () => {
    const merged = mergeSourceStatus({
      build: { status: 'idle', tool: null, category: null },
      interactive: { status: 'working', tool: 'Read', category: 'reading' },
    });
    assert.equal(merged.status, 'working');
    assert.equal(merged.tool, 'Read');
  });

  it('interactive idle does not clear build working', () => {
    const merged = mergeSourceStatus({
      build: { status: 'working', tool: null, category: 'thinking' },
      interactive: { status: 'idle', tool: null, category: null },
    });
    assert.equal(merged.status, 'working');
  });

  it('both idle produces idle', () => {
    const merged = mergeSourceStatus({
      build: { status: 'idle', tool: null, category: null },
      interactive: { status: 'idle', tool: null, category: null },
    });
    assert.equal(merged.status, 'idle');
  });

  it('both null produces idle', () => {
    const merged = mergeSourceStatus({ build: null, interactive: null });
    assert.equal(merged.status, 'idle');
  });

  it('reconnect reset — build null, interactive working = working', () => {
    const merged = mergeSourceStatus({
      build: null,
      interactive: { status: 'working', tool: 'Edit', category: 'writing' },
    });
    assert.equal(merged.status, 'working');
  });

  it('reconnect reset — both null = idle', () => {
    const merged = mergeSourceStatus({ build: null, interactive: null });
    assert.equal(merged.status, 'idle');
  });

  it('concurrent build + interactive — build events do not disrupt interactive working', () => {
    // Interactive is working, build changes to working too — interactive still takes priority
    const merged = mergeSourceStatus({
      build: { status: 'working', tool: null, category: 'thinking' },
      interactive: { status: 'working', tool: 'Bash', category: 'executing' },
    });
    assert.equal(merged.status, 'working');
    assert.equal(merged.tool, 'Bash'); // interactive takes priority
    assert.equal(merged.category, 'executing');
  });
});

describe('CATEGORY_LABELS', () => {
  it('includes waiting label', () => {
    assert.equal(CATEGORY_LABELS.waiting, 'Waiting for gate approval');
  });
});
