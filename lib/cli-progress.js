/**
 * cli-progress.js — Ink-based TUI for compose build.
 *
 * Renders a live terminal UI with step progress, tool activity,
 * heartbeat timer, and key commands (t: toggle, s: skip, r: retry).
 *
 * Uses React.createElement (no JSX) since CLI code runs without a build step.
 */

import { EventEmitter } from 'node:events';
import React, { useState, useEffect, useRef } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';

const h = React.createElement;

// ---------------------------------------------------------------------------
// Tool color map
// ---------------------------------------------------------------------------

const TOOL_COLORS = {
  Bash: 'cyan', bash: 'cyan',
  Read: 'green', read: 'green',
  Write: 'yellow', write: 'yellow',
  Edit: 'yellow', edit: 'yellow',
  Glob: 'magenta', glob: 'magenta',
  Grep: 'magenta', grep: 'magenta',
  Agent: 'cyanBright', agent: 'cyanBright',
};

// ---------------------------------------------------------------------------
// Ink component — the live TUI
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function useSpinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame(f => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return SPINNER_FRAMES[frame];
}

function BuildUI({ controller }) {
  const { exit } = useApp();
  const spinner = useSpinner();
  const [state, setState] = useState({
    step: null,        // { num, total, id }
    subFlow: null,     // { flowName, stepId }
    tools: [],         // [{ tool, detail }]
    expanded: false,
    messages: [],      // [{ text, color, bold, dim }]
    heartbeat: null,   // elapsed seconds string
    running: false,
  });

  useEffect(() => {
    const handler = (patch) => setState(prev => ({ ...prev, ...patch }));
    controller.on('state', handler);
    return () => controller.removeListener('state', handler);
  }, [controller]);

  useInput((input, key) => {
    if (input === 't' || input === 'T') controller._toggleExpanded();
    if (input === 's' || input === 'S') controller._requestAction('skip');
    if (input === 'r' || input === 'R') controller._requestAction('retry');
    if (key.ctrl && input === 'c') {
      controller.finish();
      exit();
      process.exit(130);
    }
  });

  const { step, subFlow, tools, expanded, messages, heartbeat, running } = state;

  const children = [];

  // Sticky messages (step starts, retries, warnings)
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    children.push(
      h(Text, {
        key: `msg-${i}`,
        color: msg.color || undefined,
        bold: msg.bold || false,
        dimColor: msg.dim || false,
      }, msg.text)
    );
  }

  // Active step with spinner
  if (running && step) {
    const stepLabel = subFlow ? `${subFlow.flowName}/${subFlow.stepId}` : step.id;
    children.push(
      h(Box, { key: 'active-step' },
        h(Text, { color: 'cyan', bold: true }, spinner, ' '),
        h(Text, { bold: true }, `[${step.num}/${step.total}]`),
        h(Text, null, ` ${stepLabel}`),
        heartbeat ? h(Text, { dimColor: true }, ` (${heartbeat})`) : null,
      )
    );
  }

  // Tool activity
  if (expanded && tools.length > 0) {
    const recent = tools.slice(-8);
    children.push(
      h(Box, { key: 'tools', flexDirection: 'column', marginLeft: 4 },
        ...recent.map((t, i) =>
          h(Text, { key: `t-${i}`, color: TOOL_COLORS[t.tool] || 'gray' },
            `↳ ${t.tool}${t.detail ? ': ' + t.detail : ''}`)
        )
      )
    );
  } else if (!expanded && tools.length > 0) {
    const last = tools[tools.length - 1];
    children.push(
      h(Box, { key: 'tools-collapsed', marginLeft: 4 },
        h(Text, { dimColor: true },
          `↳ ${last.tool}${last.detail ? ': ' + last.detail : ''} [${tools.length} calls]`)
      )
    );
  }

  // Key hints
  if (running) {
    children.push(
      h(Text, { key: 'hints', dimColor: true }, '  keys: t=toggle  s=skip  r=retry')
    );
  }

  return h(Box, { flexDirection: 'column' }, ...children);
}

// ---------------------------------------------------------------------------
// CliProgress — public API (unchanged interface)
// ---------------------------------------------------------------------------

export class CliProgress extends EventEmitter {
  #inkInstance = null;
  #expanded = false;
  #pendingAction = null;
  #heartbeatTimer = null;
  #stepStart = 0;
  #stream;
  #state = {
    step: null,
    subFlow: null,
    tools: [],
    expanded: false,
    messages: [],
    heartbeat: null,
    running: false,
  };

  constructor({ stream, expanded = false } = {}) {
    super();
    this.#stream = stream ?? process.stderr;
    this.#expanded = expanded;
    this.#state.expanded = expanded;
    this.#mount();
  }

  get expanded() { return this.#expanded; }

  consumeAction() {
    const action = this.#pendingAction;
    this.#pendingAction = null;
    return action;
  }

  get pendingAction() { return this.#pendingAction; }

  // ── Called by BuildUI key handler ─────────────────────────────────────

  _toggleExpanded() {
    this.#expanded = !this.#expanded;
    this.#pushState({ expanded: this.#expanded });
  }

  _requestAction(action) {
    this.#pendingAction = action;
    const label = action === 'skip' ? '⏭ Skip' : '↻ Retry';
    this.#pushMessage(`  ${label} requested — interrupting current step...`, 'yellow');
    this.emit('interrupt');
  }

  // ── Event handlers (called from build.js / result-normalizer) ─────────

  stepStart(stepNum, totalSteps, stepId) {
    this.#stopHeartbeat();
    this.#pushMessage(`[${stepNum}/${totalSteps}] ${stepId}...`, null, true);
    this.#state.step = { num: stepNum, total: totalSteps, id: stepId };
    this.#state.subFlow = null;
    this.#state.tools = [];
    this.#stepStart = Date.now();
    this.#pushState({ step: this.#state.step, subFlow: null, tools: [], heartbeat: null, running: true });
    this.#startHeartbeat();
  }

  subFlowStep(flowName, stepId) {
    this.#stopHeartbeat();
    this.#pushMessage(`  [${flowName}] ${stepId}...`, 'cyan');
    this.#state.subFlow = { flowName, stepId };
    this.#state.tools = [];
    this.#stepStart = Date.now();
    this.#pushState({ subFlow: this.#state.subFlow, tools: [], heartbeat: null });
    this.#startHeartbeat();
  }

  toolUse(tool, detail) {
    this.#stepStart = Date.now();
    const short = typeof detail === 'string' && detail.length > 60
      ? detail.slice(0, 57) + '...'
      : (detail || '');
    this.#state.tools = [...this.#state.tools, { tool, detail: short }];
    this.#pushState({ tools: this.#state.tools, heartbeat: null });
  }

  toolSummary(summary) {
    const short = summary.length > 80 ? summary.slice(0, 77) + '...' : summary;
    this.#state.tools = [...this.#state.tools, { tool: '✓', detail: short }];
    this.#pushState({ tools: this.#state.tools });
  }

  toolProgress(tool, elapsed) {
    this.#state.tools = [...this.#state.tools, { tool, detail: `(${Math.round(elapsed)}s)` }];
    this.#pushState({ tools: this.#state.tools });
  }

  retry(flowName, stepId, agent) {
    this.#pushMessage(`  [${flowName}] ↻ Retrying ${stepId}${agent ? ` (${agent})` : ''}`, 'yellow');
  }

  fix(flowName, fixAgent, stepId) {
    this.#pushMessage(`  [${flowName}] ↻ Fix (${fixAgent}) for ${stepId}`, 'yellow');
  }

  warn(msg) {
    this.#pushMessage(`    ⚠ ${msg}`, 'red');
  }

  success(msg) {
    this.#pushMessage(`  ✓ ${msg}`, 'green');
  }

  info(msg) {
    this.#pushMessage(msg);
  }

  debug(msg) {
    if (!process.env.COMPOSE_DEBUG) return;
    this.#pushMessage(`  [debug] ${msg}`, 'gray', false, true);
  }

  pause() {
    this.#stopHeartbeat();
    if (this.#inkInstance) {
      this.#inkInstance.unmount();
      this.#inkInstance = null;
    }
  }

  resume() {
    this.#mount();
    this.#pushState({ ...this.#state });
  }

  finish() {
    this.#stopHeartbeat();
    this.#pushState({ running: false });
    if (this.#inkInstance) {
      this.#inkInstance.unmount();
      this.#inkInstance = null;
    }
  }

  toggle() {
    this._toggleExpanded();
  }

  // ── Internal ──────────────────────────────────────────────────────────

  #mount() {
    if (this.#inkInstance) return;
    const isTTY = this.#stream.isTTY ?? false;
    if (!isTTY) return;
    try {
      this.#inkInstance = render(
        h(BuildUI, { controller: this }),
        { stdout: this.#stream, exitOnCtrlC: false }
      );
    } catch {
      this.#inkInstance = null;
    }
  }

  #pushState(patch) {
    Object.assign(this.#state, patch);
    this.emit('state', patch);
  }

  #pushMessage(text, color = null, bold = false, dim = false) {
    const messages = [...this.#state.messages, { text, color, bold, dim }].slice(-50);
    this.#state.messages = messages;
    this.#pushState({ messages });

    // Fallback for non-TTY
    if (!this.#inkInstance) {
      this.#stream.write(text + '\n');
    }
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      const elapsed = Math.round((Date.now() - this.#stepStart) / 1000);
      this.#pushState({ heartbeat: `${elapsed}s` });
    }, 5_000);
  }

  #stopHeartbeat() {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }
}
