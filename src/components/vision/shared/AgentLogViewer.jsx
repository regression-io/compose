import React, { useState, useEffect, useRef, useCallback } from 'react';

/**
 * AgentLogViewer — polls GET /api/agent/:id and displays output + stderr.
 * Auto-scrolls unless user has scrolled up.
 */
function AgentLogViewer({ agentId, status }) {
  const [output, setOutput] = useState('');
  const [stderr, setStderr] = useState('');
  const containerRef = useRef(null);
  const userScrolledUp = useRef(false);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    userScrolledUp.current = el.scrollTop + el.clientHeight < el.scrollHeight - 20;
  }, []);

  // Auto-scroll to bottom on output change unless user scrolled up
  useEffect(() => {
    const el = containerRef.current;
    if (el && !userScrolledUp.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [output, stderr]);

  // Poll agent output
  useEffect(() => {
    if (!agentId) return;

    const doFetch = async () => {
      try {
        const res = await fetch(`/api/agent/${agentId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.output != null) setOutput(data.output);
        if (data.stderr != null) setStderr(data.stderr);
      } catch {
        // ignore fetch errors
      }
    };

    // Initial fetch
    doFetch();

    if (status === 'running') {
      const id = setInterval(doFetch, 2000);
      return () => clearInterval(id);
    }
    // Final fetch when status changed to complete/failed (already done by initial fetch above)
  }, [agentId, status]);

  const isEmpty = !output && !stderr;
  const isRunning = status === 'running';

  return (
    <div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="overflow-auto max-h-[300px] rounded bg-muted/30 p-2"
      >
        {isEmpty ? (
          <p className="text-[10px] font-mono text-muted-foreground italic">
            {isRunning ? 'Waiting for output...' : 'No output'}
          </p>
        ) : (
          <>
            {output && (
              <pre className="text-[10px] font-mono text-muted-foreground whitespace-pre-wrap break-all m-0">
                {output}
              </pre>
            )}
            {stderr && (
              <div className="mt-2">
                <span className="text-[10px] font-mono font-medium text-destructive">stderr</span>
                <pre className="text-[10px] font-mono text-destructive whitespace-pre-wrap break-all m-0 mt-0.5">
                  {stderr}
                </pre>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default React.memo(AgentLogViewer);
