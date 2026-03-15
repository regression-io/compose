/**
 * AgentBar — always-present collapsible panel at the bottom of the cockpit.
 *
 * Three states (controlled by `barState` prop):
 *   collapsed  — thin strip showing agent status text + toggle button (h-7)
 *   expanded   — message stream + chat input (~40 vh)
 *   maximized  — fills the entire main workspace (flex-1, managed by parent)
 *
 * The parent (CockpitLayout / AppInner) owns `barState` and passes
 * `onStateChange` so the bar can request state transitions.
 *
 * In `collapsed` state the bar listens for `compose:agent-status` custom
 * events emitted by AgentStream to show a live status line without mounting
 * the full stream UI.
 *
 * Props:
 *   barState      {'collapsed'|'expanded'|'maximized'}
 *   onStateChange {fn}  called with next state string
 */
import React, { useState, useEffect, useCallback } from 'react';
import AgentStream from '../AgentStream.jsx';
import {
  nextAgentBarState,
  collapseAgentBar,
  maximizeAgentBar,
  agentBarHeightClass,
} from './agentBarState.js';

// Icon helpers (text-based — no extra dep)
const CHEVRON_DOWN = '▾';
const CHEVRON_UP   = '▴';
const EXPAND_ICON  = '⤢';   // maximized

export default function AgentBar({ barState = 'collapsed', onStateChange }) {
  const [statusText, setStatusText] = useState('idle');
  const [parallelProgress, setParallelProgress] = useState(null);

  // Listen for compose:agent-status events to power the collapsed status line
  useEffect(() => {
    function handleStatus(e) {
      const { status, tool, category, parallelTasks } = e.detail ?? {};

      // Track parallel task progress
      setParallelProgress(parallelTasks ?? null);

      if (parallelTasks) {
        const { total, completed, failed, active } = parallelTasks;
        setStatusText(`\u2225 ${completed}/${total} tasks${failed ? ` (${failed} failed)` : ''}${active ? ` \u2022 ${active} active` : ''}`);
      } else if (status === 'idle') {
        setStatusText('idle');
      } else if (tool) {
        setStatusText(`${tool} — ${category ?? status}`);
      } else if (category) {
        setStatusText(category);
      } else {
        setStatusText(status ?? 'idle');
      }
    }
    window.addEventListener('compose:agent-status', handleStatus);
    return () => window.removeEventListener('compose:agent-status', handleStatus);
  }, []);

  const cycle = useCallback(() => {
    onStateChange?.(nextAgentBarState(barState));
  }, [barState, onStateChange]);

  const collapse = useCallback(() => {
    onStateChange?.(collapseAgentBar(barState));
  }, [barState, onStateChange]);

  const maximize = useCallback(() => {
    onStateChange?.(maximizeAgentBar(barState));
  }, [barState, onStateChange]);

  // The height class is applied by the parent layout (flex-1 or fixed h-*).
  // AgentBar itself only renders content.
  const isCollapsed  = barState === 'collapsed';
  const isExpanded   = barState === 'expanded';
  const isMaximized  = barState === 'maximized';

  return (
    <div
      className="flex flex-col shrink-0 overflow-hidden"
      style={{ borderTop: '1px solid hsl(var(--border))' }}
      data-agent-bar-state={barState}
    >
      {/* ------------------------------------------------------------------ */}
      {/* Title / status strip — always visible                               */}
      {/* ------------------------------------------------------------------ */}
      <div
        className="flex items-center gap-2 px-3 h-7 shrink-0 select-none"
        style={{ borderBottom: isCollapsed ? 'none' : '1px solid hsl(var(--border) / 0.5)' }}
      >
        {/* Expand / cycle button */}
        <button
          className="compose-btn-icon shrink-0"
          onClick={cycle}
          title={
            isCollapsed ? 'Expand agent bar' :
            isExpanded  ? 'Maximize agent bar' :
            'Collapse agent bar'
          }
          aria-label="Toggle agent bar"
        >
          {isCollapsed  ? CHEVRON_UP :
           isExpanded   ? EXPAND_ICON :
           CHEVRON_DOWN}
        </button>

        {/* Label */}
        <span
          className="text-[10px] uppercase tracking-wider font-semibold shrink-0"
          style={{ color: 'hsl(var(--accent))' }}
        >
          Agent
        </span>

        {/* Status text (collapsed: live status; expanded/max: summary) */}
        <span
          className="flex-1 min-w-0 truncate text-[11px] font-mono"
          style={{ color: 'hsl(var(--muted-foreground))' }}
        >
          {statusText}
        </span>

        {/* Parallel progress bar — shown when parallel tasks are active */}
        {parallelProgress && parallelProgress.total > 0 && (
          <div
            className="shrink-0 flex items-center gap-1"
            title={`${parallelProgress.completed}/${parallelProgress.total} tasks complete`}
          >
            <div
              style={{
                width: 48, height: 4, borderRadius: 2,
                background: 'hsl(var(--muted))',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${(parallelProgress.completed / parallelProgress.total) * 100}%`,
                  height: '100%', borderRadius: 2,
                  background: parallelProgress.failed
                    ? 'hsl(var(--destructive))'
                    : 'hsl(var(--accent))',
                  transition: 'width 300ms ease',
                }}
              />
            </div>
          </div>
        )}

        {/* Collapse button (only in expanded / maximized) */}
        {!isCollapsed && (
          <button
            className="compose-btn-icon shrink-0"
            onClick={collapse}
            title="Collapse agent bar"
            aria-label="Collapse agent bar"
          >
            {CHEVRON_DOWN}
          </button>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Stream content — shown in expanded and maximized states             */}
      {/* ------------------------------------------------------------------ */}
      {!isCollapsed && (
        <div className="flex-1 min-h-0 overflow-hidden">
          <AgentStream />
        </div>
      )}
    </div>
  );
}
