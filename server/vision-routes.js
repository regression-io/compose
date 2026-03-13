/**
 * vision-routes.js — Vision CRUD + plan/parse routes.
 *
 * Routes:
 *   GET    /api/vision/items
 *   POST   /api/vision/items
 *   PATCH  /api/vision/items/:id
 *   DELETE /api/vision/items/:id
 *   GET    /api/vision/items/:id
 *   POST   /api/vision/connections
 *   DELETE /api/vision/connections/:id
 *   GET    /api/vision/summary
 *   GET    /api/vision/blocked
 *   POST   /api/vision/ui
 *   POST   /api/plan/parse
 *   GET    /api/vision/items/:id/lifecycle
 *   POST   /api/vision/items/:id/lifecycle/start
 *   POST   /api/vision/items/:id/lifecycle/advance
 *   POST   /api/vision/items/:id/lifecycle/skip
 *   POST   /api/vision/items/:id/lifecycle/kill
 *   POST   /api/vision/items/:id/lifecycle/complete
 *   GET    /api/vision/gates
 *   GET    /api/vision/gates/:id
 *   POST   /api/vision/gates/:id/resolve
 *   GET    /api/vision/items/:id/artifacts
 *   POST   /api/vision/items/:id/artifacts/scaffold
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFilePaths } from './vision-utils.js';
import { ArtifactManager } from './artifact-manager.js';

import { TARGET_ROOT, resolveProjectPath, loadProjectConfig } from './project-root.js';

const PROJECT_ROOT = TARGET_ROOT;

/**
 * Attach vision CRUD and plan/parse REST routes to an Express app.
 *
 * @param {object} app — Express app
 * @param {{ store: object, scheduleBroadcast: function, broadcastMessage: function, projectRoot: string }} deps
 */
export function attachVisionRoutes(app, { store, scheduleBroadcast, broadcastMessage, projectRoot = PROJECT_ROOT, settingsStore }) {
  // GET /api/vision/items — full state
  app.get('/api/vision/items', (_req, res) => {
    res.json(store.getState());
  });

  // POST /api/vision/items — create item
  app.post('/api/vision/items', (req, res) => {
    try {
      const item = store.createItem(req.body);
      scheduleBroadcast();
      res.status(201).json(item);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // PATCH /api/vision/items/:id — update item
  app.patch('/api/vision/items/:id', (req, res) => {
    try {
      const item = store.updateItem(req.params.id, req.body);
      scheduleBroadcast();
      res.json(item);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  });

  // DELETE /api/vision/items/:id — delete item + connections
  app.delete('/api/vision/items/:id', (req, res) => {
    try {
      store.deleteItem(req.params.id);
      scheduleBroadcast();
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // POST /api/vision/connections — create connection
  app.post('/api/vision/connections', (req, res) => {
    try {
      const conn = store.createConnection(req.body);
      scheduleBroadcast();
      res.status(201).json(conn);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // DELETE /api/vision/connections/:id — delete connection
  app.delete('/api/vision/connections/:id', (req, res) => {
    try {
      store.deleteConnection(req.params.id);
      scheduleBroadcast();
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // GET /api/vision/items/:id — get single item by ID
  app.get('/api/vision/items/:id', (req, res) => {
    const items = store.getState().items;
    const item = items.find(i => i.id === req.params.id);
    if (!item) {
      return res.status(404).json({ error: `Item not found: ${req.params.id}` });
    }
    const connections = store.getState().connections.filter(
      c => c.fromId === req.params.id || c.toId === req.params.id
    );
    res.json({ ...item, connections });
  });

  // ── Lifecycle endpoints (simplified — no state machine) ──────────────
  const featuresPath = projectRoot !== PROJECT_ROOT
    ? path.join(projectRoot, loadProjectConfig().paths?.features || 'docs/features')
    : resolveProjectPath('features');

  const TRANSITIONS = {
    explore_design: ['prd', 'architecture', 'blueprint'],
    prd: ['architecture', 'blueprint'],
    architecture: ['blueprint'],
    blueprint: ['verification'],
    verification: ['plan', 'blueprint'],
    plan: ['execute'],
    execute: ['report', 'docs'],
    report: ['docs'],
    docs: ['ship'],
    ship: [],
  };
  const SKIPPABLE = new Set(['prd', 'architecture', 'report']);
  const TERMINAL = new Set(['complete', 'killed']);

  app.get('/api/vision/items/:id/lifecycle', (req, res) => {
    try {
      const item = store.items.get(req.params.id);
      if (!item) return res.status(404).json({ error: `Item not found: ${req.params.id}` });
      if (!item.lifecycle) return res.status(404).json({ error: 'No lifecycle on this item' });
      res.json(item.lifecycle);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/vision/items/:id/lifecycle/start', (req, res) => {
    try {
      const { featureCode } = req.body;
      if (!featureCode) return res.status(400).json({ error: 'featureCode is required' });
      const item = store.items.get(req.params.id);
      if (!item) return res.status(404).json({ error: `Item not found: ${req.params.id}` });
      if (item.lifecycle) return res.status(400).json({ error: `Item ${req.params.id} already has a lifecycle` });

      const now = new Date().toISOString();
      const lifecycle = {
        currentPhase: 'explore_design',
        featureCode,
        startedAt: now,
        completedAt: null,
        killedAt: null,
        killReason: null,
      };
      store.updateLifecycle(req.params.id, lifecycle);
      scheduleBroadcast();
      broadcastMessage({ type: 'lifecycleStarted', itemId: req.params.id, phase: 'explore_design', featureCode, timestamp: now });
      res.json(lifecycle);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  });

  app.post('/api/vision/items/:id/lifecycle/advance', (req, res) => {
    try {
      const { targetPhase, outcome } = req.body;
      const item = store.items.get(req.params.id);
      if (!item?.lifecycle) return res.status(404).json({ error: 'No lifecycle on this item' });
      const from = item.lifecycle.currentPhase;
      if (TERMINAL.has(from)) return res.status(400).json({ error: `Cannot advance from terminal state: ${from}` });
      const valid = TRANSITIONS[from];
      if (!valid?.includes(targetPhase)) return res.status(400).json({ error: `Invalid transition: ${from} → ${targetPhase}` });

      item.lifecycle.currentPhase = targetPhase;
      store.updateLifecycle(req.params.id, item.lifecycle);
      const now = new Date().toISOString();
      scheduleBroadcast();
      broadcastMessage({ type: 'lifecycleTransition', itemId: req.params.id, from, to: targetPhase, outcome, timestamp: now });
      res.json({ from, to: targetPhase, outcome });
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  });

  app.post('/api/vision/items/:id/lifecycle/skip', (req, res) => {
    try {
      const { targetPhase, reason } = req.body;
      const item = store.items.get(req.params.id);
      if (!item?.lifecycle) return res.status(404).json({ error: 'No lifecycle on this item' });
      const from = item.lifecycle.currentPhase;
      if (TERMINAL.has(from)) return res.status(400).json({ error: `Cannot skip from terminal state: ${from}` });
      if (!SKIPPABLE.has(from)) return res.status(400).json({ error: `Phase ${from} is not skippable` });
      const valid = TRANSITIONS[from];
      if (!valid?.includes(targetPhase)) return res.status(400).json({ error: `Invalid transition: ${from} → ${targetPhase}` });

      item.lifecycle.currentPhase = targetPhase;
      store.updateLifecycle(req.params.id, item.lifecycle);
      const now = new Date().toISOString();
      scheduleBroadcast();
      broadcastMessage({ type: 'lifecycleTransition', itemId: req.params.id, from, to: targetPhase, outcome: 'skipped', timestamp: now });
      res.json({ from, to: targetPhase, outcome: 'skipped', reason });
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  });

  app.post('/api/vision/items/:id/lifecycle/kill', (req, res) => {
    try {
      const { reason } = req.body;
      const item = store.items.get(req.params.id);
      if (!item?.lifecycle) return res.status(404).json({ error: 'No lifecycle on this item' });
      const from = item.lifecycle.currentPhase;
      if (TERMINAL.has(from)) return res.status(400).json({ error: `Cannot kill from terminal state: ${from}` });

      const now = new Date().toISOString();
      item.lifecycle.currentPhase = 'killed';
      item.lifecycle.killedAt = now;
      item.lifecycle.killReason = reason;
      store.updateLifecycle(req.params.id, item.lifecycle);
      store.updateItem(req.params.id, { status: 'killed' });
      scheduleBroadcast();
      broadcastMessage({ type: 'lifecycleTransition', itemId: req.params.id, from, to: 'killed', outcome: 'killed', timestamp: now });
      res.json({ phase: from, reason });
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  });

  app.post('/api/vision/items/:id/lifecycle/complete', (req, res) => {
    try {
      const item = store.items.get(req.params.id);
      if (!item?.lifecycle) return res.status(404).json({ error: 'No lifecycle on this item' });
      if (item.lifecycle.currentPhase !== 'ship') {
        return res.status(400).json({ error: `Can only complete from ship phase, currently in: ${item.lifecycle.currentPhase}` });
      }

      const now = new Date().toISOString();
      item.lifecycle.currentPhase = 'complete';
      item.lifecycle.completedAt = now;
      store.updateLifecycle(req.params.id, item.lifecycle);
      store.updateItem(req.params.id, { status: 'complete' });
      scheduleBroadcast();
      broadcastMessage({ type: 'lifecycleTransition', itemId: req.params.id, from: 'ship', to: 'complete', outcome: 'approved', timestamp: now });
      res.json({ completedAt: now });
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  });

  // ── Artifact endpoints ───────────────────────────────────────────────
  const artifactManager = new ArtifactManager(featuresPath);

  app.get('/api/vision/items/:id/artifacts', (req, res) => {
    try {
      const item = store.items.get(req.params.id);
      if (!item) return res.status(404).json({ error: `Item not found: ${req.params.id}` });
      if (!item.lifecycle?.featureCode) {
        return res.status(400).json({ error: 'Item has no lifecycle featureCode' });
      }
      const assessment = artifactManager.assess(item.lifecycle.featureCode);
      res.json(assessment);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/vision/items/:id/artifacts/scaffold', (req, res) => {
    try {
      const item = store.items.get(req.params.id);
      if (!item) return res.status(404).json({ error: `Item not found: ${req.params.id}` });
      if (!item.lifecycle?.featureCode) {
        return res.status(400).json({ error: 'Item has no lifecycle featureCode' });
      }
      const result = artifactManager.scaffold(item.lifecycle.featureCode, req.body);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Gate endpoints ─────────────────────────────────────────────────

  app.get('/api/vision/gates', (req, res) => {
    try {
      const statusFilter = req.query.status;
      if (statusFilter === 'all') {
        res.json({ gates: store.getAllGates() });
      } else if (statusFilter === 'resolved') {
        res.json({ gates: store.getAllGates().filter(g => g.status === 'resolved') });
      } else {
        const itemId = req.query.itemId || undefined;
        const gates = store.getPendingGates(itemId);
        res.json({ gates });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/vision/gates — create a gate (used by CLI dual-dispatch)
  app.post('/api/vision/gates', (req, res) => {
    try {
      const { flowId, stepId, itemId, artifact, options, fromPhase, toPhase, summary, comment } = req.body;
      const round = req.body.round ?? 1;
      if (!flowId || !stepId) {
        return res.status(400).json({ error: 'flowId and stepId are required' });
      }
      const id = `${flowId}:${stepId}:${round}`;
      const existing = store.getGateById(id);
      if (existing) {
        return res.status(200).json(existing); // idempotent
      }
      const gate = {
        id,
        flowId,
        stepId,
        round,
        itemId: itemId || null,
        artifact: artifact || null,
        options: options || null,
        fromPhase: fromPhase || null,
        toPhase: toPhase || null,
        summary: summary || null,
        comment: comment || null,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      store.createGate(gate);
      scheduleBroadcast();
      broadcastMessage({ type: 'gateCreated', gateId: id, itemId: itemId || null, timestamp: gate.createdAt });
      res.status(201).json(gate);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/vision/gates/:id', (req, res) => {
    try {
      const gate = store.gates.get(req.params.id);
      if (!gate) return res.status(404).json({ error: `Gate not found: ${req.params.id}` });
      // Lazy gate expiry
      const gateTimeout = Number(process.env.COMPOSE_GATE_TIMEOUT) || 30 * 60 * 1000;
      if (gate.status === 'pending' && (Date.now() - new Date(gate.createdAt).getTime()) > gateTimeout) {
        gate.status = 'expired';
        store._save();
      }
      res.json(gate);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/vision/gates/:id/resolve', (req, res) => {
    try {
      const { outcome: rawOutcome, comment } = req.body;
      if (!rawOutcome) return res.status(400).json({ error: 'outcome is required' });
      // Normalize legacy outcome values
      const outcomeMap = { approved: 'approve', killed: 'kill', revised: 'revise' };
      const outcome = outcomeMap[rawOutcome] || rawOutcome;
      const gate = store.gates.get(req.params.id);
      if (!gate) return res.status(404).json({ error: `Gate not found: ${req.params.id}` });
      // Idempotent: already-resolved gates return 200
      if (gate.status !== 'pending') {
        return res.status(200).json({ gateId: req.params.id, gateOutcome: gate.outcome });
      }

      // AD-4: Server only updates gate state. CLI owns lifecycle transitions.
      store.resolveGate(req.params.id, { outcome, comment });

      scheduleBroadcast();
      broadcastMessage({ type: 'gateResolved', gateId: req.params.id, itemId: gate.itemId, outcome, timestamp: new Date().toISOString() });
      res.json({ gateId: req.params.id, gateOutcome: outcome });
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  });

  // GET /api/vision/summary — structured board summary
  app.get('/api/vision/summary', (_req, res) => {
    const { items, connections } = store.getState();
    const byPhase = {};
    const byStatus = {};
    const byType = {};
    let totalConfidence = 0;
    let confidenceCount = 0;
    let openQuestions = 0;
    let blockedItems = 0;

    for (const item of items) {
      const phase = item.phase || 'unassigned';
      byPhase[phase] = (byPhase[phase] || 0) + 1;

      const status = item.status || 'planned';
      byStatus[status] = (byStatus[status] || 0) + 1;

      const type = item.type || 'artifact';
      byType[type] = (byType[type] || 0) + 1;

      if (typeof item.confidence === 'number') {
        totalConfidence += item.confidence;
        confidenceCount++;
      }

      if (item.type === 'question' && item.status !== 'complete' && item.status !== 'killed') {
        openQuestions++;
      }

      if (item.status === 'blocked') {
        blockedItems++;
      }
    }

    res.json({
      totalItems: items.length,
      totalConnections: connections.length,
      byPhase,
      byStatus,
      byType,
      openQuestions,
      blockedItems,
      avgConfidence: confidenceCount > 0 ? Math.round((totalConfidence / confidenceCount) * 100) / 100 : 0,
    });
  });

  // GET /api/vision/blocked — items blocked by non-complete items
  app.get('/api/vision/blocked', (_req, res) => {
    const { items, connections } = store.getState();
    const itemMap = new Map(items.map(i => [i.id, i]));

    const blocked = [];
    for (const conn of connections) {
      if (conn.type === 'blocks') {
        const blocker = itemMap.get(conn.fromId);
        const target = itemMap.get(conn.toId);
        if (blocker && target && blocker.status !== 'complete' && blocker.status !== 'killed') {
          blocked.push({
            item: target,
            blockedBy: blocker,
            connectionId: conn.id,
          });
        }
      }
    }

    res.json({ blocked, count: blocked.length });
  });

  // POST /api/vision/ui — push UI commands (lens, layout, phase)
  app.post('/api/vision/ui', (req, res) => {
    broadcastMessage({ type: 'visionUI', ...req.body });
    res.json({ ok: true });
  });

  // POST /api/plan/parse — extract file paths from plan/spec markdown
  app.post('/api/plan/parse', (req, res) => {
    const { filePath, itemId } = req.body || {};
    if (!filePath) return res.status(400).json({ error: 'filePath required' });

    const fullPath = path.resolve(projectRoot, filePath);
    if (!fullPath.startsWith(projectRoot)) {
      return res.status(400).json({ error: 'Path must be within project' });
    }
    let content;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      return res.status(404).json({ error: `File not found: ${filePath}` });
    }

    const extracted = extractFilePaths(content);

    if (itemId) {
      const item = store.items.get(itemId);
      if (item) {
        const existing = item.files || [];
        const merged = [...new Set([...existing, ...extracted])];
        store.updateItem(itemId, { files: merged });
        scheduleBroadcast();
      }
    }

    res.json({ files: extracted, itemId: itemId || null });
  });
}
