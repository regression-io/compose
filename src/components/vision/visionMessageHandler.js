/**
 * visionMessageHandler.js — Extracted WebSocket message dispatch logic.
 *
 * Pure function that takes a parsed WS message, ref objects, and setter
 * callbacks. Testable without React or jsdom.
 */

// COMP-UX-9: Per-loopId clear timers for iteration state cleanup
const iterClearTimers = new Map();

export function handleVisionMessage(msg, refs, setters) {
  const {
    prevItemMapRef, snapshotProviderRef, gatesRef, pendingResolveIdsRef,
    changeTimerRef, sessionEndTimerRef, wsRef,
  } = refs;

  const {
    setItems, setConnections, setGates, setGateEvent,
    setRecentChanges, setUICommand, setAgentActivity,
    setAgentErrors, setSessionState, setSpawnedAgents, setAgentRelays, setSettings, setPipelineDraft, setActiveBuild, setSessions, setIterationStates, setFeatureTimeline, EMPTY_CHANGES,
  } = setters;

  // COMP-UX-11: Helper to push a timeline event
  const pushTimeline = setFeatureTimeline ? (event) => {
    setFeatureTimeline(prev => {
      // Deduplicate by id
      if (prev.some(e => e.id === event.id)) return prev;
      return [...prev, event];
    });
  } : null;

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
      parentSessionId: msg.parentSessionId,
      agentType: msg.agentType,
      status: 'running',
      startedAt: msg.startedAt,
      prompt: msg.prompt,
    }]);

  } else if (msg.type === 'agentSilent') {
    // COMP-AGT-1: Mark agent as silent (warning state)
    setSpawnedAgents(prev => prev.map(a =>
      a.agentId === msg.agentId
        ? { ...a, silent: true, silentSinceMs: msg.silentSinceMs }
        : a
    ));

  } else if (msg.type === 'agentKilled') {
    // COMP-AGT-1: Terminal state — agentComplete cannot downgrade it
    setSpawnedAgents(prev => prev.map(a =>
      a.agentId === msg.agentId
        ? { ...a, status: 'killed', terminalReason: msg.reason, completedAt: new Date().toISOString() }
        : a
    ));

  } else if (msg.type === 'agentGC') {
    // COMP-AGT-1: Worktree GC notification — informational only
    if (msg.removed?.length > 0) {
      setAgentActivity(prev => {
        const next = [...prev, {
          tool: 'gc', category: 'executing',
          detail: `Cleaned ${msg.removed.length} orphan worktree(s)`,
          items: [], timestamp: msg.timestamp,
        }];
        return next.length > 20 ? next.slice(-20) : next;
      });
    }

  } else if (msg.type === 'agentComplete') {
    // COMP-AGT-1: Do not downgrade 'killed' status
    setSpawnedAgents(prev => prev.map(a =>
      a.agentId === msg.agentId
        ? (a.status === 'killed' ? a : { ...a, status: msg.status, completedAt: new Date().toISOString() })
        : a
    ));

  } else if (msg.type === 'agentRelay') {
    setAgentRelays(prev => [...prev, msg].slice(-50));

  } else if (msg.type === 'sessionStart') {
    // COMP-STATE-4: always clear previous session and its end timer unconditionally
    if (sessionEndTimerRef.current) { clearTimeout(sessionEndTimerRef.current); sessionEndTimerRef.current = null; }
    // COMP-VIS-1: Clear stale agents and relays from prior session
    setSpawnedAgents(() => []);
    setAgentRelays(() => []);
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
    // COMP-UX-11: Timeline event
    if (pushTimeline) pushTimeline({
      id: `session-start-${msg.sessionId}`, timestamp: msg.timestamp,
      category: 'session', title: 'Session started',
      detail: msg.source ? `Source: ${msg.source}` : null,
      severity: 'info', sessionId: msg.sessionId, meta: { source: msg.source },
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
    // COMP-UX-11: Timeline event
    if (pushTimeline) pushTimeline({
      id: `session-end-${msg.sessionId || Date.now()}`, timestamp: msg.timestamp,
      category: 'session',
      title: `Session ended (${msg.toolCount ?? 0} tools)`,
      detail: null, severity: 'info', sessionId: msg.sessionId || null,
      meta: { toolCount: msg.toolCount, duration: msg.duration },
    });

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
    // COMP-UX-11: Timeline event
    if (pushTimeline) pushTimeline({
      id: `error-${msg.timestamp}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: msg.timestamp || new Date().toISOString(),
      category: 'error', title: msg.message || `${msg.errorType} error`,
      detail: msg.tool ? `Tool: ${msg.tool}` : null,
      severity: msg.severity === 'error' ? 'error' : 'warning',
      sessionId: null, meta: { type: msg.errorType, tool: msg.tool },
    });

  } else if (msg.type === 'gateCreated' || msg.type === 'gatePending') {
    // Server calls scheduleBroadcast() after gate creation — the next visionState
    // message will include the full gate. No optimistic fetch needed.
    // Just fire the toast/event so the UI reacts immediately.
    setGateEvent({ type: 'pending', gateId: msg.gateId, itemId: msg.itemId,
                   fromPhase: msg.fromPhase, toPhase: msg.toPhase });
    // COMP-UX-11: Timeline event
    if (pushTimeline) pushTimeline({
      id: `gate-created-${msg.gateId}`, timestamp: msg.timestamp || new Date().toISOString(),
      category: 'gate',
      title: msg.fromPhase && msg.toPhase ? `Gate: ${msg.fromPhase} → ${msg.toPhase}` : 'Gate created',
      detail: null, severity: 'info', sessionId: null,
      meta: { gateId: msg.gateId, itemId: msg.itemId, fromPhase: msg.fromPhase, toPhase: msg.toPhase },
    });

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
    // COMP-UX-11: Timeline event
    const outcomeLabel = msg.outcome === 'approve' ? 'approved' : msg.outcome === 'revise' ? 'revised' : msg.outcome === 'kill' ? 'killed' : msg.outcome;
    const severityMap = { approve: 'success', revise: 'warning', kill: 'error' };
    if (pushTimeline) pushTimeline({
      id: `gate-resolved-${msg.gateId}`, timestamp: msg.timestamp || new Date().toISOString(),
      category: 'gate', title: `Gate ${outcomeLabel}`,
      detail: null, severity: severityMap[msg.outcome] || 'info',
      sessionId: null, meta: { gateId: msg.gateId, itemId: msg.itemId, outcome: msg.outcome },
    });

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

    // COMP-UX-9: Update iterationStates Map for progress strip
    if (msg.type === 'iterationStarted') {
      if (iterClearTimers.has(msg.loopId)) {
        clearTimeout(iterClearTimers.get(msg.loopId));
        iterClearTimers.delete(msg.loopId);
      }
      setIterationStates(prev => {
        const next = new Map(prev);
        next.set(msg.loopId, {
          loopId: msg.loopId, itemId: msg.itemId, loopType: msg.loopType,
          count: 0, maxIterations: msg.maxIterations,
          status: 'running', outcome: null, startedAt: msg.startedAt ?? msg.timestamp,
          wallClockTimeout: msg.wallClockTimeout ?? null,
          maxActions: msg.maxActions ?? null,
        });
        return next;
      });
    } else if (msg.type === 'iterationUpdate') {
      setIterationStates(prev => {
        const entry = prev.get(msg.loopId);
        if (!entry) return prev;
        const next = new Map(prev);
        next.set(msg.loopId, { ...entry, count: msg.count, maxIterations: msg.maxIterations });
        return next;
      });
    } else if (msg.type === 'iterationComplete') {
      setIterationStates(prev => {
        const entry = prev.get(msg.loopId);
        if (!entry) return prev;
        const next = new Map(prev);
        next.set(msg.loopId, { ...entry, status: 'complete', outcome: msg.outcome, count: msg.finalCount ?? entry.count });
        return next;
      });
      const timer = setTimeout(() => {
        setIterationStates(prev => { const next = new Map(prev); next.delete(msg.loopId); return next; });
        iterClearTimers.delete(msg.loopId);
      }, 5000);
      iterClearTimers.set(msg.loopId, timer);
    }

    if (msg.type === 'iterationComplete' && (msg.outcome === 'max_reached' || msg.outcome === 'timeout' || msg.outcome === 'action_limit')) {
      const budgetMessages = {
        max_reached: `${msg.loopType ?? 'Loop'} hit max iterations (${msg.finalCount}) — problem may be in the spec`,
        timeout: `${msg.loopType ?? 'Loop'} timed out after ${msg.elapsedMinutes ?? '?'} minutes (${msg.finalCount} iterations)`,
        action_limit: `${msg.loopType ?? 'Loop'} hit action count ceiling (${msg.finalCount} iterations)`,
      };
      setAgentErrors(prev => {
        const next = [...prev, {
          errorType: 'iteration_limit',
          severity: 'warning',
          message: budgetMessages[msg.outcome] ?? `${msg.loopType ?? 'Loop'} stopped: ${msg.outcome}`,
          timestamp: msg.timestamp,
        }];
        return next.length > 10 ? next.slice(-10) : next;
      });
      setSessionState(prev => prev?.active ? { ...prev, errorCount: (prev.errorCount || 0) + 1 } : prev);
    }
    // COMP-UX-11: Timeline event for iteration start/complete (skip updates — too noisy)
    if (pushTimeline && (msg.type === 'iterationStarted' || msg.type === 'iterationComplete')) {
      const detail = msg.type === 'iterationStarted'
        ? `${msg.loopType} loop started (0/${msg.maxIterations})`
        : `${msg.loopType ?? 'loop'} loop ${msg.outcome} (${msg.finalCount} iterations)`;
      pushTimeline({
        id: `iteration-${msg.loopId}-${msg.type}`, timestamp: msg.timestamp,
        category: 'iteration', title: detail, detail: null,
        severity: (msg.outcome === 'max_reached' || msg.outcome === 'timeout' || msg.outcome === 'action_limit') ? 'warning' : msg.type === 'iterationComplete' ? 'success' : 'info',
        sessionId: null, meta: { loopId: msg.loopId, loopType: msg.loopType },
      });
    }

  } else if (msg.type === 'lifecycleStarted') {
    // COMP-UX-11: Phase event — lifecycle just started
    if (pushTimeline) pushTimeline({
      id: `lifecycle-started-${msg.itemId}`, timestamp: msg.timestamp,
      category: 'phase', title: `Lifecycle started: ${msg.phase}`,
      detail: msg.featureCode ? `Feature: ${msg.featureCode}` : null,
      severity: 'success', sessionId: null,
      meta: { itemId: msg.itemId, phase: msg.phase, featureCode: msg.featureCode },
    });

  } else if (msg.type === 'lifecycleTransition') {
    // COMP-UX-11: Phase event — phase advanced/skipped/killed
    const outcomeLabel = msg.outcome === 'skipped' ? ' (skipped)' : msg.outcome === 'killed' ? ' (killed)' : '';
    const severity = msg.outcome === 'killed' ? 'error' : msg.outcome === 'skipped' ? 'info' : 'success';
    if (pushTimeline) pushTimeline({
      id: `lifecycle-${msg.itemId}-${msg.from}-${msg.to}`, timestamp: msg.timestamp,
      category: 'phase', title: `Phase: ${msg.from} → ${msg.to}${outcomeLabel}`,
      detail: null, severity, sessionId: null,
      meta: { itemId: msg.itemId, from: msg.from, to: msg.to, outcome: msg.outcome },
    });

  } else if (msg.type === 'settingsState' || msg.type === 'settingsUpdated') {
    if (setSettings) setSettings(msg.settings || null);

  } else if (msg.type === 'buildState') {
    // Per STRAT-COMP-4: flat payload — the message itself IS the state object
    if (setActiveBuild) setActiveBuild(msg);

  } else if (msg.type === 'pipelineDraft') {
    // COMP-PIPE-1-3: Pipeline draft created — set draft state
    if (setPipelineDraft) setPipelineDraft(msg);

  } else if (msg.type === 'pipelineDraftResolved') {
    // COMP-PIPE-1-3: Pipeline draft approved/rejected — clear draft state
    if (setPipelineDraft) setPipelineDraft(null);

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
