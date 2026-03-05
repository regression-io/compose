/**
 * speckit-helpers.js — Speckit scan/seed helpers + route registration.
 *
 * Scans the .specify/ directory structure and upserts features/tasks into the
 * vision store. Routes: GET /api/speckit/scan, POST /api/speckit/seed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/**
 * Scan .specify/ directory and return structured feature + task data.
 *
 * @param {string} [projectRoot]
 * @returns {Array<{ name: string, description?: string, tasks: Array<{ filename: string, title: string }> }>}
 */
export function scanSpeckit(projectRoot = PROJECT_ROOT) {
  const specDir = path.join(projectRoot, '.specify');
  if (!fs.existsSync(specDir)) return [];

  const features = [];
  let entries;
  try {
    entries = fs.readdirSync(specDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const featureDir = path.join(specDir, entry.name);
    const feature = { name: entry.name, tasks: [] };

    // Read spec.md for description
    const specPath = path.join(featureDir, 'spec.md');
    if (fs.existsSync(specPath)) {
      try {
        const raw = fs.readFileSync(specPath, 'utf-8');
        const lines = raw.split('\n');
        const descLines = [];
        let pastHeading = false;
        for (const line of lines) {
          if (!pastHeading && line.startsWith('#')) { pastHeading = true; continue; }
          if (pastHeading && line.trim()) { descLines.push(line.trim()); }
          if (descLines.length >= 3) break;
        }
        feature.description = descLines.join(' ');
      } catch { /* skip */ }
    }

    // Read tasks/*.md
    const tasksDir = path.join(featureDir, 'tasks');
    if (fs.existsSync(tasksDir)) {
      let taskFiles;
      try {
        taskFiles = fs.readdirSync(tasksDir).filter(f => f.endsWith('.md')).sort();
      } catch { taskFiles = []; }

      for (const taskFile of taskFiles) {
        try {
          const taskContent = fs.readFileSync(path.join(tasksDir, taskFile), 'utf-8');
          const titleMatch = taskContent.match(/^#\s+(.+)$/m);
          feature.tasks.push({
            filename: taskFile,
            title: titleMatch ? titleMatch[1].trim() : taskFile.replace(/\.md$/, ''),
          });
        } catch { /* skip */ }
      }
    }

    features.push(feature);
  }

  return features;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

/**
 * Upsert .specify/ features and tasks into the vision store.
 *
 * @param {Array} features — result of scanSpeckit()
 * @param {object} store — VisionStore instance
 * @returns {{ features: number, tasks: number, updated: number }}
 */
export function seedSpeckit(features, store) {
  const seeded = { features: 0, tasks: 0, updated: 0 };

  for (const feature of features) {
    const featureKey = `speckit:feature:${feature.name}`;

    let featureItem = Array.from(store.items.values()).find(i => i.speckitKey === featureKey);

    if (!featureItem) {
      featureItem = store.createItem({
        type: 'feature',
        title: feature.name,
        description: feature.description || '',
        status: 'planned',
        phase: 'planning',
        files: [`.specify/${feature.name}/`],
      });
      store.updateItem(featureItem.id, { speckitKey: featureKey });
      featureItem = store.items.get(featureItem.id);
      seeded.features++;
    } else if (feature.description && featureItem.description !== feature.description) {
      store.updateItem(featureItem.id, { description: feature.description });
      seeded.updated++;
    }

    for (const task of feature.tasks) {
      const taskKey = `speckit:task:${feature.name}:${task.filename}`;
      let taskItem = Array.from(store.items.values()).find(i => i.speckitKey === taskKey);

      if (!taskItem) {
        taskItem = store.createItem({
          type: 'task',
          title: task.title,
          description: '',
          status: 'planned',
          phase: 'implementation',
          parentId: featureItem.id,
          files: [`.specify/${feature.name}/tasks/${task.filename}`],
        });
        store.updateItem(taskItem.id, { speckitKey: taskKey });
        taskItem = store.items.get(taskItem.id);
        seeded.tasks++;

        try {
          store.createConnection({ fromId: taskItem.id, toId: featureItem.id, type: 'implements' });
        } catch { /* connection may already exist */ }
      } else if (taskItem.title !== task.title) {
        store.updateItem(taskItem.id, { title: task.title });
        seeded.updated++;
      }
    }
  }

  console.log(`[vision] Speckit seed: ${seeded.features} new features, ${seeded.tasks} new tasks, ${seeded.updated} updated`);
  return seeded;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Attach speckit REST routes to an Express app.
 *
 * @param {object} app — Express app
 * @param {{ projectRoot: string, store: object, scheduleBroadcast: function }} deps
 */
export function attachSpeckitRoutes(app, { projectRoot = PROJECT_ROOT, store, scheduleBroadcast }) {
  // GET /api/speckit/scan — scan .specify/ and return features + tasks
  app.get('/api/speckit/scan', (_req, res) => {
    try {
      const features = scanSpeckit(projectRoot);
      res.json({ features, count: features.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/speckit/seed — upsert .specify/ features + tasks into vision store
  app.post('/api/speckit/seed', (_req, res) => {
    try {
      const features = scanSpeckit(projectRoot);
      const seeded = seedSpeckit(features, store);
      scheduleBroadcast();
      res.json({ ok: true, ...seeded });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
