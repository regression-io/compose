/**
 * cli-progress.js — Build progress output for compose build.
 *
 * Two modes:
 *   Collapsed (default): last 5 tool events + sticky key hints bar
 *   Expanded: all tool events printed as they arrive
 *
 * Keys: t=toggle  s=skip  r=retry  Ctrl+C=abort
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
const WHITE   = `${ESC}37m`;

const ERASE_LINE = `${ESC}2K\r`;
const MOVE_UP    = (n) => `${ESC}${n}A`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;

// ---------------------------------------------------------------------------
// Tool color mapping
// ---------------------------------------------------------------------------

const TOOL_COLORS = {
  Bash:    CYAN,   bash:    CYAN,
  Read:    GREEN,  read:    GREEN,
  Write:   YELLOW, write:   YELLOW,
  Edit:    YELLOW, edit:    YELLOW,
  Glob:    MAGENTA, glob:   MAGENTA,
  Grep:    MAGENTA, grep:   MAGENTA,
  Agent:   BOLD + CYAN, agent: BOLD + CYAN,
};

function colorForTool(tool) {
  return TOOL_COLORS[tool] ?? GRAY;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLLAPSED_LINES = 5;   // tool lines to show when collapsed
const HINT_BAR = `${DIM}  keys: ${WHITE}t${GRAY}=toggle  ${WHITE}s${GRAY}=skip  ${WHITE}r${GRAY}=retry  ${WHITE}Ctrl+C${GRAY}=abort${RESET}`;

// ---------------------------------------------------------------------------
// CliProgress
// ---------------------------------------------------------------------------

export class CliProgress extends EventEmitter {
  #expanded = false;
  #toolHistory = [];     // all tool events for current step
  #toolCount = 0;
  #drawnCollapsedLines = 0; // how many collapsed lines are currently on screen
  #stream;
  #isTTY;
  #onKey;
  #wasRaw;
  #listening = false;
  #heartbeatTimer = null;
  #stepStart = 0;
  #currentStepId = '';
  #pendingAction = null;

  constructor({ stream, expanded = false } = {}) {
    super();
    this.#stream = stream ?? process.stderr;
    this.#isTTY = this.#stream.isTTY ?? false;
    this.#expanded = expanded;

    this.#onKey = (key) => {
      if (key === 't' || key === 'T') this.toggle();
      if (key === 's' || key === 'S') {
        this.#pendingAction = 'skip';
        this.#clearCollapsed();
        this.#stream.write(`  ${YELLOW}⏭ Skip requested — interrupting current step...${RESET}\n`);
        this.emit('interrupt');
      }
      if (key === 'r' || key === 'R') {
        this.#pendingAction = 'retry';
        this.#clearCollapsed();
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

  consumeAction() {
    const action = this.#pendingAction;
    this.#pendingAction = null;
    return action;
  }

  get pendingAction() { return this.#pendingAction; }

  // ── Key listener management ───────────────────────────────────────────

  #startListening() {
    if (this.#listening) return;
    if (!this.#isTTY || !process.stdin.isTTY || !process.stdin.setRawMode) return;
    this.#wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', this.#onKey);
    this.#listening = true;
    if (this.#isTTY) this.#stream.write(HIDE_CURSOR);
  }

  #stopListening() {
    if (!this.#listening) return;
    process.stdin.removeListener('data', this.#onKey);
    if (process.stdin.setRawMode) {
      try { process.stdin.setRawMode(this.#wasRaw ?? false); } catch { /* ignore */ }
    }
    process.stdin.pause();
    this.#listening = false;
    if (this.#isTTY) this.#stream.write(SHOW_CURSOR);
  }

  pause() {
    this.#clearCollapsed();
    this.#stopListening();
  }

  resume() {
    this.#startListening();
    if (!this.#expanded) this.#drawCollapsed();
  }

  toggle() {
    this.#clearCollapsed();
    this.#expanded = !this.#expanded;
    if (this.#expanded) {
      // Dump full tool history on expand
      for (const t of this.#toolHistory) {
        this.#stream.write(`    ${colorForTool(t.tool)}↳ ${t.tool}${RESET}${t.detail ? ': ' + t.detail : ''}\n`);
      }
    } else {
      this.#drawCollapsed();
    }
  }

  // ── Event handlers ────────────────────────────────────────────────────

  toolUse(tool, detail) {
    this.#toolCount++;
    this.#stepStart = Date.now();
    const short = typeof detail === 'string' && detail.length > 60
      ? detail.slice(0, 57) + '...' : (detail || '');

    this.#toolHistory.push({ tool, detail: short });

    if (this.#expanded) {
      this.#stream.write(`    ${colorForTool(tool)}↳ ${tool}${RESET}${short ? ': ' + short : ''}\n`);
    } else {
      this.#drawCollapsed();
    }
  }

  toolSummary(summary) {
    const short = summary.length > 80 ? summary.slice(0, 77) + '...' : summary;
    this.#toolHistory.push({ tool: '✓', detail: short });

    if (this.#expanded) {
      this.#stream.write(`    ${GREEN}✓${RESET} ${short}\n`);
    } else {
      this.#drawCollapsed();
    }
  }

  toolProgress(tool, elapsed) {
    this.#toolHistory.push({ tool, detail: `(${Math.round(elapsed)}s)` });

    if (this.#expanded) {
      this.#stream.write(`    ${colorForTool(tool)}↳ ${tool}${RESET} ${DIM}(${Math.round(elapsed)}s)${RESET}\n`);
    } else {
      this.#drawCollapsed();
    }
  }

  stepStart(stepNum, totalSteps, stepId) {
    this.#clearCollapsed();
    this.#stopHeartbeat();
    this.#stream.write(`${BOLD}[${stepNum}/${totalSteps}]${RESET} ${stepId}...\n`);
    this.#toolCount = 0;
    this.#toolHistory = [];
    this.#stepStart = Date.now();
    this.#currentStepId = stepId;
    if (!this.#expanded) this.#drawCollapsed();
    this.#startHeartbeat();
  }

  subFlowStep(flowName, stepId) {
    this.#clearCollapsed();
    this.#stopHeartbeat();
    this.#stream.write(`  ${CYAN}[${flowName}]${RESET} ${stepId}...\n`);
    this.#toolHistory = [];
    this.#stepStart = Date.now();
    this.#currentStepId = `${flowName}/${stepId}`;
    if (!this.#expanded) this.#drawCollapsed();
    this.#startHeartbeat();
  }

  retry(flowName, stepId, agent) {
    this.#clearCollapsed();
    this.#stream.write(`  ${YELLOW}[${flowName}] ↻ Retrying ${stepId}${agent ? ` (${agent})` : ''}${RESET}\n`);
    if (!this.#expanded) this.#drawCollapsed();
  }

  fix(flowName, fixAgent, stepId) {
    this.#clearCollapsed();
    this.#stream.write(`  ${YELLOW}[${flowName}] ↻ Fix (${fixAgent}) for ${stepId}${RESET}\n`);
    if (!this.#expanded) this.#drawCollapsed();
  }

  warn(msg) {
    this.#clearCollapsed();
    this.#stream.write(`    ${RED}⚠ ${msg}${RESET}\n`);
    if (!this.#expanded) this.#drawCollapsed();
  }

  success(msg) {
    this.#clearCollapsed();
    this.#stream.write(`  ${GREEN}✓${RESET} ${msg}\n`);
    if (!this.#expanded) this.#drawCollapsed();
  }

  info(msg) {
    this.#clearCollapsed();
    this.#stream.write(`${msg}\n`);
    if (!this.#expanded) this.#drawCollapsed();
  }

  debug(msg) {
    if (!process.env.COMPOSE_DEBUG) return;
    if (this.#expanded) {
      this.#stream.write(`  ${DIM}[debug] ${msg}${RESET}\n`);
    }
  }

  finish() {
    this.#clearCollapsed();
    this.#stopHeartbeat();
    this.#stopListening();
  }

  // ── Collapsed view: last N tools + heartbeat + hints ──────────────────

  #drawCollapsed() {
    if (!this.#isTTY) return;

    // First erase any previously drawn collapsed block
    this.#eraseCollapsedBlock();

    const lines = [];

    // Last N tool events
    const recent = this.#toolHistory.slice(-COLLAPSED_LINES);
    for (const t of recent) {
      const color = colorForTool(t.tool);
      lines.push(`    ${color}↳ ${t.tool}${RESET}${t.detail ? ': ' + t.detail : ''}`);
    }

    // Heartbeat / status line
    const elapsed = Math.round((Date.now() - this.#stepStart) / 1000);
    const countStr = this.#toolCount > 0 ? `${this.#toolCount} calls` : 'waiting';
    lines.push(`  ${DIM}${this.#currentStepId} · ${elapsed}s · ${countStr}${RESET}`);

    // Key hints
    lines.push(HINT_BAR);

    // Write all lines
    for (const line of lines) {
      this.#stream.write(line + '\n');
    }

    this.#drawnCollapsedLines = lines.length;
  }

  #clearCollapsed() {
    this.#eraseCollapsedBlock();
  }

  #eraseCollapsedBlock() {
    if (!this.#isTTY || this.#drawnCollapsedLines === 0) return;
    // Move up and erase each line
    for (let i = 0; i < this.#drawnCollapsedLines; i++) {
      this.#stream.write(MOVE_UP(1) + ERASE_LINE);
    }
    this.#drawnCollapsedLines = 0;
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      if (!this.#expanded) {
        this.#drawCollapsed();
      } else {
        // In expanded mode, just print elapsed time
        const elapsed = Math.round((Date.now() - this.#stepStart) / 1000);
        this.#stream.write(`    ${DIM}… ${this.#currentStepId} (${elapsed}s)${RESET}\n`);
      }
    }, 5_000);
  }

  #stopHeartbeat() {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }
}
