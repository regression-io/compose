# Stratum: Workflow Execution for AI Agents

You are participating in a Stratum-orchestrated workflow. Stratum is an execution engine that coordinates multi-step, multi-agent workflows via `.stratum.yaml` specs. Your job is to execute assigned steps, return structured results, and let Stratum handle sequencing, gates, and routing.

## How It Works

1. An orchestrator calls `stratum_plan` with a spec and inputs
2. Stratum returns the first step for you to execute
3. You do the work described in the step's `intent`
4. You call `stratum_step_done` with your result
5. Stratum evaluates postconditions and returns the next step (or completion)
6. Repeat until the flow completes

## MCP Tools

### Core Loop

**`stratum_plan(spec, flow, inputs)`** — Start a flow. Returns the first step dispatch.

**`stratum_step_done(flow_id, step_id, result)`** — Report step completion. `result` is a JSON object. Returns the next step, or `complete`.

**`stratum_audit(flow_id)`** — Get the full execution trace after completion.

### Gates

**`stratum_gate_resolve(flow_id, step_id, outcome, rationale, resolved_by)`**
- `outcome`: `"approve"`, `"revise"`, or `"kill"`
- `resolved_by`: `"human"`, `"agent"`, or `"system"`
- Returns: next step dispatch (approve/revise) or killed status

### Iterations

**`stratum_iteration_start(flow_id, step_id)`** — Start a counted loop on the current step.

**`stratum_iteration_report(flow_id, step_id, result)`** — Report one iteration. Returns `iteration_continue` or `iteration_exit`.

**`stratum_iteration_abort(flow_id, step_id, reason)`** — Abort the loop early.

### Utility

**`stratum_skip_step(flow_id, step_id, reason)`** — Skip the current step with a recorded reason.

**`stratum_validate(spec)`** — Validate a spec without executing. Returns `{ valid, errors }`.

**`stratum_commit(flow_id, label)`** — Create a named checkpoint.

**`stratum_revert(flow_id, label)`** — Roll back to a checkpoint.

## Step Dispatch Response

When Stratum gives you a step to execute, the response looks like:

```json
{
  "status": "execute_step",
  "flow_id": "uuid",
  "step_number": 1,
  "total_steps": 5,
  "step_id": "design",
  "step_mode": "inline",
  "agent": "claude",
  "intent": "Explore the codebase and write a design doc.",
  "inputs": { "featureCode": "FEAT-1" },
  "output_contract": "PhaseResult",
  "output_fields": { "phase": "string", "artifact": "string", "outcome": "string" },
  "ensure": ["file_exists('docs/features/' + input.featureCode + '/design.md')"],
  "retries_remaining": 2
}
```

Key fields:
- **`intent`** — What to do. This is your primary instruction.
- **`inputs`** — Data from prior steps or flow input. Use these values.
- **`output_fields`** — Expected shape of your result. Return a JSON object matching these fields.
- **`ensure`** — Postconditions Stratum will evaluate. Make sure your work satisfies them.
- **`retries_remaining`** — How many retries left if postconditions fail.

## Returning Results

Call `stratum_step_done(flow_id, step_id, result)` where `result` is a JSON object.

If `output_fields` specifies expected fields, your result must include them:

```json
// output_fields: { "phase": "string", "artifact": "string", "outcome": "string" }
// Your result:
{ "phase": "explore_design", "artifact": "design.md", "outcome": "complete" }
```

If `ensure` expressions reference `result.*`, your result must satisfy them:

```python
# ensure: ["result.clean == true"]
# Your result must have: { "clean": true, ... }

# ensure: ["file_exists('docs/features/' + input.featureCode + '/design.md')"]
# You must create that file before calling step_done
```

### When Postconditions Fail

If your result fails an `ensure` expression and retries remain, Stratum returns the same step with `status: "ensure_failed"` and `violations` listing what failed. Fix the issues and call `step_done` again.

## IR v0.2 Spec Format

### Top-Level Structure

```yaml
version: "0.2"

workflow:                    # optional — makes the spec invocable as a command
  name: build               # lowercase, hyphens allowed
  description: "Execute feature lifecycle"
  input:
    featureCode:
      type: string
      required: true
    skipPrd:
      type: boolean
      default: false

contracts:                   # optional — define output shapes
  PhaseResult:
    phase:    { type: string }
    artifact: { type: string }
    outcome:  { type: string }

functions:                   # optional — reusable function definitions
  my_function:
    mode: compute            # compute | infer | gate
    intent: "Do something"
    input:
      param: { type: string }
    output: PhaseResult      # contract reference
    ensure:
      - "file_exists('output.txt')"
    retries: 3

flows:                       # required — at least one flow
  main:
    input:
      featureCode: { type: string }
    output: PhaseResult
    max_rounds: 10
    steps:
      - id: step_one
        # ... step definition
```

### Step Types

Every step must have exactly one of: `function`, `intent`, or `flow`.

**Function reference** — calls a defined function:
```yaml
- id: design
  function: explore_design
  inputs:
    featureCode: "$.input.featureCode"
  depends_on: []
```

**Inline step** — intent and execution params directly on the step:
```yaml
- id: design
  agent: claude
  intent: "Explore codebase and write design.md"
  inputs:
    featureCode: "$.input.featureCode"
  ensure:
    - "file_exists('docs/features/' + input.featureCode + '/design.md')"
  retries: 2
```

**Sub-workflow** — invokes another flow:
```yaml
- id: review
  flow: review_fix
  inputs:
    task: "$.steps.implement.output.summary"
    blueprint: "$.input.blueprint"
  depends_on: [implement]
```

### Step Fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Required. Unique within the flow. |
| `agent` | string | Which agent executes (e.g. `claude`, `codex`). Forbidden on `flow` steps. |
| `intent` | string | What to do (inline steps only). |
| `function` | string | Reference to `functions:` block. |
| `flow` | string | Sub-workflow name from `flows:`. |
| `inputs` | object | Data from prior steps. Values are expressions like `"$.input.x"` or `"$.steps.prev.output.y"`. |
| `depends_on` | list | Step IDs this step waits for. |
| `ensure` | list | Postcondition expressions. Evaluated after step_done. |
| `retries` | integer | Max retries on ensure failure. Inline steps only. |
| `on_fail` | string | Route to this step ID when retries exhausted. Requires `ensure`. |
| `next` | string | Explicit next step (for loop-back routing). |
| `skip_if` | string | Expression — skip this step if true. |
| `skip_reason` | string | Recorded when skipped. |
| `max_iterations` | integer | Enable counted iteration loop. |
| `exit_criterion` | string | Expression — exit loop when true. Requires `max_iterations`. |
| `output_contract` | string | Contract name for result validation. Inline steps only. |

### Gate Steps

Gate steps suspend the flow until a human or agent resolves them:

```yaml
functions:
  design_gate:
    mode: gate
    timeout: 3600         # optional, seconds

steps:
  - id: design_review
    function: design_gate
    on_approve: plan       # proceed to this step
    on_revise: design      # loop back to this step
    on_kill: null           # null = terminal (end flow)
```

Gate-specific fields:
- `on_approve` — step ID to route to on approval (null = flow complete)
- `on_revise` — step ID to loop back to (must be topologically earlier, required non-null)
- `on_kill` — step ID or null (null = terminate flow)
- `policy` — `gate` (default), `flag` (auto-approve, note for review), `skip` (auto-approve, silent)

### Input Expressions

Reference flow inputs and prior step outputs:

```yaml
inputs:
  featureCode: "$.input.featureCode"           # flow input
  summary: "$.steps.design.output.summary"     # prior step output
  clean: "$.steps.review.output.clean"         # boolean from prior step
```

### Ensure Expressions

Python-like expressions evaluated by Stratum. Available context:
- `result` — the step's result object
- `input` — the step's resolved inputs
- `file_exists(path)` — check if a file exists
- `file_contains(path, text)` — check if a file contains text

```yaml
ensure:
  - "result.clean == true"
  - "file_exists('docs/features/' + input.featureCode + '/design.md')"
  - "len(result.findings) == 0"
```

No `__` (dunder) allowed in expressions (security guard).

## Examples

### Example 1: Simple Linear Spec

```yaml
version: "0.2"

contracts:
  Result:
    summary: { type: string }

flows:
  simple:
    input:
      task: { type: string }
    output: Result
    steps:
      - id: research
        agent: claude
        intent: "Research the topic and write notes."
        inputs:
          task: "$.input.task"
        retries: 1

      - id: write
        agent: claude
        intent: "Write a summary based on the research."
        inputs:
          task: "$.input.task"
          notes: "$.steps.research.output.summary"
        output_contract: Result
        ensure:
          - "len(result.summary) > 100"
        retries: 2
        depends_on: [research]
```

### Example 2: Review-Fix Loop with on_fail/next

```yaml
version: "0.2"

contracts:
  ReviewResult:
    clean:    { type: boolean }
    findings: { type: array }

flows:
  review_fix:
    input:
      task: { type: string }
      blueprint: { type: string }
    output: ReviewResult
    steps:
      - id: implement
        agent: claude
        intent: "Implement the task fully."
        inputs:
          task: "$.input.task"
        retries: 1

      - id: review
        agent: codex
        intent: "Review the implementation against the blueprint."
        inputs:
          task: "$.input.task"
          blueprint: "$.input.blueprint"
        output_contract: ReviewResult
        ensure:
          - "result.clean == true"
        retries: 3
        on_fail: fix
        depends_on: [implement]

      - id: fix
        agent: claude
        intent: "Fix all review findings."
        inputs:
          findings: "$.steps.review.output.findings"
          task: "$.input.task"
        next: review
```

When `review` fails its ensure (not clean), it routes to `fix`. After `fix` completes, `next: review` loops back. This continues until clean or retries exhausted.

### Example 3: Multi-Agent Spec

```yaml
version: "0.2"

flows:
  multi_agent:
    input:
      topic: { type: string }
    steps:
      - id: explore
        agent: claude
        intent: "Explore the codebase for patterns related to the topic."
        inputs:
          topic: "$.input.topic"

      - id: audit
        agent: codex
        intent: "Audit the patterns found for correctness."
        inputs:
          patterns: "$.steps.explore.output.summary"
        depends_on: [explore]

      - id: document
        agent: claude
        intent: "Write documentation based on the audit findings."
        inputs:
          findings: "$.steps.audit.output.summary"
        depends_on: [audit]
```

Each step's `agent` field tells the orchestrator which agent to dispatch to.

### Example 4: Composed Workflow with flow:

```yaml
version: "0.2"

contracts:
  ReviewResult:
    clean:    { type: boolean }
    findings: { type: array }

flows:
  review_fix:
    input:
      task: { type: string }
      blueprint: { type: string }
    output: ReviewResult
    steps:
      - id: review
        agent: codex
        intent: "Review against blueprint. Return {clean, findings}."
        inputs:
          task: "$.input.task"
          blueprint: "$.input.blueprint"
        output_contract: ReviewResult
        ensure:
          - "result.clean == true"
        on_fail: fix
        retries: 10

      - id: fix
        agent: claude
        intent: "Fix all findings."
        inputs:
          findings: "$.steps.review.output.findings"
          task: "$.input.task"
        next: review

  build_feature:
    input:
      featureCode: { type: string }
      description: { type: string }
    steps:
      - id: implement
        agent: claude
        intent: "Implement the feature."
        inputs:
          featureCode: "$.input.featureCode"
          description: "$.input.description"

      - id: review
        flow: review_fix
        inputs:
          task: "$.steps.implement.output.summary"
          blueprint: "$.input.description"
        depends_on: [implement]
```

The `review` step in `build_feature` invokes the `review_fix` sub-flow. Stratum creates a child execution with its own step graph and audit trail.

## Key Rules

1. **Always call `stratum_step_done`** after completing work. Never skip it.
2. **Return structured JSON** when `output_fields` is present.
3. **Satisfy ensure expressions** — if your result fails, you'll get a retry with violations listed.
4. **Read `inputs`** — they contain data from prior steps. Don't ignore them.
5. **The `intent` is your instruction.** Follow it precisely.
6. **Don't call `stratum_plan` yourself** unless you're authoring a new workflow. The orchestrator handles planning.
