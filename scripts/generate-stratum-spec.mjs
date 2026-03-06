#!/usr/bin/env node
/**
 * generate-stratum-spec.mjs — Generates pipelines/compose_feature.stratum.yaml
 * from contracts/lifecycle.json.
 *
 * Usage: node scripts/generate-stratum-spec.mjs
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

// Contracts
w('contracts:');
w('  PhaseResult:');
w('    phase:     {type: string}');
w('    artifact:  {type: string}');
w('    outcome:   {type: string}');
w();

// Functions — one per phase
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
  w('    retries: 2');
  w();
}

// Flow
w('flows:');
w('  compose_feature:');
w('    input:');
w('      featureCode: {type: string}');
w('      description: {type: string}');
w('    output: PhaseResult');
w('    steps:');

// Derive depends_on from the contract transition graph.
// For each phase, find all forward predecessors (phases that transition to it,
// excluding back-edges like verification → blueprint). Then depends_on is
// the earliest predecessor — this preserves skip paths (e.g. explore_design
// can skip prd/architecture and go directly to blueprint).
const phaseIndex = Object.fromEntries(contract.phases.map((p, i) => [p.id, i]));

for (let i = 0; i < contract.phases.length; i++) {
  const phase = contract.phases[i];

  // Find forward predecessors: phases before this one that list it as a target
  const forwardPreds = [];
  for (const [from, targets] of Object.entries(contract.transitions)) {
    if (targets.includes(phase.id) && phaseIndex[from] < i) {
      forwardPreds.push(from);
    }
  }
  // Sort by phase order, take earliest (the mandatory predecessor all paths share)
  forwardPreds.sort((a, b) => phaseIndex[a] - phaseIndex[b]);

  w(`      - id: ${phase.id}`);
  w(`        function: ${phase.id}`);
  w('        inputs:');
  w('          featureCode: "$.input.featureCode"');
  w('          description: "$.input.description"');
  if (forwardPreds.length > 0) {
    w(`        depends_on: [${forwardPreds[0]}]`);
  }
  w();
}

writeFileSync(OUTPUT, lines.join('\n'));
console.log(`Generated ${OUTPUT}`);
