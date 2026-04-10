/**
 * test/ideabox.test.js — Parser round-trip, mutations, edge cases.
 *
 * Tests:
 *   - parseIdeabox: basic parsing, status, priority, tags, source, cluster
 *   - serializeIdeabox: round-trip fidelity
 *   - addIdea: ID sequencing, fields
 *   - promoteIdea: status update with feature code
 *   - killIdea: moves to killed section
 *   - setPriority: valid and invalid
 *   - Edge cases: empty file, malformed entries, missing sections
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseIdeabox,
  serializeIdeabox,
  addIdea,
  promoteIdea,
  killIdea,
  resurrectIdea,
  setPriority,
  updateIdea,
  addDiscussion,
  IDEABOX_TEMPLATE,
} from '../lib/ideabox.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MINIMAL = `# Ideabox

## Ideas

#### IDEA-1 — Fast search indexing
**Status:** NEW | **Priority:** P1 | **Tags:** \`#core\`
**Source:** Internal session (2026-01-01)
**Idea:** Index documents on write for sub-100ms search.

#### IDEA-2 — Dark mode
**Status:** NEW | **Priority:** P2 | **Tags:** \`#ux\`
**Source:** User request
**Idea:** Toggle dark/light theme.

## Killed Ideas

#### IDEA-3 — Blockchain integration
**Status:** KILLED | **Tags:** \`#infra\`
**Source:** Brainstorm
**Idea:** Use blockchain for audit trail.
**Killed:** 2026-01-15 — Overkill for the use case.
`

const CLUSTERED = `# Ideabox

## Ideas

### Search Features

#### IDEA-1 — Full-text search
**Status:** NEW | **Priority:** P1 | **Tags:** \`#core\`
**Source:** User research
**Idea:** Full text search across all documents.

### UI Polish

#### IDEA-2 — Animated transitions
**Status:** NEW | **Priority:** P2 | **Tags:** \`#ux\`
**Source:** Design review
**Idea:** Smooth page transitions.

## Killed Ideas
`

const PROMOTED_EXAMPLE = `# Ideabox

## Ideas

#### IDEA-1 — Realtime sync
**Status:** PROMOTED (→ SYNC-1) | **Tags:** \`#core\`
**Source:** V2 planning

## Killed Ideas
`

// ---------------------------------------------------------------------------
// parseIdeabox
// ---------------------------------------------------------------------------

describe('parseIdeabox', () => {
  it('parses basic ideas', () => {
    const { ideas, killed, nextId } = parseIdeabox(MINIMAL)
    assert.equal(ideas.length, 2)
    assert.equal(killed.length, 1)
    assert.equal(nextId, 4)
  })

  it('extracts idea ID, title, status, priority', () => {
    const { ideas } = parseIdeabox(MINIMAL)
    const idea1 = ideas[0]
    assert.equal(idea1.id, 'IDEA-1')
    assert.equal(idea1.num, 1)
    assert.equal(idea1.title, 'Fast search indexing')
    assert.equal(idea1.status, 'NEW')
    assert.equal(idea1.priority, 'P1')
  })

  it('extracts tags as array', () => {
    const { ideas } = parseIdeabox(MINIMAL)
    assert.deepEqual(ideas[0].tags, ['#core'])
    assert.deepEqual(ideas[1].tags, ['#ux'])
  })

  it('extracts source and description', () => {
    const { ideas } = parseIdeabox(MINIMAL)
    assert.equal(ideas[0].source, 'Internal session (2026-01-01)')
    assert.equal(ideas[0].description, 'Index documents on write for sub-100ms search.')
  })

  it('parses killed ideas with reason and date', () => {
    const { killed } = parseIdeabox(MINIMAL)
    const k = killed[0]
    assert.equal(k.id, 'IDEA-3')
    assert.equal(k.status, 'KILLED')
    assert.equal(k.killedReason, 'Overkill for the use case.')
    assert.equal(k.killedDate, '2026-01-15')
  })

  it('extracts cluster from H3 headings', () => {
    const { ideas } = parseIdeabox(CLUSTERED)
    assert.equal(ideas[0].cluster, 'Search Features')
    assert.equal(ideas[1].cluster, 'UI Polish')
  })

  it('parses PROMOTED status with feature reference', () => {
    const { ideas } = parseIdeabox(PROMOTED_EXAMPLE)
    assert.equal(ideas[0].status, 'PROMOTED (→ SYNC-1)')
  })

  it('computes nextId as max+1', () => {
    const { nextId } = parseIdeabox(MINIMAL)
    assert.equal(nextId, 4) // max is IDEA-3
  })

  it('returns nextId=1 for empty ideabox', () => {
    const { ideas, killed, nextId } = parseIdeabox(IDEABOX_TEMPLATE)
    assert.equal(ideas.length, 0)
    assert.equal(killed.length, 0)
    assert.equal(nextId, 1)
  })

  it('handles empty string gracefully', () => {
    const { ideas, killed, nextId } = parseIdeabox('')
    assert.equal(ideas.length, 0)
    assert.equal(killed.length, 0)
    assert.equal(nextId, 1)
  })

  it('handles malformed entry (no status line) without crashing', () => {
    const md = `# Ideabox\n\n## Ideas\n\n#### IDEA-1 — Some idea\n\n## Killed Ideas\n`
    const { ideas } = parseIdeabox(md)
    assert.equal(ideas.length, 1)
    assert.equal(ideas[0].status, 'NEW') // default
  })

  it('handles untriaged priority (dash)', () => {
    const md = `# Ideabox\n\n## Ideas\n\n#### IDEA-1 — No priority\n**Status:** NEW | **Priority:** —\n\n## Killed Ideas\n`
    const { ideas } = parseIdeabox(md)
    assert.equal(ideas[0].priority, '—')
  })
})

// ---------------------------------------------------------------------------
// serializeIdeabox — round-trip
// ---------------------------------------------------------------------------

describe('serializeIdeabox', () => {
  it('round-trips parse → serialize → parse', () => {
    const parsed1 = parseIdeabox(MINIMAL)
    const md2 = serializeIdeabox(parsed1)
    const parsed2 = parseIdeabox(md2)

    assert.equal(parsed2.ideas.length, parsed1.ideas.length)
    assert.equal(parsed2.killed.length, parsed1.killed.length)

    // Key fields preserved
    assert.equal(parsed2.ideas[0].id, parsed1.ideas[0].id)
    assert.equal(parsed2.ideas[0].title, parsed1.ideas[0].title)
    assert.equal(parsed2.ideas[0].status, parsed1.ideas[0].status)
    assert.equal(parsed2.ideas[0].priority, parsed1.ideas[0].priority)
    assert.deepEqual(parsed2.ideas[0].tags, parsed1.ideas[0].tags)
    assert.equal(parsed2.ideas[0].source, parsed1.ideas[0].source)
    assert.equal(parsed2.ideas[0].description, parsed1.ideas[0].description)
  })

  it('preserves killed idea reason and date after round-trip', () => {
    const parsed1 = parseIdeabox(MINIMAL)
    const md2 = serializeIdeabox(parsed1)
    const parsed2 = parseIdeabox(md2)

    const k1 = parsed1.killed[0]
    const k2 = parsed2.killed[0]
    assert.equal(k2.killedReason, k1.killedReason)
    assert.equal(k2.killedDate, k1.killedDate)
  })

  it('round-trips clustered ideas preserving cluster names', () => {
    const parsed1 = parseIdeabox(CLUSTERED)
    const md2 = serializeIdeabox(parsed1)
    const parsed2 = parseIdeabox(md2)

    assert.equal(parsed2.ideas[0].cluster, 'Search Features')
    assert.equal(parsed2.ideas[1].cluster, 'UI Polish')
  })

  it('produces valid markdown with required sections', () => {
    const parsed = parseIdeabox(MINIMAL)
    const md = serializeIdeabox(parsed)
    assert.ok(md.includes('# Ideabox'))
    assert.ok(md.includes('## Ideas'))
    assert.ok(md.includes('## Killed Ideas'))
  })
})

// ---------------------------------------------------------------------------
// addIdea
// ---------------------------------------------------------------------------

describe('addIdea', () => {
  it('adds an idea with sequential ID', () => {
    const parsed = parseIdeabox(MINIMAL)
    addIdea(parsed, { title: 'New feature' })
    assert.equal(parsed.ideas[parsed.ideas.length - 1].id, 'IDEA-4')
    assert.equal(parsed.nextId, 5)
  })

  it('increments nextId on each add', () => {
    const parsed = parseIdeabox(IDEABOX_TEMPLATE)
    addIdea(parsed, { title: 'First' })
    addIdea(parsed, { title: 'Second' })
    addIdea(parsed, { title: 'Third' })
    assert.equal(parsed.ideas[0].id, 'IDEA-1')
    assert.equal(parsed.ideas[1].id, 'IDEA-2')
    assert.equal(parsed.ideas[2].id, 'IDEA-3')
    assert.equal(parsed.nextId, 4)
  })

  it('sets default status NEW and priority —', () => {
    const parsed = parseIdeabox(IDEABOX_TEMPLATE)
    addIdea(parsed, { title: 'Test idea' })
    const idea = parsed.ideas[0]
    assert.equal(idea.status, 'NEW')
    assert.equal(idea.priority, '—')
  })

  it('stores provided description, source, tags, cluster', () => {
    const parsed = parseIdeabox(IDEABOX_TEMPLATE)
    addIdea(parsed, {
      title: 'My idea',
      description: 'Detailed description',
      source: 'Session insight',
      tags: ['#ux', '#core'],
      cluster: 'Performance',
    })
    const idea = parsed.ideas[0]
    assert.equal(idea.description, 'Detailed description')
    assert.equal(idea.source, 'Session insight')
    assert.deepEqual(idea.tags, ['#ux', '#core'])
    assert.equal(idea.cluster, 'Performance')
  })

  it('does not reuse IDs from killed ideas', () => {
    // MINIMAL has IDEA-1, IDEA-2 (active) and IDEA-3 (killed) → nextId=4
    const parsed = parseIdeabox(MINIMAL)
    addIdea(parsed, { title: 'New' })
    assert.equal(parsed.ideas[parsed.ideas.length - 1].id, 'IDEA-4')
  })
})

// ---------------------------------------------------------------------------
// promoteIdea
// ---------------------------------------------------------------------------

describe('promoteIdea', () => {
  it('marks idea as PROMOTED with feature code', () => {
    const parsed = parseIdeabox(MINIMAL)
    promoteIdea(parsed, 'IDEA-1', 'SEARCH-1')
    assert.equal(parsed.ideas[0].status, 'PROMOTED (→ SEARCH-1)')
  })

  it('marks idea as PROMOTED without feature code', () => {
    const parsed = parseIdeabox(MINIMAL)
    promoteIdea(parsed, 'IDEA-1')
    assert.equal(parsed.ideas[0].status, 'PROMOTED')
  })

  it('is case-insensitive for ID lookup', () => {
    const parsed = parseIdeabox(MINIMAL)
    promoteIdea(parsed, 'idea-1', 'FEAT-99')
    assert.equal(parsed.ideas[0].status, 'PROMOTED (→ FEAT-99)')
  })

  it('throws if idea not found', () => {
    const parsed = parseIdeabox(MINIMAL)
    assert.throws(() => promoteIdea(parsed, 'IDEA-999'), /not found/)
  })

  it('idea stays in ideas array after promotion (not moved)', () => {
    const parsed = parseIdeabox(MINIMAL)
    const countBefore = parsed.ideas.length
    promoteIdea(parsed, 'IDEA-1', 'FEAT-1')
    assert.equal(parsed.ideas.length, countBefore)
  })
})

// ---------------------------------------------------------------------------
// killIdea
// ---------------------------------------------------------------------------

describe('killIdea', () => {
  it('moves idea from ideas to killed', () => {
    const parsed = parseIdeabox(MINIMAL)
    const ideasBefore = parsed.ideas.length
    const killedBefore = parsed.killed.length
    killIdea(parsed, 'IDEA-1', 'Not needed')
    assert.equal(parsed.ideas.length, ideasBefore - 1)
    assert.equal(parsed.killed.length, killedBefore + 1)
  })

  it('sets killedReason and killedDate', () => {
    const parsed = parseIdeabox(MINIMAL)
    killIdea(parsed, 'IDEA-1', 'Duplicate idea')
    const killed = parsed.killed.find(k => k.id === 'IDEA-1')
    assert.ok(killed)
    assert.equal(killed.killedReason, 'Duplicate idea')
    assert.ok(killed.killedDate) // has a date
    assert.ok(killed.killedDate.match(/^\d{4}-\d{2}-\d{2}$/))
  })

  it('sets status to KILLED', () => {
    const parsed = parseIdeabox(MINIMAL)
    killIdea(parsed, 'IDEA-2', 'Not a priority')
    const killed = parsed.killed.find(k => k.id === 'IDEA-2')
    assert.equal(killed.status, 'KILLED')
  })

  it('throws if idea not found in either list', () => {
    const parsed = parseIdeabox(MINIMAL)
    assert.throws(() => killIdea(parsed, 'IDEA-999', 'reason'), /not found/)
  })

  it('is idempotent for already-killed ideas', () => {
    const parsed = parseIdeabox(MINIMAL)
    // IDEA-3 is already in killed
    assert.doesNotThrow(() => killIdea(parsed, 'IDEA-3', 'already killed'))
  })

  it('round-trips correctly after kill', () => {
    const parsed = parseIdeabox(MINIMAL)
    killIdea(parsed, 'IDEA-1', 'test reason')
    const md = serializeIdeabox(parsed)
    const reparsed = parseIdeabox(md)
    const k = reparsed.killed.find(k => k.id === 'IDEA-1')
    assert.ok(k)
    assert.equal(k.killedReason, 'test reason')
  })
})

// ---------------------------------------------------------------------------
// setPriority
// ---------------------------------------------------------------------------

describe('setPriority', () => {
  it('sets P0 priority', () => {
    const parsed = parseIdeabox(MINIMAL)
    setPriority(parsed, 'IDEA-1', 'P0')
    assert.equal(parsed.ideas[0].priority, 'P0')
  })

  it('sets P1 priority', () => {
    const parsed = parseIdeabox(MINIMAL)
    setPriority(parsed, 'IDEA-2', 'P1')
    const idea = parsed.ideas.find(i => i.id === 'IDEA-2')
    assert.equal(idea.priority, 'P1')
  })

  it('sets — (untriaged) priority', () => {
    const parsed = parseIdeabox(MINIMAL)
    setPriority(parsed, 'IDEA-1', '—')
    assert.equal(parsed.ideas[0].priority, '—')
  })

  it('throws on invalid priority', () => {
    const parsed = parseIdeabox(MINIMAL)
    assert.throws(() => setPriority(parsed, 'IDEA-1', 'P3'), /Invalid priority/)
    assert.throws(() => setPriority(parsed, 'IDEA-1', 'high'), /Invalid priority/)
  })

  it('throws if idea not found', () => {
    const parsed = parseIdeabox(MINIMAL)
    assert.throws(() => setPriority(parsed, 'IDEA-999', 'P1'), /not found/)
  })

  it('round-trips after priority change', () => {
    const parsed = parseIdeabox(MINIMAL)
    setPriority(parsed, 'IDEA-1', 'P0')
    const md = serializeIdeabox(parsed)
    const reparsed = parseIdeabox(md)
    assert.equal(reparsed.ideas[0].priority, 'P0')
  })
})

// ---------------------------------------------------------------------------
// ID sequencing
// ---------------------------------------------------------------------------

describe('ID sequencing', () => {
  it('nextId accounts for gaps in sequence', () => {
    const md = `# Ideabox\n\n## Ideas\n\n#### IDEA-5 — Jump\n**Status:** NEW | **Priority:** P1\n\n## Killed Ideas\n`
    const { nextId } = parseIdeabox(md)
    assert.equal(nextId, 6)
  })

  it('IDs from killed ideas count toward nextId', () => {
    // MINIMAL has active IDEA-1, IDEA-2 and killed IDEA-3
    const { nextId } = parseIdeabox(MINIMAL)
    assert.equal(nextId, 4)
  })

  it('multiple adds produce strictly sequential IDs', () => {
    const parsed = { ideas: [], killed: [], nextId: 10 }
    addIdea(parsed, { title: 'A' })
    addIdea(parsed, { title: 'B' })
    addIdea(parsed, { title: 'C' })
    assert.equal(parsed.ideas[0].id, 'IDEA-10')
    assert.equal(parsed.ideas[1].id, 'IDEA-11')
    assert.equal(parsed.ideas[2].id, 'IDEA-12')
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('handles file with only ## Ideas and no entries', () => {
    const md = `# Ideabox\n\n## Ideas\n\n## Killed Ideas\n`
    const { ideas, killed, nextId } = parseIdeabox(md)
    assert.equal(ideas.length, 0)
    assert.equal(killed.length, 0)
    assert.equal(nextId, 1)
  })

  it('handles missing ## Killed Ideas section', () => {
    const md = `# Ideabox\n\n## Ideas\n\n#### IDEA-1 — Only section\n**Status:** NEW | **Priority:** P1\n`
    const { ideas, killed } = parseIdeabox(md)
    assert.equal(ideas.length, 1)
    assert.equal(killed.length, 0)
  })

  it('serializes and re-parses the default template cleanly', () => {
    const parsed = parseIdeabox(IDEABOX_TEMPLATE)
    const md = serializeIdeabox(parsed)
    const reparsed = parseIdeabox(md)
    assert.equal(reparsed.ideas.length, 0)
    assert.equal(reparsed.killed.length, 0)
    assert.equal(reparsed.nextId, 1)
  })

  it('handles idea with no tags', () => {
    const md = `# Ideabox\n\n## Ideas\n\n#### IDEA-1 — No tags\n**Status:** NEW | **Priority:** P1\n\n## Killed Ideas\n`
    const { ideas } = parseIdeabox(md)
    assert.deepEqual(ideas[0].tags, [])
  })

  it('handles idea with multiple tags', () => {
    const md = `# Ideabox\n\n## Ideas\n\n#### IDEA-1 — Multi tags\n**Status:** NEW | **Priority:** P1 | **Tags:** \`#ux\` \`#core\` \`#infra\`\n\n## Killed Ideas\n`
    const { ideas } = parseIdeabox(md)
    assert.deepEqual(ideas[0].tags, ['#ux', '#core', '#infra'])
  })

  it('updateIdea mutates a field in place', () => {
    const parsed = parseIdeabox(MINIMAL)
    updateIdea(parsed, 'IDEA-1', { title: 'Updated title', source: 'New source' })
    assert.equal(parsed.ideas[0].title, 'Updated title')
    assert.equal(parsed.ideas[0].source, 'New source')
  })

  it('add then kill then serialize does not lose other ideas', () => {
    const parsed = parseIdeabox(IDEABOX_TEMPLATE)
    addIdea(parsed, { title: 'Alpha' })
    addIdea(parsed, { title: 'Beta' })
    killIdea(parsed, 'IDEA-1', 'Removed')
    const md = serializeIdeabox(parsed)
    const reparsed = parseIdeabox(md)
    assert.equal(reparsed.ideas.length, 1)
    assert.equal(reparsed.ideas[0].title, 'Beta')
    assert.equal(reparsed.killed.length, 1)
    assert.equal(reparsed.killed[0].id, 'IDEA-1')
  })
})

// ---------------------------------------------------------------------------
// Discussion parsing and serialization (Item 186)
// ---------------------------------------------------------------------------

const DISCUSSION_EXAMPLE = `# Ideabox

## Ideas

#### IDEA-1 — Feature with discussion
**Status:** DISCUSSING | **Priority:** P1
**Source:** Team meeting
**Idea:** Add vector search.
**Discussion:**
- [2026-04-10] human: Should we use vector or graph?
- [2026-04-10] agent: Graph maps better to relationships.

## Killed Ideas
`

describe('discussion parsing', () => {
  it('parses discussion entries from markdown', () => {
    const { ideas } = parseIdeabox(DISCUSSION_EXAMPLE)
    assert.equal(ideas.length, 1)
    const disc = ideas[0].discussion
    assert.equal(disc.length, 2)
    assert.equal(disc[0].date, '2026-04-10')
    assert.equal(disc[0].author, 'human')
    assert.equal(disc[0].text, 'Should we use vector or graph?')
    assert.equal(disc[1].author, 'agent')
    assert.equal(disc[1].text, 'Graph maps better to relationships.')
  })

  it('defaults to empty discussion array when no discussion section', () => {
    const { ideas } = parseIdeabox(MINIMAL)
    for (const idea of ideas) {
      assert.deepEqual(idea.discussion, [])
    }
  })

  it('round-trips discussion entries through serialize/parse', () => {
    const { ideas: [idea1] } = parseIdeabox(DISCUSSION_EXAMPLE)
    const parsed = parseIdeabox(DISCUSSION_EXAMPLE)
    const md2 = serializeIdeabox(parsed)
    const { ideas: [reparsed] } = parseIdeabox(md2)

    assert.equal(reparsed.discussion.length, 2)
    assert.equal(reparsed.discussion[0].author, 'human')
    assert.equal(reparsed.discussion[0].text, 'Should we use vector or graph?')
    assert.equal(reparsed.discussion[1].author, 'agent')
    assert.equal(reparsed.discussion[1].text, 'Graph maps better to relationships.')
  })

  it('serializes discussion entries in correct markdown format', () => {
    const parsed = parseIdeabox(DISCUSSION_EXAMPLE)
    const md = serializeIdeabox(parsed)
    assert.ok(md.includes('**Discussion:**'))
    assert.ok(md.includes('- [2026-04-10] human: Should we use vector or graph?'))
    assert.ok(md.includes('- [2026-04-10] agent: Graph maps better to relationships.'))
  })
})

// ---------------------------------------------------------------------------
// addDiscussion (Item 186)
// ---------------------------------------------------------------------------

describe('addDiscussion', () => {
  it('appends a discussion entry to an idea', () => {
    const parsed = parseIdeabox(MINIMAL)
    addDiscussion(parsed, 'IDEA-1', 'human', 'What about caching?')
    const idea = parsed.ideas[0]
    assert.equal(idea.discussion.length, 1)
    assert.equal(idea.discussion[0].author, 'human')
    assert.equal(idea.discussion[0].text, 'What about caching?')
    assert.ok(idea.discussion[0].date.match(/^\d{4}-\d{2}-\d{2}$/))
  })

  it('appends multiple entries sequentially', () => {
    const parsed = parseIdeabox(MINIMAL)
    addDiscussion(parsed, 'IDEA-1', 'human', 'First comment')
    addDiscussion(parsed, 'IDEA-1', 'agent', 'Agent response')
    const disc = parsed.ideas[0].discussion
    assert.equal(disc.length, 2)
    assert.equal(disc[0].author, 'human')
    assert.equal(disc[1].author, 'agent')
  })

  it('appends to ideas in killed list too', () => {
    const parsed = parseIdeabox(MINIMAL)
    // IDEA-3 is in killed
    addDiscussion(parsed, 'IDEA-3', 'human', 'Reconsidering this one')
    const killed = parsed.killed.find(k => k.id === 'IDEA-3')
    assert.equal(killed.discussion.length, 1)
  })

  it('throws if idea not found', () => {
    const parsed = parseIdeabox(MINIMAL)
    assert.throws(() => addDiscussion(parsed, 'IDEA-999', 'human', 'text'), /not found/)
  })

  it('round-trips after addDiscussion', () => {
    const parsed = parseIdeabox(MINIMAL)
    addDiscussion(parsed, 'IDEA-1', 'human', 'Test comment')
    const md = serializeIdeabox(parsed)
    const reparsed = parseIdeabox(md)
    const idea = reparsed.ideas[0]
    assert.equal(idea.discussion.length, 1)
    assert.equal(idea.discussion[0].text, 'Test comment')
  })
})

// ---------------------------------------------------------------------------
// Effort/Impact fields (Item 187)
// ---------------------------------------------------------------------------

const EFFORT_IMPACT_EXAMPLE = `# Ideabox

## Ideas

#### IDEA-1 — Matrix idea
**Status:** NEW | **Priority:** P1
**Source:** Planning
**Idea:** Fast indexing.
**Effort:** M
**Impact:** high

## Killed Ideas
`

describe('effort/impact fields', () => {
  it('parses Effort field', () => {
    const { ideas } = parseIdeabox(EFFORT_IMPACT_EXAMPLE)
    assert.equal(ideas[0].effort, 'M')
  })

  it('parses Impact field', () => {
    const { ideas } = parseIdeabox(EFFORT_IMPACT_EXAMPLE)
    assert.equal(ideas[0].impact, 'high')
  })

  it('defaults effort and impact to null when absent', () => {
    const { ideas } = parseIdeabox(MINIMAL)
    assert.equal(ideas[0].effort, null)
    assert.equal(ideas[0].impact, null)
  })

  it('round-trips effort and impact through serialize/parse', () => {
    const parsed = parseIdeabox(EFFORT_IMPACT_EXAMPLE)
    const md = serializeIdeabox(parsed)
    const reparsed = parseIdeabox(md)
    assert.equal(reparsed.ideas[0].effort, 'M')
    assert.equal(reparsed.ideas[0].impact, 'high')
  })

  it('addIdea supports effort and impact fields', () => {
    const parsed = parseIdeabox(IDEABOX_TEMPLATE)
    addIdea(parsed, { title: 'Effort idea', effort: 'S', impact: 'medium' })
    const idea = parsed.ideas[0]
    assert.equal(idea.effort, 'S')
    assert.equal(idea.impact, 'medium')
  })

  it('serializes effort and impact as bold field lines', () => {
    const parsed = parseIdeabox(EFFORT_IMPACT_EXAMPLE)
    const md = serializeIdeabox(parsed)
    assert.ok(md.includes('**Effort:** M'))
    assert.ok(md.includes('**Impact:** high'))
  })
})

// ---------------------------------------------------------------------------
// resurrectIdea
// ---------------------------------------------------------------------------

describe('resurrectIdea', () => {
  it('moves killed idea back to ideas array', () => {
    const parsed = parseIdeabox(MINIMAL)
    const killedBefore = parsed.killed.length
    const ideasBefore = parsed.ideas.length
    resurrectIdea(parsed, 'IDEA-3')
    assert.equal(parsed.killed.length, killedBefore - 1)
    assert.equal(parsed.ideas.length, ideasBefore + 1)
  })

  it('resets status to NEW', () => {
    const parsed = parseIdeabox(MINIMAL)
    resurrectIdea(parsed, 'IDEA-3')
    const idea = parsed.ideas.find(i => i.id === 'IDEA-3')
    assert.ok(idea)
    assert.equal(idea.status, 'NEW')
  })

  it('removes killedReason and killedDate', () => {
    const parsed = parseIdeabox(MINIMAL)
    resurrectIdea(parsed, 'IDEA-3')
    const idea = parsed.ideas.find(i => i.id === 'IDEA-3')
    assert.equal(idea.killedReason, undefined)
    assert.equal(idea.killedDate, undefined)
  })

  it('throws if idea not in killed list', () => {
    const parsed = parseIdeabox(MINIMAL)
    assert.throws(() => resurrectIdea(parsed, 'IDEA-999'), /not found/)
  })

  it('round-trips correctly after resurrect', () => {
    const parsed = parseIdeabox(MINIMAL)
    resurrectIdea(parsed, 'IDEA-3')
    const md = serializeIdeabox(parsed)
    const reparsed = parseIdeabox(md)
    const idea = reparsed.ideas.find(i => i.id === 'IDEA-3')
    assert.ok(idea)
    assert.equal(idea.status, 'NEW')
  })
})
