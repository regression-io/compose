# Session 23 — COMP-QA: Diff-Aware QA Scoping

**Date:** 2026-04-09
**Items:** 113–116 (Diff-to-route mapper, dev server detection, targeted route classification, regression guard)

## What happened

The ask was COMP-QA: given a build's `context.filesChanged`, identify which routes/pages are affected so humans (and future automation) know what to browser-test. v1 was explicitly scoped to file-analysis only — no Playwright execution.

We read `build.js`, `build-stream-bridge.js`, `bin/compose.js`, and a test file for patterns before touching anything. The codebase already had `context.filesChanged` populated by the pipeline; we just needed the mapper.

## What we built

**New file**

- `lib/qa-scoping.js` — core of COMP-QA:
  - `mapFilesToRoutes(filesChanged, config?)` — heuristic framework detection (Next.js pages/, app/, Express routes/, React Router `*Route.*`) plus explicit `routes.yaml` override. Returns `{ affectedRoutes, unmappedFiles, framework, docsOnly }`.
  - `classifyRoutes(affectedRoutes, allKnownRoutes)` — splits routes into `affected` (directly changed) and `adjacent` (share a parent path or are siblings). v1 uses simple path prefix matching.
  - `detectDevServer(timeout?)` — probes ports 3000, 3001, 4000, 5173, 8080 via HTTP GET. Returns `{ url, port }` or null. Detection only.
  - `isDocsOnlyDiff(filesChanged)` — returns true when every changed file is a doc/config extension or under docs/.
  - `loadRoutesConfig(cwd)` / `parseRoutesYaml(raw)` — loads `.compose/routes.yaml` or `compose.routes.yaml`. Minimal hand-rolled YAML parser for the documented schema shape; avoids adding a yaml dependency.
  - `matchesGlob(file, pattern)` — glob helper supporting `*` (within-segment) and `**` (cross-path).

**Modified files**

- `lib/build.js` — imports `mapFilesToRoutes`, `classifyRoutes`, `isDocsOnlyDiff`. Before the `coverage_check` child flow, emits a `qa_scope` stream event with affected routes, adjacent routes, unmapped files, framework, and a `skipCoverage` hint when the diff is docs-only. Wrapped in try/catch — non-fatal.
- `server/build-stream-bridge.js` — added `qa_scope` case to `_mapEvent()`, mapping it to `{ type: 'system', subtype: 'qa_scope', ... }`.
- `bin/compose.js` — added `compose qa-scope <featureCode>` command. Reads `feature.filesChanged`, calls the mapper, prints affected routes / adjacent routes / unmapped files. Added to help text.

**New test file**

- `test/qa-scoping.test.js` — 11 describe blocks, 39 tests:
  - Next.js pages/ and app/ directory mapping
  - Express routes/ mapping
  - docs/config-only diff detection
  - Explicit routes.yaml override
  - classifyRoutes adjacent detection
  - detectDevServer null return
  - React Router Route filename mapping
  - matchesGlob patterns
  - parseRoutesYaml inline and list formats
  - isDocsOnlyDiff edge cases

## What we learned

1. **Index stripping needs a regex that handles both bare `index` and `/index`**. The initial implementation used `.replace(/\/index$/, '')` which left `pages/index.tsx` mapping to `/index` instead of `/`. The fix: `slug.replace(/(?:^|\/)index$/, '') || ''` then return `/` for empty string.

2. **Minimal YAML parsing is viable for fixed schemas**. The routes.yaml shape is constrained (mappings list, pattern string, routes array). A ~50-line hand-rolled parser handles both inline array (`routes: ["/a", "/b"]`) and list-item formats without pulling in a yaml dependency. This keeps the module light.

3. **Non-fatal wrapping is the right call for informational integrations**. The `qa_scope` emission in build.js is wrapped in try/catch with a console.warn. If route mapping fails for any reason, the build continues. This is the right pattern for tooling that assists rather than gates.

4. **The `docsOnly` flag propagates cleanly through the event pipeline**. We emit it from the mapper, carry it through the stream event, and the bridge preserves it. Future UI can surface this as "no browser testing needed."

## Open threads

- [ ] v2: collect `allKnownRoutes` from a project-level routes manifest (could scan pages/ or app/ at build start)
- [ ] v2: Playwright integration that actually navigates to `affectedRoutes` when `detectDevServer` returns a URL
- [ ] `compose qa-scope` could also read from the most recent build-stream.jsonl (look for `qa_scope` event) rather than feature.json filesChanged
- [ ] routes.yaml scaffold could be added to `compose init --with-qa` if that flag is ever added

Session character: small surface area, clean boundaries — the mapper stays pure (no I/O except optional config load), the integration is additive and non-fatal.
