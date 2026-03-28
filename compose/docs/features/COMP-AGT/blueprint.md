# Agent Lifecycle Control: Implementation Blueprint

**Status:** BLUEPRINT
**Date:** 2026-03-28
**Design:** [design.md](design.md)

---

## File Plan

| File | Action | Purpose |
|------|--------|---------|
| `server/agent-spawn.js` | existing | Add `POST /api/agent/:id/stop` and `POST /api/agent/gc` endpoints; wire HealthMonitor `.track()` on spawn |
| `server/agent-health.js` | new | `HealthMonitor` class: per-agent liveness probe, silence warning/kill timers, wall-clock timeout, memory RSS polling |
| `server/worktree-gc.js` | new | `WorktreeGC` class: orphan worktree scanner, age-based pruning, `git worktree remove` + `rm -rf` fallback |
| `server/agent-server.js` | existing | Delegate `POST /api/agent/interrupt` to unified stop logic; add kill timer after `interrupt()` — escalate to `_killCurrentSession()` if iterator doesn't resolve within grace period |
| `server/agent-registry.js` | existing | Add `getRunning()` method for health monitor cross-reference; add `updateStatus()` for silence/killed states |
| `server/vision-server.js` | existing | Initialize `HealthMonitor` and `WorktreeGC` at startup (lines 171-179); pass to `attachAgentSpawnRoutes` |
| `lib/build.js` | existing | Add disk quota check before worktree merge (pre-`git apply` at line 847); pass `agentLimits` config |
| `src/components/vision/AgentPanel.jsx` | existing | Add kill button per agent tab (line 114-133); add silence warning badge; add GC trigger button |
| `src/components/shared/AgentCard.jsx` | existing | Add `onStop` callback prop; show silence warning state via yellow dot |
| `src/components/vision/visionMessageHandler.js` | existing | Add handlers for `agentSilent`, `agentKilled`, `agentGC` WS message types |
| `src/components/vision/AppSidebar.jsx` | existing | Pass `onStopAgent` callback through to `AgentPanel` (renders AgentPanel at line 151) |
| `src/components/vision/AttentionQueueSidebar.jsx` | existing | Pass `onStopAgent` callback through to `AgentPanel` (renders AgentPanel at line 341) |
| `src/components/vision/DashboardView.jsx` | existing | Pass `onStop` callback to `AgentCard` (renders AgentCard directly at lines 102, 112) |
| `src/lib/api.js` or colocated helper | existing | Add `stopAgent(agentId)` — `POST /api/agent/:id/stop`; add `triggerGC()` — `POST /api/agent/gc` |

---

## Integration Points (verified line references)

### AGT-1: Unified Stop Endpoint

**`server/agent-spawn.js`**

| Line | What Exists | What Changes |
|------|-------------|-------------|
| 36 | `attachAgentSpawnRoutes(app, { ... registry, sessionManager })` | Add `healthMonitor` to deps destructuring |
| 37 | `const _agents = new Map()` | No change — this is the in-memory handle map we use for stop |
| 52-59 | `spawn('claude', ...)` returns `proc` (ChildProcess) | No change — `proc` handle already stored at line 62 as `agent.process` |
| 61-69 | Agent record: `{ process, output, stderr, status, prompt, startedAt }` | Add `stoppedBy: null` field for tracking manual vs automatic kills; add `terminalReason: null` (one of: `manual_stop`, `silence_timeout`, `wall_clock_timeout`, `memory_exceeded`, `normal`) |
| 94-96 | `proc.stdout.on('data', ...)` accumulates output | Wire `healthMonitor.track(agentId, proc)` immediately after this block (after line 100) |
| 102-123 | `proc.on('close', ...)` sets status and broadcasts `agentComplete` | Add `healthMonitor.untrack(agentId)` at top of close handler; include `terminalReason` in the `agentComplete` broadcast payload (defaults to `normal` if not set by HealthMonitor or manual stop). **Terminal state rule:** if `terminalReason` is set to anything other than `normal`, the close handler sets `status: 'killed'` in the payload regardless of exit code -- `agentKilled` is terminal and `agentComplete` must not downgrade it. |
| After line 133 | No stop endpoint exists | Add `POST /api/agent/:id/stop` with SIGTERM -> grace(5s) -> SIGKILL escalation. **Spawned agents only** -- this endpoint handles agents in the `_agents` map (Path A). If `id` matches the SDK session (e.g., `'current-session'`), proxy to `agent-server`'s `POST /api/agent/interrupt` instead of attempting a direct process kill (Path B). |
| After line 161 | No GC endpoint exists | Add `POST /api/agent/gc` delegating to `WorktreeGC.runNow()` |

**`server/agent-server.js`**

| Line | What Exists | What Changes |
|------|-------------|-------------|
| 51 | `let _session = { id: null, queryIter: null }` | No structural change — stop endpoint uses `queryIter.interrupt()` then kill timer |
| 135-145 | `POST /api/agent/interrupt` calls `_session.queryIter.interrupt()` | Preserve endpoint -- this is the canonical entry point for SDK session stop (Path B, separate process from `agent-spawn.js`). Add a 5s kill timer after `interrupt()` that calls `_killCurrentSession()` if iterator hasn't resolved. Broadcast `agentKilled` on timeout. The new `POST /api/agent/:id/stop` in `agent-spawn.js` proxies here for SDK session IDs rather than attempting cross-process iterator access. |
| 178-183 | `_killCurrentSession()` calls `queryIter.return()` | No change — this is our escalation target after grace period |

**`server/vision-server.js`**

| Line | What Exists | What Changes |
|------|-------------|-------------|
| 172 | `const agentRegistry = new AgentRegistry(getDataDir())` | After this line: instantiate `HealthMonitor` and `WorktreeGC` |
| 173-179 | `attachAgentSpawnRoutes(app, { ... })` | Add `healthMonitor` and `worktreeGC` to deps object |

**`src/components/vision/AgentPanel.jsx`**

| Line | What Exists | What Changes |
|------|-------------|-------------|
| 59 | `function AgentPanel({ agentActivity, agentErrors, sessionState, onSelectItem, spawnedAgents, agentRelays })` | Add `onStopAgent` prop |
| 114-133 | Tab buttons per agent: `<button key={a.agentId} onClick={() => setSelectedAgent(a.agentId)}>` | Add a stop/kill button (X icon) inside each running agent's tab. Calls `onStopAgent(a.agentId)`. Only visible when `a.status === 'running'`. |
| 125-129 | Status dot with green/emerald/red | Add yellow state for `a.status === 'silent'` (silence warning from AGT-2) |
| 308-325 | Subagents list section with status dots | Mirror the yellow silence state and add stop button per agent row |

**`src/components/shared/AgentCard.jsx`**

| Line | What Exists | What Changes |
|------|-------------|-------------|
| 13 | `export default function AgentCard({ agent, toolCount, errorCount, currentTool, currentCategory })` | Add `onStop` callback prop |
| 14-16 | Status derivation: `isRunning`, `isFailed`, `isComplete` | Add `isSilent = agent.status === 'silent'` |
| 43-63 | Status dot + label + elapsed | Add yellow color for `isSilent`; add stop button (X) when `isRunning \|\| isSilent` that calls `onStop?.(agent.agentId)` |

**`src/components/vision/visionMessageHandler.js`**

| Line | What Exists | What Changes |
|------|-------------|-------------|
| 85-90 | `agentComplete` handler: updates `spawnedAgents` status | Preserve `terminalReason` from the `agentComplete` payload onto the spawned agent state so UI can display why the agent stopped (e.g., "killed: silence timeout"). **Terminal state guard:** if the agent already has `status: 'killed'` from a prior `agentKilled` WS message, preserve it -- do not overwrite with exit-code-derived status. Rule: `agentKilled` is terminal, `agentComplete` cannot downgrade it. |

### AGT-2: Health Monitoring

**`server/agent-health.js` (new)**

Creates a `HealthMonitor` class with:
- `track(agentId, proc)` — attaches stdout + stderr listeners, starts silence timer and wall-clock timer
- `untrack(agentId)` — clears all timers for the agent
- `_onStdoutData(agentId)` — resets silence timer
- `_onSilenceWarning(agentId)` — broadcasts `agentSilent` via `broadcastMessage`
- `_onSilenceKill(agentId)` — calls unified stop endpoint logic, broadcasts `agentKilled` with reason `silence_timeout`
- `_onWallClockExpired(agentId)` — calls unified stop endpoint, broadcasts `agentKilled` with reason `wall_clock_timeout`
- Constructor takes `{ broadcastMessage, stopAgent, config }` where `config` comes from `.compose/compose.json` `agentHealth` key

**`server/agent-spawn.js`**

| Line | What Exists | What Changes |
|------|-------------|-------------|
| 94-100 | stdout/stderr data handlers | After line 100: call `healthMonitor.track(agentId, proc)` |
| 102 | `proc.on('close', ...)` | Add `healthMonitor.untrack(agentId)` at start of callback |

**`server/build-stream-bridge.js` (reference pattern only)**

| Line | What Exists | Pattern to Follow |
|------|-------------|-------------------|
| 14 | `const DEFAULT_CRASH_TIMEOUT_MS = 300_000` | HealthMonitor uses same 5min default for kill threshold |
| 377-394 | `_resetCrashTimer()`: `clearTimeout` -> `setTimeout` -> check state -> broadcast | Same timer-reset pattern: clear existing, start new, check liveness on fire, broadcast event |
| 379-393 | Timer callback checks `this.#buildActive && this.#inStep` before emitting crash | HealthMonitor checks agent still in `_agents` map and still running before killing |
| 393 | `if (this.#crashTimer.unref) this.#crashTimer.unref()` | HealthMonitor timers must also `.unref()` to not block process exit |

**`src/components/vision/visionMessageHandler.js`**

| Line | What Exists | What Changes |
|------|-------------|-------------|
| After line 93 (agentRelay handler) | No silence/killed handlers | Add `agentSilent` handler: updates matching agent in `spawnedAgents` with `status: 'silent'` |
| After agentSilent handler | Nothing | Add `agentKilled` handler: updates matching agent with `status: 'killed'`, pushes to `agentErrors` with reason |

### AGT-3: Resource Limit Enforcement

**`server/agent-health.js` (new — same file as AGT-2)**

Wall-clock timeout:
- `_startWallClockTimer(agentId, timeoutMs)` — `setTimeout` that fires unified stop. Default 600000ms (10min).
- Called from `track()`. Timeout configurable via `POST /api/agent/spawn` body `{ timeout: <ms> }` or global `agentLimits.spawnTimeoutMs`.

Memory RSS polling:
- `_startMemoryPoller(agentId, pid)` — `setInterval` every 30s, checks RSS via `ps -o rss= -p <pid>` (macOS compatible).
- If RSS exceeds `agentLimits.maxMemoryMb` (default 512), log warning and trigger unified stop with reason `memory_exceeded`.
- Interval stored per-agent, cleared in `untrack()`. Interval `.unref()`.

**`server/agent-spawn.js`**

| Line | What Exists | What Changes |
|------|-------------|-------------|
| 39-41 | `POST /api/agent/spawn` reads `{ prompt, id }` from body | Also read `{ timeout }` from body; pass to `healthMonitor.track(agentId, proc, { timeoutMs: timeout })` |

**`lib/build.js`**

| Line | What Exists | What Changes |
|------|-------------|-------------|
| 42-57 | `STEP_TIMEOUT_MS` map + `DEFAULT_TIMEOUT_MS` | No change — build-orchestrated agents keep existing per-step timeouts |
| 753-764 | Diff collection from worktree: `git add -A` then `git diff --cached HEAD` | Before diff collection: add disk quota check via `du -sk <wtPath>`, compare against `agentLimits.maxWorktreeDiskMb` (default 100MB). If exceeded, skip diff/merge, set task status to `failed` with `disk_quota_exceeded` error. |
| 847-853 | `git apply --check` then `git apply` for patch merge | No change here — the disk check happens earlier at diff collection (line 753) |

**`lib/result-normalizer.js` (reference pattern)**

| Line | What Exists | Pattern to Follow |
|------|-------------|-------------------|
| 157-163 | `setTimeout` sets `timedOut = true`, calls `connector.interrupt()` | HealthMonitor's wall-clock timer follows same pattern: timer fires, then calls stop logic |

### AGT-4: Worktree GC

**`server/worktree-gc.js` (new)**

Creates a `WorktreeGC` class with:
- Constructor: `({ projectRoot, getRunningAgentIds, config })` where config is from `worktreeGc` key in compose.json
- `start()` — runs initial scan, starts periodic interval (default 15min, `.unref()`)
- `stop()` — clears interval
- `runNow()` — returns `{ removed: string[], errors: string[] }`
- `_scan()` — lists dirs in `.compose/par/`, reads `.owner` file from each dir. If `.owner` exists and `pid` is alive (`process.kill(pid, 0)`), skip. If `.owner` is missing OR pid is dead AND dir mtime older than age threshold, mark as orphan.
- `_removeWorktree(path)` — `git worktree remove <path> --force`, fallback to `rm -rf`, then `git worktree prune`
- Safety: never removes dirs outside `.compose/par/`; never removes if PID still alive (`process.kill(pid, 0)`)

**`server/agent-spawn.js`**

| Line | What Exists | What Changes |
|------|-------------|-------------|
| After line 161 | No GC route | Add `POST /api/agent/gc` that calls `worktreeGC.runNow()` and returns result |

**`server/agent-registry.js`**

| Line | What Exists | What Changes |
|------|-------------|-------------|
| 49-51 | `getChildren(parentSessionId)` and `getAll()` | Add `getRunning()`: returns all records with `status === 'running'`, used by WorktreeGC to check ownership |
| 53 | `getAll()` returns all records | No change |
| 54 | `get(agentId)` returns single record | No change — used for PID lookup during orphan detection |
| 22-37 | `register()` stores `{ pid, status, ... }` | Persist `terminalReason` alongside `exitCode` when agent record is updated on close |

**`server/vision-server.js`**

| Line | What Exists | What Changes |
|------|-------------|-------------|
| 172-179 | AgentRegistry instantiation and route attachment | After AgentRegistry: create `WorktreeGC` with `projectRoot: getTargetRoot()`, `getRunningAgentIds` from registry. Call `worktreeGC.start()`. Pass to `attachAgentSpawnRoutes`. |

> **Project-switch safety:** Both `HealthMonitor` and `WorktreeGC` must be recreated on `onProjectSwitch()` (`vision-server.js` handles this pattern already for `StratumSync`). On switch: call `healthMonitor.stop()` (clears all per-agent timers) and `worktreeGC.stop()` (clears interval), then instantiate new instances with the new project paths.

**`lib/build.js`**

| Line | What Exists | What Changes |
|------|-------------|-------------|
| 925-928 | `rm -rf "${parDir}"` after parallel dispatch | No change — this aggressive cleanup remains. WorktreeGC is the safety net for when this doesn't run (crash, kill, etc.) |
| 668 | `const parDir = join(agentCwd, '.compose', 'par')` | No change — WorktreeGC uses the same path convention |
| 700-717 | Worktree creation per task | After worktree creation, write `.owner` file inside the worktree: `{ pid: process.pid, taskId, createdAt: Date.now(), buildFlowId }`. This enables GC ownership checks without cross-referencing agent registry. |
| 779-784 | `git worktree remove` in `finally` block per-task | No change — per-task cleanup remains. GC catches what `finally` misses. |

**`src/components/vision/visionMessageHandler.js`**

| Line | What Exists | What Changes |
|------|-------------|-------------|
| After agentKilled handler | Nothing | Add `agentGC` handler: pushes to `agentActivity` feed with tool='worktree-gc', detail=`removed N worktrees` |

---

## Corrections Table

| Design Assumption | Reality | Resolution |
|-------------------|---------|------------|
| Design says `AgentPanel.jsx` is at `src/components/vision/shared/AgentPanel.jsx` | Actual path: `src/components/vision/AgentPanel.jsx` (not in `shared/`) | Use correct path |
| Design says `AgentCard.jsx` is at `src/components/vision/shared/AgentCard.jsx` | Actual path: `src/components/shared/AgentCard.jsx` (in `shared/`, not under `vision/`) | Use correct path |
| Design originally said server init is in `server/app.js` | No `app.js` exists. Agent routes are initialized in `server/vision-server.js:171-179` | **Fixed in design** — updated to `server/vision-server.js` |
| Design says `agent-spawn.js:37` stores `agent.process` | Correct — line 62 stores `process: proc` in the agent record, line 69 puts it in `_agents` map at line 37 | No fix needed |
| Design references `agent-server.js:135-145` for interrupt path | Correct — `POST /api/agent/interrupt` at lines 135-145 | No fix needed |
| Design references `build-stream-bridge.js:377-394` for crash timer | Correct — `_resetCrashTimer()` at lines 377-394 | No fix needed |
| Design references `build.js:770-787` for worktree merge section | Merge section starts at line 802 (`// Merge diffs from worktrees`). Per-task worktree cleanup `finally` block is at lines 779-784. | Disk quota check goes at line 753 (pre-diff-collection), not at merge |
| Design references `build.js:927` for `rm -rf .compose/par/` | Correct — line 927 | No fix needed |
| Design says `AgentLogViewer.jsx:49` polls every 2s | AgentLogViewer is imported at line 2 of AgentPanel but its internals not relevant to AGT-1/2 — the silence indicator goes on the tab/card, not the log viewer | No log viewer changes needed |
| Design says `agent-registry.js:22-36` stores pid but not process handle | Correct — `register()` at lines 22-37 stores `pid` in the JSON record. ChildProcess handle stays in `_agents` map (in-memory only). | Cross-reference both: `_agents` for handle, registry for PID fallback |
| Design says HealthMonitor subscribes to `_agents` map | `_agents` is local to `attachAgentSpawnRoutes` closure (line 37), not directly accessible | HealthMonitor gets notified via explicit `track()/untrack()` calls, not map subscription. The stop function is injected as a callback. |
| Design says `build.js:682-691` for concurrent task limit | Semaphore is at lines 681-692 | No fix needed (off by one in design ref) |
| Design says OpenCode connector at `opencode-connector.js:144-148` | OpenCode connector exists but is not in scope for AGT-1 — it's a separate process type not managed through `_agents` | Defer OpenCode stop to future work; document as known gap |
| Design does not mention project-switch lifecycle for HealthMonitor/WorktreeGC | `vision-server.js` has `onProjectSwitch()` that recreates project-scoped services (e.g., StratumSync) | Both services must be `.stop()`-ed and recreated on project switch with new project paths |
| Design claims `proc.kill('SIGKILL')` kills the process group | Spawned agents are not detached process groups; `proc.kill()` signals the direct child only | SIGKILL the direct child; grandchild cleanup is best-effort only — not guaranteed for non-session-leader descendants |
| Design does not track terminal reason through the close path | `agentComplete` overwrites status without preserving why the agent was killed | Add `terminalReason` field set before exit, included in broadcast, persisted in registry. **Terminal state rule added:** close handler preserves `killed` status when `terminalReason` is non-normal; `visionMessageHandler` guards against `agentComplete` downgrading a prior `agentKilled` state. |
| File plan only lists AgentPanel and AgentCard for UI changes | `AppSidebar.jsx:151` and `AttentionQueueSidebar.jsx:341` render AgentPanel and must pass `onStopAgent`; `DashboardView.jsx:102,112` renders AgentCard directly and must pass `onStop` | Added all parent call sites and client-side API helpers to file plan |

---

## Verification Checklist

Every file:line reference that needs verification before implementation begins:

### Server files
- [ ] `server/agent-spawn.js:37` — `_agents` Map declaration exists and is closure-scoped
- [ ] `server/agent-spawn.js:52-59` — `spawn('claude', ...)` with `proc` ChildProcess
- [ ] `server/agent-spawn.js:61-69` — Agent record structure with `process: proc`
- [ ] `server/agent-spawn.js:94-100` — stdout/stderr data handlers (insertion point for `track()`)
- [ ] `server/agent-spawn.js:102-123` — `proc.on('close', ...)` handler (insertion point for `untrack()`)
- [ ] `server/agent-spawn.js:133` — End of spawn route (insertion point for stop endpoint)
- [ ] `server/agent-spawn.js:161` — End of agents list route (insertion point for GC endpoint)
- [ ] `server/agent-server.js:51` — `_session` object with `queryIter`
- [ ] `server/agent-server.js:135-145` — `POST /api/agent/interrupt` handler
- [ ] `server/agent-server.js:178-183` — `_killCurrentSession()` function
- [ ] `server/agent-registry.js:22-37` — `register()` method stores `pid`
- [ ] `server/agent-registry.js:49-54` — `getChildren()`, `getAll()`, `get()` methods
- [ ] `server/vision-server.js:172` — `AgentRegistry` instantiation
- [ ] `server/vision-server.js:173-179` — `attachAgentSpawnRoutes` call with deps
- [ ] `server/build-stream-bridge.js:14` — `DEFAULT_CRASH_TIMEOUT_MS = 300_000`
- [ ] `server/build-stream-bridge.js:377-394` — crash timer pattern with `.unref()`

### Build orchestrator
- [ ] `lib/build.js:42-57` — `STEP_TIMEOUT_MS` map (no changes, reference only)
- [ ] `lib/build.js:668` — `parDir = join(agentCwd, '.compose', 'par')` — worktree root path
- [ ] `lib/build.js:681-692` — Semaphore for `maxConcurrent` (reference only)
- [ ] `lib/build.js:700-717` — Worktree creation per task
- [ ] `lib/build.js:753-764` — Diff collection section (insertion point for disk quota check)
- [ ] `lib/build.js:779-784` — Per-task worktree cleanup in `finally` block
- [ ] `lib/build.js:925-928` — Bulk `rm -rf` cleanup after parallel dispatch
- [ ] `lib/result-normalizer.js:157-163` — Timeout timer pattern (reference for HealthMonitor)

### Frontend
- [ ] `src/components/vision/AgentPanel.jsx:59` — Component props signature
- [ ] `src/components/vision/AgentPanel.jsx:114-133` — Per-agent tab buttons (kill button insertion point)
- [ ] `src/components/vision/AgentPanel.jsx:125-129` — Status dot colors (add yellow for silent)
- [ ] `src/components/vision/AgentPanel.jsx:308-325` — Subagents list section (stop button insertion point)
- [ ] `src/components/shared/AgentCard.jsx:13` — Component props signature (add `onStop`)
- [ ] `src/components/shared/AgentCard.jsx:14-16` — Status derivation (add `isSilent`)
- [ ] `src/components/shared/AgentCard.jsx:43-63` — Status dot + label (add yellow for silent)
- [ ] `src/components/vision/visionMessageHandler.js:75-90` — `agentSpawned`/`agentComplete` handlers
- [ ] `src/components/vision/visionMessageHandler.js:92-93` — `agentRelay` handler (insertion point for new handlers)

### Parent call sites (Finding 5)
- [ ] `src/components/vision/AppSidebar.jsx:151` — Renders `<AgentPanel>`, needs `onStopAgent` prop
- [ ] `src/components/vision/AttentionQueueSidebar.jsx:341` — Renders `<AgentPanel>`, needs `onStopAgent` prop
- [ ] `src/components/vision/DashboardView.jsx:102,112` — Renders `<AgentCard>` directly, needs `onStop` prop
- [ ] `src/lib/api.js` or equivalent — Confirm API helper file exists for `stopAgent()` and `triggerGC()` additions

### Config
- [ ] `.compose/compose.json` — Verify file exists and can accept new `agentHealth`, `agentLimits`, `worktreeGc` keys without breaking existing config parsing
