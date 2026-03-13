# STRAT-PAR: Parallel Task Decomposition and Execution

**Feature:** Automatically decompose pipeline steps into independent subtasks, analyze their dependency graph, and execute non-dependent subtasks concurrently with file-ownership isolation and structured merge.

**Status:** PLANNED
**Created:** 2026-03-13
**Roadmap:** STRAT-PAR (items 67–72)
**IR Version:** 0.3 (patch bump from 0.2)

## Related Documents

- [Compose ROADMAP.md](../../../ROADMAP.md) — STRAT-PAR items
- [Stratum ROADMAP.md](../../../../stratum/ROADMAP.md) — Stratum-side IR changes
- [build.stratum.yaml](../../../pipelines/build.stratum.yaml) — Pipeline that gains parallel execution
- [concurrency.py](../../../../stratum/src/stratum/concurrency.py) — Existing async primitives (`parallel`, `race`, `debate`)
- [spec.py](../../../../stratum/stratum-mcp/src/stratum_mcp/spec.py) — IR schema and validation
- [executor.py](../../../../stratum/stratum-mcp/src/stratum_mcp/executor.py) — Flow execution engine

---

## 1. Problem Statement

Compose pipelines execute steps sequentially. A feature build with 6 independent view replacements (COMP-UI-4) runs them one after another even though they don't share files or state. The agent idles waiting for step N to complete before starting step N+1.

This is wasteful when:
- Multiple subtasks within a step touch different files
- Components are independent (e.g., BoardView, ListView, RoadmapView)
- Review passes on independent modules could run concurrently

**Goal:** Add a `decompose` → `parallel_dispatch` pattern to Stratum IR v0.3 that:
1. Analyzes a plan doc and emits a task graph with file ownership
2. Validates no file-ownership conflicts between concurrent tasks
3. Dispatches independent tasks to parallel agents (worktree-isolated)
4. Merges results in dependency order with conflict detection

---

## 2. What Already Exists

| Component | What's there | Gap |
|-----------|-------------|-----|
| `concurrency.py` | `parallel()`, `race()`, `debate()` — full async primitives with `require` semantics | Python library only, not exposed to IR/executor |
| `spec.py` | `depends_on` field, topological sort via Kahn's algorithm | No parallel grouping, no `require` semantics |
| `executor.py` | Sequential `current_idx` advancement, single step dispatch | No multi-step dispatch, no batch result collection |
| `build-dag.js` | DAG builder + topo sort for roadmap planning | Static planning only, not execution |
| `build.stratum.yaml` | All steps have `depends_on` forming a linear chain | No parallel branches |
| Claude Code | `isolation: "worktree"` for agents | Available but not used by Stratum |

---

## 3. Architecture

### 3.1 New IR v0.3 Primitives

Two new step types added to the schema:

#### `decompose` step

Runs an agent that reads a plan/spec and emits a `TaskGraph`:

```yaml
- id: analyze_tasks
  type: decompose
  agent: claude
  intent: >
    Read the plan at {plan_path}. For each task, identify:
    - Which files it creates or modifies (exclusive ownership)
    - Which other tasks must complete before it can start
    Output a TaskGraph.
  inputs:
    plan: "$.steps.plan.output.artifact"
  output_contract: TaskGraph
  ensure:
    - "no_file_conflicts(result.tasks)"
```

**TaskGraph contract:**

```yaml
TaskGraph:
  tasks:
    type: array
    items:
      type: object
      properties:
        id:          { type: string }
        description: { type: string }
        depends_on:  { type: array, items: { type: string } }
        files_owned: { type: array, items: { type: string } }
        files_read:  { type: array, items: { type: string } }
```

**Built-in ensure function:** `no_file_conflicts(tasks)` validates that no two tasks without a dependency relationship share entries in `files_owned`. Read-only overlap is allowed; write overlap requires a dependency edge.

#### `parallel_dispatch` step

Executes tasks from a TaskGraph concurrently, respecting the dependency DAG:

```yaml
- id: execute_parallel
  type: parallel_dispatch
  source: "$.steps.analyze_tasks.output.tasks"
  agent: claude
  max_concurrent: 3
  isolation: worktree
  require: all
  merge: sequential_apply
  intent_template: >
    Implement this task: {task.description}
    You own these files exclusively: {task.files_owned}
    Do NOT modify any other files.
  output_contract: PhaseResult
  ensure:
    - "result.outcome == 'complete'"
  retries: 2
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `source` | ref | Reference to a TaskGraph (array of tasks) |
| `agent` | string | Default agent for all subtasks (overridable per task) |
| `max_concurrent` | int | Maximum simultaneous agent dispatches |
| `isolation` | enum | `worktree` (git worktree per task) or `branch` (git branch per task) |
| `require` | `all` / `any` / int | How many tasks must succeed (maps to `concurrency.parallel()` semantics) |
| `merge` | enum | `sequential_apply` (diffs in topo order) or `manual` (human resolves) |
| `intent_template` | string | Template with `{task.*}` placeholders, expanded per task |

### 3.2 Execution Flow

```
decompose step
    │
    ▼
TaskGraph validated (no_file_conflicts)
    │
    ▼
parallel_dispatch step
    │
    ├─ Topo-sort tasks into levels (L0: no deps, L1: depends on L0, ...)
    │
    ├─ Level 0: dispatch up to max_concurrent tasks
    │   ├─ Each task gets its own git worktree
    │   ├─ Agent receives intent_template with task context
    │   ├─ Agent runs, produces diff in worktree
    │   └─ On completion: collect diff, record result
    │
    ├─ When all L0 tasks complete: merge diffs into main worktree
    │   ├─ Apply in topo order
    │   ├─ If conflict detected: STOP, report conflict, fall back to sequential
    │   └─ Run ensure expressions against merged state
    │
    ├─ Level 1: dispatch tasks whose deps are now satisfied
    │   └─ (repeat)
    │
    └─ All levels complete: final merged state is the step output
```

### 3.3 Merge Strategy: `sequential_apply`

Each parallel task produces a git diff (captured from its worktree). Diffs are applied to the main working tree in topological order:

1. Sort completed tasks by topo position
2. For each task: `git apply --check <diff>` (dry run)
3. If clean: `git apply <diff>`
4. If conflict: mark the task as `conflict`, log which files collided, abort remaining applies
5. On conflict: the step fails with a structured error containing the conflict details. The retry mechanism can re-run with sequential fallback.

**Why not three-way merge?** Worktree diffs are against the same base commit. If `no_file_conflicts()` passed during decomposition, diffs should apply cleanly. Conflicts indicate the decomposition was wrong (missed a shared file), not a merge problem — so we surface it as a decomposition error, not a merge error.

### 3.4 Worktree Lifecycle

```
main worktree (compose build runs here)
    │
    ├─ git worktree add .compose/par/task-001 --detach HEAD
    ├─ git worktree add .compose/par/task-002 --detach HEAD
    ├─ git worktree add .compose/par/task-003 --detach HEAD
    │
    │  (agents run in parallel, each in their own worktree)
    │
    ├─ Collect diffs: git -C .compose/par/task-001 diff HEAD
    ├─ Apply diffs to main worktree in topo order
    │
    └─ git worktree remove .compose/par/task-* (cleanup)
```

Worktrees live under `.compose/par/` and are cleaned up after merge regardless of success/failure.

---

## 4. Schema Changes (IR v0.3)

### 4.1 New Version

Add `"0.3"` to the `SCHEMAS` dict in `spec.py`. v0.3 is a **superset** of v0.2 — all v0.2 specs are valid v0.3 specs. The only additions:

```python
# New step types
"type": {"enum": ["function", "inline", "flow", "decompose", "parallel_dispatch"]}

# New fields on steps (all optional, only valid on parallel_dispatch)
"source":          {"type": "string"}       # ref to TaskGraph
"max_concurrent":  {"type": "integer", "minimum": 1}
"isolation":       {"enum": ["worktree", "branch"]}
"require":         {}                       # "all" | "any" | integer
"merge":           {"enum": ["sequential_apply", "manual"]}
"intent_template": {"type": "string"}

# New built-in ensure function
"no_file_conflicts": # validates TaskGraph has no write-write overlap between independent tasks
```

### 4.2 Semantic Validation

New rules added to `_validate_semantics()`:

1. `decompose` step must have `output_contract` referencing a TaskGraph-shaped contract
2. `parallel_dispatch` step must have `source` referencing a decompose step's output
3. `parallel_dispatch` must not appear inside a `parallel_dispatch` (no nested parallelism)
4. `intent_template` is required on `parallel_dispatch`, forbidden on other step types
5. `max_concurrent` defaults to 3 if omitted on `parallel_dispatch`

### 4.3 Backward Compatibility

- v0.2 specs continue to work unchanged — the `SCHEMAS["0.2"]` entry is untouched
- v0.3 adds new step types but doesn't modify existing ones
- The executor dispatches `decompose` and `parallel_dispatch` only when encountered; existing step types use the current sequential path

---

## 5. Executor Changes

### 5.1 Replace `current_idx` with Ready Set

The core change: instead of a single integer index, the executor tracks a **set of completed step IDs** and computes which steps are ready (all `depends_on` satisfied, not yet started).

```python
# Current (v0.2):
state.current_idx: int  # which step we're on

# New (v0.3):
state.completed_steps: set[str]     # step IDs that have finished
state.active_steps: set[str]        # step IDs currently running
state.step_results: dict[str, Any]  # results keyed by step ID

def ready_steps(state, flow_def) -> list[str]:
    """Return step IDs whose depends_on are all in completed_steps."""
    ...
```

**Backward compatibility:** For non-`parallel_dispatch` steps, `get_current_step_info()` still returns exactly one step (the first ready step in topo order). The MCP tool interface doesn't change — `stratum_plan` and `stratum_step_done` work the same way. The executor just knows how to return multiple steps when a `parallel_dispatch` is the current step.

### 5.2 New MCP Tool: `stratum_parallel_dispatch`

When the executor encounters a `parallel_dispatch` step, `stratum_plan`/`stratum_step_done` returns a new dispatch type:

```json
{
  "type": "parallel_dispatch",
  "flow_id": "...",
  "step_id": "execute_parallel",
  "tasks": [
    {"id": "task-001", "description": "...", "files_owned": [...], "depends_on": []},
    {"id": "task-002", "description": "...", "files_owned": [...], "depends_on": []},
    {"id": "task-003", "description": "...", "files_owned": [...], "depends_on": ["task-001"]}
  ],
  "max_concurrent": 3,
  "isolation": "worktree",
  "intent_template": "..."
}
```

The caller (Compose `build.js`) handles the actual parallel agent dispatch. Stratum provides the task graph and validation; Compose provides the execution runtime.

### 5.3 New MCP Tool: `stratum_parallel_done`

Reports results for a completed parallel dispatch:

```json
{
  "flow_id": "...",
  "step_id": "execute_parallel",
  "task_results": [
    {"task_id": "task-001", "result": {...}, "status": "complete"},
    {"task_id": "task-002", "result": {...}, "status": "complete"},
    {"task_id": "task-003", "result": {...}, "status": "complete"}
  ],
  "merge_status": "clean"
}
```

Stratum validates ensure expressions against the aggregate result and advances the flow.

---

## 6. Compose Changes (`build.js`)

### 6.1 Handle `parallel_dispatch` Dispatch Type

```javascript
case 'parallel_dispatch': {
  const { tasks, max_concurrent, isolation, intent_template } = dispatch;

  // 1. Topo-sort tasks into levels
  const levels = topoLevels(tasks);

  // 2. Execute level by level
  for (const level of levels) {
    // 3. Dispatch up to max_concurrent agents
    const results = await parallelAgentDispatch(level, {
      max_concurrent,
      isolation,
      intent_template,
      connector: getConnector(dispatch.agent),
    });

    // 4. Merge diffs from this level
    const mergeResult = await mergeDiffs(results);
    if (mergeResult.conflicts.length > 0) {
      // Fall back to sequential for conflicting tasks
      break;
    }
  }

  // 5. Report to Stratum
  await stratum.parallelDone(flow_id, step_id, taskResults, mergeStatus);
}
```

### 6.2 Worktree Management

```javascript
async function createTaskWorktree(taskId) {
  const path = join('.compose', 'par', taskId);
  await exec(`git worktree add ${path} --detach HEAD`);
  return path;
}

async function collectDiff(worktreePath) {
  const diff = await exec(`git -C ${worktreePath} diff HEAD`);
  return diff;
}

async function cleanupWorktrees() {
  const parDir = join('.compose', 'par');
  // remove all worktrees, ignore errors
  await exec(`git worktree list --porcelain`)
    .then(list => /* filter .compose/par entries, remove each */);
}
```

### 6.3 Agent Bar Integration

When a `parallel_dispatch` is active, the agent bar shows parallel tracks:

```
Agent Bar (expanded):
┌────────────────────────────────────────────────────┐
│ ● Parallel: 3/6 tasks  [██████░░░░░░] 50%         │
│                                                     │
│  ✓ task-001: Replace BoardView          12s        │
│  ✓ task-002: Replace ListView            9s        │
│  ● task-003: Replace RoadmapView        [working]  │
│  ● task-004: Restyle GraphView          [working]  │
│  ○ task-005: Add PipelineView           [queued]   │
│  ○ task-006: Add SessionsView           [queued]   │
└────────────────────────────────────────────────────┘
```

---

## 7. Pipeline Integration

### 7.1 Updated `build.stratum.yaml` (excerpt)

The execute step gains a decompose + parallel_dispatch pair:

```yaml
# Phase: Task Analysis
- id: decompose
  type: decompose
  agent: claude
  intent: >
    Read the plan at docs/features/{featureCode}/plan.md.
    For each task, identify which files it creates or modifies
    (exclusive ownership) and which tasks must complete first.
    Output a TaskGraph. Be conservative — if two tasks might
    touch the same file, add a dependency edge between them.
  inputs:
    plan: "$.steps.plan.output.artifact"
  output_contract: TaskGraph
  ensure:
    - "no_file_conflicts(result.tasks)"
    - "len(result.tasks) >= 1"
  retries: 2
  depends_on: [plan_gate]

# Phase: Parallel Execute
- id: execute
  type: parallel_dispatch
  source: "$.steps.decompose.output.tasks"
  agent: claude
  max_concurrent: 3
  isolation: worktree
  require: all
  merge: sequential_apply
  intent_template: >
    Implement this task: {task.description}
    Feature: {featureCode}
    You own these files exclusively: {task.files_owned}
    You may read but NOT modify: {task.files_read}
    Use TDD: write test first, watch it fail, implement, watch it pass.
  output_contract: PhaseResult
  ensure:
    - "result.outcome == 'complete'"
  retries: 2
  depends_on: [decompose]
```

### 7.2 Fallback to Sequential

If `no_file_conflicts` fails (tasks have overlapping file ownership that can't be resolved by adding edges), the decompose step retries with a prompt asking the agent to add dependency edges to resolve conflicts. If it still fails after retries, the pipeline falls back to a single sequential execute step (current behavior).

If merge conflicts occur during `sequential_apply`, the parallel_dispatch step fails and retries. On second failure, Compose falls back to sequential execution of the remaining tasks.

**Principle:** Parallel is an optimization. Sequential is always the safe fallback. The pipeline never fails because parallelism failed — it degrades gracefully.

---

## 8. Open Questions

1. **Decompose agent vs static analysis?** The decompose step uses an agent to analyze the plan. An alternative is static analysis of the plan doc (parse task headers, extract file paths). Agent analysis is more flexible but costs a prompt. Recommendation: agent, because plans vary in format and the agent can reason about implicit dependencies.

2. **Max concurrency default?** 3 is conservative. Claude Code supports many subagents. But each worktree is a full repo copy, and each agent consumes API tokens. Recommendation: default 3, configurable up to 10.

3. **Worktree vs branch isolation?** Worktrees are heavier (full working copy) but fully isolated. Branches share the working tree and can't run concurrently. Recommendation: worktree only for v0.3; branch mode deferred.

4. **Should review sub-flows also parallelize?** If 6 tasks ran in parallel, should 6 review passes also run in parallel? Recommendation: yes, but only if the review step is inside the parallel_dispatch scope. For now, review runs after merge on the combined diff.

5. **IR version: 0.3 or 0.2.1?** This adds new step types but doesn't break existing specs. Recommendation: 0.3 — new step types are a feature addition, not a patch. The `SCHEMAS` dict already supports multiple versions cleanly.

---

## 9. Success Criteria

- [ ] IR v0.3 schema validates `decompose` and `parallel_dispatch` step types
- [ ] `no_file_conflicts()` built-in ensure function works
- [ ] Executor returns `parallel_dispatch` dispatch type with task graph
- [ ] `stratum_parallel_done` MCP tool accepts batch results
- [ ] `build.js` dispatches tasks to parallel agents in worktrees
- [ ] Diffs merge cleanly when file ownership is respected
- [ ] Conflicts detected and reported with structured error
- [ ] Graceful fallback to sequential on conflict
- [ ] Agent bar shows parallel task progress
- [ ] Pipeline runs at least 2x faster on COMP-UI-4 (6 independent views) vs sequential
