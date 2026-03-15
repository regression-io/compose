/**
 * ContextPanel — collapsible right-side panel for contextual detail content.
 *
 * Width is view-dependent and resizable via drag handle.
 *
 * Props:
 *   isOpen      {boolean}  whether the panel is visible
 *   onToggle    {fn}       called when the user clicks the toggle
 *   widthPx     {number}   panel width in pixels (computed by App.jsx)
 *   onResizePx  {fn}       called with new pixel width when user drags
 *   children    {node}     content to render inside the panel
 *   activeBuild {object}   active build state (for no-selection summary)
 *   gates       {array}    pending gates (for no-selection summary)
 *   agentErrors {array}    recent errors (for no-selection summary)
 *   items       {array}    all items (for no-selection summary)
 */
import React, { useCallback, useRef } from 'react';

const MIN_WIDTH = 280;
const MAX_WIDTH_FRACTION = 0.6;

export default function ContextPanel({
  isOpen = false,
  onToggle,
  widthPx = 380,
  onResizePx,
  children,
  activeBuild,
  gates = [],
  agentErrors = [],
  items = [],
}) {
  const dragging = useRef(false);

  const handleDragStart = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;

    const onMove = (ev) => {
      if (!dragging.current) return;
      const newWidth = window.innerWidth - ev.clientX;
      const max = window.innerWidth * MAX_WIDTH_FRACTION;
      const clamped = Math.max(MIN_WIDTH, Math.min(max, newWidth));
      onResizePx?.(clamped);
    };

    const onUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [onResizePx]);

  const pendingGates = gates.filter(g => g.status === 'pending' || g.status === 'awaiting');

  return (
    <div
      className="flex shrink-0 h-full"
      style={{ borderLeft: '1px solid hsl(var(--border))' }}
      data-context-panel-open={isOpen}
    >
      {/* Drag handle */}
      {isOpen && onResizePx && (
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

      {/* Panel body */}
      {isOpen && (
        <div
          className="flex flex-col h-full overflow-hidden"
          style={{ width: `${widthPx}px` }}
        >
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
