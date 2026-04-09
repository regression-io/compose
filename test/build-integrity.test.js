/**
 * Tests for STRAT-IMMUTABLE: verifyPipelineIntegrity and verifyPolicyIntegrity.
 *
 * These are pure unit tests — no Stratum MCP server required.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, rmSync, mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { verifyPipelineIntegrity, verifyPolicyIntegrity } from '../lib/build.js';
import { StratumError } from '../lib/stratum-mcp-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'build-integrity-'));
}

// ---------------------------------------------------------------------------
// verifyPipelineIntegrity
// ---------------------------------------------------------------------------

describe('verifyPipelineIntegrity', () => {
  test('passes with unchanged file content', () => {
    const dir = makeTmp();
    try {
      const specPath = join(dir, 'pipeline.yaml');
      const content = 'version: "0.3"\nflows:\n  build:\n    steps: []\n';
      writeFileSync(specPath, content);
      const hash = sha256(content);

      // Must not throw
      verifyPipelineIntegrity(specPath, hash);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('throws PIPELINE_MODIFIED when file content differs', () => {
    const dir = makeTmp();
    try {
      const specPath = join(dir, 'pipeline.yaml');
      const original = 'version: "0.3"\nflows:\n  build:\n    steps: []\n';
      const modified = 'version: "0.3"\nflows:\n  build:\n    steps: [tampered]\n';
      writeFileSync(specPath, modified);  // write modified content
      const hash = sha256(original);     // hash of original

      assert.throws(
        () => verifyPipelineIntegrity(specPath, hash),
        (err) => {
          assert.ok(err instanceof StratumError, 'expected StratumError');
          assert.equal(err.code, 'PIPELINE_MODIFIED');
          return true;
        }
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('throws PIPELINE_MODIFIED when file is missing at verify time', () => {
    const dir = makeTmp();
    try {
      const specPath = join(dir, 'missing.yaml');
      // File does not exist — should throw PIPELINE_MODIFIED (not a crash)
      assert.throws(
        () => verifyPipelineIntegrity(specPath, 'anyhash'),
        (err) => {
          assert.ok(err instanceof StratumError, 'expected StratumError');
          assert.equal(err.code, 'PIPELINE_MODIFIED');
          return true;
        }
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// verifyPolicyIntegrity
// ---------------------------------------------------------------------------

describe('verifyPolicyIntegrity', () => {
  test('passes with unchanged settings', () => {
    const dir = makeTmp();
    try {
      const settingsPath = join(dir, 'settings.json');
      const policies = { 'ship': 'skip', 'review': 'flag' };
      writeFileSync(settingsPath, JSON.stringify({ policies }));
      const hash = sha256(JSON.stringify(policies));

      // Must not throw
      verifyPolicyIntegrity(settingsPath, hash);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('throws POLICY_MODIFIED when policy fields change', () => {
    const dir = makeTmp();
    try {
      const settingsPath = join(dir, 'settings.json');
      const original = { 'ship': 'skip' };
      const tampered = { 'ship': 'gate' };  // weakened gate policy
      writeFileSync(settingsPath, JSON.stringify({ policies: tampered }));
      const hash = sha256(JSON.stringify(original));

      assert.throws(
        () => verifyPolicyIntegrity(settingsPath, hash),
        (err) => {
          assert.ok(err instanceof StratumError, 'expected StratumError');
          assert.equal(err.code, 'POLICY_MODIFIED');
          return true;
        }
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('does not throw (graceful degradation) when settings.json is missing', () => {
    const dir = makeTmp();
    try {
      const settingsPath = join(dir, 'settings.json');
      // File does not exist — should silently pass (graceful degradation)
      assert.doesNotThrow(() => verifyPolicyIntegrity(settingsPath, 'anyhash'));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('passes when policies field is absent (treated as empty object)', () => {
    const dir = makeTmp();
    try {
      const settingsPath = join(dir, 'settings.json');
      // settings.json with no policies key
      writeFileSync(settingsPath, JSON.stringify({ version: '1' }));
      const hash = sha256(JSON.stringify({}));  // empty policies

      // Must not throw — absent policies is equivalent to {}
      verifyPolicyIntegrity(settingsPath, hash);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
