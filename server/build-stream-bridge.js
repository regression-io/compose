/**
 * BuildStreamBridge — tails .compose/build-stream.jsonl and rebroadcasts
 * events as SSE messages via the agent-server's broadcast() function.
 *
 * File-based decoupling: the CLI writes JSONL, this bridge reads it.
 * The CLI and server are separate OS processes with independent lifecycles.
 */

import { readFileSync, statSync, watch } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { existsSync } from 'node:fs';

const JSONL_FILENAME = 'build-stream.jsonl';
const DEFAULT_CRASH_TIMEOUT_MS = 300_000; // 5 min
const STALE_GATE_TIMEOUT_MS = 86_400_000; // 24h
const DEBOUNCE_MS = 50;
const POLL_INTERVAL_MS = 2000;

export class BuildStreamBridge {
  #filePath;
  #composeDir;
  #broadcast;
  #crashTimeoutMs;

  // Byte-level cursor tracking
  #cursor = 0;
  #lastSeq = -1;
  #lastIno = null;
  #trailingFragment = '';

  // Lifecycle state for crash detection
  #buildActive = false;
  #inStep = false;

  // Timers and watchers
  #watcher = null;
  #pollInterval = null;
  #debounceTimer = null;
  #crashTimer = null;
  #polling = false;

  /**
   * @param {string} composeDir  Path to .compose directory
   * @param {Function} broadcast  broadcast(msg) function from agent-server
   * @param {object} [opts]
   * @param {number} [opts.crashTimeoutMs]  Crash detection timeout (default 5min)
   */
  constructor(composeDir, broadcast, opts = {}) {
    this.#composeDir = composeDir;
    this.#filePath = join(composeDir, JSONL_FILENAME);
    this.#broadcast = broadcast;
    this.#crashTimeoutMs = opts.crashTimeoutMs ?? DEFAULT_CRASH_TIMEOUT_MS;
  }

  /**
   * Begin tailing the JSONL file. Catches up from byte 0 if file already
   * exists and is fresh (active build).
   */
  start() {
    if (existsSync(this.#composeDir)) {
      this._startWatching();
      // Catch up if file exists and is fresh
      if (existsSync(this.#filePath)) {
        if (!this._isStaleOnStartup()) {
          this.#cursor = 0;
          this.#lastSeq = -1;
          this._readNewLines();
        } else {
          // Stale file — skip to EOF
          try {
            const stat = statSync(this.#filePath);
            this.#cursor = stat.size;
            this.#lastIno = stat.ino;
          } catch { /* ignore */ }
        }
      }
    } else {
      // Directory doesn't exist yet — poll until it appears
      this._pollForDirectory();
    }
  }

  /** Stop all timers, watchers, and intervals. */
  stop() {
    if (this.#watcher) {
      this.#watcher.close();
      this.#watcher = null;
    }
    if (this.#pollInterval) {
      clearInterval(this.#pollInterval);
      this.#pollInterval = null;
    }
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
    if (this.#crashTimer) {
      clearTimeout(this.#crashTimer);
      this.#crashTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // File watching
  // ---------------------------------------------------------------------------

  _startWatching() {
    try {
      this.#watcher = watch(this.#composeDir, (eventType, filename) => {
        if (filename === JSONL_FILENAME || filename === null) {
          this._debouncedRead();
        }
      });
      this.#watcher.on('error', () => {
        // Watcher died — fall back to polling
        this.#watcher = null;
        this._pollForDirectory();
      });
    } catch {
      // fs.watch can throw on some platforms — fall back to polling
      this._pollForDirectory();
    }
  }

  _pollForDirectory() {
    if (this.#polling) return;
    this.#polling = true;

    this.#pollInterval = setInterval(() => {
      if (existsSync(this.#composeDir)) {
        clearInterval(this.#pollInterval);
        this.#pollInterval = null;
        this.#polling = false;
        this._startWatching();
        // Check if file appeared while polling
        if (existsSync(this.#filePath)) {
          this._readNewLines();
        }
      }
    }, POLL_INTERVAL_MS);
    this.#pollInterval.unref();
  }

  _debouncedRead() {
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      this._readNewLines();
    }, DEBOUNCE_MS);
  }

  // ---------------------------------------------------------------------------
  // Core read logic — Buffer-based cursor tracking
  // ---------------------------------------------------------------------------

  _readNewLines() {
    let stat;
    try {
      stat = statSync(this.#filePath);
    } catch {
      return; // file doesn't exist yet
    }

    // Inode change detection (primary): file was replaced
    if (this.#lastIno !== null && stat.ino !== this.#lastIno) {
      this.#cursor = 0;
      this.#lastSeq = -1;
      this.#trailingFragment = '';
    }
    // Size-based fallback: truncation without inode change
    else if (stat.size < this.#cursor) {
      this.#cursor = 0;
      this.#lastSeq = -1;
      this.#trailingFragment = '';
    }

    this.#lastIno = stat.ino;

    if (stat.size <= this.#cursor) return; // no new data

    // Read new bytes as Buffer
    let buf;
    try {
      const fd = readFileSync(this.#filePath);
      buf = fd.subarray(this.#cursor, stat.size);
    } catch {
      return; // read error — will retry on next event
    }

    this.#cursor = stat.size;

    // Convert to string and split on newlines
    const text = this.#trailingFragment + buf.toString('utf-8');
    const lines = text.split('\n');

    // Last element is either empty (complete line) or a trailing fragment
    this.#trailingFragment = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // malformed JSON — skip
      }

      // Dedup via monotonic _seq guard
      if (typeof event._seq === 'number' && event._seq <= this.#lastSeq) {
        continue;
      }
      if (typeof event._seq === 'number') {
        this.#lastSeq = event._seq;
      }

      // Map and broadcast
      const mapped = this._mapEvent(event);
      if (mapped) {
        this.#broadcast(mapped);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Stale file detection on startup
  // ---------------------------------------------------------------------------

  _isStaleOnStartup() {
    try {
      const content = readFileSync(this.#filePath, 'utf-8').trim();
      if (!content) return true;

      const lines = content.split('\n');
      const lastLine = lines[lines.length - 1];
      const stat = statSync(this.#filePath);
      const age = Date.now() - stat.mtimeMs;

      let lastEvent;
      try {
        lastEvent = JSON.parse(lastLine);
      } catch {
        // Malformed last line — stale if old enough
        return age > this.#crashTimeoutMs;
      }

      // Completed/killed/aborted build — stale
      if (lastEvent.type === 'build_end') return true;

      // Gate-pending: stale only if older than 24h (gates have unbounded wait)
      if (lastEvent.type === 'build_gate') {
        return age > STALE_GATE_TIMEOUT_MS;
      }

      // Non-gate, non-terminal: stale if older than crash timeout
      return age > this.#crashTimeoutMs;
    } catch {
      return true; // can't read — treat as stale
    }
  }

  // ---------------------------------------------------------------------------
  // Event mapping (JSONL -> SSE)
  // ---------------------------------------------------------------------------

  _mapEvent(event) {
    const type = event.type;

    // Track lifecycle state for crash timer
    if (type === 'build_start' || type === 'build_resume') {
      this.#buildActive = true;
      this.#inStep = false;
      this._clearCrashTimer();
    } else if (type === 'build_step_start') {
      this.#inStep = true;
      this._resetCrashTimer();
    } else if (type === 'build_step_done' || type === 'build_gate') {
      this.#inStep = false;
      this._clearCrashTimer();
    } else if (type === 'build_end') {
      this.#buildActive = false;
      this.#inStep = false;
      this._clearCrashTimer();
    } else if (type === 'tool_use' || type === 'assistant') {
      // Content events during active step — reset crash timer
      if (this.#inStep) this._resetCrashTimer();
    }

    switch (type) {
      case 'build_start':
      case 'build_resume':
        return {
          type: 'system', subtype: type,
          featureCode: event.featureCode, flowId: event.flowId,
          _source: 'build',
        };

      case 'build_step_start':
        return {
          type: 'system', subtype: 'build_step',
          stepId: event.stepId, stepNum: event.stepNum,
          totalSteps: event.totalSteps, agent: event.agent,
          intent: event.intent,
          flowId: event.flowId,
          ...(event.parentFlowId ? { parentFlowId: event.parentFlowId } : {}),
          ...(event.parallel ? { parallel: true } : {}),
          _source: 'build',
        };

      case 'tool_use':
        return {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: event.tool, input: event.input }] },
          _source: 'build',
        };

      case 'tool_use_summary':
        return {
          type: 'assistant', subtype: 'tool_use_summary',
          summary: event.summary, output: event.output,
          _source: 'build',
        };

      case 'tool_progress':
        return {
          type: 'tool_progress',
          tool: event.tool, elapsed: event.elapsed,
          _source: 'build',
        };

      case 'assistant':
        return {
          type: 'assistant',
          message: { content: [{ type: 'text', text: event.content }] },
          _source: 'build',
        };

      case 'build_step_done':
        return {
          type: 'system', subtype: 'build_step_done',
          stepId: event.stepId, summary: event.summary,
          retries: event.retries, violations: event.violations,
          flowId: event.flowId,
          ...(event.parentFlowId ? { parentFlowId: event.parentFlowId } : {}),
          ...(event.parallel ? { parallel: true } : {}),
          _source: 'build',
        };

      case 'build_gate':
        return {
          type: 'system', subtype: 'build_gate',
          stepId: event.stepId, gateType: event.gateType,
          flowId: event.flowId,
          ...(event.parentFlowId ? { parentFlowId: event.parentFlowId } : {}),
          _source: 'build',
        };

      case 'build_gate_resolved':
        return {
          type: 'system', subtype: 'build_gate_resolved',
          stepId: event.stepId, outcome: event.outcome,
          rationale: event.rationale,
          flowId: event.flowId,
          ...(event.parentFlowId ? { parentFlowId: event.parentFlowId } : {}),
          _source: 'build',
        };

      case 'build_error':
        return {
          type: 'error',
          message: event.message, source: 'build',
          _source: 'build',
        };

      case 'build_end':
        return {
          type: 'system', subtype: 'build_end',
          status: event.status, featureCode: event.featureCode,
          _source: 'build',
        };

      case 'idea_suggestion':
        return {
          type: 'system', subtype: 'idea_suggestion',
          text: event.text, stepId: event.stepId,
          _source: 'build',
        };

      default:
        return null; // unknown event type — skip
    }
  }

  // ---------------------------------------------------------------------------
  // Crash detection
  // ---------------------------------------------------------------------------

  _resetCrashTimer() {
    this._clearCrashTimer();
    this.#crashTimer = setTimeout(() => {
      this.#crashTimer = null;
      if (this.#buildActive && this.#inStep) {
        // Emit synthetic build_end(crashed)
        this.#broadcast({
          type: 'system', subtype: 'build_end',
          status: 'crashed', _source: 'build',
        });
        // Suppress late events from dead build
        this.#lastSeq = Infinity;
        this.#buildActive = false;
        this.#inStep = false;
      }
    }, this.#crashTimeoutMs);
    if (this.#crashTimer.unref) this.#crashTimer.unref();
  }

  _clearCrashTimer() {
    if (this.#crashTimer) {
      clearTimeout(this.#crashTimer);
      this.#crashTimer = null;
    }
  }
}
