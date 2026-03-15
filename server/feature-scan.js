/**
 * feature-scan.js — Scan feature folders and seed vision store.
 *
 * Scans docs/features/ (or custom path from config) and builds rich feature
 * records from the artifacts found:
 *   - Status parsed from design.md / plan.md / report.md frontmatter
 *   - Description from first non-heading paragraph
 *   - Artifact completeness assessment (confidence score)
 *   - Related features extracted from document cross-references
 *   - Sub-package detection (top-level dirs with README.md)
 *
 * Routes: GET /api/features/scan, POST /api/features/seed.
 */

import fs from 'node:fs';
import path from 'node:path';

import { getTargetRoot, resolveProjectPath } from './project-root.js';

// ---------------------------------------------------------------------------
// Metadata extraction
// ---------------------------------------------------------------------------

const STATUS_RE = /^\*\*Status:\*\*\s*(.+)$/im;
const DATE_RE = /^\*\*Date:\*\*\s*(.+)$/im;
const FEATURE_ID_RE = /^\*\*Feature\s*ID:\*\*\s*`?([^`\n]+)`?/im;
const RELATED_DOC_RE = /\[.*?\]\(\.\.\/([\w-]+)\//g;

/**
 * Parse markdown frontmatter-style metadata from a file.
 * Looks for **Key:** Value patterns in the first 30 lines.
 */
function parseMetadata(content) {
  const meta = {};
  const statusMatch = content.match(STATUS_RE);
  if (statusMatch) meta.status = statusMatch[1].trim();

  const dateMatch = content.match(DATE_RE);
  if (dateMatch) meta.date = dateMatch[1].trim();

  const idMatch = content.match(FEATURE_ID_RE);
  if (idMatch) meta.featureId = idMatch[1].trim();

  return meta;
}

/**
 * Extract related feature codes from markdown cross-references.
 * Matches patterns like [text](../FEATURE-CODE/file.md)
 */
function parseRelatedFeatures(content) {
  const related = new Set();
  let match;
  const re = new RegExp(RELATED_DOC_RE.source, 'g');
  while ((match = re.exec(content)) !== null) {
    related.add(match[1]);
  }
  return [...related];
}

/**
 * Map free-text status strings to vision store status keys.
 */
function normalizeStatus(raw) {
  if (!raw) return null;
  const lower = raw.toLowerCase().replace(/[^a-z_\s]/g, '').trim();
  if (lower.includes('complete') || lower.includes('done') || lower.includes('shipped')) return 'complete';
  if (lower.includes('in progress') || lower.includes('in_progress') || lower.includes('active')) return 'in_progress';
  if (lower.includes('partial')) return 'in_progress';
  if (lower.includes('blocked')) return 'blocked';
  if (lower.includes('parked') || lower.includes('paused')) return 'parked';
  if (lower.includes('killed') || lower.includes('cancelled') || lower.includes('superseded')) return 'killed';
  if (lower.includes('review')) return 'review';
  if (lower.includes('ready')) return 'ready';
  return null;
}

/**
 * Infer lifecycle phase from which artifacts exist.
 */
function inferPhase(artifacts) {
  if (artifacts.includes('report.md')) return 'verification';
  if (artifacts.includes('plan.md')) return 'planning';
  if (artifacts.includes('blueprint.md')) return 'planning';
  if (artifacts.includes('architecture.md')) return 'specification';
  if (artifacts.includes('prd.md')) return 'specification';
  if (artifacts.includes('design.md')) return 'planning';
  return 'vision';
}

/**
 * Compute a 0–3 confidence score based on artifact completeness.
 *   0 = no artifacts, 1 = some exist, 2 = key artifacts present, 3 = full set
 */
function computeConfidence(artifacts) {
  if (artifacts.length === 0) return 0;
  const key = ['design.md', 'plan.md'];
  const hasKey = key.filter(k => artifacts.includes(k)).length;
  if (artifacts.length >= 4 && hasKey === 2) return 3;
  if (hasKey >= 1 && artifacts.length >= 2) return 2;
  return 1;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/**
 * Scan feature folders and return structured feature data.
 *
 * Each subdirectory of the features path is a feature. Reads metadata from
 * design.md, plan.md, report.md. Detects relationships from cross-references.
 *
 * @param {string} [featuresDir] — absolute path to features directory
 * @returns {Array<Feature>}
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
    const feature = {
      name: entry.name,
      description: '',
      status: null,
      date: null,
      phase: 'planning',
      confidence: 0,
      artifacts: [],
      relatedFeatures: [],
    };

    // List artifacts
    try {
      feature.artifacts = fs.readdirSync(featureDir)
        .filter(f => f.endsWith('.md'))
        .sort();
    } catch { /* skip */ }

    // Read metadata from docs in priority order
    const docPriority = ['design.md', 'spec.md', 'plan.md', 'report.md', 'prd.md'];
    let gotDescription = false;
    const allRelated = new Set();

    for (const docFile of docPriority) {
      const filePath = path.join(featureDir, docFile);
      if (!fs.existsSync(filePath)) continue;

      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const meta = parseMetadata(raw);

        // First status found wins
        if (!feature.status && meta.status) {
          feature.status = normalizeStatus(meta.status);
        }
        if (!feature.date && meta.date) {
          feature.date = meta.date;
        }

        // Description: first non-heading paragraph from first available doc
        if (!gotDescription) {
          const lines = raw.split('\n');
          const descLines = [];
          let pastHeading = false;
          for (const line of lines) {
            const trimmed = line.trim();
            // Skip metadata lines like **Status:** etc.
            if (trimmed.startsWith('**') && trimmed.includes(':**')) continue;
            if (trimmed.startsWith('---')) continue;
            if (trimmed.startsWith('>')) continue;
            if (!pastHeading && trimmed.startsWith('#')) { pastHeading = true; continue; }
            if (pastHeading && trimmed) { descLines.push(trimmed); }
            if (descLines.length >= 3) break;
          }
          if (descLines.length) {
            feature.description = descLines.join(' ');
            gotDescription = true;
          }
        }

        // Collect related features
        for (const rel of parseRelatedFeatures(raw)) {
          allRelated.add(rel);
        }
      } catch { /* skip */ }
    }

    // Remove self-references
    allRelated.delete(feature.name);
    feature.relatedFeatures = [...allRelated];

    // Infer phase from artifacts
    feature.phase = inferPhase(feature.artifacts);

    // Compute confidence from artifact completeness
    feature.confidence = computeConfidence(feature.artifacts);

    // Default status if none found in docs
    if (!feature.status) {
      // If there's a report.md, likely complete
      if (feature.artifacts.includes('report.md')) feature.status = 'complete';
      else feature.status = 'planned';
    }

    features.push(feature);
  }

  return features;
}

/**
 * Scan top-level directories that look like sub-packages.
 * A sub-package has a README.md or setup.py/pyproject.toml at its root.
 */
export function scanSubPackages() {
  const root = getTargetRoot();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const packages = [];
  const markers = ['README.md', 'pyproject.toml', 'setup.py', 'package.json', 'Cargo.toml', 'go.mod'];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'docs') continue;

    const dirPath = path.join(root, entry.name);
    const hasMarker = markers.some(m => fs.existsSync(path.join(dirPath, m)));
    if (!hasMarker) continue;

    const pkg = { name: entry.name, type: 'package' };

    // Try to read description from README
    const readmePath = path.join(dirPath, 'README.md');
    if (fs.existsSync(readmePath)) {
      try {
        const raw = fs.readFileSync(readmePath, 'utf-8');
        const lines = raw.split('\n');
        let pastHeading = false;
        for (const line of lines) {
          if (!pastHeading && line.startsWith('#')) { pastHeading = true; continue; }
          if (pastHeading && line.trim()) {
            pkg.description = line.trim().substring(0, 200);
            break;
          }
        }
      } catch { /* skip */ }
    }

    packages.push(pkg);
  }

  return packages;
}

// ---------------------------------------------------------------------------
// Roadmap graph import
// ---------------------------------------------------------------------------

/**
 * Parse a roadmap-graph.html file (Cytoscape-based dependency graph).
 * Extracts the `nodes` and `edges` JS arrays from the <script> block.
 *
 * @param {string} htmlPath — absolute path to roadmap-graph.html
 * @returns {{ nodes: Array, edges: Array }}
 */
export function parseRoadmapGraph(htmlPath) {
  if (!fs.existsSync(htmlPath)) return { nodes: [], edges: [] };

  const raw = fs.readFileSync(htmlPath, 'utf-8');

  // Extract nodes array
  const nodesMatch = raw.match(/const\s+nodes\s*=\s*\[([\s\S]*?)\];\s*\n/);
  const edgesMatch = raw.match(/const\s+edges\s*=\s*\[([\s\S]*?)\];\s*\n/);

  let nodes = [];
  let edges = [];

  if (nodesMatch) {
    try {
      // Wrap in array brackets and evaluate as JSON-ish JS
      // The data uses single quotes and unquoted keys, so we need to eval
      nodes = Function(`"use strict"; return [${nodesMatch[1]}]`)();
    } catch (e) {
      console.error('[feature-scan] Failed to parse roadmap-graph nodes:', e.message);
    }
  }

  if (edgesMatch) {
    try {
      edges = Function(`"use strict"; return [${edgesMatch[1]}]`)();
    } catch (e) {
      console.error('[feature-scan] Failed to parse roadmap-graph edges:', e.message);
    }
  }

  return { nodes, edges };
}

/**
 * Find roadmap-graph.html in common locations within a project.
 */
function findRoadmapGraph() {
  const root = getTargetRoot();
  const candidates = [
    path.join(root, 'docs', 'roadmap-graph.html'),
    path.join(root, 'roadmap-graph.html'),
  ];

  // Search one level of subdirs for docs/roadmap-graph.html
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      candidates.push(path.join(root, entry.name, 'docs', 'roadmap-graph.html'));
      candidates.push(path.join(root, entry.name, 'roadmap-graph.html'));
    }
  } catch { /* skip */ }

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const GRAPH_STATUS_MAP = {
  planned: 'planned',
  parked: 'parked',
  partial: 'in_progress',
  open: 'in_progress',
  complete: 'complete',
};

const GRAPH_EDGE_MAP = {
  dep: 'blocks',
  concurrent: 'supports',
};

/**
 * Seed vision store from a roadmap-graph.html file.
 * Creates items for nodes and connections for edges.
 */
export function seedFromRoadmapGraph(store) {
  const graphPath = findRoadmapGraph();
  if (!graphPath) return { items: 0, connections: 0 };

  const { nodes, edges } = parseRoadmapGraph(graphPath);
  if (nodes.length === 0) return { items: 0, connections: 0 };

  console.log(`[vision] Roadmap graph: ${nodes.length} nodes, ${edges.length} edges from ${graphPath}`);

  const seeded = { items: 0, connections: 0 };
  const idMap = new Map(); // graphNodeId → visionItemId

  // Create/update items from nodes
  for (const node of nodes) {
    // Look for existing item by featureCode or title
    let item = Array.from(store.items.values()).find(
      i => i.lifecycle?.featureCode === node.id || i.title === node.id
    );

    const status = GRAPH_STATUS_MAP[node.status] || 'planned';
    const description = [
      node.name || '',
      node.desc || '',
      node.track ? `Track: ${node.track}` : '',
      node.priority ? `Priority: ${node.priority}` : '',
    ].filter(Boolean).join('\n');

    if (!item) {
      item = store.createItem({
        type: 'feature',
        title: node.id,
        description,
        status,
        phase: 'planning',
        confidence: status === 'complete' ? 3 : node.priority === 'high' ? 1 : 0,
      });
      try {
        store.updateLifecycle(item.id, { featureCode: node.id });
      } catch { /* skip */ }
      item = store.items.get(item.id);
      seeded.items++;
    } else {
      // Update description and status if richer
      const updates = {};
      if (description.length > (item.description || '').length) {
        updates.description = description;
      }
      if (status !== item.status && status !== 'planned') {
        updates.status = status;
      }
      if (Object.keys(updates).length > 0) {
        store.updateItem(item.id, updates);
      }
    }

    idMap.set(node.id, item.id);
  }

  // Create connections from edges
  for (const edge of edges) {
    const fromId = idMap.get(edge.source);
    const toId = idMap.get(edge.target);
    if (!fromId || !toId) continue;

    const type = GRAPH_EDGE_MAP[edge.type] || 'informs';

    // Check existing
    const exists = Array.from(store.connections.values()).some(
      c => (c.fromId === fromId && c.toId === toId) ||
           (c.fromId === toId && c.toId === fromId)
    );
    if (exists) continue;

    try {
      store.createConnection({ fromId, toId, type });
      seeded.connections++;
    } catch { /* skip */ }
  }

  if (seeded.items || seeded.connections) {
    console.log(`[vision] Roadmap graph: ${seeded.items} items, ${seeded.connections} connections seeded`);
  }
  return seeded;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

/**
 * Upsert feature folders into the vision store.
 * Now uses parsed status, confidence, phase, and creates connections
 * for related features.
 *
 * @param {Array} features — result of scanFeatures()
 * @param {object} store — VisionStore instance
 * @returns {{ features: number, updated: number, connections: number }}
 */
export function seedFeatures(features, store) {
  const seeded = { features: 0, updated: 0, connections: 0 };
  const featureItemMap = new Map(); // featureCode → itemId

  // First pass: create/update items
  for (const feature of features) {
    let featureItem = Array.from(store.items.values()).find(
      i => i.lifecycle?.featureCode === feature.name
    );

    if (!featureItem) {
      featureItem = store.createItem({
        type: 'feature',
        title: feature.name,
        description: feature.description || '',
        status: feature.status || 'planned',
        phase: feature.phase || 'planning',
        confidence: feature.confidence,
        files: feature.artifacts.map(a => `docs/features/${feature.name}/${a}`),
      });
      try {
        store.updateLifecycle(featureItem.id, { featureCode: feature.name, currentPhase: 'explore_design' });
      } catch { /* lifecycle method may not exist */ }
      featureItem = store.items.get(featureItem.id);
      seeded.features++;
    } else {
      // Update with richer data if we have it
      const updates = {};
      if (feature.description && feature.description !== featureItem.description) {
        updates.description = feature.description;
      }
      if (feature.status && feature.status !== featureItem.status) {
        updates.status = feature.status;
      }
      if (feature.confidence > (featureItem.confidence || 0)) {
        updates.confidence = feature.confidence;
      }
      const newFiles = feature.artifacts.map(a => `docs/features/${feature.name}/${a}`);
      if (JSON.stringify(newFiles) !== JSON.stringify(featureItem.files || [])) {
        updates.files = newFiles;
      }
      if (Object.keys(updates).length > 0) {
        store.updateItem(featureItem.id, updates);
        seeded.updated++;
      }
    }

    featureItemMap.set(feature.name, featureItem.id);
  }

  // Second pass: create connections for related features
  for (const feature of features) {
    const fromId = featureItemMap.get(feature.name);
    if (!fromId || !feature.relatedFeatures.length) continue;

    for (const relatedName of feature.relatedFeatures) {
      const toId = featureItemMap.get(relatedName);
      if (!toId) continue;

      // Check if connection already exists
      const exists = Array.from(store.connections.values()).some(
        c => (c.fromId === fromId && c.toId === toId) ||
             (c.fromId === toId && c.toId === fromId)
      );
      if (exists) continue;

      try {
        store.createConnection({ fromId, toId, type: 'informs' });
        seeded.connections++;
      } catch { /* skip duplicate or invalid */ }
    }
  }

  if (seeded.features || seeded.updated || seeded.connections) {
    console.log(`[vision] Feature scan: ${seeded.features} new, ${seeded.updated} updated, ${seeded.connections} connections`);
  }
  return seeded;
}

/**
 * Seed sub-packages as vision items (type: 'track').
 */
export function seedSubPackages(packages, store) {
  let created = 0;
  for (const pkg of packages) {
    // Check if already exists by title
    const exists = Array.from(store.items.values()).some(
      i => i.title === pkg.name && i.type === 'track'
    );
    if (exists) continue;

    store.createItem({
      type: 'track',
      title: pkg.name,
      description: pkg.description || '',
      status: 'in_progress',
      phase: 'implementation',
      confidence: 2,
    });
    created++;
  }
  if (created) console.log(`[vision] Sub-package scan: ${created} new`);
  return created;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Attach feature scan/seed REST routes to an Express app.
 */
export function attachFeatureScanRoutes(app, { store, scheduleBroadcast }) {
  app.get('/api/features/scan', (_req, res) => {
    try {
      const features = scanFeatures();
      const packages = scanSubPackages();
      res.json({ features, packages, count: features.length + packages.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/features/seed', (_req, res) => {
    try {
      const features = scanFeatures();
      const seeded = seedFeatures(features, store);
      const packages = scanSubPackages();
      const pkgCount = seedSubPackages(packages, store);
      scheduleBroadcast();
      res.json({ ok: true, ...seeded, packages: pkgCount });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
