/**
 * lifecycle-contract.test.js — Validates contracts/lifecycle.json and verifies
 * that lifecycle-constants.js derives identical values from it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(readFileSync(resolve(REPO_ROOT, 'contracts', 'lifecycle.json'), 'utf8'));

const {
  PHASES, TERMINAL, SKIPPABLE, TRANSITIONS, PHASE_ARTIFACTS,
  ITERATION_DEFAULTS, DEFAULT_POLICIES, VALID_GATE_OUTCOMES, CONTRACT,
} = await import(`${REPO_ROOT}/server/lifecycle-constants.js`);

// Also verify policy-engine re-exports match
const policyEngine = await import(`${REPO_ROOT}/server/policy-engine.js`);

// Load generated Stratum spec for parity check
let stratumSpec;
try {
  const specYaml = readFileSync(resolve(REPO_ROOT, 'pipelines', 'compose_feature.stratum.yaml'), 'utf8');
  // Simple YAML parser — extract step IDs and depends_on from the spec
  const steps = [];
  let currentStep = null;
  for (const line of specYaml.split('\n')) {
    const idMatch = line.match(/^\s+- id:\s+(\S+)/);
    if (idMatch) {
      currentStep = { id: idMatch[1], depends_on: [] };
      steps.push(currentStep);
    }
    const depMatch = line.match(/^\s+depends_on:\s+\[([^\]]*)\]/);
    if (depMatch && currentStep) {
      currentStep.depends_on = depMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  stratumSpec = { steps };
} catch { stratumSpec = null; }

// ---------------------------------------------------------------------------
// Contract schema validation
// ---------------------------------------------------------------------------

describe('contract schema', () => {
  test('has required top-level fields', () => {
    assert.ok(contract.version);
    assert.ok(Array.isArray(contract.phases));
    assert.ok(contract.transitions);
    assert.ok(Array.isArray(contract.terminal));
    assert.ok(Array.isArray(contract.gateOutcomes));
    assert.ok(Array.isArray(contract.policyModes));
    assert.ok(contract.iterationDefaults);
  });

  test('all phase IDs are valid identifiers', () => {
    for (const phase of contract.phases) {
      assert.ok(phase.id, 'phase must have an id');
      assert.match(phase.id, /^[a-z_]+$/, `phase id "${phase.id}" should be lowercase snake_case`);
      assert.ok(phase.label, `phase "${phase.id}" must have a label`);
      assert.ok(phase.description, `phase "${phase.id}" must have a description`);
      assert.equal(typeof phase.skippable, 'boolean', `phase "${phase.id}" skippable must be boolean`);
    }
  });

  test('phase IDs are unique', () => {
    const ids = contract.phases.map(p => p.id);
    assert.equal(ids.length, new Set(ids).size, 'duplicate phase IDs found');
  });

  test('transition targets only reference defined phases', () => {
    const phaseIds = new Set(contract.phases.map(p => p.id));
    for (const [from, targets] of Object.entries(contract.transitions)) {
      assert.ok(phaseIds.has(from), `transition source "${from}" is not a defined phase`);
      for (const target of targets) {
        assert.ok(phaseIds.has(target), `transition target "${target}" from "${from}" is not a defined phase`);
      }
    }
  });

  test('every phase has a transition entry', () => {
    for (const phase of contract.phases) {
      assert.ok(phase.id in contract.transitions, `phase "${phase.id}" missing from transitions`);
    }
  });

  test('terminal states are not in the phase list', () => {
    const phaseIds = new Set(contract.phases.map(p => p.id));
    for (const t of contract.terminal) {
      assert.ok(!phaseIds.has(t), `terminal state "${t}" should not be in phases`);
    }
  });

  test('artifact filenames are unique', () => {
    const artifacts = contract.phases.filter(p => p.artifact).map(p => p.artifact);
    assert.equal(artifacts.length, new Set(artifacts).size, 'duplicate artifact filenames');
  });

  test('defaultPolicy values are valid policy modes', () => {
    const validModes = new Set(contract.policyModes);
    for (const phase of contract.phases) {
      if (phase.defaultPolicy !== null) {
        assert.ok(validModes.has(phase.defaultPolicy),
          `phase "${phase.id}" has invalid defaultPolicy: ${phase.defaultPolicy}`);
      }
    }
  });

  test('skippable phases have skip as default policy', () => {
    for (const phase of contract.phases) {
      if (phase.skippable && phase.defaultPolicy) {
        assert.equal(phase.defaultPolicy, 'skip',
          `skippable phase "${phase.id}" should default to skip, got ${phase.defaultPolicy}`);
      }
    }
  });

  test('every phase has a non-null defaultPolicy', () => {
    for (const phase of contract.phases) {
      assert.ok(phase.defaultPolicy !== null && phase.defaultPolicy !== undefined,
        `phase "${phase.id}" must have a non-null defaultPolicy`);
    }
  });
});

// ---------------------------------------------------------------------------
// Derivation parity — constants match contract
// ---------------------------------------------------------------------------

describe('derivation parity', () => {
  test('PHASES matches contract phase IDs in order', () => {
    assert.deepEqual(PHASES, contract.phases.map(p => p.id));
  });

  test('TERMINAL matches contract terminal states', () => {
    assert.deepEqual([...TERMINAL].sort(), [...contract.terminal].sort());
  });

  test('SKIPPABLE matches contract skippable phases', () => {
    const expected = new Set(contract.phases.filter(p => p.skippable).map(p => p.id));
    assert.deepEqual([...SKIPPABLE].sort(), [...expected].sort());
  });

  test('TRANSITIONS matches contract transitions', () => {
    assert.deepEqual(TRANSITIONS, contract.transitions);
  });

  test('PHASE_ARTIFACTS matches contract artifacts', () => {
    const expected = {};
    for (const p of contract.phases) {
      if (p.artifact) expected[p.id] = p.artifact;
    }
    assert.deepEqual(PHASE_ARTIFACTS, expected);
  });

  test('ITERATION_DEFAULTS matches contract', () => {
    assert.deepEqual(ITERATION_DEFAULTS, contract.iterationDefaults);
  });

  test('DEFAULT_POLICIES matches contract defaultPolicy values', () => {
    const expected = {};
    for (const p of contract.phases) {
      if (p.defaultPolicy) expected[p.id] = p.defaultPolicy;
    }
    assert.deepEqual(DEFAULT_POLICIES, expected);
  });

  test('VALID_GATE_OUTCOMES matches contract', () => {
    assert.deepEqual(VALID_GATE_OUTCOMES, contract.gateOutcomes);
  });

  test('CONTRACT export is the raw contract object', () => {
    assert.equal(CONTRACT.version, contract.version);
    assert.equal(CONTRACT.phases.length, contract.phases.length);
  });
});

// ---------------------------------------------------------------------------
// Policy engine re-export parity
// ---------------------------------------------------------------------------

describe('policy-engine re-exports', () => {
  test('DEFAULT_POLICIES from policy-engine matches lifecycle-constants', () => {
    assert.deepEqual(policyEngine.DEFAULT_POLICIES, DEFAULT_POLICIES);
  });

  test('VALID_GATE_OUTCOMES from policy-engine matches lifecycle-constants', () => {
    assert.deepEqual(policyEngine.VALID_GATE_OUTCOMES, VALID_GATE_OUTCOMES);
  });

  test('evaluatePolicy still works with derived defaults', () => {
    assert.equal(policyEngine.evaluatePolicy('explore_design'), 'gate');
    assert.equal(policyEngine.evaluatePolicy('blueprint'), 'gate');
    assert.equal(policyEngine.evaluatePolicy('prd'), 'skip');
    assert.equal(policyEngine.evaluatePolicy('execute'), 'flag');
  });

  test('evaluatePolicy validates against contract policyModes', () => {
    assert.throws(
      () => policyEngine.evaluatePolicy('blueprint', { blueprint: 'bogus' }),
      /Invalid policy mode/,
    );
  });
});

// ---------------------------------------------------------------------------
// Stratum spec parity — generated YAML matches contract
// ---------------------------------------------------------------------------

describe('Stratum spec parity', () => {
  test('spec file exists and was parsed', () => {
    assert.ok(stratumSpec, 'compose_feature.stratum.yaml should exist and be parseable');
    assert.ok(stratumSpec.steps.length > 0, 'spec should have steps');
  });

  test('every contract phase is represented in a spec step', () => {
    // Phases may be individual steps or grouped into compound steps
    const coveredPhases = new Set();
    for (const step of stratumSpec.steps) {
      // Compound step IDs use _and_ to join phase IDs
      for (const part of step.id.split('_and_')) {
        coveredPhases.add(part);
      }
    }
    for (const phase of contract.phases) {
      assert.ok(coveredPhases.has(phase.id),
        `phase "${phase.id}" not covered by any spec step`);
    }
  });

  test('revision edges are modeled as compound steps', () => {
    const phaseIdx = Object.fromEntries(contract.phases.map((p, i) => [p.id, i]));

    // Find all revision edges in contract
    const revisionEdges = [];
    for (const [from, targets] of Object.entries(contract.transitions)) {
      for (const target of targets) {
        if (phaseIdx[from] > phaseIdx[target]) {
          revisionEdges.push({ from, to: target });
        }
      }
    }

    assert.ok(revisionEdges.length > 0, 'contract should have at least one revision edge');

    // Each revision edge should produce a compound step containing both phases
    for (const edge of revisionEdges) {
      const compoundStep = stratumSpec.steps.find(s => {
        if (!s.id.includes('_and_')) return false;
        const parts = s.id.split('_and_');
        return parts.includes(edge.to) && parts.includes(edge.from);
      });
      assert.ok(compoundStep,
        `revision edge ${edge.from} → ${edge.to} should be a compound step, ` +
        `found steps: ${stratumSpec.steps.map(s => s.id).join(', ')}`);
    }
  });

  test('forward skip paths are preserved in depends_on', () => {
    const phaseIdx = Object.fromEntries(contract.phases.map((p, i) => [p.id, i]));

    // Phases reachable directly from explore_design (skip paths)
    const skipTargets = contract.transitions.explore_design || [];

    for (const target of skipTargets) {
      // Find the step that covers this target phase
      const step = stratumSpec.steps.find(s =>
        s.id === target || s.id.split('_and_').includes(target)
      );
      if (!step) continue;

      // This step should depend on explore_design (preserving the skip path)
      if (step.depends_on.length > 0) {
        assert.equal(step.depends_on[0], 'explore_design',
          `step "${step.id}" (covering "${target}") should depend on explore_design ` +
          `to preserve skip path, got [${step.depends_on}]`);
      }
    }
  });

  test('post-execute skip path preserved (execute → docs)', () => {
    const docsStep = stratumSpec.steps.find(s => s.id === 'docs');
    assert.ok(docsStep, 'docs step should exist');
    assert.deepEqual(docsStep.depends_on, ['execute'],
      'docs should depend on execute (skipping report)');
  });
});
