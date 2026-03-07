/**
 * Result Normalizer — bridges connector text streams to structured step results
 * for the headless build runner.
 *
 * Converts flat Stratum output_fields to JSON Schema, runs a connector,
 * accumulates text, and extracts structured JSON from the response.
 */

import { injectSchema } from '../server/connectors/agent-connector.js';

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
 * @returns {Promise<{ text: string, result: object|null }>}
 */
export async function runAndNormalize(connector, prompt, stepDispatch) {
  const outputFields = stepDispatch.output_fields;
  const hasSchema = outputFields && typeof outputFields === 'object' && Object.keys(outputFields).length > 0;

  let actualPrompt = prompt;
  let schema = null;

  if (hasSchema) {
    schema = outputFieldsToJsonSchema(outputFields);
    actualPrompt = injectSchema(prompt, schema);
  }

  const opts = {};
  const textParts = [];

  for await (const event of connector.run(actualPrompt, opts)) {
    if (event.type === 'error') {
      throw new AgentError(event.message);
    }
    if (event.type === 'assistant' && event.content) {
      textParts.push(event.content);
    }
  }

  const text = textParts.join('');

  if (!hasSchema) {
    return { text, result: null };
  }

  const result = extractJson(text);
  if (result === null) {
    throw new ResultParseError(
      'Failed to extract JSON from connector output',
      text,
    );
  }

  return { text, result };
}
