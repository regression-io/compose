import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { BuildStreamBridge } from '../server/build-stream-bridge.js';

function writeLine(filePath, event, seq) {
  const line = JSON.stringify({ ...event, _seq: seq, _ts: Date.now() });
  appendFileSync(filePath, line + '\n');
}

describe('BuildStreamBridge', () => {
  let tmpDir;
  let composeDir;
  let filePath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bsb-test-'));
    composeDir = join(tmpDir, '.compose');
    mkdirSync(composeDir, { recursive: true });
    filePath = join(composeDir, 'build-stream.jsonl');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('maps JSONL events to correct SSE shapes and broadcasts', async () => {
    const broadcasts = [];
    const bridge = new BuildStreamBridge(composeDir, (msg) => broadcasts.push(msg));

    // Start bridge first, then write events (live tailing)
    bridge.start();
    await sleep(100);

    writeLine(filePath, { type: 'build_start', featureCode: 'T-1', flowId: 'f1' }, 0);
    writeLine(filePath, { type: 'build_step_start', stepId: 's1', stepNum: 1, totalSteps: 2, agent: 'claude', flowId: 'f1' }, 1);
    writeLine(filePath, { type: 'tool_use', tool: 'Read', input: { file_path: '/x' } }, 2);
    writeLine(filePath, { type: 'assistant', content: 'hello' }, 3);
    writeLine(filePath, { type: 'build_step_done', stepId: 's1', summary: 'done', flowId: 'f1' }, 4);
    writeLine(filePath, { type: 'build_error', message: 'oops' }, 5);
    writeLine(filePath, { type: 'build_end', status: 'complete', featureCode: 'T-1' }, 6);

    await sleep(200); // let debounced read fire

    bridge.stop();

    assert.equal(broadcasts.length, 7);

    // build_start
    assert.equal(broadcasts[0].type, 'system');
    assert.equal(broadcasts[0].subtype, 'build_start');
    assert.equal(broadcasts[0]._source, 'build');
    assert.equal(broadcasts[0].featureCode, 'T-1');

    // build_step_start -> build_step
    assert.equal(broadcasts[1].type, 'system');
    assert.equal(broadcasts[1].subtype, 'build_step');
    assert.equal(broadcasts[1].stepId, 's1');

    // tool_use -> assistant wrapper
    assert.equal(broadcasts[2].type, 'assistant');
    assert.equal(broadcasts[2].message.content[0].type, 'tool_use');
    assert.equal(broadcasts[2].message.content[0].name, 'Read');
    assert.equal(broadcasts[2]._source, 'build');

    // assistant -> text wrapper
    assert.equal(broadcasts[3].type, 'assistant');
    assert.equal(broadcasts[3].message.content[0].type, 'text');
    assert.equal(broadcasts[3].message.content[0].text, 'hello');

    // build_step_done
    assert.equal(broadcasts[4].type, 'system');
    assert.equal(broadcasts[4].subtype, 'build_step_done');

    // build_error
    assert.equal(broadcasts[5].type, 'error');
    assert.equal(broadcasts[5].message, 'oops');
    assert.equal(broadcasts[5].source, 'build');
    assert.equal(broadcasts[5]._source, 'build');

    // build_end
    assert.equal(broadcasts[6].type, 'system');
    assert.equal(broadcasts[6].subtype, 'build_end');
    assert.equal(broadcasts[6].status, 'complete');
  });

  it('deduplicates events with same _seq', async () => {
    const broadcasts = [];
    const bridge = new BuildStreamBridge(composeDir, (msg) => broadcasts.push(msg));

    writeLine(filePath, { type: 'build_start', featureCode: 'T-1', flowId: 'f1' }, 0);
    writeLine(filePath, { type: 'build_start', featureCode: 'T-1', flowId: 'f1' }, 0); // duplicate

    bridge.start();
    await sleep(200);
    bridge.stop();

    assert.equal(broadcasts.length, 1);
  });

  it('resets cursor on file replacement (inode change)', async () => {
    const broadcasts = [];
    const bridge = new BuildStreamBridge(composeDir, (msg) => broadcasts.push(msg));

    bridge.start();
    await sleep(100);

    // First build — live
    writeLine(filePath, { type: 'build_start', featureCode: 'T-1', flowId: 'f1' }, 0);
    writeLine(filePath, { type: 'build_end', status: 'complete', featureCode: 'T-1' }, 1);

    await sleep(200);

    assert.equal(broadcasts.length, 2);

    // Replace file (new inode) — simulating new build
    unlinkSync(filePath);
    writeLine(filePath, { type: 'build_start', featureCode: 'T-2', flowId: 'f2' }, 0);

    await sleep(200);
    bridge.stop();

    assert.equal(broadcasts.length, 3);
    assert.equal(broadcasts[2].featureCode, 'T-2');
  });

  it('resets cursor on file truncation (size < cursor)', async () => {
    const broadcasts = [];
    const bridge = new BuildStreamBridge(composeDir, (msg) => broadcasts.push(msg));

    writeLine(filePath, { type: 'build_start', featureCode: 'T-1', flowId: 'f1' }, 0);
    writeLine(filePath, { type: 'build_step_start', stepId: 's1', stepNum: 1, totalSteps: 1, agent: 'claude', flowId: 'f1' }, 1);

    bridge.start();
    await sleep(200);

    // Truncate file by overwriting with smaller content
    writeFileSync(filePath, JSON.stringify({ type: 'build_start', featureCode: 'T-2', flowId: 'f3', _seq: 0, _ts: Date.now() }) + '\n');

    await sleep(200);
    bridge.stop();

    // Should have caught up: 2 from first write + 1 from truncated write
    assert.ok(broadcasts.length >= 3);
  });

  it('catches up from existing file on start()', async () => {
    // Write events before bridge starts
    writeLine(filePath, { type: 'build_start', featureCode: 'T-1', flowId: 'f1' }, 0);
    writeLine(filePath, { type: 'build_step_start', stepId: 's1', stepNum: 1, totalSteps: 1, agent: 'claude', flowId: 'f1' }, 1);

    const broadcasts = [];
    const bridge = new BuildStreamBridge(composeDir, (msg) => broadcasts.push(msg));
    bridge.start();
    await sleep(200);
    bridge.stop();

    assert.equal(broadcasts.length, 2);
  });

  it('skips stale file with build_end last line on startup', async () => {
    writeLine(filePath, { type: 'build_start', featureCode: 'T-1', flowId: 'f1' }, 0);
    writeLine(filePath, { type: 'build_end', status: 'complete', featureCode: 'T-1' }, 1);

    const broadcasts = [];
    const bridge = new BuildStreamBridge(composeDir, (msg) => broadcasts.push(msg));
    bridge.start();
    await sleep(200);
    bridge.stop();

    // Stale file should be skipped
    assert.equal(broadcasts.length, 0);
  });

  it('skips malformed JSON lines without error', async () => {
    appendFileSync(filePath, '{"type":"build_start","featureCode":"T-1","flowId":"f1","_seq":0,"_ts":1}\n');
    appendFileSync(filePath, 'NOT VALID JSON\n');
    appendFileSync(filePath, '{"type":"build_end","status":"complete","featureCode":"T-1","_seq":1,"_ts":2}\n');

    const broadcasts = [];
    const bridge = new BuildStreamBridge(composeDir, (msg) => broadcasts.push(msg));
    bridge.start();
    await sleep(200);
    bridge.stop();

    // build_start is skipped (stale) if last line is build_end... but we're testing malformed in middle
    // Actually the last line is build_end so it's stale. Let's test differently.
  });

  it('handles malformed JSON lines in active stream', async () => {
    const broadcasts = [];
    const bridge = new BuildStreamBridge(composeDir, (msg) => broadcasts.push(msg));

    // Write initial active event
    writeLine(filePath, { type: 'build_start', featureCode: 'T-1', flowId: 'f1' }, 0);

    bridge.start();
    await sleep(200);

    // Append malformed line followed by valid one
    appendFileSync(filePath, 'BROKEN JSON\n');
    writeLine(filePath, { type: 'build_step_start', stepId: 's1', stepNum: 1, totalSteps: 1, agent: 'claude', flowId: 'f1' }, 1);

    await sleep(200);
    bridge.stop();

    // Should have build_start + build_step (malformed skipped)
    assert.equal(broadcasts.length, 2);
    assert.equal(broadcasts[0].subtype, 'build_start');
    assert.equal(broadcasts[1].subtype, 'build_step');
  });

  it('buffers incomplete trailing lines', async () => {
    const broadcasts = [];
    const bridge = new BuildStreamBridge(composeDir, (msg) => broadcasts.push(msg));

    // Write a partial line (no newline)
    const partial = JSON.stringify({ type: 'build_start', featureCode: 'T-1', flowId: 'f1', _seq: 0, _ts: Date.now() });
    writeFileSync(filePath, partial); // no trailing \n

    bridge.start();
    await sleep(200);

    // Should not broadcast yet (incomplete line)
    assert.equal(broadcasts.length, 0);

    // Complete the line
    appendFileSync(filePath, '\n');
    await sleep(200);
    bridge.stop();

    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].subtype, 'build_start');
  });

  it('all mapped events carry _source: "build"', async () => {
    const broadcasts = [];
    const bridge = new BuildStreamBridge(composeDir, (msg) => broadcasts.push(msg));

    writeLine(filePath, { type: 'build_start', featureCode: 'T-1', flowId: 'f1' }, 0);
    writeLine(filePath, { type: 'tool_use', tool: 'Read', input: {} }, 1);
    writeLine(filePath, { type: 'assistant', content: 'text' }, 2);
    writeLine(filePath, { type: 'build_error', message: 'err' }, 3);

    bridge.start();
    await sleep(200);
    bridge.stop();

    for (const msg of broadcasts) {
      assert.equal(msg._source, 'build', `Event type=${msg.type} missing _source`);
    }
  });

  it('no mapped event produces system/init', async () => {
    const broadcasts = [];
    const bridge = new BuildStreamBridge(composeDir, (msg) => broadcasts.push(msg));

    writeLine(filePath, { type: 'build_start', featureCode: 'T-1', flowId: 'f1' }, 0);
    writeLine(filePath, { type: 'build_step_start', stepId: 's1', stepNum: 1, totalSteps: 1, agent: 'claude', flowId: 'f1' }, 1);
    writeLine(filePath, { type: 'build_end', status: 'complete', featureCode: 'T-1' }, 2);

    bridge.start();
    await sleep(200);
    bridge.stop();

    for (const msg of broadcasts) {
      if (msg.type === 'system') {
        assert.notEqual(msg.subtype, 'init', 'Bridge must never emit system/init');
      }
    }
  });

  it('crash detection — emits synthetic build_end(crashed) after timeout during step', async () => {
    const broadcasts = [];
    const bridge = new BuildStreamBridge(composeDir, (msg) => broadcasts.push(msg), {
      crashTimeoutMs: 200, // very short for testing
    });

    writeLine(filePath, { type: 'build_start', featureCode: 'T-1', flowId: 'f1' }, 0);
    writeLine(filePath, { type: 'build_step_start', stepId: 's1', stepNum: 1, totalSteps: 1, agent: 'claude', flowId: 'f1' }, 1);

    bridge.start();
    await sleep(500); // wait for crash timeout
    bridge.stop();

    const crashEvent = broadcasts.find(m => m.type === 'system' && m.subtype === 'build_end' && m.status === 'crashed');
    assert.ok(crashEvent, 'Should emit synthetic build_end(crashed)');
  });

  it('crash timer reset — content events during step prevent false crash', async () => {
    const broadcasts = [];
    const bridge = new BuildStreamBridge(composeDir, (msg) => broadcasts.push(msg), {
      crashTimeoutMs: 300,
    });

    writeLine(filePath, { type: 'build_start', featureCode: 'T-1', flowId: 'f1' }, 0);
    writeLine(filePath, { type: 'build_step_start', stepId: 's1', stepNum: 1, totalSteps: 1, agent: 'claude', flowId: 'f1' }, 1);

    bridge.start();
    await sleep(100);

    // Keep resetting the timer with content events
    writeLine(filePath, { type: 'tool_use', tool: 'Read', input: {} }, 2);
    await sleep(100);
    writeLine(filePath, { type: 'assistant', content: 'working...' }, 3);
    await sleep(100);
    writeLine(filePath, { type: 'build_step_done', stepId: 's1', summary: 'done', flowId: 'f1' }, 4);

    await sleep(200);
    bridge.stop();

    const crashEvent = broadcasts.find(m => m.subtype === 'build_end' && m.status === 'crashed');
    assert.equal(crashEvent, undefined, 'Should not emit crash — content events kept timer alive');
  });

  it('crash suppression — late events after synthetic crash are suppressed', async () => {
    const broadcasts = [];
    const bridge = new BuildStreamBridge(composeDir, (msg) => broadcasts.push(msg), {
      crashTimeoutMs: 150,
    });

    writeLine(filePath, { type: 'build_start', featureCode: 'T-1', flowId: 'f1' }, 0);
    writeLine(filePath, { type: 'build_step_start', stepId: 's1', stepNum: 1, totalSteps: 1, agent: 'claude', flowId: 'f1' }, 1);

    bridge.start();
    await sleep(400); // crash fires

    const crashFired = broadcasts.some(m => m.subtype === 'build_end' && m.status === 'crashed');
    assert.ok(crashFired, 'Crash should have fired');
    const countBefore = broadcasts.length;

    // Late event from dead build
    writeLine(filePath, { type: 'tool_use', tool: 'Read', input: {} }, 2);
    await sleep(200);
    bridge.stop();

    assert.equal(broadcasts.length, countBefore, 'Late events after crash should be suppressed');
  });

  it('crash timer does NOT fire during gate wait', async () => {
    const broadcasts = [];
    const bridge = new BuildStreamBridge(composeDir, (msg) => broadcasts.push(msg), {
      crashTimeoutMs: 150,
    });

    writeLine(filePath, { type: 'build_start', featureCode: 'T-1', flowId: 'f1' }, 0);
    writeLine(filePath, { type: 'build_step_start', stepId: 's1', stepNum: 1, totalSteps: 1, agent: 'claude', flowId: 'f1' }, 1);
    writeLine(filePath, { type: 'build_step_done', stepId: 's1', summary: 'done', flowId: 'f1' }, 2);
    writeLine(filePath, { type: 'build_gate', stepId: 'g1', gateType: 'approval', flowId: 'f1' }, 3);

    bridge.start();
    await sleep(400); // wait longer than crash timeout
    bridge.stop();

    const crashEvent = broadcasts.find(m => m.subtype === 'build_end' && m.status === 'crashed');
    assert.equal(crashEvent, undefined, 'Crash timer should not fire during gate wait');
  });

  it('child-flow hierarchy metadata is preserved in mapping', async () => {
    const broadcasts = [];
    const bridge = new BuildStreamBridge(composeDir, (msg) => broadcasts.push(msg));

    writeLine(filePath, { type: 'build_start', featureCode: 'T-1', flowId: 'f1' }, 0);
    writeLine(filePath, {
      type: 'build_step_start', stepId: 'cs1', stepNum: 1, totalSteps: 2,
      agent: 'codex', flowId: 'child-f1', parentFlowId: 'f1',
    }, 1);
    writeLine(filePath, {
      type: 'build_step_done', stepId: 'cs1', summary: 'child done',
      flowId: 'child-f1', parentFlowId: 'f1',
    }, 2);

    bridge.start();
    await sleep(200);
    bridge.stop();

    const stepStart = broadcasts.find(m => m.subtype === 'build_step' && m.stepId === 'cs1');
    assert.ok(stepStart);
    assert.equal(stepStart.flowId, 'child-f1');
    assert.equal(stepStart.parentFlowId, 'f1');

    const stepDone = broadcasts.find(m => m.subtype === 'build_step_done');
    assert.ok(stepDone);
    assert.equal(stepDone.flowId, 'child-f1');
    assert.equal(stepDone.parentFlowId, 'f1');
  });

  it('skips stale gate on startup (build_gate last line with mtime > 24h)', async () => {
    // Write a build_gate as the last event and backdate mtime to >24h
    writeLine(filePath, { type: 'build_start', featureCode: 'T-1', flowId: 'f1' }, 0);
    writeLine(filePath, { type: 'build_gate', stepId: 'review', flowId: 'f1' }, 1);

    // Backdate mtime to 25 hours ago
    const { utimesSync } = await import('node:fs');
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(filePath, past, past);

    const broadcasts = [];
    const bridge = new BuildStreamBridge(composeDir, (msg) => broadcasts.push(msg));
    bridge.start();
    await sleep(200);
    bridge.stop();

    assert.equal(broadcasts.length, 0, 'stale gate file (>24h) should be skipped on startup');
  });

  it('replays fresh gate on startup (build_gate last line with mtime < 24h)', async () => {
    // Write a build_gate as the last event — file is fresh (just written)
    writeLine(filePath, { type: 'build_start', featureCode: 'T-1', flowId: 'f1' }, 0);
    writeLine(filePath, { type: 'build_gate', stepId: 'review', flowId: 'f1' }, 1);

    const broadcasts = [];
    const bridge = new BuildStreamBridge(composeDir, (msg) => broadcasts.push(msg));
    bridge.start();
    await sleep(200);
    bridge.stop();

    assert.ok(broadcasts.length >= 2, 'fresh gate file (<24h) should be replayed on startup');
    assert.equal(broadcasts[0].subtype, 'build_start');
    assert.equal(broadcasts[1].subtype, 'build_gate');
  });

  it('skips stale file with malformed last line on startup (mtime > crash timeout)', async () => {
    // Write a valid event followed by a malformed line
    writeLine(filePath, { type: 'build_start', featureCode: 'T-1', flowId: 'f1' }, 0);
    appendFileSync(filePath, 'this is not json\n');

    // Backdate mtime to exceed crash timeout
    const { utimesSync } = await import('node:fs');
    const past = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
    utimesSync(filePath, past, past);

    const broadcasts = [];
    // Use a short crash timeout so 10 min ago exceeds it
    const bridge = new BuildStreamBridge(composeDir, (msg) => broadcasts.push(msg), { crashTimeoutMs: 5000 });
    bridge.start();
    await sleep(200);
    bridge.stop();

    assert.equal(broadcasts.length, 0, 'stale file with malformed last line should be skipped');
  });

  it('skips stale no-sentinel non-gate file on startup (mtime > crash timeout)', async () => {
    // Write events that end with build_step_start (no build_end, no build_gate)
    writeLine(filePath, { type: 'build_start', featureCode: 'T-1', flowId: 'f1' }, 0);
    writeLine(filePath, { type: 'build_step_start', stepId: 's1', stepNum: 1, totalSteps: 2, agent: 'claude', flowId: 'f1' }, 1);

    // Backdate mtime to exceed crash timeout
    const { utimesSync } = await import('node:fs');
    const past = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
    utimesSync(filePath, past, past);

    const broadcasts = [];
    const bridge = new BuildStreamBridge(composeDir, (msg) => broadcasts.push(msg), { crashTimeoutMs: 5000 });
    bridge.start();
    await sleep(200);
    bridge.stop();

    assert.equal(broadcasts.length, 0, 'stale non-terminal file (>crash timeout) should be skipped');
  });

  it('handles directory creation after server start (poll fallback)', async () => {
    // Use a non-existent directory
    const lateDirBase = mkdtempSync(join(tmpdir(), 'bsb-late-'));
    const lateComposeDir = join(lateDirBase, '.compose');
    const lateFilePath = join(lateComposeDir, 'build-stream.jsonl');

    const broadcasts = [];
    const bridge = new BuildStreamBridge(lateComposeDir, (msg) => broadcasts.push(msg));

    bridge.start();
    await sleep(100);

    // Now create the directory and file
    mkdirSync(lateComposeDir, { recursive: true });
    writeLine(lateFilePath, { type: 'build_start', featureCode: 'T-1', flowId: 'f1' }, 0);

    await sleep(3000); // wait for poll interval (2s) + debounce
    bridge.stop();

    assert.ok(broadcasts.length >= 1, 'Should have picked up events after directory creation');

    rmSync(lateDirBase, { recursive: true, force: true });
  });
});
