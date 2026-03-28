/**
 * timelineAssembler.js — Merge sessions, gates, and lifecycle data into
 * a sorted array of normalized timeline events.
 *
 * COMP-UX-11: Feature Event Timeline
 */

/**
 * @typedef {Object} TimelineEvent
 * @property {string} id
 * @property {string} timestamp - ISO 8601
 * @property {'phase'|'gate'|'session'|'iteration'|'error'} category
 * @property {string} title
 * @property {string|null} detail
 * @property {'info'|'success'|'warning'|'error'} severity
 * @property {string|null} sessionId
 * @property {Object|null} meta
 */

/**
 * Assemble a chronological timeline from persisted data sources.
 *
 * @param {Array|null} sessions - From GET /api/session/history
 * @param {Array|null} gates - From store, pre-filtered or will be filtered by itemId
 * @param {Object|null} currentItem - Tracker item with { id }
 * @returns {TimelineEvent[]}
 */
export function assembleTimeline(sessions, gates, currentItem) {
  const events = [];
  const itemId = currentItem?.id ?? null;

  // Track phases seen across sessions to reconstruct transitions
  // (phaseHistory is not persisted server-side, so we infer from session data)
  const phasesSeenFromSessions = new Set();

  if (Array.isArray(sessions)) {
    for (const session of sessions) {
      // Session start
      events.push({
        id: `session-start-${session.id}`,
        timestamp: session.startedAt,
        category: 'session',
        title: 'Session started',
        detail: session.source ? `Source: ${session.source}` : null,
        severity: 'info',
        sessionId: session.id,
        meta: { toolCount: session.toolCount, source: session.source },
      });

      // Session end
      if (session.endedAt) {
        events.push({
          id: `session-end-${session.id}`,
          timestamp: session.endedAt,
          category: 'session',
          title: `Session ended (${session.toolCount ?? 0} tools${session.errors?.length ? `, ${session.errors.length} error${session.errors.length > 1 ? 's' : ''}` : ''})`,
          detail: null,
          severity: 'info',
          sessionId: session.id,
          meta: { toolCount: session.toolCount, errorCount: session.errors?.length ?? 0 },
        });
      }

      // Errors from session
      if (Array.isArray(session.errors)) {
        for (let i = 0; i < session.errors.length; i++) {
          const err = session.errors[i];
          events.push({
            id: `error-${session.id}-${i}`,
            timestamp: err.timestamp || session.startedAt,
            category: 'error',
            title: err.message || `${err.type} error`,
            detail: err.tool ? `Tool: ${err.tool}` : null,
            severity: err.severity === 'error' ? 'error' : 'warning',
            sessionId: session.id,
            meta: { type: err.type, tool: err.tool },
          });
        }
      }

      // Phase transition inferred from phaseAtBind → phaseAtEnd
      if (session.phaseAtBind && session.phaseAtEnd && session.phaseAtBind !== session.phaseAtEnd) {
        // Place transition midway through the session
        const startMs = new Date(session.startedAt).getTime();
        const endMs = session.endedAt ? new Date(session.endedAt).getTime() : startMs;
        const midTs = new Date(startMs + (endMs - startMs) * 0.8).toISOString();
        events.push({
          id: `phase-${session.id}`,
          timestamp: midTs,
          category: 'phase',
          title: `Phase: ${session.phaseAtBind} → ${session.phaseAtEnd}`,
          detail: null,
          severity: 'success',
          sessionId: session.id,
          meta: { from: session.phaseAtBind, to: session.phaseAtEnd },
        });
      }
    }
  }

  if (Array.isArray(gates)) {
    const filtered = itemId ? gates.filter(g => g.itemId === itemId) : gates;
    for (const gate of filtered) {
      // Gate created
      if (gate.createdAt) {
        const label = gate.fromPhase && gate.toPhase
          ? `Gate: ${gate.fromPhase} → ${gate.toPhase}`
          : `Gate created`;
        events.push({
          id: `gate-created-${gate.id}`,
          timestamp: gate.createdAt,
          category: 'gate',
          title: label,
          detail: null,
          severity: 'info',
          sessionId: null,
          meta: { gateId: gate.id, fromPhase: gate.fromPhase, toPhase: gate.toPhase },
        });
      }

      // Gate resolved
      if (gate.resolvedAt && gate.outcome) {
        // Normalize both short-form (approve/revise/kill) and long-form (approved/revised/killed)
        const outcomeMap = { approve: 'approve', approved: 'approve', revise: 'revise', revised: 'revise', kill: 'kill', killed: 'kill' };
        const normalized = outcomeMap[gate.outcome] || gate.outcome;
        const severityMap = { approve: 'success', revise: 'warning', kill: 'error' };
        const labelMap = { approve: 'approved', revise: 'revised', kill: 'killed' };
        events.push({
          id: `gate-resolved-${gate.id}`,
          timestamp: gate.resolvedAt,
          category: 'gate',
          title: `Gate ${labelMap[normalized] || gate.outcome}`,
          detail: gate.comment || null,
          severity: severityMap[normalized] || 'info',
          sessionId: null,
          meta: { gateId: gate.id, outcome: gate.outcome, comment: gate.comment },
        });
      }
    }
  }

  // Deduplicate by id (in case of merge with live events)
  const seen = new Set();
  const unique = [];
  for (const event of events) {
    if (!seen.has(event.id)) {
      seen.add(event.id);
      unique.push(event);
    }
  }

  // Sort ascending by timestamp
  unique.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return unique;
}
