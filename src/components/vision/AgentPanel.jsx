import React from 'react';
import AgentLogViewer from './shared/AgentLogViewer.jsx';
import AgentRelayFeed from './shared/AgentRelayFeed.jsx';
import { cn } from '@/lib/utils.js';
import { AGENT_CATEGORY_COLORS } from './constants.js';

const CATEGORY_LABELS = {
  reading: 'Reading', writing: 'Writing', executing: 'Running',
  searching: 'Searching', fetching: 'Fetching', delegating: 'Delegating',
  thinking: 'Thinking',
};

const ERROR_TYPE_LABELS = {
  build_error: 'Build', test_failure: 'Test', lint_error: 'Lint',
  git_conflict: 'Conflict', permission_error: 'Permission', not_found: 'Not Found',
  runtime_error: 'Error',
};

function formatElapsed(ms) {
  if (!ms || ms < 1000) return '<1s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

const SessionTimer = React.memo(function SessionTimer({ startedAt, active, duration }) {
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    if (!active) return;
    const id = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(id);
  }, [active]);

  const elapsed = active
    ? Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)
    : (duration || 0);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return <span className="tabular-nums">{m}m {String(s).padStart(2, '0')}s</span>;
});

/**
 * AgentPanel — volatile telemetry display for agent status, activity, errors, and session info.
 * Extracted from AppSidebar to isolate high-frequency re-renders from stable navigation.
 *
 * COMP-UX-6: Per-agent log viewer tabs. When agents are spawned, a tab bar appears
 * with "Session" (existing content) and one tab per agent showing log output + relay feed.
 */
function AgentPanel({ agentActivity, agentErrors, sessionState, onSelectItem, spawnedAgents, agentRelays, onStopAgent }) {
  const [selectedAgent, setSelectedAgent] = React.useState(null);
  const [agentState, setAgentState] = React.useState({
    status: 'idle', tool: null, category: null, activityLog: [], currentActivity: null,
  });
  const [, tick] = React.useState(0);
  const [resolvedItems, setResolvedItems] = React.useState([]);
  const resolvedTimerRef = React.useRef(null);

  // Listen for OSC-sourced agent status from Terminal
  React.useEffect(() => {
    const handler = (e) => setAgentState(e.detail);
    window.addEventListener('compose:agent-status', handler);
    return () => window.removeEventListener('compose:agent-status', handler);
  }, []);

  // Tick elapsed time while agent is working
  React.useEffect(() => {
    if (agentState.status !== 'working') return;
    const id = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(id);
  }, [agentState.status]);

  // Extract resolved items from hook-sourced activity and fade after 30s
  React.useEffect(() => {
    if (!agentActivity || agentActivity.length === 0) return;
    const latest = agentActivity[agentActivity.length - 1];
    if (Array.isArray(latest.items) && latest.items.length > 0) {
      setResolvedItems(latest.items);
      if (resolvedTimerRef.current) clearTimeout(resolvedTimerRef.current);
      resolvedTimerRef.current = setTimeout(() => setResolvedItems([]), 30000);
    }
  }, [agentActivity]);

  // Cleanup timer on unmount
  React.useEffect(() => {
    return () => {
      if (resolvedTimerRef.current) clearTimeout(resolvedTimerRef.current);
    };
  }, []);

  return (
    <>
      {/* COMP-UX-6: Tab bar — only shown when agents exist */}
      {spawnedAgents && spawnedAgents.length > 0 && (
        <div className="flex items-center gap-0.5 mb-1.5 overflow-x-auto px-3">
          <button
            onClick={() => setSelectedAgent(null)}
            className={cn(
              'text-[10px] px-2 py-0.5 rounded cursor-pointer transition-colors border shrink-0',
              !selectedAgent
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-transparent text-muted-foreground border-border hover:text-foreground'
            )}
          >Session</button>
          {spawnedAgents.map(a => (
            <span key={a.agentId} className="flex items-center gap-0 shrink-0">
              <button
                onClick={() => setSelectedAgent(a.agentId)}
                className={cn(
                  'text-[10px] px-2 py-0.5 rounded-l cursor-pointer transition-colors border flex items-center gap-1 shrink-0',
                  selectedAgent === a.agentId
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-transparent text-muted-foreground border-border hover:text-foreground'
                )}
              >
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{
                  background: a.status === 'killed' ? 'hsl(var(--destructive))'
                    : a.silent ? 'hsl(45 93% 47%)'
                    : a.status === 'running' ? 'hsl(var(--success))'
                    : a.status === 'complete' ? 'hsl(142 71% 45%)' : 'hsl(var(--destructive))',
                  animation: a.status === 'running' && !a.silent ? 'phase-active-pulse 2s ease-in-out infinite' : 'none',
                }} />
                {a.agentType}
                {a.silent && <span className="text-[8px] text-yellow-500 ml-0.5" title="Agent silent">!</span>}
              </button>
              {a.status === 'running' && onStopAgent && (
                <button
                  onClick={(e) => { e.stopPropagation(); onStopAgent(a.agentId); }}
                  className="text-[10px] px-1 py-0.5 rounded-r border border-l-0 border-border hover:bg-destructive/20 hover:text-destructive cursor-pointer transition-colors"
                  title="Stop agent"
                >
                  x
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {/* COMP-UX-6: Per-agent view or Session (existing) content */}
      {selectedAgent ? (
        <div className="px-3 pb-2 space-y-2">
          <AgentLogViewer
            agentId={selectedAgent}
            status={spawnedAgents.find(a => a.agentId === selectedAgent)?.status}
          />
          <AgentRelayFeed agentId={selectedAgent} relays={agentRelays} />
        </div>
      ) : (
        <>
          {/* Session info */}
          {sessionState?.featureCode && (
            <div className="px-3 py-1.5 mb-1 rounded bg-muted/50">
              <div className="flex items-center gap-1.5 text-[10px]">
                <span className="text-muted-foreground">Working on</span>
                <button
                  className="font-medium text-foreground hover:underline"
                  onClick={() => sessionState.featureItemId && onSelectItem?.(sessionState.featureItemId)}
                >
                  {sessionState.featureCode}
                </button>
              </div>
              {sessionState.phaseAtBind && (
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  Phase: {sessionState.phaseAtBind.replace(/_/g, ' ')}
                </div>
              )}
            </div>
          )}
          {sessionState && (
            <div className="px-3 pb-1">
              <div className="flex items-center gap-1.5 text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{
                  background: sessionState.active ? 'hsl(var(--primary))' : 'hsl(var(--success))',
                }} />
                <SessionTimer startedAt={sessionState.startedAt} active={sessionState.active} duration={sessionState.duration} />
                <span className="tabular-nums">{sessionState.toolCount || 0} tools</span>
                {sessionState.errorCount > 0 && (
                  <span style={{ color: 'hsl(var(--destructive))' }}>{sessionState.errorCount} err</span>
                )}
                {!sessionState.active && sessionState.journalSpawned && (
                  <span style={{ color: 'hsl(var(--primary))' }}>journal</span>
                )}
              </div>
              {sessionState.summaries?.length > 0 && (
                <p className="text-[10px] mt-0.5 truncate" style={{ color: 'hsl(var(--muted-foreground))', opacity: 0.7 }}
                  title={sessionState.summaries[sessionState.summaries.length - 1]?.summary}>
                  {sessionState.summaries[sessionState.summaries.length - 1]?.summary}
                </p>
              )}
            </div>
          )}

          {/* Agent activity */}
          <div className="px-3 pb-2">
            <div className="rounded-md p-2" style={{ background: 'hsl(var(--accent))' }}>
              <div className="flex items-center gap-1.5 mb-1">
                <div
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{
                    background: agentState.status === 'working' ? 'var(--color-category-writing)' : 'hsl(var(--success))',
                    animation: agentState.status === 'working' ? 'pulse 1.5s ease-in-out infinite' : 'none',
                  }}
                />
                <span className="text-[10px] font-medium uppercase tracking-wider" style={{
                  color: agentState.status === 'working' ? 'var(--color-category-writing)' : 'hsl(var(--muted-foreground))',
                }}>
                  {agentState.status === 'working'
                    ? (CATEGORY_LABELS[agentState.category] || 'Working')
                    : 'Idle'}
                </span>
                {agentState.status === 'working' && agentState.tool && (
                  <span className="text-[10px] tracking-wider" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    {agentState.tool}
                  </span>
                )}
                {agentState.status === 'working' && agentState.currentActivity && (
                  <span className="text-[10px] tabular-nums ml-auto" style={{ color: 'hsl(var(--muted-foreground))', opacity: 0.6 }}>
                    {formatElapsed(Date.now() - agentState.currentActivity.startTime)}
                  </span>
                )}
              </div>
              {/* Recent activity strip */}
              {agentState.activityLog && agentState.activityLog.length > 0 && (
                <div className="flex items-center gap-0.5 mt-1">
                  {agentState.activityLog.slice(-6).map((entry, i, arr) => (
                    <div
                      key={i}
                      className="h-1 rounded-full"
                      title={`${entry.tool || 'thinking'} — ${formatElapsed(entry.duration)}`}
                      style={{
                        width: Math.max(4, Math.min(16, (entry.duration || 0) / 1000 * 2)),
                        background: AGENT_CATEGORY_COLORS[entry.category] || (agentState.status === 'working' ? 'var(--color-category-writing)' : 'hsl(var(--success))'),
                        opacity: 0.2 + (i / arr.length) * 0.6,
                      }}
                    />
                  ))}
                </div>
              )}
              {/* Hook-sourced activity feed */}
              {agentActivity && agentActivity.length > 0 && (
                <div className="mt-1.5 space-y-0.5">
                  {agentActivity.slice(-4).map((entry, i) => (
                    <div key={i} className="flex items-center gap-1 text-[10px]" style={{ color: entry.error ? 'hsl(var(--destructive))' : 'hsl(var(--muted-foreground))' }}>
                      {entry.error && (
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'hsl(var(--destructive))' }} />
                      )}
                      <span className="font-medium shrink-0">{entry.tool}</span>
                      {entry.category && !entry.error && (
                        <span className="shrink-0 opacity-50"
                          style={{ color: AGENT_CATEGORY_COLORS[entry.category] }}>
                          {entry.category}
                        </span>
                      )}
                      {entry.error ? (
                        <span className="truncate" title={entry.error.type}>
                          {ERROR_TYPE_LABELS[entry.error.type] || entry.error.type}
                        </span>
                      ) : entry.detail ? (
                        <span className="truncate opacity-60" title={entry.detail}>
                          {entry.detail.split('/').pop()}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
              {/* Resolved tracker items */}
              {resolvedItems.length > 0 && (
                <div className="mt-1.5">
                  <p className="text-[10px] font-medium uppercase tracking-wider mb-0.5"
                     style={{ color: 'hsl(var(--muted-foreground))' }}>
                    Working on
                  </p>
                  {resolvedItems.slice(0, 3).map(item => (
                    <div key={item.id}
                      className="flex items-center gap-1 text-[10px] py-0.5"
                      style={{ color: 'hsl(var(--muted-foreground))' }}>
                      <span>{item.status === 'in_progress' ? '◆' : '◇'}</span>
                      <span className="truncate">{item.title}</span>
                    </div>
                  ))}
                </div>
              )}
              {/* Recent errors */}
              {agentErrors && agentErrors.length > 0 && (
                <div className="mt-1.5">
                  <p className="text-[10px] font-medium uppercase tracking-wider mb-0.5"
                     style={{ color: 'hsl(var(--destructive))' }}>
                    Errors
                  </p>
                  {agentErrors.slice(-3).map((err, i) => (
                    <div key={i} className="flex items-center gap-1 text-[10px] py-0.5"
                      style={{ color: 'hsl(var(--destructive))' }}>
                      <span className="font-medium shrink-0">
                        {ERROR_TYPE_LABELS[err.errorType] || err.errorType}
                      </span>
                      <span className="truncate opacity-70" title={err.message}>
                        {err.message}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {/* Spawned subagents */}
              {spawnedAgents && spawnedAgents.length > 0 && (
                <div className="mt-1.5">
                  <p className="text-[10px] font-medium uppercase tracking-wider mb-0.5"
                     style={{ color: 'hsl(var(--muted-foreground))' }}>
                    Subagents
                  </p>
                  {spawnedAgents.map(agent => (
                    <div key={agent.agentId}
                      className="flex items-center gap-1.5 text-[10px] py-0.5"
                      style={{ color: 'hsl(var(--muted-foreground))' }}>
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{
                        background: agent.status === 'running'
                          ? 'var(--color-category-executing)'
                          : agent.status === 'complete' ? 'hsl(var(--success))' : 'hsl(var(--destructive))',
                        animation: agent.status === 'running' ? 'pulse 1.5s ease-in-out infinite' : 'none',
                      }} />
                      <span className="font-medium shrink-0">{agent.agentType}</span>
                      <span className="truncate opacity-60">{agent.status}</span>
                      <span className="tabular-nums ml-auto opacity-50">
                        {formatElapsed(Date.now() - new Date(agent.startedAt).getTime())}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}

export default React.memo(AgentPanel);
