import { create } from 'zustand';

/**
 * useDesignStore — Zustand singleton store for design sessions.
 *
 * COMP-DESIGN-1: Thin glue between React components and the design session
 * server endpoints. Pure logic lives in designSessionState.js; this store
 * handles fetch calls, SSE streaming, and optimistic UI updates.
 */

// Module-level SSE singleton (survives Vite HMR, same pattern as AgentStream.jsx)
const _sse = {
  es: null,          // EventSource instance
  reconnectTimer: null,
};

const useDesignStore = create((set, get) => ({
  // State
  session: null,
  messages: [],
  decisions: [],
  status: 'idle',       // 'idle' | 'active' | 'streaming' | 'complete'
  error: null,
  streamingMessage: null, // partial message being streamed
  scope: null,
  featureCode: null,
  designDocPath: null,

  // Actions
  hydrate: async (scope, featureCode) => {
    // If scope not provided, try store state first (tab switch), then localStorage (page reload)
    if (!scope) {
      const storeScope = get().scope;
      if (storeScope) {
        scope = storeScope;
        featureCode = get().featureCode || null;
      } else {
        try {
          const saved = JSON.parse(localStorage.getItem('compose:designSession') || '{}');
          scope = saved.scope || 'product';
          featureCode = saved.featureCode || null;
        } catch { scope = 'product'; }
      }
    }
    // Reset immediately to prevent stale data during async hydration (preserve scope)
    set({ session: null, messages: [], decisions: [], status: 'idle', error: null, streamingMessage: null, designDocPath: null, scope, featureCode });

    const query = scope === 'feature' && featureCode
      ? `?scope=feature&featureCode=${featureCode}`
      : `?scope=${scope}`;

    try {
      const res = await fetch(`/api/design/session${query}`);
      const { session } = await res.json();
      if (session) {
        set({
          session,
          messages: session.messages || [],
          decisions: session.decisions || [],
          status: session.status === 'complete' ? 'complete' : 'active',
          scope,
          featureCode,
        });
        // Connect SSE after state is set so scope/featureCode are correct
        get().disconnectSSE();
        get().connectSSE();
      } else {
        // No session — reset everything so stale state doesn't linger
        set({ session: null, messages: [], decisions: [], status: 'idle', error: null, streamingMessage: null, scope, featureCode });
        get().disconnectSSE();
      }
    } catch (err) {
      set({ error: err.message });
    }
  },

  startSession: async (scope = 'product', featureCode = null) => {
    try {
      const res = await fetch(`/api/design/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, featureCode }),
      });
      if (!res.ok) {
        const { error } = await res.json();
        set({ error });
        return;
      }
      const { session } = await res.json();
      try { localStorage.setItem('compose:designSession', JSON.stringify({ scope, featureCode })); } catch {}
      set({
        session,
        messages: session.messages || [],
        decisions: session.decisions || [],
        status: 'active',
        error: null,
        scope,
        featureCode,
      });
      // Auto-connect SSE after starting
      get().connectSSE();
    } catch (err) {
      set({ error: err.message });
    }
  },

  sendMessage: async (content) => {
    const { session, messages: prevMessages } = get();
    if (!session) return;
    const scope = session.scope;
    const featureCode = session.featureCode;

    // Optimistic update — set status to 'streaming' immediately to disable input
    const humanMsg = { role: 'human', type: 'text', content, timestamp: new Date().toISOString() };
    set(s => ({ messages: [...s.messages, humanMsg], status: 'streaming' }));

    try {
      const res = await fetch(`/api/design/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, featureCode, type: 'text', content }),
      });
      if (!res.ok) {
        set({ messages: prevMessages, status: 'active', error: `Failed to send message: ${res.status}` });
      }
    } catch (err) {
      set({ messages: prevMessages, status: 'active', error: err.message });
    }
  },

  selectCard: async (cardId, comment = null, messageIndex = null) => {
    const { session, messages: prevMessages } = get();
    if (!session) return;

    // Optimistic update — set status to 'streaming' immediately to disable input
    const humanMsg = { role: 'human', type: 'card_select', content: { cardId, comment }, timestamp: new Date().toISOString() };
    set(s => ({ messages: [...s.messages, humanMsg], status: 'streaming' }));

    try {
      const res = await fetch(`/api/design/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: session.scope, featureCode: session.featureCode, type: 'card_select', cardId, comment, messageIndex }),
      });
      if (!res.ok) {
        set({ messages: prevMessages, status: 'active', error: `Failed to select card: ${res.status}` });
      }
    } catch (err) {
      set({ messages: prevMessages, status: 'active', error: err.message });
    }
  },

  reviseDecision: async (decisionIndex) => {
    const { session } = get();
    if (!session) return;

    // Get the decision being revised
    const decision = get().decisions[decisionIndex];
    if (!decision || decision.superseded) return;

    try {
      // Mark the decision as superseded on the server
      const reviseRes = await fetch(`/api/design/revise`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: session.scope,
          featureCode: session.featureCode,
          decisionIndex,
        }),
      });
      if (!reviseRes.ok) {
        const { error } = await reviseRes.json().catch(() => ({ error: 'Revision failed' }));
        set({ error });
        return;
      }
      // Server atomically supersedes the decision, appends a re-ask message,
      // and dispatches the agent — no second client request needed.

      // Re-hydrate to pick up the server-side state changes (preserve current scope)
      get().hydrate(session.scope, session.featureCode);
    } catch (err) {
      set({ error: err.message });
    }
  },

  completeDesign: async () => {
    const { session } = get();
    if (!session) return;

    set({ status: 'summarizing' });
    try {
      const res = await fetch(`/api/design/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: session.scope, featureCode: session.featureCode }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: 'Unknown error' }));
        set({ error, status: 'active' });
        return;
      }
      const data = await res.json();
      const nextState = { session: data.session, status: 'complete', designDocPath: data.designDocPath || null };
      if (data.error) {
        nextState.error = data.error;
      }
      set(nextState);
    } catch (err) {
      set({ error: err.message, status: 'active' });
    }
  },

  connectSSE: () => {
    if (_sse.es) return; // already connected

    const { scope, featureCode } = get();
    const params = new URLSearchParams({ scope: scope || 'product' });
    if (featureCode) params.set('featureCode', featureCode);
    const es = new EventSource(`/api/design/stream?${params}`);
    _sse.es = es;

    // ack — fallback confirmation that server received the message
    es.addEventListener('ack', () => {
      set(s => (s.status !== 'streaming' ? { status: 'streaming' } : {}));
    });

    es.addEventListener('text', (e) => {
      const data = JSON.parse(e.data);
      set(s => {
        // If we're not already streaming, create a new assistant message
        if (!s.streamingMessage) {
          return {
            status: 'streaming',
            streamingMessage: { role: 'assistant', type: 'text', content: data.content, timestamp: new Date().toISOString() },
          };
        }
        // Append to existing streaming message
        return {
          streamingMessage: { ...s.streamingMessage, content: s.streamingMessage.content + data.content },
        };
      });
    });

    es.addEventListener('decision', (e) => {
      const data = JSON.parse(e.data);
      set(s => ({
        status: 'streaming',
        streamingMessage: s.streamingMessage
          ? { ...s.streamingMessage, type: 'decision', decisionData: data }
          : { role: 'assistant', type: 'decision', content: '', decisionData: data, timestamp: new Date().toISOString() },
      }));
    });

    es.addEventListener('done', () => {
      set(s => {
        const newMessages = s.streamingMessage
          ? [...s.messages, s.streamingMessage]
          : s.messages;
        return {
          messages: newMessages,
          streamingMessage: null,
          status: 'active',
        };
      });
      // Re-hydrate to get server-side state (decisions recorded by server)
      get().hydrate();
    });

    // Server-sent error event (agent failure) — clear streaming state and surface error
    es.addEventListener('error', (e) => {
      try {
        const data = JSON.parse(e.data);
        set(s => ({
          status: 'active',
          streamingMessage: null,
          error: data.message || 'Agent error',
          // Discard any partial streaming message
          messages: s.messages,
        }));
      } catch {
        set({ status: 'active', streamingMessage: null });
      }
    });

    // EventSource connection error — auto-reconnects, just track state
    es.onerror = () => {
      set({ status: 'active' });
    };
  },

  disconnectSSE: () => {
    if (_sse.es) {
      _sse.es.close();
      _sse.es = null;
    }
    if (_sse.reconnectTimer) {
      clearTimeout(_sse.reconnectTimer);
      _sse.reconnectTimer = null;
    }
  },

  reset: () => {
    try { localStorage.removeItem('compose:designSession'); } catch {}
    set({ session: null, messages: [], decisions: [], status: 'idle', error: null, streamingMessage: null, scope: null, featureCode: null, designDocPath: null });
  },
}));

export { useDesignStore };
