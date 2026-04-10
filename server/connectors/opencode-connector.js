/**
 * OpencodeConnector — spawns `opencode run` for each prompt.
 *
 * Model-agnostic base for any non-Anthropic agent running through OpenCode.
 * NOT exposed as an MCP tool directly — subclasses (e.g. CodexConnector)
 * are exposed after constraining to a specific provider/model set.
 *
 * Uses `opencode run --format json` which streams structured JSON events
 * (step_start, text, tool_use, step_finish) to stdout. This is more reliable
 * than the SDK's serve mode which has event stream issues.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AgentConnector, injectSchema } from './agent-connector.js';

// ---------------------------------------------------------------------------
// OpencodeConnector
// ---------------------------------------------------------------------------

export class OpencodeConnector extends AgentConnector {
  _defaultProviderID;
  _defaultModelID;
  _cwd;
  _agentName;
  #proc = null;

  /**
   * @param {object} opts
   * @param {string} opts.providerID  — OpenCode provider ID (e.g. 'openai')
   * @param {string} opts.modelID     — model ID (e.g. 'gpt-5.4')
   * @param {string} [opts.cwd]       — default working directory
   * @param {string} [opts.agentName] — label used in system messages
   */
  constructor({ providerID, modelID, cwd = process.cwd(), agentName = 'opencode' }) {
    super();
    this._defaultProviderID = providerID;
    this._defaultModelID = modelID;
    this._cwd = cwd;
    this._agentName = agentName;
  }

  async *run(prompt, { schema, modelID, providerID, cwd } = {}) {
    if (this.#proc) {
      throw new Error(`${this._agentName}: run() already active. Call interrupt() first.`);
    }

    const resolvedProviderID = providerID ?? this._defaultProviderID;
    const resolvedModelID    = modelID    ?? this._defaultModelID;
    const resolvedCwd        = cwd        ?? this._cwd;
    const actualPrompt       = schema ? injectSchema(prompt, schema) : prompt;

    yield {
      type: 'system', subtype: 'init',
      agent: this._agentName, model: `${resolvedProviderID}/${resolvedModelID}`,
    };

    // Build clean env: remove OPENAI_API_KEY so opencode uses OAuth
    // (API key overrides OAuth and may lack Codex model access)
    const cleanEnv = { ...process.env };
    delete cleanEnv.OPENAI_API_KEY;

    const proc = spawn('opencode', [
      'run',
      '-m', `${resolvedProviderID}/${resolvedModelID}`,
      '--format', 'json',
      actualPrompt,
    ], {
      cwd: resolvedCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanEnv,
    });
    this.#proc = proc;

    // Read JSON events line-by-line from stdout
    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });

    const textParts = [];
    let stderrChunks = [];

    // Stream stderr live — detect rate-limit, auth, and quota errors immediately
    proc.stderr.on('data', chunk => {
      stderrChunks.push(chunk);
      const text = chunk.toString();
      const lower = text.toLowerCase();
      // Check for actionable errors that should surface immediately
      if (lower.includes('rate limit') || lower.includes('rate_limit') ||
          lower.includes('quota') || lower.includes('insufficient_quota') ||
          lower.includes('unauthorized') || lower.includes('401') ||
          lower.includes('403') || lower.includes('authentication') ||
          lower.includes('auth') || lower.includes('billing') ||
          lower.includes('exceeded') || lower.includes('capacity')) {
        process.stderr.write(`\n⚠ ${this._agentName}: ${text.trim()}\n`);
        process.stderr.write(`  → Check account: opencode auth status\n`);
        process.stderr.write(`  → Switch account: opencode auth login\n\n`);
      }
    });

    // Stall detection — warn if no stdout events for 120s
    let lastEventAt = Date.now();
    const stallTimer = setInterval(() => {
      const silent = Math.round((Date.now() - lastEventAt) / 1000);
      if (silent >= 120) {
        process.stderr.write(`\n⚠ ${this._agentName}: no response for ${silent}s — may be stalled or rate-limited\n`);
        process.stderr.write(`  → Press s to skip, or Ctrl+C to abort\n\n`);
      }
    }, 30_000);

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        lastEventAt = Date.now();

        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // skip non-JSON lines
        }

        if (event.type === 'text') {
          const text = event.part?.text ?? '';
          if (text) {
            textParts.push(text);
            yield { type: 'assistant', content: text };
          }
        } else if (event.type === 'tool_use') {
          const tool = event.part?.tool ?? event.part?.state?.input?.command ? 'bash' : 'unknown';
          const input = event.part?.state?.input ?? {};
          yield { type: 'tool_use', tool, input };

          // If tool has output, yield a summary
          const output = event.part?.state?.output;
          if (output && typeof output === 'string') {
            const short = output.length > 80 ? output.slice(0, 77) + '...' : output;
            yield { type: 'tool_use_summary', summary: short, output: output.slice(0, 2048) };
          }
        } else if (event.type === 'step_finish') {
          // step_finish includes cost and token info — forward as usage event
          const part = event.part;
          if (part && (part.cost != null || part.tokens != null)) {
            if (process.env.COMPOSE_DEBUG) {
              process.stderr.write(`  [${this._agentName}] cost=$${(part.cost ?? 0).toFixed(4)} tokens=${part.tokens?.total}\n`);
            }
            yield {
              type: 'usage',
              input_tokens: part.tokens?.input ?? 0,
              output_tokens: part.tokens?.output ?? 0,
              cache_creation_input_tokens: part.tokens?.cache_write ?? 0,
              cache_read_input_tokens: part.tokens?.cache_read ?? 0,
              cost_usd: part.cost ?? 0,
              model: resolvedModelID,
            };
          }
        }
        // step_start is ignored (already yielded init)
      }

      // Wait for process to exit
      const exitCode = await new Promise((resolve) => {
        proc.on('close', resolve);
      });

      if (exitCode !== 0 && textParts.length === 0) {
        const stderr = Buffer.concat(stderrChunks).toString();
        yield { type: 'error', message: stderr || `opencode exited with code ${exitCode}` };
      } else {
        // Yield the full concatenated text as a result
        const fullText = textParts.join('');
        if (fullText) {
          yield { type: 'result', content: fullText };
        }
        yield { type: 'system', subtype: 'complete', agent: this._agentName };
      }
    } catch (err) {
      if (err?.name !== 'AbortError') {
        yield { type: 'error', message: err.message || String(err) };
      }
    } finally {
      clearInterval(stallTimer);
      this.#proc = null;
    }
  }

  interrupt() {
    if (this.#proc) {
      try { this.#proc.kill('SIGTERM'); } catch { /* ignore */ }
      this.#proc = null;
    }
  }

  get isRunning() {
    return this.#proc !== null;
  }
}
