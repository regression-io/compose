/**
 * OpencodeConnector — wraps @opencode-ai/sdk.
 *
 * Model-agnostic base for any non-Anthropic agent running through OpenCode.
 * NOT exposed as an MCP tool directly — subclasses (e.g. CodexConnector)
 * are exposed after constraining to a specific provider/model set.
 *
 * Singleton pattern: opencode serve is started once per process.
 * Multiple instantiations share the same underlying server.
 */

import { createOpencodeServer, createOpencodeClient } from '@opencode-ai/sdk';
import { AgentConnector, injectSchema } from './agent-connector.js';

// ---------------------------------------------------------------------------
// Module-level singleton — one opencode serve subprocess per process
// ---------------------------------------------------------------------------

let _serverPromise = null;
let _serverUrl = null;

function _getServerUrl() {
  if (!_serverPromise) {
    _serverPromise = createOpencodeServer({
      hostname: '127.0.0.1',
      port: 4096,
      timeout: 15000,
    }).then(server => {
      _serverUrl = server.url;
      return server;
    }).catch(err => {
      _serverPromise = null; // allow retry on next call
      throw err;
    });
  }
  return _serverPromise.then(() => _serverUrl);
}

function _makeClient(baseUrl, cwd) {
  return createOpencodeClient({ baseUrl, directory: cwd });
}

// ---------------------------------------------------------------------------
// OpencodeConnector
// ---------------------------------------------------------------------------

export class OpencodeConnector extends AgentConnector {
  _defaultProviderID;
  _defaultModelID;
  _cwd;
  _agentName;
  #client = null;
  #sessionId = null;
  #abortController = null;

  /**
   * @param {object} opts
   * @param {string} opts.providerID  — OpenCode provider ID (e.g. 'openai')
   * @param {string} opts.modelID     — model ID (e.g. 'gpt-5.2-codex')
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
    if (this.#sessionId) {
      throw new Error(`${this._agentName}: run() already active. Call interrupt() first.`);
    }

    const resolvedProviderID = providerID ?? this._defaultProviderID;
    const resolvedModelID    = modelID    ?? this._defaultModelID;
    const resolvedCwd        = cwd        ?? this._cwd;
    const actualPrompt       = schema ? injectSchema(prompt, schema) : prompt;

    const baseUrl = await _getServerUrl();
    const client  = _makeClient(baseUrl, resolvedCwd);
    this.#client  = client;

    // Create session
    const sessionResp = await client.session.create({
      body: { title: actualPrompt.slice(0, 60) },
    });
    const sessionId = sessionResp.data?.id ?? sessionResp.id;
    this.#sessionId = sessionId;

    const ac = new AbortController();
    this.#abortController = ac;

    yield {
      type: 'system', subtype: 'init',
      agent: this._agentName, model: `${resolvedProviderID}/${resolvedModelID}`,
    };

    // Subscribe to event stream BEFORE sending prompt to avoid missing events
    const sseResult = await client.event.subscribe({ signal: ac.signal });

    // Send prompt
    await client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: 'text', text: actualPrompt }],
        model: { providerID: resolvedProviderID, modelID: resolvedModelID },
      },
    });

    // Stream events until session is idle or errors
    try {
      for await (const event of sseResult.stream) {
        if (event.type === 'message.part.updated') {
          const delta = event.properties?.delta;
          if (delta) yield { type: 'assistant', content: delta };
        } else if (event.type === 'session.idle') {
          if (event.properties?.sessionID === sessionId) {
            yield { type: 'system', subtype: 'complete', agent: this._agentName };
            break;
          }
        } else if (event.type === 'session.error') {
          const sid = event.properties?.sessionID;
          if (!sid || sid === sessionId) {
            const msg = event.properties?.error?.message ?? 'Unknown session error';
            yield { type: 'error', message: msg };
            break;
          }
        }
      }
    } finally {
      this.#sessionId = null;
      this.#client    = null;
      this.#abortController = null;
      ac.abort();
    }
  }

  interrupt() {
    if (this.#sessionId && this.#client) {
      try {
        this.#client.session.abort({ path: { id: this.#sessionId } });
      } catch { /* ignore */ }
    }
    if (this.#abortController) {
      this.#abortController.abort();
    }
    this.#sessionId = null;
  }

  get isRunning() {
    return this.#sessionId !== null;
  }
}
