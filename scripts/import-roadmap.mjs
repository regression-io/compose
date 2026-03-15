#!/usr/bin/env node
/**
 * import-roadmap.mjs — Parse ROADMAP.md and import entries into the vision store.
 *
 * Usage: node scripts/import-roadmap.mjs [path-to-roadmap]
 * Defaults to ../ROADMAP.md (project root).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRoadmap } from '../lib/roadmap-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_BASE = process.env.API_BASE || 'http://localhost:3001';

const roadmapPath = process.argv[2] || path.resolve(__dirname, '../../ROADMAP.md');
const text = fs.readFileSync(roadmapPath, 'utf-8');
const entries = parseRoadmap(text);

console.log(`Parsed ${entries.length} entries from ${roadmapPath}`);

// Map roadmap statuses to vision store statuses
function mapStatus(s) {
  const upper = s.toUpperCase();
  if (upper === 'COMPLETE') return 'complete';
  if (upper === 'IN_PROGRESS') return 'in_progress';
  if (upper === 'PARTIAL') return 'in_progress';
  if (upper === 'SUPERSEDED') return 'killed';
  if (upper === 'PARKED') return 'blocked';
  if (upper === 'MANUAL GATE') return 'blocked';
  return 'planned';
}

// Valid phases: vision, specification, planning, implementation, verification, release
function mapPhase(phaseId) {
  const lower = phaseId.toLowerCase();
  if (lower.includes('bootstrap')) return 'vision';
  if (lower.includes('vision surface')) return 'vision';
  if (lower.includes('agent awareness')) return 'specification';
  if (lower.includes('session tracking')) return 'specification';
  if (lower.includes('agent connector')) return 'implementation';
  if (lower.includes('stratum sync')) return 'implementation';
  if (lower.includes('standalone')) return 'planning';
  if (lower.includes('lifecycle')) return 'implementation';
  if (lower.includes('project bootstrap') || lower.includes('init-1')) return 'implementation';
  if (lower.includes('strat-1')) return 'implementation';
  if (lower.includes('comp-ui')) return 'implementation';
  if (lower.includes('comp-rt')) return 'planning';
  if (lower.includes('strat-par')) return 'implementation';
  if (lower.includes('comp-bench')) return 'planning';
  if (lower.includes('dogfood')) return 'verification';
  return 'planning';
}

// Determine item type
function mapType(entry) {
  if (entry.code.startsWith('_anon_')) return 'task';
  if (entry.code.startsWith('STRAT-')) return 'feature';
  if (entry.code.startsWith('COMP-')) return 'feature';
  if (entry.code.startsWith('INIT-')) return 'feature';
  return 'task';
}

// First, get existing items to avoid duplicates
const existing = await fetch(`${API_BASE}/api/vision/items`).then(r => r.json());
const existingTitles = new Set((existing.items || []).map(i => i.title));

let created = 0;
let skipped = 0;

for (const entry of entries) {
  // Build a clean title
  const title = entry.code.startsWith('_anon_')
    ? entry.description.substring(0, 80)
    : `${entry.code}: ${entry.description.substring(0, 80)}`;

  if (existingTitles.has(title)) {
    skipped++;
    continue;
  }

  const item = {
    type: mapType(entry),
    title,
    description: `${entry.description}\n\nPhase: ${entry.phaseId}\nRoadmap status: ${entry.status}`,
    status: mapStatus(entry.status),
    phase: mapPhase(entry.phaseId),
    confidence: entry.status === 'COMPLETE' ? 3 : entry.status === 'PARTIAL' || entry.status === 'IN_PROGRESS' ? 2 : 0,
  };

  // Add featureCode for named features
  if (!entry.code.startsWith('_anon_')) {
    item.featureCode = entry.code;
  }

  try {
    const res = await fetch(`${API_BASE}/api/vision/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item),
    });

    if (res.ok) {
      created++;
      process.stdout.write('.');
    } else {
      const err = await res.text();
      console.error(`\nFailed to create "${title}": ${res.status} ${err}`);
    }
  } catch (err) {
    console.error(`\nFetch error for "${title}": ${err.message}`);
  }
}

console.log(`\n\nDone: ${created} created, ${skipped} skipped (already exist)`);
