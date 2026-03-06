/**
 * lifecycle-manager.js — Feature lifecycle state machine.
 *
 * Tracks which compose lifecycle phase a feature is in, with
 * forward-only transitions, history, reconciliation, and terminal ops.
 */

import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { evaluatePolicy, VALID_GATE_OUTCOMES } from './policy-engine.js';
import { ArtifactManager, ARTIFACT_SCHEMAS } from './artifact-manager.js';

// Re-export constants from shared module (preserves existing import paths)
export { PHASES, TERMINAL, SKIPPABLE, TRANSITIONS, PHASE_ARTIFACTS, ITERATION_DEFAULTS } from './lifecycle-constants.js';
import { PHASES, TERMINAL, SKIPPABLE, TRANSITIONS, PHASE_ARTIFACTS, ITERATION_DEFAULTS } from './lifecycle-constants.js';

// ---------------------------------------------------------------------------
// LifecycleManager
// ---------------------------------------------------------------------------

export class LifecycleManager {
  #store;
  #featureRoot;
  #artifactManager;
  #settingsStore;

  constructor(store, featureRoot, settingsStore) {
    this.#store = store;
    this.#featureRoot = featureRoot;
    this.#artifactManager = new ArtifactManager(featureRoot);
    this.#settingsStore = settingsStore || null;
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
      policyLog: [],
      pendingGate: null,
      policyOverrides: null,
      iterationState: null,
    };

    this.#store.updateLifecycle(itemId, lifecycle);
    return lifecycle;
  }

  advancePhase(itemId, targetPhase, outcome) {
    const { item, lifecycle } = this.#getLifecycle(itemId);
    const from = lifecycle.currentPhase;

    if (lifecycle.pendingGate) {
      throw new Error(`Cannot advance: gate ${lifecycle.pendingGate} is pending for item ${itemId}`);
    }

    if (from === 'execute' && lifecycle.iterationState && !lifecycle.iterationState.completedAt) {
      throw new Error(`Cannot leave execute phase: iteration loop ${lifecycle.iterationState.loopId} is still active`);
    }

    const policy = evaluatePolicy(targetPhase, lifecycle.policyOverrides, this.#settingsStore?.get()?.policies);

    if (policy === 'gate') {
      return this.#createGate(itemId, 'advance', { targetPhase, outcome }, from, targetPhase);
    }

    const result = this.#executeAdvance(itemId, targetPhase, outcome);

    if (policy === 'flag') {
      const flagId = this.#recordPolicyEntry(itemId, 'flag', from, targetPhase);
      return { ...result, flagged: true, flagId };
    }

    this.#recordPolicyEntry(itemId, 'skip', from, targetPhase);
    return result;
  }

  skipPhase(itemId, targetPhase, reason) {
    const { item, lifecycle } = this.#getLifecycle(itemId);
    const from = lifecycle.currentPhase;

    if (lifecycle.pendingGate) {
      throw new Error(`Cannot skip: gate ${lifecycle.pendingGate} is pending for item ${itemId}`);
    }

    if (from === 'execute' && lifecycle.iterationState && !lifecycle.iterationState.completedAt) {
      throw new Error(`Cannot leave execute phase: iteration loop ${lifecycle.iterationState.loopId} is still active`);
    }

    const policy = evaluatePolicy(targetPhase, lifecycle.policyOverrides, this.#settingsStore?.get()?.policies);

    if (policy === 'gate') {
      return this.#createGate(itemId, 'skip', { targetPhase, reason }, from, targetPhase);
    }

    const result = this.#executeSkip(itemId, targetPhase, reason);

    if (policy === 'flag') {
      const flagId = this.#recordPolicyEntry(itemId, 'flag', from, targetPhase);
      return { ...result, flagged: true, flagId };
    }

    this.#recordPolicyEntry(itemId, 'skip', from, targetPhase);
    return result;
  }

  killFeature(itemId, reason) {
    const { item, lifecycle } = this.#getLifecycle(itemId);
    const from = lifecycle.currentPhase;

    if (TERMINAL.has(from)) {
      throw new Error(`Cannot kill from terminal state: ${from}`);
    }

    // Resolve any pending gate before killing
    if (lifecycle.pendingGate) {
      const gateId = lifecycle.pendingGate;
      this.#store.resolveGate(gateId, { outcome: 'killed', comment: reason || 'Feature killed' });
      this.#resolveGatePolicyEntry(itemId, gateId, 'killed', reason || 'Feature killed');
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

  approveGate(gateId, { outcome, comment }) {
    const gate = this.#store.gates.get(gateId);
    if (!gate) throw new Error(`Gate not found: ${gateId}`);
    if (gate.status !== 'pending') throw new Error(`Gate ${gateId} is not pending (status: ${gate.status})`);
    if (!VALID_GATE_OUTCOMES.includes(outcome)) {
      throw new Error(`Invalid gate outcome: ${outcome} (must be ${VALID_GATE_OUTCOMES.join(', ')})`);
    }

    const { lifecycle } = this.#getLifecycle(gate.itemId);
    if (lifecycle.pendingGate !== gateId) {
      throw new Error(`Gate ${gateId} is not the active gate for item ${gate.itemId} (active: ${lifecycle.pendingGate})`);
    }

    if (outcome === 'approved') {
      let result;
      if (gate.operation === 'advance') {
        result = this.#executeAdvance(gate.itemId, gate.operationArgs.targetPhase, gate.operationArgs.outcome);
      } else if (gate.operation === 'skip') {
        result = this.#executeSkip(gate.itemId, gate.operationArgs.targetPhase, gate.operationArgs.reason);
      } else {
        throw new Error(`Unknown gate operation: ${gate.operation}`);
      }

      this.#store.resolveGate(gateId, { outcome, comment });
      this.#resolveGatePolicyEntry(gate.itemId, gateId, outcome, comment);
      return { ...result, gateId, gateOutcome: outcome };
    }

    if (outcome === 'revised') {
      this.#store.resolveGate(gateId, { outcome, comment });
      this.#resolveGatePolicyEntry(gate.itemId, gateId, outcome, comment);
      return { gateId, gateOutcome: outcome, comment };
    }

    if (outcome === 'killed') {
      this.#store.resolveGate(gateId, { outcome, comment });
      this.#resolveGatePolicyEntry(gate.itemId, gateId, outcome, comment);
      const killResult = this.killFeature(gate.itemId, comment || 'Killed at gate');
      return { ...killResult, gateId, gateOutcome: outcome };
    }
  }

  // ── Iteration loop management ───────────────────────────────────────────

  startIterationLoop(itemId, loopType, { maxIterations } = {}) {
    const { lifecycle } = this.#getLifecycle(itemId);
    if (lifecycle.currentPhase !== 'execute') {
      throw new Error(`Cannot start iteration loop outside execute phase (current: ${lifecycle.currentPhase})`);
    }
    if (lifecycle.iterationState && !lifecycle.iterationState.completedAt) {
      throw new Error(`Iteration loop already active: ${lifecycle.iterationState.loopId}`);
    }
    const defaults = ITERATION_DEFAULTS[loopType];
    if (!defaults) throw new Error(`Unknown loop type: ${loopType}`);

    const settingsMax = this.#settingsStore?.get()?.iterations?.[loopType]?.maxIterations;
    const loopId = `iter-${uuidv4()}`;
    lifecycle.iterationState = {
      loopType,
      loopId,
      phase: 'execute',
      count: 0,
      maxIterations: maxIterations || settingsMax || defaults.maxIterations,
      startedAt: new Date().toISOString(),
      completedAt: null,
      outcome: null,
      iterations: [],
    };
    this.#store.updateLifecycle(itemId, lifecycle);
    return { loopId, loopType, maxIterations: lifecycle.iterationState.maxIterations };
  }

  reportIterationResult(itemId, { clean, passing, summary, findings, failures }) {
    const { lifecycle } = this.#getLifecycle(itemId);
    const state = lifecycle.iterationState;
    if (!state || state.completedAt) {
      throw new Error('No active iteration loop');
    }

    const n = state.count + 1;
    const now = new Date().toISOString();

    const exitCriteriaMet = state.loopType === 'review' ? (clean === true) : (passing === true);

    state.iterations.push({
      n,
      startedAt: state.iterations.length > 0 ? state.iterations[state.iterations.length - 1].completedAt || now : state.startedAt,
      completedAt: now,
      result: { clean, passing, summary, findings, failures },
    });
    state.count = n;

    let continueLoop = true;
    if (exitCriteriaMet) {
      state.completedAt = now;
      state.outcome = 'clean';
      continueLoop = false;
    } else if (n >= state.maxIterations) {
      state.completedAt = now;
      state.outcome = 'max_reached';
      continueLoop = false;
    }

    this.#store.updateLifecycle(itemId, lifecycle);

    return {
      loopId: state.loopId,
      loopType: state.loopType,
      count: n,
      maxIterations: state.maxIterations,
      exitCriteriaMet,
      continueLoop,
      outcome: state.outcome,
    };
  }

  getIterationStatus(itemId) {
    const { lifecycle } = this.#getLifecycle(itemId);
    return lifecycle.iterationState || null;
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

  // ── Policy private methods ─────────────────────────────────────────────

  #executeAdvance(itemId, targetPhase, outcome) {
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

  #executeSkip(itemId, targetPhase, reason) {
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

  #createGate(itemId, operation, operationArgs, fromPhase, toPhase) {
    const { lifecycle } = this.#getLifecycle(itemId);

    if (lifecycle.pendingGate) {
      throw new Error(`Gate already pending for item ${itemId}: ${lifecycle.pendingGate}`);
    }

    const gateId = `gate-${uuidv4()}`;

    let artifactAssessment = null;
    const artifactName = PHASE_ARTIFACTS[fromPhase];
    if (artifactName && ARTIFACT_SCHEMAS[artifactName]) {
      try {
        artifactAssessment = this.#artifactManager.assessOne(lifecycle.featureCode, artifactName);
      } catch {
        artifactAssessment = null;
      }
    }

    const gate = {
      id: gateId,
      itemId,
      operation,
      operationArgs,
      fromPhase,
      toPhase,
      status: 'pending',
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedBy: null,
      outcome: null,
      comment: null,
      artifactAssessment,
    };

    this.#store.createGate(gate);

    lifecycle.pendingGate = gateId;
    this.#store.updateLifecycle(itemId, lifecycle);

    this.#recordPolicyEntry(itemId, 'gate', fromPhase, toPhase, gateId);

    return { status: 'pending_approval', gateId, fromPhase, toPhase, operation };
  }

  #recordPolicyEntry(itemId, type, fromPhase, toPhase, gateId) {
    const { lifecycle } = this.#getLifecycle(itemId);
    if (!lifecycle.policyLog) lifecycle.policyLog = [];
    const entry = {
      type,
      id: gateId || uuidv4(),
      itemId,
      fromPhase,
      toPhase,
      createdAt: new Date().toISOString(),
    };
    lifecycle.policyLog.push(entry);
    this.#store.updateLifecycle(itemId, lifecycle);
    return entry.id;
  }

  #resolveGatePolicyEntry(itemId, gateId, outcome, comment) {
    const { lifecycle } = this.#getLifecycle(itemId);
    if (lifecycle.policyLog) {
      const entry = lifecycle.policyLog.find(e => e.id === gateId && e.type === 'gate');
      if (entry) {
        entry.resolvedAt = new Date().toISOString();
        entry.outcome = outcome;
        entry.comment = comment || null;
      }
    }
    lifecycle.pendingGate = null;
    this.#store.updateLifecycle(itemId, lifecycle);
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
