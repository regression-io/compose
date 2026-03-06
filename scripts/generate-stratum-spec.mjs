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

// Steps are linear — each depends on the previous phase in order.
// Transition graph includes backward edges (verification → blueprint) for
// revision loops, but Stratum steps are sequential. Revision is handled by
// retries, not circular depends_on.
for (let i = 0; i < contract.phases.length; i++) {
  const phase = contract.phases[i];
  w(`      - id: ${phase.id}`);
  w(`        function: ${phase.id}`);
  w('        inputs:');
  w('          featureCode: "$.input.featureCode"');
  w('          description: "$.input.description"');
  if (i > 0) {
    w(`        depends_on: [${contract.phases[i - 1].id}]`);
  }
  w();
}

writeFileSync(OUTPUT, lines.join('\n'));
console.log(`Generated ${OUTPUT}`);
