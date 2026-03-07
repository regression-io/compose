/**
 * VisionWriter — Atomic read-modify-write for vision-state.json
 *
 * Provides step-to-item mapping, feature item lookup (supporting both
 * seedFeatures and lifecycle-manager conventions), and gate management.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EMPTY_STATE = () => ({ items: [], connections: [], gates: [] });

export class VisionWriter {
  /**
   * @param {string} dataDir  Path to the data directory (e.g. `.compose/data/`)
   */
  constructor(dataDir) {
    this.filePath = path.join(dataDir, 'vision-state.json');
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Read and parse vision-state.json.
   * Returns empty state if the file doesn't exist or contains invalid JSON.
   */
  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      // Ensure all expected arrays exist
      parsed.items = parsed.items || [];
      parsed.connections = parsed.connections || [];
      parsed.gates = parsed.gates || [];
      return parsed;
    } catch {
      return EMPTY_STATE();
    }
  }

  /**
   * Atomically write state by writing to a temp file then renaming.
   * Atomic on POSIX — rename within the same directory is a single inode op.
   *
   * @param {object} state
   */
  _atomicWrite(state) {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `vision-state.json.tmp.${crypto.randomUUID()}`);
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }

  // ---------------------------------------------------------------------------
  // Feature item lookup
  // ---------------------------------------------------------------------------

  /**
   * Transitional lookup — searches items for a feature code using both
   * the seedFeatures convention (top-level featureCode) and the
   * lifecycle-manager convention (lifecycle.featureCode).
   *
   * @param {string} featureCode  e.g. 'FEAT-1'
   * @returns {object|null}
   */
  findFeatureItem(featureCode) {
    const state = this._load();
    return state.items.find(
      (item) =>
        item.featureCode === `feature:${featureCode}` ||
        item.lifecycle?.featureCode === featureCode,
    ) || null;
  }

  /**
   * Find or create a feature item.
   *
   * @param {string} featureCode  e.g. 'FEAT-1'
   * @param {string} [title]      Human-readable title; defaults to featureCode
   * @returns {string}            The item id (existing or newly created)
   */
  ensureFeatureItem(featureCode, title) {
    const existing = this.findFeatureItem(featureCode);
    if (existing) return existing.id;

    const state = this._load();
    const item = {
      id: crypto.randomUUID(),
      type: 'feature',
      title: title || featureCode,
      description: '',
      status: 'planned',
      phase: 'planning',
      featureCode: `feature:${featureCode}`,
      slug: featureCode.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      confidence: null,
      createdAt: new Date().toISOString(),
    };
    state.items.push(item);
    this._atomicWrite(state);
    return item.id;
  }

  // ---------------------------------------------------------------------------
  // Item mutations
  // ---------------------------------------------------------------------------

  /**
   * Update an item's status field.
   *
   * @param {string} itemId
   * @param {string} status
   */
  updateItemStatus(itemId, status) {
    const state = this._load();
    const item = state.items.find((i) => i.id === itemId);
    if (item) {
      item.status = status;
      this._atomicWrite(state);
    }
  }

  /**
   * Update an item's lifecycle phase.
   *
   * @param {string} itemId
   * @param {string} stepId
   */
  updateItemPhase(itemId, stepId) {
    const state = this._load();
    const item = state.items.find((i) => i.id === itemId);
    if (item) {
      item.lifecycle = item.lifecycle || {};
      item.lifecycle.currentPhase = stepId;
      this._atomicWrite(state);
    }
  }

  // ---------------------------------------------------------------------------
  // Gate management
  // ---------------------------------------------------------------------------

  /**
   * Create a gate entry tied to a flow step and vision item.
   *
   * @param {string} flowId
   * @param {string} stepId
   * @param {string} itemId
   * @returns {string} The gate id (`flowId:stepId`)
   */
  createGate(flowId, stepId, itemId) {
    const state = this._load();
    state.gates = state.gates || [];
    const gate = {
      id: `${flowId}:${stepId}`,
      flowId,
      stepId,
      itemId,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    state.gates.push(gate);
    this._atomicWrite(state);
    return gate.id;
  }

  /**
   * Resolve a gate with an outcome.
   *
   * @param {string} gateId
   * @param {string} outcome  e.g. 'approve', 'reject'
   */
  resolveGate(gateId, outcome) {
    const state = this._load();
    const gate = (state.gates || []).find((g) => g.id === gateId);
    if (gate) {
      gate.status = 'resolved';
      gate.outcome = outcome;
      gate.resolvedAt = new Date().toISOString();
      this._atomicWrite(state);
    }
  }
}
