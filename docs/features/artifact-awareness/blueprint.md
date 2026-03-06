# Artifact Awareness: Implementation Blueprint

**Status:** BLUEPRINT
**Date:** 2026-03-05
**Design:** [design.md](design.md)

---

## File Plan

| File | Action | Purpose |
|------|--------|---------|
| `server/artifact-manager.js` | **Create** | Schema definitions, assessment engine, scaffold, template loading, path safety |
| `server/artifact-templates/design.md` | **Create** | Design doc template |
| `server/artifact-templates/prd.md` | **Create** | PRD template |
| `server/artifact-templates/architecture.md` | **Create** | Architecture doc template |
| `server/artifact-templates/blueprint.md` | **Create** | Blueprint template |
| `server/artifact-templates/plan.md` | **Create** | Plan template |
| `server/artifact-templates/report.md` | **Create** | Report template |
| `server/compose-mcp-tools.js` | **Edit** | Add `toolAssessFeatureArtifacts`, `toolScaffoldFeature` |
| `server/compose-mcp.js` | **Edit** | Add 2 tool definitions + 2 switch cases |
| `server/vision-routes.js` | **Edit** | Add 2 artifact REST endpoints |
| `test/artifact-manager.test.js` | **Create** | Assessment + scaffold tests |

---

## 1. `server/artifact-manager.js` (new)

### 1.1 Schema Definitions

Export `ARTIFACT_SCHEMAS` — a map from filename to schema object. Each schema has:

```js
{
  requiredSections: string[],   // heading text patterns (case-insensitive)
  optionalSections: string[],   // heading text patterns
  minWordCount: number,
}
```

Six schemas as specified in design.md Decision 1:
- `design.md`: required `['Problem', 'Goal']`, min 200
- `prd.md`: required `['Problem Statement', 'Goals & Non-Goals', 'Requirements']`, min 300
- `architecture.md`: required `['Problem', 'Proposals']`, min 200
- `blueprint.md`: required `['File Plan']`, min 300
- `plan.md`: required `['Task Order', 'Task 1']`, min 150
- `report.md`: required `['Summary', 'Files Changed']`, min 200

### 1.2 Section Extraction

Private function `_extractSections(markdown)`:

1. Split markdown by lines
2. Match lines against `/^#{1,4}\s+(.+)$/`
3. Strip leading `#` markers and whitespace
4. Strip trailing punctuation (`:`, `—`, `–`)
5. Return array of cleaned heading strings

### 1.3 Section Matching

Private function `_matchSections(foundHeadings, schema)`:

1. For each required pattern: test case-insensitively against found headings. Patterns containing `\d+` are treated as regex (e.g., `Decision \d+` matches `Decision 1`, `Decision 2`). Plain patterns use `.toLowerCase()` equality.
2. For each optional pattern: same matching logic.
3. Return `{ found, missing, optional }` — found = required sections that matched, missing = required sections that didn't, optional = optional sections that matched.

### 1.4 Path Safety

Private function `_validateFeatureCode(featureCode)`:

```js
function _validateFeatureCode(featureCode) {
  if (!/^[A-Za-z0-9_-]+$/.test(featureCode)) {
    throw new Error(`Invalid featureCode: ${featureCode}`);
  }
}
```

All public methods call this before constructing any path. Additionally, `_featurePath(featureRoot, featureCode)` performs two-tier containment:

1. **Construction check (always):** `path.resolve(realpathSync(featureRoot), featureCode)` must start with `realpathSync(featureRoot)`. Works even if the candidate doesn't exist yet (scaffold case). The regex already prevents `..` and `/` in featureCode, so this guards against construction-time traversal.
2. **Symlink check (if path exists):** If the resolved candidate path exists on disk, `realpathSync(candidate)` must also start with `realpathSync(featureRoot)`. This catches an existing directory/symlink that points outside the tree.

This two-tier approach means scaffold of a new directory passes check 1 only, while assess/read of an existing directory passes both.

### 1.5 ArtifactManager Class

```js
// Startup invariant: ARTIFACT_SCHEMAS keys must match PHASE_ARTIFACTS values
const schemaKeys = new Set(Object.keys(ARTIFACT_SCHEMAS));
const artifactValues = new Set(Object.values(PHASE_ARTIFACTS));
if (schemaKeys.size !== artifactValues.size || [...schemaKeys].some(k => !artifactValues.has(k))) {
  throw new Error('ARTIFACT_SCHEMAS keys and PHASE_ARTIFACTS values are out of sync');
}

export class ArtifactManager {
  #featureRoot;

  constructor(featureRoot) {
    this.#featureRoot = featureRoot;
  }
}
```

#### `assess(featureCode)` → `{ artifacts: Record<string, SignalObject> }`

For each key in `ARTIFACT_SCHEMAS`:
1. Call `assessOne(featureCode, filename)`
2. Collect into `{ artifacts: { 'design.md': {...}, 'prd.md': {...}, ... } }`

#### `assessOne(featureCode, filename)` → `SignalObject`

1. Validate `featureCode` via `_validateFeatureCode`
2. Validate `filename` is a key in `ARTIFACT_SCHEMAS` — throw if not (prevents filename traversal like `../../etc/passwd`)
3. Build path: `_featurePath(this.#featureRoot, featureCode)` + `filename`
3. If file doesn't exist: return `{ exists: false, wordCount: 0, meetsMinWordCount: false, sections: { found: [], missing: schema.requiredSections, optional: [] }, completeness: 0, lastModified: null }`
4. Read file, compute word count (`content.split(/\s+/).filter(Boolean).length`)
5. Extract sections via `_extractSections`
6. Match sections via `_matchSections`
7. Compute completeness: `found.length / schema.requiredSections.length` (or 1.0 if no required sections)
8. Get `lastModified` from `fs.statSync(filePath).mtime.toISOString()`
9. Return signal object — **no `stale` field**. Staleness requires lifecycle phase history context that ArtifactManager doesn't have. If staleness is needed later, add `assessWithLifecycle(featureCode, lifecycle)` that receives phase history and computes it.

#### `scaffold(featureCode, options?)` → `{ created: string[], skipped: string[] }`

1. Validate `featureCode`
2. Create `<featureRoot>/<featureCode>/` if absent
3. Create `<featureRoot>/<featureCode>/sessions/` if absent
4. For each artifact in `ARTIFACT_SCHEMAS`:
   - If `options?.only` is set and this artifact isn't in the list, skip
   - If file already exists on disk, add to `skipped`
   - Otherwise, read template via `getTemplate(filename)`, write to disk, add to `created`
5. Return `{ created, skipped }`

#### `getTemplate(artifactName)` → `string`

1. Build path: `path.join(path.dirname(fileURLToPath(import.meta.url)), 'artifact-templates', artifactName)`
2. Read file, return content
3. Throw if template not found

#### `getSchema(artifactName)` → `SchemaObject | null`

Return `ARTIFACT_SCHEMAS[artifactName] || null`.

---

## 2. Template Files (`server/artifact-templates/`)

Six `.md` files with section headings matching their schema's required + optional sections. Each includes HTML comment placeholders like `<!-- Describe the problem this feature solves -->`.

### `design.md`
```markdown
# <Feature Name>: Design

**Status:** DESIGN
**Date:** <date>

## Related Documents

<!-- Link to roadmap, dependencies, and related features -->

---

## Problem

<!-- Describe the problem this feature solves -->

## Goal

<!-- What does success look like? Scope and non-scope. -->

---

## Decision 1: <Title>

<!-- Describe the decision, options considered, and rationale -->

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| | | |

## Open Questions

<!-- List unresolved questions -->
```

### `prd.md`
```markdown
# <Feature Name>: PRD

**Status:** PRD
**Date:** <date>

## Problem Statement

<!-- What problem are we solving and for whom? -->

## Goals & Non-Goals

### Goals
<!-- What this feature WILL do -->

### Non-Goals
<!-- What this feature will NOT do -->

## Requirements

### MUST
<!-- Non-negotiable requirements -->

### SHOULD
<!-- Important but not blocking -->

### MAY
<!-- Nice-to-have -->

## Success Criteria

<!-- How do we know this feature succeeded? -->

## User Stories

<!-- As a <role>, I want <goal> so that <benefit> -->

## Constraints

<!-- Technical, time, or resource constraints -->

## Open Questions

<!-- Unresolved questions -->
```

### `architecture.md`
```markdown
# <Feature Name>: Architecture

**Status:** ARCHITECTURE
**Date:** <date>

## Problem

<!-- Technical problem statement -->

## Proposals

### Proposal A: <Name>

<!-- Description, trade-offs, diagram if helpful -->

### Proposal B: <Name>

<!-- Description, trade-offs, diagram if helpful -->

## Trade-offs

| Dimension | Proposal A | Proposal B |
|-----------|-----------|-----------|
| | | |

## Decision

<!-- Which proposal was chosen and why -->
```

### `blueprint.md`
```markdown
# <Feature Name>: Implementation Blueprint

**Status:** BLUEPRINT
**Date:** <date>
**Design:** [design.md](design.md)

---

## File Plan

| File | Action | Purpose |
|------|--------|---------|
| | | |

---

## Corrections Table

| Spec Assumption | Reality | Resolution |
|----------------|---------|------------|
| | | |
```

### `plan.md`
```markdown
# <Feature Name>: Implementation Plan

**Status:** PLAN
**Date:** <date>
**Blueprint:** [blueprint.md](blueprint.md)

---

## Task Order

<!-- List tasks in dependency order -->

## Task 1: <Title>

- **File:** `<path>` (new/existing)
- **What:** <!-- What to implement -->
- **Pattern:** <!-- Existing pattern to follow -->
- **Test:** <!-- What test to write -->
- **Depends on:** <!-- Task dependencies -->

## Files Summary

| File | Tasks |
|------|-------|
| | |
```

### `report.md`
```markdown
# <Feature Name>: Implementation Report

**Status:** REPORT
**Date:** <date>

## Summary

<!-- 2-3 sentence overview of what was delivered -->

## Delivered vs Planned

| Planned | Delivered | Notes |
|---------|-----------|-------|
| | | |

## Architecture Deviations

<!-- Any deviations from the architecture/blueprint -->

## Key Decisions

<!-- Decisions made during implementation -->

## Test Coverage

<!-- What's tested, what's not, and why -->

## Files Changed

| File | Action | Purpose |
|------|--------|---------|
| | | |

## Known Issues

<!-- Known bugs, tech debt, or incomplete work -->

## Lessons Learned

<!-- What went well, what didn't, what to do differently -->
```

---

## 3. `server/compose-mcp-tools.js` (existing) — Edit

**Insert after line 231** (after `toolCompleteFeature`):

```js
// ---------------------------------------------------------------------------
// Artifact tools — read/write directly (no REST delegation needed)
// ---------------------------------------------------------------------------

import { ArtifactManager } from './artifact-manager.js';

export function toolAssessFeatureArtifacts({ featureCode }) {
  const featureRoot = path.join(PROJECT_ROOT, 'docs', 'features');
  const manager = new ArtifactManager(featureRoot);
  return manager.assess(featureCode);
}

export function toolScaffoldFeature({ featureCode, only }) {
  const featureRoot = path.join(PROJECT_ROOT, 'docs', 'features');
  const manager = new ArtifactManager(featureRoot);
  return manager.scaffold(featureCode, only ? { only } : undefined);
}
```

**Note:** The `ArtifactManager` import goes at the top of the file with other imports. Shown inline here for clarity. Actual import placement: after line 11 (`import { fileURLToPath } from 'node:url';`).

These tools read/write directly to disk — no REST delegation needed, unlike lifecycle mutations which need the live store. `PROJECT_ROOT` is already exported at `compose-mcp-tools.js:14`.

---

## 4. `server/compose-mcp.js` (existing) — Edit

### 4.1 Import (lines 35-40, inside existing import block)

Add before the closing `} from './compose-mcp-tools.js';` at line 40:

```js
  toolAssessFeatureArtifacts,
  toolScaffoldFeature,
```

### 4.2 Tool Definitions (after `complete_feature` at line 178, before `];` at line 179)

```js
  {
    name: 'assess_feature_artifacts',
    description: 'Assess quality signals for all artifacts of a feature: section completeness, word count, last modified.',
    inputSchema: {
      type: 'object',
      properties: {
        featureCode: { type: 'string', description: 'Feature folder name (e.g. "artifact-awareness")' },
      },
      required: ['featureCode'],
    },
  },
  {
    name: 'scaffold_feature',
    description: 'Create feature folder with template stubs for all phase artifacts. Existing files are never overwritten.',
    inputSchema: {
      type: 'object',
      properties: {
        featureCode: { type: 'string', description: 'Feature folder name' },
        only: {
          type: 'array',
          items: { type: 'string' },
          description: 'Limit to specific artifacts (e.g. ["design.md", "blueprint.md"]). Omit for all.',
        },
      },
      required: ['featureCode'],
    },
  },
```

### 4.3 Switch Cases (after line 209, `case 'complete_feature'`)

```js
      case 'assess_feature_artifacts': result = toolAssessFeatureArtifacts(args); break;
      case 'scaffold_feature':         result = toolScaffoldFeature(args); break;
```

---

## 5. `server/vision-routes.js` (existing) — Edit

### 5.1 Import (after line 28, `import { LifecycleManager }`)

```js
import { ArtifactManager } from './artifact-manager.js';
```

### 5.2 Endpoints (after lifecycle complete endpoint, line 226, before summary route at line 228)

```js
  // ── Artifact endpoints ───────────────────────────────────────────────
  const artifactManager = new ArtifactManager(path.join(projectRoot, 'docs', 'features'));

  app.get('/api/vision/items/:id/artifacts', (req, res) => {
    try {
      const items = store.getState().items;
      const item = items.find(i => i.id === req.params.id);
      if (!item) return res.status(404).json({ error: `Item not found: ${req.params.id}` });
      if (!item.lifecycle?.featureCode) {
        return res.status(400).json({ error: 'Item has no lifecycle featureCode' });
      }
      const assessment = artifactManager.assess(item.lifecycle.featureCode);
      res.json(assessment);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/vision/items/:id/artifacts/scaffold', (req, res) => {
    try {
      const items = store.getState().items;
      const item = items.find(i => i.id === req.params.id);
      if (!item) return res.status(404).json({ error: `Item not found: ${req.params.id}` });
      if (!item.lifecycle?.featureCode) {
        return res.status(400).json({ error: 'Item has no lifecycle featureCode' });
      }
      const result = artifactManager.scaffold(item.lifecycle.featureCode, req.body);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
```

### 5.3 Route Comment Header (line 1-22)

Add to the route list comment:
```
 *   GET    /api/vision/items/:id/artifacts
 *   POST   /api/vision/items/:id/artifacts/scaffold
```

---

## 6. `test/artifact-manager.test.js` (new)

Follows the same pattern as `test/lifecycle-manager.test.js` — `node:test`, `assert/strict`, temp dirs, dynamic imports.

### Setup Helper

```js
function setup() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'am-test-'));
  const featureRoot = join(tmpDir, 'features');
  mkdirSync(join(featureRoot, 'TEST-1'), { recursive: true });
  const manager = new ArtifactManager(featureRoot);
  return { tmpDir, featureRoot, manager };
}
```

### Test Groups

**Assessment — file doesn't exist:**
- `assessOne` returns `exists: false`, `completeness: 0`, `missing` contains all required sections

**Assessment — stub file (headings only, no content):**
- Create `design.md` with `# Problem\n# Goal\n` (14 words)
- `assessOne` returns `exists: true`, `completeness: 1.0`, `meetsMinWordCount: false`

**Assessment — complete file:**
- Create `design.md` with 250+ words, `## Problem`, `## Goal` sections
- `assessOne` returns `exists: true`, `completeness: 1.0`, `meetsMinWordCount: true`

**Assessment — missing required section:**
- Create `design.md` with `## Problem` but no `## Goal`
- `completeness: 0.5`, `missing: ['Goal']`

**Assessment — regex pattern matching:**
- Create `design.md` with `## Decision 1`, `## Decision 2` headings
- Both match `Decision \d+` optional pattern

**Assessment — heading level agnostic:**
- Create `design.md` with `#### Problem` and `# Goal`
- Both match despite different heading levels

**Assessment — trailing punctuation stripped:**
- Create `design.md` with `## Problem:` and `## Goal —`
- Both match after stripping `:` and `—`

**Full assess:**
- Create `design.md` and `blueprint.md` on disk
- `assess('TEST-1')` returns signals for all 6 artifacts; 2 exist, 4 don't

**Scaffold — empty folder:**
- `scaffold('TEST-1')` creates all 6 templates + `sessions/` dir
- Returns `{ created: ['design.md', 'prd.md', ...], skipped: [] }`
- Verify files exist on disk

**Scaffold — existing files preserved:**
- Write custom `design.md` to disk
- `scaffold('TEST-1')` creates 5 templates, skips `design.md`
- Verify custom `design.md` content unchanged

**Scaffold — `options.only`:**
- `scaffold('TEST-1', { only: ['design.md', 'plan.md'] })` creates only those 2
- Other artifacts not created

**Path safety — invalid featureCode:**
- Table-driven: `['../etc', 'foo/bar', 'foo\\bar', '..', '']`
- All throw on `assess`, `assessOne`, `scaffold`

**Path safety — invalid filename in assessOne:**
- Table-driven: `['../../etc/passwd', 'nonexistent.md', '../design.md', '']`
- All throw because filename is not a key in `ARTIFACT_SCHEMAS`

**Path safety — symlink escape:**
- Create a directory outside featureRoot (e.g. `tmpDir/outside/`)
- Create a symlink `featureRoot/SYMLINK-1` → `tmpDir/outside/`
- `assess('SYMLINK-1')` and `scaffold('SYMLINK-1')` both throw
- Verifies the tier-2 `realpathSync` containment check

**getSchema:**
- `getSchema('design.md')` returns schema object with `requiredSections`
- `getSchema('nonexistent.md')` returns `null`

**getTemplate:**
- `getTemplate('design.md')` returns string containing `## Problem`
- `getTemplate('nonexistent.md')` throws

**Schema-artifact invariant:**
- `Object.keys(ARTIFACT_SCHEMAS)` equals `new Set(Object.values(PHASE_ARTIFACTS))` — module loads without error
- (If someone adds a schema without a PHASE_ARTIFACTS entry, the module-level check throws at import time)

---

## Corrections Table

| Spec Assumption | Reality | Resolution |
|----------------|---------|------------|
| Design says `stale` compares `lastModified` against phase history `enteredAt` | ArtifactManager is stateless — has no access to lifecycle phase history | Remove `stale` from signal object entirely. Add `assessWithLifecycle()` later if needed. |
| Design says `scaffold` creates `sessions/` subfolder | Need to verify compose skill actually uses this path | Confirmed — compose skill spec mentions `sessions/` for transcripts. Create it. |
| Design shows `PHASE_ARTIFACTS` in artifact-manager | `PHASE_ARTIFACTS` already exists in `lifecycle-manager.js:36-43` | Import from lifecycle-manager to avoid duplication. ArtifactManager uses it to know which artifacts exist. |
| Design says templates stored as plain `.md` in `server/artifact-templates/` | Directory doesn't exist yet | Create directory and all 6 templates. |
| Design shows `assess(featureCode)` iterating `PHASE_ARTIFACTS` | `ARTIFACT_SCHEMAS` keys should match `PHASE_ARTIFACTS` values | Use `Object.keys(ARTIFACT_SCHEMAS)` to iterate. Add module-level invariant that throws if schema keys and PHASE_ARTIFACTS values diverge. Add test. |
| Design says `resolve(...).startsWith(featureRoot)` for path safety | `path.resolve` doesn't follow symlinks — a symlink inside featureRoot could point outside | Two-tier check: (1) `resolve(realRoot, code).startsWith(realRoot)` always; (2) if candidate exists, `realpathSync(candidate).startsWith(realRoot)` to catch symlink escape. |
