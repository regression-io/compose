/**
 * feature-scan.js — Scan feature folders and seed vision store.
 *
 * Scans docs/features/ (or custom path from config) and upserts features
 * into the vision store. Replaces speckit-helpers.js.
 *
 * Routes: GET /api/features/scan, POST /api/features/seed.
 */

import fs from 'node:fs';
import path from 'node:path';

import { resolveProjectPath } from './project-root.js';

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/**
 * Scan feature folders and return structured feature data.
 *
 * Each subdirectory of the features path is a feature. If spec.md or
 * design.md exists, its first non-heading paragraph becomes the description.
 *
 * @param {string} [featuresDir] — absolute path to features directory
 * @returns {Array<{ name: string, description?: string, artifacts: string[] }>}
 */
export function scanFeatures(featuresDir) {
  const dir = featuresDir || resolveProjectPath('features');
  if (!fs.existsSync(dir)) return [];

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const features = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const featureDir = path.join(dir, entry.name);
    const feature = { name: entry.name, artifacts: [] };

    // Read description from spec.md or design.md (first non-heading paragraph)
    for (const descFile of ['spec.md', 'design.md']) {
      const filePath = path.join(featureDir, descFile);
      if (!fs.existsSync(filePath)) continue;
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const lines = raw.split('\n');
        const descLines = [];
        let pastHeading = false;
        for (const line of lines) {
          if (!pastHeading && line.startsWith('#')) { pastHeading = true; continue; }
          if (pastHeading && line.trim()) { descLines.push(line.trim()); }
          if (descLines.length >= 3) break;
        }
        if (descLines.length) {
          feature.description = descLines.join(' ');
          break;
        }
      } catch { /* skip */ }
    }

    // List artifacts
    try {
      feature.artifacts = fs.readdirSync(featureDir).filter(f => f.endsWith('.md')).sort();
    } catch { /* skip */ }

    features.push(feature);
  }

  return features;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

/**
 * Upsert feature folders into the vision store.
 *
 * @param {Array} features — result of scanFeatures()
 * @param {object} store — VisionStore instance
 * @returns {{ features: number, updated: number }}
 */
export function seedFeatures(features, store) {
  const seeded = { features: 0, updated: 0 };

  for (const feature of features) {
    // Search by lifecycle.featureCode (canonical format per STRAT-COMP-4)
    let featureItem = Array.from(store.items.values()).find(
      i => i.lifecycle?.featureCode === feature.name
    );

    if (!featureItem) {
      featureItem = store.createItem({
        type: 'feature',
        title: feature.name,
        description: feature.description || '',
        status: 'planned',
        phase: 'planning',
        files: feature.artifacts.map(a => `docs/features/${feature.name}/${a}`),
      });
      // Set lifecycle via dedicated method (not updateItem, which doesn't allow lifecycle)
      store.updateLifecycle(featureItem.id, { featureCode: feature.name, currentPhase: 'explore_design' });
      featureItem = store.items.get(featureItem.id);
      seeded.features++;
    } else if (feature.description && featureItem.description !== feature.description) {
      store.updateItem(featureItem.id, { description: feature.description });
      seeded.updated++;
    }
  }

  if (seeded.features || seeded.updated) {
    console.log(`[vision] Feature scan: ${seeded.features} new, ${seeded.updated} updated`);
  }
  return seeded;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Attach feature scan/seed REST routes to an Express app.
 *
 * @param {object} app — Express app
 * @param {{ store: object, scheduleBroadcast: function }} deps
 */
export function attachFeatureScanRoutes(app, { store, scheduleBroadcast }) {
  // GET /api/features/scan — scan feature folders and return data
  app.get('/api/features/scan', (_req, res) => {
    try {
      const features = scanFeatures();
      res.json({ features, count: features.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/features/seed — upsert feature folders into vision store
  app.post('/api/features/seed', (_req, res) => {
    try {
      const features = scanFeatures();
      const seeded = seedFeatures(features, store);
      scheduleBroadcast();
      res.json({ ok: true, ...seeded });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
