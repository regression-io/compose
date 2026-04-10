/**
 * lib/ideabox.js — Ideabox markdown parser, writer, and mutation helpers.
 *
 * Format reference: SmartMemory ideabox.md canonical format.
 * Each idea is an H4 entry under an H3 cluster inside the ## Ideas section.
 *
 * #### IDEA-N — <title>
 * **Status:** NEW | **Priority:** P1 | **Tags:** `#tag`
 * **Source:** <source text>
 * **Idea:** <description prose>
 * **Maps to:** <optional cross-refs>
 *
 * KILLED ideas end up under ## Killed Ideas with:
 * **Killed:** <date> — <reason>
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

// ---------------------------------------------------------------------------
// Default template
// ---------------------------------------------------------------------------

export const IDEABOX_TEMPLATE = `# Ideabox

**Purpose:** Capture raw ideas before they're ready for the roadmap.

## Conventions
- **ID:** \`IDEA-N\` (sequential, never reuse)
- **Status:** \`NEW\` | \`DISCUSSING\` | \`PROMOTED\` | \`KILLED\`
- **Priority:** \`P0\` (promote now) | \`P1\` (next up) | \`P2\` (backlog) | \`—\` (untriaged)
- **Source:** Where the idea came from
- **Tags:** \`#ux\` \`#core\` \`#distribution\` \`#integration\` \`#research\` \`#infra\`

## Ideas

<!-- Ideas grouped by potential feature cluster -->

## Killed Ideas
`

// ---------------------------------------------------------------------------
// Regex helpers
// ---------------------------------------------------------------------------

// Matches: #### IDEA-42 — Some Title   (or "- " variant)
const IDEA_HEADING_RE = /^####\s+(IDEA-(\d+))\s+[—–-]+\s+(.+)$/

// Matches a field line: **FieldName:** value  (colon inside bold markers)
const FIELD_RE = /^\*\*([^*:]+):\*\*\s*(.*)$/

// Matches a discussion entry: - [2026-04-10] author: text
const DISCUSSION_ENTRY_RE = /^-\s+\[(\d{4}-\d{2}-\d{2})\]\s+(\w+):\s+(.+)$/

// ---------------------------------------------------------------------------
// parseIdeabox(markdown) → { ideas, killed, nextId }
// ---------------------------------------------------------------------------

/**
 * Parse ideabox markdown into structured data.
 * @param {string} markdown
 * @returns {{ ideas: IdeaEntry[], killed: IdeaEntry[], nextId: number }}
 */
export function parseIdeabox(markdown) {
  const lines = markdown.split('\n')

  const ideas = []
  const killed = []

  let inIdeasSection = false
  let inKilledSection = false
  let currentCluster = null
  let currentIdea = null

  function flushCurrentIdea() {
    if (!currentIdea) return
    // Remove internal parsing state before pushing
    delete currentIdea._inDiscussion
    if (inKilledSection) {
      killed.push(currentIdea)
    } else {
      ideas.push(currentIdea)
    }
    currentIdea = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Detect section boundaries
    if (/^##\s+Ideas/.test(line)) {
      flushCurrentIdea()
      inIdeasSection = true
      inKilledSection = false
      currentCluster = null
      continue
    }
    if (/^##\s+Killed\s+Ideas/.test(line)) {
      flushCurrentIdea()
      inIdeasSection = false
      inKilledSection = true
      currentCluster = null
      continue
    }
    // Other H2 sections end both
    if (/^##\s/.test(line) && !(/^##\s+Ideas/.test(line)) && !(/^##\s+Killed\s+Ideas/.test(line))) {
      flushCurrentIdea()
      inIdeasSection = false
      inKilledSection = false
      continue
    }

    if (!inIdeasSection && !inKilledSection) continue

    // H3 = cluster heading
    if (/^###\s/.test(line)) {
      flushCurrentIdea()
      currentCluster = line.replace(/^###\s+/, '').trim()
      continue
    }

    // H4 = idea heading
    const headingMatch = line.match(IDEA_HEADING_RE)
    if (headingMatch) {
      flushCurrentIdea()
      currentIdea = {
        id: headingMatch[1],            // "IDEA-42"
        num: parseInt(headingMatch[2], 10),
        title: headingMatch[3].trim(),
        status: 'NEW',
        priority: '—',
        tags: [],
        source: '',
        description: '',
        cluster: currentCluster || null,
        mapsTo: '',
        killedReason: '',
        killedDate: '',
        effort: null,
        impact: null,
        discussion: [],
        // raw fields for round-trip fidelity
        _extraLines: [],
        _inDiscussion: false,
      }
      continue
    }

    if (!currentIdea) continue

    // Discussion header line: **Discussion:**  (must check before general FIELD_RE)
    if (line.trim() === '**Discussion:**') {
      currentIdea._inDiscussion = true
      continue
    }

    // Field lines
    const fieldMatch = line.match(FIELD_RE)
    if (fieldMatch) {
      const key = fieldMatch[1].trim()
      const val = fieldMatch[2].trim()

      if (key === 'Status') {
        // Handle inline: "NEW | **Priority:** P1 | **Tags:** `#tag`"
        // or just: "PROMOTED (→ FEAT-1)"
        // Split on | to get multiple fields on one line
        const parts = val.split('|').map(p => p.trim())
        for (const part of parts) {
          const inlineField = part.match(FIELD_RE)
          if (inlineField) {
            applyField(currentIdea, inlineField[1].trim(), inlineField[2].trim())
          } else {
            // The status itself
            currentIdea.status = extractStatus(part)
          }
        }
      } else {
        applyField(currentIdea, key, val)
      }
      continue
    }

    // Discussion entry: - [date] author: text
    if (currentIdea._inDiscussion) {
      const discMatch = line.match(DISCUSSION_ENTRY_RE)
      if (discMatch) {
        currentIdea.discussion.push({
          date: discMatch[1],
          author: discMatch[2],
          text: discMatch[3].trim(),
        })
        continue
      }
      // Empty line in discussion block — stay in discussion mode
      if (!line.trim()) continue
      // Non-matching non-empty line → exit discussion mode, fall through
      currentIdea._inDiscussion = false
    }

    // Non-empty lines after the heading = extra content (description overflow, etc.)
    if (line.trim()) {
      currentIdea._extraLines.push(line)
    }
  }

  flushCurrentIdea()

  // Compute nextId
  const allNums = [...ideas, ...killed].map(i => i.num).filter(n => !isNaN(n))
  const maxNum = allNums.length ? Math.max(...allNums) : 0
  const nextId = maxNum + 1

  return { ideas, killed, nextId }
}

function extractStatus(raw) {
  const val = raw.toUpperCase()
  if (val.startsWith('NEW')) return 'NEW'
  if (val.startsWith('DISCUSSING')) return 'DISCUSSING'
  if (val.startsWith('PROMOTED')) return raw // preserve "(→ FEAT-1)" suffix
  if (val.startsWith('KILLED')) return 'KILLED'
  return raw.trim()
}

function applyField(idea, key, val) {
  switch (key) {
    case 'Status':
      idea.status = extractStatus(val)
      break
    case 'Priority':
      idea.priority = val.replace(/`/g, '').trim() || '—'
      break
    case 'Tags':
      idea.tags = (val.match(/#\w+/g) || [])
      break
    case 'Source':
      idea.source = val
      break
    case 'Idea':
      idea.description = val
      break
    case 'Maps to':
    case 'Maps To':
      idea.mapsTo = val
      break
    case 'Effort':
      // Validate: only S/M/L allowed, anything else becomes null
      idea.effort = ['S', 'M', 'L'].includes(val) ? val : null
      break
    case 'Impact':
      // Validate: only low/medium/high allowed
      idea.impact = ['low', 'medium', 'high'].includes(val) ? val : null
      break
    case 'Killed':
      // "2026-04-09 — reason text"
      {
        const m = val.match(/^(\S+)\s+[—–-]+\s+(.+)$/)
        if (m) {
          idea.killedDate = m[1]
          idea.killedReason = m[2]
        } else {
          idea.killedReason = val
        }
        idea.status = 'KILLED'
      }
      break
    default:
      // Store unknown fields in extra lines for round-trip
      idea._extraLines.push(`**${key}:** ${val}`)
  }
}

// ---------------------------------------------------------------------------
// serializeIdeabox(parsedData) → markdown string
// ---------------------------------------------------------------------------

/**
 * Serialize parsed ideabox data back to markdown.
 * @param {{ ideas: IdeaEntry[], killed: IdeaEntry[], nextId: number }} parsedData
 * @returns {string}
 */
export function serializeIdeabox({ ideas, killed }) {
  const lines = []

  lines.push('# Ideabox')
  lines.push('')
  lines.push('**Purpose:** Capture raw ideas before they\'re ready for the roadmap.')
  lines.push('')
  lines.push('## Conventions')
  lines.push('- **ID:** `IDEA-N` (sequential, never reuse)')
  lines.push('- **Status:** `NEW` | `DISCUSSING` | `PROMOTED` | `KILLED`')
  lines.push('- **Priority:** `P0` (promote now) | `P1` (next up) | `P2` (backlog) | `—` (untriaged)')
  lines.push('- **Source:** Where the idea came from')
  lines.push('- **Tags:** `#ux` `#core` `#distribution` `#integration` `#research` `#infra`')
  lines.push('')
  lines.push('## Ideas')
  lines.push('')
  lines.push('<!-- Ideas grouped by potential feature cluster -->')
  lines.push('')

  // Group active ideas by cluster
  const clusters = new Map()
  const unclustered = []
  for (const idea of ideas) {
    if (idea.cluster) {
      if (!clusters.has(idea.cluster)) clusters.set(idea.cluster, [])
      clusters.get(idea.cluster).push(idea)
    } else {
      unclustered.push(idea)
    }
  }

  for (const [cluster, clusterIdeas] of clusters) {
    lines.push(`### ${cluster}`)
    lines.push('')
    for (const idea of clusterIdeas) {
      lines.push(...serializeIdea(idea))
    }
  }

  if (unclustered.length > 0) {
    for (const idea of unclustered) {
      lines.push(...serializeIdea(idea))
    }
  }

  lines.push('## Killed Ideas')
  lines.push('')

  for (const idea of killed) {
    lines.push(...serializeKilledIdea(idea))
  }

  return lines.join('\n')
}

function serializeIdea(idea) {
  const out = []
  out.push(`#### ${idea.id} — ${idea.title}`)

  // Build status line
  const tagStr = idea.tags.length ? ` | **Tags:** ${idea.tags.join(' ')}` : ''
  const statusStr = idea.status.startsWith('PROMOTED')
    ? idea.status
    : idea.status
  out.push(`**Status:** ${statusStr} | **Priority:** ${idea.priority}${tagStr}`)

  if (idea.source) out.push(`**Source:** ${idea.source}`)
  if (idea.description) out.push(`**Idea:** ${idea.description}`)
  if (idea.mapsTo) out.push(`**Maps to:** ${idea.mapsTo}`)
  if (idea.effort) out.push(`**Effort:** ${idea.effort}`)
  if (idea.impact) out.push(`**Impact:** ${idea.impact}`)

  for (const extra of (idea._extraLines || [])) {
    out.push(extra)
  }

  // Discussion thread
  if (idea.discussion && idea.discussion.length > 0) {
    out.push('**Discussion:**')
    for (const entry of idea.discussion) {
      out.push(`- [${entry.date}] ${entry.author}: ${entry.text}`)
    }
  }

  out.push('')
  return out
}

function serializeKilledIdea(idea) {
  const out = []
  out.push(`#### ${idea.id} — ${idea.title}`)

  const tagStr = idea.tags.length ? ` | **Tags:** ${idea.tags.join(' ')}` : ''
  out.push(`**Status:** KILLED${tagStr}`)

  if (idea.source) out.push(`**Source:** ${idea.source}`)
  if (idea.description) out.push(`**Idea:** ${idea.description}`)
  if (idea.mapsTo) out.push(`**Maps to:** ${idea.mapsTo}`)
  if (idea.effort) out.push(`**Effort:** ${idea.effort}`)
  if (idea.impact) out.push(`**Impact:** ${idea.impact}`)

  const date = idea.killedDate || new Date().toISOString().slice(0, 10)
  const reason = idea.killedReason || '(no reason given)'
  out.push(`**Killed:** ${date} — ${reason}`)

  for (const extra of (idea._extraLines || [])) {
    out.push(extra)
  }

  // Discussion thread
  if (idea.discussion && idea.discussion.length > 0) {
    out.push('**Discussion:**')
    for (const entry of idea.discussion) {
      out.push(`- [${entry.date}] ${entry.author}: ${entry.text}`)
    }
  }

  out.push('')
  return out
}

// ---------------------------------------------------------------------------
// Mutation helpers
// ---------------------------------------------------------------------------

/**
 * Add a new idea. Mutates parsedData in place and returns it.
 */
export function addIdea(parsedData, { title, description = '', source = '', tags = [], cluster = null, effort = null, impact = null }) {
  const id = `IDEA-${parsedData.nextId}`
  const idea = {
    id,
    num: parsedData.nextId,
    title,
    status: 'NEW',
    priority: '—',
    tags: Array.isArray(tags) ? tags : [],
    source,
    description,
    cluster: cluster || null,
    mapsTo: '',
    killedReason: '',
    killedDate: '',
    effort,
    impact,
    discussion: [],
    _extraLines: [],
  }
  parsedData.ideas.push(idea)
  parsedData.nextId += 1
  return parsedData
}

/**
 * Promote an idea: mark PROMOTED, optionally reference a feature code.
 */
export function promoteIdea(parsedData, ideaId, featureCode = '') {
  const idea = findIdea(parsedData, ideaId)
  if (!idea) throw new Error(`Idea not found: ${ideaId}`)
  const ref = featureCode ? ` (→ ${featureCode})` : ''
  idea.status = `PROMOTED${ref}`
  return parsedData
}

/**
 * Kill an idea: move from ideas → killed with reason + date.
 */
export function killIdea(parsedData, ideaId, reason = '') {
  const idx = parsedData.ideas.findIndex(i => i.id.toUpperCase() === ideaId.toUpperCase())
  if (idx === -1) {
    // Already in killed? No-op.
    const inKilled = parsedData.killed.find(i => i.id.toUpperCase() === ideaId.toUpperCase())
    if (inKilled) return parsedData
    throw new Error(`Idea not found: ${ideaId}`)
  }
  const [idea] = parsedData.ideas.splice(idx, 1)
  idea.status = 'KILLED'
  idea.killedReason = reason
  idea.killedDate = new Date().toISOString().slice(0, 10)
  parsedData.killed.push(idea)
  return parsedData
}

/**
 * Resurrect a killed idea: move from killed → ideas, reset status to NEW.
 */
export function resurrectIdea(parsedData, ideaId) {
  const idx = parsedData.killed.findIndex(i => i.id.toUpperCase() === ideaId.toUpperCase())
  if (idx === -1) throw new Error(`Killed idea not found: ${ideaId}`)
  const [idea] = parsedData.killed.splice(idx, 1)
  idea.status = 'NEW'
  delete idea.killedReason
  delete idea.killedDate
  parsedData.ideas.push(idea)
  return parsedData
}

/**
 * Set priority on an idea.
 */
export function setPriority(parsedData, ideaId, priority) {
  const valid = ['P0', 'P1', 'P2', '—']
  if (!valid.includes(priority)) throw new Error(`Invalid priority: ${priority}. Must be P0, P1, P2, or —`)
  const idea = findIdea(parsedData, ideaId)
  if (!idea) throw new Error(`Idea not found: ${ideaId}`)
  idea.priority = priority
  return parsedData
}

/**
 * Update arbitrary fields on an idea (status, source, description, tags, cluster).
 */
export function updateIdea(parsedData, ideaId, fields) {
  const idea = findIdea(parsedData, ideaId)
  if (!idea) throw new Error(`Idea not found: ${ideaId}`)
  Object.assign(idea, fields)
  return parsedData
}

/**
 * Append a discussion entry to an idea.
 * @param {object} parsedData
 * @param {string} ideaId     e.g. "IDEA-3"
 * @param {string} author     e.g. "human" or "agent"
 * @param {string} text       Comment text
 */
export function addDiscussion(parsedData, ideaId, author, text) {
  const idea = findIdea(parsedData, ideaId)
  if (!idea) throw new Error(`Idea not found: ${ideaId}`)
  if (!idea.discussion) idea.discussion = []
  idea.discussion.push({
    date: new Date().toISOString().slice(0, 10),
    author,
    text,
  })
  return parsedData
}

// ---------------------------------------------------------------------------
// Lens support (Item 180)
// ---------------------------------------------------------------------------

/**
 * Load a priority lens from docs/product/ideabox-priority-<lensName>.md.
 * Returns lens metadata or null if not found.
 */
export function loadLens(cwd, lensName) {
  const lensPath = join(cwd, 'docs', 'product', `ideabox-priority-${lensName}.md`)
  if (!existsSync(lensPath)) return null
  const content = readFileSync(lensPath, 'utf-8')
  return { name: lensName, path: lensPath, content }
}

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse the ideabox file from the project.
 */
export function readIdeabox(cwd, ideaboxPath) {
  const fullPath = join(cwd, ideaboxPath)
  if (!existsSync(fullPath)) {
    // Return empty state
    return { ideas: [], killed: [], nextId: 1 }
  }
  const markdown = readFileSync(fullPath, 'utf-8')
  return parseIdeabox(markdown)
}

/**
 * Write serialized ideabox back to disk.
 */
export function writeIdeabox(cwd, ideaboxPath, parsedData) {
  const fullPath = join(cwd, ideaboxPath)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, serializeIdeabox(parsedData))
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function findIdea(parsedData, ideaId) {
  const upper = ideaId.toUpperCase()
  return parsedData.ideas.find(i => i.id.toUpperCase() === upper)
    || parsedData.killed.find(i => i.id.toUpperCase() === upper)
    || null
}
