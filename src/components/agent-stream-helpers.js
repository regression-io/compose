/**
 * agent-stream-helpers.js — pure JS helpers extracted from AgentStream.jsx
 * for testability with node --test (no JSX/jsdom required).
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
