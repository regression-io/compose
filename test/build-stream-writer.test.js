import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { BuildStreamWriter } from '../lib/build-stream-writer.js';

describe('BuildStreamWriter', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bsw-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates build-stream.jsonl in the compose directory', () => {
    const composeDir = join(tmpDir, '.compose');
    const writer = new BuildStreamWriter(composeDir, 'TEST-1');
    writer.write({ type: 'build_start', featureCode: 'TEST-1' });

    assert.ok(existsSync(join(composeDir, 'build-stream.jsonl')));
    assert.equal(writer.filePath, join(composeDir, 'build-stream.jsonl'));
  });

  it('appends JSONL lines with monotonically increasing _seq and valid _ts', () => {
    const composeDir = join(tmpDir, '.compose');
    const writer = new BuildStreamWriter(composeDir, 'TEST-1');

    writer.write({ type: 'build_start' });
    writer.write({ type: 'build_step_start', stepId: 's1' });
    writer.write({ type: 'tool_use', tool: 'Read' });

    const lines = readFileSync(writer.filePath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 3);

    const events = lines.map(l => JSON.parse(l));
    // _seq monotonically increasing
    assert.equal(events[0]._seq, 0);
    assert.equal(events[1]._seq, 1);
    assert.equal(events[2]._seq, 2);

    // _ts is a valid timestamp
    const now = Date.now();
    for (const e of events) {
      assert.ok(typeof e._ts === 'number');
      assert.ok(e._ts <= now);
      assert.ok(e._ts > now - 10000); // within last 10s
    }
  });

  it('truncates existing file on re-construction (fresh start per build)', () => {
    const composeDir = join(tmpDir, '.compose');

    // First build
    const writer1 = new BuildStreamWriter(composeDir, 'TEST-1');
    writer1.write({ type: 'build_start' });
    writer1.write({ type: 'build_step_start' });
    writer1.close();

    const lines1 = readFileSync(writer1.filePath, 'utf-8').trim().split('\n');
    assert.equal(lines1.length, 3); // start + step + end

    // Second build — should truncate
    const writer2 = new BuildStreamWriter(composeDir, 'TEST-2');
    writer2.write({ type: 'build_start' });

    const lines2 = readFileSync(writer2.filePath, 'utf-8').trim().split('\n');
    assert.equal(lines2.length, 1); // only the new start
    assert.equal(JSON.parse(lines2[0])._seq, 0); // seq reset
  });

  it('close() writes a build_end event with correct status and featureCode', () => {
    const composeDir = join(tmpDir, '.compose');
    const writer = new BuildStreamWriter(composeDir, 'TEST-1');
    writer.write({ type: 'build_start' });
    writer.close('killed');

    const lines = readFileSync(writer.filePath, 'utf-8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.type, 'build_end');
    assert.equal(last.status, 'killed');
    assert.equal(last.featureCode, 'TEST-1');
  });

  it('close() defaults status to complete', () => {
    const composeDir = join(tmpDir, '.compose');
    const writer = new BuildStreamWriter(composeDir, 'TEST-1');
    writer.close();

    const lines = readFileSync(writer.filePath, 'utf-8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.status, 'complete');
  });

  it('close() is idempotent — calling twice writes exactly one build_end', () => {
    const composeDir = join(tmpDir, '.compose');
    const writer = new BuildStreamWriter(composeDir, 'TEST-1');
    writer.write({ type: 'build_start' });
    writer.close('complete');
    writer.close('killed'); // second call should be no-op

    const lines = readFileSync(writer.filePath, 'utf-8').trim().split('\n');
    const endEvents = lines.map(l => JSON.parse(l)).filter(e => e.type === 'build_end');
    assert.equal(endEvents.length, 1);
    assert.equal(endEvents[0].status, 'complete'); // first call wins
  });
});
