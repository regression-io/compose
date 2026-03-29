/**
 * Result Normalizer — bridges connector text streams to structured step results
 * for the headless build runner.
 *
 * Converts flat Stratum output_fields to JSON Schema, runs a connector,
 * accumulates text, and extracts structured JSON from the response.
 */

import { injectSchema } from '../server/connectors/agent-connector.js';
import { CliProgress } from './cli-progress.js';

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class ResultParseError extends Error {
  /**
   * @param {string} message
   * @param {string} rawText  The raw connector output that could not be parsed
   */
  constructor(message, rawText) {
    super(message);
    this.name = 'ResultParseError';
    this.rawText = rawText;
  }
}

export class AgentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentError';
  }
}

export class UserInterruptError extends Error {
  /** @param {string} stepId @param {'skip'|'retry'} action */
  constructor(stepId, action) {
    super(`User requested ${action} for step "${stepId}"`);
    this.name = 'UserInterruptError';
    this.stepId = stepId;
    this.action = action;
  }
}

// ---------------------------------------------------------------------------
// Schema conversion
// ---------------------------------------------------------------------------

/** Map from Stratum flat type names to JSON Schema property descriptors. */
const TYPE_MAP = {
  string:  { type: 'string' },
  boolean: { type: 'boolean' },
  integer: { type: 'integer' },
  number:  { type: 'number' },
  array:   { type: 'array' },
  object:  { type: 'object' },
};

/**
 * Convert Stratum's flat output_fields type map to a JSON Schema object.
 *
 * @param {Record<string, string>} outputFields  e.g. { "clean": "boolean", "findings": "array" }
 * @returns {object} A JSON Schema object with type, required, and properties.
 */
export function outputFieldsToJsonSchema(outputFields) {
  const properties = {};
  const required = Object.keys(outputFields);

  for (const [key, typeStr] of Object.entries(outputFields)) {
    const lower = typeStr.toLowerCase();
    properties[key] = TYPE_MAP[lower] ?? {}; // any/unknown → unconstrained
  }

  return {
    type: 'object',
    required,
    properties,
  };
}

// ---------------------------------------------------------------------------
// JSON extraction helpers
// ---------------------------------------------------------------------------

/**
 * Try to extract a JSON object from text using multiple strategies.
 *
 * @param {string} text
 * @returns {object|null} Parsed JSON or null if all strategies fail.
 */
function extractJson(text) {
  // Strategy A: full text is valid JSON
  try {
    return JSON.parse(text);
  } catch { /* continue */ }

  // Strategy B: fenced ```json ... ``` block
  const fenceMatch = text.match(/```json\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch { /* continue */ }
  }

  // Strategy C: first balanced { ... } substring
  const startIdx = text.indexOf('{');
  if (startIdx !== -1) {
    let depth = 0;
    for (let i = startIdx; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(startIdx, i + 1));
        } catch { /* continue */ }
        break;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run a connector and normalize its output to a structured result.
 *
 * @param {object} connector         Object with a run(prompt, opts) async generator method.
 * @param {string} prompt            The prompt to send to the connector.
 * @param {object} stepDispatch      Step dispatch descriptor.
 * @param {Record<string, string>} [stepDispatch.output_fields]  Expected output fields.
 * @param {object} [opts]
 * @param {CliProgress} [opts.progress]  CLI progress renderer.
 * @returns {Promise<{ text: string, result: object|null }>}
 */
export class AgentTimeoutError extends Error {
  constructor(stepId, durationMs) {
    super(`Agent timed out on step "${stepId}" after ${Math.round(durationMs / 1000)}s`);
    this.name = 'AgentTimeoutError';
    this.stepId = stepId;
    this.durationMs = durationMs;
  }
}

export async function runAndNormalize(connector, prompt, stepDispatch, opts = {}) {
  const progress = opts.progress;
  const streamWriter = opts.streamWriter;
  const maxDurationMs = opts.maxDurationMs ?? null; // null = no timeout
  const outputFields = stepDispatch.output_fields;
  const hasSchema = outputFields && typeof outputFields === 'object' && Object.keys(outputFields).length > 0;

  let actualPrompt = prompt;
  let schema = null;

  if (hasSchema) {
    schema = outputFieldsToJsonSchema(outputFields);
    actualPrompt = injectSchema(prompt, schema);
  }

  const textParts = [];
  const startTime = Date.now();

  // Set up timeout timer if configured
  let timeoutTimer = null;
  let timedOut = false;
  if (maxDurationMs) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      try { connector.interrupt(); } catch { /* best effort */ }
    }, maxDurationMs);
  }

  // Wire up skip/retry interrupt from CLI key press
  let userInterrupted = false;
  const onInterrupt = () => {
    userInterrupted = true;
    try { connector.interrupt(); } catch { /* best effort */ }
  };
  if (progress?.on) progress.on('interrupt', onInterrupt);

  try {
  for await (const event of connector.run(actualPrompt, {})) {
    // Check for timeout after each event
    if (timedOut) {
      const stepId = stepDispatch.step_id ?? 'unknown';
      throw new AgentTimeoutError(stepId, Date.now() - startTime);
    }
    // Check for user interrupt (skip/retry)
    if (userInterrupted) {
      const stepId = stepDispatch.step_id ?? 'unknown';
      throw new UserInterruptError(stepId, progress?.consumeAction() ?? 'skip');
    }
    if (progress) {
      progress.debug(`event type=${event.type} keys=${Object.keys(event).join(',')}`);
    } else if (process.env.COMPOSE_DEBUG) {
      process.stderr.write(`  [event] type=${event.type} keys=${Object.keys(event).join(',')}\n`);
    }
    if (event.type === 'error') {
      // build_error is written by build.js catch blocks, not here — avoids duplicate events
      throw new AgentError(event.message);
    }
    if (event.type === 'assistant' && event.content) {
      textParts.push(event.content);
      if (streamWriter) {
        streamWriter.write({ type: 'assistant', content: event.content });
      }
    }
    if (event.type === 'result' && event.content) {
      // Result contains the final aggregated text — use it if we got nothing from blocks
      if (textParts.length === 0) {
        textParts.push(event.content);
      }
    }
    // Forward tool_use to build stream (before progress logging)
    if (streamWriter && event.type === 'tool_use' && event.tool) {
      streamWriter.write({ type: 'tool_use', tool: event.tool, input: event.input });
    }
    // Progress logging — show tool calls so the user sees activity
    if (event.type === 'tool_use' && event.tool) {
      const detail = event.input?.command
        ?? event.input?.pattern
        ?? event.input?.query
        ?? event.input?.file_path
        ?? '';
      if (progress) {
        progress.toolUse(event.tool, detail);
      } else {
        const short = typeof detail === 'string' && detail.length > 60
          ? detail.slice(0, 57) + '...'
          : detail;
        process.stderr.write(`    ↳ ${event.tool}${short ? ': ' + short : ''}\n`);
      }
    }
    if (event.type === 'tool_use_summary' && event.summary) {
      if (progress) {
        progress.toolSummary(event.summary);
      } else {
        const short = event.summary.length > 80
          ? event.summary.slice(0, 77) + '...'
          : event.summary;
        process.stderr.write(`    ↳ ${short}\n`);
      }
    }
    if (event.type === 'tool_progress' && event.tool) {
      if (progress) {
        progress.toolProgress(event.tool, event.elapsed);
      } else {
        process.stderr.write(`    ↳ ${event.tool} (${Math.round(event.elapsed)}s)\n`);
      }
    }
  }
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (progress?.removeListener) progress.removeListener('interrupt', onInterrupt);
  }

  // If we broke out of the loop due to timeout, throw
  if (timedOut) {
    const stepId = stepDispatch.step_id ?? 'unknown';
    throw new AgentTimeoutError(stepId, Date.now() - startTime);
  }

  const text = textParts.join('');

  if (progress) {
    progress.debug(`normalizer: textParts=${textParts.length}, text length=${text.length}`);
    if (text.length > 0) progress.debug(`text preview: ${text.slice(0, 300)}`);
  } else if (process.env.COMPOSE_DEBUG) {
    process.stderr.write(`  [normalizer] textParts count: ${textParts.length}, text length: ${text.length}\n`);
    if (text.length > 0) process.stderr.write(`  [normalizer] text preview: ${text.slice(0, 300)}\n`);
  }

  if (!hasSchema) {
    return { text, result: null };
  }

  const result = extractJson(text);
  if (result === null) {
    // Agent did its work but didn't return structured JSON.
    // Log a warning and return a fallback — don't crash the pipeline.
    if (progress) {
      progress.warn('Could not extract JSON from agent output, using fallback');
    } else {
      process.stderr.write('    ⚠ Could not extract JSON from agent output, using fallback\n');
    }
    const summary = text.slice(0, 200).replace(/\n/g, ' ').trim();
    return { text, result: { summary: summary || 'Step complete' } };
  }

  return { text, result };
}
