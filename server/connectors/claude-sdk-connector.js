/**
 * ClaudeSDKConnector — wraps @anthropic-ai/claude-agent-sdk query().
 *
 * All Anthropic model execution goes through this connector.
 * Yields the same typed message envelope as the other connectors.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { AgentConnector, injectSchema } from './agent-connector.js';

const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

export class ClaudeSDKConnector extends AgentConnector {
  #model;
  #cwd;
  #query = null;

  /**
   * @param {object} [opts]
   * @param {string} [opts.model]  — default model (env CLAUDE_MODEL or claude-sonnet-4-6)
   * @param {string} [opts.cwd]   — default working directory
   */
  constructor({ model = DEFAULT_MODEL, cwd = process.cwd() } = {}) {
    super();
    this.#model = model;
    this.#cwd = cwd;
  }

  async *run(prompt, { schema, modelID, cwd } = {}) {
    if (this.#query) {
      throw new Error('ClaudeSDKConnector: run() already active. Call interrupt() first.');
    }

    const actualPrompt = schema ? injectSchema(prompt, schema) : prompt;

    const q = query({
      prompt: actualPrompt,
      options: {
        cwd: cwd ?? this.#cwd,
        model: modelID ?? this.#model,
        permissionMode: 'acceptEdits',
        tools: { type: 'preset', preset: 'claude_code' },
      },
    });
    this.#query = q;

    yield { type: 'system', subtype: 'init', agent: 'claude', model: modelID ?? this.#model };

    try {
      for await (const msg of q) {
        yield _normalize(msg);
      }
      yield { type: 'system', subtype: 'complete', agent: 'claude' };
    } catch (err) {
      if (err?.name !== 'AbortError') {
        yield { type: 'error', message: err.message || String(err) };
      }
    } finally {
      this.#query = null;
    }
  }

  interrupt() {
    if (this.#query) {
      try { this.#query.interrupt(); } catch { /* already done */ }
      this.#query = null;
    }
  }

  get isRunning() {
    return this.#query !== null;
  }
}

// ---------------------------------------------------------------------------
// Normalize Claude SDK message → shared envelope
// ---------------------------------------------------------------------------

function _normalize(msg) {
  if (!msg || typeof msg !== 'object') {
    return { type: 'assistant', content: String(msg) };
  }
  // Pass through messages that already match the envelope
  if (msg.type === 'system' || msg.type === 'error') return msg;
  if (msg.type === 'assistant') return msg;
  if (msg.type === 'tool_use') {
    return { type: 'tool_use', tool: msg.name ?? msg.tool, input: msg.input ?? {} };
  }
  // Delta or text content
  if (msg.delta?.text) return { type: 'assistant', content: msg.delta.text };
  if (msg.content && typeof msg.content === 'string') return { type: 'assistant', content: msg.content };
  // Pass through unknown message types as-is
  return msg;
}
