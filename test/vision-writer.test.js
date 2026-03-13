/**
 * vision-writer.test.js — Tests for VisionWriter dual-dispatch read-modify-write.
 *
 * Covers: feature item creation/lookup (lifecycle.featureCode format), status updates,
 * gate creation/resolution with default round, migration, outcome normalization,
 * gate metadata, gate comments, getGate, port option, and atomic write integrity.
 *
 * All tests run in direct mode (no server) by using a port that is not in use.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VisionWriter, ServerUnreachableError } from '../lib/vision-writer.js';

describe('VisionWriter', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-writer-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Feature item creation (lifecycle.featureCode format)
  // -------------------------------------------------------------------------

  it('creates feature item with lifecycle.featureCode', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'test-'));
    const writer = new VisionWriter(dir, { port: 19990 });

    const id = await writer.ensureFeatureItem('FEAT-1', 'Feature One');

    assert.ok(id, 'should return an id');
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'vision-state.json'), 'utf-8'));
    assert.equal(state.items.length, 1);
    const item = state.items[0];
    assert.equal(item.id, id);
    assert.equal(item.lifecycle.featureCode, 'FEAT-1');
    assert.equal(item.lifecycle.currentPhase, 'explore_design');
    assert.equal(item.type, 'feature');
    assert.equal(item.status, 'planned');
    assert.equal(item.title, 'Feature One');
    // No legacy featureCode field
    assert.equal(item.featureCode, undefined);
  });

  // -------------------------------------------------------------------------
  // Feature item lookup — lifecycle.featureCode
  // -------------------------------------------------------------------------

  it('finds existing item by lifecycle.featureCode', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'test-'));
    const existing = {
      items: [
        { id: 'def-456', type: 'feature', title: 'F3', lifecycle: { featureCode: 'FEAT-3' } },
      ],
      connections: [],
      gates: [],
    };
    fs.writeFileSync(path.join(dir, 'vision-state.json'), JSON.stringify(existing));

    const writer = new VisionWriter(dir, { port: 19990 });
    const found = await writer.findFeatureItem('FEAT-3');

    assert.ok(found);
    assert.equal(found.id, 'def-456');
  });

  // -------------------------------------------------------------------------
  // Deduplication
  // -------------------------------------------------------------------------

  it('does not duplicate when item already exists', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'test-'));
    const existing = {
      items: [
        {
          id: 'ghi-789',
          type: 'feature',
          title: 'F4',
          lifecycle: { featureCode: 'FEAT-4' },
        },
      ],
      connections: [],
      gates: [],
    };
    fs.writeFileSync(path.join(dir, 'vision-state.json'), JSON.stringify(existing));

    const writer = new VisionWriter(dir, { port: 19990 });
    const id = await writer.ensureFeatureItem('FEAT-4');

    assert.equal(id, 'ghi-789');
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'vision-state.json'), 'utf-8'));
    assert.equal(state.items.length, 1, 'should not create a duplicate item');
  });

  // -------------------------------------------------------------------------
  // Status update
  // -------------------------------------------------------------------------

  it('updates item status', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'test-'));
    const writer = new VisionWriter(dir, { port: 19990 });

    const id = await writer.ensureFeatureItem('FEAT-5', 'Feature Five');
    await writer.updateItemStatus(id, 'in_progress');

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'vision-state.json'), 'utf-8'));
    assert.equal(state.items[0].status, 'in_progress');
  });

  // -------------------------------------------------------------------------
  // Gate creation with default round and :1 suffix
  // -------------------------------------------------------------------------

  it('creates gate with default round=1 and :1 suffix', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'test-'));
    const writer = new VisionWriter(dir, { port: 19990 });

    const gateId = await writer.createGate('flow-1', 'step-1', 'item-1');
    assert.equal(gateId, 'flow-1:step-1:1');

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'vision-state.json'), 'utf-8'));
    assert.equal(state.gates.length, 1);
    assert.equal(state.gates[0].status, 'pending');
    assert.equal(state.gates[0].flowId, 'flow-1');
    assert.equal(state.gates[0].itemId, 'item-1');
    assert.equal(state.gates[0].round, 1);
  });

  // -------------------------------------------------------------------------
  // Gate resolution
  // -------------------------------------------------------------------------

  it('resolves gate with status: resolved and normalized outcome', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'test-'));
    const writer = new VisionWriter(dir, { port: 19990 });

    const gateId = await writer.createGate('flow-1', 'step-1', 'item-1');
    await writer.resolveGate(gateId, 'approve');

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'vision-state.json'), 'utf-8'));
    assert.equal(state.gates[0].status, 'resolved');
    assert.equal(state.gates[0].outcome, 'approve');
    assert.ok(state.gates[0].resolvedAt);
  });

  // -------------------------------------------------------------------------
  // Migration: legacy featureCode format
  // -------------------------------------------------------------------------

  it('migrates legacy featureCode: "feature:X" to lifecycle.featureCode on load', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'test-'));
    const legacy = {
      items: [
        { id: 'old-1', type: 'feature', title: 'Old', featureCode: 'feature:FEAT-OLD' },
        { id: 'new-1', type: 'feature', title: 'New', lifecycle: { featureCode: 'FEAT-NEW' } },
      ],
      connections: [],
      gates: [],
    };
    fs.writeFileSync(path.join(dir, 'vision-state.json'), JSON.stringify(legacy));

    const writer = new VisionWriter(dir, { port: 19990 });
    const oldItem = await writer.findFeatureItem('FEAT-OLD');
    const newItem = await writer.findFeatureItem('FEAT-NEW');

    assert.ok(oldItem, 'migrated item must be findable');
    assert.equal(oldItem.lifecycle.featureCode, 'FEAT-OLD');
    assert.ok(newItem, 'new-format item must still be findable');

    // Verify migration persisted
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'vision-state.json'), 'utf-8'));
    const oldInFile = state.items.find(i => i.id === 'old-1');
    assert.equal(oldInFile.featureCode, undefined, 'legacy field should be removed');
    assert.equal(oldInFile.lifecycle.featureCode, 'FEAT-OLD');
  });

  // -------------------------------------------------------------------------
  // Outcome normalization
  // -------------------------------------------------------------------------

  it('normalizes legacy outcome values (approved → approve)', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'test-'));
    const writer = new VisionWriter(dir, { port: 19990 });

    const gateId = await writer.createGate('flow-n', 'step-n', 'item-n');
    await writer.resolveGate(gateId, 'approved');

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'vision-state.json'), 'utf-8'));
    assert.equal(state.gates[0].outcome, 'approve', 'approved should normalize to approve');
  });

  // -------------------------------------------------------------------------
  // Gate metadata
  // -------------------------------------------------------------------------

  it('stores gate metadata (fromPhase, toPhase, artifact, summary)', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'test-'));
    const writer = new VisionWriter(dir, { port: 19990 });

    const gateId = await writer.createGate('flow-m', 'step-m', 'item-m', {
      fromPhase: 'blueprint',
      toPhase: 'verification',
      artifact: 'docs/features/FEAT-1/blueprint.md',
      summary: 'Review the blueprint',
    });

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'vision-state.json'), 'utf-8'));
    const gate = state.gates[0];
    assert.equal(gate.fromPhase, 'blueprint');
    assert.equal(gate.toPhase, 'verification');
    assert.equal(gate.artifact, 'docs/features/FEAT-1/blueprint.md');
    assert.equal(gate.summary, 'Review the blueprint');
  });

  // -------------------------------------------------------------------------
  // Gate comment
  // -------------------------------------------------------------------------

  it('stores comment on gate resolution', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'test-'));
    const writer = new VisionWriter(dir, { port: 19990 });

    const gateId = await writer.createGate('flow-c', 'step-c', 'item-c');
    await writer.resolveGate(gateId, 'revise', 'Needs more detail in section 3');

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'vision-state.json'), 'utf-8'));
    assert.equal(state.gates[0].comment, 'Needs more detail in section 3');
    assert.equal(state.gates[0].outcome, 'revise');
  });

  // -------------------------------------------------------------------------
  // getGate
  // -------------------------------------------------------------------------

  it('getGate returns gate by ID', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'test-'));
    const writer = new VisionWriter(dir, { port: 19990 });

    await writer.createGate('flow-g', 'step-g', 'item-g');
    const gate = await writer.getGate('flow-g:step-g:1');
    assert.ok(gate);
    assert.equal(gate.status, 'pending');
    assert.equal(gate.flowId, 'flow-g');
  });

  it('getGate returns null for missing gate', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'test-'));
    const writer = new VisionWriter(dir, { port: 19990 });

    const gate = await writer.getGate('nonexistent');
    assert.equal(gate, null);
  });

  it('getGate with requireServer throws ServerUnreachableError when server is down', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'test-'));
    const writer = new VisionWriter(dir, { port: 19990 });

    await assert.rejects(
      () => writer.getGate('some-gate', { requireServer: true }),
      (err) => err instanceof ServerUnreachableError
    );
  });

  // -------------------------------------------------------------------------
  // Port option
  // -------------------------------------------------------------------------

  it('accepts port option in constructor', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'test-'));
    const writer = new VisionWriter(dir, { port: 4567 });
    assert.equal(writer._port, 4567);
  });

  // -------------------------------------------------------------------------
  // Atomic write integrity
  // -------------------------------------------------------------------------

  it('atomic write produces valid JSON on immediate read', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'test-'));
    const writer = new VisionWriter(dir, { port: 19990 });

    await writer.ensureFeatureItem('FEAT-6', 'Feature Six');

    const raw = fs.readFileSync(path.join(dir, 'vision-state.json'), 'utf-8');
    const state = JSON.parse(raw);
    assert.ok(Array.isArray(state.items));
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0].lifecycle.featureCode, 'FEAT-6');
  });
});
