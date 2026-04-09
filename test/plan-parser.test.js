/**
 * Tests for lib/plan-parser.js (COMP-PLAN-VERIFY)
 * Run with: node --test test/plan-parser.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanItems, matchItemsToDiff } from '../lib/plan-parser.js';

// ---------------------------------------------------------------------------
// parsePlanItems
// ---------------------------------------------------------------------------

describe('parsePlanItems', () => {
  it('extracts unchecked checkbox items', () => {
    const md = `
# Plan

- [ ] Implement \`lib/plan-parser.js\` helper
- [ ] Add ensure builtin to \`spec.py\`
`;
    const items = parsePlanItems(md);
    assert.equal(items.length, 2);
    assert.equal(items[0].text, 'Implement `lib/plan-parser.js` helper');
    assert.equal(items[0].file, 'lib/plan-parser.js');
    assert.equal(items[1].file, 'spec.py');
  });

  it('extracts checked checkbox items too', () => {
    const md = `- [x] Already done \`done.js\`\n- [X] Also done \`also.js\``;
    const items = parsePlanItems(md);
    assert.equal(items.length, 2);
    assert.equal(items[0].file, 'done.js');
    assert.equal(items[1].file, 'also.js');
  });

  it('marks critical items when text contains MUST', () => {
    const md = `- [ ] MUST implement authentication in \`auth.js\``;
    const items = parsePlanItems(md);
    assert.equal(items[0].critical, true);
  });

  it('marks critical items when text contains "required"', () => {
    const md = `- [ ] This is required: update \`core.js\``;
    const items = parsePlanItems(md);
    assert.equal(items[0].critical, true);
  });

  it('marks critical items when text contains "test"', () => {
    const md = `- [ ] Write tests for \`parser.js\``;
    const items = parsePlanItems(md);
    assert.equal(items[0].critical, true);
  });

  it('marks non-critical items correctly', () => {
    const md = `- [ ] Update README.md with usage examples`;
    const items = parsePlanItems(md);
    assert.equal(items[0].critical, false);
  });

  it('handles items without file references', () => {
    const md = `- [ ] Update the documentation\n- [ ] Review PR`;
    const items = parsePlanItems(md);
    assert.equal(items.length, 2);
    assert.equal(items[0].file, null);
    assert.equal(items[1].file, null);
  });

  it('ignores non-checkbox lines', () => {
    const md = `
# Heading

Some prose text.

- [ ] Actual checkbox \`file.js\`

- A bullet without checkbox
`;
    const items = parsePlanItems(md);
    assert.equal(items.length, 1);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(parsePlanItems(''), []);
    assert.deepEqual(parsePlanItems(null), []);
    assert.deepEqual(parsePlanItems(undefined), []);
  });
});

// ---------------------------------------------------------------------------
// matchItemsToDiff
// ---------------------------------------------------------------------------

describe('matchItemsToDiff', () => {
  it('classifies done items when file is in filesChanged', () => {
    const items = [
      { text: 'Implement parser', file: 'lib/plan-parser.js', critical: false },
      { text: 'Add builtin', file: 'spec.py', critical: false },
    ];
    const files = ['lib/plan-parser.js', 'spec.py'];
    const { done, missing, extra } = matchItemsToDiff(items, files);
    assert.equal(done.length, 2);
    assert.equal(missing.length, 0);
    assert.equal(extra.length, 0);
  });

  it('classifies missing items when file not in filesChanged', () => {
    const items = [
      { text: 'Implement parser', file: 'lib/plan-parser.js', critical: false },
      { text: 'Add builtin', file: 'spec.py', critical: false },
    ];
    const files = ['lib/plan-parser.js'];
    const { done, missing } = matchItemsToDiff(items, files);
    assert.equal(done.length, 1);
    assert.equal(missing.length, 1);
    assert.equal(missing[0].file, 'spec.py');
  });

  it('identifies extra files as scope creep', () => {
    const items = [
      { text: 'Implement parser', file: 'lib/plan-parser.js', critical: false },
    ];
    const files = ['lib/plan-parser.js', 'lib/unplanned.js', 'test/surprise.test.js'];
    const { extra } = matchItemsToDiff(items, files);
    assert.equal(extra.length, 2);
    assert.ok(extra.includes('lib/unplanned.js'));
    assert.ok(extra.includes('test/surprise.test.js'));
  });

  it('handles items without file references as done', () => {
    const items = [
      { text: 'Update docs', file: null, critical: false },
      { text: 'Review PR', file: null, critical: false },
    ];
    const { done, missing } = matchItemsToDiff(items, []);
    assert.equal(done.length, 2);
    assert.equal(missing.length, 0);
  });

  it('preserves critical flag on missing items', () => {
    const items = [
      { text: 'MUST add auth', file: 'auth.js', critical: true },
    ];
    const { missing } = matchItemsToDiff(items, []);
    assert.equal(missing[0].critical, true);
  });

  it('handles empty inputs gracefully', () => {
    const { done, missing, extra } = matchItemsToDiff([], []);
    assert.equal(done.length, 0);
    assert.equal(missing.length, 0);
    assert.equal(extra.length, 0);
  });

  it('handles null filesChanged gracefully', () => {
    const items = [{ text: 'Task', file: 'a.js', critical: false }];
    const { missing } = matchItemsToDiff(items, null);
    assert.equal(missing.length, 1);
  });
});
