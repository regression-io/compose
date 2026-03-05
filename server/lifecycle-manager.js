/**
 * lifecycle-manager.js — Feature lifecycle state machine.
 *
 * Tracks which compose lifecycle phase a feature is in, with
 * forward-only transitions, history, reconciliation, and terminal ops.
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants (exported for tests)
// ---------------------------------------------------------------------------

export const PHASES = [
  'explore_design', 'prd', 'architecture', 'blueprint',
  'verification', 'plan', 'execute', 'report', 'docs', 'ship',
];

export const TERMINAL = new Set(['complete', 'killed']);
export const SKIPPABLE = new Set(['prd', 'architecture', 'report']);

export const TRANSITIONS = {
  explore_design: ['prd', 'architecture', 'blueprint'],
  prd:            ['architecture', 'blueprint'],
  architecture:   ['blueprint'],
  blueprint:      ['verification'],
  verification:   ['plan', 'blueprint'],  // blueprint = revision loop
  plan:           ['execute'],
  execute:        ['report', 'docs'],
  report:         ['docs'],
  docs:           ['ship'],
  ship:           [],  // terminal via completeFeature()
};

export const PHASE_ARTIFACTS = {
  explore_design: 'design.md',
  prd:            'prd.md',
  architecture:   'architecture.md',
  blueprint:      'blueprint.md',
  plan:           'plan.md',
  report:         'report.md',
};

// ---------------------------------------------------------------------------
// LifecycleManager
// ---------------------------------------------------------------------------

export class LifecycleManager {
  #store;
  #featureRoot;

  constructor(store, featureRoot) {
    this.#store = store;
    this.#featureRoot = featureRoot;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  startLifecycle(itemId, featureCode) {
    const item = this.#getItem(itemId);
    if (item.lifecycle) throw new Error(`Item ${itemId} already has a lifecycle`);

    const now = new Date().toISOString();
    const artifacts = this.#scanArtifacts(featureCode);
    const lifecycle = {
      currentPhase: 'explore_design',
      featureCode,
      phaseHistory: [
        { phase: 'explore_design', enteredAt: now, exitedAt: null, outcome: null },
      ],
      artifacts,
      startedAt: now,
      completedAt: null,
      killedAt: null,
      killReason: null,
      reconcileWarning: null,
    };

    this.#store.updateLifecycle(itemId, lifecycle);
    return lifecycle;
  }

  advancePhase(itemId, targetPhase, outcome) {
    const { item, lifecycle } = this.#getLifecycle(itemId);
    const from = lifecycle.currentPhase;

    if (TERMINAL.has(from)) {
      throw new Error(`Cannot advance from terminal state: ${from}`);
    }
    const valid = TRANSITIONS[from];
    if (!valid || !valid.includes(targetPhase)) {
      throw new Error(`Invalid transition: ${from} → ${targetPhase}`);
    }
    if (outcome !== 'approved' && outcome !== 'revised') {
      throw new Error(`Invalid outcome: ${outcome} (must be approved or revised)`);
    }
    if (outcome === 'revised') {
      const fromIdx = PHASES.indexOf(from);
      const toIdx = PHASES.indexOf(targetPhase);
      if (toIdx >= fromIdx) {
        throw new Error(`'revised' outcome requires backward transition, but ${from} → ${targetPhase} is forward`);
      }
    }

    const now = new Date().toISOString();
    this.#closeCurrentEntry(lifecycle, outcome, now);
    lifecycle.phaseHistory.push({ phase: targetPhase, enteredAt: now, exitedAt: null, outcome: null });
    lifecycle.currentPhase = targetPhase;

    // Update artifact for the new phase
    const artifactName = PHASE_ARTIFACTS[targetPhase];
    if (artifactName) {
      lifecycle.artifacts[artifactName] = fs.existsSync(
        path.join(this.#featureRoot, lifecycle.featureCode, artifactName),
      );
    }

    lifecycle.reconcileWarning = null;
    this.#store.updateLifecycle(itemId, lifecycle);
    return { from, to: targetPhase, outcome };
  }

  skipPhase(itemId, targetPhase, reason) {
    const { item, lifecycle } = this.#getLifecycle(itemId);
    const from = lifecycle.currentPhase;

    if (TERMINAL.has(from)) {
      throw new Error(`Cannot skip from terminal state: ${from}`);
    }
    if (!SKIPPABLE.has(from)) {
      throw new Error(`Phase ${from} is not skippable`);
    }
    const valid = TRANSITIONS[from];
    if (!valid || !valid.includes(targetPhase)) {
      throw new Error(`Invalid transition: ${from} → ${targetPhase}`);
    }

    const now = new Date().toISOString();
    this.#closeCurrentEntry(lifecycle, 'skipped', now, reason);
    lifecycle.phaseHistory.push({ phase: targetPhase, enteredAt: now, exitedAt: null, outcome: null });
    lifecycle.currentPhase = targetPhase;
    this.#store.updateLifecycle(itemId, lifecycle);
    return { from, to: targetPhase, outcome: 'skipped', reason };
  }

  killFeature(itemId, reason) {
    const { item, lifecycle } = this.#getLifecycle(itemId);
    const from = lifecycle.currentPhase;

    if (TERMINAL.has(from)) {
      throw new Error(`Cannot kill from terminal state: ${from}`);
    }

    const now = new Date().toISOString();
    this.#closeCurrentEntry(lifecycle, 'killed', now);
    lifecycle.currentPhase = 'killed';
    lifecycle.killedAt = now;
    lifecycle.killReason = reason;
    this.#store.updateLifecycle(itemId, lifecycle);
    this.#store.updateItem(itemId, { status: 'killed' });
    return { phase: from, reason };
  }

  completeFeature(itemId) {
    const { item, lifecycle } = this.#getLifecycle(itemId);

    if (lifecycle.currentPhase !== 'ship') {
      throw new Error(`Can only complete from ship phase, currently in: ${lifecycle.currentPhase}`);
    }

    const now = new Date().toISOString();
    this.#closeCurrentEntry(lifecycle, 'approved', now);
    lifecycle.currentPhase = 'complete';
    lifecycle.completedAt = now;
    this.#store.updateLifecycle(itemId, lifecycle);
    this.#store.updateItem(itemId, { status: 'complete' });
    return { completedAt: now };
  }

  getPhase(itemId) {
    const { lifecycle } = this.#getLifecycle(itemId);
    return lifecycle.currentPhase;
  }

  getHistory(itemId) {
    const { lifecycle } = this.#getLifecycle(itemId);
    return lifecycle.phaseHistory;
  }

  reconcile(itemId) {
    const { item, lifecycle } = this.#getLifecycle(itemId);

    // Terminal states are immutable — only update artifacts map
    if (TERMINAL.has(lifecycle.currentPhase)) {
      lifecycle.artifacts = this.#scanArtifacts(lifecycle.featureCode);
      this.#store.updateLifecycle(itemId, lifecycle);
      return {
        currentPhase: lifecycle.currentPhase,
        artifacts: lifecycle.artifacts,
        reconcileWarning: lifecycle.reconcileWarning,
      };
    }

    // Scan disk for artifacts
    const scanned = this.#scanArtifacts(lifecycle.featureCode);
    lifecycle.artifacts = scanned;

    // Infer phase from latest artifact on disk
    const inferredPhase = this.#inferPhaseFromArtifacts(scanned);
    const currentIdx = PHASES.indexOf(lifecycle.currentPhase);
    const inferredIdx = inferredPhase ? PHASES.indexOf(inferredPhase) : -1;

    if (inferredIdx > currentIdx) {
      // Forward reconciliation — advance through intermediate phases
      const now = new Date().toISOString();
      this.#closeCurrentEntry(lifecycle, 'reconciled', now);

      // Record reconciled entries for intermediate phases
      for (let i = currentIdx + 1; i < inferredIdx; i++) {
        lifecycle.phaseHistory.push({
          phase: PHASES[i], enteredAt: now, exitedAt: now, outcome: 'reconciled',
        });
      }
      // Open entry for the inferred phase
      lifecycle.phaseHistory.push({ phase: inferredPhase, enteredAt: now, exitedAt: null, outcome: null });
      lifecycle.currentPhase = inferredPhase;
      lifecycle.reconcileWarning = null;
    } else if (inferredIdx < currentIdx) {
      // Backward (or no artifacts at all) — flag but don't regress
      const missingArtifacts = [];
      for (const [phase, file] of Object.entries(PHASE_ARTIFACTS)) {
        if (PHASES.indexOf(phase) <= currentIdx && !scanned[file]) {
          missingArtifacts.push(file);
        }
      }
      lifecycle.reconcileWarning = {
        currentPhase: lifecycle.currentPhase,
        inferredPhase: inferredPhase || 'none',
        missingArtifacts,
        detectedAt: new Date().toISOString(),
      };
    } else {
      // Equal — clear warning
      lifecycle.reconcileWarning = null;
    }

    this.#store.updateLifecycle(itemId, lifecycle);
    return {
      currentPhase: lifecycle.currentPhase,
      artifacts: lifecycle.artifacts,
      reconcileWarning: lifecycle.reconcileWarning,
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  #getItem(itemId) {
    const item = this.#store.items.get(itemId);
    if (!item) throw new Error(`Item not found: ${itemId}`);
    return item;
  }

  #getLifecycle(itemId) {
    const item = this.#getItem(itemId);
    if (!item.lifecycle) throw new Error(`No lifecycle on item: ${itemId}`);
    return { item, lifecycle: item.lifecycle };
  }

  #scanArtifacts(featureCode) {
    const dir = path.join(this.#featureRoot, featureCode);
    const result = {};
    for (const file of Object.values(PHASE_ARTIFACTS)) {
      result[file] = fs.existsSync(path.join(dir, file));
    }
    return result;
  }

  #inferPhaseFromArtifacts(artifacts) {
    let latest = null;
    for (const [phase, file] of Object.entries(PHASE_ARTIFACTS)) {
      if (artifacts[file]) latest = phase;
    }
    return latest;
  }

  #closeCurrentEntry(lifecycle, outcome, now, reason) {
    const open = lifecycle.phaseHistory.findLast(e => e.exitedAt === null);
    if (open) {
      open.exitedAt = now;
      open.outcome = outcome;
      if (reason !== undefined) open.reason = reason;
    }
  }
}
