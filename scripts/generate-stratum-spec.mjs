#!/usr/bin/env node
/**
 * generate-stratum-spec.mjs — Generates pipelines/compose_feature.stratum.yaml
 * from contracts/lifecycle.json.
 *
 * Usage: node scripts/generate-stratum-spec.mjs
 *
 * Design constraint: the generated spec has exactly one function and one step
 * per contract phase, with step id and function id equal to the phase id.
 * Revision edges (back-edges in the transition graph) are documented as
 * comments — they are handled at runtime, not modeled in the DAG.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const contract = JSON.parse(readFileSync(resolve(ROOT, 'contracts', 'lifecycle.json'), 'utf8'));
const OUTPUT = resolve(ROOT, 'pipelines', 'compose_feature.stratum.yaml');

const lines = [];
const w = (s = '') => lines.push(s);

w('version: "0.1"');
w();
w('# compose_feature pipeline');
w(`# Generated from contracts/lifecycle.json v${contract.version}`);
w('# Do not edit manually — regenerate with: node scripts/generate-stratum-spec.mjs');
w();

// ---------------------------------------------------------------------------
// Detect revision edges for documentation purposes.
// A revision edge is A → B where B comes before A in phase order.
// These are handled at runtime, not in the Stratum DAG.
// ---------------------------------------------------------------------------

const phaseIndex = Object.fromEntries(contract.phases.map((p, i) => [p.id, i]));

const revisionEdges = []; // [{ from, to }]
for (const [from, targets] of Object.entries(contract.transitions)) {
  for (const target of targets) {
    if (phaseIndex[from] > phaseIndex[target]) {
      revisionEdges.push({ from, to: target });
    }
  }
}

// Contracts
w('contracts:');
w('  PhaseResult:');
w('    phase:     {type: string}');
w('    artifact:  {type: string}');
w('    outcome:   {type: string}');
w();

// Functions — exactly one per phase
w('functions:');
for (const phase of contract.phases) {
  w(`  ${phase.id}:`);
  w('    mode: compute');
  w(`    intent: "${phase.description}"`);
  w('    input:');
  w('      featureCode: {type: string}');
  w('      description: {type: string}');
  w('    output: PhaseResult');
  if (phase.artifact) {
    w('    ensure:');
    w(`      - "file_exists('docs/features/' + input.featureCode + '/${phase.artifact}')"`);
  }
  // Phases that are revision targets get extra retries for the loop
  const isRevisionTarget = revisionEdges.some(e => e.to === phase.id);
  w(`    retries: ${isRevisionTarget ? 3 : 2}`);
  w();
}

// Flow — exactly one step per phase, depends_on from forward transitions
w('flows:');
w('  compose_feature:');
w('    input:');
w('      featureCode: {type: string}');
w('      description: {type: string}');
w('    output: PhaseResult');

if (revisionEdges.length > 0) {
  w('    # Revision edges (handled at runtime, not in DAG):');
  for (const edge of revisionEdges) {
    w(`    #   ${edge.from} → ${edge.to}`);
  }
}

w('    steps:');

for (let i = 0; i < contract.phases.length; i++) {
  const phase = contract.phases[i];

  // Find forward predecessors: phases that transition TO this phase
  // and appear earlier in phase order (forward edges only)
  const forwardPreds = [];
  for (const [from, targets] of Object.entries(contract.transitions)) {
    if (targets.includes(phase.id) && phaseIndex[from] < i) {
      forwardPreds.push(from);
    }
  }
  // Sort by phase index — use earliest predecessor to preserve skip paths
  forwardPreds.sort((a, b) => phaseIndex[a] - phaseIndex[b]);

  w(`      - id: ${phase.id}`);
  w(`        function: ${phase.id}`);
  w('        inputs:');
  w('          featureCode: "$.input.featureCode"');
  w('          description: "$.input.description"');

  if (forwardPreds.length > 0) {
    w(`        depends_on: [${forwardPreds[0]}]`);
  }

  // Annotate revision edges involving this step
  const revFrom = revisionEdges.filter(e => e.from === phase.id);
  const revTo = revisionEdges.filter(e => e.to === phase.id);
  if (revFrom.length > 0) {
    for (const edge of revFrom) {
      w(`        # Revision: may loop back to ${edge.to}`);
    }
  }
  if (revTo.length > 0) {
    for (const edge of revTo) {
      w(`        # Revision target: ${edge.from} may loop back here`);
    }
  }
  w();
}

writeFileSync(OUTPUT, lines.join('\n'));
console.log(`Generated ${OUTPUT}`);
