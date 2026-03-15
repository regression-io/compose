/**
 * ContextPanel — collapsible right-side panel for contextual detail content.
 *
 * Renders as a percentage-width sidebar on the right of the main area.
 * Width is view-dependent: 40% for graph, 50% for tree, hidden for docs.
 * Includes a drag handle for user resize within ±15%.
 *
 * Props:
 *   isOpen    {boolean}   whether the panel is visible
 *   onToggle  {fn}        called when the user clicks the toggle
 *   width     {number}    panel width as fraction 0-1 (default 0.4)
 *   onResize  {fn}        called with new fraction when user drags the handle
 *   children  {node}      content to render inside the panel
 *   activeBuild {object}  active build state (for no-selection summary)
 *   gates     {array}     pending gates (for no-selection summary)
 *   agentErrors {array}   recent errors (for no-selection summary)
 *   items     {array}     all items (for no-selection summary)
 */
import React, { useCallback, useRef } from 'react';
import { CONTEXT_MIN_PX } from './contextPanelState.js';

export default function ContextPanel({
  isOpen = false,
  onToggle,
  width = 0.4,
  onResize,
  children,
  activeBuild,
  gates = [],
  agentErrors = [],
  items = [],
}) {
  const panelRef = useRef(null);
  const dragging = useRef(false);

  const handleDragStart = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;

    const onMove = (ev) => {
      if (!dragging.current) return;
      // Compute fraction relative to the panel's parent container
      const parent = panelRef.current?.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const fromRight = rect.right - ev.clientX;
      const newFraction = fromRight / rect.width;
      onResize?.(newFraction);
    };

    const onUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [onResize]);

  const pendingGates = gates.filter(g => g.status === 'pending' || g.status === 'awaiting');

  return (
    <div
      className="flex shrink-0 h-full"
      style={{ borderLeft: '1px solid hsl(var(--border))' }}
      data-context-panel-open={isOpen}
    >
      {/* Drag handle — between main area and panel */}
      {isOpen && onResize && (
        <div
          className="w-1 cursor-col-resize hover:bg-accent/30 active:bg-accent/50 transition-colors flex-shrink-0"
          onMouseDown={handleDragStart}
        />
      )}

      {/* Toggle tab */}
      <button
        className={[
          'w-4 h-full flex items-center justify-center',
          'text-[10px] text-muted-foreground hover:text-foreground',
          'transition-colors select-none',
        ].join(' ')}
        onClick={onToggle}
        title={isOpen ? 'Close context panel' : 'Open context panel'}
        aria-expanded={isOpen}
        aria-label="Toggle context panel"
        style={{ background: 'hsl(var(--muted) / 0.3)' }}
      >
        {isOpen ? '›' : '‹'}
      </button>

      {/* Panel body — ref used by drag handler to compute relative position */}
      {isOpen && (
        <div
          ref={panelRef}
          className="flex flex-col h-full overflow-hidden"
          style={{
            width: `${(width * 100)}%`,
            minWidth: `${CONTEXT_MIN_PX}px`,
            maxWidth: '60vw',
          }}
        >
          {/* Check if any child actually rendered (React children can be [false, false]) */}
          {React.Children.toArray(children).length > 0 ? (
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
              {children}
            </div>
          ) : (
            <ProjectSummary
              activeBuild={activeBuild}
              pendingGates={pendingGates}
              agentErrors={agentErrors}
              items={items}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * ProjectSummary — shown when no item is selected.
 * Replaces the old "No context selected" placeholder.
 */
function ProjectSummary({ activeBuild, pendingGates, agentErrors, items }) {
  const phaseDistribution = {};
  for (const item of items) {
    const phase = item.phase || 'unknown';
    phaseDistribution[phase] = (phaseDistribution[phase] || 0) + 1;
  }
  const totalItems = items.length || 1;

  const recentErrors = agentErrors.slice(-5);

  return (
    <>
      <div
        className="h-7 flex items-center px-3 shrink-0"
        style={{ borderBottom: '1px solid hsl(var(--border))' }}
      >
        <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
          Project Overview
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4">
        {/* Active build */}
        {activeBuild ? (
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Active Build</p>
            <div className="flex items-center gap-2">
              <span className="text-xs text-accent font-mono">{activeBuild.featureCode || '—'}</span>
              <span className="text-[10px] text-muted-foreground">·</span>
              <span className="text-[10px] text-foreground">{activeBuild.currentStep || activeBuild.step || '—'}</span>
            </div>
          </div>
        ) : (
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Build Status</p>
            <p className="text-[10px] text-muted-foreground italic">No active build</p>
          </div>
        )}

        {/* Pending gates */}
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1">
            Pending Gates ({pendingGates.length})
          </p>
          {pendingGates.length === 0 ? (
            <p className="text-[10px] text-muted-foreground italic">None</p>
          ) : (
            <div className="space-y-0.5">
              {pendingGates.slice(0, 5).map((g, i) => (
                <p key={i} className="text-[10px] text-amber-400 font-mono truncate">
                  {g.featureCode || g.stepId || g.id}
                </p>
              ))}
            </div>
          )}
        </div>

        {/* Recent errors */}
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1">
            Recent Errors ({recentErrors.length})
          </p>
          {recentErrors.length === 0 ? (
            <p className="text-[10px] text-muted-foreground italic">None</p>
          ) : (
            <div className="space-y-0.5">
              {recentErrors.map((e, i) => (
                <p key={i} className="text-[10px] text-destructive truncate">
                  {e.message || e.error || 'Error'}
                </p>
              ))}
            </div>
          )}
        </div>

        {/* Phase distribution */}
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1">
            Phase Distribution
          </p>
          <div className="flex h-2 rounded overflow-hidden gap-px">
            {Object.entries(phaseDistribution).map(([phase, count]) => (
              <div
                key={phase}
                className="h-full"
                style={{
                  width: `${(count / totalItems) * 100}%`,
                  background: 'hsl(var(--accent) / 0.6)',
                  minWidth: '2px',
                }}
                title={`${phase}: ${count}`}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
            {Object.entries(phaseDistribution).map(([phase, count]) => (
              <span key={phase} className="text-[9px] text-muted-foreground">
                {phase}: {count}
              </span>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
