/**
 * settings-routes.js — Settings REST API.
 *
 * Routes:
 *   GET    /api/settings        — current merged settings
 *   PATCH  /api/settings        — partial update
 *   POST   /api/settings/reset  — reset all or a section
 */

/**
 * @param {object} app — Express app
 * @param {{ settingsStore: object, broadcastMessage: function }} deps
 */
export function attachSettingsRoutes(app, { settingsStore, broadcastMessage }) {
  app.get('/api/settings', (_req, res) => {
    res.json(settingsStore.get());
  });

  app.patch('/api/settings', (req, res) => {
    try {
      const updated = settingsStore.update(req.body);
      broadcastMessage({ type: 'settingsUpdated', settings: updated });
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/settings/reset', (req, res) => {
    const section = req.body?.section || undefined;
    const updated = settingsStore.reset(section);
    broadcastMessage({ type: 'settingsUpdated', settings: updated });
    res.json(updated);
  });
}
