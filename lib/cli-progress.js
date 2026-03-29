/**
 * cli-progress.js — Collapsible, color-coded tool output for compose build.
 *
 * When expanded (default): prints every tool event line in color.
 * When collapsed: shows a single sticky status line at the bottom that
 * updates with each new tool event.
 *
 * Keys: 't' toggle expanded/collapsed, 's' skip current step, 'r' retry current step.
 */

import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const ESC = '\x1b[';
const RESET   = `${ESC}0m`;
const BOLD    = `${ESC}1m`;
const DIM     = `${ESC}2m`;
const CYAN    = `${ESC}36m`;
const YELLOW  = `${ESC}33m`;
const GREEN   = `${ESC}32m`;
const RED     = `${ESC}31m`;
const MAGENTA = `${ESC}35m`;
const GRAY    = `${ESC}90m`;

// Erase current line and move cursor to start
const ERASE_LINE = `${ESC}2K\r`;
// Save/restore cursor
const SAVE    = `${ESC}s`;
const RESTORE = `${ESC}u`;

// ---------------------------------------------------------------------------
// Tool color mapping
// ---------------------------------------------------------------------------

const TOOL_COLORS = {
  Bash:    CYAN,
  bash:    CYAN,
  Read:    GREEN,
  read:    GREEN,
  Write:   YELLOW,
  write:   YELLOW,
  Edit:    YELLOW,
  edit:    YELLOW,
  Glob:    MAGENTA,
  glob:    MAGENTA,
  Grep:    MAGENTA,
  grep:    MAGENTA,
  Agent:   BOLD + CYAN,
  agent:   BOLD + CYAN,
};

function colorForTool(tool) {
  return TOOL_COLORS[tool] ?? GRAY;
}

// ---------------------------------------------------------------------------
// CliProgress
// ---------------------------------------------------------------------------

export class CliProgress extends EventEmitter {
  #expanded = true;
  #lastTool = '';
  #lastDetail = '';
  #toolCount = 0;
  #stream;
  #cleanup = null;
  #isTTY;
  #onKey;
  #wasRaw;
  #listening = false;
  #heartbeatTimer = null;
  #stepStart = 0;
  #pendingAction = null; // 'skip' | 'retry' | null

  /**
   * @param {object} [opts]
   * @param {NodeJS.WriteStream} [opts.stream] — output stream (default: process.stderr)
   * @param {boolean} [opts.expanded] — start collapsed by default
   */
  constructor({ stream, expanded = false } = {}) {
    super();
    this.#stream = stream ?? process.stderr;
    this.#isTTY = this.#stream.isTTY ?? false;
    this.#expanded = expanded;

    this.#onKey = (key) => {
      if (key === 't' || key === 'T') {
        this.toggle();
      }
      if (key === 's' || key === 'S') {
        this.#pendingAction = 'skip';
        this.#clearStatusLine();
        this.#stream.write(`  ${YELLOW}⏭ Skip requested — interrupting current step...${RESET}\n`);
        this.emit('interrupt');
      }
      if (key === 'r' || key === 'R') {
        this.#pendingAction = 'retry';
        this.#clearStatusLine();
        this.#stream.write(`  ${YELLOW}↻ Retry requested — interrupting current step...${RESET}\n`);
        this.emit('interrupt');
      }
      if (key === '\x03') {
        this.finish();
        process.exit(130);
      }
    };

    this.#startListening();
  }

  get expanded() { return this.#expanded; }

  /** Returns 'skip' | 'retry' | null and clears the flag. */
  consumeAction() {
    const action = this.#pendingAction;
    this.#pendingAction = null;
    return action;
  }

  /** Check without clearing. */
  get pendingAction() { return this.#pendingAction; }

  #startListening() {
    if (this.#listening) return;
    if (!this.#isTTY || !process.stdin.isTTY || !process.stdin.setRawMode) return;
    this.#wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', this.#onKey);
    this.#listening = true;
  }

  #stopListening() {
    if (!this.#listening) return;
    process.stdin.removeListener('data', this.#onKey);
    if (process.stdin.setRawMode) {
      try { process.stdin.setRawMode(this.#wasRaw ?? false); } catch { /* ignore */ }
    }
    process.stdin.pause();
    this.#listening = false;
  }

  /** Pause key listener (e.g. before readline gate prompt). */
  pause() {
    this.#clearStatusLine();
    this.#stopListening();
  }

  /** Resume key listener after pause. */
  resume() {
    this.#startListening();
  }

  toggle() {
    this.#expanded = !this.#expanded;
    if (this.#expanded) {
      // Clear the status line when expanding
      this.#clearStatusLine();
      this.#stream.write(`${GRAY}  ── expanded (press t to collapse) ──${RESET}\n`);
    } else {
      this.#stream.write(`${GRAY}  ── collapsed (press t to expand) ──${RESET}\n`);
      // Redraw the status line
      this.#drawStatusLine();
    }
  }

  // -------------------------------------------------------------------------
  // Event handlers — called from result-normalizer
  // -------------------------------------------------------------------------

  /** Log a tool_use event. */
  toolUse(tool, detail) {
    this.#toolCount++;
    this.#stepStart = Date.now(); // reset heartbeat baseline on activity
    const color = colorForTool(tool);
    const short = typeof detail === 'string' && detail.length > 60
      ? detail.slice(0, 57) + '...'
      : (detail || '');

    if (this.#expanded) {
      this.#stream.write(`    ${color}↳ ${tool}${RESET}${short ? ': ' + short : ''}\n`);
    } else {
      this.#lastTool = tool;
      this.#lastDetail = short;
      this.#drawStatusLine();
    }
  }

  /** Log a tool_use_summary event. */
  toolSummary(summary) {
    const short = summary.length > 80 ? summary.slice(0, 77) + '...' : summary;

    if (this.#expanded) {
      this.#stream.write(`    ${GREEN}✓${RESET} ${short}\n`);
    } else {
      this.#lastTool = '✓';
      this.#lastDetail = short;
      this.#drawStatusLine();
    }
  }

  /** Log a tool_progress event. */
  toolProgress(tool, elapsed) {
    const color = colorForTool(tool);

    if (this.#expanded) {
      this.#stream.write(`    ${color}↳ ${tool}${RESET} ${DIM}(${Math.round(elapsed)}s)${RESET}\n`);
    } else {
      this.#lastTool = tool;
      this.#lastDetail = `(${Math.round(elapsed)}s)`;
      this.#drawStatusLine();
    }
  }

  /** Log a step start. */
  stepStart(stepNum, totalSteps, stepId) {
    // Always show step transitions, even when collapsed
    this.#clearStatusLine();
    this.#stopHeartbeat();
    this.#stream.write(`${BOLD}[${stepNum}/${totalSteps}]${RESET} ${stepId}...\n`);
    this.#toolCount = 0;
    this.#stepStart = Date.now();
    if (!this.#expanded) {
      this.#lastTool = '';
      this.#lastDetail = '';
      this.#drawStatusLine();
    }
    this.#startHeartbeat(stepId);
  }

  /** Log a sub-flow step. */
  subFlowStep(flowName, stepId) {
    this.#clearStatusLine();
    this.#stopHeartbeat();
    this.#stream.write(`  ${CYAN}[${flowName}]${RESET} ${stepId}...\n`);
    this.#stepStart = Date.now();
    this.#startHeartbeat(`${flowName}/${stepId}`);
    if (!this.#expanded) {
      this.#lastTool = '';
      this.#lastDetail = '';
      this.#drawStatusLine();
    }
  }

  /** Log a retry. */
  retry(flowName, stepId, agent) {
    this.#clearStatusLine();
    this.#stream.write(`  ${YELLOW}[${flowName}] ↻ Retrying ${stepId}${agent ? ` (${agent})` : ''}${RESET}\n`);
    if (!this.#expanded) this.#drawStatusLine();
  }

  /** Log a fix pass. */
  fix(flowName, fixAgent, stepId) {
    this.#clearStatusLine();
    this.#stream.write(`  ${YELLOW}[${flowName}] ↻ Fix (${fixAgent}) for ${stepId}${RESET}\n`);
    if (!this.#expanded) this.#drawStatusLine();
  }

  /** Log an error/warning. */
  warn(msg) {
    this.#clearStatusLine();
    this.#stream.write(`    ${RED}⚠ ${msg}${RESET}\n`);
    if (!this.#expanded) this.#drawStatusLine();
  }

  /** Log a success marker. */
  success(msg) {
    this.#clearStatusLine();
    this.#stream.write(`  ${GREEN}✓${RESET} ${msg}\n`);
    if (!this.#expanded) this.#drawStatusLine();
  }

  /** Log an info message (always visible). */
  info(msg) {
    this.#clearStatusLine();
    this.#stream.write(`${msg}\n`);
    if (!this.#expanded) this.#drawStatusLine();
  }

  /** Debug log (only in COMPOSE_DEBUG mode). */
  debug(msg) {
    if (!process.env.COMPOSE_DEBUG) return;
    if (this.#expanded) {
      this.#stream.write(`  ${DIM}[debug] ${msg}${RESET}\n`);
    }
  }

  /** Clean up: remove key listener, clear status line, stop heartbeat. */
  finish() {
    this.#clearStatusLine();
    this.#stopHeartbeat();
    this.#stopListening();
  }

  #startHeartbeat(stepId) {
    this.#stopHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      const elapsed = Math.round((Date.now() - this.#stepStart) / 1000);
      if (this.#expanded) {
        this.#stream.write(`    ${DIM}… ${stepId} running (${elapsed}s)${RESET}\n`);
      } else {
        this.#lastDetail = `(${elapsed}s)`;
        this.#drawStatusLine();
      }
    }, 15_000);
  }

  #stopHeartbeat() {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Sticky status line
  // -------------------------------------------------------------------------

  #drawStatusLine() {
    if (!this.#isTTY) return;
    const cols = this.#stream.columns ?? 80;
    const tool = this.#lastTool;
    const detail = this.#lastDetail;
    const color = tool ? colorForTool(tool) : GRAY;
    const countTag = `${DIM}[${this.#toolCount} tool calls]${RESET}`;
    const maxDetail = cols - (tool.length + 12); // room for ↳ + tool + count + padding
    const shortDetail = detail.length > maxDetail
      ? detail.slice(0, maxDetail - 3) + '...'
      : detail;
    const toolPart = tool ? `${color}${tool}${RESET}` : '';
    const detailPart = shortDetail ? ` ${shortDetail}` : '';
    this.#stream.write(`${ERASE_LINE}  ↳ ${toolPart}${detailPart} ${countTag}`);
  }

  #clearStatusLine() {
    if (!this.#isTTY) return;
    this.#stream.write(ERASE_LINE);
  }
}
