/**
 * agent-health.js — HealthMonitor for spawned subagents.
 *
 * Tracks stdout/stderr activity to detect silent agents.
 * Enforces wall-clock timeout and memory RSS limits.
 * Broadcasts agentSilent / agentKilled events via the vision WS.
 *
 * Terminal reasons: manual_stop | silence_timeout | wall_clock_timeout | memory_exceeded | normal
 */

import { execSync } from 'node:child_process';

const DEFAULT_SILENCE_WARNING_MS = 60_000;       // 60s silence → warning
const DEFAULT_SILENCE_KILL_MS    = 5 * 60_000;   // 5min silence → kill
const DEFAULT_TIMEOUT_MS         = 10 * 60_000;  // 10min wall-clock
const DEFAULT_MEMORY_LIMIT_MB   = 0;             // 0 = disabled
const MEMORY_POLL_INTERVAL_MS   = 30_000;        // 30s

export class HealthMonitor {
  #broadcastMessage;
  #silenceWarningMs;
  #silenceKillMs;
  #defaultTimeoutMs;
  #memoryLimitMB;

  /** @type {Map<string, TrackedAgent>} */
  #agents = new Map();

  /**
   * @param {object} opts
   * @param {function} opts.broadcastMessage
   * @param {number}   [opts.silenceWarningMs]
   * @param {number}   [opts.silenceKillMs]
   * @param {number}   [opts.defaultTimeoutMs]
   * @param {number}   [opts.memoryLimitMB]
   */
  constructor({ broadcastMessage, silenceWarningMs, silenceKillMs, defaultTimeoutMs, memoryLimitMB }) {
    this.#broadcastMessage = broadcastMessage;
    this.#silenceWarningMs = silenceWarningMs ?? DEFAULT_SILENCE_WARNING_MS;
    this.#silenceKillMs    = silenceKillMs    ?? DEFAULT_SILENCE_KILL_MS;
    this.#defaultTimeoutMs = defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#memoryLimitMB    = memoryLimitMB    ?? DEFAULT_MEMORY_LIMIT_MB;
  }

  /**
   * Start monitoring an agent process.
   * @param {string} agentId
   * @param {import('node:child_process').ChildProcess} proc
   */
  track(agentId, proc) {
    // Clean up any prior tracking for same id
    if (this.#agents.has(agentId)) this.untrack(agentId);

    const entry = {
      proc,
      pid: proc.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      terminalReason: null,
      silenceWarningTimer: null,
      silenceKillTimer: null,
      wallClockTimer: null,
      memoryPollTimer: null,
      stdoutHandler: null,
      stderrHandler: null,
    };

    // Activity listeners
    const onActivity = () => { entry.lastActivity = Date.now(); this._resetSilenceTimers(agentId); };
    entry.stdoutHandler = onActivity;
    entry.stderrHandler = onActivity;
    if (proc.stdout) proc.stdout.on('data', entry.stdoutHandler);
    if (proc.stderr) proc.stderr.on('data', entry.stderrHandler);

    this.#agents.set(agentId, entry);

    // Start silence timers
    this._resetSilenceTimers(agentId);

    // Wall-clock timeout
    entry.wallClockTimer = setTimeout(() => this._kill(agentId, 'wall_clock_timeout'), this.#defaultTimeoutMs);

    // Memory polling
    if (this.#memoryLimitMB > 0) {
      entry.memoryPollTimer = setInterval(() => this._checkMemory(agentId), MEMORY_POLL_INTERVAL_MS);
    }
  }

  /**
   * Stop monitoring an agent (does NOT kill the process).
   */
  untrack(agentId) {
    const entry = this.#agents.get(agentId);
    if (!entry) return;
    this._clearTimers(entry);
    // Remove listeners
    if (entry.proc.stdout && entry.stdoutHandler) entry.proc.stdout.removeListener('data', entry.stdoutHandler);
    if (entry.proc.stderr && entry.stderrHandler) entry.proc.stderr.removeListener('data', entry.stderrHandler);
    this.#agents.delete(agentId);
  }

  isTracked(agentId) {
    return this.#agents.has(agentId);
  }

  getTerminalReason(agentId) {
    return this.#agents.get(agentId)?.terminalReason ?? null;
  }

  setTerminalReason(agentId, reason) {
    const entry = this.#agents.get(agentId);
    if (entry) entry.terminalReason = reason;
  }

  /** Clean up all tracked agents and timers. */
  destroy() {
    for (const agentId of [...this.#agents.keys()]) {
      this.untrack(agentId);
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────

  _resetSilenceTimers(agentId) {
    const entry = this.#agents.get(agentId);
    if (!entry) return;

    if (entry.silenceWarningTimer) clearTimeout(entry.silenceWarningTimer);
    if (entry.silenceKillTimer) clearTimeout(entry.silenceKillTimer);

    entry.silenceWarningTimer = setTimeout(() => {
      this.#broadcastMessage({
        type: 'agentSilent',
        agentId,
        silentSinceMs: Date.now() - entry.lastActivity,
        timestamp: new Date().toISOString(),
      });
    }, this.#silenceWarningMs);

    entry.silenceKillTimer = setTimeout(() => {
      this._kill(agentId, 'silence_timeout');
    }, this.#silenceKillMs);
  }

  _kill(agentId, reason) {
    const entry = this.#agents.get(agentId);
    if (!entry || entry.terminalReason) return; // already killed

    entry.terminalReason = reason;
    this._clearTimers(entry);

    try { entry.proc.kill('SIGTERM'); } catch { /* already dead */ }

    this.#broadcastMessage({
      type: 'agentKilled',
      agentId,
      reason,
      timestamp: new Date().toISOString(),
    });
  }

  _clearTimers(entry) {
    if (entry.silenceWarningTimer) { clearTimeout(entry.silenceWarningTimer); entry.silenceWarningTimer = null; }
    if (entry.silenceKillTimer) { clearTimeout(entry.silenceKillTimer); entry.silenceKillTimer = null; }
    if (entry.wallClockTimer) { clearTimeout(entry.wallClockTimer); entry.wallClockTimer = null; }
    if (entry.memoryPollTimer) { clearInterval(entry.memoryPollTimer); entry.memoryPollTimer = null; }
  }

  _checkMemory(agentId) {
    const entry = this.#agents.get(agentId);
    if (!entry || !entry.pid || entry.terminalReason) return;

    try {
      const rssKB = parseInt(execSync(`ps -o rss= -p ${entry.pid}`, { encoding: 'utf-8', timeout: 5000 }).trim(), 10);
      const rssMB = rssKB / 1024;
      if (rssMB > this.#memoryLimitMB) {
        this._kill(agentId, 'memory_exceeded');
      }
    } catch {
      // Process may have already exited — ignore
    }
  }
}
