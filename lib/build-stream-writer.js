/**
 * BuildStreamWriter — appends JSONL events to .compose/build-stream.jsonl
 *
 * Used by build.js to emit build lifecycle events that the agent-server's
 * BuildStreamBridge tails and rebroadcasts via SSE.
 *
 * Sync I/O is intentional — JSONL lines are small and the CLI is already
 * I/O-bound on agent calls between writes.
 */

import { mkdirSync, appendFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export class BuildStreamWriter {
  #path;
  #seq = 0;
  #featureCode;
  #closed = false;

  /**
   * @param {string} composeDir  Path to .compose directory
   * @param {string} featureCode Feature code (e.g. 'STRAT-COMP-7')
   * @param {object} [opts]
   * @param {boolean} [opts.truncate=false] Truncate existing stream (fresh builds only)
   */
  constructor(composeDir, featureCode, { truncate = false } = {}) {
    mkdirSync(composeDir, { recursive: true });
    this.#path = join(composeDir, 'build-stream.jsonl');
    this.#featureCode = featureCode;

    // Only truncate on fresh builds — resumed builds append to existing stream
    if (truncate && existsSync(this.#path)) {
      unlinkSync(this.#path);
    }

    // On resume: read the last _seq from the existing JSONL so new events
    // have monotonically increasing _seq values. The SSE bridge deduplicates
    // on _seq, so restarting from 0 would cause all resumed events to be dropped.
    if (!truncate && existsSync(this.#path)) {
      try {
        const content = readFileSync(this.#path, 'utf-8').trimEnd();
        if (content) {
          const lastLine = content.slice(content.lastIndexOf('\n') + 1);
          const lastEvent = JSON.parse(lastLine);
          if (typeof lastEvent._seq === 'number') {
            this.#seq = lastEvent._seq + 1;
          }
        }
      } catch {
        // Corrupt file — start from 0, bridge will handle duplicates
      }
    }
  }

  /**
   * Append a JSONL event with auto-incremented _seq and _ts fields.
   * @param {object} event  Event payload (must include `type`)
   */
  write(event) {
    const line = JSON.stringify({
      ...event,
      _seq: this.#seq++,
      _ts: Date.now(),
    });
    appendFileSync(this.#path, line + '\n');
  }

  /**
   * Emit a capability_profile event noting the active template for a step.
   * Informational only — never blocks or fails the build.
   *
   * @param {string}        stepId        Step ID
   * @param {string}        agent         Full agent string, e.g. "claude:read-only-reviewer"
   * @param {string|null}   templateName  Template name, or null if no template
   * @param {string[]|null} allowedTools  Allowed tools list from template
   * @param {string[]|null} disallowedTools Disallowed tools list from template
   */
  writeCapabilityProfile(stepId, agent, templateName, allowedTools, disallowedTools) {
    this.write({
      type: 'capability_profile',
      stepId,
      agent,
      template: templateName,
      allowedTools,
      disallowedTools,
    });
  }

  /**
   * Emit a capability_violation event for informational audit.
   * Violations are never blocking in v1.
   *
   * @param {string} stepId       Step ID where the violation was detected
   * @param {string} agent        Full agent string
   * @param {string} templateName Active template name
   * @param {string} detail       Description of the violation
   */
  writeViolation(stepId, agent, templateName, detail) {
    this.write({
      type: 'capability_violation',
      stepId,
      agent,
      template: templateName,
      detail,
    });
  }

  /**
   * Write a build_end sentinel and mark the writer as closed.
   * Idempotent — calling multiple times writes exactly one build_end.
   * @param {string} [status='complete']  Build exit status
   */
  close(status = 'complete') {
    if (this.#closed) return;
    this.#closed = true;
    this.write({ type: 'build_end', status, featureCode: this.#featureCode });
  }

  /** @returns {string} Absolute path to the JSONL file */
  get filePath() {
    return this.#path;
  }
}
