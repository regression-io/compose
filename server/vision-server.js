/**
 * Vision Server — REST endpoints + WebSocket broadcast for the vision surface.
 * Follows the same attach() pattern as FileWatcherServer.
 */

import { WebSocketServer } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireSensitiveToken } from './security.js';
import { detectError, spawnJournalAgent, extractSlugFromPath } from './vision-utils.js';
import { attachSpeckitRoutes } from './speckit-helpers.js';
import { StratumSync, attachStratumRoutes } from './stratum-sync.js';
import { attachAgentSpawnRoutes } from './agent-spawn.js';
import { attachVisionRoutes } from './vision-routes.js';
import { attachSessionRoutes } from './session-routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// NOTE: Duplicated in src/components/Terminal.jsx — keep in sync
const TOOL_CATEGORIES = {
  Read: 'reading', Glob: 'searching', Grep: 'searching',
  Write: 'writing', Edit: 'writing', NotebookEdit: 'writing',
  Bash: 'executing', Task: 'delegating', Skill: 'delegating',
  WebFetch: 'fetching', WebSearch: 'searching',
  TodoRead: 'reading', TodoWrite: 'writing',
};

export class VisionServer {
  constructor(store, sessionManager = null) {
    this.store = store;
    this.sessionManager = sessionManager;
    this.clients = new Set();
    this.wss = null;
    this._broadcastTimer = null;
    this._pendingSnapshots = new Map();
    this._stratumSync = null;
  }

  attach(httpServer, app) {
    // ── Vision CRUD + plan/parse routes ────────────────────────────────────
    attachVisionRoutes(app, {
      store: this.store,
      scheduleBroadcast: () => this.scheduleBroadcast(),
      broadcastMessage: (msg) => this.broadcastMessage(msg),
      projectRoot: PROJECT_ROOT,
    });

    // ── Activity + error routes (stay inline: use this.resolveItems) ────────

    // POST /api/agent/activity — receive tool use events from hooks
    app.post('/api/agent/activity', (req, res) => {
      const { tool, input, response, timestamp } = req.body || {};
      if (!tool) return res.status(400).json({ error: 'tool is required' });

      let detail = null;
      let filePath = null;
      if (input) {
        filePath = input.file_path || null;
        detail = filePath || input.command || input.pattern || input.query || input.url || input.prompt || null;
        if (detail && detail.length > 120) detail = detail.slice(0, 117) + '...';
      }

      const items = filePath ? this.resolveItems(filePath) : [];

      // Auto-status: Write/Edit on planned items → in_progress
      if (['Write', 'Edit'].includes(tool) && filePath) {
        for (const item of items) {
          if (item.status === 'planned') {
            try {
              this.store.updateItem(item.id, { status: 'in_progress' });
              this.scheduleBroadcast();
            } catch { /* ignore */ }
          }
        }
      }

      const category = TOOL_CATEGORIES[tool] || 'thinking';

      if (this.sessionManager) {
        this.sessionManager.recordActivity(tool, category, filePath, input, items);
      }

      let error = null;
      if (response && typeof response === 'string') {
        error = detectError(tool, input, response);
      }

      if (error) {
        if (this.sessionManager) {
          this.sessionManager.recordError(tool, filePath, error.type, error.severity, error.message, items);
        }
        this.broadcastMessage({
          type: 'agentError',
          errorType: error.type,
          severity: error.severity,
          message: error.message,
          tool,
          detail,
          items: items.map(i => ({ id: i.id, title: i.title })),
          timestamp: timestamp || new Date().toISOString(),
        });
      }

      this.broadcastMessage({
        type: 'agentActivity',
        tool,
        category,
        detail,
        error: error ? { type: error.type, severity: error.severity } : null,
        items: items.map(i => ({ id: i.id, title: i.title, status: i.status })),
        timestamp: timestamp || new Date().toISOString(),
      });

      res.json({ ok: true });
    });

    // POST /api/agent/error — receive PostToolUseFailure events from hooks
    app.post('/api/agent/error', (req, res) => {
      const { tool, input, error: errorMsg } = req.body || {};
      if (!tool) return res.status(400).json({ error: 'tool is required' });

      const filePath = input?.file_path || null;
      const items = filePath ? this.resolveItems(filePath) : [];

      const detected = detectError(tool, input, errorMsg || '') || {
        type: 'runtime_error',
        severity: 'error',
        message: errorMsg || 'Tool use failed',
      };

      if (this.sessionManager) {
        this.sessionManager.recordError(tool, filePath, detected.type, detected.severity, detected.message, items);
      }

      this.broadcastMessage({
        type: 'agentError',
        errorType: detected.type,
        severity: detected.severity,
        message: detected.message,
        tool,
        detail: filePath || input?.command || null,
        items: items.map(i => ({ id: i.id, title: i.title })),
        timestamp: new Date().toISOString(),
      });

      console.log(`[vision] Error detected: ${detected.type} (${detected.severity}) from ${tool}: ${detected.message.slice(0, 80)}`);
      res.json({ ok: true, detected });
    });

    // ── Session routes ──────────────────────────────────────────────────────
    attachSessionRoutes(app, {
      sessionManager: this.sessionManager,
      scheduleBroadcast: () => this.scheduleBroadcast(),
      broadcastMessage: (msg) => this.broadcastMessage(msg),
      spawnJournalAgent,
      projectRoot: PROJECT_ROOT,
    });

    // ── Snapshot route (stays inline: uses this._pendingSnapshots + this.clients) ──
    app.get('/api/snapshot', (req, res) => {
      const requestId = `snap-${Date.now()}`;
      const timeout = parseInt(req.query.timeout) || 3000;

      let target = null;
      for (const client of this.clients) {
        if (client.readyState === 1) { target = client; break; }
      }
      if (!target) {
        return res.status(503).json({ error: 'No connected clients' });
      }

      const timer = setTimeout(() => {
        this._pendingSnapshots.delete(requestId);
        res.status(504).json({ error: 'Snapshot timeout' });
      }, timeout);

      this._pendingSnapshots.set(requestId, { res, timer });

      try {
        target.send(JSON.stringify({ type: 'snapshotRequest', requestId }));
      } catch (err) {
        clearTimeout(timer);
        this._pendingSnapshots.delete(requestId);
        res.status(500).json({ error: err.message });
      }
    });

    // ── Agent spawn routes ──────────────────────────────────────────────────
    attachAgentSpawnRoutes(app, {
      projectRoot: PROJECT_ROOT,
      broadcastMessage: (msg) => this.broadcastMessage(msg),
      requireSensitiveToken,
    });

    // ── Speckit routes ──────────────────────────────────────────────────────
    attachSpeckitRoutes(app, {
      projectRoot: PROJECT_ROOT,
      store: this.store,
      scheduleBroadcast: () => this.scheduleBroadcast(),
    });

    // ── Stratum routes + poller ─────────────────────────────────────────────
    this._stratumSync = new StratumSync(this.store, () => this.scheduleBroadcast());
    attachStratumRoutes(app, {
      store: this.store,
      scheduleBroadcast: () => this.scheduleBroadcast(),
      broadcastMessage: (msg) => this.broadcastMessage(msg),
      sync: this._stratumSync,
    });
    this._stratumSync.start();

    // ── Haiku summary broadcast ─────────────────────────────────────────────
    if (this.sessionManager) {
      this.sessionManager.onSummary((summary) => {
        this.broadcastMessage({ type: 'sessionSummary', ...summary, timestamp: new Date().toISOString() });
      });
    }

    // ── WebSocket ───────────────────────────────────────────────────────────
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      console.log(`[vision] Client connected (${this.clients.size} total)`);

      try {
        ws.send(JSON.stringify({ type: 'visionState', ...this.store.getState() }));
      } catch (err) {
        console.error('[vision] Error sending initial state:', err.message);
      }

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'snapshotResponse' && msg.requestId) {
            const pending = this._pendingSnapshots.get(msg.requestId);
            if (pending) {
              clearTimeout(pending.timer);
              this._pendingSnapshots.delete(msg.requestId);
              pending.res.json(msg.snapshot);
            }
          }
        } catch {
          // ignore malformed messages
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        console.log(`[vision] Client disconnected (${this.clients.size} total)`);
      });

      ws.on('error', (err) => {
        console.error('[vision] WebSocket error:', err.message);
        this.clients.delete(ws);
      });
    });

    console.log('Vision server attached (REST + WebSocket at /ws/vision)');
  }

  /** Schedule a debounced broadcast (100ms) to coalesce rapid mutations */
  scheduleBroadcast() {
    if (this._broadcastTimer) clearTimeout(this._broadcastTimer);
    this._broadcastTimer = setTimeout(() => {
      this._broadcastTimer = null;
      this.broadcastState();
    }, 100);
  }

  /** Broadcast full state to all connected clients */
  broadcastState() {
    this.broadcastMessage({ type: 'visionState', ...this.store.getState() });
  }

  /** Broadcast any message to all connected clients */
  broadcastMessage(msg) {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState === 1) {
        try {
          client.send(data);
        } catch (err) {
          console.error('[vision] Broadcast error:', err.message);
        }
      }
    }
  }

  close() {
    if (this._stratumSync) this._stratumSync.stop();
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    if (this.wss) this.wss.close();
  }

  /** Resolve a file path to matching tracker items */
  resolveItems(filePath) {
    const rel = filePath.startsWith(PROJECT_ROOT)
      ? filePath.slice(PROJECT_ROOT.length + 1)
      : filePath.replace(/^\.\//, '');
    const matches = [];
    const matchType = new Map();

    for (const item of this.store.items.values()) {
      if (item.files && item.files.length > 0) {
        for (const pattern of item.files) {
          if (pattern.endsWith('/')) {
            if (rel.startsWith(pattern)) { matches.push(item); matchType.set(item.id, 'prefix'); break; }
          } else {
            if (rel === pattern) { matches.push(item); matchType.set(item.id, 'exact'); break; }
          }
        }
      }
      if (rel.startsWith('docs/') && item.slug) {
        const slug = extractSlugFromPath(rel);
        if (slug && slug === item.slug) {
          if (!matches.find(m => m.id === item.id)) {
            matches.push(item);
            matchType.set(item.id, 'slug');
          }
        }
      }
    }

    const specificity = { exact: 0, prefix: 1, slug: 2 };
    matches.sort((a, b) => {
      if (a.status === 'in_progress' && b.status !== 'in_progress') return -1;
      if (b.status === 'in_progress' && a.status !== 'in_progress') return 1;
      const sa = specificity[matchType.get(a.id)] ?? 3;
      const sb = specificity[matchType.get(b.id)] ?? 3;
      if (sa !== sb) return sa - sb;
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });

    return matches;
  }
}
