/**
 * violation-detail.test.js — COMP-OBS-SURFACE S2 tests
 *
 * Tests the pure logic that backs ViolationDetail.jsx.
 * Four behaviours verified:
 *   1. Empty/null violations → display state is 'hidden' (component renders nothing)
 *   2. Non-empty violations, collapsed → header label includes count and collapsed chevron
 *   3. After toggle → expanded state shows expanded chevron
 *   4. Second toggle → returns to collapsed state
 *
 * Uses node:test — no DOM, no browser required.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  violationDisplayState,
  violationHeaderLabel,
  violationChevron,
  toggleViolationExpanded,
} from '../src/components/agent/violationDetailState.js';

// ─── 1. Empty violations → hidden ───────────────────────────────────────────

describe('violationDisplayState — empty array', () => {
  it('returns hidden for empty array', () => {
    assert.equal(violationDisplayState([], false), 'hidden');
  });

  it('returns hidden for null', () => {
    assert.equal(violationDisplayState(null, false), 'hidden');
  });

  it('returns hidden for undefined', () => {
    assert.equal(violationDisplayState(undefined, false), 'hidden');
  });

  it('returns hidden for empty array regardless of expanded flag', () => {
    assert.equal(violationDisplayState([], true), 'hidden');
  });
});

// ─── 2. Non-empty violations, collapsed ──────────────────────────────────────

describe('violationDisplayState — non-empty, collapsed', () => {
  it('returns collapsed when violations present and expanded=false', () => {
    assert.equal(violationDisplayState(['unused var'], false), 'collapsed');
  });

  it('returns collapsed for multiple violations', () => {
    assert.equal(violationDisplayState(['a', 'b', 'c'], false), 'collapsed');
  });
});

describe('violationHeaderLabel', () => {
  it('includes count in the label', () => {
    assert.equal(violationHeaderLabel(['a', 'b']), 'violations (2)');
  });

  it('works for a single violation', () => {
    assert.equal(violationHeaderLabel(['x']), 'violations (1)');
  });

  it('returns violations (0) for empty array', () => {
    assert.equal(violationHeaderLabel([]), 'violations (0)');
  });
});

describe('violationChevron — collapsed', () => {
  it('returns right-pointing chevron when not expanded', () => {
    assert.equal(violationChevron(false), '▸');
  });
});

// ─── 3. Toggle → expanded ────────────────────────────────────────────────────

describe('violationDisplayState — non-empty, expanded', () => {
  it('returns expanded when violations present and expanded=true', () => {
    assert.equal(violationDisplayState(['unused var'], true), 'expanded');
  });
});

describe('violationChevron — expanded', () => {
  it('returns downward chevron when expanded', () => {
    assert.equal(violationChevron(true), '▾');
  });
});

describe('toggleViolationExpanded — first click (collapse → expand)', () => {
  it('toggles false to true', () => {
    assert.equal(toggleViolationExpanded(false), true);
  });
});

// ─── 4. Second toggle → collapsed ────────────────────────────────────────────

describe('toggleViolationExpanded — second click (expand → collapse)', () => {
  it('toggles true back to false', () => {
    assert.equal(toggleViolationExpanded(true), false);
  });
});

describe('toggleViolationExpanded — full cycle', () => {
  it('collapsed → expanded → collapsed', () => {
    let expanded = false;
    expanded = toggleViolationExpanded(expanded); // click 1
    assert.equal(expanded, true);
    expanded = toggleViolationExpanded(expanded); // click 2
    assert.equal(expanded, false);
  });
});
