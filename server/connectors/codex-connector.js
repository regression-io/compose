/**
 * CodexConnector — extends OpencodeConnector, locked to OpenAI Codex models.
 *
 * Validates modelID at construction time and at run() call time.
 * Authenticated via opencode-openai-codex-auth (ChatGPT subscription, OAuth).
 *
 * One-time auth setup (not a code dependency):
 *   npx -y opencode-openai-codex-auth@latest
 *   opencode auth login
 */

import { OpencodeConnector } from './opencode-connector.js';

// ---------------------------------------------------------------------------
// Supported Codex model IDs (via opencode-openai-codex-auth)
// ---------------------------------------------------------------------------

export const CODEX_MODEL_IDS = new Set([
  'gpt-5.2-codex',
  'gpt-5.2-codex/low',
  'gpt-5.2-codex/medium',
  'gpt-5.2-codex/high',
  'gpt-5.2-codex/xhigh',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-max/low',
  'gpt-5.1-codex-max/medium',
  'gpt-5.1-codex-max/high',
  'gpt-5.1-codex-max/xhigh',
  'gpt-5.1-codex',
  'gpt-5.1-codex/low',
  'gpt-5.1-codex/medium',
  'gpt-5.1-codex/high',
  'gpt-5.1-codex-mini',
  'gpt-5.1-codex-mini/medium',
  'gpt-5.1-codex-mini/high',
]);

const DEFAULT_MODEL_ID   = process.env.CODEX_MODEL || 'gpt-5.2-codex';
const DEFAULT_PROVIDER_ID = 'openai';

// ---------------------------------------------------------------------------
// CodexConnector
// ---------------------------------------------------------------------------

export class CodexConnector extends OpencodeConnector {
  /**
   * @param {object} [opts]
   * @param {string} [opts.modelID] — Codex model ID; must be in CODEX_MODEL_IDS
   * @param {string} [opts.cwd]    — default working directory
   * @throws {Error} if modelID is not a recognized Codex model
   */
  constructor({ modelID = DEFAULT_MODEL_ID, cwd = process.cwd() } = {}) {
    _assertCodexModel(modelID);
    super({
      providerID: DEFAULT_PROVIDER_ID,
      modelID,
      cwd,
      agentName: 'codex',
    });
  }

  async *run(prompt, opts = {}) {
    const resolvedModel = opts.modelID ?? this._defaultModelID;
    _assertCodexModel(resolvedModel);
    yield* super.run(prompt, { ...opts, modelID: resolvedModel, providerID: DEFAULT_PROVIDER_ID });
  }
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

function _assertCodexModel(modelID) {
  if (!CODEX_MODEL_IDS.has(modelID)) {
    throw new Error(
      `CodexConnector: '${modelID}' is not a supported Codex model.\n` +
      `Supported models: ${[...CODEX_MODEL_IDS].join(', ')}`
    );
  }
}
