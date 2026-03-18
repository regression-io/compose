/**
 * Golden flow tests for the agent MCP server (agent-mcp.js).
 *
 * Tests the MCP protocol surface: tool listing, input validation,
 * and connector routing. Live inference tests are skipped unless
 * COMPOSE_LIVE_TEST=1 is set.
 *
 * Covers 18f (test + observability hardening) and 18h acceptance criteria.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_PATH = resolve(REPO_ROOT, 'server/agent-mcp.js');

// ---------------------------------------------------------------------------
// MCP JSON-RPC helpers
// ---------------------------------------------------------------------------

let msgId = 0;

function jsonrpc(method, params = {}) {
  return JSON.stringify({ jsonrpc: '2.0', id: ++msgId, method, params });
}

/**
 * Spawn agent-mcp.js, send a sequence of JSON-RPC messages, collect responses.
 * Returns after the server responds to all messages or timeout.
 */
async function mcpCall(messages, { timeoutMs = 5000 } = {}) {
  const proc = spawn('node', [SERVER_PATH], {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });

  const responses = [];
  let buf = '';

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      resolve(responses);
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      // MCP uses newline-delimited JSON
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          responses.push(JSON.parse(line));
        } catch {
          // skip non-JSON (e.g. MCP notifications)
        }
        if (responses.length >= messages.length) {
          clearTimeout(timer);
          proc.kill();
          resolve(responses);
        }
      }
    });

    proc.on('error', reject);
    proc.on('close', () => {
      clearTimeout(timer);
      resolve(responses);
    });
  });

  // Send messages with small delays to let the server initialize
  for (const msg of messages) {
    proc.stdin.write(msg + '\n');
  }

  return done;
}

// ---------------------------------------------------------------------------
// Tool listing
// ---------------------------------------------------------------------------

describe('agent MCP server — tool listing', () => {
  test('lists agent_run tool with correct schema', async () => {
    const responses = await mcpCall([
      jsonrpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      }),
      jsonrpc('tools/list'),
    ]);

    // Find the tools/list response
    const toolsResp = responses.find(r =>
      r.result?.tools || (Array.isArray(r.result) && r.result[0]?.name)
    );
    assert.ok(toolsResp, 'Expected a tools/list response');

    const tools = toolsResp.result.tools || toolsResp.result;
    assert.ok(Array.isArray(tools), 'tools should be an array');

    const agentRun = tools.find(t => t.name === 'agent_run');
    assert.ok(agentRun, 'agent_run tool should be listed');
    assert.equal(agentRun.inputSchema.type, 'object');
    assert.ok(agentRun.inputSchema.properties.type, 'should have type property');
    assert.ok(agentRun.inputSchema.properties.prompt, 'should have prompt property');
    assert.ok(agentRun.inputSchema.properties.schema, 'should have schema property');
    assert.ok(agentRun.inputSchema.properties.modelID, 'should have modelID property');
    assert.deepEqual(agentRun.inputSchema.required, ['prompt']);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('agent MCP server — input validation', () => {
  test('rejects missing prompt', async () => {
    const responses = await mcpCall([
      jsonrpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      }),
      jsonrpc('tools/call', { name: 'agent_run', arguments: {} }),
    ]);

    const callResp = responses.find(r =>
      r.result?.isError || r.error
    );
    assert.ok(callResp, 'Expected an error response for missing prompt');
    if (callResp.result) {
      assert.equal(callResp.result.isError, true);
      assert.ok(
        callResp.result.content[0].text.includes('prompt'),
        'Error should mention prompt',
      );
    }
  });

  test('rejects empty prompt', async () => {
    const responses = await mcpCall([
      jsonrpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      }),
      jsonrpc('tools/call', { name: 'agent_run', arguments: { prompt: '   ' } }),
    ]);

    const callResp = responses.find(r =>
      r.result?.isError || r.error
    );
    assert.ok(callResp, 'Expected an error response for empty prompt');
  });

  test('rejects unknown tool name', async () => {
    const responses = await mcpCall([
      jsonrpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      }),
      jsonrpc('tools/call', { name: 'nonexistent_tool', arguments: { prompt: 'hi' } }),
    ]);

    const callResp = responses.find(r =>
      r.result?.isError || r.error
    );
    assert.ok(callResp, 'Expected an error for unknown tool');
  });

  test('rejects unknown connector type', async () => {
    const responses = await mcpCall([
      jsonrpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      }),
      jsonrpc('tools/call', {
        name: 'agent_run',
        arguments: { type: 'gemini', prompt: 'hello' },
      }),
    ]);

    const callResp = responses.find(r =>
      r.result?.isError || r.error
    );
    assert.ok(callResp, 'Expected an error for unknown type');
    if (callResp.result) {
      assert.ok(
        callResp.result.content[0].text.includes('unknown type'),
        'Error should mention unknown type',
      );
    }
  });

  test('rejects invalid codex modelID', async () => {
    const responses = await mcpCall([
      jsonrpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      }),
      jsonrpc('tools/call', {
        name: 'agent_run',
        arguments: { type: 'codex', modelID: 'gpt-4o', prompt: 'hello' },
      }),
    ]);

    const callResp = responses.find(r =>
      r.result?.isError || r.error
    );
    assert.ok(callResp, 'Expected an error for invalid codex modelID');
    if (callResp.result) {
      assert.ok(
        callResp.result.content[0].text.includes('not a supported Codex model'),
        'Error should mention unsupported model',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Live inference smoke tests (skipped by default)
// ---------------------------------------------------------------------------

const LIVE = process.env.COMPOSE_LIVE_TEST === '1';

describe('agent MCP server — live smoke tests', { skip: !LIVE }, () => {
  test('claude agent_run returns text', async () => {
    const responses = await mcpCall([
      jsonrpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      }),
      jsonrpc('tools/call', {
        name: 'agent_run',
        arguments: { type: 'claude', prompt: 'Reply with exactly: HELLO_18H' },
      }),
    ], { timeoutMs: 60000 });

    const callResp = responses.find(r => r.result && !r.result.isError && r.result.content);
    assert.ok(callResp, 'Expected a successful response');
    const text = callResp.result.content[0].text;
    const parsed = JSON.parse(text);
    assert.ok(parsed.text.includes('HELLO_18H'), 'Response should contain HELLO_18H');
  });

  test('codex agent_run with schema returns structured JSON', async () => {
    const responses = await mcpCall([
      jsonrpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      }),
      jsonrpc('tools/call', {
        name: 'agent_run',
        arguments: {
          type: 'codex',
          prompt: 'Is 2+2 equal to 4? Answer with clean=true if yes.',
          schema: {
            type: 'object',
            required: ['clean', 'summary'],
            properties: {
              clean: { type: 'boolean' },
              summary: { type: 'string' },
            },
          },
        },
      }),
    ], { timeoutMs: 120000 });

    const callResp = responses.find(r => r.result && !r.result.isError && r.result.content);
    assert.ok(callResp, 'Expected a successful response');
    const text = callResp.result.content[0].text;
    const parsed = JSON.parse(text);
    assert.ok(parsed.result, 'Should have parsed result');
    assert.equal(typeof parsed.result.clean, 'boolean', 'clean should be boolean');
    assert.equal(typeof parsed.result.summary, 'string', 'summary should be string');
  });
});
