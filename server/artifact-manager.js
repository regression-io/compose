/**
 * artifact-manager.js — Artifact schema definitions, quality assessment,
 * scaffolding, and template loading.
 *
 * Stateless — reads files and schemas, computes signals, returns data.
 * No persistence beyond what the lifecycle manager already stores.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE_ARTIFACTS } from './lifecycle-constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, 'artifact-templates');

// ---------------------------------------------------------------------------
// Artifact schemas
// ---------------------------------------------------------------------------

export const ARTIFACT_SCHEMAS = {
  'design.md': {
    requiredSections: ['Problem', 'Goal'],
    optionalSections: ['Related Documents', 'Decision \\d+', 'Files', 'Open Questions', 'Resolved Questions'],
    minWordCount: 200,
  },
  'prd.md': {
    requiredSections: ['Problem Statement', 'Goals & Non-Goals', 'Requirements'],
    optionalSections: ['Success Criteria', 'User Stories', 'Constraints', 'Open Questions'],
    minWordCount: 300,
  },
  'architecture.md': {
    requiredSections: ['Problem', 'Proposals'],
    optionalSections: ['Trade-offs', 'Decision', 'Component Diagram'],
    minWordCount: 200,
  },
  'blueprint.md': {
    requiredSections: ['File Plan'],
    optionalSections: ['Corrections Table'],
    minWordCount: 300,
  },
  'plan.md': {
    requiredSections: ['Task Order', 'Task 1'],
    optionalSections: ['Files Summary'],
    minWordCount: 150,
  },
  'report.md': {
    requiredSections: ['Summary', 'Files Changed'],
    optionalSections: ['Delivered vs Planned', 'Architecture Deviations', 'Key Decisions', 'Test Coverage', 'Known Issues', 'Lessons Learned'],
    minWordCount: 200,
  },
};

// ---------------------------------------------------------------------------
// Startup invariant: schema keys must match PHASE_ARTIFACTS values
// ---------------------------------------------------------------------------

const schemaKeys = new Set(Object.keys(ARTIFACT_SCHEMAS));
const artifactValues = new Set(Object.values(PHASE_ARTIFACTS));
if (schemaKeys.size !== artifactValues.size || [...schemaKeys].some(k => !artifactValues.has(k))) {
  throw new Error('ARTIFACT_SCHEMAS keys and PHASE_ARTIFACTS values are out of sync');
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function _validateFeatureCode(featureCode) {
  if (!featureCode || !/^[A-Za-z0-9_-]+$/.test(featureCode)) {
    throw new Error(`Invalid featureCode: ${featureCode}`);
  }
}

function _featurePath(featureRoot, featureCode) {
  _validateFeatureCode(featureCode);
  const realRoot = fs.realpathSync(featureRoot);
  const candidate = path.resolve(realRoot, featureCode);
  if (!candidate.startsWith(realRoot + path.sep) && candidate !== realRoot) {
    throw new Error(`Path escapes feature root: ${featureCode}`);
  }
  // Tier 2: if candidate exists, verify real path
  if (fs.existsSync(candidate)) {
    const realCandidate = fs.realpathSync(candidate);
    if (!realCandidate.startsWith(realRoot + path.sep) && realCandidate !== realRoot) {
      throw new Error(`Symlink escapes feature root: ${featureCode}`);
    }
  }
  return candidate;
}

function _extractSections(markdown) {
  const headings = [];
  for (const line of markdown.split('\n')) {
    const m = line.match(/^#{1,4}\s+(.+)$/);
    if (m) {
      let text = m[1].trim();
      // Strip trailing punctuation (with optional leading/trailing whitespace)
      text = text.replace(/\s*[:—–]+\s*$/, '');
      headings.push(text);
    }
  }
  return headings;
}

function _matchPattern(heading, pattern) {
  if (pattern.includes('\\d+')) {
    const re = new RegExp(`^${pattern}$`, 'i');
    return re.test(heading);
  }
  return heading.toLowerCase() === pattern.toLowerCase();
}

function _matchSections(foundHeadings, schema) {
  const found = [];
  const missing = [];
  for (const pattern of schema.requiredSections) {
    if (foundHeadings.some(h => _matchPattern(h, pattern))) {
      found.push(pattern);
    } else {
      missing.push(pattern);
    }
  }

  const optional = [];
  for (const pattern of schema.optionalSections) {
    if (foundHeadings.some(h => _matchPattern(h, pattern))) {
      optional.push(pattern);
    }
  }

  return { found, missing, optional };
}

// ---------------------------------------------------------------------------
// ArtifactManager
// ---------------------------------------------------------------------------

export class ArtifactManager {
  #featureRoot;

  constructor(featureRoot) {
    this.#featureRoot = featureRoot;
  }

  assess(featureCode) {
    const artifacts = {};
    for (const filename of Object.keys(ARTIFACT_SCHEMAS)) {
      artifacts[filename] = this.assessOne(featureCode, filename);
    }
    return { artifacts };
  }

  assessOne(featureCode, filename) {
    if (!ARTIFACT_SCHEMAS[filename]) {
      throw new Error(`Unknown artifact: ${filename}`);
    }
    const dir = _featurePath(this.#featureRoot, featureCode);
    const filePath = path.join(dir, filename);
    const schema = ARTIFACT_SCHEMAS[filename];

    // Check file-level symlink escape
    if (fs.existsSync(filePath)) {
      const realFile = fs.realpathSync(filePath);
      const realRoot = fs.realpathSync(this.#featureRoot);
      if (!realFile.startsWith(realRoot + path.sep)) {
        throw new Error(`Symlink escapes feature root: ${filename}`);
      }
    }

    if (!fs.existsSync(filePath)) {
      return {
        exists: false,
        wordCount: 0,
        meetsMinWordCount: false,
        sections: { found: [], missing: [...schema.requiredSections], optional: [] },
        completeness: 0,
        lastModified: null,
      };
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const wordCount = content.split(/\s+/).filter(Boolean).length;
    const headings = _extractSections(content);
    const sections = _matchSections(headings, schema);
    const completeness = schema.requiredSections.length > 0
      ? sections.found.length / schema.requiredSections.length
      : 1.0;
    const lastModified = fs.statSync(filePath).mtime.toISOString();

    return {
      exists: true,
      wordCount,
      meetsMinWordCount: wordCount >= schema.minWordCount,
      sections,
      completeness,
      lastModified,
    };
  }

  scaffold(featureCode, options) {
    const dir = _featurePath(this.#featureRoot, featureCode);
    const created = [];
    const skipped = [];

    // Create directories
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });

    for (const filename of Object.keys(ARTIFACT_SCHEMAS)) {
      if (options?.only && !options.only.includes(filename)) continue;

      const filePath = path.join(dir, filename);
      if (fs.existsSync(filePath)) {
        skipped.push(filename);
      } else {
        const template = this.getTemplate(filename);
        fs.writeFileSync(filePath, template, 'utf-8');
        created.push(filename);
      }
    }

    return { created, skipped };
  }

  getTemplate(artifactName) {
    if (!ARTIFACT_SCHEMAS[artifactName]) {
      throw new Error(`Unknown artifact: ${artifactName}`);
    }
    const filePath = path.join(TEMPLATES_DIR, artifactName);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Template not found: ${artifactName}`);
    }
    return fs.readFileSync(filePath, 'utf-8');
  }

  getSchema(artifactName) {
    return ARTIFACT_SCHEMAS[artifactName] || null;
  }
}
