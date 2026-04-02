import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  violationDisplayState,
  violationHeaderLabel,
  violationChevron,
  toggleViolationExpanded,
} from '../src/components/agent/violationDetailState.js';

describe('violationDisplayState', () => {
  it('returns hidden when violations is empty', () => {
    assert.equal(violationDisplayState([], false), 'hidden');
  });

  it('returns hidden when violations is null', () => {
    assert.equal(violationDisplayState(null, false), 'hidden');
  });

  it('returns hidden when violations is undefined', () => {
    assert.equal(violationDisplayState(undefined, false), 'hidden');
  });

  it('returns collapsed when violations present and not expanded', () => {
    assert.equal(violationDisplayState(['fail'], false), 'collapsed');
  });

  it('returns expanded when violations present and expanded', () => {
    assert.equal(violationDisplayState(['fail'], true), 'expanded');
  });
});

describe('violationHeaderLabel', () => {
  it('returns "violations (0)" for empty array', () => {
    assert.equal(violationHeaderLabel([]), 'violations (0)');
  });

  it('returns count for non-empty array', () => {
    assert.equal(violationHeaderLabel(['a', 'b', 'c']), 'violations (3)');
  });

  it('handles non-array input', () => {
    assert.equal(violationHeaderLabel(null), 'violations (0)');
  });
});

describe('violationChevron', () => {
  it('returns ▸ when collapsed', () => {
    assert.equal(violationChevron(false), '▸');
  });

  it('returns ▾ when expanded', () => {
    assert.equal(violationChevron(true), '▾');
  });
});

describe('toggleViolationExpanded', () => {
  it('toggles false to true', () => {
    assert.equal(toggleViolationExpanded(false), true);
  });

  it('toggles true to false', () => {
    assert.equal(toggleViolationExpanded(true), false);
  });
});
