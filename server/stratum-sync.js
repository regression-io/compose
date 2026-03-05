/**
 * stratum-sync.js — Stratum flow poller + route registration.
 *
 * Polls stratum flow state via stratum-client (not direct file reads) and syncs
 * into the vision store every 15 seconds.
 *
 * Routes: POST /api/stratum/bind, POST /api/stratum/audit/:itemId
 * (Flow/gate query routes are now in stratum-api.js)
 */

import { queryFlows } from './stratum-client.js';

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
      this.#syncFlows().catch(err => {
        console.error('[vision] Stratum poll error:', err.message);
      });
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
   * Fetch flow summaries via stratum-client (stable contract, not direct file reads).
   * Maps stratum's query output to the shape the sync logic expects.
   * @returns {Promise<Array>}
   */
  async readFlows() {
    const raw = await queryFlows();
    if (!Array.isArray(raw)) return [];

    return raw.map(f => {
      // Map stratum canonical status → legacy sync status labels
      const status = f.status === 'running' || f.status === 'awaiting_gate' ? 'running'
        : f.status === 'complete' ? 'complete'
        : f.status === 'killed' ? 'blocked'
        : 'paused';

      return {
        flowId:   f.flow_id,
        flowName: f.flow_name,
        status,
        stepsCompleted: f.completed_steps,
        currentIdx:     f.completed_steps,
        steps:          [],
      };
    });
  }

  /** Sync stratum flow states → vision item statuses + violation evidence. */
  async #syncFlows() {
    const flows = await this.readFlows();
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
      if (flow.status === 'blocked') {
        // Flow was killed via gate reject — record factual evidence, not retry semantics.
        const killNote = `Flow '${flow.flowName}' was killed via gate reject`;
        if (existing.stratumKillNote !== killNote) {
          try {
            // Also clear any stale retry-exhaustion evidence from old sync format.
            const { stratumViolations: _v, violatedAt: _va, ...rest } = existing;
            this.#store.updateItem(item.id, {
              evidence: { ...rest, stratumKillNote: killNote, killedAt: new Date().toISOString() },
            });
            changed = true;
          } catch { /* ignore */ }
        }
      } else if (existing.stratumKillNote || existing.stratumViolations) {
        // Flow is no longer blocked — clear kill evidence.
        try {
          const { stratumKillNote: _k, killedAt: _ka, stratumViolations: _v, violatedAt: _va, ...rest } = existing;
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
