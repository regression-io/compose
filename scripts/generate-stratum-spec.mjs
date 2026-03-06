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

// ---------------------------------------------------------------------------
// Detect revision edges (back-edges in the transition graph).
// A revision edge is A → B where B comes before A in phase order.
// These become compound steps with retries in the Stratum spec.
// ---------------------------------------------------------------------------

const phaseIndex = Object.fromEntries(contract.phases.map((p, i) => [p.id, i]));

// Map: target → [sources] for back-edges (revision loops)
const revisionEdges = {};
for (const [from, targets] of Object.entries(contract.transitions)) {
  for (const target of targets) {
    if (phaseIndex[from] > phaseIndex[target]) {
      if (!revisionEdges[target]) revisionEdges[target] = [];
      revisionEdges[target].push(from);
    }
  }
}

// Group phases into compound steps where revision edges exist.
// E.g., verification → blueprint means blueprint + verification become one compound step.
// A compound step includes the revision target and all phases up to (including) the revision source.
const compoundGroups = []; // [{ phases: [...], revisionFrom, revisionTo }]
const inCompound = new Set();

for (const [target, sources] of Object.entries(revisionEdges)) {
  for (const source of sources) {
    const startIdx = phaseIndex[target];
    const endIdx = phaseIndex[source];
    const grouped = contract.phases.slice(startIdx, endIdx + 1);
    compoundGroups.push({
      phases: grouped,
      revisionFrom: source,
      revisionTo: target,
    });
    for (const p of grouped) inCompound.add(p.id);
  }
}

// Contracts
w('contracts:');
w('  PhaseResult:');
w('    phase:     {type: string}');
w('    artifact:  {type: string}');
w('    outcome:   {type: string}');
w();

// Functions — one per phase, plus compound functions for revision loops
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

// Compound functions for revision loops
for (const group of compoundGroups) {
  const ids = group.phases.map(p => p.id);
  const compoundId = ids.join('_and_');
  const artifacts = group.phases.filter(p => p.artifact);
  w(`  ${compoundId}:`);
  w('    mode: compute');
  w(`    intent: >-`);
  w(`      Compound step: ${ids.join(' → ')} with revision loop`);
  w(`      (${group.revisionFrom} may loop back to ${group.revisionTo}).`);
  for (const phase of group.phases) {
    w(`      ${phase.id}: ${phase.description}.`);
  }
  w('    input:');
  w('      featureCode: {type: string}');
  w('      description: {type: string}');
  w('    output: PhaseResult');
  if (artifacts.length > 0) {
    w('    ensure:');
    for (const a of artifacts) {
      w(`      - "file_exists('docs/features/' + input.featureCode + '/${a.artifact}')"`);
    }
  }
  w(`    # Revision edge: ${group.revisionFrom} → ${group.revisionTo}`);
  w('    retries: 3');
  w();
}

// Flow — emit steps respecting compound groups
w('flows:');
w('  compose_feature:');
w('    input:');
w('      featureCode: {type: string}');
w('      description: {type: string}');
w('    output: PhaseResult');
w('    steps:');

let lastStepId = null;

for (let i = 0; i < contract.phases.length; i++) {
  const phase = contract.phases[i];

  // Check if this phase starts a compound group
  const group = compoundGroups.find(g => g.phases[0].id === phase.id);
  if (group) {
    const ids = group.phases.map(p => p.id);
    const compoundId = ids.join('_and_');

    // Find forward predecessors for the first phase in the group
    const forwardPreds = [];
    for (const [from, targets] of Object.entries(contract.transitions)) {
      if (targets.includes(phase.id) && phaseIndex[from] < i && !inCompound.has(from)) {
        forwardPreds.push(from);
      }
    }
    forwardPreds.sort((a, b) => phaseIndex[a] - phaseIndex[b]);

    w(`      - id: ${compoundId}`);
    w(`        function: ${compoundId}`);
    w(`        # Revision loop: ${group.revisionFrom} → ${group.revisionTo}`);
    w('        inputs:');
    w('          featureCode: "$.input.featureCode"');
    w('          description: "$.input.description"');
    const dep = forwardPreds.length > 0 ? forwardPreds[0] : lastStepId;
    if (dep) {
      w(`        depends_on: [${dep}]`);
    }
    w();

    lastStepId = compoundId;
    // Skip the remaining phases in this compound group
    i += group.phases.length - 1;
    continue;
  }

  // Skip phases that are interior to a compound group (handled above)
  if (inCompound.has(phase.id)) continue;

  // Regular step
  const forwardPreds = [];
  for (const [from, targets] of Object.entries(contract.transitions)) {
    if (targets.includes(phase.id) && phaseIndex[from] < i) {
      forwardPreds.push(from);
    }
  }
  forwardPreds.sort((a, b) => phaseIndex[a] - phaseIndex[b]);

  w(`      - id: ${phase.id}`);
  w(`        function: ${phase.id}`);
  w('        inputs:');
  w('          featureCode: "$.input.featureCode"');
  w('          description: "$.input.description"');

  // Remap depends_on: if a predecessor is inside a compound group, use the compound step ID
  let dep = forwardPreds.length > 0 ? forwardPreds[0] : null;
  if (dep && inCompound.has(dep)) {
    const ownerGroup = compoundGroups.find(g => g.phases.some(p => p.id === dep));
    if (ownerGroup) dep = ownerGroup.phases.map(p => p.id).join('_and_');
  }
  if (dep) {
    w(`        depends_on: [${dep}]`);
  } else if (lastStepId) {
    w(`        depends_on: [${lastStepId}]`);
  }
  w();

  lastStepId = phase.id;
}

writeFileSync(OUTPUT, lines.join('\n'));
console.log(`Generated ${OUTPUT}`);
