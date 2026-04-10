/**
 * Tests for capability-checker.js — COMP-CAPS-ENFORCE Item 194.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { checkCapabilityViolation } from '../lib/capability-checker.js';

describe('checkCapabilityViolation', () => {
  // No template — no restrictions
  it('returns no violation when agent has no template', () => {
    const r = checkCapabilityViolation('Edit', 'claude');
    assert.equal(r.violation, false);
    assert.equal(r.severity, 'none');
  });

  it('returns no violation when agent string is null', () => {
    const r = checkCapabilityViolation('Write', null);
    assert.equal(r.violation, false);
  });

  // read-only-reviewer: allowedTools=['Read','Grep','Glob','Agent'], disallowedTools=['Edit','Write','Bash']
  it('flags violation for disallowed tool', () => {
    const r = checkCapabilityViolation('Edit', 'claude:read-only-reviewer');
    assert.equal(r.violation, true);
    assert.equal(r.severity, 'violation');
    assert.match(r.reason, /disallowedTools/);
  });

  it('flags violation for another disallowed tool', () => {
    const r = checkCapabilityViolation('Write', 'claude:read-only-reviewer');
    assert.equal(r.violation, true);
    assert.equal(r.severity, 'violation');
  });

  it('flags warning for tool not in allowedTools (but not disallowed)', () => {
    // 'TodoWrite' is not in allowedTools and not in disallowedTools for read-only-reviewer
    const r = checkCapabilityViolation('TodoWrite', 'claude:read-only-reviewer');
    assert.equal(r.violation, true);
    assert.equal(r.severity, 'warning');
    assert.match(r.reason, /allowedTools/);
  });

  it('returns no violation for allowed tool', () => {
    const r = checkCapabilityViolation('Read', 'claude:read-only-reviewer');
    assert.equal(r.violation, false);
    assert.equal(r.severity, 'none');
  });

  it('returns no violation for allowed tool (Grep)', () => {
    const r = checkCapabilityViolation('Grep', 'claude:read-only-reviewer');
    assert.equal(r.violation, false);
  });

  // implementer: allowedTools=null, disallowedTools=null — unrestricted
  it('returns no violation for implementer template (unrestricted)', () => {
    const r = checkCapabilityViolation('Write', 'claude:implementer');
    assert.equal(r.violation, false);
    assert.equal(r.severity, 'none');
  });

  // orchestrator: allowedTools=['Read','Grep','Glob','Agent','Bash'], disallowedTools=['Edit','Write']
  it('flags violation for Edit used by orchestrator', () => {
    const r = checkCapabilityViolation('Edit', 'claude:orchestrator');
    assert.equal(r.violation, true);
    assert.equal(r.severity, 'violation');
  });

  it('returns no violation for Bash used by orchestrator', () => {
    const r = checkCapabilityViolation('Bash', 'claude:orchestrator');
    assert.equal(r.violation, false);
  });

  // Unknown template — treated as no restrictions
  it('returns no violation for unknown template', () => {
    const r = checkCapabilityViolation('Edit', 'claude:nonexistent-template');
    assert.equal(r.violation, false);
    assert.equal(r.severity, 'none');
  });
});
