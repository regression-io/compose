import { useState, useEffect, useRef, useCallback } from 'react';
import { handleVisionMessage } from './visionMessageHandler.js';

/**
 * Walk the DOM and produce a compact accessibility-style snapshot.
 * Returns a tree of { tag, role, text, children } nodes.
 * Skips invisible elements and script/style tags.
 */
function collectDOMSnapshot() {
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT']);
  const MAX_DEPTH = 12;
  const MAX_TEXT = 120;

  function walk(el, depth) {
    if (!el || depth > MAX_DEPTH) return null;
    if (el.nodeType === Node.TEXT_NODE) {
      const text = el.textContent.trim();
      return text ? text.slice(0, MAX_TEXT) : null;
    }
    if (el.nodeType !== Node.ELEMENT_NODE) return null;
    if (SKIP_TAGS.has(el.tagName)) return null;

    // Skip hidden elements
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return null;

    const node = {};
    const role = el.getAttribute('role') || el.getAttribute('aria-label');
    const tag = el.tagName.toLowerCase();

    // Compact representation
    if (role) node.role = role;
    else node.tag = tag;

    // Capture key attributes
    if (el.className && typeof el.className === 'string') {
      const cls = el.className.trim();
      if (cls.length < 80) node.class = cls;
    }

    // Collect children
    const children = [];
    for (const child of el.childNodes) {
      const c = walk(child, depth + 1);
      if (c) children.push(c);
    }

    // Flatten: if a node has exactly one text child, inline it
    if (children.length === 1 && typeof children[0] === 'string') {
      node.text = children[0];
    } else if (children.length > 0) {
      node.children = children;
    }

    // Skip wrapper divs with no semantic value
    if (!role && (tag === 'div' || tag === 'span') && !node.text && children.length === 1 && typeof children[0] === 'object') {
      return children[0];
    }

    return node;
  }

  // Start from the Vision Tracker root if present, otherwise body
  const root = document.querySelector('[data-snapshot-root]') || document.body;
  return walk(root, 0);
}

/**
 * useVisionStore — WebSocket connection to /ws/vision + REST mutations.
 * Full state replacement on every visionState message (no deltas).
 */
const EMPTY_CHANGES = { newIds: new Set(), changedIds: new Set() };

export function useVisionStore() {
  const [items, setItems] = useState([]);
  const [connections, setConnections] = useState([]);
  const [connected, setConnected] = useState(false);
  const [uiCommand, setUICommand] = useState(null);
  const [recentChanges, setRecentChanges] = useState(EMPTY_CHANGES);
  const [agentActivity, setAgentActivity] = useState([]);
  const [agentErrors, setAgentErrors] = useState([]);
  const [sessionState, setSessionState] = useState(null);
  const [gates, setGates] = useState([]);
  const [gateEvent, setGateEvent] = useState(null);
  const [settings, setSettings] = useState(null);
  const [activeBuild, setActiveBuild] = useState(null);
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const snapshotProviderRef = useRef(null);
  const prevItemMapRef = useRef(null);
  const changeTimerRef = useRef(null);
  const sessionEndTimerRef = useRef(null);
  const gatesRef = useRef([]);
  const pendingResolveIdsRef = useRef(new Set());

  // Keep gatesRef in sync for use inside the WS handler closure
  useEffect(() => { gatesRef.current = gates; }, [gates]);

  useEffect(() => {
    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/vision`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        fetch('/api/build/state').then(r => r.json()).then(data => setActiveBuild(data.state ?? null)).catch(() => {});
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleVisionMessage(msg, {
            prevItemMapRef, snapshotProviderRef, gatesRef, pendingResolveIdsRef,
            changeTimerRef, sessionEndTimerRef, wsRef, collectDOMSnapshot,
          }, {
            setItems, setConnections, setGates, setGateEvent,
            setRecentChanges, setUICommand, setAgentActivity,
            setAgentErrors, setSessionState, setSettings, setActiveBuild, EMPTY_CHANGES,
          });
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        setConnected(false);
        reconnectTimerRef.current = setTimeout(connect, 2000);
      };

      ws.onerror = () => {};
    }

    connect();

    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (changeTimerRef.current) clearTimeout(changeTimerRef.current);
      if (sessionEndTimerRef.current) clearTimeout(sessionEndTimerRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  // Hydrate session state on mount (server may already have an active session)
  useEffect(() => {
    fetch('/api/session/current')
      .then(r => r.json())
      .then(data => {
        if (data.session) {
          // Only hydrate if no WebSocket sessionStart has arrived first
          setSessionState(prev => prev ? prev : {
            id: data.session.id, active: true, startedAt: data.session.startedAt,
            source: data.session.source || 'hydrated', toolCount: data.session.toolCount || 0,
            errorCount: data.session.errorCount || 0, summaries: data.session.summaries || [],
            featureCode: data.session.featureCode || null,
            featureItemId: data.session.featureItemId || null,
            phaseAtBind: data.session.phaseAtBind || null,
            boundAt: data.session.boundAt || null,
          });
        }
      })
      .catch(() => { console.warn('[vision] Failed to hydrate session state'); });
  }, []);

  // Hydrate active build state on mount
  useEffect(() => {
    fetch('/api/build/state')
      .then(r => r.json())
      .then(data => setActiveBuild(data.state ?? null))
      .catch(() => {});
  }, []);

  // 30s polling fallback for build state (covers missed fs.watch events)
  useEffect(() => {
    const interval = setInterval(() => {
      fetch('/api/build/state')
        .then(r => r.json())
        .then(data => setActiveBuild(data.state ?? null))
        .catch(() => {});
    }, 30_000);
    return () => clearInterval(interval);
  }, []);

  const handleResponse = useCallback(async (res) => {
    const data = await res.json();
    if (!res.ok) {
      console.error(`[vision] API error ${res.status}:`, data.error || data);
      return { error: data.error || `HTTP ${res.status}` };
    }
    return data;
  }, []);

  const createItem = useCallback(async (data) => {
    const res = await fetch('/api/vision/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return handleResponse(res);
  }, [handleResponse]);

  const updateItem = useCallback(async (id, data) => {
    const res = await fetch(`/api/vision/items/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return handleResponse(res);
  }, [handleResponse]);

  const deleteItem = useCallback(async (id) => {
    const res = await fetch(`/api/vision/items/${id}`, { method: 'DELETE' });
    return handleResponse(res);
  }, [handleResponse]);

  const createConnection = useCallback(async (data) => {
    const res = await fetch('/api/vision/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return handleResponse(res);
  }, [handleResponse]);

  const deleteConnection = useCallback(async (id) => {
    const res = await fetch(`/api/vision/connections/${id}`, { method: 'DELETE' });
    return handleResponse(res);
  }, [handleResponse]);

  // Optimistic position update for drag (local state + debounced REST)
  const updateItemPosition = useCallback((id, position) => {
    setItems(prev => prev.map(item =>
      item.id === id ? { ...item, position } : item
    ));
  }, []);

  const clearUICommand = useCallback(() => setUICommand(null), []);

  const registerSnapshotProvider = useCallback((provider) => {
    snapshotProviderRef.current = provider;
  }, []);

  const resolveGate = useCallback(async (gateId, outcome, comment) => {
    pendingResolveIdsRef.current.add(gateId);
    try {
      const res = await fetch(`/api/vision/gates/${gateId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome, comment }),
      });
      const data = await handleResponse(res);
      if (data.error) pendingResolveIdsRef.current.delete(gateId);
      return data;
    } catch {
      pendingResolveIdsRef.current.delete(gateId);
      return { error: 'Network error' };
    }
  }, [handleResponse]);

  const updateSettings = useCallback(async (patch) => {
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return handleResponse(res);
  }, [handleResponse]);

  const resetSettings = useCallback(async (section) => {
    const res = await fetch('/api/settings/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(section ? { section } : {}),
    });
    return handleResponse(res);
  }, [handleResponse]);

  return {
    items,
    connections,
    connected,
    uiCommand,
    clearUICommand,
    recentChanges,
    createItem,
    updateItem,
    deleteItem,
    createConnection,
    deleteConnection,
    updateItemPosition,
    agentActivity,
    agentErrors,
    sessionState,
    registerSnapshotProvider,
    gates,
    gateEvent,
    resolveGate,
    settings,
    updateSettings,
    resetSettings,
    activeBuild,
    setActiveBuild,
  };
}
