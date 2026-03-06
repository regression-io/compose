/**
 * activity-routes.js — POST /api/agent/activity and POST /api/agent/error route handlers.
 *
 * These stay separate from vision-routes because they depend on resolveItems,
 * which lives on VisionServer. Both deps are injected.
 */

import { detectError } from './vision-utils.js';

// NOTE: Duplicated in vision-server.js and src/components/Terminal.jsx — keep in sync
const TOOL_CATEGORIES = {
  Read: 'reading', Glob: 'searching', Grep: 'searching',
  Write: 'writing', Edit: 'writing', NotebookEdit: 'writing',
  Bash: 'executing', Task: 'delegating', Skill: 'delegating',
  WebFetch: 'fetching', WebSearch: 'searching',
  TodoRead: 'reading', TodoWrite: 'writing',
};

/**
 * @param {object} app
 * @param {{ store, sessionManager, scheduleBroadcast, broadcastMessage, resolveItems }} deps
 */
export function attachActivityRoutes(app, { store, sessionManager, scheduleBroadcast, broadcastMessage, resolveItems }) {
  // POST /api/agent/activity — receive tool use events from hooks
  app.post('/api/agent/activity', (req, res) => {
    const { tool, input, response, timestamp } = req.body || {};
    if (!tool) return res.status(400).json({ error: 'tool is required' });

    let detail = null;
    let filePath = null;
    if (input) {
      filePath = input.file_path || null;
      detail = filePath || input.command || input.pattern || input.query || input.url || input.prompt || null;
      if (detail && detail.length > 120) detail = detail.slice(0, 117) + '...';
    }

    const items = filePath ? resolveItems(filePath) : [];

    // Auto-status: Write/Edit on planned items → in_progress
    if (['Write', 'Edit'].includes(tool) && filePath) {
      for (const item of items) {
        if (item.status === 'planned') {
          try {
            store.updateItem(item.id, { status: 'in_progress' });
            scheduleBroadcast();
          } catch { /* ignore */ }
        }
      }
    }

    const category = TOOL_CATEGORIES[tool] || 'thinking';

    if (sessionManager) {
      sessionManager.recordActivity(tool, category, filePath, input, items);
    }

    let error = null;
    if (response && typeof response === 'string') {
      error = detectError(tool, input, response);
    }

    if (error) {
      if (sessionManager) {
        sessionManager.recordError(tool, filePath, error.type, error.severity, error.message, items);
      }
      broadcastMessage({
        type: 'agentError',
        errorType: error.type,
        severity: error.severity,
        message: error.message,
        tool,
        detail,
        items: items.map(i => ({ id: i.id, title: i.title })),
        timestamp: timestamp || new Date().toISOString(),
      });
    }

    broadcastMessage({
      type: 'agentActivity',
      tool,
      category,
      detail,
      error: error ? { type: error.type, severity: error.severity } : null,
      items: items.map(i => ({ id: i.id, title: i.title, status: i.status, phase: i.lifecycle?.currentPhase || null })),
      timestamp: timestamp || new Date().toISOString(),
    });

    res.json({ ok: true });
  });

  // POST /api/agent/error — receive PostToolUseFailure events from hooks
  app.post('/api/agent/error', (req, res) => {
    const { tool, input, error: errorMsg } = req.body || {};
    if (!tool) return res.status(400).json({ error: 'tool is required' });

    const filePath = input?.file_path || null;
    const items = filePath ? resolveItems(filePath) : [];

    const detected = detectError(tool, input, errorMsg || '') || {
      type: 'runtime_error',
      severity: 'error',
      message: errorMsg || 'Tool use failed',
    };

    if (sessionManager) {
      sessionManager.recordError(tool, filePath, detected.type, detected.severity, detected.message, items);
    }

    broadcastMessage({
      type: 'agentError',
      errorType: detected.type,
      severity: detected.severity,
      message: detected.message,
      tool,
      detail: filePath || input?.command || null,
      items: items.map(i => ({ id: i.id, title: i.title })),
      timestamp: new Date().toISOString(),
    });

    console.log(`[vision] Error detected: ${detected.type} (${detected.severity}) from ${tool}: ${detected.message.slice(0, 80)}`);
    res.json({ ok: true, detected });
  });
}
