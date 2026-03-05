#!/usr/bin/env node
/**
 * Compose MCP Server — stdio transport
 *
 * Exposes Compose tracker state as MCP tools for Claude Code agents running
 * inside this project. Claude Code launches this process on-demand and
 * communicates via stdin/stdout JSON-RPC. No port, no supervisor entry.
 *
 * Register in .mcp.json:
 *   { "mcpServers": { "compose": { "command": "node", "args": ["server/compose-mcp.js"] } } }
 *
 * Tools:
 *   get_vision_items     — query items by phase/status/type/keyword
 *   get_item_detail      — single item with its connections
 *   get_current_session  — active session: tool count, items touched, summaries
 *   get_phase_summary    — status distribution for a given phase
 *   get_blocked_items    — items blocked by non-complete dependencies
 *
 * Token budget (per docs/features/mcp-connector/design.md Decision 6):
 *   Baseline (2026-02-24): ~519 tokens for all 5 tool definitions combined
 *   Soft cap: 2,000 tokens. Add typed tools for new operations; avoid proliferation.
 *   Per-tool: get_vision_items 235, get_phase_summary 104,
 *   get_item_detail 72, get_current_session 62, get_blocked_items 44
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  toolGetVisionItems,
  toolGetItemDetail,
  toolGetPhasesSummary,
  toolGetBlockedItems,
  toolGetCurrentSession,
} from './compose-mcp-tools.js';

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'get_vision_items',
    description: 'Query Compose tracker items. Filter by phase, status, type, or keyword. Returns id, title, type, phase, status, confidence, description.',
    inputSchema: {
      type: 'object',
      properties: {
        phase: {
          type: 'string',
          description: 'Filter by phase: vision, requirements, design, planning, implementation, verification, release',
        },
        status: {
          type: 'string',
          description: 'Filter by status (comma-separated for multiple): planned, in_progress, complete, blocked, parked, killed',
        },
        type: {
          type: 'string',
          description: 'Filter by type: task, decision, evaluation, idea, spec, thread, artifact, question, feature, track',
        },
        keyword: {
          type: 'string',
          description: 'Search keyword matched against title and description',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 30)',
        },
      },
    },
  },
  {
    name: 'get_item_detail',
    description: 'Get full detail for a single tracker item including all its connections.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Item ID (UUID) or semanticId/slug',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_phase_summary',
    description: 'Get status and type distribution for a phase (or all phases). Useful for understanding overall project health.',
    inputSchema: {
      type: 'object',
      properties: {
        phase: {
          type: 'string',
          description: 'Phase to summarize: vision, requirements, design, planning, implementation, verification, release. Omit for all phases.',
        },
      },
    },
  },
  {
    name: 'get_blocked_items',
    description: 'List all tracker items that are blocked by non-complete items.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_current_session',
    description: 'Get the most recent session: tool count, items touched, error count, and recent Haiku summaries of what was accomplished.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'compose', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    let result;
    switch (name) {
      case 'get_vision_items':    result = toolGetVisionItems(args); break;
      case 'get_item_detail':     result = toolGetItemDetail(args); break;
      case 'get_phase_summary':   result = toolGetPhasesSummary(args); break;
      case 'get_blocked_items':   result = toolGetBlockedItems(); break;
      case 'get_current_session': result = toolGetCurrentSession(); break;
      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
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
