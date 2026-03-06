# Artifact Awareness: Implementation Plan

**Status:** PLAN
**Date:** 2026-03-05
**Blueprint:** [blueprint.md](blueprint.md)

---

## Task Order

Tasks 1 and 2 are independent (create new files). Task 3 depends on Task 1. Tasks 4-5 depend on Task 1. Task 6 depends on all.

```
Task 1: artifact-manager.js ─────┬──→ Task 3: unit tests (depends on 1, 2)
Task 2: artifact templates (6)   ├──→ Task 4: MCP tools (depends on 1)
                                  ├──→ Task 5: REST routes (depends on 1)
                                  ├──→ Task 6: integration tests (depends on 3, 4, 5)
                                  └──→ Task 7: verify all (depends on 1-6)
```

## Task 1: Create `server/artifact-manager.js`

- **File:** `server/artifact-manager.js` (new)
- **What:** Core module — schemas, assessment, scaffold, template loading, path safety
- **Pattern:** Follow `server/lifecycle-manager.js` structure (exported constants, class with private fields, private helpers)
- **Details:**
  - Export `ARTIFACT_SCHEMAS` — 6 schemas with `requiredSections`, `optionalSections`, `minWordCount`
  - Import `PHASE_ARTIFACTS` from `server/lifecycle-manager.js:36`
  - Module-level invariant: `Object.keys(ARTIFACT_SCHEMAS)` must equal `new Set(Object.values(PHASE_ARTIFACTS))`; throw on mismatch
  - `_validateFeatureCode(featureCode)` — regex `/^[A-Za-z0-9_-]+$/`, throw on invalid
  - `_featurePath(featureRoot, featureCode)` — two-tier containment:
    1. `path.resolve(realpathSync(featureRoot), featureCode).startsWith(realpathSync(featureRoot))`
    2. If candidate exists on disk: `realpathSync(candidate).startsWith(realpathSync(featureRoot))`
  - `_extractSections(markdown)` — match `/^#{1,4}\s+(.+)$/`, strip trailing `:`, `—`, `–`
  - `_matchSections(foundHeadings, schema)` — case-insensitive, regex for `\d+` patterns
  - `ArtifactManager(featureRoot)`:
    - `assess(featureCode)` → `{ artifacts: Record<string, SignalObject> }`
    - `assessOne(featureCode, filename)` → SignalObject (filename must be key in ARTIFACT_SCHEMAS)
    - `scaffold(featureCode, options?)` → `{ created: string[], skipped: string[] }` (creates `sessions/` subdir)
    - `getTemplate(artifactName)` → string
    - `getSchema(artifactName)` → schema object or null
  - No `stale` field in signal object (deferred per design revision)
- **Test:** Task 3
- **Depends on:** None

## Task 2: Create template files

- **File:** `server/artifact-templates/*.md` (new, 6 files)
- **What:** Markdown templates with section headings and HTML comment placeholders
- **Pattern:** Section headings match schema required + optional sections
- **Details:**
  - Create `server/artifact-templates/` directory
  - `design.md` — Problem, Goal, Related Documents, Decision 1, Files, Open Questions
  - `prd.md` — Problem Statement, Goals & Non-Goals, Requirements, Success Criteria, User Stories, Constraints, Open Questions
  - `architecture.md` — Problem, Proposals, Trade-offs, Decision
  - `blueprint.md` — File Plan, Corrections Table
  - `plan.md` — Task Order, Task 1, Files Summary
  - `report.md` — Summary, Delivered vs Planned, Architecture Deviations, Key Decisions, Test Coverage, Files Changed, Known Issues, Lessons Learned
  - Content exactly as specified in blueprint section 2
- **Test:** Verified via scaffold tests in Task 3
- **Depends on:** None

## Task 3: Create `test/artifact-manager.test.js`

- **File:** `test/artifact-manager.test.js` (new)
- **What:** ~18 tests covering assessment, scaffold, path safety, schema/template access
- **Pattern:** Follow `test/lifecycle-manager.test.js` — `node:test`, `assert/strict`, temp dirs, cleanup
- **Details:**
  - Setup helper: `mkdtempSync`, create `featureRoot/TEST-1/`, instantiate `ArtifactManager`
  - Assessment tests (8):
    - [ ] File doesn't exist → `exists: false`, `completeness: 0`, all required in `missing`
    - [ ] Stub file (headings only, <200 words) → `completeness: 1.0`, `meetsMinWordCount: false`
    - [ ] Complete file (250+ words, all sections) → `completeness: 1.0`, `meetsMinWordCount: true`
    - [ ] Missing required section → `completeness: 0.5`, `missing: ['Goal']`
    - [ ] Regex pattern matching (`Decision \d+` matches `Decision 1`, `Decision 2`)
    - [ ] Heading level agnostic (`#### Problem` and `# Goal` both match)
    - [ ] Trailing punctuation stripped (`## Problem:`, `## Goal —`)
    - [ ] Full `assess()` — 2 files on disk, returns signals for all 6 artifacts
  - Scaffold tests (3):
    - [ ] Empty folder → creates all 6 templates + `sessions/` dir
    - [ ] Existing files preserved → skips existing, creates rest
    - [ ] `options.only` → creates only specified artifacts
  - Path safety tests (3):
    - [ ] Invalid featureCode table-driven: `['../etc', 'foo/bar', 'foo\\bar', '..', '']`
    - [ ] Invalid filename table-driven: `['../../etc/passwd', 'nonexistent.md', '../design.md', '']`
    - [ ] Symlink escape: symlink in featureRoot pointing outside → throws
  - Schema/template tests (2):
    - [ ] `getSchema('design.md')` returns object; `getSchema('nonexistent.md')` returns null
    - [ ] `getTemplate('design.md')` returns content; `getTemplate('nonexistent.md')` throws
  - Invariant test (1):
    - [ ] Module loads without error (invariant passes)
- **Depends on:** Task 1, Task 2

## Task 4: Edit MCP tools and server

- **File:** `server/compose-mcp-tools.js` (existing), `server/compose-mcp.js` (existing)
- **What:** Add 2 new MCP tools for artifact assessment and scaffolding
- **Pattern:** Follow existing lifecycle tools — disk-direct (no REST delegation)
- **Details:**
  - `compose-mcp-tools.js`:
    - Add `import { ArtifactManager } from './artifact-manager.js';` after line 11
    - Add `toolAssessFeatureArtifacts({ featureCode })` and `toolScaffoldFeature({ featureCode, only })` after line 231
    - Both instantiate `ArtifactManager(path.join(PROJECT_ROOT, 'docs', 'features'))`
  - `compose-mcp.js`:
    - Add `toolAssessFeatureArtifacts, toolScaffoldFeature` to import block (before line 40)
    - Add 2 tool definitions after `complete_feature` (line 178)
    - Add 2 switch cases after line 209
- **Test:** MCP wiring tests in Task 3 (text parsing + direct call)
- **Depends on:** Task 1

## Task 5: Edit REST routes

- **File:** `server/vision-routes.js` (existing)
- **What:** Add 2 artifact endpoints
- **Pattern:** Follow lifecycle endpoints — look up item, extract featureCode, delegate to manager
- **Details:**
  - Add `import { ArtifactManager } from './artifact-manager.js';` after line 28
  - Instantiate `const artifactManager = new ArtifactManager(...)` after lifecycle routes (line 226)
  - `GET /api/vision/items/:id/artifacts` — returns assessment for item's featureCode
  - `POST /api/vision/items/:id/artifacts/scaffold` — scaffolds feature folder
  - Both return 404 if item not found, 400 if no lifecycle featureCode
  - Update route comment header (lines 1-22)
- **Test:** REST endpoint tests in Task 3 (ephemeral Express server)
- **Depends on:** Task 1

## Task 6: Integration tests (REST + MCP)

- **File:** `test/artifact-manager.test.js` (existing, append)
- **What:** REST endpoint and MCP wiring tests that depend on route and tool edits
- **Pattern:** Follow `test/lifecycle-routes.test.js` — ephemeral Express, `setupServer` helper
- **Details:**
  - REST endpoint tests (3) — spin up Express with ephemeral port:
    - [ ] `GET /api/vision/items/:id/artifacts` — start lifecycle, returns assessment with 6 artifact keys
    - [ ] `POST /api/vision/items/:id/artifacts/scaffold` — creates templates, returns `{ created, skipped }`
    - [ ] `GET /api/vision/items/:id/artifacts` — 400 when item has no lifecycle
  - MCP tool wiring tests (2):
    - [ ] `compose-mcp.js` contains `assess_feature_artifacts` and `scaffold_feature` in tool definitions and switch cases (text parsing)
    - [ ] `toolAssessFeatureArtifacts` direct call returns assessment object with correct shape (runtime test)
- **Depends on:** Task 3, Task 4, Task 5

## Task 7: Verify all

- **What:** Syntax checks + test runs
- **Details:**
  - [ ] `node --check server/artifact-manager.js`
  - [ ] `node --check server/compose-mcp-tools.js`
  - [ ] `node --check server/vision-routes.js`
  - [ ] `node --test test/artifact-manager.test.js` — all pass
  - [ ] `node --test test/lifecycle-manager.test.js` — regression check
  - [ ] `node --test test/lifecycle-routes.test.js` — regression check
  - [ ] `compose-mcp.js` contains `assess_feature_artifacts` and `scaffold_feature` in tool definitions and switch cases
- **Depends on:** Tasks 1-6

## Files Summary

| File | Tasks |
|------|-------|
| `server/artifact-manager.js` | 1 |
| `server/artifact-templates/design.md` | 2 |
| `server/artifact-templates/prd.md` | 2 |
| `server/artifact-templates/architecture.md` | 2 |
| `server/artifact-templates/blueprint.md` | 2 |
| `server/artifact-templates/plan.md` | 2 |
| `server/artifact-templates/report.md` | 2 |
| `server/compose-mcp-tools.js` | 4 |
| `server/compose-mcp.js` | 4 |
| `server/vision-routes.js` | 5 |
| `test/artifact-manager.test.js` | 3 |
