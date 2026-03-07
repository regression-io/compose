/**
 * Tests for stratum-mcp-client.js — MCP protocol client.
 *
 * These tests spawn a real stratum-mcp subprocess. Skip if not installed.
 */

import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { StratumMcpClient, StratumError } from '../lib/stratum-mcp-client.js';

// ---------------------------------------------------------------------------
// Skip guard: stratum-mcp must be installed
// ---------------------------------------------------------------------------

let stratumAvailable = false;
try {
  execFileSync('stratum-mcp', ['--help'], { timeout: 5000, stdio: 'pipe' });
  stratumAvailable = true;
} catch {
  // not installed or errored
}

// ---------------------------------------------------------------------------
// Inline specs (stratum_plan takes inline YAML, not file paths)
// ---------------------------------------------------------------------------

const MINIMAL_SPEC = `\
version: "0.2"

contracts:
  SimpleResult:
    summary: { type: string }

flows:
  simple:
    input:
      task: { type: string }
    output: SimpleResult
    steps:
      - id: step_one
        agent: claude
        intent: "Do the first thing."
        inputs:
          task: "$.input.task"
        output_contract: SimpleResult
        retries: 1
`;

const INVALID_SPEC = `\
version: "0.2"
flows: {}
`;

describe('StratumMcpClient', { skip: !stratumAvailable && 'stratum-mcp not installed' }, () => {
  let client;

  after(async () => {
    if (client) {
      await client.close();
      client = null;
    }
  });

  test('connects and closes without error', async () => {
    client = new StratumMcpClient();
    await client.connect();
    await client.close();
    client = null;
  });

  test('plan returns execute_step dispatch', async () => {
    client = new StratumMcpClient();
    await client.connect();

    const dispatch = await client.plan(MINIMAL_SPEC, 'simple', { task: 'test task' });

    assert.equal(dispatch.status, 'execute_step');
    assert.equal(dispatch.step_id, 'step_one');
    assert.ok(dispatch.flow_id, 'must have a flow_id');
    assert.ok(dispatch.intent, 'must have an intent');

    await client.close();
    client = null;
  });

  test('stepDone advances to complete on single-step flow', async () => {
    client = new StratumMcpClient();
    await client.connect();

    const dispatch = await client.plan(MINIMAL_SPEC, 'simple', { task: 'test task' });
    const result = await client.stepDone(dispatch.flow_id, 'step_one', {
      summary: 'Done with the task',
    });

    assert.equal(result.status, 'complete');

    await client.close();
    client = null;
  });

  test('audit returns execution trace after completion', async () => {
    client = new StratumMcpClient();
    await client.connect();

    const dispatch = await client.plan(MINIMAL_SPEC, 'simple', { task: 'audit test' });
    await client.stepDone(dispatch.flow_id, 'step_one', { summary: 'Done' });

    const auditResult = await client.audit(dispatch.flow_id);
    assert.ok(auditResult.flow_id || auditResult.audit, 'must have flow data');

    await client.close();
    client = null;
  });

  test('validate returns valid for good spec', async () => {
    client = new StratumMcpClient();
    await client.connect();

    const result = await client.validate(MINIMAL_SPEC);
    assert.equal(result.valid, true);

    await client.close();
    client = null;
  });

  test('validate rejects truly broken spec', async () => {
    client = new StratumMcpClient();
    await client.connect();

    // A spec with no version should fail validation
    const BROKEN_SPEC = 'not valid yaml: [';
    let gotError = false;
    try {
      const result = await client.validate(BROKEN_SPEC);
      if (result.valid === false) {
        gotError = true;
      }
    } catch {
      gotError = true;
    }
    assert.ok(gotError, 'must indicate invalid spec via result or error');

    await client.close();
    client = null;
  });

  test('throws when not connected', async () => {
    client = new StratumMcpClient();
    await assert.rejects(
      () => client.plan(MINIMAL_SPEC, 'simple', {}),
      /not connected/i
    );
    client = null;
  });

  test('double connect is idempotent', async () => {
    client = new StratumMcpClient();
    await client.connect();
    await client.connect(); // should not throw
    await client.close();
    client = null;
  });

  test('double close is safe', async () => {
    client = new StratumMcpClient();
    await client.connect();
    await client.close();
    await client.close(); // should not throw
    client = null;
  });
});
