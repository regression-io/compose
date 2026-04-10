/**
 * useIdeaboxStore — Zustand singleton for the ideabox feature.
 *
 * State: { ideas, killed, loading, error, selectedIdeaId, filters }
 * Actions: hydrate(), addIdea(), promoteIdea(), killIdea(), setPriority(), updateFilters()
 *
 * Hydrates via GET /api/ideabox.
 * Subscribes to WS 'ideaboxUpdated' messages via the vision store's WS — but since
 * ideabox has its own WS channel we poll the vision WS for the message type and
 * re-hydrate. For independence we attach our own lightweight WS listener.
 */

import { create } from 'zustand';

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function apiFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------------------------------------------------------------------------
// WS (reuse existing vision WS for ideaboxUpdated messages)
// ---------------------------------------------------------------------------

let _wsListener = null;

function attachWSListener(onMessage) {
  // The vision WS at /ws/vision already broadcasts ideaboxUpdated.
  // We subscribe to window-level custom events dispatched by visionMessageHandler,
  // OR we open a lightweight listener on the same endpoint.
  // To avoid double-WS, we dispatch a custom DOM event from the visionMessageHandler
  // — but that requires patching it. Instead, open our own WS and close on hot reload.
  if (_wsListener) return; // already attached

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws/vision`);
  _wsListener = ws;

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'ideaboxUpdated') {
        onMessage(msg);
      }
    } catch {
      // ignore
    }
  };

  ws.onclose = () => {
    _wsListener = null;
    // Reconnect after a delay if not disposed
    setTimeout(() => {
      if (!_wsDisposed) attachWSListener(onMessage);
    }, 3000);
  };

  ws.onerror = () => {};
}

let _wsDisposed = false;

// ---------------------------------------------------------------------------
// Zustand store
// ---------------------------------------------------------------------------

export const useIdeaboxStore = create((set, get) => {
  // Hydrate on store creation
  setTimeout(() => get().hydrate(), 0);

  // Attach WS listener for live updates
  setTimeout(() => {
    attachWSListener(() => {
      get().hydrate();
    });
  }, 500);

  return {
    // ── State ───────────────────────────────────────────────────────────────
    ideas: [],
    killed: [],
    loading: false,
    error: null,
    selectedIdeaId: null,
    filters: {
      tag: '',
      status: '',
      priority: '',
      search: '',
    },

    // ── Actions ─────────────────────────────────────────────────────────────

    hydrate: async () => {
      set({ loading: true, error: null });
      try {
        const data = await apiFetch('/api/ideabox');
        set({ ideas: data.ideas || [], killed: data.killed || [], loading: false });
      } catch (err) {
        set({ error: err.message, loading: false });
      }
    },

    addIdea: async (fields) => {
      const result = await apiFetch('/api/ideabox/ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      // Server will broadcast ideaboxUpdated; hydrate immediately too
      await get().hydrate();
      return result;
    },

    promoteIdea: async (ideaId, featureCode = '') => {
      const result = await apiFetch(`/api/ideabox/ideas/${ideaId}/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ featureCode }),
      });
      await get().hydrate();
      return result;
    },

    killIdea: async (ideaId, reason = '') => {
      const result = await apiFetch(`/api/ideabox/ideas/${ideaId}/kill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      await get().hydrate();
      return result;
    },

    setPriority: async (ideaId, priority) => {
      const result = await apiFetch(`/api/ideabox/ideas/${ideaId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority }),
      });
      // Optimistic update
      set(s => ({
        ideas: s.ideas.map(i => i.id === ideaId ? { ...i, priority } : i),
      }));
      return result;
    },

    resurrectIdea: async (ideaId) => {
      // True resurrect: moves the killed idea back to active with status NEW.
      // Preserves the original ID, no duplication.
      const result = await apiFetch(`/api/ideabox/ideas/${encodeURIComponent(ideaId)}/resurrect`, {
        method: 'POST',
      });
      await get().hydrate();
      return result;
    },

    addDiscussion: async (ideaId, author, text) => {
      const result = await apiFetch(`/api/ideabox/ideas/${encodeURIComponent(ideaId)}/discuss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author, text }),
      });
      await get().hydrate();
      return result;
    },

    updateIdea: async (ideaId, fields) => {
      const result = await apiFetch(`/api/ideabox/ideas/${encodeURIComponent(ideaId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      await get().hydrate();
      return result;
    },

    setSelectedIdea: (id) => set({ selectedIdeaId: id }),

    updateFilters: (patch) => set(s => ({ filters: { ...s.filters, ...patch } })),

    clearFilters: () => set({
      filters: { tag: '', status: '', priority: '', search: '' },
    }),
  };
});

// ── HMR teardown ─────────────────────────────────────────────────────────────

function teardown() {
  _wsDisposed = true;
  if (_wsListener) {
    _wsListener.onclose = null;
    _wsListener.close();
    _wsListener = null;
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(teardown);
}
