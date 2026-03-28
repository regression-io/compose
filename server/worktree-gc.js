/**
 * worktree-gc.js — Garbage collector for orphan worktree directories.
 *
 * Scans `.compose/par/` for directories whose owner process has died.
 * Uses `.owner` file (contains PID) to check liveness via process.kill(pid, 0).
 * Directories without an owner or with a dead owner that are older than maxAgeMs
 * are removed via `git worktree remove --force`, with fallback to rm -rf + prune.
 */

import { readdirSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const DEFAULT_SCAN_INTERVAL_MS = 15 * 60_000; // 15min
const DEFAULT_MAX_AGE_MS       = 3600_000;     // 1h

export class WorktreeGC {
  #projectRoot;
  #parDir;
  #scanIntervalMs;
  #maxAgeMs;
  #timer = null;

  /**
   * @param {object} opts
   * @param {string} opts.projectRoot — git repo root (for git worktree commands)
   * @param {string} opts.parDir — path to .compose/par/ directory
   * @param {number} [opts.scanIntervalMs]
   * @param {number} [opts.maxAgeMs]
   */
  constructor({ projectRoot, parDir, scanIntervalMs, maxAgeMs }) {
    this.#projectRoot    = projectRoot;
    this.#parDir         = parDir;
    this.#scanIntervalMs = scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.#maxAgeMs       = maxAgeMs       ?? DEFAULT_MAX_AGE_MS;
  }

  /** Start periodic scanning. Also runs an initial scan. */
  start() {
    this.runNow().catch(() => {}); // fire-and-forget initial scan
    this.#timer = setInterval(() => {
      this.runNow().catch(() => {});
    }, this.#scanIntervalMs);
  }

  /** Stop periodic scanning. */
  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Run a single GC scan. Returns list of removed directory names.
   * @returns {Promise<string[]>}
   */
  async runNow() {
    if (!existsSync(this.#parDir)) return [];

    let entries;
    try {
      entries = readdirSync(this.#parDir, { withFileTypes: true })
        .filter(e => e.isDirectory());
    } catch {
      return [];
    }

    const removed = [];

    for (const entry of entries) {
      const dirPath = join(this.#parDir, entry.name);
      const ownerFile = join(dirPath, '.owner');

      // Check owner liveness
      if (existsSync(ownerFile)) {
        try {
          const pid = parseInt(readFileSync(ownerFile, 'utf-8').trim(), 10);
          if (pid > 0 && _isPidAlive(pid)) continue; // owner alive, skip
        } catch {
          // Can't read owner file — treat as orphan
        }
      }

      // Check age
      try {
        const stat = statSync(dirPath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs < this.#maxAgeMs) continue; // too fresh
      } catch {
        continue; // stat failed, skip
      }

      // Remove
      if (this._removeWorktree(dirPath)) {
        removed.push(entry.name);
      }
    }

    return removed;
  }

  /**
   * Attempt to remove a worktree directory. Returns true if successfully removed.
   */
  _removeWorktree(dirPath) {
    // Try git worktree remove first
    try {
      execSync(`git worktree remove "${dirPath}" --force`, {
        cwd: this.#projectRoot, encoding: 'utf-8', timeout: 30_000, stdio: 'pipe',
      });
      return true;
    } catch {
      // Fallback: rm -rf + prune
      try {
        rmSync(dirPath, { recursive: true, force: true });
        try {
          execSync('git worktree prune', {
            cwd: this.#projectRoot, encoding: 'utf-8', timeout: 15_000, stdio: 'pipe',
          });
        } catch { /* prune is best-effort */ }
        return true;
      } catch {
        return false;
      }
    }
  }
}

function _isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
