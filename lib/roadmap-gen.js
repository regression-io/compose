/**
 * roadmap-gen.js — Generate ROADMAP.md from feature.json files.
 *
 * feature.json is the source of truth. ROADMAP.md is a rendered view.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { listFeatures } from './feature-json.js';

const STATUS_ORDER = ['IN_PROGRESS', 'PARTIAL', 'PLANNED', 'COMPLETE', 'SUPERSEDED', 'PARKED'];

/**
 * Compute the aggregate status for a phase based on its features.
 */
function phaseStatus(features) {
  const statuses = new Set(features.map(f => f.status));
  if (statuses.size === 1) return [...statuses][0];
  if (statuses.has('IN_PROGRESS') || statuses.has('PARTIAL')) return 'PARTIAL';
  if (statuses.has('PLANNED') && statuses.has('COMPLETE')) return 'PARTIAL';
  return 'PLANNED';
}

/**
 * Generate ROADMAP.md content from feature.json files.
 *
 * @param {string} cwd - Project root
 * @param {object} [opts]
 * @param {string} [opts.featuresDir] - Relative path to features dir
 * @param {string} [opts.projectName] - Project name for header
 * @param {string} [opts.projectDescription] - Project description for header
 * @returns {string} - Generated ROADMAP.md content
 */
export function generateRoadmap(cwd, opts = {}) {
  const featuresDir = opts.featuresDir ?? 'docs/features';
  const features = listFeatures(cwd, featuresDir);

  // Read existing ROADMAP.md to preserve header/preamble
  const preamble = readPreamble(cwd, opts);

  // Group by phase
  const phases = new Map();
  const ungrouped = [];

  for (const f of features) {
    const phase = f.phase ?? null;
    if (!phase) {
      ungrouped.push(f);
      continue;
    }
    if (!phases.has(phase)) phases.set(phase, []);
    phases.get(phase).push(f);
  }

  const sections = [preamble.trimEnd()];

  // Sort phases by the minimum position of their features (preserves ROADMAP order)
  const sortedPhases = [...phases.entries()].sort((a, b) => {
    const minA = Math.min(...a[1].map(f => f.position ?? 999));
    const minB = Math.min(...b[1].map(f => f.position ?? 999));
    return minA - minB;
  });

  // Render each phase
  for (const [phase, phaseFeatures] of sortedPhases) {
    const status = phaseStatus(phaseFeatures);
    sections.push(renderPhase(phase, status, phaseFeatures));
  }

  // Render ungrouped features
  if (ungrouped.length > 0) {
    sections.push(renderPhase('Features', phaseStatus(ungrouped), ungrouped));
  }

  // Key documents section
  const keyDocs = buildKeyDocs(features, featuresDir);
  if (keyDocs) sections.push(keyDocs);

  return sections.join('\n\n---\n\n') + '\n';
}

/**
 * Read the preamble (everything before the first ## Phase/Feature section)
 * from an existing ROADMAP.md, or generate a default one.
 */
function readPreamble(cwd, opts) {
  const roadmapPath = join(cwd, 'ROADMAP.md');
  if (existsSync(roadmapPath)) {
    const text = readFileSync(roadmapPath, 'utf-8');
    // Find the first ## heading that looks like a phase/feature section
    const match = text.match(/^(---\s*\n\s*)?(?=## )/m);
    if (match) {
      const idx = text.indexOf(match[0]);
      const pre = text.slice(0, idx).trimEnd();
      if (pre.length > 0) return pre;
    }
  }

  // Default preamble
  const name = opts.projectName ?? 'Project';
  const desc = opts.projectDescription ?? '';
  const today = new Date().toISOString().slice(0, 10);
  return `# ${name} Roadmap

${desc ? desc + '\n\n' : ''}<!-- Generated from feature.json — do not edit manually -->
<!-- Run: compose roadmap generate -->

**Last updated:** ${today}

---

## Roadmap Conventions

- **Status:** \`PLANNED\` | \`IN_PROGRESS\` | \`PARTIAL\` | \`COMPLETE\` | \`SUPERSEDED\` | \`PARKED\`
- Items are numbered sequentially. Never reuse a number.
- Cross-reference stable IDs (e.g. \`FEAT-1\`) not section headings.`;
}

/**
 * Render a phase section with its feature table.
 */
function renderPhase(phaseName, status, features) {
  const lines = [`## ${phaseName} — ${status}`, ''];

  // Phase description from the first feature's phaseDescription if available
  const desc = features[0]?.phaseDescription;
  if (desc) {
    lines.push(desc, '');
  }

  // Determine table columns based on whether features have sub-items
  const hasSubItems = features.some(f => f.items && f.items.length > 0);

  if (hasSubItems) {
    // Expanded: one row per sub-item
    lines.push('| # | Feature | Item | Status |');
    lines.push('|---|---------|------|--------|');
    for (const f of features) {
      if (f.items && f.items.length > 0) {
        for (const item of f.items) {
          const num = item.position ?? '—';
          const desc = item.description ?? '';
          const st = item.status ?? f.status;
          lines.push(`| ${num} | ${f.code} | ${desc} | ${st} |`);
        }
      } else {
        const num = f.position ?? '—';
        lines.push(`| ${num} | ${f.code} | ${f.description} | ${f.status} |`);
      }
    }
  } else {
    // Simple: one row per feature
    lines.push('| # | Feature | Description | Status |');
    lines.push('|---|---------|-------------|--------|');
    for (const f of features) {
      const num = f.position ?? '—';
      const desc = f.description.length > 80 ? f.description.slice(0, 77) + '...' : f.description;
      lines.push(`| ${num} | ${f.code} | ${desc} | ${f.status} |`);
    }
  }

  // Exit criteria
  const exit = features[0]?.phaseExit;
  if (exit) {
    lines.push('', `**Exit:** ${exit}`);
  }

  // Links to design docs
  const docsLinks = features
    .filter(f => f.designDoc)
    .map(f => `See \`${f.designDoc}\` for ${f.code} design.`);
  if (docsLinks.length > 0) {
    lines.push('', docsLinks.join('\n'));
  }

  return lines.join('\n');
}

/**
 * Build a Key Documents section from features that have design docs.
 */
function buildKeyDocs(features, featuresDir) {
  const docs = features
    .filter(f => existsSync || f.designDoc) // always include if designDoc is set
    .filter(f => f.designDoc)
    .map(f => `| \`${f.designDoc}\` | ${f.code} design |`);

  if (docs.length === 0) return null;

  return [
    '## Key Documents',
    '',
    '| Document | What it is |',
    '|---|---|',
    ...docs,
  ].join('\n');
}

/**
 * Write the generated ROADMAP.md to disk.
 *
 * @param {string} cwd - Project root
 * @param {object} [opts]
 */
export function writeRoadmap(cwd, opts = {}) {
  const content = generateRoadmap(cwd, opts);
  const roadmapPath = join(cwd, 'ROADMAP.md');
  writeFileSync(roadmapPath, content);
  return roadmapPath;
}
