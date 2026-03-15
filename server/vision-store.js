/**
 * Vision Store — JSON-file-backed storage for vision surface items and connections.
 * Loads from disk on startup, saves after every mutation.
 */

import { v4 as uuidv4 } from 'uuid';
import fs from 'node:fs';
import path from 'node:path';

export const VALID_TYPES = ['feature', 'track', 'idea', 'decision', 'question', 'thread', 'artifact', 'task', 'spec', 'evaluation'];
export const VALID_STATUSES = ['planned', 'ready', 'in_progress', 'review', 'complete', 'blocked', 'parked', 'killed'];
export const VALID_CONNECTION_TYPES = ['informs', 'blocks', 'supports', 'contradicts', 'implements'];
export const VALID_PHASES = ['vision', 'specification', 'planning', 'implementation', 'verification', 'release'];

import { getDataDir as getDefaultDataDir } from './project-root.js';

const DATA_FILE = path.join(getDefaultDataDir(), 'vision-state.json');

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export class VisionStore {
  constructor(dataDir) {
    this._dataDir = dataDir || getDefaultDataDir();
    this._dataFile = dataDir ? path.join(dataDir, 'vision-state.json') : DATA_FILE;
    this.items = new Map();
    this.connections = new Map();
    this.gates = new Map();
    this._load();
  }

  /**
   * Re-target the store at a different data directory.
   * Clears all in-memory state and reloads from the new location.
   */
  reloadFrom(dataDir) {
    this._dataDir = dataDir;
    this._dataFile = path.join(dataDir, 'vision-state.json');
    this.items.clear();
    this.connections.clear();
    this.gates.clear();
    this._load();
  }

  /** Load state from disk */
  _load() {
    try {
      const raw = fs.readFileSync(this._dataFile, 'utf-8');
      const data = JSON.parse(raw);
      let migrated = false;
      if (Array.isArray(data.items)) {
        for (const item of data.items) {
          // Migration: legacy featureCode → lifecycle.featureCode
          if (item.featureCode && item.featureCode.startsWith('feature:') && !item.lifecycle?.featureCode) {
            const bare = item.featureCode.replace(/^feature:/, '');
            item.lifecycle = item.lifecycle || {};
            item.lifecycle.featureCode = bare;
            delete item.featureCode;
            migrated = true;
          }
          if (!item.slug && item.title) item.slug = slugify(item.title);
          if (!item.files) item.files = [];
          this.items.set(item.id, item);
        }
      }
      if (Array.isArray(data.connections)) {
        for (const conn of data.connections) this.connections.set(conn.id, conn);
      }
      if (Array.isArray(data.gates)) {
        for (const gate of data.gates) {
          // Migration: normalize legacy gate outcomes
          if (gate.outcome) {
            const map = { approved: 'approve', killed: 'kill', revised: 'revise' };
            if (map[gate.outcome]) { gate.outcome = map[gate.outcome]; migrated = true; }
          }
          this.gates.set(gate.id, gate);
        }
      }
      if (migrated) this._save();
      console.log(`[vision] Loaded ${this.items.size} items, ${this.connections.size} connections from ${this._dataFile}`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log('[vision] No saved state found, starting fresh');
      } else {
        console.error('[vision] Failed to load state, starting fresh:', err.message);
      }
    }
  }

  /** Save state to disk atomically (temp file + rename) */
  _save() {
    try {
      fs.mkdirSync(this._dataDir, { recursive: true });
      const data = JSON.stringify(this.getState(), null, 2) + '\n';
      const tmp = path.join(this._dataDir, `vision-state.json.tmp.${Date.now()}`);
      fs.writeFileSync(tmp, data, 'utf-8');
      fs.renameSync(tmp, this._dataFile);
    } catch (err) {
      console.error('[vision] Failed to save state:', err.message);
    }
  }

  /** Get full state snapshot */
  getState() {
    return {
      items: Array.from(this.items.values()),
      connections: Array.from(this.connections.values()),
      gates: Array.from(this.gates.values()),
    };
  }

  /** Create a new vision item */
  createItem({ type, title, description = '', confidence = 0, status = 'planned', phase, position, parentId, files, priority, assignedTo, governance, featureCode }) {
    if (!VALID_TYPES.includes(type)) throw new Error(`Invalid type: ${type}`);
    if (!title) throw new Error('title required');
    if (!VALID_STATUSES.includes(status)) throw new Error(`Invalid status: ${status}`);
    if (confidence < 0 || confidence > 4) throw new Error('confidence must be 0-4');
    if (phase && !VALID_PHASES.includes(phase)) throw new Error(`Invalid phase: ${phase}`);
    if (parentId && !this.items.has(parentId)) throw new Error(`Parent not found: ${parentId}`);

    const now = new Date().toISOString();
    const item = {
      id: uuidv4(),
      type,
      title,
      description,
      confidence,
      status,
      phase: phase || null,
      parentId: parentId || null,
      files: Array.isArray(files) ? files : [],
      priority: priority || null,
      assignedTo: assignedTo || null,
      governance: governance || null,
      featureCode: featureCode || null,
      slug: slugify(title),
      position: position || { x: 100 + Math.random() * 400, y: 100 + Math.random() * 300 },
      createdAt: now,
      updatedAt: now,
    };

    this.items.set(item.id, item);
    this._save();
    return item;
  }

  /** Update an existing item (partial) */
  updateItem(id, updates) {
    const item = this.items.get(id);
    if (!item) throw new Error(`Item not found: ${id}`);

    if (updates.type !== undefined && !VALID_TYPES.includes(updates.type)) {
      throw new Error(`Invalid type: ${updates.type}`);
    }
    if (updates.status !== undefined && !VALID_STATUSES.includes(updates.status)) {
      throw new Error(`Invalid status: ${updates.status}`);
    }
    if (updates.confidence !== undefined && (updates.confidence < 0 || updates.confidence > 4)) {
      throw new Error('confidence must be 0-4');
    }
    if (updates.phase !== undefined && updates.phase !== null && !VALID_PHASES.includes(updates.phase)) {
      throw new Error(`Invalid phase: ${updates.phase}`);
    }

    const allowed = ['type', 'title', 'description', 'confidence', 'status', 'phase', 'position', 'parentId', 'summary', 'files', 'featureCode', 'stratumFlowId', 'evidence'];
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        item[key] = updates[key];
      }
    }
    // Regenerate slug when title changes
    if (updates.title !== undefined) {
      item.slug = slugify(updates.title);
    }
    // Ensure files is always an array
    if (updates.files !== undefined) {
      item.files = Array.isArray(updates.files) ? updates.files : [];
    }
    item.updatedAt = new Date().toISOString();

    this.items.set(id, item);
    this._save();
    return item;
  }

  /** Update the lifecycle field on an item — bypasses the generic allowlist.
   *  Only callable by LifecycleManager. */
  updateLifecycle(id, lifecycle) {
    const item = this.items.get(id);
    if (!item) throw new Error(`Item not found: ${id}`);
    item.lifecycle = lifecycle;
    item.updatedAt = new Date().toISOString();
    this.items.set(id, item);
    this._save();
    return item;
  }

  /** Delete an item and all its connections and gates */
  deleteItem(id) {
    if (!this.items.has(id)) throw new Error(`Item not found: ${id}`);
    this.items.delete(id);

    // Remove connections referencing this item
    for (const [connId, conn] of this.connections) {
      if (conn.fromId === id || conn.toId === id) {
        this.connections.delete(connId);
      }
    }

    // Remove gates associated with this item
    for (const [gateId, gate] of this.gates) {
      if (gate.itemId === id) {
        this.gates.delete(gateId);
      }
    }

    this._save();
    return { ok: true };
  }

  /** Create a connection between two items */
  createConnection({ fromId, toId, type }) {
    if (!this.items.has(fromId)) throw new Error(`Item not found: ${fromId}`);
    if (!this.items.has(toId)) throw new Error(`Item not found: ${toId}`);
    if (!VALID_CONNECTION_TYPES.includes(type)) throw new Error(`Invalid connection type: ${type}`);

    const conn = {
      id: uuidv4(),
      fromId,
      toId,
      type,
      createdAt: new Date().toISOString(),
    };

    this.connections.set(conn.id, conn);
    this._save();
    return conn;
  }

  /** Delete a connection */
  deleteConnection(id) {
    if (!this.connections.has(id)) throw new Error(`Connection not found: ${id}`);
    this.connections.delete(id);
    this._save();
    return { ok: true };
  }

  // ── Gate methods ──────────────────────────────────────────────────────

  /** Create a gate record */
  createGate(gate) {
    this.gates.set(gate.id, gate);
    this._save();
    return gate;
  }

  /** Resolve a pending gate */
  resolveGate(gateId, { outcome, comment }) {
    const gate = this.gates.get(gateId);
    if (!gate) throw new Error(`Gate not found: ${gateId}`);
    if (gate.status !== 'pending') throw new Error(`Gate ${gateId} is not pending (status: ${gate.status})`);
    gate.status = 'resolved';
    gate.outcome = outcome;
    gate.resolvedAt = new Date().toISOString();
    gate.resolvedBy = 'human';
    gate.comment = comment || null;
    this.gates.set(gateId, gate);
    this._save();
    return gate;
  }

  /** Get a gate by flow/step/round composite key */
  getGateByFlowStep(flowId, stepId, round) {
    const id = `${flowId}:${stepId}:${round}`;
    return this.gates.get(id) || null;
  }

  /** Get a gate by its ID */
  getGateById(gateId) {
    return this.gates.get(gateId) || null;
  }

  /** Get all gates (any status) as an array */
  getAllGates() {
    return Array.from(this.gates.values());
  }

  /** Get pending gates, optionally filtered by item */
  getPendingGates(itemId) {
    const pending = [];
    for (const gate of this.gates.values()) {
      if (gate.status !== 'pending') continue;
      if (itemId && gate.itemId !== itemId) continue;
      pending.push(gate);
    }
    return pending;
  }

  /** Get all gates for an item (any status) */
  getGatesForItem(itemId) {
    const result = [];
    for (const gate of this.gates.values()) {
      if (gate.itemId === itemId) result.push(gate);
    }
    return result;
  }

  /** Find an item by its lifecycle featureCode */
  getItemByFeatureCode(featureCode) {
    for (const item of this.items.values()) {
      if (item.lifecycle?.featureCode === featureCode) return item;
    }
    return null;
  }
}
