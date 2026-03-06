# INIT-1 Implementation Report

**Feature:** Compose Project Bootstrap
**Date:** 2026-03-06
**Status:** Complete

## Summary

Made Compose portable across projects by introducing project binding (`compose init`), a project manifest (`.compose/compose.json`), graceful stratum degradation, and config-driven paths throughout the server.

## Delivered vs Planned

| Plan Task | Status | Notes |
|---|---|---|
| 1. Extract `find-root.js` + config API | ✅ | Side-effect-free module, loadProjectConfig/resolveProjectPath |
| 2. Rewrite `bin/compose.js` | ✅ | init/setup/install/start commands |
| 3. Stratum soft-fail in `index.js` | ✅ | Capability downgrade + warning |
| 4. VisionServer conditional stratum | ✅ | Stub 503 routes when disabled |
| 5. Config paths in `vision-routes.js` | ✅ | resolveProjectPath('features') |
| 6. Config paths in `file-watcher.js` | ✅ | loadProjectConfig().paths.docs |
| 7. Config paths in `vision-utils.js` | ✅ | Config-driven journal path |
| 8. Config paths in `compose-mcp-tools.js` | ✅ | resolveProjectPath('features') |
| 9. Tests | ✅ | 34 new tests across 4 files |

## Architecture Deviations

1. **vision-routes.js test compatibility branch** — Blueprint called for unconditional `resolveProjectPath('features')`. Tests that pass custom `projectRoot` required keeping the branch, but the fallback now reads from config instead of hardcoding `docs/features`.

2. **No `compose setup` stratum registration test** — The `stratum-mcp install` subprocess interaction is hard to test in isolation without the real binary. Covered by the existing install.test.js.

## Key Implementation Decisions

- **JSON.parse(JSON.stringify) for clone discipline** — chosen over structuredClone for Node 16 compat and simplicity.
- **Object.freeze on DEFAULT_CONFIG** — catches accidental mutation at dev time.
- **Cache sentinel on miss** — `_configCache = DEFAULT_CONFIG` when file missing/corrupt, preventing repeated fs reads per request. (Found during review loop.)
- **Capability merge order** — existing config spread first, then fresh detection overwrites, then explicit flags. (Fixed during review loop.)

## Test Coverage

| Test File | Tests | What It Covers |
|---|---|---|
| `test/project-config.test.js` | 11 | findProjectRoot, loadProjectConfig, resolveProjectPath |
| `test/init.test.js` | 16 | compose init/setup/install/start, flags, idempotency |
| `test/stratum-softfail.test.js` | 3 | Stratum capability downgrade, stub 503 route |
| `test/config-paths.test.js` | 4 | Custom docs/features/journal paths |
| `test/install.test.js` | 7 | Existing tests (backwards compat) |
| **Total new** | **34** | |
| **Full suite** | **409** | All passing |

## Files Changed

### New Files
- `server/find-root.js` — Side-effect-free findProjectRoot + MARKERS
- `test/project-config.test.js` — Config API tests
- `test/init.test.js` — CLI command tests
- `test/stratum-softfail.test.js` — Stratum degradation tests
- `test/config-paths.test.js` — Config-driven path integration tests

### Modified Files
- `server/project-root.js` — Added loadProjectConfig, resolveProjectPath, DEFAULT_CONFIG
- `bin/compose.js` — Rewritten: init/setup/install/start commands
- `server/index.js` — Stratum soft-fail, config-driven paths
- `server/vision-server.js` — Conditional stratum setup
- `server/vision-routes.js` — resolveProjectPath for features
- `server/file-watcher.js` — Config-driven docs path
- `server/vision-utils.js` — Config-driven journal path
- `server/compose-mcp-tools.js` — resolveProjectPath for features

## Known Issues & Tech Debt

1. **Config cache is process-lifetime** — `loadProjectConfig()` caches on first read and never invalidates. If a user edits `compose.json` while the server is running, they must restart. This is acceptable for v1.
2. **`compose start` timeout in tests** — The parent traversal + start tests rely on 3s timeouts because supervisor.js tries to actually start. A `--dry-run` flag would improve test speed.

## Lessons Learned

1. **Side-effect-free modules are essential for testability** — Extracting `find-root.js` from `project-root.js` (which has IIFE side effects) was the key enabler for CLI testing without triggering server init.
2. **Clone-on-return prevents a class of bugs** — The `_configCache` shared reference would silently corrupt config if any caller mutated the returned object. JSON round-trip is cheap enough for config objects.
3. **Review loop caught 2 production bugs** — The cache miss regression and capability merge order were both invisible to the test suite but would have caused real issues: silent performance degradation and broken re-init flows.
