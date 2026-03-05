/**
 * stratum-sync.js — Stratum flow poller + route registration.
 *
 * Reads persisted flow states from ~/.stratum/flows/ and syncs them into the
 * vision store every 15 seconds.
 *
 * Routes: GET /api/stratum/flows, POST /api/stratum/bind, POST /api/stratum/audit/:itemId
 */

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// StratumSync class
// ---------------------------------------------------------------------------

export class StratumSync {
  #store;
  #scheduleBroadcast;
  #pollTimer = null;

  /**
   * @param {object} store — VisionStore instance
   * @param {function} scheduleBroadcast
   */
  constructor(store, scheduleBroadcast) {
    this.#store = store;
    this.#scheduleBroadcast = scheduleBroadcast;
  }

  /** Start the 15s polling interval. */
  start() {
    this.#pollTimer = setInterval(() => {
      try {
        this.#syncFlows();
      } catch (err) {
        console.error('[vision] Stratum poll error:', err.message);
      }
    }, 15_000);
  }

  /** Stop the polling interval. */
  stop() {
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
  }

  /**
   * Read all persisted flow states from ~/.stratum/flows/.
   * @returns {Array}
   */
  readFlows() {
    const flowsDir = path.join(homedir(), '.stratum', 'flows');
    if (!fs.existsSync(flowsDir)) return [];

    const flows = [];
    let files;
    try {
      files = fs.readdirSync(flowsDir).filter(f => f.endsWith('.json'));
    } catch { return []; }

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(flowsDir, file), 'utf-8');
        const state = JSON.parse(raw);
        const records = Array.isArray(state.records) ? state.records : [];
        const attempts = state.attempts || {};
        const stepOutputIds = new Set(Object.keys(state.step_outputs || {}));
        const completedIds = new Set(records.map(r => r.step_id));

        const hasInFlight = Object.keys(attempts).some(sid => !completedIds.has(sid));

        // Exhausted: step is in records but NOT in step_outputs → retries_exhausted
        const exhaustedSteps = records.filter(r => !stepOutputIds.has(r.step_id));
        const hasExhausted = exhaustedSteps.length > 0;

        // Status hierarchy: running > blocked > paused
        // NOTE: 'complete' is NOT detectable via polling — driven by /api/stratum/audit instead.
        const status = hasInFlight ? 'running' : hasExhausted ? 'blocked' : 'paused';

        flows.push({
          flowId: state.flow_id,
          flowName: state.flow_name || state.flow_id,
          status,
          stepsCompleted: stepOutputIds.size,
          currentIdx: state.current_idx || 0,
          exhaustedSteps: exhaustedSteps.map(r => ({ stepId: r.step_id, attempts: r.attempts })),
          steps: records.map(r => ({
            id: r.step_id,
            status: stepOutputIds.has(r.step_id) ? 'complete' : 'failed',
            attempts: r.attempts,
            duration_ms: r.duration_ms,
          })),
        });
      } catch { /* skip malformed files */ }
    }

    return flows;
  }

  /** Sync stratum flow states → vision item statuses + violation evidence. */
  #syncFlows() {
    const flows = this.readFlows();
    if (flows.length === 0) return;

    const flowMap = new Map(flows.map(f => [f.flowId, f]));
    let changed = false;

    for (const item of this.#store.items.values()) {
      if (!item.stratumFlowId) continue;
      const flow = flowMap.get(item.stratumFlowId);
      if (!flow) continue;

      const targetStatus = flow.status === 'running' ? 'in_progress'
        : flow.status === 'blocked' ? 'blocked'
        : null;

      if (targetStatus && targetStatus !== item.status) {
        try {
          this.#store.updateItem(item.id, { status: targetStatus });
          changed = true;
        } catch { /* ignore */ }
      }

      const existing = item.evidence || {};
      if (flow.status === 'blocked' && flow.exhaustedSteps.length > 0) {
        const violations = flow.exhaustedSteps.map(s =>
          `Step '${s.stepId}' exhausted retries after ${s.attempts} attempt${s.attempts !== 1 ? 's' : ''}`
        );
        const needsUpdate = JSON.stringify(existing.stratumViolations) !== JSON.stringify(violations);
        if (needsUpdate) {
          try {
            this.#store.updateItem(item.id, {
              evidence: { ...existing, stratumViolations: violations, violatedAt: new Date().toISOString() },
            });
            changed = true;
          } catch { /* ignore */ }
        }
      } else if (existing.stratumViolations) {
        try {
          const { stratumViolations: _, violatedAt: __, ...rest } = existing;
          this.#store.updateItem(item.id, { evidence: rest });
          changed = true;
        } catch { /* ignore */ }
      }
    }

    if (changed) this.#scheduleBroadcast();
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Attach stratum REST routes to an Express app.
 *
 * @param {object} app — Express app
 * @param {{ store: object, scheduleBroadcast: function, broadcastMessage: function, sync: StratumSync }} deps
 */
export function attachStratumRoutes(app, { store, scheduleBroadcast, broadcastMessage, sync }) {
  // GET /api/stratum/flows — list persisted flow states from ~/.stratum/flows/
  app.get('/api/stratum/flows', (_req, res) => {
    try {
      const flows = sync.readFlows();
      res.json({ flows, count: flows.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/stratum/bind — link a stratum flow_id to a vision item
  app.post('/api/stratum/bind', (req, res) => {
    const { flowId, itemId } = req.body || {};
    if (!flowId || !itemId) return res.status(400).json({ error: 'flowId and itemId required' });
    try {
      const item = store.updateItem(itemId, { stratumFlowId: flowId });
      scheduleBroadcast();
      res.json({ ok: true, itemId, flowId, item });
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  });

  // POST /api/stratum/audit/:itemId — store audit trace in item evidence + emit session log event
  app.post('/api/stratum/audit/:itemId', (req, res) => {
    const { trace } = req.body || {};
    if (!trace) return res.status(400).json({ error: 'trace required' });
    try {
      const item = store.items.get(req.params.itemId);
      if (!item) return res.status(404).json({ error: `Item not found: ${req.params.itemId}` });
      // eslint-disable-next-line no-unused-vars
      const { stratumViolations: _v, violatedAt: _va, ...existingEvidence } = item.evidence || {};
      const evidence = { ...existingEvidence, stratumTrace: trace, tracedAt: new Date().toISOString() };
      const updates = { evidence };
      if (trace.status === 'complete' && item.status !== 'complete') {
        updates.status = 'complete';
      }
      const updatedItem = store.updateItem(req.params.itemId, updates);
      scheduleBroadcast();

      const stepsCompleted = Array.isArray(trace.trace) ? trace.trace.length : 0;
      const totalMs = trace.total_duration_ms || null;
      broadcastMessage({
        type: 'agentActivity',
        tool: 'stratum_audit',
        category: 'delegating',
        detail: `${trace.flow_name || trace.flow_id}: ${stepsCompleted} steps${totalMs != null ? `, ${(totalMs / 1000).toFixed(1)}s` : ''}`,
        error: null,
        items: [{ id: updatedItem.id, title: updatedItem.title, status: updatedItem.status }],
        timestamp: new Date().toISOString(),
      });

      res.json({ ok: true, itemId: req.params.itemId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
