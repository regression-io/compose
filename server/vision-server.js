/**
 * Vision Server — REST endpoints + WebSocket broadcast for the vision surface.
 * Follows the same attach() pattern as FileWatcherServer.
 */

import { WebSocketServer } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireSensitiveToken } from './security.js';
import { spawnJournalAgent, extractSlugFromPath } from './vision-utils.js';
import { attachSpeckitRoutes } from './speckit-helpers.js';
import { StratumSync, attachStratumRoutes } from './stratum-sync.js';
import { createStratumRouter } from './stratum-api.js';
import { attachAgentSpawnRoutes } from './agent-spawn.js';
import { attachVisionRoutes } from './vision-routes.js';
import { attachSessionRoutes } from './session-routes.js';
import { attachActivityRoutes } from './activity-routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

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

    // ── Activity + error routes ─────────────────────────────────────────────
    attachActivityRoutes(app, {
      store: this.store,
      sessionManager: this.sessionManager,
      scheduleBroadcast: () => this.scheduleBroadcast(),
      broadcastMessage: (msg) => this.broadcastMessage(msg),
      resolveItems: (fp) => this.resolveItems(fp),
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

    // ── Stratum pipeline monitor + gate routes ──────────────────────────────
    app.use('/api/stratum', createStratumRouter());

    // ── Stratum vision-sync poller + bind/audit routes ──────────────────────
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
