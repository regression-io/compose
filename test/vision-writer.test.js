/**
 * vision-writer.test.js — Tests for VisionWriter atomic read-modify-write.
 *
 * Covers: feature item creation/lookup (both conventions), status updates,
 * gate creation/resolution, and atomic write integrity.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VisionWriter } from '../lib/vision-writer.js';

describe('VisionWriter', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-writer-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Feature item creation
  // -------------------------------------------------------------------------

  it('creates feature item when none exists', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'test-'));
    const writer = new VisionWriter(dir);

    const id = writer.ensureFeatureItem('FEAT-1', 'Feature One');

    assert.ok(id, 'should return an id');
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'vision-state.json'), 'utf-8'));
    assert.equal(state.items.length, 1);
    const item = state.items[0];
    assert.equal(item.id, id);
    assert.equal(item.featureCode, 'feature:FEAT-1');
    assert.equal(item.type, 'feature');
    assert.equal(item.status, 'planned');
    assert.equal(item.title, 'Feature One');
  });

  // -------------------------------------------------------------------------
  // Feature item lookup — top-level featureCode
  // -------------------------------------------------------------------------

  it('finds existing item by top-level featureCode', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'test-'));
    const existing = {
      items: [
        { id: 'abc-123', type: 'feature', featureCode: 'feature:FEAT-2', title: 'F2' },
      ],
      connections: [],
      gates: [],
    };
    fs.writeFileSync(path.join(dir, 'vision-state.json'), JSON.stringify(existing));

    const writer = new VisionWriter(dir);
    const found = writer.findFeatureItem('FEAT-2');

    assert.ok(found);
    assert.equal(found.id, 'abc-123');
  });

  // -------------------------------------------------------------------------
  // Feature item lookup — lifecycle.featureCode
  // -------------------------------------------------------------------------

  it('finds existing item by lifecycle.featureCode', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'test-'));
    const existing = {
      items: [
        { id: 'def-456', type: 'feature', title: 'F3', lifecycle: { featureCode: 'FEAT-3' } },
      ],
      connections: [],
      gates: [],
    };
    fs.writeFileSync(path.join(dir, 'vision-state.json'), JSON.stringify(existing));

    const writer = new VisionWriter(dir);
    const found = writer.findFeatureItem('FEAT-3');

    assert.ok(found);
    assert.equal(found.id, 'def-456');
  });

  // -------------------------------------------------------------------------
  // Deduplication when both fields present
  // -------------------------------------------------------------------------

  it('does not duplicate when both featureCode fields present', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'test-'));
    const existing = {
      items: [
        {
          id: 'ghi-789',
          type: 'feature',
          title: 'F4',
          featureCode: 'feature:FEAT-4',
          lifecycle: { featureCode: 'FEAT-4' },
        },
      ],
      connections: [],
      gates: [],
    };
    fs.writeFileSync(path.join(dir, 'vision-state.json'), JSON.stringify(existing));

    const writer = new VisionWriter(dir);
    const id = writer.ensureFeatureItem('FEAT-4');

    assert.equal(id, 'ghi-789');
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'vision-state.json'), 'utf-8'));
    assert.equal(state.items.length, 1, 'should not create a duplicate item');
  });

  // -------------------------------------------------------------------------
  // Status update
  // -------------------------------------------------------------------------

  it('updates item status', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'test-'));
    const writer = new VisionWriter(dir);

    const id = writer.ensureFeatureItem('FEAT-5', 'Feature Five');
    writer.updateItemStatus(id, 'in_progress');

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'vision-state.json'), 'utf-8'));
    assert.equal(state.items[0].status, 'in_progress');
  });

  // -------------------------------------------------------------------------
  // Gate creation and resolution
  // -------------------------------------------------------------------------

  it('creates and resolves gate entries', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'test-'));
    const writer = new VisionWriter(dir);

    // Seed an empty state so gates array exists
    const gateId = writer.createGate('flow-1', 'step-1', 'item-1');
    assert.equal(gateId, 'flow-1:step-1');

    let state = JSON.parse(fs.readFileSync(path.join(dir, 'vision-state.json'), 'utf-8'));
    assert.equal(state.gates.length, 1);
    assert.equal(state.gates[0].status, 'pending');
    assert.equal(state.gates[0].flowId, 'flow-1');
    assert.equal(state.gates[0].itemId, 'item-1');

    writer.resolveGate('flow-1:step-1', 'approve');

    state = JSON.parse(fs.readFileSync(path.join(dir, 'vision-state.json'), 'utf-8'));
    assert.equal(state.gates[0].status, 'resolved');
    assert.equal(state.gates[0].outcome, 'approve');
    assert.ok(state.gates[0].resolvedAt);
  });

  // -------------------------------------------------------------------------
  // Atomic write integrity
  // -------------------------------------------------------------------------

  it('atomic write produces valid JSON on immediate read', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'test-'));
    const writer = new VisionWriter(dir);

    writer.ensureFeatureItem('FEAT-6', 'Feature Six');

    // Immediately read — should be valid JSON (not a partial write)
    const raw = fs.readFileSync(path.join(dir, 'vision-state.json'), 'utf-8');
    const state = JSON.parse(raw); // throws if invalid
    assert.ok(Array.isArray(state.items));
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0].featureCode, 'feature:FEAT-6');
  });
});
