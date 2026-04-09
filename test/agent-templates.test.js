/**
 * Tests for COMP-AGENT-CAPS:
 *   - server/agent-templates.js: AGENT_TEMPLATES, resolveTemplate, validateCapabilities
 *   - lib/agent-string.js: parseAgentString, resolveAgentConfig
 *   - server/connectors/claude-sdk-connector.js: tool restriction opts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_TEMPLATES, resolveTemplate, validateCapabilities } from '../server/agent-templates.js';
import { parseAgentString, resolveAgentConfig } from '../lib/agent-string.js';

// ---------------------------------------------------------------------------
// resolveTemplate
// ---------------------------------------------------------------------------

describe('resolveTemplate', () => {
  test('returns correct template for read-only-reviewer', () => {
    const t = resolveTemplate('read-only-reviewer');
    assert.ok(t, 'should return a template');
    assert.deepStrictEqual(t.allowedTools, ['Read', 'Grep', 'Glob', 'Agent']);
    assert.deepStrictEqual(t.disallowedTools, ['Edit', 'Write', 'Bash']);
    assert.strictEqual(t.description, 'Read-only review agent');
  });

  test('returns correct template for implementer', () => {
    const t = resolveTemplate('implementer');
    assert.ok(t, 'should return a template');
    assert.strictEqual(t.allowedTools, null);
    assert.strictEqual(t.disallowedTools, null);
  });

  test('returns correct template for orchestrator', () => {
    const t = resolveTemplate('orchestrator');
    assert.ok(t, 'should return a template');
    assert.deepStrictEqual(t.allowedTools, ['Read', 'Grep', 'Glob', 'Agent', 'Bash']);
    assert.deepStrictEqual(t.disallowedTools, ['Edit', 'Write']);
  });

  test('returns correct template for security-auditor', () => {
    const t = resolveTemplate('security-auditor');
    assert.ok(t, 'should return a template');
    assert.deepStrictEqual(t.allowedTools, ['Read', 'Grep', 'Glob', 'Bash']);
    assert.deepStrictEqual(t.disallowedTools, ['Edit', 'Write']);
  });

  test('returns null for unknown template name', () => {
    assert.strictEqual(resolveTemplate('nonexistent-role'), null);
  });

  test('returns null for null input', () => {
    assert.strictEqual(resolveTemplate(null), null);
  });

  test('returns null for undefined input', () => {
    assert.strictEqual(resolveTemplate(undefined), null);
  });
});

// ---------------------------------------------------------------------------
// validateCapabilities
// ---------------------------------------------------------------------------

describe('validateCapabilities', () => {
  test('allows all tools when template is null', () => {
    const result = validateCapabilities(null, 'Edit');
    assert.strictEqual(result.allowed, true);
  });

  test('denies tool in disallowedTools', () => {
    const template = resolveTemplate('read-only-reviewer');
    const result = validateCapabilities(template, 'Edit');
    assert.strictEqual(result.allowed, false);
    assert.match(result.reason, /disallowedTools/);
  });

  test('allows tool in allowedTools', () => {
    const template = resolveTemplate('read-only-reviewer');
    const result = validateCapabilities(template, 'Read');
    assert.strictEqual(result.allowed, true);
  });

  test('denies tool not in allowedTools (when allowedTools is set)', () => {
    const template = resolveTemplate('read-only-reviewer');
    const result = validateCapabilities(template, 'Bash');
    assert.strictEqual(result.allowed, false);
    // Bash is in disallowedTools so the deny reason should mention it
    assert.match(result.reason, /disallowedTools/);
  });

  test('allows all tools for implementer (null restrictions)', () => {
    const template = resolveTemplate('implementer');
    const edit = validateCapabilities(template, 'Edit');
    const bash = validateCapabilities(template, 'Bash');
    assert.strictEqual(edit.allowed, true);
    assert.strictEqual(bash.allowed, true);
  });

  test('denies Edit for orchestrator', () => {
    const template = resolveTemplate('orchestrator');
    const result = validateCapabilities(template, 'Edit');
    assert.strictEqual(result.allowed, false);
  });

  test('allows Bash for orchestrator', () => {
    const template = resolveTemplate('orchestrator');
    const result = validateCapabilities(template, 'Bash');
    assert.strictEqual(result.allowed, true);
  });
});

// ---------------------------------------------------------------------------
// parseAgentString
// ---------------------------------------------------------------------------

describe('parseAgentString', () => {
  test('parses "claude:read-only-reviewer"', () => {
    const r = parseAgentString('claude:read-only-reviewer');
    assert.strictEqual(r.provider, 'claude');
    assert.strictEqual(r.template, 'read-only-reviewer');
  });

  test('parses "claude" (no template)', () => {
    const r = parseAgentString('claude');
    assert.strictEqual(r.provider, 'claude');
    assert.strictEqual(r.template, null);
  });

  test('parses "codex" (no template)', () => {
    const r = parseAgentString('codex');
    assert.strictEqual(r.provider, 'codex');
    assert.strictEqual(r.template, null);
  });

  test('parses null → default claude', () => {
    const r = parseAgentString(null);
    assert.strictEqual(r.provider, 'claude');
    assert.strictEqual(r.template, null);
  });

  test('parses undefined → default claude', () => {
    const r = parseAgentString(undefined);
    assert.strictEqual(r.provider, 'claude');
    assert.strictEqual(r.template, null);
  });

  test('parses "claude:orchestrator"', () => {
    const r = parseAgentString('claude:orchestrator');
    assert.strictEqual(r.provider, 'claude');
    assert.strictEqual(r.template, 'orchestrator');
  });
});

// ---------------------------------------------------------------------------
// resolveAgentConfig
// ---------------------------------------------------------------------------

describe('resolveAgentConfig', () => {
  test('resolves "claude:read-only-reviewer" with allowedTools/disallowedTools', () => {
    const cfg = resolveAgentConfig('claude:read-only-reviewer');
    assert.strictEqual(cfg.provider, 'claude');
    assert.strictEqual(cfg.template, 'read-only-reviewer');
    assert.deepStrictEqual(cfg.allowedTools, ['Read', 'Grep', 'Glob', 'Agent']);
    assert.deepStrictEqual(cfg.disallowedTools, ['Edit', 'Write', 'Bash']);
  });

  test('resolves "claude" with null restrictions (backward compat)', () => {
    const cfg = resolveAgentConfig('claude');
    assert.strictEqual(cfg.provider, 'claude');
    assert.strictEqual(cfg.template, null);
    assert.strictEqual(cfg.allowedTools, null);
    assert.strictEqual(cfg.disallowedTools, null);
  });

  test('resolves null → claude with null restrictions', () => {
    const cfg = resolveAgentConfig(null);
    assert.strictEqual(cfg.provider, 'claude');
    assert.strictEqual(cfg.template, null);
    assert.strictEqual(cfg.allowedTools, null);
    assert.strictEqual(cfg.disallowedTools, null);
  });

  test('resolves "claude:orchestrator" with correct restrictions', () => {
    const cfg = resolveAgentConfig('claude:orchestrator');
    assert.strictEqual(cfg.provider, 'claude');
    assert.deepStrictEqual(cfg.allowedTools, ['Read', 'Grep', 'Glob', 'Agent', 'Bash']);
    assert.deepStrictEqual(cfg.disallowedTools, ['Edit', 'Write']);
  });

  test('resolves unknown template with null restrictions (graceful fallback)', () => {
    const cfg = resolveAgentConfig('claude:unknown-role');
    assert.strictEqual(cfg.provider, 'claude');
    assert.strictEqual(cfg.template, 'unknown-role');
    assert.strictEqual(cfg.allowedTools, null);
    assert.strictEqual(cfg.disallowedTools, null);
  });
});

// ---------------------------------------------------------------------------
// ClaudeSDKConnector constructor options (structural, no SDK call needed)
// ---------------------------------------------------------------------------

describe('ClaudeSDKConnector tool restriction opts', () => {
  test('connector accepts allowedTools and disallowedTools without throwing', async () => {
    // Dynamic import to avoid top-level SDK side effects in test suite
    const { ClaudeSDKConnector } = await import('../server/connectors/claude-sdk-connector.js');

    // Constructor should not throw when given tool restriction opts
    assert.doesNotThrow(() => {
      new ClaudeSDKConnector({
        allowedTools: ['Read', 'Grep'],
        disallowedTools: ['Edit', 'Write'],
      });
    });
  });

  test('connector accepts no tool opts (backward compat — preset mode)', async () => {
    const { ClaudeSDKConnector } = await import('../server/connectors/claude-sdk-connector.js');

    assert.doesNotThrow(() => {
      new ClaudeSDKConnector({});
    });
  });

  test('connector accepts only disallowedTools', async () => {
    const { ClaudeSDKConnector } = await import('../server/connectors/claude-sdk-connector.js');

    assert.doesNotThrow(() => {
      new ClaudeSDKConnector({ disallowedTools: ['Edit'] });
    });
  });
});
