import React, { useMemo } from 'react';

function relativeTime(ts) {
  if (!ts) return '';
  const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (diff < 5) return 'now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

/**
 * AgentRelayFeed — shows dispatch/result relay messages for a given agent.
 */
function AgentRelayFeed({ agentId, relays }) {
  const filtered = useMemo(() => {
    if (!relays || !agentId) return [];
    return relays.filter(r => r.fromAgentId === agentId || r.toAgentId === agentId);
  }, [relays, agentId]);

  if (filtered.length === 0) return null;

  return (
    <div>
      <p className="text-[10px] font-medium uppercase tracking-wider mb-0.5"
         style={{ color: 'hsl(var(--muted-foreground))' }}>
        Relays
      </p>
      <div className="space-y-0.5">
        {filtered.map((relay, i) => {
          const isResult = relay.direction === 'result';
          return (
            <div key={relay.id || i} className="flex items-start gap-1 text-[10px] font-mono">
              <span className={isResult ? 'text-foreground shrink-0' : 'text-muted-foreground shrink-0'}>
                {isResult ? '\u2192' : '\u2190'}
              </span>
              <span className={isResult ? 'text-foreground truncate' : 'text-muted-foreground truncate'}
                    title={relay.messagePreview}>
                {relay.messagePreview}
              </span>
              <span className="text-muted-foreground opacity-50 ml-auto shrink-0 tabular-nums">
                {relativeTime(relay.timestamp)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default React.memo(AgentRelayFeed);
