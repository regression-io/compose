/**
 * stratum-mcp-client.js — MCP protocol client for stratum-mcp.
 *
 * Spawns `stratum-mcp` (no subcommand) as a child process and communicates
 * via the MCP SDK over stdio. This is for the build runner's plan/step_done
 * loop — distinct from server/stratum-client.js which uses CLI subcommands.
 *
 * Usage:
 *   const client = new StratumMcpClient();
 *   await client.connect();
 *   const dispatch = await client.plan(specPath, 'build', { featureCode: 'FEAT-1' });
 *   const next = await client.stepDone(dispatch.flow_id, 'step1', { phase: 'design' });
 *   await client.close();
 */

import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export class StratumError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'StratumError';
    this.code = code;
    this.detail = detail;
  }
}

export class StratumMcpClient {
  #client = null;
  #transport = null;
  #connected = false;

  /**
   * Spawn stratum-mcp and establish MCP connection.
   * @param {object} [opts]
   * @param {string} [opts.command] - Override binary (for testing)
   * @param {string[]} [opts.args] - Override args
   * @param {string}   [opts.cwd]  - Working directory for the subprocess
   */
  async connect(opts = {}) {
    if (this.#connected) return;

    const command = opts.command ?? 'stratum-mcp';
    const args = opts.args ?? [];

    // Pre-flight: verify binary exists on $PATH (skip for test overrides)
    if (command === 'stratum-mcp') {
      try {
        execFileSync('which', [command], { stdio: 'pipe', timeout: 3000 });
      } catch {
        throw new Error(
          'stratum-mcp not found on $PATH. Install with: pip install stratum-mcp'
        );
      }
    }

    const transportOpts = { command, args, stderr: 'pipe' };
    if (opts.cwd) transportOpts.cwd = opts.cwd;
    this.#transport = new StdioClientTransport(transportOpts);

    this.#client = new Client(
      { name: 'compose-build', version: '1.0.0' },
      { capabilities: {} }
    );

    await this.#client.connect(this.#transport);
    this.#connected = true;
  }

  /** Kill subprocess and clean up. */
  async close() {
    if (!this.#connected) return;
    try {
      await this.#client.close();
    } catch {
      // Ignore close errors — process may already be dead
    }
    this.#client = null;
    this.#transport = null;
    this.#connected = false;
  }

  /**
   * Call an MCP tool and return the parsed JSON result.
   * @param {string} toolName
   * @param {object} args
   * @returns {Promise<any>}
   */
  async #callTool(toolName, args) {
    if (!this.#connected) {
      throw new Error('StratumMcpClient not connected. Call connect() first.');
    }

    const result = await this.#client.callTool({
      name: toolName,
      arguments: args,
    });

    // MCP tool results come back as content array; extract text content
    const textContent = result.content?.find(c => c.type === 'text');
    if (!textContent) {
      throw new StratumError('EMPTY_RESPONSE', `Tool ${toolName} returned no text content`, '');
    }

    // MCP isError flag indicates tool-level failure
    if (result.isError) {
      throw new StratumError('TOOL_ERROR', textContent.text, '');
    }

    let parsed;
    try {
      parsed = JSON.parse(textContent.text);
    } catch {
      // Try to extract JSON from text that may have surrounding prose
      const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          throw new StratumError('PARSE_ERROR', `Tool ${toolName} returned invalid JSON`, textContent.text);
        }
      } else {
        throw new StratumError('PARSE_ERROR', `Tool ${toolName} returned invalid JSON`, textContent.text);
      }
    }

    // Check for Stratum error envelope
    if (parsed.status === 'error' || parsed.error) {
      const err = parsed.error ?? parsed;
      throw new StratumError(
        err.code ?? 'STRATUM_ERROR',
        err.message ?? 'Stratum tool call failed',
        err.detail ?? ''
      );
    }

    return parsed;
  }

  /**
   * Start a flow. Returns the first step dispatch.
   * @param {string} spec - Inline YAML spec content (not a file path)
   * @param {string} flow - Flow name within the spec
   * @param {object} inputs - Flow input values
   * @returns {Promise<object>} Step dispatch response
   */
  async plan(spec, flow, inputs) {
    return this.#callTool('stratum_plan', { spec, flow, inputs });
  }

  /**
   * Resume an in-progress flow. Returns the current step dispatch.
   * @param {string} flowId
   * @returns {Promise<object>} Step dispatch response (same format as plan/stepDone)
   */
  async resume(flowId) {
    return this.#callTool('stratum_resume', { flow_id: flowId });
  }

  /**
   * Report step completion. Returns next step dispatch or completion.
   * @param {string} flowId
   * @param {string} stepId
   * @param {object} result - Step result (must match output_contract)
   * @returns {Promise<object>}
   */
  async stepDone(flowId, stepId, result) {
    return this.#callTool('stratum_step_done', {
      flow_id: flowId,
      step_id: stepId,
      result,
    });
  }

  /**
   * Resolve a gate step.
   * @param {string} flowId
   * @param {string} stepId
   * @param {'approve'|'revise'|'kill'} outcome
   * @param {string} rationale
   * @param {'human'|'agent'|'system'} resolvedBy
   * @returns {Promise<object>}
   */
  async gateResolve(flowId, stepId, outcome, rationale, resolvedBy = 'human') {
    return this.#callTool('stratum_gate_resolve', {
      flow_id: flowId,
      step_id: stepId,
      outcome,
      rationale,
      resolved_by: resolvedBy,
    });
  }

  /**
   * Skip the current step with a recorded reason.
   * @param {string} flowId
   * @param {string} stepId
   * @param {string} reason
   * @returns {Promise<object>}
   */
  async skipStep(flowId, stepId, reason) {
    return this.#callTool('stratum_skip_step', {
      flow_id: flowId,
      step_id: stepId,
      reason,
    });
  }

  /**
   * Get the full execution trace.
   * @param {string} flowId
   * @returns {Promise<object>}
   */
  async audit(flowId) {
    return this.#callTool('stratum_audit', { flow_id: flowId });
  }

  /**
   * Start a counted iteration loop on a step.
   * @param {string} flowId
   * @param {string} stepId
   * @returns {Promise<object>}
   */
  async iterationStart(flowId, stepId) {
    return this.#callTool('stratum_iteration_start', {
      flow_id: flowId,
      step_id: stepId,
    });
  }

  /**
   * Report one iteration result.
   * @param {string} flowId
   * @param {string} stepId
   * @param {object} result
   * @returns {Promise<object>}
   */
  async iterationReport(flowId, stepId, result) {
    return this.#callTool('stratum_iteration_report', {
      flow_id: flowId,
      step_id: stepId,
      result,
    });
  }

  /**
   * Abort an iteration loop early.
   * @param {string} flowId
   * @param {string} stepId
   * @param {string} reason
   * @returns {Promise<object>}
   */
  async iterationAbort(flowId, stepId, reason) {
    return this.#callTool('stratum_iteration_abort', {
      flow_id: flowId,
      step_id: stepId,
      reason,
    });
  }

  /**
   * Validate a spec without executing.
   * @param {string} spec - Inline YAML spec content
   * @returns {Promise<{valid: boolean, errors?: string[]}>}
   */
  async validate(spec) {
    return this.#callTool('stratum_validate', { spec });
  }

  /**
   * Create a named checkpoint.
   * @param {string} flowId
   * @param {string} label
   * @returns {Promise<object>}
   */
  async commit(flowId, label) {
    return this.#callTool('stratum_commit', {
      flow_id: flowId,
      label,
    });
  }

  /**
   * Roll back to a checkpoint.
   * @param {string} flowId
   * @param {string} label
   * @returns {Promise<object>}
   */
  async revert(flowId, label) {
    return this.#callTool('stratum_revert', {
      flow_id: flowId,
      label,
    });
  }
}
