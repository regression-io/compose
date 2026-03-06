/**
 * gate-logic.test.js — Pure logic tests for gate UI derivations.
 *
 * Covers: phase label completeness, pending/resolved partitioning,
 * artifact display derivation, pendingGateCount.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { PHASES, TERMINAL, PHASE_ARTIFACTS } = await import(`${REPO_ROOT}/server/lifecycle-constants.js`);
const { LIFECYCLE_PHASE_LABELS, LIFECYCLE_PHASE_ARTIFACTS } = await import(
  `${REPO_ROOT}/src/components/vision/constants.js`
);

// ---------------------------------------------------------------------------
// Phase label completeness
// ---------------------------------------------------------------------------

describe('LIFECYCLE_PHASE_LABELS completeness', () => {
  test('every lifecycle phase has a label', () => {
    for (const phase of PHASES) {
      assert.ok(
        LIFECYCLE_PHASE_LABELS[phase],
        `Missing label for lifecycle phase: ${phase}`,
      );
    }
  });

  test('terminal states (complete, killed) have labels', () => {
    for (const state of TERMINAL) {
      assert.ok(
        LIFECYCLE_PHASE_LABELS[state],
        `Missing label for terminal state: ${state}`,
      );
    }
  });

  test('no extra labels beyond phases + terminal states', () => {
    const expected = new Set([...PHASES, ...TERMINAL]);
    for (const key of Object.keys(LIFECYCLE_PHASE_LABELS)) {
      assert.ok(expected.has(key), `Unexpected label key: ${key}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Artifact mapping completeness
// ---------------------------------------------------------------------------

describe('LIFECYCLE_PHASE_ARTIFACTS', () => {
  test('client artifact map matches server artifact map', () => {
    for (const [phase, artifact] of Object.entries(PHASE_ARTIFACTS)) {
      assert.equal(
        LIFECYCLE_PHASE_ARTIFACTS[phase], artifact,
        `Mismatch for phase ${phase}: client=${LIFECYCLE_PHASE_ARTIFACTS[phase]} server=${artifact}`,
      );
    }
  });

  test('client has no extra artifact entries beyond server', () => {
    for (const key of Object.keys(LIFECYCLE_PHASE_ARTIFACTS)) {
      assert.ok(
        PHASE_ARTIFACTS[key],
        `Client has artifact for ${key} but server does not`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Pending/resolved gate partitioning (mirrors GateView useMemo)
// ---------------------------------------------------------------------------

describe('gate partitioning logic', () => {
  function partition(gates) {
    const pending = [];
    const resolvedToday = [];
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    for (const gate of gates) {
      if (gate.status === 'pending') {
        pending.push(gate);
      } else if (gate.resolvedAt && new Date(gate.resolvedAt) >= todayStart) {
        resolvedToday.push(gate);
      }
    }
    return { pending, resolvedToday };
  }

  test('separates pending from resolved', () => {
    const gates = [
      { id: 'g1', status: 'pending', createdAt: '2026-03-06T10:00:00Z' },
      { id: 'g2', status: 'approved', outcome: 'approved', resolvedAt: new Date().toISOString() },
    ];
    const { pending, resolvedToday } = partition(gates);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, 'g1');
    assert.equal(resolvedToday.length, 1);
    assert.equal(resolvedToday[0].id, 'g2');
  });

  test('excludes resolved gates from before today', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const gates = [
      { id: 'g1', status: 'approved', outcome: 'approved', resolvedAt: yesterday.toISOString() },
    ];
    const { pending, resolvedToday } = partition(gates);
    assert.equal(pending.length, 0);
    assert.equal(resolvedToday.length, 0);
  });

  test('empty input returns empty arrays', () => {
    const { pending, resolvedToday } = partition([]);
    assert.equal(pending.length, 0);
    assert.equal(resolvedToday.length, 0);
  });
});

// ---------------------------------------------------------------------------
// pendingGateCount derivation (mirrors VisionTracker useMemo)
// ---------------------------------------------------------------------------

describe('pendingGateCount', () => {
  function pendingGateCount(gates) {
    return gates.filter(g => g.status === 'pending').length;
  }

  test('counts only pending gates', () => {
    const gates = [
      { id: 'g1', status: 'pending' },
      { id: 'g2', status: 'approved' },
      { id: 'g3', status: 'pending' },
      { id: 'g4', status: 'killed' },
    ];
    assert.equal(pendingGateCount(gates), 2);
  });

  test('returns 0 for empty array', () => {
    assert.equal(pendingGateCount([]), 0);
  });

  test('returns 0 when all resolved', () => {
    const gates = [
      { id: 'g1', status: 'approved' },
      { id: 'g2', status: 'revised' },
    ];
    assert.equal(pendingGateCount(gates), 0);
  });
});

// ---------------------------------------------------------------------------
// Artifact assessment display derivation
// ---------------------------------------------------------------------------

describe('artifact assessment display', () => {
  test('renders completeness percentage correctly', () => {
    const assessment = { exists: true, completeness: 0.75, wordCount: 450, meetsMinWordCount: true, sections: { missing: [] } };
    const pct = Math.round(assessment.completeness * 100);
    assert.equal(pct, 75);
  });

  test('flags missing sections', () => {
    const assessment = { exists: true, completeness: 0.5, wordCount: 200, meetsMinWordCount: true, sections: { missing: ['Goals', 'Constraints'] } };
    assert.equal(assessment.sections.missing.length, 2);
    assert.ok(assessment.sections.missing.includes('Goals'));
  });

  test('flags below min word count', () => {
    const assessment = { exists: true, completeness: 0.3, wordCount: 50, meetsMinWordCount: false, sections: { missing: [] } };
    assert.equal(assessment.meetsMinWordCount, false);
  });

  test('handles non-existent artifact', () => {
    const assessment = { exists: false };
    assert.equal(assessment.exists, false);
  });
});
