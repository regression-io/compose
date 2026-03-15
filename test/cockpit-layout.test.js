/**
 * cockpit-layout.test.js
 *
 * TDD tests for COMP-UI-1: Cockpit shell layout logic.
 * Tests cover the pure-logic modules that back the cockpit UI:
 *   - agentBarState.js  — state machine for the collapsible agent bar
 *   - viewTabsState.js  — logic for managing main-area view tabs
 *
 * Tests use node:test (the project's existing test runner).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// These imports will FAIL until the modules are created (red phase).
import {
  AGENT_BAR_STATES,
  nextAgentBarState,
  collapseAgentBar,
  expandAgentBar,
  maximizeAgentBar,
  isValidAgentBarState,
  agentBarHeightClass,
} from '../src/components/cockpit/agentBarState.js';

import {
  DEFAULT_MAIN_TABS,
  isValidTab,
  getDefaultTab,
  addTab,
  removeTab,
  reorderTabs,
} from '../src/components/cockpit/viewTabsState.js';

// ---------------------------------------------------------------------------
// agentBarState
// ---------------------------------------------------------------------------

describe('agentBarState — state constants', () => {
  it('exports the three canonical states', () => {
    assert.equal(AGENT_BAR_STATES.COLLAPSED, 'collapsed');
    assert.equal(AGENT_BAR_STATES.EXPANDED, 'expanded');
    assert.equal(AGENT_BAR_STATES.MAXIMIZED, 'maximized');
    assert.equal(Object.keys(AGENT_BAR_STATES).length, 3);
  });
});

describe('agentBarState — nextAgentBarState (cycle)', () => {
  it('collapsed → expanded', () => {
    assert.equal(nextAgentBarState('collapsed'), 'expanded');
  });

  it('expanded → maximized', () => {
    assert.equal(nextAgentBarState('expanded'), 'maximized');
  });

  it('maximized → collapsed', () => {
    assert.equal(nextAgentBarState('maximized'), 'collapsed');
  });

  it('unknown state falls back to collapsed', () => {
    assert.equal(nextAgentBarState('bogus'), 'collapsed');
    assert.equal(nextAgentBarState(null), 'collapsed');
    assert.equal(nextAgentBarState(undefined), 'collapsed');
  });
});

describe('agentBarState — direct transitions', () => {
  it('collapseAgentBar always returns collapsed', () => {
    assert.equal(collapseAgentBar('expanded'), 'collapsed');
    assert.equal(collapseAgentBar('maximized'), 'collapsed');
    assert.equal(collapseAgentBar('collapsed'), 'collapsed');
  });

  it('expandAgentBar always returns expanded', () => {
    assert.equal(expandAgentBar('collapsed'), 'expanded');
    assert.equal(expandAgentBar('maximized'), 'expanded');
    assert.equal(expandAgentBar('expanded'), 'expanded');
  });

  it('maximizeAgentBar always returns maximized', () => {
    assert.equal(maximizeAgentBar('collapsed'), 'maximized');
    assert.equal(maximizeAgentBar('expanded'), 'maximized');
    assert.equal(maximizeAgentBar('maximized'), 'maximized');
  });
});

describe('agentBarState — isValidAgentBarState', () => {
  it('accepts all three valid states', () => {
    assert.equal(isValidAgentBarState('collapsed'), true);
    assert.equal(isValidAgentBarState('expanded'), true);
    assert.equal(isValidAgentBarState('maximized'), true);
  });

  it('rejects invalid values', () => {
    assert.equal(isValidAgentBarState('open'), false);
    assert.equal(isValidAgentBarState(''), false);
    assert.equal(isValidAgentBarState(null), false);
    assert.equal(isValidAgentBarState(undefined), false);
  });
});

describe('agentBarState — agentBarHeightClass', () => {
  it('collapsed returns a non-empty string', () => {
    const cls = agentBarHeightClass('collapsed');
    assert.equal(typeof cls, 'string');
    assert.ok(cls.length > 0, 'should return a CSS class/style descriptor');
  });

  it('expanded returns a non-empty string different from collapsed', () => {
    const collapsed = agentBarHeightClass('collapsed');
    const expanded = agentBarHeightClass('expanded');
    assert.equal(typeof expanded, 'string');
    assert.notEqual(expanded, collapsed);
  });

  it('maximized returns a non-empty string', () => {
    const cls = agentBarHeightClass('maximized');
    assert.equal(typeof cls, 'string');
    assert.ok(cls.length > 0);
  });
});

// ---------------------------------------------------------------------------
// viewTabsState
// ---------------------------------------------------------------------------

describe('viewTabsState — DEFAULT_MAIN_TABS', () => {
  it('is a non-empty array', () => {
    assert.ok(Array.isArray(DEFAULT_MAIN_TABS));
    assert.ok(DEFAULT_MAIN_TABS.length >= 2);
  });

  it('contains all view keys in correct order', () => {
    const expected = ['tree', 'graph', 'docs', 'gates', 'pipeline', 'sessions'];
    for (const key of expected) {
      assert.ok(DEFAULT_MAIN_TABS.includes(key), `missing ${key}`);
    }
    // Working views before monitoring views
    assert.ok(DEFAULT_MAIN_TABS.indexOf('docs') < DEFAULT_MAIN_TABS.indexOf('pipeline'));
  });
});

describe('viewTabsState — isValidTab', () => {
  it('returns true for a tab in the list', () => {
    assert.equal(isValidTab(['Canvas', 'Stratum'], 'Canvas'), true);
  });

  it('returns false for a tab not in the list', () => {
    assert.equal(isValidTab(['Canvas', 'Stratum'], 'Bogus'), false);
  });

  it('returns false for empty/null tab name', () => {
    assert.equal(isValidTab(['Canvas'], ''), false);
    assert.equal(isValidTab(['Canvas'], null), false);
  });
});

describe('viewTabsState — getDefaultTab', () => {
  it('returns the first tab', () => {
    assert.equal(getDefaultTab(['Canvas', 'Stratum']), 'Canvas');
  });

  it('returns null for empty array', () => {
    assert.equal(getDefaultTab([]), null);
  });
});

describe('viewTabsState — addTab', () => {
  it('appends a new tab to the list', () => {
    const result = addTab(['Canvas', 'Stratum'], 'Graph');
    assert.deepEqual(result, ['Canvas', 'Stratum', 'Graph']);
  });

  it('does not add duplicates', () => {
    const result = addTab(['Canvas', 'Stratum'], 'Canvas');
    assert.deepEqual(result, ['Canvas', 'Stratum']);
  });
});

describe('viewTabsState — removeTab', () => {
  it('removes an existing tab', () => {
    const result = removeTab(['Canvas', 'Stratum', 'Graph'], 'Graph');
    assert.deepEqual(result, ['Canvas', 'Stratum']);
  });

  it('is a no-op if tab does not exist', () => {
    const result = removeTab(['Canvas', 'Stratum'], 'Bogus');
    assert.deepEqual(result, ['Canvas', 'Stratum']);
  });

  it('does not remove if only one tab remains', () => {
    // Cannot remove the last tab
    const result = removeTab(['Canvas'], 'Canvas');
    assert.deepEqual(result, ['Canvas']);
  });
});

describe('viewTabsState — reorderTabs', () => {
  it('moves a tab from one position to another', () => {
    const result = reorderTabs(['Canvas', 'Stratum', 'Graph'], 2, 0);
    assert.deepEqual(result, ['Graph', 'Canvas', 'Stratum']);
  });

  it('is a no-op when from === to', () => {
    const result = reorderTabs(['Canvas', 'Stratum'], 0, 0);
    assert.deepEqual(result, ['Canvas', 'Stratum']);
  });

  it('returns original array when indices are out of bounds', () => {
    const tabs = ['Canvas', 'Stratum'];
    const result = reorderTabs(tabs, -1, 5);
    assert.deepEqual(result, ['Canvas', 'Stratum']);
  });
});
