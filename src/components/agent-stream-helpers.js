/**
 * agent-stream-helpers.js — pure JS helpers extracted from AgentStream.jsx
 * for testability with node --test (no JSX/jsdom required).
 *
 * Also exports verbose stream state management (getVerboseStream,
 * setVerboseStream, hydrateVerboseStream, shouldIncludeMessage) so those
 * behaviors can be tested without importing the JSX component.
 */

// Tool category mapping — matches agent-hooks.js
const TOOL_CATEGORIES = {
  Read: 'reading', Glob: 'searching', Grep: 'searching',
  Write: 'writing', Edit: 'writing', NotebookEdit: 'writing',
  Bash: 'executing', Task: 'delegating', Skill: 'delegating',
  WebFetch: 'fetching', WebSearch: 'searching',
  TodoRead: 'reading', TodoWrite: 'writing',
};

export const CATEGORY_LABELS = {
  reading: 'Reading', writing: 'Writing', executing: 'Running',
  searching: 'Searching', fetching: 'Fetching', delegating: 'Delegating',
  thinking: 'Thinking', waiting: 'Waiting for gate approval',
};

// ---------------------------------------------------------------------------
// Verbose stream toggle state
// ---------------------------------------------------------------------------

const VERBOSE_STREAM_KEY = 'compose:verboseStream';

// Module-level state — shared with AgentStream.jsx via these exports
const _verboseState = { verboseStream: false };

/** Return the current verbose stream setting. */
export function getVerboseStream() {
  return _verboseState.verboseStream;
}

/**
 * Set the verbose stream toggle.
 * @param {*} val        Truthy/falsy — coerced to boolean.
 * @param {Storage} [storage]  Injectable storage (defaults to globalThis.localStorage).
 */
export function setVerboseStream(val, storage) {
  _verboseState.verboseStream = !!val;
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  if (store) {
    try { store.setItem(VERBOSE_STREAM_KEY, String(_verboseState.verboseStream)); } catch {}
  }
}

/**
 * Hydrate verbose stream state from localStorage (or injected storage).
 * Call once at app init. Safe to call when storage is unavailable.
 * @param {Storage} [storage]  Injectable storage (defaults to globalThis.localStorage).
 */
export function hydrateVerboseStream(storage) {
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!store) return;
  try {
    const raw = store.getItem(VERBOSE_STREAM_KEY);
    if (raw !== null) _verboseState.verboseStream = raw === 'true';
  } catch {}
}

// ---------------------------------------------------------------------------
// Message filter — verbose stream conditional
// ---------------------------------------------------------------------------

/**
 * Determine whether a message should be included in the render list.
 *
 * Returns `{ include: boolean, msg: object }` where `msg` may be a new
 * object with `verbose: true` tagged on (tool_progress / tool_use_summary
 * when verboseStream is enabled). The original message is never mutated.
 *
 * @param {object} msg           SSE message object
 * @param {boolean} verboseStream  Current verbose stream setting
 * @returns {{ include: boolean, msg: object }}
 */
export function shouldIncludeMessage(msg, verboseStream) {
  // stream_event is always filtered — unused by the UI
  if (msg.type === 'stream_event') {
    return { include: false, msg };
  }

  if (msg.type === 'tool_progress' || msg.type === 'tool_use_summary') {
    if (!verboseStream) {
      return { include: false, msg };
    }
    // Verbose mode: include with tag (new object, no mutation)
    return { include: true, msg: { ...msg, verbose: true } };
  }

  return { include: true, msg };
}

// ---------------------------------------------------------------------------
// Pre-grouping: pair tool_use → tool_use_summary (COMP-OBS-STREAM)
// ---------------------------------------------------------------------------

/**
 * Group consecutive tool_use → tool_use_summary pairs so that results render
 * attached below their tool call. The summary is consumed and attached as
 * `_toolResult` on the preceding tool_use message (shallow copy).
 *
 * Only pairs when:
 * - Current message is an assistant message with tool_use content blocks
 * - Next message is a tool_use_summary (subtype or type)
 *
 * @param {object[]} messages
 * @returns {object[]}
 */
export function groupToolResults(messages) {
  const grouped = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const next = messages[i + 1];

    // Check if current is a tool_use assistant message
    const hasToolUse = msg.type === 'assistant' &&
      msg.message?.content?.some(b => b.type === 'tool_use');

    // Check if next is a tool_use_summary
    const nextIsSummary = next && (
      next.type === 'tool_use_summary' ||
      (next.type === 'assistant' && next.subtype === 'tool_use_summary')
    );

    if (hasToolUse && nextIsSummary) {
      grouped.push({ ...msg, _toolResult: next });
      i++; // skip the consumed summary
    } else {
      grouped.push(msg);
    }
  }
  return grouped;
}

// ---------------------------------------------------------------------------
// Status derivation — replaces OSC title parsing
// ---------------------------------------------------------------------------

/**
 * Derive agent status from a message.
 * @param {object} msg  SSE message
 * @returns {{ status: string, tool: string|null, category: string|null, _source?: string }|null}
 */
export function deriveStatus(msg) {
  // Build events — derive with _source: 'build'
  if (msg._source === 'build') {
    if (msg.type === 'system') {
      if (msg.subtype === 'build_step' || msg.subtype === 'build_step_done' || msg.subtype === 'build_gate_resolved') {
        return { status: 'working', tool: null, category: 'thinking', _source: 'build' };
      }
      if (msg.subtype === 'build_gate') {
        return { status: 'working', tool: null, category: 'waiting', _source: 'build' };
      }
      if (msg.subtype === 'build_end') {
        return { status: 'idle', tool: null, category: null, _source: 'build' };
      }
    }
    if (msg.type === 'error' && msg.source === 'build') {
      return { status: 'working', tool: null, category: 'thinking', _source: 'build' };
    }
    if (msg.type === 'assistant') {
      const content = msg.message?.content ?? [];
      for (const block of content) {
        if (block.type === 'tool_use') {
          const category = TOOL_CATEGORIES[block.name] || 'thinking';
          return { status: 'working', tool: block.name, category, _source: 'build' };
        }
      }
      if (content.some(b => b.type === 'text')) {
        return { status: 'working', tool: null, category: 'thinking', _source: 'build' };
      }
    }
    return null;
  }

  // Interactive events
  if (msg.type === 'assistant') {
    const content = msg.message?.content ?? [];
    for (const block of content) {
      if (block.type === 'tool_use') {
        const category = TOOL_CATEGORIES[block.name] || 'thinking';
        return { status: 'working', tool: block.name, category };
      }
    }
    if (content.some(b => b.type === 'text')) {
      return { status: 'working', tool: null, category: 'thinking' };
    }
  }
  if (msg.type === 'result') {
    return { status: 'idle', tool: null, category: null };
  }
  return null;
}

/**
 * Merge per-source statuses to determine the displayed status.
 * @param {{ build: object|null, interactive: object|null }} sourceStatus
 * @returns {{ status: string, tool: string|null, category: string|null }}
 */
export function mergeSourceStatus(sourceStatus) {
  const build = sourceStatus.build;
  const interactive = sourceStatus.interactive;

  // Priority: interactive > build
  if (interactive?.status === 'working') {
    return { status: interactive.status, tool: interactive.tool, category: interactive.category };
  }
  if (build?.status === 'working') {
    return { status: build.status, tool: build.tool, category: build.category };
  }
  return { status: 'idle', tool: null, category: null };
}
