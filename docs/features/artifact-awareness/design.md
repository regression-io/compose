# Artifact Awareness: Design

**Status:** DESIGN
**Date:** 2026-03-05
**Roadmap item:** 22 (Phase 6)

## Related Documents

- [Lifecycle Engine Roadmap](../../plans/2026-02-15-lifecycle-engine-roadmap.md) — Layer 2 context
- [Lifecycle State Machine Design](../lifecycle-state-machine/design.md) — Layer 1 (dependency)
- [Compose Skill](../../../.claude/skills/compose/SKILL.md) — the 10-phase lifecycle

---

## Problem

The lifecycle state machine (item 21) tracks which phase a feature is in and whether artifact files exist on disk (boolean). But it has no concept of artifact **quality** — a 3-word stub and a 500-word reviewed design both read as `'design.md': true`. And there's no **scaffolding** — agents write each artifact from scratch, producing inconsistent structure across features.

Current gaps:

1. **No templates** — agents reinvent artifact structure each time. design.md for lifecycle-state-machine looks different from session-tracking's design.md.
2. **No quality signals** — the system only knows "file exists." It can't tell the agent or the gate UI "this blueprint is missing a corrections table" or "this design has no decisions section."
3. **No folder scaffolding** — feature folders are created ad-hoc. The `sessions/` subfolder mentioned in the compose skill never gets created.
4. **No artifact metadata** — word count, section completeness, last modified, review status are all invisible to the system.

## Goal

Make artifacts **structurally aware** — the system knows what a well-formed artifact looks like, can scaffold it, and can assess completeness. This is the substrate for policy enforcement (item 23) and gate UI (item 24).

Scope: agent-facing infrastructure only. UI rendering of artifact status is item 24.

---

## Decision 1: Artifact Schema

Each phase artifact has a **schema** — a list of expected sections with optional/required flags. Not a rigid template that gets filled in, but a structural contract that defines what "complete" means.

```js
const ARTIFACT_SCHEMAS = {
  'design.md': {
    requiredSections: ['Problem', 'Goal'],
    optionalSections: ['Related Documents', 'Decision \\d+', 'Files', 'Open Questions', 'Resolved Questions'],
    minWordCount: 200,
  },
  'prd.md': {
    requiredSections: ['Problem Statement', 'Goals & Non-Goals', 'Requirements'],
    optionalSections: ['Success Criteria', 'User Stories', 'Constraints', 'Open Questions'],
    minWordCount: 300,
  },
  'architecture.md': {
    requiredSections: ['Problem', 'Proposals'],
    optionalSections: ['Trade-offs', 'Decision', 'Component Diagram'],
    minWordCount: 200,
  },
  'blueprint.md': {
    requiredSections: ['File Plan'],
    optionalSections: ['Corrections Table'],
    minWordCount: 300,
  },
  'plan.md': {
    requiredSections: ['Task Order', 'Task 1'],
    optionalSections: ['Files Summary'],
    minWordCount: 150,
  },
  'report.md': {
    requiredSections: ['Summary', 'Files Changed'],
    optionalSections: ['Delivered vs Planned', 'Architecture Deviations', 'Key Decisions', 'Test Coverage', 'Known Issues', 'Lessons Learned'],
    minWordCount: 200,
  },
};
```

Section matching extracts heading text from any markdown heading level (`#` through `####`),
strips leading `#` markers and whitespace, then matches case-insensitively against schema
patterns. `Decision \d+` matches `## Decision 1`, `### Decision 2`, `# Decision 3`, etc.
Trailing punctuation (`:`, `—`, `–`) is stripped before matching. This makes detection
robust to heading level variations and minor formatting differences across artifacts.

---

## Decision 2: Quality Signals

Quality is assessed per-artifact, producing a signals object:

```js
{
  exists: true,
  wordCount: 450,
  meetsMinWordCount: true,
  sections: {
    found: ['Problem', 'Goal', 'Decision 1', 'Decision 2', 'Files'],
    missing: [],              // required sections not found
    optional: ['Related Documents', 'Decision \\d+', 'Files'],  // optional sections found
  },
  completeness: 1.0,         // found required / total required
  lastModified: '2026-03-05T10:00:00Z',
}
```

**Completeness** is `requiredSections found / requiredSections total`. A score of 1.0 means all required sections are present. This does NOT assess content quality — just structural presence.

**Staleness (deferred):** Originally planned as a `stale` boolean comparing `lastModified` against phase history `enteredAt`. Deferred because ArtifactManager is stateless — it has no access to lifecycle phase history. If staleness is needed, a future `assessWithLifecycle(featureCode, lifecycle)` method can accept phase history and compute it. Callers with lifecycle access can compare `lastModified` against `enteredAt` themselves.

---

## Decision 3: Where This Lives

A new `server/artifact-manager.js` module. Stateless — it reads files and schemas, computes signals, returns data. No persistence beyond what the lifecycle manager already stores.

```
ArtifactManager(featureRoot)
  - assess(featureCode)                    → full assessment of all artifacts
  - assessOne(featureCode, filename)       → single artifact assessment
  - scaffold(featureCode, options?)        → create feature folder + stub files
  - getTemplate(artifactName)              → return template content for an artifact
  - getSchema(artifactName)                → return schema for an artifact
```

### Path Safety

All methods validate `featureCode` before constructing paths:

1. Must match `/^[A-Za-z0-9_-]+$/` — alphanumeric, hyphens, underscores only
2. Must not contain `..`, `/`, or `\`
3. The resolved path must start with `featureRoot` (defense-in-depth against symlink traversal)

Methods throw on invalid `featureCode`. This bounds all disk operations to `docs/features/<featureCode>/`.

The lifecycle manager's `#scanArtifacts` stays as-is (boolean presence). ArtifactManager provides the deeper analysis when requested — at gates, on demand via MCP, or during reconciliation.

---

## Decision 4: Templates

Templates are markdown files with section headings pre-filled and brief guidance comments. Stored in `server/artifact-templates/` as plain `.md` files.

```
server/artifact-templates/
  design.md
  prd.md
  architecture.md
  blueprint.md
  plan.md
  report.md
```

`scaffold(featureCode, options?)` creates the feature folder structure and copies template stubs. Behavior:

1. Creates `docs/features/<featureCode>/` if absent
2. Creates `docs/features/<featureCode>/sessions/` subdirectory (for session transcripts, as specified in compose skill)
3. For each artifact in `PHASE_ARTIFACTS`: if the file does **not** already exist on disk, copies the template. Existing files are never overwritten.
4. `options.only` (optional string array) — limit scaffolding to specific artifacts, e.g. `['design.md', 'blueprint.md']`. If omitted, all templates are scaffolded.

Scaffold does **not** need lifecycle state. It's purely existence-based: if a file exists, skip it; if not, create from template. The compose skill or agent decides *when* to call scaffold (typically at lifecycle start), but scaffold itself has no lifecycle dependency. This keeps it usable for features that don't have a lifecycle object yet (e.g., manual work, legacy features).

Templates include placeholders like `<!-- Describe the problem this feature solves -->` that agents replace with actual content.

---

## Decision 5: Integration Points

### Lifecycle Manager

No changes to the lifecycle manager itself. ArtifactManager is a separate module that reads the same feature folders. The lifecycle manager's `lifecycle.artifacts` map stays boolean (exists/not). Rich quality data is computed on demand by ArtifactManager, not stored on the lifecycle object.

**Why not store quality on lifecycle?** Quality signals are derived data — recomputable from disk at any time. Storing them would create a cache invalidation problem (any file edit outside the system would make stored signals stale). Compute on read, don't cache on write.

### MCP Tools

New tools in `compose-mcp-tools.js`:

- `assess_feature_artifacts(featureCode)` — returns full assessment (all artifacts, quality signals, completeness)
- `scaffold_feature(featureCode)` — creates folder + template stubs, returns list of created files

Both are read-from-disk / write-to-disk operations — no REST delegation needed (unlike lifecycle mutations which need the live store). The MCP process can do these directly.

### REST Endpoints

- `GET /api/vision/items/:id/artifacts` — returns assessment for the feature linked to this item
- `POST /api/vision/items/:id/artifacts/scaffold` — scaffolds the feature folder

These are thin wrappers around ArtifactManager, using the item's `lifecycle.featureCode` to locate the folder.

### Compose Skill

The skill calls `assess_feature_artifacts` at entry scan to get a richer picture than just file existence. At gates, it checks completeness before proposing advancement:

- Completeness < 1.0 → warn that required sections are missing
- Staleness detected → warn that artifact may be outdated
- Word count below minimum → flag as likely stub

The skill already creates feature folders ad-hoc. With `scaffold_feature`, it can do it in one call with proper templates.

---

## Decision 6: What This Does NOT Do

- **No content analysis** — doesn't evaluate whether a "Problem" section is well-written, just that it exists with some content under it
- **No auto-gating** — quality signals inform the gate decision but don't enforce it (that's item 23, policy enforcement)
- **No UI** — artifact status rendering is item 24 (gate UI)
- **No cross-feature analysis** — doesn't compare artifacts across features
- **No version tracking** — doesn't track artifact revisions over time

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `server/artifact-manager.js` | **Create** | Schema definitions, assessment, scaffold, template loading |
| `server/artifact-templates/design.md` | **Create** | Design doc template |
| `server/artifact-templates/prd.md` | **Create** | PRD template |
| `server/artifact-templates/architecture.md` | **Create** | Architecture doc template |
| `server/artifact-templates/blueprint.md` | **Create** | Blueprint template |
| `server/artifact-templates/plan.md` | **Create** | Plan template |
| `server/artifact-templates/report.md` | **Create** | Report template |
| `server/compose-mcp-tools.js` | **Edit** | Add `assess_feature_artifacts`, `scaffold_feature` tools |
| `server/compose-mcp.js` | **Edit** | Add tool definitions + switch cases |
| `server/vision-routes.js` | **Edit** | Add artifact endpoints |
| `test/artifact-manager.test.js` | **Create** | Assessment + scaffold tests |
