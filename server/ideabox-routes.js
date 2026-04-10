/**
 * server/ideabox-routes.js — REST API for the ideabox feature.
 *
 * Routes:
 *   GET    /api/ideabox                  — return parsed ideabox JSON (cached)
 *   POST   /api/ideabox/ideas            — add new idea
 *   PATCH  /api/ideabox/ideas/:id        — update priority/status/etc.
 *   POST   /api/ideabox/ideas/:id/promote — promote to feature
 *   POST   /api/ideabox/ideas/:id/kill   — kill with reason
 *   DELETE /api/ideabox/ideas/:id        — not allowed (use kill)
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  readIdeabox,
  writeIdeabox,
  addIdea,
  promoteIdea,
  killIdea,
  resurrectIdea,
  setPriority,
  updateIdea,
  addDiscussion,
} from '../lib/ideabox.js'
import { IdeaboxCache } from './ideabox-cache.js'

/**
 * @param {object} app              — Express app
 * @param {{ getProjectRoot, getDataDir, broadcastMessage }} deps
 */
export function attachIdeaboxRoutes(app, { getProjectRoot, getDataDir, broadcastMessage }) {
  // Lazily created per project root — we need to handle project switches
  let _cache = null
  let _lastProjectRoot = null
  let _lastDataDir = null

  function getCache() {
    const projectRoot = getProjectRoot()
    const dataDir = getDataDir()
    if (!_cache || _lastProjectRoot !== projectRoot || _lastDataDir !== dataDir) {
      const config = loadConfig(projectRoot)
      const ideaboxRel = config?.paths?.ideabox || 'docs/product/ideabox.md'
      const sourceFile = path.join(projectRoot, ideaboxRel)
      _cache = new IdeaboxCache(dataDir, sourceFile)
      _lastProjectRoot = projectRoot
      _lastDataDir = dataDir
    }
    return _cache
  }

  function getIdeaboxPath(projectRoot) {
    const config = loadConfig(projectRoot)
    return config?.paths?.ideabox || 'docs/product/ideabox.md'
  }

  function broadcastUpdate() {
    if (broadcastMessage) {
      broadcastMessage({ type: 'ideaboxUpdated', timestamp: new Date().toISOString() })
    }
  }

  // GET /api/ideabox
  app.get('/api/ideabox', (_req, res) => {
    try {
      const cache = getCache()
      const data = cache.get()
      res.json(data)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/ideabox/ideas
  app.post('/api/ideabox/ideas', (req, res) => {
    try {
      const { title, description, source, tags, cluster } = req.body || {}
      if (!title) return res.status(400).json({ error: 'title is required' })

      const projectRoot = getProjectRoot()
      const ideaboxPath = getIdeaboxPath(projectRoot)
      const parsed = readIdeabox(projectRoot, ideaboxPath)
      addIdea(parsed, { title, description, source, tags, cluster })
      writeIdeabox(projectRoot, ideaboxPath, parsed)
      getCache().invalidate()
      broadcastUpdate()
      // Return the newly created idea
      const newIdea = parsed.ideas[parsed.ideas.length - 1]
      res.status(201).json(newIdea)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // PATCH /api/ideabox/ideas/:id
  app.patch('/api/ideabox/ideas/:id', (req, res) => {
    try {
      const { id } = req.params
      const fields = req.body || {}

      const projectRoot = getProjectRoot()
      const ideaboxPath = getIdeaboxPath(projectRoot)
      const parsed = readIdeabox(projectRoot, ideaboxPath)

      // Handle priority shortcut
      if (fields.priority) {
        setPriority(parsed, id, fields.priority)
        delete fields.priority
      }

      // Reject status changes via PATCH — must use /promote or /kill endpoints
      // to ensure proper transition logic (move to killed section, set fields, etc.)
      if (fields.status !== undefined) {
        return res.status(400).json({
          error: 'Status changes must go through /promote or /kill endpoints, not PATCH'
        })
      }

      // Handle remaining fields (no status)
      const allowed = ['title', 'description', 'source', 'tags', 'cluster', 'mapsTo', 'effort', 'impact']
      const safeFields = {}
      for (const k of allowed) {
        if (fields[k] !== undefined) safeFields[k] = fields[k]
      }
      // Validate enum fields
      if (safeFields.effort !== undefined && safeFields.effort !== null && !['S', 'M', 'L'].includes(safeFields.effort)) {
        return res.status(400).json({ error: 'effort must be S, M, L, or null' })
      }
      if (safeFields.impact !== undefined && safeFields.impact !== null && !['low', 'medium', 'high'].includes(safeFields.impact)) {
        return res.status(400).json({ error: 'impact must be low, medium, high, or null' })
      }
      if (Object.keys(safeFields).length > 0) {
        updateIdea(parsed, id, safeFields)
      }

      writeIdeabox(projectRoot, ideaboxPath, parsed)
      getCache().invalidate()
      broadcastUpdate()

      // Find and return the updated idea
      const upper = id.toUpperCase()
      const updated = [...parsed.ideas, ...parsed.killed].find(i => i.id.toUpperCase() === upper)
      res.json(updated || { id })
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 500
      res.status(status).json({ error: err.message })
    }
  })

  // POST /api/ideabox/ideas/:id/promote
  app.post('/api/ideabox/ideas/:id/promote', (req, res) => {
    try {
      const { id } = req.params
      const { featureCode } = req.body || {}

      const projectRoot = getProjectRoot()
      const ideaboxPath = getIdeaboxPath(projectRoot)
      const parsed = readIdeabox(projectRoot, ideaboxPath)

      // Find the idea before promoting (need title for feature folder seed)
      const upper = id.toUpperCase()
      const sourceIdea = parsed.ideas.find(i => i.id.toUpperCase() === upper)
      if (!sourceIdea) {
        return res.status(404).json({ error: `Idea not found: ${id}` })
      }

      // Resolve feature code: explicit, or derived from idea
      let resolvedCode = featureCode
      if (!resolvedCode) {
        const slug = sourceIdea.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20).replace(/-+$/, '')
        resolvedCode = `IDEA-${sourceIdea.num}-${slug}`.toUpperCase()
      }

      // Create feature folder + feature.json (same logic as CLI promote)
      const composeJsonPath = path.join(projectRoot, '.compose', 'compose.json')
      let featuresRel = 'docs/features'
      if (fs.existsSync(composeJsonPath)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(composeJsonPath, 'utf-8'))
          featuresRel = cfg?.paths?.features || 'docs/features'
        } catch {}
      }
      const featuresDir = path.join(projectRoot, featuresRel, resolvedCode)
      if (!fs.existsSync(featuresDir)) {
        fs.mkdirSync(featuresDir, { recursive: true })
        fs.writeFileSync(path.join(featuresDir, 'feature.json'), JSON.stringify({
          code: resolvedCode,
          description: sourceIdea.title,
          status: 'PLANNED',
          promotedFrom: sourceIdea.id,
          createdAt: new Date().toISOString(),
        }, null, 2))
      }

      promoteIdea(parsed, id, resolvedCode)
      writeIdeabox(projectRoot, ideaboxPath, parsed)
      getCache().invalidate()
      broadcastUpdate()

      const updated = parsed.ideas.find(i => i.id.toUpperCase() === upper)
      res.json({ ...(updated || { id }), featureCode: resolvedCode, featurePath: `${featuresRel}/${resolvedCode}` })
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 500
      res.status(status).json({ error: err.message })
    }
  })

  // POST /api/ideabox/ideas/:id/kill
  app.post('/api/ideabox/ideas/:id/kill', (req, res) => {
    try {
      const { id } = req.params
      const { reason } = req.body || {}

      const projectRoot = getProjectRoot()
      const ideaboxPath = getIdeaboxPath(projectRoot)
      const parsed = readIdeabox(projectRoot, ideaboxPath)
      killIdea(parsed, id, reason || '')
      writeIdeabox(projectRoot, ideaboxPath, parsed)
      getCache().invalidate()
      broadcastUpdate()

      const upper = id.toUpperCase()
      const killed = parsed.killed.find(i => i.id.toUpperCase() === upper)
      res.json(killed || { id })
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 500
      res.status(status).json({ error: err.message })
    }
  })

  // POST /api/ideabox/ideas/:id/resurrect
  app.post('/api/ideabox/ideas/:id/resurrect', (req, res) => {
    try {
      const { id } = req.params
      const projectRoot = getProjectRoot()
      const ideaboxPath = getIdeaboxPath(projectRoot)
      const parsed = readIdeabox(projectRoot, ideaboxPath)
      resurrectIdea(parsed, id)
      writeIdeabox(projectRoot, ideaboxPath, parsed)
      getCache().invalidate()
      broadcastUpdate()

      const upper = id.toUpperCase()
      const restored = parsed.ideas.find(i => i.id.toUpperCase() === upper)
      res.json(restored || { id })
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 500
      res.status(status).json({ error: err.message })
    }
  })

  // POST /api/ideabox/ideas/:id/discuss
  app.post('/api/ideabox/ideas/:id/discuss', (req, res) => {
    try {
      const { id } = req.params
      const { author, text } = req.body || {}
      if (!author) return res.status(400).json({ error: 'author is required' })
      if (!text) return res.status(400).json({ error: 'text is required' })

      const projectRoot = getProjectRoot()
      const ideaboxPath = getIdeaboxPath(projectRoot)
      const parsed = readIdeabox(projectRoot, ideaboxPath)
      addDiscussion(parsed, id, author, text)
      writeIdeabox(projectRoot, ideaboxPath, parsed)
      getCache().invalidate()
      broadcastUpdate()

      const upper = id.toUpperCase()
      const updated = [...parsed.ideas, ...parsed.killed].find(i => i.id.toUpperCase() === upper)
      res.status(201).json(updated || { id })
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 500
      res.status(status).json({ error: err.message })
    }
  })

  // DELETE /api/ideabox/ideas/:id — not allowed
  app.delete('/api/ideabox/ideas/:id', (_req, res) => {
    res.status(405).json({ error: 'Deletion not allowed. Use POST /api/ideabox/ideas/:id/kill instead.' })
  })
}

// ---------------------------------------------------------------------------
// Internal: load compose.json config
// ---------------------------------------------------------------------------

function loadConfig(projectRoot) {
  const configPath = path.join(projectRoot, '.compose', 'compose.json')
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  } catch {
    return null
  }
}
