# INIT-1: Implementation Blueprint

## Corrections Table

| Design assumption | Reality | Impact |
|---|---|---|
| `findProjectRoot` needs to be "extracted to a shared location" | It exists in `project-root.js:23` but that module has side effects (`TARGET_ROOT` IIFE calls `process.exit`). Importing it from `bin/compose.js` would trigger the IIFE before CLI validation runs. | Extract to a new side-effect-free `server/find-root.js`; both `project-root.js` and `bin/compose.js` import from it |
| Stratum imports in `vision-server.js` would cause load-time errors if stratum packages are absent | `stratum-sync.js` and `stratum-api.js` only import from `stratum-client.js`, which is local code (not a pip package). The only external dependency is the `stratum-mcp` binary, which is spawned at runtime, not imported. | No dynamic imports needed — static imports are safe, just don't call the functions |
| `attachStratumRoutes` needs the `sync` parameter | Agent 3 found that `sync` is accepted in the signature but never used in the function body (`stratum-sync.js:137`). | Can pass `null` for `sync` when stratum is disabled — no functional change |
| `file-watcher.js` paths can be made config-driven by passing a parameter | `PROJECT_ROOT` is a module-level constant with no per-instance override. `FileWatcherServer` has no constructor params. | Need to add a `config` parameter to constructor or `attach()`, or read config at module level |
| `compose-mcp-tools.js` paths can be changed to use `resolveProjectPath()` | The MCP tools file exports `PROJECT_ROOT` as a named export consumed externally. Changing the value is fine, but the export contract must be preserved. | Use `resolveProjectPath('features')` internally, keep `PROJECT_ROOT` export |
| `createStratumRouter()` would crash if stratum-mcp is missing | Agent 3 confirmed it already has error middleware returning 503 on ENOENT. The router itself is safe to mount even without stratum-mcp. | Only need to guard `StratumSync.start()` (the poller) and optionally skip route mounting for cleanliness |

## Task Breakdown

### Task 1: Extract `findProjectRoot` to `server/find-root.js` and add config loader to `project-root.js`

**File:** `server/find-root.js` (new) — see Task 2 section above for exact contents.

**File:** `server/project-root.js` (existing)

**Changes:**

1. Replace the private `findProjectRoot` function and `MARKERS` constant (lines 20-33) with an import from the new module:
```js
// Before (lines 20-33):
const MARKERS = ['.compose', '.stratum.yaml', '.git'];
function findProjectRoot(startDir) { ... }

// After:
import { findProjectRoot } from './find-root.js';
```

Re-export `findProjectRoot` for any server-side consumers that currently import from `project-root.js`:
```js
export { findProjectRoot } from './find-root.js';
```

2. Add `DEFAULT_CONFIG` constant and `loadProjectConfig()` function after `ensureDataDir()`:
```js
const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  capabilities: Object.freeze({ stratum: true, speckit: false, lifecycle: true }),
  paths: Object.freeze({ docs: 'docs', features: 'docs/features', journal: 'docs/journal' }),
});

function cloneConfig(obj) {
  return JSON.parse(JSON.stringify(obj));
}

let _configCache = null;

export function loadProjectConfig() {
  if (_configCache) return cloneConfig(_configCache);
  const configPath = path.join(TARGET_ROOT, '.compose', 'compose.json');
  try {
    _configCache = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return cloneConfig(_configCache);
  } catch {
    return cloneConfig(DEFAULT_CONFIG);
  }
}

export function resolveProjectPath(key) {
  const config = loadProjectConfig();
  const rel = config.paths?.[key];
  if (!rel) return path.join(TARGET_ROOT, DEFAULT_CONFIG.paths[key] || key);
  return path.join(TARGET_ROOT, rel);
}
```

`DEFAULT_CONFIG` is frozen to prevent accidental mutation. `loadProjectConfig()` always returns a fresh clone — callers (like `index.js` setting `capabilities.stratum = false`) mutate their own copy without affecting the cache or future callers. Cache is module-level — the file is read once per process, cloned on each call.

**Test:** Unit test for `loadProjectConfig` with missing file, valid file, corrupt file. Unit test for `resolveProjectPath` with default and custom paths.

---

### Task 2: Rewrite `bin/compose.js` — init/setup/install/start

**File:** `bin/compose.js` (existing, full rewrite)

**Changes:**

1. Extract `findProjectRoot` and `MARKERS` into a new side-effect-free module `server/find-root.js`:

```js
// server/find-root.js — Pure utility, no side effects at import time.
import path from 'node:path';
import fs from 'node:fs';

export const MARKERS = ['.compose', '.stratum.yaml', '.git'];

export function findProjectRoot(startDir) {
  let dir = path.resolve(startDir);
  const { root } = path.parse(dir);
  while (dir !== root) {
    for (const marker of MARKERS) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}
```

Then `server/project-root.js` imports from it instead of defining its own copy:

```js
// server/project-root.js — replace lines 20-33
import { findProjectRoot, MARKERS } from './find-root.js';
// ... TARGET_ROOT IIFE, DATA_DIR, etc. unchanged
```

And `bin/compose.js` imports from the same safe module:

```js
import { findProjectRoot } from '../server/find-root.js';
```

This keeps one source of truth for the marker list and walk logic without pulling in the `TARGET_ROOT` IIFE (which calls `process.exit` on bad `COMPOSE_TARGET`). The side-effecting module (`project-root.js`) delegates to the pure one (`find-root.js`), and CLI code never imports the side-effecting module directly.

2. `compose init` command:
```
compose init [--no-stratum] [--no-lifecycle]
```

Steps:
- Create `.compose/` in cwd
- Detect capabilities: `stratum` = `which stratum-mcp` succeeds (unless `--no-stratum`), `speckit` = `.specify/` exists, `lifecycle` = true (unless `--no-lifecycle`)
- Write `.compose/compose.json` with detected capabilities + default paths
- If file exists, merge: preserve existing `paths`, update `capabilities` only if flags override
- Create `.compose/data/`
- Register `compose-mcp` in `.mcp.json` (existing step 2 logic from install)
- Scaffold `ROADMAP.md` from template if absent (existing step 4 logic)
- Print summary

3. `compose setup` command:
```
compose setup
```

Steps:
- Install `/compose` skill to `~/.claude/skills/compose/SKILL.md` (existing step 3 logic)
- If `stratum-mcp` on PATH, run `stratum-mcp install` (existing step 1 stratum registration)
- Print what was set up

4. `compose install` command — alias:
```js
if (cmd === 'install') {
  // Run init, then setup
  runInit(args);
  runSetup();
  process.exit(0);
}
```

5. `compose start` — fix target binding:
```js
if (cmd === 'start') {
  // Resolve target root BEFORE spawning supervisor
  const explicitTarget = process.env.COMPOSE_TARGET;
  const targetRoot = explicitTarget
    ? resolve(explicitTarget)
    : findProjectRoot(process.cwd());

  if (!targetRoot || !existsSync(join(targetRoot, '.compose', 'compose.json'))) {
    console.error('[compose] No .compose/ found (searched from cwd upward).');
    console.error('[compose] Run \'compose init\' first, or set COMPOSE_TARGET.');
    process.exit(1);
  }

  const child = spawn('node', [join(PACKAGE_ROOT, 'server', 'supervisor.js')], {
    stdio: 'inherit',
    cwd: PACKAGE_ROOT,
    env: { ...process.env, COMPOSE_TARGET: targetRoot },
  });
  // ... existing error/exit handlers
}
```

**Test:** Extend `test/install.test.js` with init-specific tests. New `test/init.test.js` for the full bootstrap flow.

---

### Task 3: Stratum soft-fail in `server/index.js`

**File:** `server/index.js` (existing)

**Changes:**

Replace lines 13-26 (hard exit on missing stratum-mcp):

```js
// Before:
try {
  execFileSync('which', ['stratum-mcp'], { stdio: 'ignore' });
} catch {
  // ... banner ...
  process.exit(1);
}

// After:
import { loadProjectConfig } from './project-root.js';
const projectConfig = loadProjectConfig();

// Verify stratum capability matches reality
if (projectConfig.capabilities.stratum) {
  try {
    execFileSync('which', ['stratum-mcp'], { stdio: 'ignore' });
  } catch {
    console.warn('[compose] stratum-mcp not found — Stratum features disabled');
    console.warn('[compose] Install: pip install stratum && stratum-mcp install');
    projectConfig.capabilities.stratum = false;
  }
}
```

Pass `projectConfig` to `VisionServer` constructor (new second param or options bag):

```js
// Line 59 area:
const visionServer = new VisionServer(visionStore, sessionManager, { config: projectConfig });
```

Replace hardcoded `featureRoot` at line 65:

```js
// Before:
featureRoot: path.join(TARGET_ROOT, 'docs', 'features'),
// After:
featureRoot: resolveProjectPath('features'),
```

**Test:** Test that startup succeeds when `stratum-mcp` is not on PATH. Test that `capabilities.stratum` is set to false at runtime.

---

### Task 4: Stratum conditional in `server/vision-server.js`

**File:** `server/vision-server.js` (existing)

**Changes:**

1. Accept `config` in constructor:
```js
constructor(store, sessionManager = null, { config } = {}) {
  // ... existing fields ...
  this._config = config || { capabilities: { stratum: true } };
}
```

2. Guard stratum section in `attach()` (replacing lines 118-129):
```js
// ── Stratum (conditional) ────────────────────────────────────────────
if (this._config.capabilities?.stratum) {
  app.use('/api/stratum', createStratumRouter());
  this._stratumSync = new StratumSync(this.store, () => this.scheduleBroadcast());
  attachStratumRoutes(app, {
    store: this.store,
    scheduleBroadcast: () => this.scheduleBroadcast(),
    broadcastMessage: (msg) => this.broadcastMessage(msg),
    sync: this._stratumSync,
  });
  this._stratumSync.start();
  console.log('[vision] Stratum sync enabled');
} else {
  app.use('/api/stratum', (_req, res) => {
    res.status(503).json({ error: 'Stratum not enabled', hint: 'pip install stratum && compose init' });
  });
}
```

3. `close()` — already null-guards `this._stratumSync` at line 211. No change needed.

4. Pass config-driven `projectRoot` where `PROJECT_ROOT` is currently used. Actually, `PROJECT_ROOT` is already `TARGET_ROOT` and flows to routes via params. The paths inside routes are addressed in Task 5.

**Test:** Test VisionServer attach with `capabilities.stratum = false` — verify no StratumSync created, stub route returns 503.

---

### Task 5: Config-driven paths in `server/vision-routes.js`

**File:** `server/vision-routes.js` (existing)

**Changes:**

Import `resolveProjectPath` and use it consistently with the rest of the codebase:

```js
import { TARGET_ROOT, resolveProjectPath } from './project-root.js';
const PROJECT_ROOT = TARGET_ROOT;
```

Replace hardcoded `docs/features` at lines 122 and 262:

```js
// Line 122 — before:
const lifecycleManager = new LifecycleManager(store, path.join(projectRoot, 'docs', 'features'), settingsStore);
// After:
const featuresPath = resolveProjectPath('features');
const lifecycleManager = new LifecycleManager(store, featuresPath, settingsStore);

// Line 262 — before:
const artifactManager = new ArtifactManager(path.join(projectRoot, 'docs', 'features'));
// After:
const artifactManager = new ArtifactManager(featuresPath);
```

Both constructors are called once at route-attachment time, so `featuresPath` is computed once and reused. No `config` parameter needed — `resolveProjectPath` reads config internally, maintaining the single-resolver discipline from the design.

**Test:** Verify LifecycleManager and ArtifactManager receive custom paths when config overrides are set.

---

### Task 6: Config-driven paths in `server/file-watcher.js`

**File:** `server/file-watcher.js` (existing)

**Changes:**

`FileWatcherServer` currently reads `PROJECT_ROOT` as a module-level constant with no instance override. Add config support:

1. Import `loadProjectConfig` from `project-root.js`:
```js
import { TARGET_ROOT, loadProjectConfig } from './project-root.js';
const PROJECT_ROOT = TARGET_ROOT;
```

2. In `startWatching()`, read docs path from config:
```js
startWatching() {
  const config = loadProjectConfig();
  const docsPrefix = config.paths?.docs || 'docs';
  const docsDir = path.join(PROJECT_ROOT, docsPrefix);
  // ...
  watchDir(docsDir, docsPrefix, (relativePath, fullPath) => { ... });
  watchDir(path.join(PROJECT_ROOT, '.specify'), '.specify', (relativePath) => { ... });
}
```

3. In `/api/files` endpoint, same pattern:
```js
app.get('/api/files', (_req, res) => {
  const config = loadProjectConfig();
  const docsPrefix = config.paths?.docs || 'docs';
  const docsDir = path.join(PROJECT_ROOT, docsPrefix);
  // ...
});
```

The `safePath()` method (line 24) uses `PROJECT_ROOT` for security boundary — this stays as-is. The boundary is the project root, not the docs dir.

**Test:** Verify file watcher watches custom docs path when config overrides it.

---

### Task 7: Config-driven paths in `server/vision-utils.js`

**File:** `server/vision-utils.js` (existing)

**Changes:**

`spawnJournalAgent` already accepts `projectRoot` as a parameter. Add a `journalPath` parameter:

```js
export function spawnJournalAgent(session, transcriptPath, projectRoot = PROJECT_ROOT, journalPath = null) {
  const config = loadProjectConfig();
  const journalRel = journalPath || config.paths?.journal || 'docs/journal';
  const journalAbs = path.join(projectRoot, journalRel);
```

Replace line 88:
```js
const entries = fs.readdirSync(journalAbs);
```

Replace the prompt string (lines 95-105) — use `journalRel` for the relative paths in the prompt (since the spawned agent runs with `cwd: projectRoot`):
```js
const prompt = `You are writing a developer journal entry for the Compose project.
Read the transcript at: ${transcriptPath}
Write a journal entry at ${journalRel}/${today}-session-${sessionNum}-<slug>.md following the exact format of existing entries in ${journalRel}/. Use first person plural ("we"). Be honest about failures.
Session data:
- Duration: ${durationSec}s (${Math.round(durationSec / 60)} minutes)
- Tool uses: ${session.toolCount}
- Items worked on:\n${itemSummaries || '(none resolved)'}
- Work blocks:\n${blockSummaries || '(single block)'}
- Commits: ${(session.commits || []).join(', ') || '(none)'}
After writing the entry, update ${journalRel}/README.md with the new entry row.
Then commit both files.`;
```

**Test:** Verify journal agent prompt uses custom journal path from config.

---

### Task 8: Config-driven paths in `server/compose-mcp-tools.js`

**File:** `server/compose-mcp-tools.js` (existing)

**Changes:**

Import `resolveProjectPath`:
```js
import { TARGET_ROOT, DATA_DIR, resolveProjectPath } from './project-root.js';
```

Replace lines 311 and 317:
```js
// Before (line 311):
const featureRoot = path.join(PROJECT_ROOT, 'docs', 'features');
// After:
const featureRoot = resolveProjectPath('features');

// Before (line 317):
const featureRoot = path.join(PROJECT_ROOT, 'docs', 'features');
// After:
const featureRoot = resolveProjectPath('features');
```

Keep `PROJECT_ROOT` export for external consumers — its value is already `TARGET_ROOT`.

**Test:** Verify MCP tools use custom features path from config.

---

### Task 9: Config-driven `featureRoot` in `server/index.js`

Already covered in Task 3. The `featureRoot` passed to `SessionManager` at line 65 changes from `path.join(TARGET_ROOT, 'docs', 'features')` to `resolveProjectPath('features')`.

---

### Task 10: Tests

**File:** `test/init.test.js` (new)

Tests for `compose init`:
- [ ] Creates `.compose/` directory
- [ ] Writes `.compose/compose.json` with correct schema
- [ ] Creates `.compose/data/` directory
- [ ] Registers `compose-mcp` in `.mcp.json`
- [ ] Scaffolds `ROADMAP.md` from template
- [ ] Detects stratum capability from PATH
- [ ] `--no-stratum` flag disables stratum capability
- [ ] `--no-lifecycle` flag disables lifecycle capability
- [ ] Idempotent: re-init preserves existing config values
- [ ] Merges into existing `.mcp.json` without clobbering

Tests for `compose setup`:
- [ ] Installs skill to `~/.claude/skills/compose/SKILL.md`
- [ ] Registers stratum-mcp if on PATH

Tests for `compose install` (alias):
- [ ] Runs both init + setup effects

Tests for `compose start`:
- [ ] Resolves project root via parent traversal (run from subdirectory)
- [ ] Exits with error when no `.compose/` found
- [ ] Passes resolved root as `COMPOSE_TARGET` to supervisor

**File:** `test/project-config.test.js` (new)

- [ ] `loadProjectConfig` returns defaults when no file exists
- [ ] `loadProjectConfig` reads valid `.compose/compose.json`
- [ ] `loadProjectConfig` returns defaults on corrupt JSON
- [ ] `resolveProjectPath` returns absolute path using config
- [ ] `resolveProjectPath` falls back to defaults for missing keys

**File:** `test/stratum-softfail.test.js` (new)

- [ ] VisionServer with `stratum: false` does not create StratumSync
- [ ] Stub stratum route returns 503 with hint message
- [ ] VisionServer with `stratum: true` creates StratumSync normally

**Modify:** `test/install.test.js`
- [ ] Add test that `compose init` works as a command (alias for the new init flow)
- [ ] Keep existing tests as-is (they test `compose install` which now runs init + setup)

## Dependency Order

```
Task 1  (project-root.js — config loader)
  ↓
Task 2  (bin/compose.js — init/setup/start)     ← depends on findProjectRoot export
  ↓
Task 3  (index.js — stratum soft-fail)           ← depends on loadProjectConfig
Task 4  (vision-server.js — stratum conditional) ← depends on config param from Task 3
  ↓
Tasks 5-8 (config-driven paths)                  ← depend on resolveProjectPath from Task 1
  ↓
Task 10 (tests)                                  ← depends on all above
```

Tasks 5, 6, 7, 8 are independent of each other and can be parallelized.

## Verification Checklist

After implementation:

- [ ] `compose init` in empty dir creates `.compose/compose.json` with correct defaults
- [ ] `compose start` from subdirectory of initialized repo finds the root
- [ ] `compose start` without init prints error and exits non-zero
- [ ] Server starts without `stratum-mcp` installed — no crash, stratum routes return 503
- [ ] Server starts without `docs/` directory — no crash, empty file list
- [ ] Custom `paths.features` in config is respected by lifecycle and artifact endpoints
- [ ] All existing tests (375) still pass
- [ ] New tests pass
