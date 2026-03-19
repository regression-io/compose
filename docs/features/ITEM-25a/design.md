# ITEM-25a: Subagent Activity Nesting — Design

## Problem

When the compose skill spawns parallel agents (compose-explorer, compose-architect) via `agent_run` or `/api/agent/spawn`, they're invisible in the UI. The AgentPanel shows only the parent session's activity. Users can't see what subagents are doing, how long they've been running, or whether they've completed.

## Current State

- **SessionManager** tracks one flat session per Claude Code invocation
- **agent-spawn.js** tracks spawned agents in-memory for 5 minutes, then deletes
- **AgentPanel** shows parent session telemetry only (OSC-sourced status, hook-sourced activity)
- **WebSocket** broadcasts `agentComplete` when spawn finishes, but no `agentSpawned` event
- No parent-child relationship between sessions/agents

## Architecture Decision

**Separate AgentRegistry** (not extending SessionManager).

Why: SessionManager is the single-session accumulator with Haiku batching, block tracking, and feature binding. Agent hierarchy is a different concern — tracking N concurrent short-lived workers. Mixing them would complicate SessionManager's lifecycle (start/end) with spawn/complete events that don't follow the same pattern.

The AgentRegistry is a lightweight in-memory tracker that:
- Persists spawned agents to the session data dir (not just memory)
- Tracks parent→child relationships
- Broadcasts spawn/complete events over WebSocket
- Gets read by the UI to render nested trees

## Design

### New module: `server/agent-registry.js`

```js
export class AgentRegistry {
  constructor(dataDir) {
    this._agents = new Map();  // agentId → AgentRecord
    this._file = path.join(dataDir, 'agents.json');
    this._load();
  }

  register(agentId, { parentSessionId, agentType, prompt, pid }) → AgentRecord
  complete(agentId, { status, exitCode }) → AgentRecord
  getChildren(parentSessionId) → AgentRecord[]
  getAll() → AgentRecord[]
  get(agentId) → AgentRecord | null
}
```

**AgentRecord shape:**
```js
{
  agentId: string,
  parentSessionId: string | null,
  agentType: 'claude' | 'codex' | 'compose-explorer' | 'compose-architect' | 'unknown',
  prompt: string (truncated to 200 chars),
  status: 'running' | 'complete' | 'failed',
  pid: number | null,
  startedAt: ISO string,
  completedAt: ISO string | null,
  exitCode: number | null,
}
```

Persisted to `agents.json` on register/complete. Cleaned up after session end (keep last 50 for history).

### Modify: `server/agent-spawn.js`

- On spawn: call `registry.register(agentId, { parentSessionId, agentType, prompt, pid })`
- On close: call `registry.complete(agentId, { status, exitCode })`
- Broadcast new `agentSpawned` message: `{ type: 'agentSpawned', agentId, parentSessionId, agentType, prompt }`
- Derive `agentType` from prompt heuristics: if prompt contains "explore" → 'compose-explorer', "architect" → 'compose-architect', else 'claude'
- Remove 5-minute cleanup — registry handles lifecycle

### New route: `GET /api/agents/tree`

Returns the agent hierarchy for the current session:
```json
{
  "sessionId": "session-...",
  "agents": [
    { "agentId": "agent-1", "agentType": "compose-explorer", "status": "running", "startedAt": "..." },
    { "agentId": "agent-2", "agentType": "compose-architect", "status": "complete", "startedAt": "...", "completedAt": "..." }
  ]
}
```

### Modify: `src/components/vision/AgentPanel.jsx`

Add a "Subagents" section below the activity feed. Shows:
- Each spawned agent as a row: type icon + label + status dot + elapsed time
- Running agents pulse, completed agents show checkmark/X
- Compact — fits in the sidebar without bloating

```
┌─ Agent Activity ──────────────────────┐
│ ● WRITING  Edit  3s                   │
│ ▬▬▬▬▬▬ (activity strip)              │
│                                       │
│ SUBAGENTS                             │
│ ● compose-explorer   running  45s     │
│ ✓ compose-explorer   complete 1m 12s  │
│ ● compose-architect  running  30s     │
└───────────────────────────────────────┘
```

### WebSocket integration

AgentPanel listens for two new message types via the existing store:
- `agentSpawned` → add to local agents list
- `agentComplete` → update status in local list (already exists, just enrich with agentType)

## Acceptance Criteria

- [ ] `AgentRegistry` class with register/complete/getChildren/getAll
- [ ] Agents persisted to `agents.json` (survive page refresh)
- [ ] `agent-spawn.js` registers with AgentRegistry, broadcasts `agentSpawned`
- [ ] `agentType` derived from prompt heuristics
- [ ] `GET /api/agents/tree` returns hierarchy for current session
- [ ] AgentPanel shows "Subagents" section with running/completed agents
- [ ] Running agents show pulsing dot + elapsed timer
- [ ] Completed agents show status icon + duration
- [ ] No 5-minute cleanup — registry manages lifecycle
- [ ] Tests: AgentRegistry unit tests (register, complete, getChildren)
- [ ] Tests: agent-spawn route integration test (spawn → registry → broadcast)

## Files Modified

| File | Action |
|------|--------|
| `server/agent-registry.js` | CREATE — AgentRegistry class |
| `server/agent-spawn.js` | MODIFY — integrate registry, broadcast agentSpawned, derive agentType |
| `server/vision-server.js` | MODIFY — instantiate registry, pass to spawn routes |
| `src/components/vision/AgentPanel.jsx` | MODIFY — add Subagents section |
| `src/components/vision/useVisionStore.js` | MODIFY — handle agentSpawned/agentComplete messages |
| `test/agent-registry.test.js` | CREATE — unit tests |

## Out of Scope

- **agent_run MCP tool tracking** — agent_run uses connectors directly, not the spawn API. Tracking those would require modifying agent-mcp.js to register with the registry. Deferred.
- **Drill-down into subagent output** — showing full agent output in UI. Deferred.
- **Cross-session hierarchy** — only tracks agents within current session. Historical hierarchy is in agents.json but not rendered.
