# Team Presets

Team presets are curated multi-agent pipeline templates that ship with Compose. They let you run specialized agent teams without writing pipeline YAML from scratch.

## Usage

```bash
compose build <feature-code> --team <name>
```

Available teams: `review`, `research`, `feature`.

## Teams

### review

Runs 3 read-only reviewers in parallel (security, performance, architecture), then merges and deduplicates findings. Aborts if any critical-severity finding is detected.

```bash
compose build FEAT-1 --team review
```

**When to use:** After implementation, before merge. Catches issues a single-pass review would miss.

**Agents:** All use `read-only-reviewer` profile (Read/Grep/Glob only, no file modifications).

### research

Runs 3 explorers in parallel (codebase, web search, local docs), then synthesizes findings into actionable recommendations.

```bash
compose build FEAT-1 --team research
```

**When to use:** Cold-start discovery, unfamiliar feature areas, evaluating approaches before implementation.

**Agents:** Codebase and docs explorers use `read-only-reviewer`. Web explorer uses `read-only-researcher` (adds WebSearch/WebFetch).

### feature

Decomposes a feature into parallel tasks with file ownership, implements them in isolated worktrees, merges results, and verifies tests pass.

```bash
compose build FEAT-1 --team feature
```

**When to use:** Multi-file feature implementation where tasks can be parallelized.

**Agents:** Orchestrator decomposes, implementers use `claude:implementer` (full access within their `files_owned`).

## Customization

To customize a preset, copy it to your project's `pipelines/` directory:

```bash
cp presets/team-review.stratum.yaml pipelines/team-review.stratum.yaml
# Edit pipelines/team-review.stratum.yaml to your needs
```

Project-local templates in `pipelines/` take precedence over bundled presets.

## Inspecting Presets

View the raw YAML to understand what a team does:

```bash
cat presets/team-review.stratum.yaml
```

Each preset starts with a comment block describing its purpose, pattern, and capabilities.

## Limitations

- `--team` only works with single features (not `--all` or multiple feature codes)
- `--team` and `--template` cannot be used together
- File ownership in `team-feature` is validated at plan time (`no_file_conflicts`), not enforced at runtime
- No custom merge strategies in v1 — deduplication is agent-driven
- No team-lead agent pattern — the `decompose` step serves this role
