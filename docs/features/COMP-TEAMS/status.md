# COMP-TEAMS — Resume Point

**Last session:** 2026-04-12
**Phase completed:** Phase 1 (Design)
**Next phase:** Phase 4 (Blueprint) — Phases 2 and 3 skipped per design

## Quick context (read this first if resuming cold)

COMP-TEAMS is a Wave 5 feature for the compose project. It ships 3 curated multi-agent team templates as `.stratum.yaml` files plus a thin `--team` CLI alias. Scoped down from the original L-effort roadmap entry to S after research showed that the infrastructure (STRAT-PAR, COMP-AGENT-CAPS) already handles everything except curation.

**Version chosen:** A (Thin) — no new primitives, no new code beyond ~10 lines CLI alias, ~1.5 days total effort.

## What's in v1

Three team preset templates:

1. **`team-review`** — 3 parallel read-only reviewers (security, perf, architecture) → merge findings → optional gate
2. **`team-research`** — 3 parallel explorers (codebase, web, docs) → synthesize into structured findings
3. **`team-feature`** — decompose → parallel implement with `files_owned` → `merge: sequential_apply`

Users invoke via `compose build <feature> --team review` (thin alias for `--template team-review`).

## What's deferred (already on forge ROADMAP.md)

- **COMP-TEAMS-DEBUG** — 3 competing hypotheses, gate semantics need design
- **COMP-TEAMS-FULLSTACK** — 4 layered agents, dependency design needed
- **STRAT-TEAMS-IR** — `team:` top-level IR section (future abstraction)
- **Team-lead capability profile** — `decompose` + `orchestrator` already cover this
- **Hard file-ownership enforcement** — separate ticket, v1 informational logging is enough

## Resume instructions

1. **Read `design.md` first** — all decisions and rationale live there
2. **Start at Phase 4 (Blueprint)** — skip Phase 2 (PRD) and Phase 3 (Architecture) per design doc
3. **For Phase 4, launch a `compose-explorer` targeting:**
   - `compose/pipelines/build.stratum.yaml:148` (existing `review_lenses` parallel_dispatch step — template for team-review)
   - `compose/pipelines/build.stratum.yaml:353` (existing `execute` decompose+parallel_dispatch step — template for team-feature)
   - Any existing `research.stratum.yaml` template in the pipelines dir (template for team-research)
   - `compose/server/agent-templates.js` to confirm `read-only-reviewer` profile details
4. **Blueprint deliverable:** draft YAML for each of the 3 templates with inline `# FILE:LINE` references to existing patterns they mirror, plus a corrections table of any spec-vs-reality mismatches found during exploration

## Open design questions (surfaced in design, not yet resolved)

- **Team-research web capability:** The `web` explorer needs WebSearch/WebFetch tools. Current `read-only-reviewer` profile excludes them. Options:
  1. Add web tools to `read-only-reviewer` (affects other uses — risky)
  2. Add new `read-only-researcher` profile in `server/agent-templates.js` (recommended in design)
  3. Use raw `claude` with no profile restrictions (simplest but least safe)

  **Design recommends option 2.** Phase 4 blueprint should scope that profile addition.

- **`--team` + `--template` collision:** If user passes both flags, what wins? Design doesn't commit yet. Recommend: reject with error message, keep CLI semantics clean.

- **Gate on "any critical findings"** for team-review:** Design mentions it as optional. Phase 4 should decide whether v1 ships with this gate or leaves it to user customization.

## Dependencies (already satisfied, verify they're still on main)

- STRAT-PAR (IR v0.3 parallel execution) — shipped, on stratum main
- COMP-AGENT-CAPS (capability profiles with `read-only-reviewer`, `implementer`, `orchestrator`, `security-auditor`) — shipped, in compose main
- `--template` CLI flag — existing at `compose/bin/compose.js:978` and `compose/lib/build.js:398`

## Files that will be touched in Phase 4+ (preview)

**Create:**
- `compose/pipelines/team-review.stratum.yaml`
- `compose/pipelines/team-research.stratum.yaml`
- `compose/pipelines/team-feature.stratum.yaml`
- `compose/docs/team-presets.md`
- `compose/tests/integration/test_teams.js` (or equivalent — check existing test patterns)

**Modify:**
- `compose/bin/compose.js` — add `--team` alias (~10 lines)
- `compose/server/agent-templates.js` — add `read-only-researcher` profile (if option 2 confirmed)
- `compose/ROADMAP.md` (after ship) — mark COMP-TEAMS complete
- `compose/CHANGELOG.md` (after ship) — entry for COMP-TEAMS

## Rough phase budget (from design doc)

| Phase | Effort |
|---|---|
| Phase 4 (Blueprint) | 2-3h |
| Phase 5 (Verify) | 1h |
| Phase 6 (Plan) | 1-2h |
| Phase 7 (Execute) | ~1 day (TDD each template, E2E run, review loop, coverage) |
| Phase 8-10 (Report, Docs, Ship) | 2-3h |

**Total remaining:** ~1.5 days focused work.

## Session flow on resume

```
1. Read design.md + this file
2. Delete this file (status.md) per compose skill convention
3. Dispatch compose-explorer for Phase 4 blueprint research
4. Draft blueprint.md
5. Verify blueprint (Phase 5)
6. Phase 1 gate → Phase 4 gate → Phase 5 gate → Phase 6 gate → Phase 7 execution
7. Ship COMP-TEAMS, update forge ROADMAP.md with COMPLETE
```

## Commit(s) from this session

- Design doc + status.md (this commit) — Phase 1 complete, `--through design` stopping point
- Forge ROADMAP.md updated separately with: COMP-TEAMS scoped to v1, COMP-TEAMS-DEBUG added, COMP-TEAMS-FULLSTACK added, STRAT-TEAMS-IR added
