/**
 * AgentConnector — base interface for all agent connectors.
 *
 * Subclasses implement run(), interrupt(), and isRunning.
 * Duck typing — no enforcement at runtime beyond the throw in run().
 *
 * Message envelope (yielded by run()):
 *   { type: 'system',    subtype: 'init' | 'complete', agent: string, model?: string }
 *   { type: 'assistant', content: string }
 *   { type: 'tool_use',          tool: string, input: object }
 *   { type: 'tool_use_summary',  summary: string, output?: string }
 *   { type: 'error',             message: string }
 *
 * Schema mode: if opts.schema is provided, the connector injects it into the
 * prompt as instructions and yields text output. JSON.parse() happens at the
 * MCP layer (agent-mcp.js), never inside connectors.
 */

export class AgentConnector {
  /**
   * Run a prompt against the agent.
   *
   * @param {string} prompt
   * @param {object} [opts]
   * @param {object}   [opts.schema]     — JSON Schema → structured output mode
   * @param {string}   [opts.modelID]    — override model for this run
   * @param {string}   [opts.providerID] — provider ID (OpenCode subclasses only)
   * @param {string}   [opts.cwd]        — working directory
   * @param {string[]} [opts.tools]      — restrict available tools
   * @returns {AsyncGenerator}
   */
  // eslint-disable-next-line require-yield
  async *run(_prompt, _opts = {}) {
    throw new Error(`${this.constructor.name}.run() not implemented`);
  }

  /** Stop the active run cleanly. No-op if not running. */
  interrupt() {}

  /** Whether a run is currently active. */
  get isRunning() { return false; }
}

/**
 * Inject a JSON schema into a prompt so the agent knows to return structured JSON.
 * Used by both ClaudeSDKConnector and OpencodeConnector — parsing happens at call site.
 *
 * @param {string} prompt
 * @param {object} schema  JSON Schema object
 * @returns {string}
 */
export function injectSchema(prompt, schema) {
  return (
    `${prompt}\n\n` +
    `IMPORTANT: After completing the task, include a JSON code block at the very end ` +
    `of your response matching this schema:\n` +
    '```json\n' +
    `${JSON.stringify(schema, null, 2)}\n` +
    '```\n' +
    `The JSON block must be the last thing in your response.`
  );
}
