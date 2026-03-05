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
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFilePaths } from './vision-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * Attach vision CRUD and plan/parse REST routes to an Express app.
 *
 * @param {object} app — Express app
 * @param {{ store: object, scheduleBroadcast: function, broadcastMessage: function, projectRoot: string }} deps
 */
export function attachVisionRoutes(app, { store, scheduleBroadcast, broadcastMessage, projectRoot = PROJECT_ROOT }) {
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
