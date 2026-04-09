/**
 * Vision Server — REST endpoints + WebSocket broadcast for the vision surface.
 * Follows the same attach() pattern as FileWatcherServer.
 */

import { WebSocketServer } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireSensitiveToken } from './security.js';
import { spawnJournalAgent, extractSlugFromPath } from './vision-utils.js';
import { attachFeatureScanRoutes } from './feature-scan.js';
import { attachGraphExportRoutes } from './graph-export.js';
import { StratumSync, attachStratumRoutes } from './stratum-sync.js';
import { createStratumRouter } from './stratum-api.js';
import { attachAgentSpawnRoutes } from './agent-spawn.js';
import { AgentRegistry } from './agent-registry.js';
import { HealthMonitor } from './agent-health.js';
import { WorktreeGC } from './worktree-gc.js';
import { attachVisionRoutes } from './vision-routes.js';
import { attachSessionRoutes } from './session-routes.js';
import { attachActivityRoutes } from './activity-routes.js';
import { SettingsStore } from './settings-store.js';
import { attachSettingsRoutes } from './settings-routes.js';
import { attachDesignRoutes } from './design-routes.js';
import { DesignSessionManager } from './design-session.js';
import { ClaudeSDKConnector } from './connectors/claude-sdk-connector.js';
import { attachPipelineRoutes } from './pipeline-routes.js';
/** Settings defaults (previously derived from contracts/lifecycle.json). */
const SETTINGS_DEFAULTS = {
  phases: [
    { id: 'explore_design', defaultPolicy: null },
    { id: 'prd', defaultPolicy: 'skip' },
    { id: 'architecture', defaultPolicy: 'skip' },
    { id: 'blueprint', defaultPolicy: 'gate' },
    { id: 'verification', defaultPolicy: 'gate' },
    { id: 'plan', defaultPolicy: 'gate' },
    { id: 'execute', defaultPolicy: 'flag' },
    { id: 'report', defaultPolicy: 'skip' },
    { id: 'docs', defaultPolicy: 'flag' },
    { id: 'ship', defaultPolicy: 'gate' },
  ],
  iterationDefaults: {
    review: { maxIterations: 4, timeout: 15, maxTotal: 20 },
    coverage: { maxIterations: 15, timeout: 30, maxTotal: 50 },
  },
  policyModes: ['gate', 'flag', 'skip'],
};

import { getTargetRoot, getDataDir } from './project-root.js';

export class VisionServer {
  constructor(store, sessionManager = null, { config } = {}) {
    this.store = store;
    this.sessionManager = sessionManager;
    this._config = config || { capabilities: { stratum: true } };
    this.clients = new Set();
    this.wss = null;
    this._broadcastTimer = null;
    this._pendingSnapshots = new Map();
    this._stratumSync = null;
  }

  attach(httpServer, app) {
    // ── Settings store ────────────────────────────────────────────────────
    this.settingsStore = new SettingsStore(undefined, SETTINGS_DEFAULTS);

    // ── Settings routes ───────────────────────────────────────────────────
    attachSettingsRoutes(app, {
      settingsStore: this.settingsStore,
      broadcastMessage: (msg) => this.broadcastMessage(msg),
    });

    // ── Vision CRUD + plan/parse routes ────────────────────────────────────
    attachVisionRoutes(app, {
      store: this.store,
      scheduleBroadcast: () => this.scheduleBroadcast(),
      broadcastMessage: (msg) => this.broadcastMessage(msg),
      projectRoot: getTargetRoot(),
      settingsStore: this.settingsStore,
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
      projectRoot: getTargetRoot(),
      store: this.store,
    });

    // ── Pipeline authoring routes ──────────────────────────────────────────
    attachPipelineRoutes(app, {
      broadcastMessage: (msg) => this.broadcastMessage(msg),
      scheduleBroadcast: () => this.scheduleBroadcast(),
      getDataDir: () => getDataDir(),
      getPipelinesDir: () => path.join(getTargetRoot(), 'pipelines'),
      stratumClient: null, // V1: no MCP client in server context; fallback YAML parse is acceptable
    });

    // ── Design conversation routes ──────────────────────────────────────────
    // Re-resolve on every call so project switches get fresh instances.
    let _designSessionManager = null;
    let _designDataDir = null;
    let _designConnector = null;
    let _designCwd = null;

    attachDesignRoutes(app, {
      getSessionManager: () => {
        const dataDir = getDataDir();
        if (dataDir !== _designDataDir) {
          if (_designSessionManager) _designSessionManager.destroy();
          _designSessionManager = new DesignSessionManager(dataDir);
          _designDataDir = dataDir;
        }
        return _designSessionManager;
      },
      getConnector: () => {
        const cwd = getTargetRoot();
        if (cwd !== _designCwd) {
          _designConnector = new ClaudeSDKConnector({ cwd });
          _designCwd = cwd;
        }
        return _designConnector;
      },
      getProjectRoot: () => getTargetRoot(),
    });

    // ── Build state hydration ─────────────────────────────────────────────
    app.get('/api/build/state', (_req, res) => {
      const buildPath = path.join(getDataDir(), 'active-build.json');
      try {
        if (fs.existsSync(buildPath)) {
          const state = JSON.parse(fs.readFileSync(buildPath, 'utf-8'));
          res.json({ state });
        } else {
          res.json({ state: null });
        }
      } catch {
        res.json({ state: null });
      }
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

    // ── Agent spawn routes + lifecycle services ────────────────────────────
    // TODO: Load lifecycle config (silenceKillMs, defaultTimeoutMs, memoryLimitMB,
    // gcIntervalMs, gcMaxAgeMs) from .compose/compose.json and pass to HealthMonitor
    // and WorktreeGC constructors. Defaults work fine for V1.
    const agentRegistry = new AgentRegistry(getDataDir());
    this._healthMonitor = new HealthMonitor({
      broadcastMessage: (msg) => this.broadcastMessage(msg),
    });
    this._worktreeGC = new WorktreeGC({
      projectRoot: getTargetRoot(),
      parDir: path.join(getTargetRoot(), '.compose', 'par'),
    });
    this._worktreeGC.start();
    attachAgentSpawnRoutes(app, {
      projectRoot: getTargetRoot(),
      broadcastMessage: (msg) => this.broadcastMessage(msg),
      requireSensitiveToken,
      registry: agentRegistry,
      sessionManager: this.sessionManager,
      healthMonitor: this._healthMonitor,
      worktreeGC: this._worktreeGC,
    });

    // ── Feature scan routes ────────────────────────────────────────────────
    attachFeatureScanRoutes(app, {
      store: this.store,
      scheduleBroadcast: () => this.scheduleBroadcast(),
    });

    // ── Graph export routes ──────────────────────────────────────────────
    attachGraphExportRoutes(app, { store: this.store });

    // ── Stratum (conditional) ────────────────────────────────────────────
    if (this._config.capabilities?.stratum) {
      app.use('/api/stratum', createStratumRouter());
      this._stratumSync = new StratumSync(this.store, () => this.scheduleBroadcast());
      attachStratumRoutes(app, {
        store: this.store,
        scheduleBroadcast: () => this.scheduleBroadcast(),
        broadcastMessage: (msg) => this.broadcastMessage(msg),
        sync: this._stratumSync,
      });
      this._stratumSync.start();
      console.log('[vision] Stratum sync enabled');
    } else {
      app.use('/api/stratum', (_req, res) => {
        res.status(503).json({ error: 'Stratum not enabled', hint: 'pip install stratum && compose init' });
      });
    }

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
        ws.send(JSON.stringify({ type: 'visionState', ...this.store.getState(), sessions: this.sessionManager?.getRecentSessions?.() || [] }));
        ws.send(JSON.stringify({ type: 'settingsState', settings: this.settingsStore.get() }));
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
    this.broadcastMessage({ type: 'visionState', ...this.store.getState(), sessions: this.sessionManager?.getRecentSessions?.() || [] });
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
    if (this._healthMonitor) this._healthMonitor.destroy();
    if (this._worktreeGC) this._worktreeGC.stop();
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    if (this.wss) this.wss.close();
  }

  /** Resolve a file path to matching tracker items */
  resolveItems(filePath) {
    const rel = filePath.startsWith(getTargetRoot())
      ? filePath.slice(getTargetRoot().length + 1)
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
