# COMP-BENCH: Model Benchmark Suite

**Feature:** Benchmark different LLMs on Compose/Stratum workflow fidelity using canonical feature requests against a fixed seed repo, with hybrid scoring (automated Stratum audit + judge-model qualitative eval).

**Status:** PLANNED
**Created:** 2026-03-12
**Roadmap:** COMP-BENCH (items 62–66)

## Related Documents

- [ROADMAP.md](../../../ROADMAP.md) — COMP-BENCH (items 62–66)
- [STRAT-COMP-3 design](../STRAT-COMP-3/design.md) — Proof run (validates the pipeline this benchmarks)
- [build.stratum.yaml](../../../pipelines/build.stratum.yaml) — The lifecycle spec models are evaluated against
- `contracts/lifecycle.json` — Phase transition rules models must follow

---

## 1. Problem Statement

Compose dispatches work to LLMs via agent connectors. Different models (Claude Opus, Sonnet, Haiku, GPT-4o, Codex, Gemini) have different strengths. Today there is no systematic way to answer:

- Which model follows a `.stratum.yaml` pipeline most faithfully?
- Which model produces the best design docs vs. the best code?
- Which model respects gates, handles postcondition failures gracefully, and stays within budget?
- What's the cost/quality tradeoff per model per phase?

SWE-bench measures bug-fix ability on existing repos — single-turn, pass/fail. Compose needs to measure **multi-phase workflow fidelity**: does the model follow a structured pipeline, produce coherent artifacts across phases, and recover from failures?

**Goal:** A repeatable benchmark suite that scores models on pipeline fidelity, artifact quality, code correctness, gate discipline, and cost efficiency — with automated scoring from Stratum audit traces and judge-model scoring for qualitative axes.

---

## 2. Architecture Overview

### 2.1 Component Map

```
bench/
├── seed-repo/                  # Fixed ~2k LOC Node.js app (git repo)
│   ├── src/                    # Express API + simple frontend
│   ├── test/                   # Existing test suite
│   ├── .compose/               # Pre-initialized Compose project
│   └── package.json
│
├── features/                   # Canonical feature request specs
│   ├── auth-oauth.yaml         # Full lifecycle, multi-file, contract-first
│   ├── repo-refactor.yaml      # Refactor pipeline, incremental builds
│   ├── websocket-notify.yaml   # Design complexity, cross-cutting
│   ├── fix-race-condition.yaml # Diagnosis → fix (closest to SWE-bench)
│   └── csv-export.yaml         # Small feature, tests over-engineering
│
├── pipelines/                  # Stratum specs for each feature
│   └── bench-build.stratum.yaml
│
├── scoring/
│   ├── audit-scorer.js         # Automated: parse stratum audit → scores
│   ├── judge-scorer.js         # LLM judge: qualitative artifact scoring
│   ├── rubric.yaml             # Scoring rubric definition
│   └── report-generator.js     # Aggregate results → comparison report
│
├── harness/
│   ├── runner.js               # Orchestrates: reset repo → run model → collect
│   ├── connectors.js           # Model-specific connector config
│   └── isolation.js            # Git worktree per run for clean isolation
│
└── results/
    └── {model}-{feature}-{timestamp}/
        ├── audit.json          # Stratum audit trace
        ├── artifacts/          # Design docs, plans, code produced
        ├── scores.json         # Combined automated + judge scores
        └── meta.json           # Tokens, cost, wall time, retries
```

### 2.2 Execution Flow

```
runner.js
   │
   ├─ 1. git worktree create (isolated copy of seed-repo)
   │
   ├─ 2. Load feature spec from features/{name}.yaml
   │     - description, acceptance criteria, expected artifacts
   │
   ├─ 3. Configure connector for target model
   │     - model ID, API key ref, token budget
   │
   ├─ 4. compose build {feature} --connector {model}
   │     - Full pipeline: scaffold → design → plan → implement → test → audit
   │     - Stratum records every step, retry, gate, postcondition
   │
   ├─ 5. Collect outputs
   │     - Copy audit trace, artifacts, active-build.json
   │     - Record token usage, wall time, cost from connector
   │
   ├─ 6. Automated scoring (audit-scorer.js)
   │     - Parse stratum audit → pipeline fidelity, gate compliance, etc.
   │
   ├─ 7. Judge scoring (judge-scorer.js)
   │     - Feed artifacts + rubric to judge model → qualitative scores
   │
   └─ 8. Generate comparison report
```

---

## 3. Seed Repo Design

### 3.1 Requirements

The seed repo must be:

- **Small enough** to fit in a single context window (~2-3k LOC)
- **Real enough** to have architectural decisions worth making
- **Tested enough** that code correctness is measurable (tests pass/fail)
- **Stable** — pinned dependencies, no external service calls in tests

### 3.2 Shape

A task management API. Chosen because it's a domain every model has seen, reducing domain-knowledge variance and isolating workflow-fidelity signal.

```
seed-repo/
├── src/
│   ├── server.js           # Express app setup, middleware
│   ├── routes/
│   │   ├── tasks.js        # CRUD endpoints for tasks
│   │   ├── users.js        # Auth endpoints (basic, pre-OAuth)
│   │   └── health.js       # Health check
│   ├── models/
│   │   ├── task.js         # Task schema + validation
│   │   └── user.js         # User schema + validation
│   ├── middleware/
│   │   ├── auth.js         # Basic token auth (pre-OAuth)
│   │   └── errors.js       # Error handler
│   ├── db.js               # SQLite via better-sqlite3 (no external DB)
│   └── config.js           # Environment config
├── public/
│   ├── index.html          # Minimal task list UI
│   └── app.js              # Vanilla JS client (~200 lines)
├── test/
│   ├── integration/
│   │   ├── tasks.test.js   # CRUD golden flows
│   │   └── auth.test.js    # Auth golden flows
│   ├── harness/
│   │   └── setup.js        # DB reset, test server lifecycle
│   └── fixtures/
│       └── seed-data.js    # Deterministic test data
├── .compose/
│   └── compose.json        # Pre-initialized Compose manifest
├── package.json            # Pinned deps, no lockfile
└── README.md               # Minimal — models should read the code
```

### 3.3 Why SQLite

- No external services — benchmark runs anywhere
- Real SQL — not a mock, tests actually hit a database
- Fast reset — delete file, re-seed
- Deterministic — no connection pool timing variance

---

## 4. Canonical Feature Requests

Each feature request is a YAML file that defines what the model must build, what pipeline it runs through, and what acceptance criteria are evaluated.

### 4.1 Feature Spec Schema

```yaml
# features/{name}.yaml
name: string              # Human-readable name
id: string                # Feature code (e.g., BENCH-1)
difficulty: easy|medium|hard
pipeline: string          # Which .stratum.yaml to use
description: string       # The "product ask" — what a PM would say

acceptance:               # Machine-checkable criteria
  files_created: [string] # Expected new files (glob patterns)
  files_modified: [string]
  tests_pass: boolean     # All existing + new tests must pass
  test_count_min: number  # Minimum new tests added
  endpoints: [{method, path, status}]  # Expected API surface

artifacts:                # Expected Compose artifacts
  design: boolean         # Design doc must exist
  plan: boolean           # Plan doc must exist
  blueprint: boolean      # Blueprint must exist

judge_criteria:           # Qualitative axes for judge model
  - name: string
    weight: number        # 0-1, must sum to 1
    prompt: string        # Judge prompt for this criterion
```

### 4.2 The Five Features

#### BENCH-1: OAuth Authentication (hard)

Full lifecycle. Requires design decisions (OAuth provider, token storage, session management), multi-file changes (new routes, middleware rewrite, DB migration, frontend auth flow), and contract-first thinking.

**Tests:** model's ability to handle architectural complexity, produce coherent design docs, and make consistent decisions across phases.

#### BENCH-2: Repository Pattern Refactor (medium)

Refactor direct DB calls in route handlers into a repository layer. No new features — pure structural change. Existing tests must keep passing throughout.

**Tests:** incremental refactoring discipline, test preservation, ability to avoid over-engineering (should NOT add unnecessary abstractions beyond the repository layer).

#### BENCH-3: WebSocket Notifications (hard)

Add real-time notifications when tasks are created/updated/deleted. Requires cross-cutting changes: new WebSocket server, event emission from existing routes, frontend subscription, connection management.

**Tests:** cross-cutting design, integration across layers, handling of concurrent concerns (WebSocket lifecycle alongside HTTP).

#### BENCH-4: Fix Race Condition (medium)

The seed repo has an intentional race condition in the task assignment endpoint — two concurrent assignments can both succeed. Planted bug with a subtle test that exposes it intermittently.

**Tests:** diagnostic reasoning, root cause identification, minimal fix (should NOT rewrite the endpoint — just add proper locking/transaction).

#### BENCH-5: CSV Export (easy)

Add a `GET /tasks/export?format=csv` endpoint. Simple feature that a model should complete quickly without over-engineering.

**Tests:** restraint. Does the model add unnecessary abstractions (export service, format strategy pattern, plugin system) or just write the endpoint? Penalize over-engineering.

---

## 5. Scoring System

### 5.1 Automated Scoring (from Stratum audit trace)

These scores are extracted directly from the `stratum_audit` output — no LLM judge needed.

| Axis | Source | Scoring |
|------|--------|---------|
| **Pipeline fidelity** | Audit step sequence vs. spec step sequence | 10 = exact match, -1 per skipped/reordered/hallucinated step |
| **Gate compliance** | Audit gate events | 10 = all gates hit, 0 = any gate skipped |
| **Postcondition pass rate** | `ensure_failed` vs `ensure_passed` counts | 10 * (passed / total) |
| **Retry efficiency** | Retries used vs. retries available | 10 - (unnecessary_retries * 2) |
| **Budget compliance** | Tokens used vs. budget allocated | 10 = under budget, scaled down to 0 at 2x budget |
| **Test pass rate** | Final test run results | 10 * (passing / total) |

### 5.2 Judge Scoring (LLM evaluates artifacts)

A separate "judge" model (fixed across all benchmark runs — e.g., always Claude Opus) evaluates qualitative axes. Each axis gets a dedicated prompt with the rubric and the artifacts.

| Axis | What the judge sees | Scoring |
|------|--------------------|---------|
| **Design coherence** | Design doc + plan + code diff | 0-10: Does the design doc describe what was actually built? Are decisions consistent? |
| **Artifact quality** | Design doc + plan doc standalone | 0-10: Would a human engineer find these useful? Clear, structured, non-generic? |
| **Code quality** | Full diff of all changes | 0-10: Clean, idiomatic, no dead code, proper error handling at boundaries |
| **Over-engineering penalty** | Full diff + feature spec | 0-10: Did the model add unnecessary abstractions, configs, or features? (10 = minimal, 0 = gold-plated) |
| **Recovery quality** | Audit retry sequences + diffs between attempts | 0-10: When postconditions failed, were fixes targeted or shotgun? |

### 5.3 Composite Score

```
automated_score = mean(pipeline_fidelity, gate_compliance, postcondition_pass,
                       retry_efficiency, budget_compliance, test_pass_rate)

judge_score = weighted_mean(design_coherence, artifact_quality, code_quality,
                            overengineering_penalty, recovery_quality)

composite = 0.5 * automated_score + 0.5 * judge_score

cost_efficiency = composite / cost_in_dollars
```

### 5.4 Judge Consistency

To ensure judge reliability:
- **Fixed judge model** across all runs (never judge yourself)
- **Rubric-grounded prompts** — each criterion has explicit 0/2/5/8/10 anchor descriptions
- **Blind evaluation** — judge sees artifacts but not which model produced them
- **Inter-rater check** — run judge 3x per artifact, report mean + stddev. Flag any axis with stddev > 2

---

## 6. Benchmark Harness

### 6.1 Runner

```
compose bench run --model claude-opus --feature auth-oauth
compose bench run --model claude-sonnet --feature all
compose bench run --model gpt-4o --feature all --runs 3
compose bench report --compare claude-opus,claude-sonnet,gpt-4o
```

### 6.2 Isolation

Each run gets a git worktree:

```javascript
// harness/isolation.js
async function createIsolatedRun(seedRepoPath, runId) {
  const worktreePath = `bench/runs/${runId}`;
  await exec(`git worktree add ${worktreePath} --detach HEAD`);
  // Reset to clean seed state
  await exec(`git -C ${worktreePath} checkout -- .`);
  return worktreePath;
}
```

### 6.3 Connector Configuration

```yaml
# harness/models.yaml
models:
  claude-opus:
    connector: ClaudeSDKConnector
    model_id: claude-opus-4-6
    token_budget: 200000
    cost_per_1k_input: 0.015
    cost_per_1k_output: 0.075

  claude-sonnet:
    connector: ClaudeSDKConnector
    model_id: claude-sonnet-4-6
    token_budget: 200000
    cost_per_1k_input: 0.003
    cost_per_1k_output: 0.015

  gpt-4o:
    connector: OpenAIConnector  # new connector needed
    model_id: gpt-4o
    token_budget: 128000
    cost_per_1k_input: 0.005
    cost_per_1k_output: 0.015

  codex:
    connector: CodexConnector
    model_id: codex
    token_budget: 200000
    cost_per_1k_input: 0.0
    cost_per_1k_output: 0.0
```

---

## 7. Implementation Plan (High-Level)

### Phase A: Seed Repo (1 feature)

- [ ] Build the task management API seed repo
- [ ] Write integration test suite (golden flows + error paths)
- [ ] Plant the race condition bug (BENCH-4)
- [ ] Pre-initialize `.compose/` with manifest
- [ ] Verify: `npm test` passes, `compose build` runs against it

### Phase B: Feature Specs (2 features)

- [ ] Write all 5 feature request YAML specs
- [ ] Write `bench-build.stratum.yaml` (benchmark variant of build pipeline)
- [ ] Define acceptance criteria (file globs, test counts, endpoints)
- [ ] Define judge criteria with rubric anchors

### Phase C: Harness (3 features)

- [ ] `runner.js` — worktree isolation, connector config, run orchestration
- [ ] `audit-scorer.js` — parse Stratum audit → 6 automated scores
- [ ] `judge-scorer.js` — feed artifacts to judge model → 5 qualitative scores
- [ ] `report-generator.js` — aggregate, compare, output markdown table

### Phase D: Baseline Runs (1 feature)

- [ ] Run all 5 features against Claude Opus, Sonnet, Haiku
- [ ] Validate scoring consistency (judge stddev < 2)
- [ ] Calibrate rubric anchors based on actual output distribution
- [ ] Generate first comparison report

### Phase E: CLI Integration (1 feature)

- [ ] `compose bench` subcommand wired into `bin/compose.js`
- [ ] Results stored in `bench/results/` with consistent naming
- [ ] `compose bench report` generates comparison tables

---

## 8. Open Questions

1. **Judge model selection:** Use Claude Opus as judge for all models including Claude models? Or use a different judge to avoid self-evaluation bias? (Recommendation: use Opus as judge — it's evaluating artifacts, not itself, and consistency matters more than theoretical bias.)

2. **Feature request wording:** Should feature specs use PM-style prose ("users need to log in with Google") or technical specs ("add OAuth 2.0 PKCE flow with Google as IdP")? PM-style tests more of the pipeline; technical-style isolates implementation quality. (Recommendation: PM-style — that's what Compose is designed for.)

3. **Baseline calibration:** How many runs per model to establish a stable baseline? (Recommendation: 3 runs per feature per model = 75 total runs for 5 models. Run the easy feature first to validate the harness.)

4. **New connectors:** Benchmarking non-Claude models requires new connectors (OpenAI, Gemini). Should these be production connectors or benchmark-only shims? (Recommendation: benchmark-only shims first — they only need to implement the `AgentConnector` interface, not handle all production edge cases.)

---

## 9. Success Criteria

- [ ] Seed repo is stable: `npm test` passes deterministically 100/100 times
- [ ] All 5 features have YAML specs with machine-checkable acceptance criteria
- [ ] Harness runs end-to-end: `compose bench run --model X --feature Y` produces `scores.json`
- [ ] Automated scores correlate with human judgment (spot-check 10 runs manually)
- [ ] Judge scores have stddev < 2 across 3 evaluations of the same artifact
- [ ] `compose bench report` produces a readable comparison table
- [ ] At least 3 models benchmarked with full results
