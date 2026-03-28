import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  triageLenses,
} from '../lib/review-lenses.js';

const REQUIRED_FIELDS = ['id', 'lens_name', 'lens_focus', 'confidence_gate', 'exclusions'];

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
