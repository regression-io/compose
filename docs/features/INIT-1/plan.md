# INIT-1: Implementation Plan

## Task Order

Sequential tasks 1-4, then parallel tasks 5-8, then task 9 (tests).

---

### Task 1: Create `server/find-root.js` and refactor `server/project-root.js`

**Files:** `server/find-root.js` (new), `server/project-root.js` (existing)

**Steps:**

- [ ] Create `server/find-root.js` with `MARKERS` array and `findProjectRoot(startDir)` function — pure, no side effects
- [ ] In `server/project-root.js`, replace lines 20-33 (private `MARKERS` + `findProjectRoot`) with `import { findProjectRoot } from './find-root.js'`
- [ ] Add re-export: `export { findProjectRoot } from './find-root.js'`
- [ ] Add frozen `DEFAULT_CONFIG` constant after `ensureDataDir()`
- [ ] Add `cloneConfig(obj)` helper (JSON round-trip)
- [ ] Add `loadProjectConfig()` — reads `.compose/compose.json` from `TARGET_ROOT`, caches raw result, returns cloned copy on every call; returns cloned `DEFAULT_CONFIG` on missing/corrupt file
- [ ] Add `resolveProjectPath(key)` — calls `loadProjectConfig()`, joins `TARGET_ROOT` with `config.paths[key]`, falls back to `DEFAULT_CONFIG.paths[key]`
- [ ] Export: `findProjectRoot`, `loadProjectConfig`, `resolveProjectPath` (plus existing `COMPOSE_HOME`, `TARGET_ROOT`, `DATA_DIR`, `ensureDataDir`)
- [ ] `node --check server/find-root.js && node --check server/project-root.js`
- [ ] Run existing tests: `node --test test/*.test.js` — all 375 must pass

**Pattern:** Follow existing export style in `project-root.js`. `DEFAULT_CONFIG` uses `Object.freeze` recursively.

---

### Task 2: Rewrite `bin/compose.js` — init, setup, install, start

**File:** `bin/compose.js` (existing, substantial rewrite)

**Steps:**

- [ ] Import `findProjectRoot` from `../server/find-root.js` (side-effect-free module)
- [ ] Add `import { parse } from 'node:path'` if not already present
- [ ] Implement `runInit(args)` function:
  - [ ] Parse `--no-stratum` and `--no-lifecycle` flags from `args`
  - [ ] Create `.compose/` directory in cwd (`mkdirSync` with `{ recursive: true }`)
  - [ ] Detect capabilities: `stratum` = `spawnSync('which', ['stratum-mcp']).status === 0` (unless `--no-stratum`), `speckit` = `existsSync('.specify/')`, `lifecycle` = true (unless `--no-lifecycle`)
  - [ ] Read existing `.compose/compose.json` if present — merge: preserve existing `paths`, update `capabilities` only if detection or flags override
  - [ ] Write `.compose/compose.json` with `version: 1`, detected `capabilities`, default `paths`
  - [ ] Create `.compose/data/` directory
  - [ ] Register `compose-mcp` in `.mcp.json` (move existing logic from `install` into `runInit`)
  - [ ] Scaffold `ROADMAP.md` from template if absent (move existing logic from `install`)
  - [ ] Print summary: what was created, what capabilities detected
- [ ] Implement `runSetup()` function:
  - [ ] Install `/compose` skill to `~/.claude/skills/compose/SKILL.md` (move existing logic)
  - [ ] If `stratum-mcp` on PATH, run `stratum-mcp install` (move existing logic)
  - [ ] Print what was set up
- [ ] Wire commands:
  - [ ] `compose init` → `runInit(args); process.exit(0)`
  - [ ] `compose setup` → `runSetup(); process.exit(0)`
  - [ ] `compose install` → `runInit(args); runSetup(); process.exit(0)` (backwards-compat alias)
- [ ] Fix `compose start`:
  - [ ] Resolve target: if `COMPOSE_TARGET` env set, use it; else call `findProjectRoot(process.cwd())`
  - [ ] Validate: resolved root must exist and contain `.compose/compose.json` — if not, print error with instructions and exit 1
  - [ ] Spawn supervisor with `env: { ...process.env, COMPOSE_TARGET: resolvedTargetRoot }`
  - [ ] Keep `cwd: PACKAGE_ROOT` (supervisor needs Compose's own node_modules)
- [ ] Update help text to list all four commands
- [ ] `node --check bin/compose.js`

**Pattern:** Keep synchronous flow (no async). Use `spawnSync` for detection, `spawn` only for supervisor.

---

### Task 3: Stratum soft-fail in `server/index.js`

**File:** `server/index.js` (existing)

**Steps:**

- [ ] Add `loadProjectConfig, resolveProjectPath` to the import from `./project-root.js`
- [ ] Replace lines 13-26 (stratum hard exit) with:
  - [ ] `const projectConfig = loadProjectConfig()`
  - [ ] If `projectConfig.capabilities.stratum` is true, try `execFileSync('which', ['stratum-mcp'])` — on failure, warn and set `projectConfig.capabilities.stratum = false` (safe: `loadProjectConfig` returns a cloned copy)
  - [ ] If `projectConfig.capabilities.stratum` is false (from config or downgrade), log that stratum is disabled
- [ ] Replace `featureRoot: path.join(TARGET_ROOT, 'docs', 'features')` at line 65 with `featureRoot: resolveProjectPath('features')`
- [ ] Pass `projectConfig` to `VisionServer` constructor: `new VisionServer(visionStore, sessionManager, { config: projectConfig })`
- [ ] `node --check server/index.js`

**Pattern:** `projectConfig` is the local mutable copy for this process lifetime. Mutations to it don't leak to other callers of `loadProjectConfig()`.

---

### Task 4: Stratum conditional in `server/vision-server.js`

**File:** `server/vision-server.js` (existing)

**Steps:**

- [ ] Update constructor signature: `constructor(store, sessionManager = null, { config } = {})`
- [ ] Store config: `this._config = config || { capabilities: { stratum: true } }`
- [ ] Wrap stratum section (lines 118-129) in `if (this._config.capabilities?.stratum)`:
  - [ ] True branch: existing code (createStratumRouter, StratumSync, attachStratumRoutes, start)
  - [ ] False branch: mount stub middleware returning 503 with `{ error: 'Stratum not enabled', hint: 'pip install stratum && compose init' }`
- [ ] Add log: `[vision] Stratum sync enabled` in true branch (no log in false — the index.js warning covers it)
- [ ] `close()` already null-guards `this._stratumSync` — no change needed
- [ ] `node --check server/vision-server.js`

**Pattern:** Static imports of stratum modules are fine — they're local code, not external packages. The guard prevents calling them, not loading them.

---

### Task 5: Config-driven paths in `server/vision-routes.js` (parallel)

**File:** `server/vision-routes.js` (existing)

**Steps:**

- [ ] Add `resolveProjectPath` to the import from `./project-root.js`
- [ ] At line 122, replace `path.join(projectRoot, 'docs', 'features')` with `resolveProjectPath('features')`
- [ ] Store result in `const featuresPath` and reuse at line 262 for `ArtifactManager`
- [ ] `node --check server/vision-routes.js`

---

### Task 6: Config-driven paths in `server/file-watcher.js` (parallel)

**File:** `server/file-watcher.js` (existing)

**Steps:**

- [ ] Add `loadProjectConfig` to the import from `./project-root.js`
- [ ] In `startWatching()`, read config: `const config = loadProjectConfig()`
- [ ] Replace hardcoded `'docs'` prefix with `config.paths?.docs || 'docs'`
- [ ] Replace `path.join(PROJECT_ROOT, 'docs')` at line 164 with `path.join(PROJECT_ROOT, docsPrefix)`
- [ ] In `/api/files` endpoint (line 52), same pattern: read config, compute `docsDir` from `config.paths.docs`
- [ ] `.specify/` watch (line 175) stays hardcoded — it's detected, not configured
- [ ] `safePath()` stays unchanged — security boundary is `PROJECT_ROOT`, not docs dir
- [ ] `node --check server/file-watcher.js`

---

### Task 7: Config-driven paths in `server/vision-utils.js` (parallel)

**File:** `server/vision-utils.js` (existing)

**Steps:**

- [ ] Add `loadProjectConfig` to the import from `./project-root.js`
- [ ] In `spawnJournalAgent`, after existing params, compute `journalRel` from config: `const config = loadProjectConfig(); const journalRel = config.paths?.journal || 'docs/journal'`
- [ ] Replace `path.join(projectRoot, 'docs', 'journal')` at line 88 with `path.join(projectRoot, journalRel)`
- [ ] Replace all three `docs/journal/` occurrences in the prompt string (lines 97, 97, 104) with `${journalRel}/`
- [ ] `node --check server/vision-utils.js`

---

### Task 8: Config-driven paths in `server/compose-mcp-tools.js` (parallel)

**File:** `server/compose-mcp-tools.js` (existing)

**Steps:**

- [ ] Add `resolveProjectPath` to the import from `./project-root.js`
- [ ] Replace `path.join(PROJECT_ROOT, 'docs', 'features')` at line 311 with `resolveProjectPath('features')`
- [ ] Replace `path.join(PROJECT_ROOT, 'docs', 'features')` at line 317 with `resolveProjectPath('features')`
- [ ] Keep `PROJECT_ROOT` export unchanged — external consumers still need it
- [ ] `node --check server/compose-mcp-tools.js`

---

### Task 9: Tests

**Files:** `test/project-config.test.js` (new), `test/init.test.js` (new), `test/stratum-softfail.test.js` (new), `test/install.test.js` (modify)

**Steps:**

#### `test/project-config.test.js` (new)

- [ ] `loadProjectConfig` returns defaults when no `.compose/compose.json` exists
- [ ] `loadProjectConfig` reads and returns valid config from disk
- [ ] `loadProjectConfig` returns defaults on corrupt JSON
- [ ] `loadProjectConfig` returns a fresh clone each call (mutating one copy doesn't affect the next)
- [ ] `resolveProjectPath('features')` returns absolute path using config value
- [ ] `resolveProjectPath('docs')` returns absolute path using config value
- [ ] `resolveProjectPath('journal')` returns absolute path using config value
- [ ] `resolveProjectPath` falls back to default for missing keys
- [ ] `findProjectRoot` finds `.compose/` marker in parent directory
- [ ] `findProjectRoot` returns null when no marker found

#### `test/init.test.js` (new)

Follow existing `install.test.js` pattern: real subprocess, temp dirs, fake `stratum-mcp`.

- [ ] `compose init` creates `.compose/` directory
- [ ] `compose init` writes `.compose/compose.json` with version, capabilities, paths
- [ ] `compose init` creates `.compose/data/` directory
- [ ] `compose init` registers `compose-mcp` in `.mcp.json`
- [ ] `compose init` scaffolds `ROADMAP.md` from template
- [ ] `compose init` detects stratum capability from PATH
- [ ] `compose init --no-stratum` sets `capabilities.stratum: false`
- [ ] `compose init --no-lifecycle` sets `capabilities.lifecycle: false`
- [ ] Re-init is idempotent: preserves existing `paths` values
- [ ] `compose setup` installs skill to `~/.claude/skills/`
- [ ] `compose install` runs both init + setup effects
- [ ] `compose start` exits non-zero when no `.compose/` found
- [ ] `compose start` resolves project root from subdirectory (parent traversal)
- [ ] `compose start` honors explicit `COMPOSE_TARGET` env pointing at a valid initialized repo

#### `test/config-paths.test.js` (new)

Integration tests verifying config-driven paths reach actual consumers.

- [ ] `file-watcher.js`: with custom `paths.docs`, `/api/files` endpoint lists files from the custom directory (not hardcoded `docs/`)
- [ ] `file-watcher.js`: with custom `paths.docs`, watcher targets the custom directory
- [ ] `vision-utils.js`: with custom `paths.journal`, `spawnJournalAgent` prompt string contains the custom path (not hardcoded `docs/journal/`)
- [ ] `vision-utils.js`: with custom `paths.journal`, `readdirSync` targets the custom directory
- [ ] `compose-mcp-tools.js`: with custom `paths.features`, `toolAssessFeatureArtifacts` uses the custom path

#### `test/stratum-softfail.test.js` (new)

- [ ] VisionServer with `capabilities.stratum: false` does not create StratumSync (`_stratumSync` is null)
- [ ] Stub stratum route returns 503 with hint message
- [ ] VisionServer with `capabilities.stratum: true` creates StratumSync normally

#### `test/install.test.js` (modify)

- [ ] Existing 7 tests still pass (install = init + setup now)
- [ ] Verify that `compose install` still creates `.mcp.json`, skill, and ROADMAP.md (backwards compat)

#### Final validation

- [ ] Run full suite: `node --test test/*.test.js` — all tests pass (existing 375 + new)
- [ ] `node --check` on every modified server file
