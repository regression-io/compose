# Discovery: `.compose/` Project Roots, Sub-Projects, and Inheritance

**Date:** 2026-03-13
**Status:** Open
**Triggered by:** STRAT-PAR batch build exposed cross-repo cwd issues — agents ran in `compose/` but needed to modify `stratum/` (sibling repo).

---

## The Problem

Compose currently assumes a single project root: wherever `.compose/compose.json` lives. Everything is relative to that root:
- `pipelines/build.stratum.yaml`
- `docs/features/{code}/`
- `.compose/data/` (state, streams, locks)
- Agent working directory

This breaks when a feature spans multiple repos or needs agents to operate in a different directory than where `.compose/` lives. The STRAT-PAR build created files under `compose/stratum-mcp/tests/` instead of `stratum/stratum-mcp/tests/` because the agent's cwd was `compose/`.

**Immediate fix (shipped):** `--cwd` flag on `compose build` that sets the agent working directory independently of the project root. For STRAT-PAR: `compose build STRAT-PAR --cwd /Users/ruze/reg/my/forge`.

## Questions

### 1. What is a "project root" in Compose?

Today: the directory containing `.compose/compose.json`. Discovered by walking up from cwd.

Options:
- **A) Keep it simple:** Project root = `.compose/` location. Cross-repo features use `--cwd` to set agent working directory. No hierarchy.
- **B) Workspace model:** A parent directory can have `.compose/workspace.json` that declares child projects. Similar to pnpm workspaces or Cargo workspaces. The workspace owns shared state; child projects inherit config.
- **C) Git-root convention:** `.compose/` always lives at the git root. Monorepo = one `.compose/`. Multi-repo = one `.compose/` per repo, plus an optional workspace `.compose/` at the parent.

### 2. What lives in `.compose/`?

Current contents:
```
.compose/
  compose.json        # project config (version, capabilities)
  data/
    active-build.json # current build state (per-feature in future)
    build-stream.jsonl # event stream (per-feature in future)
    items.json        # vision surface items
    gates.json        # gate state
  breadcrumbs.log     # intent tracking
```

Should `.compose/` also contain:
- **Feature-level config** (per-feature cwd, skip list, agent overrides)?
- **Build artifacts index** (what was built, when, by which agent)?
- **Cache** (agent conversation history, intermediate results)?

### 3. Sub-projects and inheritance

Scenario: `forge/` is a workspace containing `compose/`, `stratum/`, and `compose-ui/`. Each has its own test suite and conventions, but features can span multiple sub-projects.

Questions:
- Does each sub-project get its own `.compose/`?
- If so, does the workspace `.compose/` override or merge with sub-project configs?
- How does the pipeline know which sub-project's tests to run for coverage?

### 4. Per-feature configuration

Some features need different settings:
- **cwd**: STRAT-PAR needs `forge/` as working directory
- **test command**: COMP-UI features run `npm test` in `compose-ui/`, not `compose/`
- **agent model**: Some features might prefer opus over sonnet
- **skip list**: Some pipeline steps are irrelevant for doc-only features

Where does this config live?
- **A) In ROADMAP.md:** Extra columns or metadata in the table (gets cluttered)
- **B) In the feature folder:** `docs/features/STRAT-PAR/compose.json` with overrides
- **C) In `.compose/features.json`:** Centralized feature config map
- **D) In the pipeline spec:** `build.stratum.yaml` per-step overrides keyed by feature prefix

### 5. Composability across repos

The `compose build` command currently reads ROADMAP.md, pipelines, and feature docs from the same root. For multi-repo features:

- Should the pipeline spec support `cwd` per step? (e.g., "run tests in `stratum/`")
- Should feature docs live in the workspace root rather than any single repo?
- Should there be a shared `forge/.compose/` that coordinates cross-repo builds?

## Design Principles (Proposed)

1. **Convention over configuration.** `.compose/` at the git root. No config for the common case.
2. **Explicit override for the uncommon case.** `--cwd`, per-feature config, per-step cwd — all opt-in.
3. **Infrastructure stays local.** `.compose/data/` is always relative to the `.compose/` that owns the build. No cross-project state sharing.
4. **Agent cwd is a separate concern.** Where agents operate and where Compose stores state are independent. The `--cwd` fix makes this explicit.
5. **Feature config lives with the feature.** `docs/features/{code}/compose.json` for per-feature overrides. Compose merges it with the project-level config.

## Proposal Sketch

### Minimal (ship now)

Already done:
- `--cwd` flag on CLI
- `workingDirectory` option in `runBuild` / `runBuildAll`

### Next (feature-level config)

Add optional `docs/features/{code}/compose.json`:
```json
{
  "workingDirectory": "../..",
  "testCommand": "cd stratum && python -m pytest",
  "skipSteps": ["prd", "architecture"]
}
```

`build.js` reads this before starting and merges with global config.

### Later (workspace model)

Add `forge/.compose/workspace.json`:
```json
{
  "projects": ["compose", "stratum", "compose-ui"],
  "sharedFeatures": "docs/features/",
  "roadmap": "compose/ROADMAP.md"
}
```

`compose build` from any child project discovers the workspace root and resolves paths accordingly.

## Open Threads

- [ ] Decide: option A, B, or C for project root model
- [ ] Decide: where per-feature config lives (B or C from question 4)
- [ ] Design: coverage agent needs to know which tests to run per feature — test command in feature config?
- [ ] Design: `active-build.json` per-feature (concurrent builds) vs. single file with feature tagging
- [ ] Design: `build-stream.jsonl` per-feature vs. tagged events
- [ ] Prototype: workspace discovery (walk up from cwd looking for `.compose/workspace.json`)
