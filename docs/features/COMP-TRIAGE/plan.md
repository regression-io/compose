# COMP-TRIAGE Implementation Plan

**Items:** 129-132
**Scope:** Pre-flight feature triage. Analyzes feature folder contents, assigns a complexity tier, and populates the build profile (`needs_prd`, `needs_architecture`, `needs_verification`, `needs_report`) in feature.json. The existing build pipeline already respects `skip_if` on these steps — triage just automates the decision instead of requiring manual `compose pipeline enable/disable`.

## Architecture

Triage is a **pre-build analysis step**, not a pipeline step. It runs before `stratum_plan()` in `runBuild()`, replacing the never-implemented "scope" step that build.js already has persistence code for (line 500-512). The scope step's ghost code in build.js persists `complexity` and `profile` fields — triage populates these same fields.

**How it connects to the existing build:**

1. `lib/triage.js` analyzes the feature folder and returns `{ tier, profile, rationale, signals }`
2. `lib/build.js` calls triage before loading the spec YAML, then mutates the parsed spec to set/remove `skip_if` on `prd`, `architecture`, `verification`, and `report` steps based on the profile
3. The mutated spec is passed to `stratum_plan()` — Stratum handles the actual skip logic as it already does today
4. The profile is persisted to feature.json (creating it if missing) so subsequent builds reuse the decision

**No new pipeline templates.** No `build-lite.stratum.yaml`. The existing `build.stratum.yaml` already has the skippable steps — triage just toggles them.

## Tasks

### Task 1: Triage engine

**File:** `compose/lib/triage.js` (new)

- [ ] Export `async function runTriage(featureCode, opts)` where `opts` includes `{ cwd }`
- [ ] Read feature folder contents: `docs/features/<CODE>/` — check for existence of design.md, blueprint.md, plan.md, prd.md, architecture.md
- [ ] **Tier definitions** (informational — the profile is what matters):
  - Tier 0: Config-only (dotfiles, package.json tweaks, no design docs) — skip prd, architecture, verification, report
  - Tier 1: Single-concern change (1-2 files in plan, no security/core paths) — skip prd, architecture, report
  - Tier 2: Standard feature (multiple files, design doc present) — skip prd, architecture (default)
  - Tier 3: Cross-component or security-sensitive — enable architecture, skip prd
  - Tier 4: Architecture change, shared/core code — enable prd and architecture
- [ ] **Signal analysis** (reads files, does not call LLM):
  - Count file paths mentioned in plan.md/blueprint.md (regex for backtick-quoted paths)
  - Check for security-sensitive paths (auth, crypto, session, middleware)
  - Check for shared/core code paths (lib/, server/index, connector base classes)
  - Count tasks in plan.md (markdown checkbox items)
- [ ] **Profile output:** `{ needs_prd: boolean, needs_architecture: boolean, needs_verification: boolean, needs_report: boolean }`
- [ ] **Return:** `{ tier: 0-4, profile, rationale: string, signals: { fileCount, securityPaths, corePaths, taskCount } }`

### Task 2: Integrate triage into build

**File:** `compose/lib/build.js` (existing)

- [ ] Import `runTriage` from `./triage.js`
- [ ] Import `readFeature`, `writeFeature` from `./feature-json.js`
- [ ] **Before spec loading** (~line 262, before `const specPath`):
  - If `!opts.skipTriage`:
    - Read feature.json via `readFeature(cwd, featureCode)`
    - Check cache validity: if feature.json has a `triageTimestamp` AND no file in the feature folder has an mtime newer than that timestamp, reuse the stored profile
    - Otherwise call `runTriage(featureCode, { cwd })`
    - Persist to feature.json: use `writeFeature()` if feature.json doesn't exist (create with code + description + profile), otherwise use `updateFeature()` to merge `{ complexity, profile, triageTimestamp }`
    - Log tier and profile to console
  - Read the profile from feature.json (whether fresh or cached)
- [ ] **After spec YAML is parsed** (after `readFileSync(specPath, 'utf-8')`):
  - Parse YAML into object (import `yaml` or use existing YAML parser)
  - Find the `build` flow's steps array
  - For each skippable step (`prd`, `architecture`, `verification`, `report`):
    - If profile says `needs_<step>` is true: delete `skip_if` and `skip_reason` from that step
    - If profile says `needs_<step>` is false: set `skip_if: "true"` and `skip_reason: "Skipped by triage (tier N)"`
  - Serialize back to YAML string for `stratum_plan()`
  - **`opts.template` still wins** — if user passes `--template`, skip triage entirely
- [ ] **Remove the ghost scope-step persistence** (lines 500-512): replace the `if (stepId === 'scope')` block with a comment noting that triage now handles this pre-build

### Task 3: feature.json creation on triage

**File:** `compose/lib/build.js` (existing) and `compose/lib/triage.js` (new)

- [ ] When triage runs and `readFeature()` returns null, create feature.json via `writeFeature(cwd, { code: featureCode, description, status: 'PLANNED', ...triageResult })` — the feature folder already exists (it has plan.md/design.md), it just lacks feature.json
- [ ] `triageTimestamp` field: ISO string of when triage ran, used for cache invalidation

### Task 4: Cache invalidation

**File:** `compose/lib/triage.js` (new)

- [ ] Export `function isTriageStale(cwd, featureCode)` → boolean
- [ ] Read feature.json's `triageTimestamp`
- [ ] `statSync` all files in the feature folder (`docs/features/<CODE>/`)
- [ ] If any file's `mtime` is newer than `triageTimestamp`, return true (stale)
- [ ] If no `triageTimestamp` exists, return true (never triaged)

### Task 5: CLI plumbing

**File:** `compose/bin/compose.js` (existing)

- [ ] Add `triage` to the help text (~line 34): `'  triage    Analyze a feature and recommend build profile'`
- [ ] Add `--template <name>` flag to the build command option parsing (~line 856): extract template name from args, pass as `opts.template` to `runBuild()`
- [ ] Add `--skip-triage` flag to the build command (~line 856): pass as `opts.skipTriage` to `runBuild()`
- [ ] Add `triage` command handler (after the build handler, ~line 920):
  - Parse feature code from args
  - Call `runTriage(featureCode, { cwd: process.cwd() })`
  - Print formatted result: tier, profile flags, signal counts, rationale
  - Persist to feature.json (create if missing, update if exists)

### Task 6: Tests

**File:** `compose/test/triage.test.js` (new)

- [ ] Test: config-only feature folder (no plan.md, no blueprint.md) -> tier 0, all needs_* false
- [ ] Test: single-file plan with no security paths -> tier 1, needs_verification true, rest false
- [ ] Test: multi-file plan, standard complexity -> tier 2, needs_verification true, rest false
- [ ] Test: plan references auth/crypto paths -> tier 3+, needs_architecture true
- [ ] Test: plan references core/shared code -> tier 4, needs_prd and needs_architecture true
- [ ] Test: `isTriageStale()` returns true when plan.md mtime > triageTimestamp
- [ ] Test: `isTriageStale()` returns false when triageTimestamp is newer than all files
- [ ] Test: triage creates feature.json when it doesn't exist
- [ ] Test: triage updates existing feature.json without clobbering other fields
- [ ] Test: build.js applies profile to spec YAML — prd step gets skip_if removed when needs_prd is true
- [ ] Test: `--skip-triage` flag causes build to skip triage and use spec as-is
- [ ] Test: `--template` flag causes build to skip triage entirely

## Non-goals

- **No new pipeline templates** (build-lite, etc.) — the existing build.stratum.yaml with skip_if toggling covers all tiers
- **No LLM calls in triage** — pure file analysis and heuristics
- **No triage history log** — removed from scope; if needed later, it's a one-liner append to a JSON file
- **No scope step in the pipeline** — triage replaces it as a pre-build function, not a Stratum-managed step
