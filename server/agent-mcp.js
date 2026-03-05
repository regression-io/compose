#!/usr/bin/env node
/**
 * Agent MCP Server — stdio transport
 *
 * Exposes a single agent_run tool that routes prompts to the appropriate
 * connector (claude or codex) based on the `type` parameter.
 *
 * Register in .mcp.json:
 *   { "mcpServers": { "agent": { "command": "node", "args": ["server/agent-mcp.js"] } } }
 *
 * Tools:
 *   agent_run — run a prompt against claude or codex; optional schema for
 *               structured JSON output
 *
 * Design decisions:
 *   - Single tool, type parameter selects connector (item 18b)
 *   - Schema mode: schema injected into prompt; JSON.parse() here, not in connector
 *   - Streaming events collapsed to final text + structured result in one MCP response
 *   - Default type is "claude"; codex requires opencode auth (see codex-connector.js)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { ClaudeSDKConnector } from './connectors/claude-sdk-connector.js';
import { CodexConnector }     from './connectors/codex-connector.js';

// ---------------------------------------------------------------------------
// Connector factory
// ---------------------------------------------------------------------------

/**
 * @param {'claude'|'codex'} type
 * @param {object} opts
 * @param {string} [opts.modelID]
 * @param {string} [opts.cwd]
 * @returns {import('./connectors/agent-connector.js').AgentConnector}
 */
const VALID_TYPES = new Set(['claude', 'codex']);

function _makeConnector(type, { modelID, cwd } = {}) {
  if (!VALID_TYPES.has(type)) {
    throw new Error(`agent_run: unknown type '${type}'. Valid types: ${[...VALID_TYPES].join(', ')}`);
  }
  if (type === 'codex') {
    return new CodexConnector({ modelID, cwd });
  }
  return new ClaudeSDKConnector({ model: modelID, cwd });
}

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

/**
 * Run a prompt and accumulate the full response.
 * Returns { text, result } where result is parsed JSON if schema was provided.
 */
async function toolAgentRun({ type = 'claude', prompt, schema, modelID, cwd }) {
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('agent_run: prompt is required');
  }

  const connector = _makeConnector(type, { modelID, cwd });

  const parts = [];
  for await (const event of connector.run(prompt, { schema, modelID, cwd })) {
    if (event.type === 'assistant' && event.content) {
      parts.push(event.content);
    } else if (event.type === 'error') {
      throw new Error(`agent_run (${type}): ${event.message}`);
    }
    // system init/complete and tool_use events are intentionally ignored here;
    // the MCP layer returns the final text, not the event stream.
  }

  const text = parts.join('');

  if (schema) {
    try {
      const result = JSON.parse(text);
      return { text, result };
    } catch {
      return { text, result: null, parseError: 'Response was not valid JSON' };
    }
  }

  return { text };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'agent_run',
    description:
      'Run a prompt against an AI agent (claude or codex). ' +
      'Returns the full response text. ' +
      'If schema is provided, the agent is instructed to return JSON matching the schema ' +
      'and the parsed result is included in the response.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['claude', 'codex'],
          description: 'Which agent to use. "claude" uses the Claude Agent SDK (default). "codex" uses OpenAI Codex via opencode.',
        },
        prompt: {
          type: 'string',
          description: 'The prompt to send to the agent.',
        },
        schema: {
          type: 'object',
          description: 'JSON Schema for structured output. When provided, the agent responds with JSON only.',
        },
        modelID: {
          type: 'string',
          description: 'Override the model ID. For codex, must be a valid Codex model ID.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the agent. Defaults to process.cwd().',
        },
      },
      required: ['prompt'],
    },
  },
];

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'agent', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  if (name !== 'agent_run') {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  try {
    const result = await toolAgentRun(args);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
// Server runs until stdin closes — no explicit exit needed
