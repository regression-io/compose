/**
 * health-score.test.js — COMP-HEALTH unit tests for scoring logic.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeCompositeScore,
  scoreTestCoverage,
  scoreReviewFindings,
  scoreContractCompliance,
  scoreRuntimeErrors,
  scoreDocFreshness,
  scorePlanCompletion,
  DIMENSIONS,
} from '../lib/health-score.js';

// ---------------------------------------------------------------------------
// DIMENSIONS sanity
// ---------------------------------------------------------------------------
describe('DIMENSIONS', () => {
  it('weights sum to 1.0', () => {
    const total = Object.values(DIMENSIONS).reduce((s, d) => s + d.weight, 0);
    assert.ok(Math.abs(total - 1.0) < 0.001, `Expected weights to sum to 1.0, got ${total}`);
  });
});

// ---------------------------------------------------------------------------
// scoreTestCoverage
// ---------------------------------------------------------------------------
describe('scoreTestCoverage', () => {
  it('returns 100 when passing with no failures', () => {
    assert.equal(scoreTestCoverage({ passing: true, failures: [] }), 100);
  });

  it('returns 0 when passing is false', () => {
    assert.equal(scoreTestCoverage({ passing: false }), 0);
  });

  it('returns 50 for null (neutral)', () => {
    assert.equal(scoreTestCoverage(null), 50);
  });

  it('returns 50 for undefined', () => {
    assert.equal(scoreTestCoverage(undefined), 50);
  });

  it('returns 100 when passing true with failures absent', () => {
    assert.equal(scoreTestCoverage({ passing: true }), 100);
  });

  it('returns 0 when there are failures', () => {
    assert.equal(scoreTestCoverage({ passing: false, failures: ['test1 failed'] }), 0);
  });
});

// ---------------------------------------------------------------------------
// scoreReviewFindings
// ---------------------------------------------------------------------------
describe('scoreReviewFindings', () => {
  it('returns 100 with no findings', () => {
    assert.equal(scoreReviewFindings({ findings: [] }), 100);
  });

  it('returns 40 with 3 must-fix findings', () => {
    const result = scoreReviewFindings({
      findings: [
        { severity: 'must-fix', message: 'a' },
        { severity: 'must-fix', message: 'b' },
        { severity: 'must-fix', message: 'c' },
      ],
    });
    // 100 - 3*20 = 40
    assert.equal(result, 40);
  });

  it('deducts 5 per should-fix finding', () => {
    const result = scoreReviewFindings({
      findings: [
        { severity: 'should-fix' },
        { severity: 'should-fix' },
      ],
    });
    // 100 - 2*5 = 90
    assert.equal(result, 90);
  });

  it('deducts 1 per nit finding', () => {
    const result = scoreReviewFindings({ findings: [{ severity: 'nit' }] });
    assert.equal(result, 99);
  });

  it('floors at 0 with many must-fix findings', () => {
    const findings = Array.from({ length: 10 }, () => ({ severity: 'must-fix' }));
    assert.equal(scoreReviewFindings({ findings }), 0);
  });

  it('returns 50 for null', () => {
    assert.equal(scoreReviewFindings(null), 50);
  });

  it('handles mixed severities correctly', () => {
    const result = scoreReviewFindings({
      findings: [
        { severity: 'must-fix' },    // -20
        { severity: 'should-fix' },  // -5
        { severity: 'nit' },         // -1
      ],
    });
    // 100 - 20 - 5 - 1 = 74
    assert.equal(result, 74);
  });

  it('accepts underscore variant severity names', () => {
    const result = scoreReviewFindings({
      findings: [{ severity: 'must_fix' }],
    });
    assert.equal(result, 80);
  });
});

// ---------------------------------------------------------------------------
// scoreContractCompliance
// ---------------------------------------------------------------------------
describe('scoreContractCompliance', () => {
  it('returns 100 with all passing', () => {
    assert.equal(scoreContractCompliance([{ passed: true }, { passed: true }]), 100);
  });

  it('deducts 10 per failed ensure', () => {
    assert.equal(scoreContractCompliance([{ passed: false }, { passed: true }]), 90);
  });

  it('floors at 0', () => {
    const all = Array.from({ length: 15 }, () => ({ passed: false }));
    assert.equal(scoreContractCompliance(all), 0);
  });

  it('returns 50 for null', () => {
    assert.equal(scoreContractCompliance(null), 50);
  });

  it('returns 100 for empty array', () => {
    assert.equal(scoreContractCompliance([]), 100);
  });
});

// ---------------------------------------------------------------------------
// scoreRuntimeErrors
// ---------------------------------------------------------------------------
describe('scoreRuntimeErrors', () => {
  it('returns 100 for no violations', () => {
    assert.equal(scoreRuntimeErrors([]), 100);
  });

  it('deducts 15 per violation', () => {
    assert.equal(scoreRuntimeErrors(['v1', 'v2']), 70);
  });

  it('floors at 0', () => {
    const viols = Array.from({ length: 10 }, (_, i) => `v${i}`);
    assert.equal(scoreRuntimeErrors(viols), 0);
  });

  it('returns 50 for null', () => {
    assert.equal(scoreRuntimeErrors(null), 50);
  });
});

// ---------------------------------------------------------------------------
// scoreDocFreshness
// ---------------------------------------------------------------------------
describe('scoreDocFreshness', () => {
  it('returns 100 when no stale docs', () => {
    const results = [{ stale: false }, { stale: false }];
    assert.equal(scoreDocFreshness(results), 100);
  });

  it('deducts 20 per stale doc', () => {
    assert.equal(scoreDocFreshness([{ stale: true }, { stale: false }]), 80);
  });

  it('floors at 0', () => {
    const all = Array.from({ length: 10 }, () => ({ stale: true }));
    assert.equal(scoreDocFreshness(all), 0);
  });

  it('returns 50 for null', () => {
    assert.equal(scoreDocFreshness(null), 50);
  });

  it('returns 100 for empty array', () => {
    assert.equal(scoreDocFreshness([]), 100);
  });
});

// ---------------------------------------------------------------------------
// scorePlanCompletion
// ---------------------------------------------------------------------------
describe('scorePlanCompletion', () => {
  it('returns planCompletionPct directly', () => {
    assert.equal(scorePlanCompletion({ planCompletionPct: 80 }), 80);
  });

  it('returns 50 for null', () => {
    assert.equal(scorePlanCompletion(null), 50);
  });

  it('clamps to 100', () => {
    assert.equal(scorePlanCompletion({ planCompletionPct: 120 }), 100);
  });

  it('clamps to 0', () => {
    assert.equal(scorePlanCompletion({ planCompletionPct: -10 }), 0);
  });

  it('handles completion_pct alias', () => {
    assert.equal(scorePlanCompletion({ completion_pct: 75 }), 75);
  });
});

// ---------------------------------------------------------------------------
// computeCompositeScore
// ---------------------------------------------------------------------------
describe('computeCompositeScore', () => {
  it('returns 50 with no signals', () => {
    const { score, missing } = computeCompositeScore({});
    assert.equal(score, 50);
    assert.equal(missing.length, 6);
  });

  it('computes weighted average with all dimensions', () => {
    const signals = {
      test_coverage: { passing: true, failures: [] },        // 100
      review_findings: { findings: [] },                     // 100
      contract_compliance: [{ passed: true }],               // 100
      runtime_errors: [],                                    // 100
      doc_freshness: [],                                     // 100
      plan_completion: { planCompletionPct: 100 },           // 100
    };
    const { score, breakdown, missing } = computeCompositeScore(signals);
    assert.equal(score, 100);
    assert.equal(missing.length, 0);
    assert.equal(breakdown.test_coverage, 100);
  });

  it('re-normalizes weights when dimensions are missing (no penalty)', () => {
    // Only test_coverage provided (weight 0.25), no others
    // Result should be 100, not 100*0.25 + 50*0.75
    const { score, missing } = computeCompositeScore({
      test_coverage: { passing: true, failures: [] },
    });
    assert.equal(score, 100);
    assert.equal(missing.length, 5);
  });

  it('returns partial score when some dimensions fail', () => {
    const signals = {
      test_coverage: { passing: false },          // 0
      review_findings: { findings: [] },          // 100
    };
    const { score } = computeCompositeScore(signals);
    // weights: test_coverage=0.25, review_findings=0.25
    // total weight = 0.5, re-normalized: each is 0.5
    // score = 0*0.5 + 100*0.5 = 50
    assert.equal(score, 50);
  });

  it('lists missing dimensions', () => {
    const { missing } = computeCompositeScore({
      test_coverage: { passing: true },
    });
    assert.ok(missing.includes('review_findings'));
    assert.ok(missing.includes('contract_compliance'));
    assert.ok(!missing.includes('test_coverage'));
  });

  it('accepts custom weight overrides', () => {
    // Both dims present, override weights to 50/50
    const signals = {
      test_coverage: { passing: true },       // 100
      review_findings: { findings: [{ severity: 'must-fix' }] }, // 80
    };
    // With custom weights 0.5/0.5, score = (100 + 80) / 2 = 90
    const { score } = computeCompositeScore(signals, {
      test_coverage: 0.5,
      review_findings: 0.5,
    });
    assert.equal(score, 90);
  });

  it('breakdown contains scores for present dimensions only', () => {
    const { breakdown } = computeCompositeScore({
      test_coverage: { passing: false },
    });
    assert.ok('test_coverage' in breakdown);
    assert.ok(!('review_findings' in breakdown));
  });
});
