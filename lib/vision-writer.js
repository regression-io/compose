/**
 * VisionWriter — Dual-dispatch read-modify-write for vision-state.json
 *
 * Routes mutations through REST when the Compose server is running,
 * falls back to direct atomic file writes when it's down.
 *
 * Provides step-to-item mapping, feature item lookup (using lifecycle.featureCode),
 * gate management with outcome normalization, and migration of legacy formats.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolvePort } from './resolve-port.js';
import { probeServer } from './server-probe.js';

const EMPTY_STATE = () => ({ items: [], connections: [], gates: [] });

/** Canonical outcome normalization — maps legacy past-tense to imperative */
function normalizeOutcome(outcome) {
  const map = { approved: 'approve', killed: 'kill', revised: 'revise' };
  return map[outcome] || outcome;
}

export class ServerUnreachableError extends Error {
  constructor(message = 'Server is unreachable') {
    super(message);
    this.name = 'ServerUnreachableError';
  }
}

export class VisionWriter {
  /**
   * @param {string} dataDir  Path to the data directory (e.g. `.compose/data/`)
   * @param {object} [opts]
   * @param {number} [opts.port]  Server port (default: resolvePort())
   */
  constructor(dataDir, opts = {}) {
    this.filePath = path.join(dataDir, 'vision-state.json');
    this._dataDir = dataDir;
    this._port = opts.port ?? resolvePort();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Read and parse vision-state.json, applying migration if needed.
   * Returns empty state if the file doesn't exist or contains invalid JSON.
   */
  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      parsed.items = parsed.items || [];
      parsed.connections = parsed.connections || [];
      parsed.gates = parsed.gates || [];

      // Migration: legacy featureCode → lifecycle.featureCode
      let migrated = false;
      for (const item of parsed.items) {
        if (item.featureCode && item.featureCode.startsWith('feature:') && !item.lifecycle?.featureCode) {
          const bare = item.featureCode.replace(/^feature:/, '');
          item.lifecycle = item.lifecycle || {};
          item.lifecycle.featureCode = bare;
          delete item.featureCode;
          migrated = true;
        }
      }

      // Migration: normalize legacy gate outcomes
      for (const gate of parsed.gates) {
        if (gate.outcome) {
          const normalized = normalizeOutcome(gate.outcome);
          if (normalized !== gate.outcome) {
            gate.outcome = normalized;
            migrated = true;
          }
        }
      }

      if (migrated) {
        this._atomicWrite(parsed);
      }

      return parsed;
    } catch {
      return EMPTY_STATE();
    }
  }

  /**
   * Atomically write state by writing to a temp file then renaming.
   * @param {object} state
   */
  _atomicWrite(state) {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `vision-state.json.tmp.${crypto.randomUUID()}`);
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }

  /** Check if the Compose server is reachable */
  async _serverAvailable() {
    return probeServer(this._port);
  }

  /** Base URL for REST calls */
  get _baseUrl() {
    return `http://localhost:${this._port}`;
  }

  /** Fetch helper with timeout */
  async _fetch(urlPath, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${this._baseUrl}${urlPath}`, {
        ...opts,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...opts.headers },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`REST ${opts.method || 'GET'} ${urlPath} failed: ${res.status} ${body}`);
      }
      return res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------------
  // REST variants
  // ---------------------------------------------------------------------------

  async _restFindFeatureItem(featureCode) {
    const state = await this._fetch('/api/vision/items');
    const items = state.items || [];
    return items.find(item => item.lifecycle?.featureCode === featureCode) || null;
  }

  async _restEnsureFeatureItem(featureCode, title) {
    const existing = await this._restFindFeatureItem(featureCode);
    if (existing) {
      // Partial repair: item exists but no lifecycle — start lifecycle
      if (!existing.lifecycle?.featureCode) {
        await this._fetch(`/api/vision/items/${existing.id}/lifecycle/start`, {
          method: 'POST',
          body: JSON.stringify({ featureCode }),
        });
      }
      return existing.id;
    }
    const item = await this._fetch('/api/vision/items', {
      method: 'POST',
      body: JSON.stringify({
        type: 'feature',
        title: title || featureCode,
        description: '',
        status: 'planned',
        phase: 'planning',
      }),
    });
    await this._fetch(`/api/vision/items/${item.id}/lifecycle/start`, {
      method: 'POST',
      body: JSON.stringify({ featureCode }),
    });
    return item.id;
  }

  async _restUpdateItemStatus(itemId, status) {
    await this._fetch(`/api/vision/items/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  }

  async _restUpdateItemPhase(itemId, stepId) {
    await this._fetch(`/api/vision/items/${itemId}/lifecycle/advance`, {
      method: 'POST',
      body: JSON.stringify({ targetPhase: stepId }),
    }).catch(() => {
      // Lifecycle advance may reject for invalid transitions — fall through
    });
  }

  async _restCreateGate(flowId, stepId, itemId, opts = {}) {
    const round = opts.round ?? 1;
    const gate = await this._fetch('/api/vision/gates', {
      method: 'POST',
      body: JSON.stringify({
        flowId, stepId, round, itemId,
        fromPhase: opts.fromPhase || null,
        toPhase: opts.toPhase || null,
        artifact: opts.artifact || null,
        options: opts.options || null,
        summary: opts.summary || null,
        comment: opts.comment || null,
        policyMode: opts.policyMode || undefined,
      }),
    });
    return gate.id;
  }

  async _restGetGate(gateId) {
    try {
      return await this._fetch(`/api/vision/gates/${encodeURIComponent(gateId)}`);
    } catch {
      return null;
    }
  }

  async _restResolveGate(gateId, outcome, comment, resolvedBy) {
    await this._fetch(`/api/vision/gates/${encodeURIComponent(gateId)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ outcome: normalizeOutcome(outcome), comment: comment || null, resolvedBy: resolvedBy || undefined }),
    });
  }

  // ---------------------------------------------------------------------------
  // Direct (file-based) variants
  // ---------------------------------------------------------------------------

  _directFindFeatureItem(featureCode) {
    const state = this._load();
    return state.items.find(item => item.lifecycle?.featureCode === featureCode) || null;
  }

  _directEnsureFeatureItem(featureCode, title) {
    const existing = this._directFindFeatureItem(featureCode);
    if (existing) return existing.id;

    const state = this._load();
    const item = {
      id: crypto.randomUUID(),
      type: 'feature',
      title: title || featureCode,
      description: '',
      status: 'planned',
      phase: 'planning',
      lifecycle: { featureCode, currentPhase: 'explore_design' },
      slug: featureCode.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      confidence: null,
      createdAt: new Date().toISOString(),
    };
    state.items.push(item);
    this._atomicWrite(state);
    return item.id;
  }

  _directUpdateItemStatus(itemId, status) {
    const state = this._load();
    const item = state.items.find(i => i.id === itemId);
    if (item) {
      item.status = status;
      this._atomicWrite(state);
    }
  }

  _directUpdateItemPhase(itemId, stepId) {
    const state = this._load();
    const item = state.items.find(i => i.id === itemId);
    if (item) {
      item.lifecycle = item.lifecycle || {};
      item.lifecycle.currentPhase = stepId;
      this._atomicWrite(state);
    }
  }

  _directCreateGate(flowId, stepId, itemId, opts = {}) {
    const state = this._load();
    state.gates = state.gates || [];
    const round = opts.round ?? 1;
    const gate = {
      id: `${flowId}:${stepId}:${round}`,
      flowId,
      stepId,
      round,
      itemId,
      fromPhase: opts.fromPhase || null,
      toPhase: opts.toPhase || null,
      artifact: opts.artifact || null,
      options: opts.options || null,
      summary: opts.summary || null,
      comment: opts.comment || null,
      policyMode: opts.policyMode ?? 'gate',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    state.gates.push(gate);
    this._atomicWrite(state);
    return gate.id;
  }

  _directGetGate(gateId) {
    const state = this._load();
    return (state.gates || []).find(g => g.id === gateId) || null;
  }

  _directResolveGate(gateId, outcome, comment, resolvedBy) {
    const state = this._load();
    const gate = (state.gates || []).find(g => g.id === gateId);
    if (gate) {
      gate.status = 'resolved';
      gate.outcome = normalizeOutcome(outcome);
      gate.comment = comment || null;
      gate.resolvedBy = resolvedBy ?? 'human';
      gate.resolvedAt = new Date().toISOString();
      this._atomicWrite(state);
    }
  }

  // ---------------------------------------------------------------------------
  // Public async methods — dual dispatch
  // ---------------------------------------------------------------------------

  async findFeatureItem(featureCode) {
    if (await this._serverAvailable()) {
      return this._restFindFeatureItem(featureCode);
    }
    return this._directFindFeatureItem(featureCode);
  }

  async ensureFeatureItem(featureCode, title) {
    if (await this._serverAvailable()) {
      return this._restEnsureFeatureItem(featureCode, title);
    }
    return this._directEnsureFeatureItem(featureCode, title);
  }

  async updateItemStatus(itemId, status) {
    if (await this._serverAvailable()) {
      return this._restUpdateItemStatus(itemId, status);
    }
    return this._directUpdateItemStatus(itemId, status);
  }

  async updateItemPhase(itemId, stepId) {
    if (await this._serverAvailable()) {
      return this._restUpdateItemPhase(itemId, stepId);
    }
    return this._directUpdateItemPhase(itemId, stepId);
  }

  async createGate(flowId, stepId, itemId, opts = {}) {
    if (await this._serverAvailable()) {
      return this._restCreateGate(flowId, stepId, itemId, opts);
    }
    return this._directCreateGate(flowId, stepId, itemId, opts);
  }

  async getGate(gateId, opts = {}) {
    if (opts.requireServer) {
      const up = await this._serverAvailable();
      if (!up) throw new ServerUnreachableError();
      return this._restGetGate(gateId);
    }
    if (await this._serverAvailable()) {
      return this._restGetGate(gateId);
    }
    return this._directGetGate(gateId);
  }

  async resolveGate(gateId, outcome, comment, resolvedBy) {
    if (await this._serverAvailable()) {
      return this._restResolveGate(gateId, outcome, comment, resolvedBy);
    }
    return this._directResolveGate(gateId, outcome, comment, resolvedBy);
  }
}
