/**
 * server/ideabox-cache.js — JSON cache for ideabox data.
 *
 * Cache lives at .compose/data/ideabox-cache.json.
 * Invalidated when the source file's mtime changes.
 */

import fs from 'node:fs'
import path from 'node:path'
import { parseIdeabox } from '../lib/ideabox.js'

export class IdeaboxCache {
  /**
   * @param {string} dataDir   — absolute path to .compose/data/
   * @param {string} sourceFile — absolute path to ideabox.md
   */
  constructor(dataDir, sourceFile) {
    this._dataDir = dataDir
    this._sourceFile = sourceFile
    this._cachePath = path.join(dataDir, 'ideabox-cache.json')
    this._cachedMtime = null
    this._cachedData = null
  }

  /**
   * Return parsed ideabox data, using cache when source file is unchanged.
   * @returns {{ ideas, killed, nextId, _mtime: number }}
   */
  get() {
    let sourceMtime = null
    try {
      const stat = fs.statSync(this._sourceFile)
      sourceMtime = stat.mtimeMs
    } catch {
      // Source file missing — return empty
      return { ideas: [], killed: [], nextId: 1, _mtime: null }
    }

    // Cache hit
    if (this._cachedData && this._cachedMtime === sourceMtime) {
      return this._cachedData
    }

    // Load from disk cache if mtime matches
    if (fs.existsSync(this._cachePath)) {
      try {
        const disk = JSON.parse(fs.readFileSync(this._cachePath, 'utf-8'))
        if (disk._mtime === sourceMtime) {
          this._cachedMtime = sourceMtime
          this._cachedData = disk
          return disk
        }
      } catch { /* stale or corrupt — reparse */ }
    }

    // Parse fresh
    const markdown = fs.readFileSync(this._sourceFile, 'utf-8')
    const parsed = parseIdeabox(markdown)
    const entry = { ...parsed, _mtime: sourceMtime }

    // Write to disk cache
    try {
      fs.mkdirSync(this._dataDir, { recursive: true })
      fs.writeFileSync(this._cachePath, JSON.stringify(entry, null, 2))
    } catch { /* non-fatal */ }

    this._cachedMtime = sourceMtime
    this._cachedData = entry
    return entry
  }

  /** Invalidate in-memory cache (e.g., after a write). */
  invalidate() {
    this._cachedMtime = null
    this._cachedData = null
  }
}
