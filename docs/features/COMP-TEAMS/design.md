# COMP-TEAMS: Team Pipeline Presets — Design

**Status:** APPROVED (Phase 1 — Design)
**Version:** A (Thin)
**Date:** 2026-04-12
**Feature code:** COMP-TEAMS
**Wave:** 5 (last gate before D4 multi-agent dogfooding)

## Related Documents

- Forge roadmap entry: `ROADMAP.md` → Wave 5 → COMP-TEAMS
- Dependency: STRAT-PAR (IR v0.3 parallel execution — COMPLETE, commit range on main)
- Dependency: COMP-AGENT-CAPS (capability profiles — COMPLETE, `server/agent-templates.js`)
- Deferred siblings: COMP-TEAMS-DEBUG, COMP-TEAMS-FULLSTACK, STRAT-TEAMS-IR (all on roadmap as separate items)

## Problem

Users can already build multi-agent pipelines. `parallel_dispatch`, capability profiles, file ownership, and merge strategies have all been available since STRAT-PAR and COMP-AGENT-CAPS shipped. The infrastructure is production-ready.

**The missing piece is curation.** No pre-baked team compositions exist. Every user writing a multi-agent pipeline has to:
1. Write the `.stratum.yaml` from scratch
2. Choose `parallel_dispatch` vs `decompose` vs plain sequential steps
3. Assign capability profiles to each agent
4. Wire `isolation`, `merge`, `require` semantics correctly
5. Figure out how results fan back in

Most users won't do this. They'll give up and run a single-agent pipeline, missing the leverage of parallel specialized agents.

COMP-TEAMS closes this gap by shipping a **small library of curated team templates** that demonstrate the common patterns. Users invoke them with `compose build --team <name>` and get a working multi-agent pipeline immediately. The templates are also reference material — users can copy one, modify it, and learn by example.

## Decision: Version A (Thin)

**No new primitives. Minimal new code: a thin CLI alias, a two-level template loader, and one new capability profile (`read-only-researcher`). Ship 3 curated templates + docs.**

The original roadmap listed 4 sub-items (templates + ownership enforcement + team-lead agent + CLI flag) as L effort. After exploring the codebase, 3 of those 4 sub-items turn out to be **already shipped** via STRAT-PAR and COMP-AGENT-CAPS. The only remaining work is curation and a thin CLI alias. Effort drops from L to S.

Rejected alternatives:
- **Version B (Thick)** — build team-lead capability profile, hard file ownership enforcement, dedicated `--team` flag with team-specific metadata and validation. This was the original roadmap intent, but it duplicates existing primitives. The `decompose` step already acts as a team lead; capability profiles already restrict tools; file ownership is declared via `files_owned` in the task graph and merge conflicts are prevented by `merge: sequential_apply`. Note: `no_file_conflicts` validates the *planned* task graph, not runtime behavior — an agent can still write outside its `files_owned`. Runtime enforcement is tracked separately as COMP-CAPS-ENFORCE (roadmap). For v1, the informational logging in COMP-AGENT-CAPS is sufficient.
- **STRAT-TEAMS-IR** — new top-level `team:` section in IR schema with structural team composition. Parked as a future roadmap item pending 2+ real use cases. Don't extend the IR before you have evidence.

## What ships in v1

### Three pipeline templates

Filename convention: `compose/presets/team-<name>.stratum.yaml` (bundled defaults, `team-` prefix). Users can override by placing a same-named file in their project's `pipelines/` directory.

| Team | File | Pattern | When to use |
|---|---|---|---|
| **review** | `pipelines/team-review.stratum.yaml` | 3 read-only reviewers in parallel (security, perf, architecture) → merge findings → surface as gate | After implementation, before merge |
| **research** | `pipelines/team-research.stratum.yaml` | 3 parallel explorers (codebase, web search, docs) → synthesize into structured findings | Cold-start discovery, unfamiliar feature areas |
| **feature** | `pipelines/team-feature.stratum.yaml` | Decompose → parallel implement with `files_owned` → `merge: sequential_apply` | Standard multi-file feature implementation |

Each template is a self-contained `.stratum.yaml` that demonstrates one execution pattern. No shared sub-flows between them in v1 (keeps each template easy to understand in isolation). If patterns emerge as shared across templates, we extract them in v1.1.

### `--team <name>` CLI alias

Add a thin flag to `bin/compose.js`. Implementation sketch:

```javascript
// In compose build command
const teamIdx = filteredArgs.indexOf('--team')
if (teamIdx !== -1) {
  const teamName = filteredArgs[teamIdx + 1]
  if (!teamName || teamName.startsWith('-')) {
    console.error('error: --team requires a team name (review, research, feature)')
    process.exit(1)
  }
  // Rewrite to --template team-<name>
  filteredArgs.splice(teamIdx, 2, '--template', `team-${teamName}`)
}
```

That's ~10 lines. It rewrites `--team review` into `--template team-review` before the existing template resolver runs. If the user passes both `--team` and `--template`, reject with an error.

**Template resolution: two-level fallback loader.** The template loader in `lib/build.js` currently only checks the project's `pipelines/` directory. Extend it to check two locations in order:

1. **Project-local** — `<project>/pipelines/team-<name>.stratum.yaml` (user overrides)
2. **Bundled** — `<compose-package>/presets/team-<name>.stratum.yaml` (shipped defaults)

This means `--team review` works out of the box without `compose init` copying team files into every project. Users who want to customize a preset copy it to their `pipelines/` dir, where it takes precedence. The loader change is ~15 lines in `lib/build.js` (add a `resolveTemplate(name)` function that checks project first, falls back to bundled).

**Named presets only:** `--team` accepts only preset names (`review`, `research`, `feature`), not file paths. For custom pipeline files, use `--template path/to/file.stratum.yaml` directly. This avoids ambiguity between preset names and paths.

**Batch builds:** `--team` is rejected when multiple features are specified (`compose build FEAT-1 FEAT-2 --team review`). `runBuildAll()` does not forward the `template` option, so team selection would be silently dropped. Explicit rejection with a clear error message is better than silent ignore. If batch + team is needed later, `runBuildAll()` can be extended to forward it.

**Validation:** After resolution, if neither project nor bundled location has the template, error with a message listing available teams (scan both dirs for `team-*.stratum.yaml` files).

### Documentation

Two surfaces:

1. **`docs/team-presets.md`** — single page covering:
   - What a team preset is
   - The 3 teams in v1 with usage examples
   - How to inspect a team template (`cat presets/team-review.stratum.yaml`)
   - How to write your own team template (copy + modify recipe)
   - Known limits (no custom merge strategies, no team-lead agent yet)
   - Forward-look: reference STRAT-TEAMS-IR and the deferred teams

2. **Per-template frontmatter comment** — each `team-*.stratum.yaml` starts with a structured comment block:
   ```yaml
   # TEAM PRESET: review
   #
   # Purpose:     Parallel multi-lens review after implementation
   # Pattern:     3 read-only reviewers → merge findings → gate
   # Capability:  Agents use read-only-reviewer profile (Read/Grep/Glob/Agent only)
   # Isolation:   none (reviewers read shared state, don't modify)
   # Merge:       Manual deduplication step
   #
   # Use with:    compose build <feature-code> --team review
   # Customize:   Copy this file to team-<mytype>.stratum.yaml and edit.
   ```
   Inline docs for users who go to inspect the template directly.

## Out of scope (v1)

- **`debug` team** → roadmap item **COMP-TEAMS-DEBUG**. Blocked on gate design for "first verified hypothesis wins."
- **`fullstack` team** → roadmap item **COMP-TEAMS-FULLSTACK**. Blocked on layered dependency design (frontend needs backend contract, etc.).
- **Team-lead capability profile** — `decompose` step already covers this pattern via `agent: "claude:orchestrator"`.
- **Hard file ownership enforcement** — current v1 informational logging in COMP-AGENT-CAPS is sufficient for the 3 v1 teams. Upgrade to blocking is a separate ticket.
- **`team:` top-level IR section** → roadmap item **STRAT-TEAMS-IR**. Don't extend the IR before 2+ real use cases.
- **Team discovery / `compose team list` command** — user can `ls presets/team-*.stratum.yaml`. Not worth a dedicated CLI subcommand in v1.
- **Team-specific metadata** (e.g., "this team requires worktree support") — cross that bridge if a team actually needs it.

## Components (v1)

| # | Component | File | Effort |
|---|---|---|---|
| 1 | `team-review.stratum.yaml` | `compose/presets/team-review.stratum.yaml` (new) | 2-3h — mirror STRAT-REV patterns |
| 2 | `team-research.stratum.yaml` | `compose/presets/team-research.stratum.yaml` (new) | 2-3h — similar to review but different intents |
| 3 | `team-feature.stratum.yaml` | `compose/presets/team-feature.stratum.yaml` (new) | 3-4h — most complex, uses decompose + parallel_dispatch + sequential_apply |
| 4 | Two-level template loader | `compose/lib/build.js` (modify) | 1h — `resolveTemplate()` checks project then bundled |
| 5 | `--team` CLI alias + batch rejection | `compose/bin/compose.js` (modify) | 1h — ~15 lines + validation + tests |
| 6 | `read-only-researcher` profile | `compose/server/agent-templates.js` (modify) | 0.5h — clone read-only-reviewer + add WebSearch/WebFetch |
| 7 | Team presets documentation | `docs/team-presets.md` (new) | 2h |
| 8 | Golden E2E test | `compose/tests/` (new) | 2h — run each team against a trivial sample feature |

**Total v1 effort: ~2 days for one person.**

## Key technical decisions

### Team-review details

Mirror the existing `parallel_review` sub-flow from `pipelines/build.stratum.yaml`. Three lenses:
- **security** — `claude:read-only-reviewer` with intent focused on auth, input validation, secrets, injection
- **performance** — `claude:read-only-reviewer` with intent focused on hot paths, algorithmic complexity, query patterns
- **architecture** — `claude:read-only-reviewer` with intent focused on coupling, layering, reusability, error handling

`parallel_dispatch` with `isolation: none` (read-only, safe to share state). `merge` step deduplicates findings by file+line. Output is a `ReviewResult` with severity-tagged findings.

**Gate behavior:** The merge step produces a `has_critical: bool` output field. A subsequent `ensure` expression checks `result.has_critical == False`. If critical findings exist, the step fails its postcondition. Since team-review is a standalone read-only pipeline (no fix step embedded), the ensure failure surfaces the findings and **aborts** — there is no automatic fix-and-retry loop. The user reads the findings, fixes manually, and re-runs `--team review`. This is intentional: the main `build.stratum.yaml` embeds a fix loop around reviews, but the standalone review preset is a diagnostic tool, not a self-healing pipeline.

### Team-research details

Three explorers:
- **codebase** — `claude:read-only-reviewer` exploring the local codebase via Read/Grep/Glob
- **web** — `claude:read-only-researcher` with WebSearch/WebFetch access for external research
- **docs** — `claude:read-only-reviewer` reading local docs, READMEs, and any linked specs

Each produces structured findings (sources, quotes, patterns, open questions). Final synthesis step runs sequentially after parallel dispatch, consolidating into a single `ResearchResult` document.

**Decided:** New `read-only-researcher` capability profile — clones `read-only-reviewer` and adds WebSearch/WebFetch to allowedTools. Scoped, minimal surface. The web agent uses `claude:read-only-researcher`; the other two explorers stay on `claude:read-only-reviewer`.

### Team-feature details

Most complex. Four-step pattern:
1. `decompose` step with `agent: "claude:orchestrator"` produces a TaskGraph with `files_owned` per task
2. `parallel_dispatch` step with `isolation: worktree`, `merge: sequential_apply` runs each task in its own worktree
3. Each task uses `agent: "claude:implementer"` (profiled — implements code within capability bounds)
4. After all tasks complete, a `verify` step runs tests across the merged codebase

**File ownership enforcement:** rely on existing `no_file_conflicts` ensure (validates planned task graph) + `sequential_apply` merge (prevents merge conflicts). Runtime enforcement that agents stay within `files_owned` is out of scope — tracked as COMP-CAPS-ENFORCE.

**Max concurrent:** 3 (matches existing `execute` step in `build.stratum.yaml`). Tunable per-project via top-level field if needed later.

## Implementation plan outline (for Phase 6)

Preview of what the implementation plan would cover (not committed to yet):

1. Add two-level template loader (`resolveTemplate()`) to `lib/build.js`
2. Write `presets/team-review.stratum.yaml` — use `pipelines/build.stratum.yaml:148` (review_lenses step) as reference
3. Write `presets/team-research.stratum.yaml` — add `read-only-researcher` capability profile in `server/agent-templates.js`
4. Write `presets/team-feature.stratum.yaml` — use `pipelines/build.stratum.yaml:353` (execute step) as reference
5. Add `--team` alias + batch rejection in `bin/compose.js` (~15 lines + unit test)
6. Write `docs/team-presets.md`
7. Golden E2E test — `compose build <trivial-feature> --team review` on a fixture repo
8. Update `compose/ROADMAP.md` to mark COMP-TEAMS complete after merge

## Phase plan

Given Version A scope:

| Phase | Status | Notes |
|---|---|---|
| Phase 1: Design | **COMPLETE** (this doc) | |
| Phase 2: PRD | SKIP | Internal feature, no user-facing requirements beyond this design |
| Phase 3: Architecture | SKIP | No new components, all primitives already exist |
| Phase 4: Blueprint | REQUIRED | Draft YAML for each template with file:line references to existing pipelines |
| Phase 5: Blueprint verification | REQUIRED | Spot-check blueprint against real files |
| Phase 6: Plan | REQUIRED | Break into ordered tasks |
| Phase 7: Execute | Multi-day | TDD per template, E2E golden flow, review loop, coverage sweep |
| Phase 8: Report | OPTIONAL | Small feature, may skip |
| Phase 9: Docs | REQUIRED | `docs/team-presets.md`, CHANGELOG, ROADMAP update |
| Phase 10: Ship | REQUIRED | Merge, audit, bind vision item |

## Gate criteria for Phase 1 approval

- [x] Problem statement clear — no existing curated team templates
- [x] Version scoped (A: Thin) with explicit rationale
- [x] Scope of v1 pinned: 3 teams (review, research, feature)
- [x] Deferred work identified with roadmap items (COMP-TEAMS-DEBUG, COMP-TEAMS-FULLSTACK, STRAT-TEAMS-IR)
- [x] Directory layout decided: bundled in `compose/presets/`, user overrides in project `pipelines/`
- [x] CLI surface decided: `--team <name>` with two-level fallback loader, batch builds rejected
- [x] Per-template design shape documented
- [x] Capability profile decided: new `read-only-researcher` profile for team-research web agent
- [x] Effort re-estimated from L → S based on research findings
- [x] Phase plan defined (Phase 2/3 skipped, Phase 4-7 required)
