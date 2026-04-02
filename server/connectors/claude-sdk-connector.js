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

    // Strip CLAUDECODE env var to allow spawning inside a Claude Code session
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;

    const q = query({
      prompt: actualPrompt,
      options: {
        cwd: cwd ?? this.#cwd,
        model: modelID ?? this.#model,
        permissionMode: 'acceptEdits',
        tools: { type: 'preset', preset: 'claude_code' },
        env: cleanEnv,
      },
    });
    this.#query = q;

    yield { type: 'system', subtype: 'init', agent: 'claude', model: modelID ?? this.#model };

    try {
      for await (const msg of q) {
        if (process.env.COMPOSE_DEBUG) {
          process.stderr.write(`  [sdk] ${msg?.type ?? typeof msg}\n`);
        }
        for (const event of _normalizeAll(msg)) {
          yield event;
        }
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

/**
 * Normalize an SDK message into one or more envelope events.
 * Returns an array because a single assistant message can contain
 * multiple content blocks (text + tool_use).
 */
function _normalizeAll(msg) {
  if (!msg || typeof msg !== 'object') {
    return [{ type: 'assistant', content: String(msg) }];
  }
  if (msg.type === 'system' || msg.type === 'error') return [msg];

  // SDK assistant message — extract content blocks from msg.message
  if (msg.type === 'assistant' && msg.message?.content) {
    const events = [];
    for (const block of msg.message.content) {
      if (block.type === 'text' && block.text) {
        events.push({ type: 'assistant', content: block.text });
      } else if (block.type === 'tool_use') {
        events.push({ type: 'tool_use', tool: block.name, input: block.input ?? {} });
      }
    }
    return events.length > 0 ? events : [msg];
  }

  // SDK result message — contains the final aggregated text
  if (msg.type === 'result' && msg.result) {
    return [{ type: 'result', content: msg.result }];
  }

  if (msg.type === 'tool_use') {
    return [{ type: 'tool_use', tool: msg.name ?? msg.tool, input: msg.input ?? {} }];
  }
  if (msg.type === 'tool_use_summary') {
    const output = (msg.result ?? msg.output ?? '');
    return [{ type: 'tool_use_summary', summary: msg.summary, output: output ? output.slice(0, 2048) : undefined }];
  }
  if (msg.type === 'tool_progress') {
    return [{ type: 'tool_progress', tool: msg.tool_name, elapsed: msg.elapsed_time_seconds }];
  }
  // Delta or text content
  if (msg.delta?.text) return [{ type: 'assistant', content: msg.delta.text }];
  if (msg.content && typeof msg.content === 'string') return [{ type: 'assistant', content: msg.content }];
  // Pass through unknown message types as-is
  return [msg];
}
