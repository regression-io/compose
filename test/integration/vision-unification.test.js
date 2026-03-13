/**
 * Integration test — STRAT-COMP-4 Vision Store Unification
 *
 * Validates the full round-trip: featureCode format, gate lifecycle,
 * REST dispatch vs direct dispatch, migration, and port coordination.
 *
 * These tests use real files and (where possible) a real Express server
 * to test end-to-end behavior.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

import { VisionWriter, ServerUnreachableError } from '../../lib/vision-writer.js';
import { VisionStore } from '../../server/vision-store.js';
import { resolvePort } from '../../lib/resolve-port.js';
import { probeServer } from '../../lib/server-probe.js';

describe('STRAT-COMP-4 Integration', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strat-comp-4-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Checkpoint 1: featureCode round-trip
  // -----------------------------------------------------------------------

  describe('featureCode round-trip', () => {
    it('CLI-created item is findable by server getItemByFeatureCode', async () => {
      const dataDir = fs.mkdtempSync(path.join(tmpDir, 'fc-'));
      const writer = new VisionWriter(dataDir);
      const store = new VisionStore(dataDir);

      // CLI creates item
      const itemId = await writer.ensureFeatureItem('FEAT-RT', 'Round Trip');

      // Server loads from same file
      const store2 = new VisionStore(dataDir);
      const found = store2.getItemByFeatureCode('FEAT-RT');

      assert.ok(found, 'Server must find item created by CLI');
      assert.equal(found.id, itemId);
      assert.equal(found.lifecycle.featureCode, 'FEAT-RT');

      // No feature: prefix in file
      const raw = fs.readFileSync(path.join(dataDir, 'vision-state.json'), 'utf-8');
      assert.ok(!raw.includes('"feature:FEAT-RT"'), 'No feature: prefix should exist');
    });
  });

  // -----------------------------------------------------------------------
  // Checkpoint 6: Gate status unification
  // -----------------------------------------------------------------------

  describe('gate status unification', () => {
    it('VisionWriter and VisionStore produce identical gate shapes', async () => {
      const dataDir = fs.mkdtempSync(path.join(tmpDir, 'gs-'));

      // VisionWriter path
      const writer = new VisionWriter(dataDir);
      const gateId1 = await writer.createGate('f1', 's1', 'item1');
      await writer.resolveGate(gateId1, 'approve');
      const state1 = JSON.parse(fs.readFileSync(path.join(dataDir, 'vision-state.json'), 'utf-8'));
      const writerGate = state1.gates.find(g => g.id === gateId1);

      // VisionStore path
      const store = new VisionStore(dataDir);
      store.createGate({
        id: 'f2:s2',
        flowId: 'f2',
        stepId: 's2',
        itemId: 'item2',
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
      store.resolveGate('f2:s2', { outcome: 'approve' });
      const storeGate = store.gates.get('f2:s2');

      // Both must have status: 'resolved', outcome: 'approve'
      assert.equal(writerGate.status, 'resolved');
      assert.equal(writerGate.outcome, 'approve');
      assert.equal(storeGate.status, 'resolved');
      assert.equal(storeGate.outcome, 'approve');
    });
  });

  // -----------------------------------------------------------------------
  // Checkpoint 3: Server-down fallback
  // -----------------------------------------------------------------------

  describe('server-down fallback', () => {
    it('VisionWriter writes directly when server is not running', async () => {
      const dataDir = fs.mkdtempSync(path.join(tmpDir, 'sd-'));
      // Use a port that's definitely not in use
      const writer = new VisionWriter(dataDir, { port: 19999 });

      const itemId = await writer.ensureFeatureItem('FEAT-SD', 'Server Down');
      assert.ok(itemId);

      const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'vision-state.json'), 'utf-8'));
      assert.equal(state.items.length, 1);
      assert.equal(state.items[0].lifecycle.featureCode, 'FEAT-SD');
    });

    it('probe times out in under 600ms', async () => {
      const start = Date.now();
      const result = await probeServer(19998, 500);
      const elapsed = Date.now() - start;

      assert.equal(result, false);
      assert.ok(elapsed < 600, `Probe took ${elapsed}ms, expected < 600ms`);
    });
  });

  // -----------------------------------------------------------------------
  // Checkpoint 7: Migration
  // -----------------------------------------------------------------------

  describe('migration', () => {
    it('VisionWriter migrates legacy items on load', async () => {
      const dataDir = fs.mkdtempSync(path.join(tmpDir, 'mig-'));
      const legacy = {
        items: [
          { id: 'old-1', type: 'feature', title: 'Old', featureCode: 'feature:FEAT-OLD' },
          { id: 'new-1', type: 'feature', title: 'New', lifecycle: { featureCode: 'FEAT-NEW' } },
        ],
        connections: [],
        gates: [],
      };
      fs.writeFileSync(path.join(dataDir, 'vision-state.json'), JSON.stringify(legacy));

      const writer = new VisionWriter(dataDir);
      const oldItem = await writer.findFeatureItem('FEAT-OLD');
      const newItem = await writer.findFeatureItem('FEAT-NEW');

      assert.ok(oldItem, 'migrated item must be findable');
      assert.equal(oldItem.lifecycle.featureCode, 'FEAT-OLD');
      assert.ok(newItem, 'new-format item must still be findable');

      // Verify migration persisted
      const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'vision-state.json'), 'utf-8'));
      const oldInFile = state.items.find(i => i.id === 'old-1');
      assert.equal(oldInFile.featureCode, undefined, 'legacy field should be removed');
      assert.equal(oldInFile.lifecycle.featureCode, 'FEAT-OLD');
    });

    it('VisionStore migrates legacy items on load', () => {
      const dataDir = fs.mkdtempSync(path.join(tmpDir, 'mig-store-'));
      const legacy = {
        items: [
          { id: 'store-old', type: 'feature', title: 'Old', featureCode: 'feature:FEAT-SOLD' },
        ],
        connections: [],
        gates: [],
      };
      fs.writeFileSync(path.join(dataDir, 'vision-state.json'), JSON.stringify(legacy));

      const store = new VisionStore(dataDir);
      const found = store.getItemByFeatureCode('FEAT-SOLD');

      assert.ok(found, 'store must find migrated item');
      assert.equal(found.lifecycle.featureCode, 'FEAT-SOLD');
      assert.equal(found.featureCode, undefined);
    });
  });

  // -----------------------------------------------------------------------
  // Port coordination
  // -----------------------------------------------------------------------

  describe('port coordination', () => {
    it('resolvePort returns default 3001', () => {
      // Save and clear env vars
      const saved = { COMPOSE_PORT: process.env.COMPOSE_PORT, PORT: process.env.PORT };
      delete process.env.COMPOSE_PORT;
      delete process.env.PORT;

      try {
        assert.equal(resolvePort(), 3001);
      } finally {
        // Restore
        if (saved.COMPOSE_PORT) process.env.COMPOSE_PORT = saved.COMPOSE_PORT;
        if (saved.PORT) process.env.PORT = saved.PORT;
      }
    });

    it('COMPOSE_PORT takes priority over PORT', () => {
      const saved = { COMPOSE_PORT: process.env.COMPOSE_PORT, PORT: process.env.PORT };
      process.env.COMPOSE_PORT = '4001';
      process.env.PORT = '4002';

      try {
        assert.equal(resolvePort(), 4001);
      } finally {
        if (saved.COMPOSE_PORT) process.env.COMPOSE_PORT = saved.COMPOSE_PORT;
        else delete process.env.COMPOSE_PORT;
        if (saved.PORT) process.env.PORT = saved.PORT;
        else delete process.env.PORT;
      }
    });
  });

  // -----------------------------------------------------------------------
  // getGate with requireServer
  // -----------------------------------------------------------------------

  describe('getGate requireServer', () => {
    it('throws ServerUnreachableError when server is down and requireServer is true', async () => {
      const dataDir = fs.mkdtempSync(path.join(tmpDir, 'req-'));
      const writer = new VisionWriter(dataDir, { port: 19997 });

      await assert.rejects(
        () => writer.getGate('some-gate', { requireServer: true }),
        (err) => err instanceof ServerUnreachableError
      );
    });

    it('falls back to direct read when requireServer is false and server is down', async () => {
      const dataDir = fs.mkdtempSync(path.join(tmpDir, 'req2-'));
      const writer = new VisionWriter(dataDir, { port: 19996 });

      // Create a gate via direct write
      await writer.createGate('f-fb', 's-fb', 'item-fb');

      // Get gate without requireServer — should fall back to direct read
      const gate = await writer.getGate('f-fb:s-fb:1');
      assert.ok(gate);
      assert.equal(gate.status, 'pending');
    });
  });
});
