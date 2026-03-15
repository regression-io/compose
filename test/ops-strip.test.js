import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveEntries, filterRecentErrors } from '../src/components/cockpit/opsStripLogic.js';

describe('OpsStrip: deriveEntries', () => {
  it('returns empty array when no data', () => {
    const entries = deriveEntries({ activeBuild: null, gates: [], recentErrors: [] });
    assert.deepStrictEqual(entries, []);
  });

  it('creates build entry from activeBuild', () => {
    const entries = deriveEntries({
      activeBuild: {
        featureCode: 'FEAT-1',
        currentStep: 'execute',
        currentStepIndex: 3,
        totalSteps: 10,
      },
      gates: [],
      recentErrors: [],
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, 'build');
    assert.ok(entries[0].label.includes('FEAT-1'));
    assert.ok(entries[0].label.includes('execute'));
    assert.ok(entries[0].label.includes('3/10'));
    assert.equal(entries[0].featureCode, 'FEAT-1');
  });

  it('marks completed build as done type', () => {
    const entries = deriveEntries({
      activeBuild: { featureCode: 'FEAT-1', currentStep: 'ship', status: 'complete' },
      gates: [],
      recentErrors: [],
    });
    assert.equal(entries[0].type, 'done');
  });

  it('creates gate entries for pending gates', () => {
    const entries = deriveEntries({
      activeBuild: null,
      gates: [
        { id: 'g1', status: 'pending', featureCode: 'FEAT-2', toPhase: 'blueprint' },
        { id: 'g2', status: 'resolved', featureCode: 'FEAT-3', toPhase: 'execute' },
      ],
      recentErrors: [],
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, 'gate');
    assert.equal(entries[0].gateId, 'g1');
    assert.ok(entries[0].label.includes('FEAT-2'));
    assert.ok(entries[0].label.includes('blueprint'));
  });

  it('creates error entries from recentErrors', () => {
    const entries = deriveEntries({
      activeBuild: null,
      gates: [],
      recentErrors: [
        { message: 'Build failed: syntax error', featureCode: 'FEAT-4', timestamp: new Date().toISOString() },
      ],
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, 'error');
    assert.ok(entries[0].label.includes('FEAT-4'));
    assert.ok(entries[0].label.includes('Build failed'));
  });

  it('truncates error messages to 60 chars', () => {
    const longMsg = 'A'.repeat(100);
    const entries = deriveEntries({
      activeBuild: null,
      gates: [],
      recentErrors: [{ message: longMsg, featureCode: 'X', timestamp: new Date().toISOString() }],
    });
    // The summary part should be truncated
    const summary = entries[0].label.split('\u00B7')[1].trim();
    assert.ok(summary.length <= 60);
  });

  it('generates unique build keys per flowId to avoid dismissal collision', () => {
    const build1 = deriveEntries({
      activeBuild: { featureCode: 'FEAT-1', currentStep: 'execute', flowId: 'flow-aaa' },
      gates: [], recentErrors: [],
    });
    const build2 = deriveEntries({
      activeBuild: { featureCode: 'FEAT-1', currentStep: 'execute', flowId: 'flow-bbb' },
      gates: [], recentErrors: [],
    });
    assert.notEqual(build1[0].key, build2[0].key);
  });

  it('combines all entry types', () => {
    const entries = deriveEntries({
      activeBuild: { featureCode: 'F1', currentStep: 'execute' },
      gates: [{ id: 'g1', status: 'pending', featureCode: 'F2', toPhase: 'plan' }],
      recentErrors: [{ message: 'err', featureCode: 'F3', timestamp: new Date().toISOString() }],
    });
    assert.equal(entries.length, 3);
    assert.equal(entries[0].type, 'build');
    assert.equal(entries[1].type, 'gate');
    assert.equal(entries[2].type, 'error');
  });
});

describe('OpsStrip: filterRecentErrors', () => {
  it('filters out errors older than 60s', () => {
    const now = Date.now();
    const errors = [
      { message: 'old', timestamp: new Date(now - 120_000).toISOString() },
      { message: 'recent', timestamp: new Date(now - 30_000).toISOString() },
    ];
    const result = filterRecentErrors(errors, now);
    assert.equal(result.length, 1);
    assert.equal(result[0].message, 'recent');
  });

  it('caps at 5 errors', () => {
    const now = Date.now();
    const errors = Array.from({ length: 10 }, (_, i) => ({
      message: `error-${i}`,
      timestamp: new Date(now - 10_000 + i * 100).toISOString(),
    }));
    const result = filterRecentErrors(errors, now);
    assert.equal(result.length, 5);
    // Should be the last 5
    assert.equal(result[0].message, 'error-5');
  });

  it('returns empty for no errors', () => {
    assert.deepStrictEqual(filterRecentErrors([]), []);
  });

  it('returns empty when all errors are stale', () => {
    const now = Date.now();
    const errors = [
      { message: 'old1', timestamp: new Date(now - 120_000).toISOString() },
      { message: 'old2', timestamp: new Date(now - 90_000).toISOString() },
    ];
    assert.deepStrictEqual(filterRecentErrors(errors, now), []);
  });
});

describe('OpsStrip: visibility rules', () => {
  it('deriveEntries returns empty when no active data (strip will hide)', () => {
    const entries = deriveEntries({ activeBuild: null, gates: [], recentErrors: [] });
    assert.equal(entries.length, 0);
  });

  // activeView === 'docs' hiding is handled in the component (returns null)
  // We test the pure logic here: when there are no entries, strip should not render
});
