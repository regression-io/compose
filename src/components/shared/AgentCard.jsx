import React, { useState, useEffect } from 'react';
import { cn } from '@/lib/utils.js';

function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m ${totalSec % 60}s`;
  const hrs = Math.floor(totalMin / 60);
  return `${hrs}h ${totalMin % 60}m`;
}

export default function AgentCard({ agent, toolCount, errorCount, currentTool, currentCategory, onStop }) {
  const isRunning = agent.status === 'running';
  const isKilled = agent.status === 'killed';
  const isFailed = agent.status === 'failed' || agent.status === 'error' || isKilled;
  const isComplete = !isRunning && !isFailed;
  const isSilent = agent.silent;

  const [elapsed, setElapsed] = useState(() => {
    const start = agent.startedAt ? new Date(agent.startedAt).getTime() : Date.now();
    const end = agent.completedAt ? new Date(agent.completedAt).getTime() : Date.now();
    return end - start;
  });

  useEffect(() => {
    if (!isRunning) return;
    const start = agent.startedAt ? new Date(agent.startedAt).getTime() : Date.now();
    const tick = () => setElapsed(Date.now() - start);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isRunning, agent.startedAt]);

  const agentLabel = agent.agentType || agent.type || agent.agent || 'agent';

  return (
    <div className="px-3 py-2 rounded border border-border bg-muted/20">
      {/* Line 1: agent type (left), status + dot + elapsed (right) */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-foreground font-medium truncate">
          {agentLabel}
        </span>
        <span className="flex items-center gap-1.5 shrink-0">
          <span
            className={cn(
              'w-1.5 h-1.5 rounded-full inline-block',
              isRunning && !isSilent && 'bg-green-400',
              isRunning && isSilent && 'bg-yellow-400',
              isComplete && 'bg-emerald-400',
              isFailed && 'bg-red-400',
            )}
            style={isRunning && !isSilent ? { animation: 'phase-active-pulse 2s ease-in-out infinite' } : undefined}
          />
          <span className={cn(
            'text-[10px]',
            isRunning && !isSilent && 'text-green-400',
            isRunning && isSilent && 'text-yellow-400',
            isComplete && 'text-emerald-400',
            isFailed && 'text-red-400',
          )}>
            {isSilent ? 'silent' : agent.status}
          </span>
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {formatElapsed(elapsed)}
          </span>
          {isRunning && onStop && (
            <button
              onClick={(e) => { e.stopPropagation(); onStop(agent.agentId || agent.id); }}
              className="text-[10px] text-muted-foreground hover:text-destructive cursor-pointer ml-0.5"
              title="Stop agent"
            >
              x
            </button>
          )}
        </span>
      </div>

      {/* Line 2: metrics */}
      <div className="text-[10px] text-muted-foreground mt-0.5">
        {toolCount != null && (
          <>
            <span>{toolCount} tools</span>
            <span className="mx-1">&middot;</span>
            <span className={cn(errorCount > 0 && 'text-red-400')}>
              {errorCount ?? 0} err
            </span>
            {isRunning && currentTool && (
              <>
                <span className="mx-1">&middot;</span>
                <span>{currentCategory || 'working'} ({currentTool})</span>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
