/**
 * import.js — Scan an existing project and generate a structured analysis.
 *
 * Produces docs/discovery/project-analysis.md which is automatically
 * picked up by compose new/build as context for agents.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';

import { runAndNormalize } from './result-normalizer.js';
import { ClaudeSDKConnector } from '../server/connectors/claude-sdk-connector.js';

// ---------------------------------------------------------------------------
// File tree scanner
// ---------------------------------------------------------------------------

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.compose', 'dist', 'build', 'coverage',
  '.next', '.nuxt', '__pycache__', '.venv', 'venv', 'target',
  '.cache', '.parcel-cache', '.turbo',
]);

const IGNORE_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  '.DS_Store', 'Thumbs.db',
]);

function walkTree(dir, root, maxDepth = 4, depth = 0) {
  const entries = [];
  if (depth > maxDepth) return entries;

  let items;
  try { items = readdirSync(dir); } catch { return entries; }

  for (const item of items) {
    if (IGNORE_DIRS.has(item) || IGNORE_FILES.has(item)) continue;
    if (item.startsWith('.') && depth === 0 && item !== '.env.example') continue;

    const fullPath = join(dir, item);
    const relPath = relative(root, fullPath);
    let stat;
    try { stat = statSync(fullPath); } catch { continue; }

    if (stat.isDirectory()) {
      entries.push({ path: relPath, type: 'dir' });
      entries.push(...walkTree(fullPath, root, maxDepth, depth + 1));
    } else {
      entries.push({ path: relPath, type: 'file', size: stat.size });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Key file reader
// ---------------------------------------------------------------------------

const KEY_FILES = [
  'README.md', 'README', 'readme.md',
  'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Gemfile',
  'Makefile', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  '.env.example',
  'tsconfig.json', 'vite.config.js', 'vite.config.ts',
  'CLAUDE.md', 'AGENTS.md',
  'ROADMAP.md', 'CHANGELOG.md',
];

const KEY_DIRS = ['docs', 'src', 'lib', 'bin', 'test', 'tests', 'spec', 'api', 'scripts'];

function readKeyFiles(cwd, maxContentSize = 8000) {
  const files = {};

  // Read known key files
  for (const name of KEY_FILES) {
    const p = join(cwd, name);
    if (existsSync(p)) {
      const content = readFileSync(p, 'utf-8');
      files[name] = content.length > maxContentSize
        ? content.slice(0, maxContentSize) + '\n...(truncated)'
        : content;
    }
  }

  // Read top-level files in key directories (just filenames + first lines)
  for (const dir of KEY_DIRS) {
    const dirPath = join(cwd, dir);
    if (!existsSync(dirPath)) continue;
    try {
      const items = readdirSync(dirPath);
      for (const item of items.slice(0, 30)) {
        const p = join(dirPath, item);
        let stat;
        try { stat = statSync(p); } catch { continue; }
        if (!stat.isFile()) continue;

        const relPath = join(dir, item);
        const content = readFileSync(p, 'utf-8');
        // Include first 40 lines to give structure context
        const preview = content.split('\n').slice(0, 40).join('\n');
        files[relPath] = preview.length < content.length
          ? preview + '\n...(truncated)'
          : preview;
      }
    } catch { /* skip */ }
  }

  return files;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Scan a project and generate a structured analysis.
 *
 * @param {object} opts
 * @param {string}   [opts.cwd]              - Working directory
 * @param {Function} [opts.connectorFactory] - Override connector (for testing)
 */
export async function runImport(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const getConnector = opts.connectorFactory ?? (() => new ClaudeSDKConnector({ cwd }));

  console.log('Scanning project...\n');

  // 1. Build file tree
  const tree = walkTree(cwd, cwd);
  const fileCount = tree.filter(e => e.type === 'file').length;
  const dirCount = tree.filter(e => e.type === 'dir').length;
  console.log(`  ${fileCount} files, ${dirCount} directories`);

  // 2. Read key files
  const keyFiles = readKeyFiles(cwd);
  console.log(`  ${Object.keys(keyFiles).length} key files read`);

  // 3. Build tree string
  const treeStr = tree.map(e => {
    if (e.type === 'dir') return `${e.path}/`;
    const kb = (e.size / 1024).toFixed(1);
    return `${e.path} (${kb}kb)`;
  }).join('\n');

  // 4. Build key file contents
  const keyFileStr = Object.entries(keyFiles)
    .map(([name, content]) => `--- ${name} ---\n${content}`)
    .join('\n\n');

  // 5. Dispatch to claude for analysis
  console.log('\nAnalyzing...\n');

  const prompt = `You are analyzing an existing software project to produce a structured analysis document.

## Project file tree
\`\`\`
${treeStr}
\`\`\`

## Key file contents
${keyFileStr}

## Task

Write a comprehensive project analysis to \`docs/discovery/project-analysis.md\` with these sections:

### 1. Project Overview
- What this project does (inferred from code, README, configs)
- Primary language/framework/runtime
- Current maturity (prototype, MVP, production)

### 2. Architecture
- High-level component map (what talks to what)
- Key directories and what they contain
- Entry points (CLI, server, library exports)
- External dependencies and what they're used for

### 3. Feature Inventory
For each distinct feature/capability already built:
- Feature name and suggested code (e.g., AUTH-1, API-2)
- Status: working, partial, stub
- Key files involved
- Test coverage: tested, untested, partially tested

### 4. Patterns & Conventions
- Code style (ESM/CJS, naming, file organization)
- Testing approach (framework, fixtures, mocks)
- Build/deploy setup
- Configuration approach

### 5. Gaps & Opportunities
- Missing tests
- Missing docs
- Incomplete features
- Technical debt

### 6. Suggested Roadmap
Based on the analysis, suggest a phased roadmap with feature codes.
Use the format:
| # | Feature | Item | Status |
|---|---------|------|--------|
| 1 | CODE-1  | Description | COMPLETE/PARTIAL/PLANNED |

Write the full analysis to \`docs/discovery/project-analysis.md\`.

Return JSON: { "summary": string, "features": [{"code": string, "name": string, "status": string}], "artifact": "docs/discovery/project-analysis.md" }`;

  const connector = getConnector();
  const { result } = await runAndNormalize(connector, prompt, {
    output_contract: 'AnalysisResult',
    output_fields: [
      { name: 'summary', type: 'string' },
      { name: 'features', type: 'array' },
      { name: 'artifact', type: 'string' },
    ],
  });

  // 6. Verify the analysis was written
  const analysisPath = join(cwd, 'docs', 'discovery', 'project-analysis.md');
  if (!existsSync(analysisPath)) {
    // Agent may not have written it — write a fallback from the result
    mkdirSync(join(cwd, 'docs', 'discovery'), { recursive: true });
    if (result?.summary) {
      writeFileSync(analysisPath, `# Project Analysis\n\n${result.summary}\n`);
      console.log(`Wrote fallback analysis to ${relative(cwd, analysisPath)}`);
    }
  } else {
    console.log(`Analysis written to ${relative(cwd, analysisPath)}`);
  }

  // 7. Report features found
  if (result?.features?.length) {
    console.log(`\nFeatures identified:`);
    for (const f of result.features) {
      const status = f.status ?? 'unknown';
      console.log(`  ${f.code.padEnd(10)} ${f.name} (${status})`);
    }
  }

  console.log('\nNext steps:');
  console.log('  compose new <name> "intent"     # kickoff with this context');
  console.log('  compose feature <CODE> "desc"    # add a specific feature');
  console.log('  compose build <CODE>             # build a feature');
}
