/**
 * session-routes.js — Session lifecycle REST routes.
 *
 * Routes:
 *   POST /api/session/start
 *   POST /api/session/end
 *   GET  /api/session/current
 */

/**
 * Attach session lifecycle routes to an Express app.
 *
 * @param {object} app — Express app
 * @param {{
 *   sessionManager: object,
 *   scheduleBroadcast: function,
 *   broadcastMessage: function,
 *   spawnJournalAgent: function,
 *   projectRoot: string
 * }} deps
 */
export function attachSessionRoutes(app, { sessionManager, scheduleBroadcast, broadcastMessage, spawnJournalAgent }) {
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
      timestamp: new Date().toISOString(),
    });

    res.json({ sessionId: session.id, persisted: true, journalSpawned });
  });

  // GET /api/session/current — current session state
  app.get('/api/session/current', (_req, res) => {
    if (!sessionManager?.currentSession) return res.json({ session: null });
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
    res.json({
      session: {
        id: s.id, startedAt: s.startedAt, source: s.source, toolCount: s.toolCount,
        blockCount: s.blocks.length, errorCount: (s.errors || []).length, items,
        summaries: allSummaries,
      },
    });
  });
}
