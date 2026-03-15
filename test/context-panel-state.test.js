/**
 * context-panel-state.test.js
 *
 * Tests for context panel width computation and detail tab definitions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTEXT_WIDTH_DEFAULTS,
  CONTEXT_HIDDEN_VIEWS,
  CONTEXT_MIN_FRACTION,
  CONTEXT_MAX_FRACTION,
  getContextWidth,
  clampFraction,
  DETAIL_TABS,
  DETAIL_TAB_IDS,
  isValidDetailTab,
} from '../src/components/cockpit/contextPanelState.js';

// ---------------------------------------------------------------------------
// Width defaults
// ---------------------------------------------------------------------------

describe('contextPanelState — width defaults', () => {
  it('graph defaults to 0.4', () => {
    assert.equal(CONTEXT_WIDTH_DEFAULTS.graph, 0.4);
  });

  it('tree defaults to 0.5', () => {
    assert.equal(CONTEXT_WIDTH_DEFAULTS.tree, 0.5);
  });

  it('docs is a hidden view', () => {
    assert.ok(CONTEXT_HIDDEN_VIEWS.has('docs'));
  });

  it('graph is not a hidden view', () => {
    assert.ok(!CONTEXT_HIDDEN_VIEWS.has('graph'));
  });
});

// ---------------------------------------------------------------------------
// getContextWidth
// ---------------------------------------------------------------------------

describe('contextPanelState — getContextWidth', () => {
  it('returns 0 for hidden views', () => {
    assert.equal(getContextWidth('docs'), 0);
  });

  it('returns default for known view without override', () => {
    assert.equal(getContextWidth('graph'), 0.4);
    assert.equal(getContextWidth('tree'), 0.5);
  });

  it('returns 0.4 fallback for unknown view', () => {
    assert.equal(getContextWidth('unknown-view'), 0.4);
  });

  it('uses override when present', () => {
    assert.equal(getContextWidth('graph', { graph: 0.35 }), 0.35);
  });

  it('clamps override to min', () => {
    assert.equal(getContextWidth('graph', { graph: 0.05 }), CONTEXT_MIN_FRACTION);
  });

  it('clamps override to max', () => {
    assert.equal(getContextWidth('graph', { graph: 0.9 }), CONTEXT_MAX_FRACTION);
  });

  it('hidden view returns 0 even with override', () => {
    assert.equal(getContextWidth('docs', { docs: 0.5 }), 0);
  });
});

// ---------------------------------------------------------------------------
// clampFraction
// ---------------------------------------------------------------------------

describe('contextPanelState — clampFraction', () => {
  it('passes through valid fraction', () => {
    assert.equal(clampFraction(0.4), 0.4);
  });

  it('clamps below min', () => {
    assert.equal(clampFraction(0.1), CONTEXT_MIN_FRACTION);
  });

  it('clamps above max', () => {
    assert.equal(clampFraction(0.8), CONTEXT_MAX_FRACTION);
  });
});

// ---------------------------------------------------------------------------
// Detail tabs
// ---------------------------------------------------------------------------

describe('contextPanelState — detail tabs', () => {
  it('defines 5 tabs', () => {
    assert.equal(DETAIL_TABS.length, 5);
  });

  it('tab ids match expected set', () => {
    assert.deepEqual(DETAIL_TAB_IDS, ['overview', 'pipeline', 'sessions', 'errors', 'files']);
  });

  it('isValidDetailTab accepts known tabs', () => {
    assert.ok(isValidDetailTab('overview'));
    assert.ok(isValidDetailTab('pipeline'));
    assert.ok(isValidDetailTab('files'));
  });

  it('isValidDetailTab rejects unknown tabs', () => {
    assert.ok(!isValidDetailTab('unknown'));
    assert.ok(!isValidDetailTab(''));
  });

  it('every tab has id and label', () => {
    for (const tab of DETAIL_TABS) {
      assert.ok(tab.id, `tab missing id`);
      assert.ok(tab.label, `tab ${tab.id} missing label`);
    }
  });
});
