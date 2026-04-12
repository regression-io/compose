import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  triageLenses,
  classifyDiffSize,
  shouldRunCrossModel,
  LENS_DEFINITIONS,
} from '../lib/review-lenses.js';

const REQUIRED_FIELDS = ['id', 'lens_name', 'lens_focus', 'confidence_gate', 'exclusions'];

describe('classifyDiffSize', () => {
  it('returns small for 0 files', () => {
    assert.equal(classifyDiffSize([]), 'small');
  });

  it('returns small for 1 file', () => {
    assert.equal(classifyDiffSize(['a.js']), 'small');
  });

  it('returns small for 2 files', () => {
    assert.equal(classifyDiffSize(['a.js', 'b.js']), 'small');
  });

  it('returns medium for 3 files', () => {
    assert.equal(classifyDiffSize(['a.js', 'b.js', 'c.js']), 'medium');
  });

  it('returns medium for 8 files', () => {
    assert.equal(classifyDiffSize(Array.from({ length: 8 }, (_, i) => `f${i}.js`)), 'medium');
  });

  it('returns large for 9 files', () => {
    assert.equal(classifyDiffSize(Array.from({ length: 9 }, (_, i) => `f${i}.js`)), 'large');
  });

  it('returns large for 20 files', () => {
    assert.equal(classifyDiffSize(Array.from({ length: 20 }, (_, i) => `f${i}.js`)), 'large');
  });

  it('handles non-array input gracefully (null → small)', () => {
    assert.equal(classifyDiffSize(null), 'small');
  });
});

describe('shouldRunCrossModel', () => {
  it('returns false for small diff (2 files)', () => {
    assert.equal(shouldRunCrossModel(['a.js', 'b.js']), false);
  });

  it('returns false for medium diff (5 files)', () => {
    assert.equal(shouldRunCrossModel(Array.from({ length: 5 }, (_, i) => `f${i}.js`)), false);
  });

  it('returns true for large diff (9 files)', () => {
    assert.equal(shouldRunCrossModel(Array.from({ length: 9 }, (_, i) => `f${i}.js`)), true);
  });

  it('returns true for large diff (15 files)', () => {
    assert.equal(shouldRunCrossModel(Array.from({ length: 15 }, (_, i) => `f${i}.js`)), true);
  });

  it('returns false for empty file list', () => {
    assert.equal(shouldRunCrossModel([]), false);
  });
});

describe('triageLenses', () => {
  it('returns baseline lenses for any file list', () => {
    const tasks = triageLenses(['README.md']);
    const ids = tasks.map(t => t.id);
    assert.ok(ids.includes('diff-quality'), 'missing diff-quality');
    assert.ok(ids.includes('contract-compliance'), 'missing contract-compliance');
  });

  it('adds security lens for auth files', () => {
    const tasks = triageLenses(['src/auth/login.js']);
    const ids = tasks.map(t => t.id);
    assert.ok(ids.includes('security'), 'missing security lens for auth file');
  });

  it('adds security lens for SQL files', () => {
    const tasks = triageLenses(['db/query.sql']);
    const ids = tasks.map(t => t.id);
    assert.ok(ids.includes('security'), 'missing security lens for SQL file');
  });

  it('adds framework lens for JSX files', () => {
    const tasks = triageLenses(['src/App.jsx']);
    const ids = tasks.map(t => t.id);
    assert.ok(ids.includes('framework'), 'missing framework lens for JSX file');
  });

  it('adds framework lens for Next.js config', () => {
    const tasks = triageLenses(['next.config.js']);
    const ids = tasks.map(t => t.id);
    assert.ok(ids.includes('framework'), 'missing framework lens for Next.js config');
  });

  it('returns all 4 lenses when both triggers present', () => {
    const tasks = triageLenses(['src/auth/login.jsx']);
    const ids = tasks.map(t => t.id);
    assert.equal(ids.length, 4, `expected 4 lenses, got ${ids.length}: ${ids}`);
    assert.ok(ids.includes('diff-quality'));
    assert.ok(ids.includes('contract-compliance'));
    assert.ok(ids.includes('security'));
    assert.ok(ids.includes('framework'));
  });

  it('does not duplicate baseline lenses when triggers overlap', () => {
    const tasks = triageLenses(['src/auth/login.jsx']);
    const ids = tasks.map(t => t.id);
    const diffQualityCount = ids.filter(id => id === 'diff-quality').length;
    assert.equal(diffQualityCount, 1, 'diff-quality should appear exactly once');
  });

  it('each LensTask has required fields', () => {
    const tasks = triageLenses(['src/auth/login.jsx']);
    for (const task of tasks) {
      for (const field of REQUIRED_FIELDS) {
        assert.ok(
          field in task,
          `lens ${task.id || 'unknown'} missing field: ${field}`
        );
      }
    }
  });

});

describe('lens reasoning_template', () => {
  const LENS_IDS = ['diff-quality', 'contract-compliance', 'security', 'framework'];

  it('every lens has a reasoning_template object', () => {
    for (const id of LENS_IDS) {
      const def = LENS_DEFINITIONS[id];
      assert.ok(def.reasoning_template, `${id} missing reasoning_template`);
      assert.equal(typeof def.reasoning_template, 'object');
    }
  });

  it('every reasoning_template has require_citations: true', () => {
    for (const id of LENS_IDS) {
      assert.strictEqual(
        LENS_DEFINITIONS[id].reasoning_template.require_citations,
        true,
        `${id} missing require_citations`
      );
    }
  });

  it('every reasoning_template has exactly 3 sections', () => {
    for (const id of LENS_IDS) {
      const sections = LENS_DEFINITIONS[id].reasoning_template.sections;
      assert.ok(Array.isArray(sections), `${id} sections not an array`);
      assert.equal(sections.length, 3, `${id} expected 3 sections, got ${sections.length}`);
    }
  });

  it('every section has id, label, description', () => {
    for (const id of LENS_IDS) {
      for (const section of LENS_DEFINITIONS[id].reasoning_template.sections) {
        assert.ok(section.id, `${id} section missing id`);
        assert.ok(section.label, `${id} section missing label`);
        assert.ok(section.description, `${id} section missing description`);
      }
    }
  });

  it('first section is always premises', () => {
    for (const id of LENS_IDS) {
      const first = LENS_DEFINITIONS[id].reasoning_template.sections[0];
      assert.equal(first.id, 'premises', `${id} first section should be premises`);
    }
  });

  it('last section is always findings', () => {
    for (const id of LENS_IDS) {
      const sections = LENS_DEFINITIONS[id].reasoning_template.sections;
      const last = sections[sections.length - 1];
      assert.equal(last.id, 'findings', `${id} last section should be findings, got ${last.id}`);
    }
  });

  it('triageLenses returns tasks that still include reasoning_template', () => {
    const tasks = triageLenses(['src/auth/login.jsx']);
    for (const task of tasks) {
      assert.ok(task.reasoning_template, `triage task ${task.id} missing reasoning_template`);
    }
  });
});
