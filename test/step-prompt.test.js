/**
 * Tests for lib/step-prompt.js — Step Prompt Builder.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStepPrompt, buildRetryPrompt, buildFlowStepPrompt } from '../lib/step-prompt.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fullDispatch = {
  step_id: 'generate-schema',
  intent: 'Generate the database schema from the domain model',
  inputs: { model: 'User', format: 'sql' },
  output_fields: [
    { name: 'schema', type: 'string' },
    { name: 'tableCount', type: 'number' },
  ],
  ensure: [
    'schema contains CREATE TABLE',
    'tableCount > 0',
  ],
};

const minimalDispatch = {
  step_id: 'noop-step',
  intent: 'Do nothing interesting',
  inputs: {},
  output_fields: [],
  ensure: [],
};

const context = {
  cwd: '/projects/my-app',
  featureCode: 'AUTH-1',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('builds prompt with all fields populated', () => {
  const prompt = buildStepPrompt(fullDispatch, context);

  // step_id
  assert.ok(prompt.includes('"generate-schema"'), 'should contain step_id');

  // intent
  assert.ok(prompt.includes('Generate the database schema from the domain model'), 'should contain intent');

  // inputs JSON
  assert.ok(prompt.includes('"model": "User"'), 'should contain inputs JSON');
  assert.ok(prompt.includes('"format": "sql"'), 'should contain inputs JSON field');

  // output fields section
  assert.ok(prompt.includes('## Expected Output'), 'should contain Expected Output section');
  assert.ok(prompt.includes('- schema (string)'), 'should list output field schema');
  assert.ok(prompt.includes('- tableCount (number)'), 'should list output field tableCount');

  // ensure section
  assert.ok(prompt.includes('## Postconditions'), 'should contain Postconditions section');
  assert.ok(prompt.includes('- schema contains CREATE TABLE'), 'should list ensure expression');
  assert.ok(prompt.includes('- tableCount > 0'), 'should list ensure expression');

  // context section
  assert.ok(prompt.includes('## Context'), 'should contain Context section');
  assert.ok(prompt.includes('Working directory: /projects/my-app'), 'should contain cwd');
  assert.ok(prompt.includes('Feature: AUTH-1'), 'should contain featureCode');
});

test('builds prompt with minimal fields (no ensure, no output_fields)', () => {
  const prompt = buildStepPrompt(minimalDispatch, context);

  // Should contain intent and context
  assert.ok(prompt.includes('## Intent'), 'should contain Intent section');
  assert.ok(prompt.includes('Do nothing interesting'), 'should contain intent text');
  assert.ok(prompt.includes('## Context'), 'should contain Context section');

  // Should NOT contain optional sections
  assert.ok(!prompt.includes('## Expected Output'), 'should not contain Expected Output');
  assert.ok(!prompt.includes('## Postconditions'), 'should not contain Postconditions');
});

test('retry prompt includes violations before the main prompt', () => {
  const violations = [
    'schema was empty',
    'tableCount was -1',
  ];

  const prompt = buildRetryPrompt(fullDispatch, violations, context);

  // RETRY header present
  assert.ok(prompt.includes('RETRY'), 'should contain RETRY header');
  assert.ok(prompt.includes('- schema was empty'), 'should list first violation');
  assert.ok(prompt.includes('- tableCount was -1'), 'should list second violation');

  // Violations appear before intent
  const retryIndex = prompt.indexOf('RETRY');
  const intentIndex = prompt.indexOf('## Intent');
  assert.ok(retryIndex < intentIndex, 'RETRY header should appear before intent');
});

test('flow step prompt includes child flow context', () => {
  const flowDispatch = {
    child_flow_name: 'migration-flow',
    child_step: fullDispatch,
  };

  const prompt = buildFlowStepPrompt(flowDispatch, context);

  // sub-workflow text
  assert.ok(prompt.includes('sub-workflow'), 'should contain sub-workflow text');
  assert.ok(prompt.includes('"migration-flow"'), 'should contain child flow name');

  // child step details carried through
  assert.ok(prompt.includes('"generate-schema"'), 'should contain child step_id');
  assert.ok(prompt.includes('Generate the database schema'), 'should contain child intent');
  assert.ok(prompt.includes('## Context'), 'should contain context section');
});

// ---------------------------------------------------------------------------
// T10 — buildRetryPrompt with conflicts (STRAT-PAR-2)
// ---------------------------------------------------------------------------

test('T10.1 — buildRetryPrompt with 3 args (no conflicts arg) — no conflict section', () => {
  const violations = ['schema was empty'];
  const prompt = buildRetryPrompt(fullDispatch, violations, context);

  assert.ok(prompt.includes('RETRY'), 'should contain RETRY header');
  assert.ok(!prompt.includes('File Ownership Conflicts'), 'should NOT contain conflict section');
});

test('T10.2 — buildRetryPrompt with conflicts=undefined — no conflict section', () => {
  const violations = ['schema was empty'];
  const prompt = buildRetryPrompt(fullDispatch, violations, context, undefined);

  assert.ok(!prompt.includes('File Ownership Conflicts'), 'should NOT contain conflict section');
});

test('T10.3 — buildRetryPrompt with conflicts=[] — no conflict section', () => {
  const violations = ['schema was empty'];
  const prompt = buildRetryPrompt(fullDispatch, violations, context, []);

  assert.ok(!prompt.includes('File Ownership Conflicts'), 'should NOT contain conflict section');
});

test('T10.4 — buildRetryPrompt with one conflict — File Ownership Conflicts section present', () => {
  const violations = ['File ownership conflicts detected'];
  const conflicts = [{ task_a: 'task-a', task_b: 'task-b', files: ['src/x.js'] }];
  const prompt = buildRetryPrompt(fullDispatch, violations, context, conflicts);

  assert.ok(prompt.includes('File Ownership Conflicts'), 'should contain conflict section header');
  assert.ok(prompt.includes('task-a'), 'should mention task-a');
  assert.ok(prompt.includes('task-b'), 'should mention task-b');
  assert.ok(prompt.includes('src/x.js'), 'should list the conflicting file');
  assert.ok(prompt.includes('depends_on'), 'should include depends_on guidance');
});

test('T10.5 — buildRetryPrompt with two conflict pairs — both listed', () => {
  const violations = ['File ownership conflicts detected'];
  const conflicts = [
    { task_a: 'task-001', task_b: 'task-002', files: ['src/foo.js'] },
    { task_a: 'task-003', task_b: 'task-004', files: ['src/bar.js', 'src/baz.js'] },
  ];
  const prompt = buildRetryPrompt(fullDispatch, violations, context, conflicts);

  assert.ok(prompt.includes('task-001'), 'should mention task-001');
  assert.ok(prompt.includes('task-002'), 'should mention task-002');
  assert.ok(prompt.includes('task-003'), 'should mention task-003');
  assert.ok(prompt.includes('task-004'), 'should mention task-004');
  assert.ok(prompt.includes('src/foo.js'), 'should list src/foo.js');
  assert.ok(prompt.includes('src/bar.js'), 'should list src/bar.js');
  assert.ok(prompt.includes('src/baz.js'), 'should list src/baz.js');
});
