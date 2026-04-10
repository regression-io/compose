/**
 * health-history.test.js — COMP-HEALTH unit tests for score history persistence.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { recordScore, readHistory, getTrend } from '../lib/health-history.js';

describe('health-history', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'health-history-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // recordScore
  // -------------------------------------------------------------------------
  describe('recordScore', () => {
    it('creates health-scores.json in .compose/data/', () => {
      recordScore(tmpDir, {
        featureCode: 'FEAT-1',
        score: 85,
        breakdown: { test_coverage: 100 },
      });

      const p = join(tmpDir, '.compose', 'data', 'health-scores.json');
      assert.ok(existsSync(p), 'health-scores.json should exist');
    });

    it('appends entries for the same feature', () => {
      recordScore(tmpDir, { featureCode: 'FEAT-1', score: 70, breakdown: {} });
      recordScore(tmpDir, { featureCode: 'FEAT-1', score: 85, breakdown: {} });

      const p = join(tmpDir, '.compose', 'data', 'health-scores.json');
      const entries = JSON.parse(readFileSync(p, 'utf-8'));
      assert.equal(entries.length, 2);
    });

    it('stores featureCode, score, breakdown, timestamp', () => {
      const ts = '2025-01-01T00:00:00.000Z';
      recordScore(tmpDir, {
        featureCode: 'FEAT-2',
        phase: 'build',
        score: 72,
        breakdown: { test_coverage: 100, review_findings: 60 },
        timestamp: ts,
      });

      const p = join(tmpDir, '.compose', 'data', 'health-scores.json');
      const [entry] = JSON.parse(readFileSync(p, 'utf-8'));
      assert.equal(entry.featureCode, 'FEAT-2');
      assert.equal(entry.score, 72);
      assert.equal(entry.phase, 'build');
      assert.equal(entry.timestamp, ts);
      assert.deepEqual(entry.breakdown, { test_coverage: 100, review_findings: 60 });
    });

    it('appends entries for different features into same file', () => {
      recordScore(tmpDir, { featureCode: 'FEAT-1', score: 80, breakdown: {} });
      recordScore(tmpDir, { featureCode: 'FEAT-2', score: 60, breakdown: {} });

      const p = join(tmpDir, '.compose', 'data', 'health-scores.json');
      const entries = JSON.parse(readFileSync(p, 'utf-8'));
      assert.equal(entries.length, 2);
    });

    it('auto-sets timestamp if not provided', () => {
      const before = Date.now();
      recordScore(tmpDir, { featureCode: 'FEAT-1', score: 90, breakdown: {} });
      const after = Date.now();

      const p = join(tmpDir, '.compose', 'data', 'health-scores.json');
      const [entry] = JSON.parse(readFileSync(p, 'utf-8'));
      const ts = new Date(entry.timestamp).getTime();
      assert.ok(ts >= before && ts <= after, 'timestamp should be within test window');
    });
  });

  // -------------------------------------------------------------------------
  // readHistory
  // -------------------------------------------------------------------------
  describe('readHistory', () => {
    it('returns empty array when no file exists', () => {
      assert.deepEqual(readHistory(tmpDir, 'FEAT-1'), []);
    });

    it('returns only entries for the requested feature', () => {
      recordScore(tmpDir, { featureCode: 'FEAT-1', score: 80, breakdown: {} });
      recordScore(tmpDir, { featureCode: 'FEAT-2', score: 50, breakdown: {} });
      recordScore(tmpDir, { featureCode: 'FEAT-1', score: 90, breakdown: {} });

      const history = readHistory(tmpDir, 'FEAT-1');
      assert.equal(history.length, 2);
      assert.ok(history.every(e => e.featureCode === 'FEAT-1'));
    });

    it('returns entries sorted chronologically (oldest first)', () => {
      // Insert out of order by providing explicit timestamps
      recordScore(tmpDir, {
        featureCode: 'FEAT-1', score: 90, breakdown: {},
        timestamp: '2025-01-03T00:00:00.000Z',
      });
      recordScore(tmpDir, {
        featureCode: 'FEAT-1', score: 70, breakdown: {},
        timestamp: '2025-01-01T00:00:00.000Z',
      });
      recordScore(tmpDir, {
        featureCode: 'FEAT-1', score: 80, breakdown: {},
        timestamp: '2025-01-02T00:00:00.000Z',
      });

      const history = readHistory(tmpDir, 'FEAT-1');
      assert.equal(history[0].score, 70);
      assert.equal(history[1].score, 80);
      assert.equal(history[2].score, 90);
    });
  });

  // -------------------------------------------------------------------------
  // getTrend
  // -------------------------------------------------------------------------
  describe('getTrend', () => {
    it('returns nulls when no history', () => {
      const trend = getTrend(tmpDir, 'FEAT-1');
      assert.equal(trend.latest, null);
      assert.equal(trend.previous, null);
      assert.equal(trend.delta, null);
      assert.equal(trend.direction, null);
    });

    it('returns latest with null previous for single entry', () => {
      recordScore(tmpDir, { featureCode: 'FEAT-1', score: 80, breakdown: {} });
      const trend = getTrend(tmpDir, 'FEAT-1');
      assert.equal(trend.latest.score, 80);
      assert.equal(trend.previous, null);
      assert.equal(trend.delta, null);
      assert.equal(trend.direction, null);
    });

    it('calculates improving direction', () => {
      recordScore(tmpDir, {
        featureCode: 'FEAT-1', score: 60, breakdown: {},
        timestamp: '2025-01-01T00:00:00.000Z',
      });
      recordScore(tmpDir, {
        featureCode: 'FEAT-1', score: 80, breakdown: {},
        timestamp: '2025-01-02T00:00:00.000Z',
      });
      const { delta, direction } = getTrend(tmpDir, 'FEAT-1');
      assert.equal(delta, 20);
      assert.equal(direction, 'improving');
    });

    it('calculates declining direction', () => {
      recordScore(tmpDir, {
        featureCode: 'FEAT-1', score: 80, breakdown: {},
        timestamp: '2025-01-01T00:00:00.000Z',
      });
      recordScore(tmpDir, {
        featureCode: 'FEAT-1', score: 60, breakdown: {},
        timestamp: '2025-01-02T00:00:00.000Z',
      });
      const { delta, direction } = getTrend(tmpDir, 'FEAT-1');
      assert.equal(delta, -20);
      assert.equal(direction, 'declining');
    });

    it('calculates stable direction when delta is small', () => {
      recordScore(tmpDir, {
        featureCode: 'FEAT-1', score: 80, breakdown: {},
        timestamp: '2025-01-01T00:00:00.000Z',
      });
      recordScore(tmpDir, {
        featureCode: 'FEAT-1', score: 81, breakdown: {},
        timestamp: '2025-01-02T00:00:00.000Z',
      });
      const { direction } = getTrend(tmpDir, 'FEAT-1');
      assert.equal(direction, 'stable');
    });

    it('returns latest and previous entries correctly', () => {
      recordScore(tmpDir, {
        featureCode: 'FEAT-1', score: 60, breakdown: {},
        timestamp: '2025-01-01T00:00:00.000Z',
      });
      recordScore(tmpDir, {
        featureCode: 'FEAT-1', score: 75, breakdown: {},
        timestamp: '2025-01-02T00:00:00.000Z',
      });
      const { latest, previous } = getTrend(tmpDir, 'FEAT-1');
      assert.equal(latest.score, 75);
      assert.equal(previous.score, 60);
    });
  });
});
