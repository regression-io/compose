/**
 * build-all.js — Orchestrate building all features from ROADMAP.md in dependency order.
 *
 * Parses the roadmap, builds a DAG, walks it topologically, and calls
 * runBuild for each feature. Serial execution; gates auto-approve.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { parseRoadmap, filterBuildable } from './roadmap-parser.js';
import { buildDag, topoSort } from './build-dag.js';
import { runBuild, deleteActiveBuild } from './build.js';

/**
 * @typedef {{ built: string[], failed: string[], skipped: string[], skippedComplete: string[] }} BuildAllResult
 */

/**
 * Run all buildable features from ROADMAP.md in dependency order.
 *
 * @param {object} opts
 * @param {string}   opts.cwd               - Project root (with .compose/)
 * @param {string}   [opts.workingDirectory] - Agent working directory (default: opts.cwd)
 * @param {boolean}  [opts.dryRun]          - Print order without executing
 * @param {string}   [opts.filter]          - Prefix to filter feature codes (e.g. "STRAT-COMP")
 * @param {string[]} [opts.features]        - Explicit list of feature codes to build
 * @param {string}   [opts.roadmapPath]     - Override ROADMAP.md path (for tests)
 * @param {Function} [opts.connectorFactory] - Pass through to runBuild (for tests)
 * @returns {Promise<BuildAllResult>}
 */
export async function runBuildAll(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const roadmapPath = opts.roadmapPath ?? join(cwd, 'ROADMAP.md');

  if (!existsSync(roadmapPath)) {
    throw new Error(`ROADMAP.md not found at ${roadmapPath}`);
  }

  const text = readFileSync(roadmapPath, 'utf-8');
  const allEntries = parseRoadmap(text);
  const buildable = filterBuildable(allEntries);
  const buildableSet = new Set(buildable.map(e => e.code));
  const descriptionMap = new Map(allEntries.map(e => [e.code, e.description]));

  // Build DAG from all entries (COMPLETE ones serve as dependency anchors)
  const dag = buildDag(allEntries);
  const order = topoSort(dag);

  // Apply filters
  if (opts.features && opts.features.length > 0) {
    // Explicit feature list — keep only those codes
    const explicit = new Set(opts.features.map(f => f.toUpperCase()));
    for (const code of [...buildableSet]) {
      if (!explicit.has(code.toUpperCase())) {
        buildableSet.delete(code);
      }
    }
  } else if (opts.filter) {
    // Prefix filter
    const prefix = opts.filter.toUpperCase();
    for (const code of [...buildableSet]) {
      if (!code.toUpperCase().startsWith(prefix)) {
        buildableSet.delete(code);
      }
    }
  }

  // Filter to only buildable codes, preserving topo order
  const buildOrder = order.filter(code => buildableSet.has(code));

  if (buildOrder.length === 0) {
    console.log('No buildable features found in ROADMAP.md.');
    console.log('All features are COMPLETE, SUPERSEDED, or PARKED.');
    return { built: [], failed: [], skipped: [], skippedComplete: [] };
  }

  console.log(`Build order (${buildOrder.length} features):`);
  for (let i = 0; i < buildOrder.length; i++) {
    const code = buildOrder[i];
    const desc = descriptionMap.get(code) ?? '';
    const short = desc.length > 60 ? desc.slice(0, 57) + '...' : desc;
    console.log(`  ${i + 1}. ${code}${short ? ` — ${short}` : ''}`);
  }
  console.log('');

  if (opts.dryRun) {
    return { built: [], failed: [], skipped: [], skippedComplete: [] };
  }

  // Build deps lookup for skip-on-failure
  const depsMap = new Map(dag.map(n => [n.code, new Set(n.deps)]));
  const dataDir = join(cwd, '.compose', 'data');

  const built = [];
  const failed = new Set();
  const blocked = new Set(); // features whose dep failed/was blocked (for transitive propagation)
  const skipped = [];
  const skippedComplete = allEntries
    .filter(e => !e.code.startsWith('_anon_') && e.status === 'COMPLETE')
    .map(e => e.code);

  for (const code of buildOrder) {
    // Check if any dependency failed or was blocked (transitive)
    const deps = depsMap.get(code) ?? new Set();
    const failedDep = [...deps].find(d => failed.has(d) || blocked.has(d));
    if (failedDep) {
      const reason = failed.has(failedDep) ? 'failed' : 'blocked';
      console.log(`\nSkipping ${code} — dependency ${failedDep} ${reason}`);
      skipped.push(code);
      blocked.add(code);
      continue;
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Building ${code} (${built.length + 1}/${buildOrder.length})`);
    console.log(`${'='.repeat(60)}\n`);

    try {
      const buildOpts = {
        cwd,
        description: descriptionMap.get(code) ?? code,
        gateOpts: { nonInteractive: true },
      };
      if (opts.workingDirectory) {
        buildOpts.workingDirectory = opts.workingDirectory;
      }
      if (opts.connectorFactory) {
        buildOpts.connectorFactory = opts.connectorFactory;
      }

      await runBuild(code, buildOpts);
      built.push(code);
      console.log(`\n  ✓ ${code} complete`);
    } catch (err) {
      console.error(`\n  ✗ ${code} failed: ${err.message}`);
      failed.add(code);
      // Ensure active-build lock is released
      try { deleteActiveBuild(dataDir); } catch { /* ignore */ }
    }
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('Build All Summary');
  console.log(`${'='.repeat(60)}`);
  if (built.length > 0) {
    console.log(`\n  Built (${built.length}):`);
    for (const code of built) console.log(`    ✓ ${code}`);
  }
  if (failed.size > 0) {
    console.log(`\n  Failed (${failed.size}):`);
    for (const code of failed) console.log(`    ✗ ${code}`);
  }
  if (skipped.length > 0) {
    console.log(`\n  Skipped — blocked by failure (${skipped.length}):`);
    for (const code of skipped) console.log(`    ⊘ ${code}`);
  }
  console.log('');

  return { built, failed: [...failed], skipped, skippedComplete };
}
