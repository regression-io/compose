/**
 * BuildStreamWriter — appends JSONL events to .compose/build-stream.jsonl
 *
 * Used by build.js to emit build lifecycle events that the agent-server's
 * BuildStreamBridge tails and rebroadcasts via SSE.
 *
 * Sync I/O is intentional — JSONL lines are small and the CLI is already
 * I/O-bound on agent calls between writes.
 */

import { mkdirSync, appendFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export class BuildStreamWriter {
  #path;
  #seq = 0;
  #featureCode;
  #closed = false;

  /**
   * @param {string} composeDir  Path to .compose directory
   * @param {string} featureCode Feature code (e.g. 'STRAT-COMP-7')
   */
  constructor(composeDir, featureCode) {
    mkdirSync(composeDir, { recursive: true });
    this.#path = join(composeDir, 'build-stream.jsonl');
    this.#featureCode = featureCode;

    // Truncate any existing file for a fresh build
    if (existsSync(this.#path)) {
      unlinkSync(this.#path);
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
