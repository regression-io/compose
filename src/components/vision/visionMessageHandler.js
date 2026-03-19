/**
 * visionMessageHandler.js — Extracted WebSocket message dispatch logic.
 *
 * Pure function that takes a parsed WS message, ref objects, and setter
 * callbacks. Testable without React or jsdom.
 */

export function handleVisionMessage(msg, refs, setters) {
  const {
    prevItemMapRef, snapshotProviderRef, gatesRef, pendingResolveIdsRef,
    changeTimerRef, sessionEndTimerRef, wsRef,
  } = refs;

  const {
    setItems, setConnections, setGates, setGateEvent,
    setRecentChanges, setUICommand, setAgentActivity,
    setAgentErrors, setSessionState, setSpawnedAgents, setSettings, setActiveBuild, setSessions, EMPTY_CHANGES,
  } = setters;

  if (msg.type === 'visionState') {
    const incoming = msg.items || [];

    // Diff for animations (skip initial load)
    if (prevItemMapRef.current) {
      const prev = prevItemMapRef.current;
      const added = new Set();
      const changed = new Set();
      for (const item of incoming) {
        const old = prev.get(item.id);
        if (!old) {
          added.add(item.id);
        } else if (old.status !== item.status || old.confidence !== item.confidence || old.title !== item.title) {
          changed.add(item.id);
        }
      }
      if (added.size > 0 || changed.size > 0) {
        setRecentChanges({ newIds: added, changedIds: changed });
        if (changeTimerRef.current) clearTimeout(changeTimerRef.current);
        changeTimerRef.current = setTimeout(() => setRecentChanges(EMPTY_CHANGES), 800);
      }
    }
    prevItemMapRef.current = new Map(incoming.map(i => [i.id, i]));

    setItems(incoming);
    setConnections(msg.connections || []);
    setGates(msg.gates || []);
    if (setSessions) setSessions(msg.sessions || []);

  } else if (msg.type === 'visionUI') {
    setUICommand(msg);

  } else if (msg.type === 'agentActivity') {
    setAgentActivity(prev => {
      const next = [...prev, {
        tool: msg.tool, category: msg.category || null, detail: msg.detail,
        items: msg.items || [], error: msg.error || null, timestamp: msg.timestamp,
      }];
      return next.length > 20 ? next.slice(-20) : next;
    });
    // Optimistic session tool count increment
    setSessionState(prev => prev?.active ? { ...prev, toolCount: (prev.toolCount || 0) + 1 } : prev);

  } else if (msg.type === 'agentSpawned') {
    setSpawnedAgents(prev => [...prev, {
      agentId: msg.agentId,
      agentType: msg.agentType,
      status: 'running',
      startedAt: msg.startedAt,
      prompt: msg.prompt,
    }]);

  } else if (msg.type === 'agentComplete') {
    setSpawnedAgents(prev => prev.map(a =>
      a.agentId === msg.agentId
        ? { ...a, status: msg.status, completedAt: new Date().toISOString() }
        : a
    ));

  } else if (msg.type === 'sessionStart') {
    // COMP-STATE-4: always clear previous session and its end timer unconditionally
    if (sessionEndTimerRef.current) { clearTimeout(sessionEndTimerRef.current); sessionEndTimerRef.current = null; }
    setSessionState(prev => {
      // If hydration already set this session, preserve accumulated counts
      if (prev && prev.id === msg.sessionId) return { ...prev, active: true };
      // New session — start fresh (old session is gone)
      return {
        id: msg.sessionId, active: true, startedAt: msg.timestamp,
        source: msg.source, toolCount: 0, errorCount: 0, summaries: [],
        featureCode: null, featureItemId: null, phaseAtBind: null, boundAt: null,
      };
    });

  } else if (msg.type === 'sessionEnd') {
    if (sessionEndTimerRef.current) { clearTimeout(sessionEndTimerRef.current); sessionEndTimerRef.current = null; }
    setSessionState(prev => prev ? {
      ...prev, active: false, endedAt: msg.timestamp,
      toolCount: msg.toolCount, duration: msg.duration,
      journalSpawned: msg.journalSpawned,
      featureCode: msg.featureCode || prev?.featureCode || null,
      phaseAtEnd: msg.phaseAtEnd || null,
    } : null);
    // COMP-STATE-4: clear ended session after 3s (was 15s — long enough to see "ended", short enough to not block next session)
    sessionEndTimerRef.current = setTimeout(() => { setSessionState(null); sessionEndTimerRef.current = null; }, 3000);

  } else if (msg.type === 'sessionSummary') {
    setSessionState(prev => prev ? {
      ...prev, summaries: [...(prev.summaries || []), {
        summary: msg.summary, intent: msg.intent, component: msg.component,
        timestamp: msg.timestamp,
      }].slice(-5),
    } : prev);

  } else if (msg.type === 'sessionBound') {
    setSessionState(prev => prev ? {
      ...prev,
      featureCode: msg.featureCode,
      featureItemId: msg.itemId,
      phaseAtBind: msg.phase,
      boundAt: msg.timestamp,
    } : prev);

  } else if (msg.type === 'agentError') {
    setAgentErrors(prev => {
      const next = [...prev, {
        errorType: msg.errorType, severity: msg.severity, message: msg.message,
        tool: msg.tool, detail: msg.detail, items: msg.items || [],
        timestamp: msg.timestamp || new Date().toISOString(),
      }];
      return next.length > 10 ? next.slice(-10) : next;
    });
    // Increment session error count
    setSessionState(prev => prev?.active ? { ...prev, errorCount: (prev.errorCount || 0) + 1 } : prev);

  } else if (msg.type === 'gateCreated' || msg.type === 'gatePending') {
    // Server calls scheduleBroadcast() after gate creation — the next visionState
    // message will include the full gate. No optimistic fetch needed.
    // Just fire the toast/event so the UI reacts immediately.
    setGateEvent({ type: 'pending', gateId: msg.gateId, itemId: msg.itemId,
                   fromPhase: msg.fromPhase, toPhase: msg.toPhase });

  } else if (msg.type === 'gateResolved') {
    // Optimistic update — scheduleBroadcast() follows, visionState will reconcile
    setGates(prev => prev.map(g =>
      g.id === msg.gateId
        ? { ...g, status: 'resolved', outcome: msg.outcome, resolvedAt: msg.timestamp }
        : g
    ));
    // Toast — skip if this client triggered the resolve
    if (pendingResolveIdsRef.current.has(msg.gateId)) {
      pendingResolveIdsRef.current.delete(msg.gateId);
    } else {
      // Prefer itemId from broadcast; fall back to local gate state; never null
      const itemId = msg.itemId
        ?? gatesRef.current.find(g => g.id === msg.gateId)?.itemId
        ?? msg.gateId; // last resort: use gateId so toast has something to show
      setGateEvent({ type: 'resolved', gateId: msg.gateId, outcome: msg.outcome, itemId });
    }

  } else if (msg.type === 'iterationStarted' || msg.type === 'iterationUpdate' || msg.type === 'iterationComplete') {
    setAgentActivity(prev => {
      let detail;
      if (msg.type === 'iterationStarted') {
        detail = `${msg.loopType} loop started (0/${msg.maxIterations})`;
      } else if (msg.type === 'iterationComplete') {
        detail = `${msg.loopType ?? 'loop'} loop complete (${msg.outcome} after ${msg.finalCount} iterations)`;
      } else {
        detail = `${msg.loopType ?? 'loop'} iteration ${msg.count}/${msg.maxIterations}`;
      }
      const next = [...prev, {
        tool: 'iteration',
        category: msg.loopType || 'iteration',
        detail,
        items: [],
        timestamp: msg.timestamp,
      }];
      return next.length > 20 ? next.slice(-20) : next;
    });

    if (msg.type === 'iterationComplete' && msg.outcome === 'max_reached') {
      setAgentErrors(prev => {
        const next = [...prev, {
          errorType: 'iteration_limit',
          severity: 'warning',
          message: `${msg.loopType ?? 'Loop'} hit max iterations (${msg.finalCount}) — problem may be in the spec`,
          timestamp: msg.timestamp,
        }];
        return next.length > 10 ? next.slice(-10) : next;
      });
      setSessionState(prev => prev?.active ? { ...prev, errorCount: (prev.errorCount || 0) + 1 } : prev);
    }

  } else if (msg.type === 'settingsState' || msg.type === 'settingsUpdated') {
    if (setSettings) setSettings(msg.settings || null);

  } else if (msg.type === 'buildState') {
    // Per STRAT-COMP-4: flat payload — the message itself IS the state object
    if (setActiveBuild) setActiveBuild(msg);

  } else if (msg.type === 'snapshotRequest' && msg.requestId) {
    // Collect UI state from provider and DOM, send back
    const { collectDOMSnapshot } = refs;
    const uiState = snapshotProviderRef.current ? snapshotProviderRef.current() : {};
    const domSnapshot = collectDOMSnapshot ? collectDOMSnapshot() : {};
    const ws = wsRef.current;
    if (ws) {
      ws.send(JSON.stringify({
        type: 'snapshotResponse',
        requestId: msg.requestId,
        snapshot: { ...uiState, dom: domSnapshot, timestamp: new Date().toISOString() },
      }));
    }
  }
}
