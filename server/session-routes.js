/**
 * session-routes.js — Session lifecycle REST routes.
 *
 * Routes:
 *   POST /api/session/start
 *   POST /api/session/end
 *   POST /api/session/bind
 *   GET  /api/session/history
 *   GET  /api/session/current
 */

import { readSessionsByFeature } from './session-store.js';

/**
 * Attach session lifecycle routes to an Express app.
 *
 * @param {object} app — Express app
 * @param {{
 *   sessionManager: object,
 *   scheduleBroadcast: function,
 *   broadcastMessage: function,
 *   spawnJournalAgent: function,
 *   projectRoot: string,
 *   store: object
 * }} deps
 */
export function attachSessionRoutes(app, { sessionManager, scheduleBroadcast, broadcastMessage, spawnJournalAgent, store }) {
  // POST /api/session/start — hook calls this on SessionStart
  app.post('/api/session/start', (req, res) => {
    const { source } = req.body || {};
    if (!sessionManager) return res.status(503).json({ error: 'No session manager' });
    const session = sessionManager.startSession(source || 'startup');
    const context = sessionManager.getContext();

    broadcastMessage({
      type: 'sessionStart',
      sessionId: session.id,
      source: source || 'startup',
      timestamp: new Date().toISOString(),
    });

    res.json({ sessionId: session.id, context });
  });

  // POST /api/session/end — hook calls this on SessionEnd
  app.post('/api/session/end', async (req, res) => {
    const { reason, transcriptPath } = req.body || {};
    if (!sessionManager) return res.status(503).json({ error: 'No session manager' });
    const meetsThreshold = sessionManager.meetsJournalThreshold();
    const session = await sessionManager.endSession(reason, transcriptPath);
    if (!session) return res.json({ sessionId: null, persisted: false });
    let journalSpawned = false;
    if (meetsThreshold && transcriptPath) {
      spawnJournalAgent(session, transcriptPath);
      journalSpawned = true;
    }

    broadcastMessage({
      type: 'sessionEnd',
      sessionId: session.id,
      reason,
      toolCount: session.toolCount,
      duration: Math.round((new Date(session.endedAt) - new Date(session.startedAt)) / 1000),
      journalSpawned,
      featureCode: session.featureCode || null,
      phaseAtEnd: session.phaseAtEnd || null,
      timestamp: new Date().toISOString(),
    });

    res.json({ sessionId: session.id, persisted: true, journalSpawned });
  });

  // POST /api/session/bind — bind active session to a lifecycle feature
  app.post('/api/session/bind', (req, res) => {
    try {
      const { featureCode } = req.body;
      if (!featureCode) return res.status(400).json({ error: 'featureCode required' });
      if (!/^[A-Za-z0-9_-]+$/.test(featureCode)) return res.status(400).json({ error: 'Invalid featureCode' });

      const session = sessionManager.currentSession;
      if (!session) return res.status(409).json({ error: 'No active session' });

      // If already bound, return early without validating the new feature code
      if (session.featureCode) {
        return res.json({ already_bound: true, featureCode: session.featureCode });
      }

      // Look up the vision item for this feature — reject if not found
      const item = store.getItemByFeatureCode(featureCode);
      if (!item) return res.status(404).json({ error: `No lifecycle item for feature code: ${featureCode}` });
      const itemId = item.id;
      const phase = item.lifecycle?.currentPhase || null;

      const result = sessionManager.bindToFeature(featureCode, itemId, phase);

      if (!result.already_bound) {
        broadcastMessage({
          type: 'sessionBound',
          sessionId: session.id,
          featureCode,
          itemId,
          phase,
          timestamp: new Date().toISOString(),
        });
      }

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/session/history — sessions bound to a feature
  app.get('/api/session/history', (req, res) => {
    try {
      const { featureCode, limit } = req.query;
      if (!featureCode) return res.status(400).json({ error: 'featureCode required' });
      const sessions = readSessionsByFeature(featureCode, parseInt(limit) || 10, sessionManager.sessionsFile);
      res.json({ sessions });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/session/current — current session state (with optional featureCode enrichment)
  app.get('/api/session/current', (_req, res) => {
    const { featureCode } = _req.query;

    if (!sessionManager?.currentSession) {
      if (featureCode) {
        return res.json(_buildFeatureContext(featureCode, null));
      }
      return res.json({ session: null });
    }

    const s = sessionManager.currentSession;
    const items = {};
    const allSummaries = [];
    for (const [id, acc] of s.items) {
      items[id] = { title: acc.title, reads: acc.reads, writes: acc.writes, summaries: acc.summaries };
      for (const summary of (acc.summaries || [])) {
        if (!summary) continue;
        allSummaries.push(typeof summary === 'string' ? { summary } : summary);
      }
    }
    const sessionData = {
      id: s.id, startedAt: s.startedAt, source: s.source, toolCount: s.toolCount,
      blockCount: s.blocks.length, errorCount: (s.errors || []).length, items,
      summaries: allSummaries,
      featureCode: s.featureCode || null,
      featureItemId: s.featureItemId || null,
      phaseAtBind: s.phaseAtBind || null,
      boundAt: s.boundAt || null,
    };

    // When featureCode requested and active session is bound to THAT feature
    if (featureCode && s.featureCode === featureCode) {
      return res.json(_buildFeatureContext(featureCode, sessionData));
    }

    // When featureCode requested but active session is for a DIFFERENT feature
    if (featureCode && s.featureCode !== featureCode) {
      return res.json(_buildFeatureContext(featureCode, null));
    }

    // No featureCode requested — return generic active session (existing behavior)
    res.json({ session: sessionData });
  });

  // Helper: normalize feature-aware response shape across all branches
  function _buildFeatureContext(featureCode, sessionData) {
    const item = store.getItemByFeatureCode(featureCode);
    const recentSessions = readSessionsByFeature(featureCode, 3, sessionManager.sessionsFile);
    const recentSummaries = recentSessions
      .flatMap(rs => Object.values(rs.items || {}).flatMap(i => i.summaries || []))
      .slice(0, 10);
    return {
      session: sessionData || recentSessions[0] || null,
      lifecycle: item?.lifecycle ? {
        currentPhase: item.lifecycle.currentPhase,
        phaseHistory: (item.lifecycle.phaseHistory || []).map(h => ({ phase: h.phase, enteredAt: h.enteredAt, exitedAt: h.exitedAt })),
        artifacts: item.lifecycle.artifacts || {},
        pendingGate: item.lifecycle.pendingGate || null,
      } : null,
      recentSummaries,
    };
  }
}
