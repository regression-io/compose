# INIT-1: Compose Project Bootstrap

## Problem

Compose cannot reliably attach to an arbitrary project. Five specific gaps:

1. **No project binding at startup.** `compose start` (bin/compose.js:86) launches the supervisor with `cwd: PACKAGE_ROOT`. `project-root.js` resolves `TARGET_ROOT` from `process.cwd()`. Result: Compose always binds to its own repo, not the project where the user ran the command.

2. **No bootstrap command.** `compose install` writes `.mcp.json`, copies a skill, and optionally scaffolds `ROADMAP.md`. It does not create `.compose/`, does not write a project manifest, and does not set up state directories.

3. **Hard stratum dependency.** `index.js` exits on missing `stratum-mcp`. But `vision-server.js` also unconditionally mounts stratum routes, creates `StratumSync`, and starts polling. Removing the startup crash alone leaves a permanently noisy half-enabled runtime.

4. **Hardcoded artifact paths.** `docs/features/` is hardcoded in `vision-routes.js:122` (LifecycleManager), `vision-routes.js:262` (ArtifactManager), `session-manager.js:65`, and `compose-mcp-tools.js:312,318`. `docs/` and `.specify/` are hardcoded in `file-watcher.js:164,175`. A non-Compose-shaped project breaks lifecycle and artifact scaffolding.

5. **Global side effects in project init.** Installing a skill into `~/.claude/skills/` and registering stratum-mcp are user-global operations mixed into a project-local init flow. This is not deterministic or safely automatable by an LLM.

## Design

### 1. `compose init` — project-local setup

```
compose init [--no-stratum] [--no-lifecycle]
```

**Project-local only.** Does not touch `~/.claude/` or register global MCP servers.

What it does:

1. Creates `.compose/` in cwd
2. Writes `.compose/compose.json` — the project manifest (see section 2)
3. Creates `.compose/data/` for state files
4. Registers `compose-mcp` in `.mcp.json` (project-local, existing behavior)
5. Detects `stratum-mcp` on PATH — records `capabilities.stratum: true/false`
6. Detects `.specify/` — records `capabilities.speckit: true/false`
7. Scaffolds `ROADMAP.md` from template if absent (existing behavior)
8. Prints summary of capabilities and next steps

**Idempotent.** Re-running merges, doesn't clobber. Existing `.compose/compose.json` values are preserved unless overridden by explicit flags.

### 2. `compose setup` — user-global setup (separate command)

```
compose setup
```

What it does:

1. Installs `/compose` skill to `~/.claude/skills/compose/SKILL.md`
2. Registers `stratum-mcp` with Claude Code (if stratum on PATH)

Run once per machine. Not required for `compose init` or `compose start` to work. An LLM can call `compose init` without `compose setup` and Compose works — just without the `/compose` skill shortcut or stratum MCP in the global config.

`compose install` becomes an alias that runs both `init` + `setup` for backwards compat.

### 3. Project manifest: `.compose/compose.json`

```json
{
  "version": 1,
  "capabilities": {
    "stratum": true,
    "speckit": false,
    "lifecycle": true
  },
  "paths": {
    "docs": "docs",
    "features": "docs/features",
    "journal": "docs/journal"
  }
}
```

- `version` — schema version for future migration
- `capabilities` — which optional modules are active at runtime
- `paths` — artifact locations relative to project root

Not included: absolute paths (break on repo move), auth tokens, connector config.

### 4. Fix `compose start` target binding

This is the critical fix. Today:

```js
// bin/compose.js:86
spawn('node', [join(PACKAGE_ROOT, 'server', 'supervisor.js')], {
  cwd: PACKAGE_ROOT,  // <-- supervisor cwd = Compose's own repo
})
```

`project-root.js` resolves `TARGET_ROOT` from `process.cwd()` which is `PACKAGE_ROOT`.

**Fix:** `compose start` resolves the project root *before* spawning the supervisor, using the same marker-walk logic as `project-root.js`. It then passes the resolved root as `COMPOSE_TARGET`:

```js
// Resolve project root: COMPOSE_TARGET env > walk up from cwd for .compose/ > fail
const targetRoot = process.env.COMPOSE_TARGET
  ? path.resolve(process.env.COMPOSE_TARGET)
  : findProjectRoot(process.cwd());  // same function as project-root.js

if (!targetRoot || !existsSync(join(targetRoot, '.compose', 'compose.json'))) {
  console.error('[compose] No .compose/ found (searched from cwd upward).');
  console.error('[compose] Run \'compose init\' first, or set COMPOSE_TARGET.');
  process.exit(1);
}

spawn('node', [join(PACKAGE_ROOT, 'server', 'supervisor.js')], {
  cwd: PACKAGE_ROOT,
  env: { ...process.env, COMPOSE_TARGET: targetRoot },
})
```

Key behaviors:
- From `repo/apps/web`, walks up and finds `repo/.compose/` — sets `COMPOSE_TARGET=repo`, not `repo/apps/web`
- If `COMPOSE_TARGET` is already set (explicit override), uses it directly without walking
- Supervisor still runs from `PACKAGE_ROOT` (needs Compose's `node_modules/`, Vite binary)
- `project-root.js` sees `COMPOSE_TARGET` and skips its own marker walk — no double resolution

The `findProjectRoot()` function is extracted to a shared location importable by both `bin/compose.js` and `server/project-root.js` to avoid duplicating the walk logic.

### 5. `project-root.js` reads manifest and exports config

After resolving `TARGET_ROOT`:

```js
export function loadProjectConfig() {
  const configPath = path.join(TARGET_ROOT, '.compose', 'compose.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return DEFAULT_CONFIG;
  }
}
```

`DEFAULT_CONFIG` matches current hardcoded values so existing Compose-on-itself behavior is preserved.

Export a `resolveProjectPath(key)` helper:

```js
export function resolveProjectPath(key) {
  const config = loadProjectConfig();
  const rel = config.paths?.[key];
  if (!rel) return null;
  return path.join(TARGET_ROOT, rel);
}
```

### 6. Full stratum soft-fail

Three layers to fix, not just one:

**Layer 1: `server/index.js`** — Remove `process.exit(1)`. Replace with warning + capability check:

```js
const config = loadProjectConfig();
if (!config.capabilities.stratum) {
  console.warn('[compose] Stratum disabled — pipeline features unavailable');
}
```

**Layer 2: `server/vision-server.js`** — Guard stratum initialization:

```js
const config = loadProjectConfig();
if (config.capabilities.stratum) {
  app.use('/api/stratum', createStratumRouter());
  this._stratumSync = new StratumSync(this.store, () => this.scheduleBroadcast());
  attachStratumRoutes(app, { ... });
  this._stratumSync.start();
} else {
  // Mount stub routes that return 503
  app.use('/api/stratum', (_req, res) => {
    res.status(503).json({ error: 'Stratum not enabled', hint: 'pip install stratum && compose init' });
  });
}
```

No StratumSync created, no polling started, no noisy errors. Routes return a clear 503 with install instructions.

**Layer 3: `server/stratum-client.js`** — No changes needed. It's only called via StratumSync and stratum-api.js routes, both of which are guarded above.

### 7. Config-driven paths — complete list

Every hardcoded artifact path, with the config key that replaces it:

| File | Current hardcoded | Config key | Line(s) |
|---|---|---|---|
| `file-watcher.js` | `path.join(PROJECT_ROOT, 'docs')` | `paths.docs` | 164 |
| `file-watcher.js` | `path.join(PROJECT_ROOT, '.specify')` | detected, skip if absent | 175 |
| `vision-routes.js` | `path.join(projectRoot, 'docs', 'features')` | `paths.features` | 122 |
| `vision-routes.js` | `path.join(projectRoot, 'docs', 'features')` | `paths.features` | 262 |
| `session-manager.js` | `featureRoot` constructor param | `paths.features` | 37 |
| `index.js` | `path.join(TARGET_ROOT, 'docs', 'features')` | `paths.features` | 65 |
| `vision-utils.js` | `path.join(projectRoot, 'docs', 'journal')` | `paths.journal` | 88 |
| `vision-utils.js` | `docs/journal/...` in spawned prompt string | `paths.journal` | 95, 97, 104 |
| `compose-mcp-tools.js` | `path.join(PROJECT_ROOT, 'docs', 'features')` | `paths.features` | 312, 318 |

Each reads from `resolveProjectPath()` instead. File watcher's `listMarkdownFiles` endpoint (`/api/files`) also changes to use `paths.docs`.

### 8. What stays the same

Already safe, no changes needed:

- **VisionStore** — ENOENT = fresh start, creates dir on first save
- **SettingsStore** — ENOENT = defaults, creates dir on first save
- **File watcher** — warns and skips if dirs absent (existing behavior)
- **Speckit scan** — returns `[]` if `.specify/` absent
- **compose-mcp-tools** — returns empty data on missing files

## Scope

### In scope

- `compose init` command (project-local only)
- `compose setup` command (user-global only)
- `compose install` as alias for init + setup (backwards compat)
- `.compose/compose.json` project manifest with `loadProjectConfig()` + `resolveProjectPath()`
- Fix `compose start` to pass `COMPOSE_TARGET=cwd` to supervisor
- Full stratum soft-fail across `index.js`, `vision-server.js` (3 layers)
- Config-driven paths in all 8 locations listed above
- E2E tests: blank dir init, existing repo init, start-targets-project, idempotent re-init, stratum-disabled startup
- Update `install.test.js` to cover init/setup/install aliases

### Out of scope

- Migration/upgrade logic (v1 is first version)
- UI changes for capability toggles
- Changing the Compose skill definition
- Config file editor/UI

## File manifest

| Action | File | What changes |
|---|---|---|
| modify | `bin/compose.js` | Split into init/setup/install, pass COMPOSE_TARGET on start |
| modify | `server/project-root.js` | Add `loadProjectConfig()`, `resolveProjectPath()` |
| modify | `server/index.js` | Stratum soft-fail, config-driven featureRoot |
| modify | `server/vision-server.js` | Guard stratum routes/sync behind capability |
| modify | `server/vision-routes.js` | Config-driven features path (2 locations) |
| modify | `server/file-watcher.js` | Config-driven docs path |
| — | `server/session-manager.js` | No change needed — already accepts `featureRoot` as constructor param; `index.js` passes config-driven value |
| modify | `server/vision-utils.js` | Config-driven journal path |
| modify | `server/compose-mcp-tools.js` | Config-driven features path |
| create | `test/init.test.js` | E2E bootstrap tests |
| modify | `test/install.test.js` | Add init alias coverage |
