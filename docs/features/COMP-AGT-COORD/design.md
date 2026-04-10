# Agent Coordination, Templates & Observability: Design

**Status:** DESIGN
**Date:** 2026-03-28
**Feature Code:** COMP-AGT (items AGT-5 through AGT-17)
**Prerequisite:** COMP-AGT-1-4 (implemented)

## Related Documents

- [ROADMAP.md](/docs/ROADMAP.md) -- Phase 6.9 Agent Infrastructure (Feature 2-5)
- [COMP-AGT-1-4 implementation](/server/agent-registry.js, /server/agent-spawn.js, /server/agent-health.js, /server/worktree-gc.js) -- Foundation layer
- [Connector abstraction](/server/connectors/agent-connector.js) -- AsyncGenerator interface for all agent types
- [Build orchestration](/lib/build.js) -- Parallel dispatch, worktree isolation, merge logic
- [Compose MCP](/server/compose-mcp.js, /server/compose-mcp-tools.js) -- Tool definitions and `agent_run` implementation
- [Agent server](/server/agent-server.js) -- SDK session management, SSE streaming

---

## Problem

Compose's agent infrastructure (AGT-1-4) provides the basics: spawn, kill, health monitoring, and worktree cleanup. But agents operate in isolation -- there is no way for a parent to send a structured message to a running child, no way for parallel tasks to signal each other, no reliable delivery guarantees on the WebSocket broadcast, and merge conflicts terminate the entire parallel batch. The registry is a flat list with no query capability, there is no observability beyond stdout aggregation, and agent dispatch relies on prompt-keyword heuristics rather than a template library.

These gaps become blocking as builds scale: a 6-task parallel dispatch with one merge conflict wastes all work; a silent agent burns 5 minutes before auto-kill with no diagnostic trail; the parent agent has no structured way to manage a fleet beyond raw `agent_run` calls.

## Goal

**In scope:**
- Bidirectional parent-child messaging for spawned agents (AGT-5)
- Shared state and event signaling across parallel tasks (AGT-6)
- Reliable message delivery with ordering guarantees (AGT-7)
- Pluggable merge strategies with conflict recovery (AGT-8)
- Transient failure retry and partial success (AGT-9)
- Rich registry queries and indexed history (AGT-10)
- Correlation IDs and per-agent metrics (AGT-11)
- Pre-flight DAG and isolation validation (AGT-12)
- Agent template library with capability declarations (AGT-13-14)
- Parent orchestration and parallel dispatch skills (AGT-15-16)
- Transactional agent state machine with long-term persistence (AGT-17)

**Not in scope:**
- Multi-machine agent distribution (single-host only)
- Agent-to-agent direct communication (all coordination goes through parent or shared blackboard)
- Real-time streaming of agent output to other agents (relay remains UI-only)
- Changes to the Claude SDK's query() interface (we work within its async iterator)

---

## Decision 1: Parent-Child RPC Model (AGT-5)

### Context

Today, spawned agents (child_process via `agent-spawn.js:53-60`) are fire-and-forget: parent sends a prompt string, child writes to stdout, parent reads the accumulated output on close (`agent-spawn.js:96-101`). SDK sessions (`agent-server.js`) have bidirectional SSE but only for the vision surface -- there is no structured request/response channel between parent and child.

### Runtime Model

AGT-5 RPC is an **SDK-session feature only**. The two agent runtime models have fundamentally different communication capabilities:

- **SDK sessions** (`agent-server.js`): Long-lived, bidirectional via `POST /api/agent/message`. Supports request/response RPC with correlation IDs.
- **Spawned CLI agents** (`agent-spawn.js`, `claude -p`): One-shot, fire-and-forget. No stdin, no controller loop, no way to receive messages after dispatch. Communication is unidirectional: dispatch prompt -> stdout -> result on close.

For spawned CLI agents, structured results are achieved via **output schema injection** (already works via `agent-mcp.js` schema mode). The parent includes a JSON schema in the prompt; the agent writes conforming JSON to stdout; the parent parses on close. No RPC needed.

> **Deferred:** If CLI agents need bidirectional RPC in the future, they would need to be migrated to SDK sessions or wrapped in a persistent runtime with a message loop. This is out of scope for AGT-5.

### Approach: SDK Session RPC Channel

For SDK sessions, messages route through the existing `POST /api/agent/message` endpoint (`agent-server.js:114-129`), which resumes the session. Each message is a structured envelope:

```json
{
  "id": "msg-<ulid>",
  "correlationId": "req-<ulid>",
  "type": "request" | "response" | "event",
  "payload": { ... },
  "timestamp": "ISO-8601",
  "seq": 0
}
```

The `correlationId` links requests to responses. The parent sends a `request`, the SDK session processes it and returns a `response` with the same `correlationId`. Events are fire-and-forget notifications (no response expected).

**For spawned CLI agents:** No RPC channel. The parent dispatches a prompt with an output schema, and reads structured JSON from stdout on process close. This is the existing pattern and requires no new infrastructure.

### Alternatives Considered

1. **File-based mailbox (inbox.jsonl/outbox.jsonl):** Would work for SDK sessions but is infeasible for `claude -p` children -- they are one-shot with no controller loop to poll an inbox. Rejected in favor of scoping RPC to SDK sessions only.
2. **Named pipes (FIFOs):** Cross-platform issues on Windows, more complex lifecycle management. SDK's existing message endpoint is simpler.
3. **Unix domain sockets:** Requires the child to be a server or client. Unnecessary when the SDK already provides bidirectional communication.
4. **Stdin reopening:** Not possible after spawn with `stdio: ['ignore', ...]`. Would require changing the spawn interface, which breaks the existing `claude -p` CLI invocation.

### Dependencies

- AGT-7 (message ordering) provides sequence numbers and dedup for this channel
- AGT-17 (state persistence) manages session lifecycle

---

## Decision 2: Inter-Task Coordination (AGT-6)

### Context

Parallel tasks dispatched by `build.js:676-986` run fully independently. The `depends_on` field in task specs only affects merge order in `topoVisit` (`build.js:858-871`), not runtime execution order. There is no mechanism for Task B to wait for Task A's output or for tasks to share intermediate results.

### Approach: Orchestrator-Side Blackboard + Completion Barrier

Introduce a `Blackboard` class -- a shared key-value store backed by a single JSON file at `.compose/par/<batchId>/blackboard.json`. The blackboard is **orchestrator-side only** -- tasks do not call blackboard methods directly. The orchestrator (`parallel-runner.js`) owns all blackboard reads and writes.

```js
class Blackboard {
  constructor(batchDir) { ... }
  async set(key, value, writerId) { ... }  // called by orchestrator only
  async get(key) { ... }                   // called by orchestrator only
  async waitFor(key, timeoutMs) { ... }    // orchestrator polls until key exists or timeout
  async keys() { ... }                     // list all keys
}
```

**Why orchestrator-only:** Tasks run inside Claude query sessions (SDK or CLI). They have no direct access to the blackboard file and no API endpoint to call `blackboard.set()` or `waitFor()`. Adding an agent-facing blackboard API would require wiring a new MCP tool into the connector layer -- unnecessary complexity when the orchestrator already has full visibility into task lifecycle.

**Task-to-task wait semantics:** When a task spec declares `depends_on: [taskA]`, the orchestrator does two things:
1. (Existing) Enforces merge order in topo sort
2. (New) Before dispatching Task B, the orchestrator waits for Task A's completion signal: `blackboard.set('task:<taskA>:done', result)`. When Task A completes, the orchestrator writes the signal and injects Task A's result into Task B's prompt context.

The completion signal is written by the orchestrator's dispatch loop (`parallel-runner.js`) immediately after `runAndNormalize` returns for each task, before diff collection.

**Context injection:** When the orchestrator detects that Task B's dependencies are satisfied, it reads dependency results from the blackboard and prepends them to Task B's prompt as structured context (e.g., "Task A completed with: {result}"). This gives dependent tasks access to upstream outputs without any agent-facing API.

**Event bus:** The blackboard doubles as an event bus for orchestrator-level coordination. The orchestrator publishes named events (`blackboard.set('event:schema-ready', schema)`) and checks them before dispatching dependent tasks. This is opt-in -- tasks that don't declare runtime dependencies run fully in parallel as before.

### Alternatives Considered

1. **In-memory EventEmitter:** Doesn't work -- each task runs in its own connector (separate Claude query). The orchestrator (`build.js`) is the only shared process.
2. **Redis/SQLite:** Over-engineered for local-only, single-machine operation.
3. **File watches:** More complex than polling for low-frequency events. Blackboard read is ~1ms for a small JSON file.

### Dependencies

- AGT-12 (pre-flight validation) ensures `depends_on` references are valid before dispatch

---

## Decision 3: Message Delivery Guarantees (AGT-7)

### Context

The WebSocket broadcast in `vision-server.js:300-310` is fire-and-forget: messages are serialized and sent to all connected clients. If a client disconnects and reconnects, it misses all messages during the gap. There are no sequence numbers, no heartbeat, and no deduplication. The `BuildStreamBridge` (`build-stream-bridge.js:210`) has its own `_seq` dedup but that is JSONL-level, not WebSocket-level.

### Approach: Sequence Numbers + Ring Buffer Replay

Add three mechanisms to `VisionServer.broadcastMessage()`:

1. **Monotonic sequence number:** Each broadcast message gets a `_seq: N` field. The server maintains a counter. Clients track last-seen `_seq`.

2. **Ring buffer:** Server stores the last 1000 messages in a circular buffer. On reconnect, client sends `lastSeq=N` in the WebSocket upgrade URL. Server replays messages from `N+1` to current.

3. **Heartbeat:** Server sends `{ type: 'heartbeat', _seq: N }` every 30s. Client responds with `{ type: 'pong', lastSeq: N }`. If no pong within 60s, server closes the connection (triggers client reconnect).

**Deduplication:** Client-side dedup by `_seq`. If a message arrives with `_seq <= lastSeen`, drop it. This handles the case where replay overlaps with live messages during reconnect.

**Implementation location:** Wrap the existing `broadcastMessage` in `vision-server.js:300` with a new `ReliableBroadcast` class that owns the ring buffer and seq counter. The WebSocket upgrade handler (`vision-server.js:247-278`) gains `lastSeq` query param support.

### Alternatives Considered

1. **Persistent message log (append-only file):** Replay from disk instead of memory. Overkill -- 1000 messages in memory is ~500KB worst case. Disk-based would add latency and complexity.
2. **NATS/MQTT:** External dependency for a problem that affects exactly one WebSocket connection from the browser. Not justified.
3. **SSE with Last-Event-ID:** Agent-server already uses SSE (`agent-server.js:71-88`), but the vision surface uses WebSocket for bidirectional communication. Migrating would break existing UI code.

### Dependencies

- None; this is a standalone transport improvement

---

## Decision 4: Merge Strategy Framework (AGT-8)

### Context

The current merge logic (`build.js:851-967`) uses a single strategy: `git apply --check` then `git apply`. On first conflict, it rolls back ALL patches (`git checkout -- .` + `git clean -fd`), marks the entire batch as `conflict`, and stops. This is the correct conservative behavior but wastes all successful task work on a single conflicting file.

### Approach: Pluggable Strategy Chain with Fallback

Define a `MergeStrategy` interface and three implementations:

```js
// Strategy interface (in new file: lib/merge-strategies.js)
class MergeStrategy {
  /** @returns {{ applied: boolean, files: string[], conflicts: string[] }} */
  async apply(patchContent, cwd, taskId) { throw new Error('abstract'); }
}
```

**Strategy 1: PatchApply (current behavior)**
`git apply --check` then `git apply`. Fast, handles most non-overlapping changes.

**Strategy 2: ThreeWayMerge** (fallback when PatchApply fails)

Uses `git apply --3way` which leverages blob context headers in the diff to attempt a three-way merge when the patch doesn't apply cleanly to the current worktree state.

Key properties:
- Handles cases where the base file has been modified by a prior task's merge
- Requires the original blob SHAs to be present in the object store (always true since diffs were generated from the same repo)
- Stages changes on success (--3way implies --index)

On conflict: the strategy marks the task as conflicted and falls back to FileLevel or manual gate. Index/worktree cleanup semantics are specified in the blueprint — the design constraint is that rollback must not discard previously successful task merges.

Note: The exact rollback and index management sequence depends on whether tasks are merged incrementally (commit between each) or batch-applied (all then commit). This is an implementation choice deferred to the blueprint.

**Strategy 3: FileLevel**
When ThreeWayMerge fails, fall back to file-level resolution: for each file in the patch, if the file was not modified by any previously-applied patch (tracked via `appliedFiles` set at `build.js:884`), apply it directly. For files modified by both patches, invoke a manual resolution gate (policy-evaluator decides: gate, flag, or skip).

**Execution:** Strategies are tried in order (PatchApply -> ThreeWayMerge -> FileLevel). The first success wins. If all fail for a given task's patch, that task is marked `failed` but other tasks' patches continue applying (partial success instead of total rollback).

**Conflict context injection:** When a task fails merge, the conflict details (files, diff hunks) are injected into a retry prompt. The agent reruns with knowledge of what conflicted, targeting a compatible change.

### Alternatives Considered

1. **Always 3-way apply (skip patch-apply):** `--3way` has slightly more overhead than plain `git apply` (blob lookup for context). Patch-apply succeeds 90%+ of the time for disjoint file sets, so it is worth trying first.
2. **User-interactive merge tool (vimdiff, etc.):** Blocks automation. The manual resolution gate (policy-evaluated) is the automation-compatible equivalent.
3. **Semantic merge (AST-aware):** Language-specific, massive complexity. Defer to a future item if patch + 3-way proves insufficient.

### Dependencies

- AGT-9 (retry) provides the retry-with-context mechanism for failed merges
- AGT-12 (pre-flight) catches `files_owned` overlaps before dispatch, reducing conflicts at the source

---

## Decision 5: Graceful Degradation (AGT-9)

### Context

Today, failures in the parallel dispatch loop are terminal per-task: a spawn failure, git timeout, or worktree creation error marks the task `failed` and the result propagates to `stratum_parallel_done`. There is no retry logic. The `HealthMonitor` kills silent agents but does not trigger retry. For transient errors (network blip on SDK, git lock contention), immediate failure wastes a valid task slot.

### Approach: Categorized Retry with Exponential Backoff

Add a `RetryPolicy` to the parallel dispatch runner:

```js
const RETRY_POLICY = {
  transient: { maxRetries: 3, baseDelayMs: 1000, backoffFactor: 2 },
  merge:     { maxRetries: 1, baseDelayMs: 0,    backoffFactor: 1 },  // single retry with conflict context
  permanent: { maxRetries: 0 },
};
```

**Error categorization:** Classify errors from `runAndNormalize` and git operations:
- **Transient:** `ECONNRESET`, `ETIMEDOUT`, git lock errors (`Unable to create '*.lock'`), `AgentTimeoutError` (from `result-normalizer.js:129`)
- **Merge:** Merge conflict errors (from Decision 4)
- **Permanent:** Everything else (bad prompt, missing file, permission denied)

**Worktree fallback:** If worktree creation fails (`git worktree add` at `build.js:741`), fall back to shared-cwd mode for that specific task with a stream warning. The task loses isolation but can still execute. The merge step skips diff collection for shared-cwd tasks.

**Partial success reporting:** `stratum_parallel_done` already accepts per-task status (`build.js:849-857`). Enhance with a new `partialMerge` status alongside `clean` and `conflict`:
- `clean` -- all tasks complete, all patches applied
- `partialMerge` -- some tasks failed or some patches conflicted, but at least one task's changes are applied
- `conflict` -- total failure, nothing applied (rollback)

### Alternatives Considered

1. **Unlimited retries with circuit breaker:** Risk of burning API credits on a fundamentally broken task. Cap at 3 with clear categorization.
2. **Retry at the Stratum level (re-dispatch entire parallel batch):** Too coarse. Per-task retry preserves completed work.

### Dependencies

- AGT-8 (merge strategies) provides the merge retry path
- AGT-11 (observability) records retry counts and failure categories

---

## Decision 6: Registry Query Engine (AGT-10)

### Context

`AgentRegistry` (`agent-registry.js:12-95`) stores agent records in a `Map<string, Record>` backed by `agents.json`. The query API is minimal: `getAll()`, `get(id)`, `getChildren(parentId)`, `getRunning()`. There is no filtering by type, time range, or status. The `prune(50)` call hard-caps history at 50 entries.

### Approach: Query Builder on Indexed In-Memory Store

Extend `AgentRegistry` with a query method:

```js
query({ status, type, since, until, parentId, ancestry, limit, offset, sort }) {
  // Filter chain on the in-memory Map
  // 'ancestry' traverses parent chains: ancestry='root' returns all descendants
  // 'since'/'until' filter on startedAt ISO timestamps
  // Returns { agents: Record[], total: number, hasMore: boolean }
}
```

**REST endpoint:** `GET /api/agents?status=running&type=codex&since=1h&limit=20&offset=0`

**Indexed history:** Replace the flat 50-entry cap with a two-tier store:
- **Hot tier:** In-memory Map, all agents from current server lifecycle (unlimited)
- **Cold tier:** `agents-archive.json`, appended on prune. Queried on demand with file scan + JSON parse (lazy, cached for 30s)

Prune moves completed agents older than 1 hour from hot to cold. The cold tier has no cap -- it grows with project history. Archive rotation (compress/delete files older than 30 days) is a future concern.

### Alternatives Considered

1. **SQLite:** Proper indexed queries, but adds a native dependency. The query volumes here (tens to hundreds of records) don't justify it.
2. **Keep flat file, increase cap to 500:** Scales the problem, doesn't solve it. Query filtering on a flat array is O(n) but n=500 is fine; the issue is the cap silently dropping history.

### Dependencies

- AGT-17 (state persistence) provides the transactional state machine that feeds the registry
- AGT-11 (observability) consumes registry queries for metrics aggregation

---

## Decision 7: Observability & Correlation (AGT-11)

### Context

There are no correlation IDs linking a parent session to its spawned agents and their parallel tasks. The `agentRelay` broadcast (`agent-spawn.js:86-93`) carries `fromAgentId`/`toAgentId` but this is UI-only display data, not a queryable trace. There are no metrics: no duration tracking, no success rate, no merge conflict rate.

### Approach: Trace Context + Metrics Collector

**Trace context:** Inject a `traceId` (ULID) at the top of each build invocation (`build.js` entry point). Propagate it through:
- Agent spawn: `registry.register()` gains a `traceId` field
- Parallel dispatch: each task inherits the parent's `traceId`
- Blackboard events: include `traceId`
- Merge operations: include `traceId` in stream events

All existing `broadcastMessage` calls gain the `traceId` field. UI can filter timeline by trace.

**Metrics collector:** New class `AgentMetrics` (in `server/agent-metrics.js`):

```js
class AgentMetrics {
  record(agentId, event) { ... }  // event: spawn, complete, fail, retry, merge_conflict, timeout

  getAgentStats(agentId) { ... }  // { duration, retries, status }
  getAggregates(since) { ... }    // { spawnRate, successRate, avgDuration, mergeConflictRate }
  getTraceTimeline(traceId) { ... }  // ordered events for a trace
}
```

Storage: In-memory ring buffer (last 10,000 events) with periodic flush to `data/agent-metrics.jsonl`. Dashboard endpoint: `GET /api/agents/metrics?since=1h`.

### Alternatives Considered

1. **OpenTelemetry:** Industry standard but massive dependency for a local dev tool. If Compose ever needs distributed tracing, OTel can wrap this lightweight collector later.
2. **Log parsing:** Fragile, unstructured, no aggregation. Structured events are strictly better.

### Dependencies

- AGT-10 (registry queries) provides the agent records that metrics annotate
- AGT-17 (state persistence) ensures agent records survive restarts for correlation

---

## Decision 8: Pre-Flight Validation (AGT-12)

### Context

The current parallel dispatch (`build.js:676`) validates almost nothing before dispatch. Cycle detection happens inside `topoVisit` (`build.js:858-871`) at merge time, which is too late -- tasks have already run. `depends_on` references are not checked for existence. `files_owned` isolation is not verified -- two tasks claiming the same file will silently conflict at merge.

### Approach: Validate-Before-Dispatch Gate

New function `validateParallelBatch(tasks)` called before the `Promise.allSettled` fan-out at `build.js:732`:

```js
function validateParallelBatch(tasks) {
  const errors = [];

  // 1. Check depends_on references exist
  const taskIds = new Set(tasks.map(t => t.id));
  for (const task of tasks) {
    for (const dep of (task.depends_on ?? [])) {
      if (!taskIds.has(dep)) errors.push(`${task.id}: depends_on '${dep}' not found`);
    }
  }

  // 2. Detect cycles (Kahn's algorithm, reuse from build-dag.js:73-110)
  // Convert tasks to DagNode[] format and call topoSort()

  // 3. Check files_owned isolation
  const fileOwners = new Map();  // file -> taskId
  for (const task of tasks) {
    for (const file of (task.files_owned ?? [])) {
      if (fileOwners.has(file)) {
        errors.push(`${task.id}: files_owned '${file}' also claimed by ${fileOwners.get(file)}`);
      }
      fileOwners.set(file, task.id);
    }
  }

  // 4. Check files_owned vs files_read overlap (write-read conflict warning)
  // This is a warning, not an error -- depends_on should order them

  return { valid: errors.length === 0, errors, warnings };
}
```

**Behavior on failure:** If `valid === false`, emit a `build_error` stream event with all errors and skip the dispatch. Stratum receives a `parallel_done` with all tasks failed and a `validation_error` merge status.

### Alternatives Considered

1. **Validate at Stratum spec compile time:** Stratum specs use templates with `{task.*}` placeholders that aren't resolved until dispatch. Runtime validation is necessary.
2. **Validate only files_owned, not depends_on:** Incomplete. A broken `depends_on` reference causes a silent wait timeout in the blackboard (from Decision 2). Catching it early is cheap.

### Dependencies

- Reuses `topoSort` from `build-dag.js:73-110` for cycle detection

---

## Decision 9: Agent Template Library (AGT-13-14)

### Context

Agent type derivation is a keyword heuristic (`agent-spawn.js:26-35`): if the prompt contains "explore", the agent is `compose-explorer`. The `agent_run` tool (`compose-mcp-tools.js:432`) accepts `type: 'claude' | 'codex'` with no further specialization. There is no mechanism to restrict tools, inject system prompts, or declare expected output schemas per agent type.

### Approach: Template Registry with Capability Declarations

New file `server/agent-templates.js` exporting a registry of agent templates:

```js
const TEMPLATES = {
  'code-reviewer': {
    displayName: 'Code Reviewer',
    systemPrompt: 'You are a code reviewer. Focus on correctness, security, and style...',
    tools: ['Read', 'Grep', 'Glob'],  // restricted tool set
    writeAccess: false,
    outputSchema: { clean: 'boolean', findings: 'array', summary: 'string' },
    timeout: 300_000,  // 5 min
  },
  'test-runner': {
    displayName: 'Test Runner',
    systemPrompt: 'You are a test executor. Run the specified test suite and report results...',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    writeAccess: false,  // reads and executes, does not write
    outputSchema: { passed: 'boolean', failCount: 'integer', failures: 'array', summary: 'string' },
    timeout: 600_000,  // 10 min
  },
  'docs-generator': {
    displayName: 'Documentation Generator',
    systemPrompt: 'You are a documentation writer. Generate or update documentation...',
    tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'],
    writeAccess: true,
    outputSchema: { filesWritten: 'array', summary: 'string' },
    timeout: 300_000,
  },
  'security-auditor': {
    displayName: 'Security Auditor',
    systemPrompt: 'You are a security auditor. Scan for vulnerabilities, secrets, and misconfigurations...',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    writeAccess: false,
    outputSchema: { severity: 'string', findings: 'array', clean: 'boolean' },
    timeout: 300_000,
  },
  'refactorer': {
    displayName: 'Refactorer',
    systemPrompt: 'You are a code refactoring specialist. Apply the requested refactoring...',
    tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'],
    writeAccess: true,
    outputSchema: { filesChanged: 'array', summary: 'string' },
    timeout: 600_000,
  },
};
```

**Capability validation (AGT-14):** Before dispatch, the parent checks that the selected template's capabilities match the task requirements:

```js
function validateCapabilityMatch(template, task) {
  // Task requires write access but template is read-only?
  if (task.files_owned?.length > 0 && !template.writeAccess) {
    return { valid: false, reason: `Template '${template.displayName}' is read-only but task owns files` };
  }
  // Task requires Bash but template doesn't allow it?
  // ... similar checks for tool requirements
}
```

**Tool restriction:** The `ClaudeSDKConnector` currently passes `tools: { type: 'preset', preset: 'claude_code' }` (`claude-sdk-connector.js:46`). The SDK supports tool filtering via `allowedTools`. Templates that restrict tools pass their `tools` array to the connector, which maps it to the SDK's allowed-tools format.

**Integration with `agent_run`:** Extend `toolAgentRun` (`compose-mcp-tools.js:432`) to accept `template` as an alternative to `type`:

```js
agent_run({ template: 'code-reviewer', prompt: '...', ... })
```

The template's system prompt is prepended to the user prompt, tool restrictions are applied, and the output schema is injected.

### Alternatives Considered

1. **Dynamic template generation from prompt analysis:** Too unpredictable. Explicit templates give the user control over what the agent can do.
2. **Per-project template overrides (YAML config):** Good future extension. Start with hardcoded defaults, add `compose.templates.yaml` override path later.
3. **Separate process per template (different binaries):** Unnecessary complexity. The connector abstraction already handles model/tool variation.

### Dependencies

- AGT-5 (RPC) allows the parent to query template capabilities at runtime
- AGT-12 (pre-flight) uses capability validation to reject mismatched dispatches

---

## Decision 10: Parent Orchestration Skills (AGT-15-16)

### Context

Today, the root agent (Claude Code with Compose MCP) manages subagents through raw `agent_run` calls and manual coordination. There is no structured "fleet management" capability. The `agent_run` tool (`compose-mcp-tools.js:432`) spawns a single agent synchronously and returns its text output. Parallel dispatch is only available through `compose build` (Stratum workflow), not interactively.

### Approach: Two MCP Skills

**Skill 1: `compose:manage-agents` (AGT-15)**

**Scope limitation:** `manage_agents` manages **spawned CLI agents only** -- via `agent-spawn.js`'s `_agents` map and the `AgentRegistry`. SDK session management stays on `agent-server.js` existing endpoints (`POST /api/agent/query`, `POST /api/agent/interrupt`, `POST /api/agent/message`). A multi-session SDK controller that unifies both tiers under one tool is deferred (see Open Questions).

A composite MCP tool that exposes fleet management operations for spawned agents:

```js
{
  name: 'manage_agents',
  description: 'Manage spawned CLI agents: spawn from templates, check health, interrupt, list, and collect results.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { enum: ['spawn', 'status', 'interrupt', 'list', 'metrics'] },
      // spawn: { template, prompt, cwd }
      // status: { agentId }
      // interrupt: { agentId }
      // list: { status, type, limit }
      // metrics: { since }
    }
  }
}
```

This is a single tool with an `action` discriminator rather than 5 separate tools, to stay within the MCP tool token budget (~2000 tokens as documented in `compose-mcp.js:21`).

> **Note:** The `message` action is omitted because RPC is scoped to SDK sessions (Decision 1), which have their own `POST /api/agent/message` endpoint. Spawned CLI agents are fire-and-forget and cannot receive messages.

**Skill 2: `compose:parallel-dispatch` (AGT-16)**

Wraps the parallel dispatch logic from `build.js:676-986` into an interactive MCP tool:

```js
{
  name: 'parallel_dispatch',
  description: 'Dispatch multiple tasks in parallel with worktree isolation, dependency ordering, and merge.',
  inputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            description: { type: 'string' },
            template: { type: 'string' },  // from agent template library
            files_owned: { type: 'array', items: { type: 'string' } },
            files_read: { type: 'array', items: { type: 'string' } },
            depends_on: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'description']
        }
      },
      maxConcurrent: { type: 'number', default: 3 },
      mergeStrategy: { enum: ['patch', 'three-way', 'file-level', 'auto'], default: 'auto' },
    },
    required: ['tasks']
  }
}
```

**Key difference from `build.js` parallel dispatch:** This skill is invoked interactively by the root agent, not by the Stratum workflow engine. It does not call `stratum_parallel_done`. Instead, it returns a structured result:

```json
{
  "status": "clean" | "partialMerge" | "conflict",
  "tasks": [{ "id": "...", "status": "complete", "result": {...} }, ...],
  "mergeReport": { "applied": [...], "conflicted": [...], "skipped": [...] }
}
```

**Shared implementation:** Extract the parallel dispatch logic from `build.js:676-986` into a new `lib/parallel-runner.js` module. Both the Stratum build loop and the MCP skill call into this shared module. This eliminates code duplication and ensures both paths benefit from merge strategy improvements (AGT-8) and retry logic (AGT-9).

### Alternatives Considered

1. **Separate tools for each operation (6 tools for manage-agents):** Exceeds the MCP tool token budget. The `action` discriminator pattern is used successfully by other MCP servers.
2. **Reuse `agent_run` with a `parallel: true` flag:** Overloads a simple tool with complex semantics. A dedicated tool with proper task schema is clearer.
3. **Skill files (`.compose/skills/*.yaml`):** Future extension for user-defined orchestration patterns. Start with hardcoded tools.

### Dependencies

- AGT-8 (merge strategies) for the `mergeStrategy` parameter
- AGT-9 (retry) for transient failure handling in parallel dispatch
- AGT-12 (pre-flight) for task validation before dispatch
- AGT-13-14 (templates) for the `template` field in task specs

---

## Decision 11: Agent State Machine (AGT-17)

### Context

Agent lifecycle is tracked informally. `agent-spawn.js` creates records with `status: 'running'` on spawn and sets `'complete' | 'failed'` on close. `agent-registry.js:62` adds `updateStatus` for the health monitor's `'killed'` state. But transitions are not validated -- any code can set any status at any time. The `prune(50)` cap discards history.

### Approach: Transactional State Machine

Define valid states and transitions:

```
                 +---------+
                 | spawned |
                 +----+----+
                      |
                 +----v----+
            +--->| running |<---+
            |    +----+----+    |
            |         |         |
        (retry)  +----+----+   (resume from
            |    |         |    stored)
            |    v         v    |
        +---+----+   +----+----+
        | failed  |   |  done   |
        +---+-----+   +----+----+
            |              |
            v              v
        +--------+    +--------+
        | stored |    | stored |
        +--------+    +--------+
```

Valid transitions:
- `spawned -> running` (process started, first stdout/activity detected)
- `running -> done` (exit code 0)
- `running -> failed` (exit code != 0, timeout, memory exceeded, manual kill)
- `running -> running` (no-op, activity heartbeat)
- `failed -> running` (retry)
- `done -> stored` (result persisted to archive)
- `failed -> stored` (failure recorded to archive)
- `stored -> running` (resume from persisted state -- SDK sessions only)

**Implementation:** Add a `transition(agentId, toState, metadata)` method to `AgentRegistry` that validates the transition against the allowed edges. Invalid transitions throw with a diagnostic message. This replaces the free-form `updateStatus` method.

**Long-term persistence:** The two-tier store from Decision 6 serves as the persistence layer. State transitions are logged as events in `agent-metrics.jsonl` (Decision 7) for audit trail.

**Session indexing:** Each agent record gains a `sessionId` field linking it to the Compose session (`session-store.js`) that spawned it. The cold-tier archive is indexed by session ID for efficient correlation queries.

### Alternatives Considered

1. **XState/statechart library:** Full-featured but heavy dependency for 6 states and 8 transitions. A simple lookup table is sufficient.
2. **Status as an enum with no transition validation:** Current approach. Leads to inconsistent states when multiple callers update simultaneously. Explicit transitions prevent this.

### Dependencies

- AGT-10 (registry queries) builds on the two-tier store introduced here
- AGT-11 (observability) records state transition events

---

## Approach Summary

| Item | Approach | Key Files |
|------|----------|-----------|
| AGT-5 | SDK-session RPC via existing `POST /api/agent/message`; CLI agents use output schema injection (unidirectional) | `server/agent-server.js` (existing), `server/agent-spawn.js` (existing) |
| AGT-6 | Orchestrator-side blackboard JSON + completion barriers; context injection into dependent task prompts | `lib/blackboard.js` (new), `lib/parallel-runner.js` (new) |
| AGT-7 | Monotonic `_seq` on all broadcasts, 1000-message ring buffer, 30s heartbeat | `server/reliable-broadcast.js` (new), `server/vision-server.js` (existing) |
| AGT-8 | PatchApply -> ThreeWayMerge -> FileLevel strategy chain; partial success | `lib/merge-strategies.js` (new), `lib/build.js` (existing) |
| AGT-9 | Categorized retry (transient/merge/permanent); worktree fallback; exponential backoff | `lib/retry-policy.js` (new), `lib/build.js` (existing) |
| AGT-10 | Query builder on in-memory Map + cold-tier archive; REST query params | `server/agent-registry.js` (existing), `server/agent-spawn.js` (existing) |
| AGT-11 | TraceId propagation + AgentMetrics collector; ring buffer + JSONL flush | `server/agent-metrics.js` (new), `server/agent-registry.js` (existing) |
| AGT-12 | `validateParallelBatch()` before dispatch; reuses `topoSort` from `build-dag.js` | `lib/parallel-validator.js` (new), `lib/build.js` (existing) |
| AGT-13-14 | Template registry with capability declarations; tool restriction via SDK allowedTools | `server/agent-templates.js` (new), `server/compose-mcp-tools.js` (existing) |
| AGT-15-16 | Two MCP tools: `manage_agents` (fleet ops) + `parallel_dispatch` (interactive parallel) | `server/compose-mcp.js` (existing), `lib/parallel-runner.js` (new) |
| AGT-17 | Transactional state machine with validated transitions; two-tier archive | `server/agent-registry.js` (existing) |

## Files

| File | Action | Purpose |
|------|--------|---------|
| `server/agent-server.js` | existing | RPC channel for SDK sessions via existing message endpoint (AGT-5) |
| `lib/blackboard.js` | new | Shared key-value store for inter-task coordination (AGT-6) |
| `server/reliable-broadcast.js` | new | Ring buffer, seq numbers, heartbeat, replay on reconnect (AGT-7) |
| `lib/merge-strategies.js` | new | PatchApply, ThreeWayMerge, FileLevel strategy implementations (AGT-8) |
| `lib/retry-policy.js` | new | Error categorization and exponential backoff policy (AGT-9) |
| `lib/parallel-validator.js` | new | Pre-flight validation: DAG check, files_owned isolation (AGT-12) |
| `server/agent-metrics.js` | new | TraceId propagation, per-agent metrics, aggregate dashboard (AGT-11) |
| `server/agent-templates.js` | new | Agent template registry with capability declarations (AGT-13-14) |
| `lib/parallel-runner.js` | new | Extracted parallel dispatch logic shared by build.js and MCP skill (AGT-15-16) |
| `server/agent-registry.js` | existing | Add query(), transition(), two-tier archive, session indexing (AGT-10, 17) |
| `server/agent-spawn.js` | existing | Integrate traceId propagation, template dispatch (AGT-11, 13) |
| `server/vision-server.js` | existing | Wrap broadcastMessage with ReliableBroadcast, add heartbeat (AGT-7) |
| `lib/build.js` | existing | Replace inline merge/dispatch with parallel-runner.js calls (AGT-8, 9, 12, 15-16) |
| `server/compose-mcp.js` | existing | Register manage_agents and parallel_dispatch tools (AGT-15-16) |
| `server/compose-mcp-tools.js` | existing | Extend toolAgentRun with template support (AGT-13) |
| `server/connectors/claude-sdk-connector.js` | existing | Add allowedTools support for template tool restrictions (AGT-14) |
| `server/agent-health.js` | existing | Existing liveness monitoring infrastructure (AGT-2, used by AGT-5 for SDK session health) |
| `lib/build-dag.js` | existing | Export topoSort for reuse in parallel-validator.js (AGT-12) |

## Open Questions

### Blocking (must resolve before blueprint)

1. **SDK `allowedTools` support:** The Claude Agent SDK docs mention tool filtering but the exact API surface needs verification before blueprint. If the SDK does not support per-query tool restriction, AGT-14 tool restrictions are advisory only (enforced by system prompt, not infrastructure). Must verify with SDK docs or experimentation before committing to the template tool restriction design.

2. **Multi-session SDK controller:** `manage_agents` (AGT-15) manages spawned CLI agents only. SDK sessions are managed by `agent-server.js` separately. A unified controller that manages both tiers from one tool requires a session registry in `agent-server.js` (currently tracks only a single `_session`). This is a dependency for any future unification -- scoped out of AGT-15 but flagged as a gap.

### Non-blocking (can defer to blueprint or implementation)

3. **Ring buffer size (1000 messages):** Chosen to cover a typical reconnection gap (30-60s at ~10 msg/s). Should this be configurable via settings?

4. **Template extensibility timeline:** Users will want custom templates. When should we add `compose.templates.yaml` override support -- as part of this phase or deferred?

5. **Cold-tier archive rotation:** The design punts on archive rotation (compress/delete old entries). At what project age does this become a real concern? Should we add a `maxArchiveAge` setting now?

6. **Blackboard contention:** Advisory file locks work on macOS/Linux but have known issues on NFS. Since Compose is single-machine, this is unlikely to be a problem -- but should we document it as a known limitation?
