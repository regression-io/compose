import { create } from 'zustand';
import { handleVisionMessage } from './visionMessageHandler.js';

/**
 * useVisionStore — Zustand singleton store.
 *
 * Single WebSocket connection, single state atom, single set of intervals.
 * All components read from the same store via useVisionStore() selectors.
 *
 * COMP-STATE-1: Replaces the old React hook that created independent state
 * per component (12 WebSockets, 12 intervals, 12 state copies).
 */

// ─── DOM snapshot (for server snapshot requests) ─────────────────────────────

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
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return null;

    const node = {};
    const role = el.getAttribute('role') || el.getAttribute('aria-label');
    const tag = el.tagName.toLowerCase();
    if (role) node.role = role;
    else node.tag = tag;
    if (el.className && typeof el.className === 'string') {
      const cls = el.className.trim();
      if (cls.length < 80) node.class = cls;
    }
    const children = [];
    for (const child of el.childNodes) {
      const c = walk(child, depth + 1);
      if (c) children.push(c);
    }
    if (children.length === 1 && typeof children[0] === 'string') {
      node.text = children[0];
    } else if (children.length > 0) {
      node.children = children;
    }
    if (!role && (tag === 'div' || tag === 'span') && !node.text && children.length === 1 && typeof children[0] === 'object') {
      return children[0];
    }
    return node;
  }

  const root = document.querySelector('[data-snapshot-root]') || document.body;
  return walk(root, 0);
}

// ─── Refs (mutable, shared across all subscribers) ───────────────────────────

const refs = {
  ws: null,
  reconnectTimer: null,
  snapshotProvider: null,
  prevItemMap: null,
  changeTimer: null,
  sessionEndTimer: null,
  gates: [],
  pendingResolveIds: new Set(),
  buildPollInterval: null,
  recentErrorsInterval: null,
  connected: false,
};

const EMPTY_CHANGES = { newIds: new Set(), changedIds: new Set() };

// ─── Zustand store ───────────────────────────────────────────────────────────

export const useVisionStore = create((set, get) => {
  // ── REST helpers ─────────────────────────────────────────────────────────

  async function apiCall(url, options) {
    const res = await fetch(url, options);
    const data = await res.json();
    if (!res.ok) {
      console.error(`[vision] API error ${res.status}:`, data.error || data);
      return { error: data.error || `HTTP ${res.status}` };
    }
    return data;
  }

  // ── WebSocket connection ─────────────────────────────────────────────────

  function connect() {
    if (refs.disposed) return;
    if (refs.ws && (refs.ws.readyState === WebSocket.OPEN || refs.ws.readyState === WebSocket.CONNECTING)) {
      return; // already connected
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/vision`);
    refs.ws = ws;

    ws.onopen = () => {
      set({ connected: true });
      // Hydrate build state on connect
      fetch('/api/build/state')
        .then(r => r.json())
        .then(data => set({ activeBuild: data.state ?? null }))
        .catch(() => {});
      // COMP-VIS-1: Hydrate spawned agents on connect (only if no live events yet)
      fetch('/api/agents/tree')
        .then(r => r.json())
        .then(data => {
          const current = get().spawnedAgents;
          if (current.length === 0) {
            set({ spawnedAgents: (data.agents || []).map(a => ({
              agentId: a.agentId, parentSessionId: a.parentSessionId,
              agentType: a.agentType, status: a.status || 'running',
              startedAt: a.startedAt, prompt: a.prompt,
            }))});
          }
        })
        .catch(() => {});
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleVisionMessage(msg, {
          prevItemMapRef: { get current() { return refs.prevItemMap; }, set current(v) { refs.prevItemMap = v; } },
          snapshotProviderRef: { get current() { return refs.snapshotProvider; }, set current(v) { refs.snapshotProvider = v; } },
          gatesRef: { get current() { return refs.gates; }, set current(v) { refs.gates = v; } },
          pendingResolveIdsRef: { get current() { return refs.pendingResolveIds; }, set current(v) { refs.pendingResolveIds = v; } },
          changeTimerRef: { get current() { return refs.changeTimer; }, set current(v) { refs.changeTimer = v; } },
          sessionEndTimerRef: { get current() { return refs.sessionEndTimer; }, set current(v) { refs.sessionEndTimer = v; } },
          wsRef: { get current() { return refs.ws; }, set current(v) { refs.ws = v; } },
          collectDOMSnapshot,
        }, {
          setItems: (updater) => set(s => ({ items: typeof updater === 'function' ? updater(s.items) : updater })),
          setConnections: (updater) => set(s => ({ connections: typeof updater === 'function' ? updater(s.connections) : updater })),
          setGates: (updater) => {
            set(s => {
              const next = typeof updater === 'function' ? updater(s.gates) : updater;
              refs.gates = next; // keep ref in sync
              return { gates: next };
            });
          },
          setGateEvent: (v) => set({ gateEvent: v }),
          setRecentChanges: (updater) => set(s => ({ recentChanges: typeof updater === 'function' ? updater(s.recentChanges) : updater })),
          setUICommand: (v) => set({ uiCommand: v }),
          setAgentActivity: (updater) => set(s => ({ agentActivity: typeof updater === 'function' ? updater(s.agentActivity) : updater })),
          setAgentErrors: (updater) => {
            set(s => {
              const next = typeof updater === 'function' ? updater(s.agentErrors) : updater;
              // P1 fix: immediately recompute recentErrors on every agentErrors change
              const cutoff = Date.now() - 60_000;
              const recent = next.filter(e => new Date(e.timestamp).getTime() > cutoff).slice(-5);
              return { agentErrors: next, recentErrors: recent };
            });
          },
          setSessionState: (updater) => set(s => ({ sessionState: typeof updater === 'function' ? updater(s.sessionState) : updater })),
          setSpawnedAgents: (updater) => set(s => ({ spawnedAgents: typeof updater === 'function' ? updater(s.spawnedAgents) : updater })),
          setAgentRelays: (updater) => set(s => ({ agentRelays: typeof updater === 'function' ? updater(s.agentRelays) : updater })),
          setSettings: (v) => set({ settings: v }),
          setActiveBuild: (updater) => set(s => ({ activeBuild: typeof updater === 'function' ? updater(s.activeBuild) : updater })),
          setSessions: (updater) => set(s => ({ sessions: typeof updater === 'function' ? updater(s.sessions) : updater })),
          EMPTY_CHANGES,
        });
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = () => {
      set({ connected: false });
      refs.reconnectTimer = setTimeout(connect, 2000);
    };

    ws.onerror = () => {};
  }

  // ── Start connection + intervals on store creation ───────────────────────

  // Hydrate session
  fetch('/api/session/current')
    .then(r => r.json())
    .then(data => {
      if (data.session) {
        set(s => s.sessionState ? {} : {
          sessionState: {
            id: data.session.id, active: true, startedAt: data.session.startedAt,
            source: data.session.source || 'hydrated', toolCount: data.session.toolCount || 0,
            errorCount: data.session.errorCount || 0, summaries: data.session.summaries || [],
            featureCode: data.session.featureCode || null,
            featureItemId: data.session.featureItemId || null,
            phaseAtBind: data.session.phaseAtBind || null,
            boundAt: data.session.boundAt || null,
          },
        });
      }
    })
    .catch(() => console.warn('[vision] Failed to hydrate session state'));

  // Build state polling (5s fallback)
  refs.buildPollInterval = setInterval(() => {
    fetch('/api/build/state')
      .then(r => r.json())
      .then(data => set({ activeBuild: data.state ?? null }))
      .catch(() => {});
  }, 5_000);

  // Recent errors interval (10s, ages out old errors)
  refs.recentErrorsInterval = setInterval(() => {
    const { agentErrors } = get();
    const cutoff = Date.now() - 60_000;
    const recent = agentErrors
      .filter(e => new Date(e.timestamp).getTime() > cutoff)
      .slice(-5);
    set({ recentErrors: recent });
  }, 10_000);

  // Connect WebSocket
  connect();

  // ── Return initial state + actions ───────────────────────────────────────

  return {
    // State
    items: [],
    connections: [],
    connected: false,
    uiCommand: null,
    recentChanges: EMPTY_CHANGES,
    agentActivity: [],
    agentErrors: [],
    recentErrors: [],
    spawnedAgents: [],
    agentRelays: [],
    sessionState: null,
    gates: [],
    gateEvent: null,
    settings: null,
    activeBuild: null,
    sessions: [],
    selectedPhase: (() => {
      try { return localStorage.getItem('compose:selectedPhase') || null; } catch { return null; }
    })(),

    // Actions
    clearUICommand: () => set({ uiCommand: null }),

    registerSnapshotProvider: (provider) => { refs.snapshotProvider = provider; },

    setActiveBuild: (v) => set({ activeBuild: v }),

    setSelectedPhase: (phase) => {
      set({ selectedPhase: phase });
      try {
        if (phase) localStorage.setItem('compose:selectedPhase', phase);
        else localStorage.removeItem('compose:selectedPhase');
      } catch { /* ignore */ }
    },

    updateItemPosition: (id, position) => {
      set(s => ({ items: s.items.map(item => item.id === id ? { ...item, position } : item) }));
    },

    // REST mutations
    createItem: (data) => apiCall('/api/vision/items', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    }),

    updateItem: (id, data) => apiCall(`/api/vision/items/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    }),

    deleteItem: (id) => apiCall(`/api/vision/items/${id}`, { method: 'DELETE' }),

    createConnection: (data) => apiCall('/api/vision/connections', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    }),

    deleteConnection: (id) => apiCall(`/api/vision/connections/${id}`, { method: 'DELETE' }),

    resolveGate: async (gateId, outcome, comment) => {
      refs.pendingResolveIds.add(gateId);
      try {
        const data = await apiCall(`/api/vision/gates/${gateId}/resolve`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ outcome, comment }),
        });
        if (data.error) refs.pendingResolveIds.delete(gateId);
        return data;
      } catch {
        refs.pendingResolveIds.delete(gateId);
        return { error: 'Network error' };
      }
    },

    updateSettings: (patch) => apiCall('/api/settings', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    }),

    resetSettings: (section) => apiCall('/api/settings/reset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(section ? { section } : {}),
    }),
  };
});

// ─── HMR teardown ────────────────────────────────────────────────────────────
// P2 fix: clean up WebSocket, timers, and intervals on hot reload so the old
// module instance doesn't leak alongside the new one.

function teardown() {
  refs.disposed = true;
  if (refs.ws) { refs.ws.onclose = null; refs.ws.close(); refs.ws = null; }
  if (refs.reconnectTimer) { clearTimeout(refs.reconnectTimer); refs.reconnectTimer = null; }
  if (refs.changeTimer) { clearTimeout(refs.changeTimer); refs.changeTimer = null; }
  if (refs.sessionEndTimer) { clearTimeout(refs.sessionEndTimer); refs.sessionEndTimer = null; }
  if (refs.buildPollInterval) { clearInterval(refs.buildPollInterval); refs.buildPollInterval = null; }
  if (refs.recentErrorsInterval) { clearInterval(refs.recentErrorsInterval); refs.recentErrorsInterval = null; }
}

if (import.meta.hot) {
  import.meta.hot.dispose(teardown);
}
