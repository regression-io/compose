# Agent Lifecycle Control: Design

**Status:** DESIGN
**Date:** 2026-03-28
**Feature Code:** COMP-AGT (items AGT-1 through AGT-4)

## Related Documents

- [ROADMAP.md](../../ROADMAP.md) -- COMP-AGT-1 through COMP-AGT-4
- [compose/server/agent-spawn.js](../../../compose/server/agent-spawn.js) -- spawn/poll routes
- [compose/server/agent-registry.js](../../../compose/server/agent-registry.js) -- persistent agent tracker
- [compose/server/agent-server.js](../../../compose/server/agent-server.js) -- SDK session interrupt
- [compose/server/build-stream-bridge.js](../../../compose/server/build-stream-bridge.js) -- crash detection
- [compose/lib/build.js](../../../compose/lib/build.js) -- build orchestrator, worktrees, timeouts
- [compose/lib/result-normalizer.js](../../../compose/lib/result-normalizer.js) -- per-step timeout enforcement

---

## Problem

Compose spawns agents through four distinct mechanisms -- SDK query iterators, CLI subprocesses via `agent-spawn.js`, OpenCode connector processes, and parallel build tasks -- each with its own ad-hoc interrupt, timeout, and cleanup logic. There is no unified way to stop a runaway agent, detect a silently-hung agent, enforce resource limits, or clean up orphaned worktrees after a crash. The result is that stuck agents waste tokens and compute, orphan worktrees accumulate disk space, and the user has no single surface to kill or inspect agent health.

## Goal

**In scope:**
- Stop endpoint for spawned CLI agents and SDK sessions (AGT-1)
- Liveness monitoring with configurable silence thresholds (AGT-2)
- Per-agent resource limits: wall-clock, memory RSS, disk quota (AGT-3)
- Automated and manual worktree garbage collection (AGT-4)

**Not in scope:**
- Inter-agent RPC or structured messaging (COMP-AGT-5/6/7 -- Phase 2)
- Merge conflict recovery (COMP-AGT-8/9 -- Phase 3)
- Agent templates or capability registry (COMP-AGT-13/14 -- Phase 5)
- Changes to the Stratum execution model

---

## Decision 1: Unified Interrupt API

### Current state

Four independent interrupt paths exist:

1. **SDK session** (`agent-server.js:135-145`): `POST /api/agent/interrupt` calls `_session.queryIter.interrupt()`. Only works for the single active SDK query; no agent ID routing.
2. **OpenCode connector** (`opencode-connector.js:144-148`): `this.#proc.kill('SIGTERM')` then nulls the reference. No grace period, no SIGKILL fallback.
3. **Build abort** (`build.js:1485-1536`): `compose build --abort` deletes Stratum flow state and marks the build as killed. Does not terminate running agents.
4. **Supervisor shutdown** (`supervisor.js:185-194`): Forwards SIGINT/SIGTERM to all managed children, then exits after 2s. Not callable from the API.

None of these paths provide: agent-ID-targeted stop, graceful shutdown with escalation, or UI-driven cancellation.

### Scope

AGT-1 covers spawned CLI agents (via `agent-spawn.js`) and SDK sessions (via `agent-server.js`) only. These are the two agent types with process handles or iterator references accessible from the Compose server.

> **Future unification:** The OpenCode connector interrupt (`opencode-connector.js:144`) and build abort (`build.js:1485`) remain separate paths for now. COMP-AGT-5 (parent-child RPC) will introduce a shared stop registry that subsumes all four paths under one dispatch table.

### Approach

**Cross-process boundary:** Spawned CLI agents and SDK sessions live in different server processes with different stop mechanisms. The new `POST /api/agent/:id/stop` route in `agent-spawn.js` handles spawned agents ONLY -- it cannot reach SDK sessions because those are managed by a separate process (`agent-server.js`). The two paths are:

**Path A -- Spawned CLI agents** (managed by `agent-spawn.js`, vision-server process):

The stop endpoint resolves the agent through the in-memory `_agents` map (which already stores `agent.process`), then executes a three-phase shutdown:

1. **SIGTERM** the child process (`proc.kill('SIGTERM')`)
2. **Grace period** (configurable, default 5s) -- allow the agent to flush output and exit
3. **Direct-child termination** if the process is still alive after the grace period -- kill the direct child with `proc.kill('SIGKILL')`. Spawned agents are not detached process groups, so this kills the direct child only. Grandchild cleanup is best-effort -- the OS may or may not deliver SIGHUP to non-session-leader descendants, so grandchildren are not guaranteed to terminate. If reliable descendant cleanup is needed in the future, spawn with `detached: true` and use `process.kill(-pid, signal)` to signal the entire process group (deferred to future work).

**Path B -- SDK sessions** (managed by `agent-server.js`, agent-server process):

Stopped via the EXISTING `POST /api/agent/interrupt` endpoint (`agent-server.js:135`). AGT-1 adds a kill timer escalation to that existing endpoint: after `queryIter.interrupt()`, a grace-period timer fires `_killCurrentSession()` if the iterator hasn't resolved. The new stop endpoint in `agent-spawn.js` does NOT attempt to call `queryIter.interrupt()` across processes.

**Proxy rule:** If the stop endpoint receives a request for the SDK session (e.g., `id === 'current-session'`), it proxies to `agent-server`'s interrupt endpoint rather than attempting a direct process kill.

The existing `POST /api/agent/interrupt` endpoint is preserved for backward compatibility. It remains the canonical entry point for SDK session interruption.

**Agent handle storage:** The `_agents` map in `agent-spawn.js:37` already stores `agent.process` (the ChildProcess). The registry (`agent-registry.js:22-36`) stores `pid` but not the process handle. We store the ChildProcess reference in `_agents` (in-memory, not serialized) and use `pid` from the registry as fallback for orphan cleanup via `process.kill(pid, 0)` liveness check.

### Alternatives considered

- **Single global interrupt (status quo):** Simple but cannot target individual agents. Rejected because parallel dispatch means multiple agents run simultaneously.
- **PID-only kill (no graceful shutdown):** Faster but loses agent output. Agents should have the chance to write partial results before death.
- **Agent-side cooperative shutdown via stdin message:** Requires agents to implement a shutdown protocol. Too fragile -- agents may be stuck in a tool call that ignores stdin.

---

## Decision 2: Health Monitoring Model

### Current state

- `build-stream-bridge.js:377-394`: A 5-minute inactivity timer fires `build_crash` when no build events arrive. Only applies to the build event stream, not individual agents.
- `agent-spawn.js:102-123`: `proc.on('close')` detects process exit but not silent hangs.
- `AgentLogViewer.jsx:49`: Polls agent output every 2s. No "went silent" indicator.

### Approach

Implement a `HealthMonitor` class (new file: `server/agent-health.js`) that attaches to each spawned agent and tracks stdout and stderr activity:

- **Liveness probe:** On each stdout or stderr `data` event, reset a per-agent activity timer. Any process output counts as activity -- agents often emit progress on stderr (e.g., tool invocation logs, warnings), so monitoring stdout alone would produce false-positive silence warnings.
- **Warning threshold** (configurable, default 60s): If no output on either stream for 60s, broadcast an `agentSilent` WebSocket event. The UI shows a yellow warning badge on the agent's tab in AgentPanel.
- **Kill threshold** (configurable, default 5min): If no output on either stream for 5min, trigger the unified stop endpoint (Decision 1). Broadcast `agentKilled` with reason `'silence_timeout'`.
- **Heartbeat extension:** Agents that legitimately go quiet (e.g., waiting for a gate) can suppress the kill timer by writing a synthetic heartbeat to stdout. The build orchestrator already writes `build_step_start`/`build_step_end` events; these count as activity.

**Terminal reason tracking:** When HealthMonitor or a manual stop triggers a kill, set `agent.terminalReason` BEFORE the process exits. Valid values: `manual_stop`, `silence_timeout`, `wall_clock_timeout`, `memory_exceeded`, `normal`. The `terminalReason` is included in the `agentComplete` broadcast payload, persisted in `agent-registry.js` alongside `exitCode`, and preserved on the spawned agent state in `visionMessageHandler.js` so the UI can display why an agent stopped.

**Terminal state precedence rule:** `agentKilled` is a terminal state -- `agentComplete` cannot downgrade it. When `terminalReason` is set (any value other than `normal`), the close handler in `agent-spawn.js` PRESERVES that reason and sets `status: 'killed'` in the `agentComplete` payload, regardless of exit code. In `visionMessageHandler.js`, the `agentComplete` handler checks: if the agent already has `status: 'killed'` from a prior `agentKilled` message, it preserves that status and does not overwrite with the exit-code-derived status. This prevents the race where HealthMonitor broadcasts `agentKilled`, the process exits, and the close handler's `agentComplete` broadcast overwrites the UI state.

The HealthMonitor subscribes to the same `_agents` map used by `agent-spawn.js`. When a new agent is spawned, `agent-spawn.js` calls `healthMonitor.track(agentId, proc)`. When the agent exits, the monitor is automatically cleaned up via the `close` event.

Configuration lives in `.compose/compose.json` under a new `agentHealth` key:

```json
{
  "agentHealth": {
    "silenceWarningMs": 60000,
    "silenceKillMs": 300000,
    "enabled": true
  }
}
```

### Alternatives considered

- **Extend build-stream-bridge's crash timer to all agents:** The bridge operates on structured build events, not raw stdout. Spawned agents emit raw text. Mixing the two would complicate the bridge's event model.
- **Process-level health (CPU/memory polling):** More robust but higher overhead. Deferred to AGT-3 for resource limits; liveness monitoring should be lightweight.
- **Agent-side health reporting via API callback:** Requires cooperation from the agent process. Claude CLI doesn't support custom health endpoints. Rejected.

---

## Decision 3: Resource Limit Enforcement

### Current state

- **Per-step timeouts** (`build.js:40-57`): Phase-specific timeouts (5-45 min) enforced via `setTimeout` + `connector.interrupt()` in `result-normalizer.js:156-164`. Only applies to build-orchestrated steps, not ad-hoc spawned agents.
- **Concurrent task limit** (`build.js:682-691`): Semaphore with `maxConcurrent` (default 3). Controls parallelism but not per-task resources.
- **No memory or disk limits** anywhere in the codebase.

### Approach

Three resource dimensions, enforced in `agent-spawn.js` and the parallel dispatch path in `build.js`:

**Wall-clock timeout:**
- Spawned agents (via `agent-spawn.js`): Default 10 minutes. Configurable per-spawn via `POST /api/agent/spawn` body `{ timeout: <ms> }`. Enforced by the HealthMonitor kill timer (reused from Decision 2, with a separate `maxDurationMs` timer that fires regardless of stdout activity).
- Build-orchestrated agents: Continue using existing `STEP_TIMEOUT_MS` map in `build.js:42-56`. No change needed.

**Memory RSS check:**
- Periodic check (every 30s) of child process memory via `/proc/<pid>/status` on Linux or `ps -o rss= -p <pid>` on macOS.
- Configurable limit, default 512MB. When exceeded, log a warning and trigger the unified stop endpoint.
- Implementation in `agent-health.js` alongside the liveness probe, since both are periodic per-agent checks.

**Disk quota per worktree:**
- Before merging a worktree's diff back into the main tree (`build.js:770-787`), check disk usage of the worktree directory via `du -sk <path>`.
- Configurable limit, default 100MB. If exceeded, skip the merge and report a `disk_quota_exceeded` error for that task.
- This is a check-before-merge, not continuous monitoring -- continuous `du` on active worktrees would be too expensive.

Configuration in `.compose/compose.json`:

```json
{
  "agentLimits": {
    "spawnTimeoutMs": 600000,
    "maxMemoryMb": 512,
    "maxWorktreeDiskMb": 100
  }
}
```

### Alternatives considered

- **cgroups / ulimit enforcement:** More robust but requires root or special permissions. Compose runs as a regular user process. Rejected for V1.
- **Continuous disk monitoring:** Polling `du` every 30s on active worktrees is expensive for large repos. Check-at-merge is sufficient to prevent merging bloated output.
- **Token-count limits:** Would require intercepting the agent's API calls or parsing structured output. Out of scope -- this belongs in the connector layer, not lifecycle control.

---

## Decision 4: Worktree GC Strategy

### Current state

- **Per-task cleanup** (`build.js:779-784`): `git worktree remove <path> --force` in a `finally` block after each parallel task. Works when the process exits normally.
- **Bulk cleanup** (`build.js:927`): `rm -rf .compose/par/` after all tasks settle. Works when the build completes.
- **No cleanup** when the process crashes, the machine reboots, or the user kills the terminal. Orphan worktrees accumulate.

### Approach

New file: `server/worktree-gc.js` with a `WorktreeGC` class.

**Worktree ownership registry:** When `build.js` creates a worktree at `.compose/par/{taskId}`, it also writes a `.owner` file inside the worktree directory containing `{ pid, taskId, createdAt, buildFlowId }`. This makes ownership self-describing -- GC can determine ownership without cross-referencing the agent registry.

**Scan strategy:**
1. List all directories in `.compose/par/` (the known worktree root).
2. For each directory, read the `.owner` file. If `.owner` exists and its `pid` is still alive (`process.kill(pid, 0)` succeeds), skip -- the owning process is still running.
3. If `.owner` is missing OR the `pid` is dead AND the directory is older than the age threshold (default 1h), it is an orphan.

**GC triggers:**
- **Server start:** Run a full scan when `server/vision-server.js` initializes. This catches crash leftovers.
- **Periodic:** Every 15 minutes (configurable), scan for orphans. Uses `setInterval` with `.unref()` so it doesn't prevent process exit.
- **Manual:** `POST /api/agent/gc` endpoint. Returns `{ removed: [<paths>], errors: [<paths>] }`.
- **Post-build:** After `build.js` parallel dispatch settles, trigger a targeted scan (already partially done by the `rm -rf` in `build.js:927`, but the GC handles partial failures).

**Cleanup procedure:**
1. `git worktree remove <path> --force` (respects git's worktree bookkeeping).
2. If that fails (e.g., worktree not registered with git), fall back to `rm -rf <path>`.
3. After removing directories, run `git worktree prune` to clean git's internal worktree list.

**Safety:**
- Never remove a directory that has a running agent (checked via PID liveness: `process.kill(pid, 0)`).
- Never remove directories outside `.compose/par/`.
- Log all removals to stdout with `[worktree-gc]` prefix.

Configuration in `.compose/compose.json`:

```json
{
  "worktreeGc": {
    "maxAgeMs": 3600000,
    "intervalMs": 900000,
    "enabled": true
  }
}
```

### Alternatives considered

- **Rely on git worktree prune alone:** `git worktree prune` only removes worktree bookkeeping entries for directories that no longer exist. It doesn't delete the directories themselves. We need directory removal first.
- **Timestamp file inside each worktree:** More precise age tracking, but adds complexity. `stat` on the directory is sufficient.
- **Aggressive cleanup (remove immediately on agent exit):** Already done in the `finally` block. GC is the safety net for when the `finally` block doesn't run.

---

## Approach Summary

| Item | What | Where | Trigger |
|------|------|-------|---------|
| AGT-1 | `POST /api/agent/:id/stop` with SIGTERM -> grace -> SIGKILL (direct child only) | `agent-spawn.js` | User click, API call |
| AGT-1 | Kill button in AgentPanel tabs | `AgentPanel.jsx` | User click |
| AGT-2 | Per-agent stdout+stderr activity monitor | `agent-health.js` (new) | Spawned agent output |
| AGT-2 | `agentSilent` / `agentKilled` WebSocket events | `agent-health.js` | Silence threshold |
| AGT-3 | Wall-clock timeout for spawned agents | `agent-health.js` | Timer expiry |
| AGT-3 | Memory RSS periodic check | `agent-health.js` | 30s interval |
| AGT-3 | Disk quota check before worktree merge | `build.js` | Pre-merge |
| AGT-4 | Orphan worktree scanner + remover | `worktree-gc.js` (new) | Server start, 15m interval, API |
| AGT-4 | `POST /api/agent/gc` endpoint | `agent-spawn.js` | Manual trigger |

## Files

| File | Action | Purpose |
|------|--------|---------|
| `server/agent-spawn.js` | existing | Add `POST /api/agent/:id/stop` endpoint; add `POST /api/agent/gc` endpoint; wire HealthMonitor on spawn |
| `server/agent-health.js` | new | HealthMonitor class: liveness probe, silence detection, wall-clock timeout, memory RSS check |
| `server/worktree-gc.js` | new | WorktreeGC class: orphan scan, age-based pruning, cleanup procedure |
| `server/agent-server.js` | existing | Delegate `POST /api/agent/interrupt` to unified stop logic; add SDK session kill timer |
| `server/vision-server.js` | existing | Initialize HealthMonitor and WorktreeGC on server start; run startup GC scan |
| `lib/build.js` | existing | Add disk quota check before worktree merge (~line 779); pass agent limits config to parallel dispatch |
| `src/components/vision/AgentPanel.jsx` | existing | Add kill button per agent tab; show silence warning badge |
| `src/App.jsx` | existing | Pass `onStopAgent` callback to AgentPanel |
| `src/lib/api.js` | new | Client API helpers for stop (`/api/agent/:id/stop`) and GC (`/api/agent/gc`) endpoints |
| `.compose/compose.json` | existing | Add `agentHealth`, `agentLimits`, `worktreeGc` config sections (with defaults) |

## Resolved Questions

- **Q: Should the stop endpoint kill child processes of the agent (grandchildren)?** A: No. Claude CLI manages its own subprocesses. Sending SIGTERM to the CLI process is sufficient -- it handles cleanup internally. If the CLI fails to exit within the grace period, SIGKILL kills the direct child only. Grandchild cleanup is best-effort -- the OS may or may not deliver SIGHUP to non-session-leader descendants. Spawned agents are not detached process groups, so `proc.kill()` does not signal the entire group. If reliable group cleanup is needed, future work can spawn with `detached: true` and use `process.kill(-pid, signal)`.

- **Q: Should health monitoring apply to SDK connector agents (not just spawned CLI)?** A: Not in V1. SDK connector agents are short-lived query iterators managed by `agent-server.js`. They already have per-step timeouts via `result-normalizer.js`. Health monitoring targets long-running spawned CLI agents where silence is the primary failure mode.

- **Q: What happens if `git worktree remove` fails because of uncommitted changes?** A: The `--force` flag is already used. If it still fails (e.g., locked files), fall back to `rm -rf` and run `git worktree prune` afterward. Log the error but don't block the GC.

- **Q: Should resource limits be per-agent-type or global?** A: Global defaults in V1 with per-spawn override via the API. Per-agent-type configuration (e.g., "codex agents get 5 min, claude agents get 30 min") is deferred to COMP-AGT-14 (Agent Capability Registry).

- **Q: Should the UI show real-time memory/disk usage?** A: Not in V1. The monitoring exists server-side for enforcement. UI surfaces only two states: healthy (green) and warned/killed (yellow/red). Detailed metrics are deferred to COMP-AGT-11 (Structured Observability).
