# ITEM-25a: Subagent Activity Nesting — Blueprint

## File Plan

| File | Action | Lines |
|------|--------|-------|
| `server/agent-registry.js` | CREATE | ~80 |
| `server/agent-spawn.js` | MODIFY (existing, 119 lines) | +20 |
| `server/vision-server.js` | MODIFY (existing) | +5 |
| `src/components/vision/AgentPanel.jsx` | MODIFY (existing, 255 lines) | +50 |
| `src/components/vision/visionMessageHandler.js` | MODIFY (existing) | +15 |
| `src/components/vision/useVisionStore.js` | MODIFY (existing) | +5 |
| `test/agent-registry.test.js` | CREATE | ~80 |

## Task 1: Create AgentRegistry (server/agent-registry.js — new)

Pure data store, no Express dependency. JSON file-backed.

```js
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export class AgentRegistry {
  #agents;   // Map<agentId, AgentRecord>
  #file;     // path to agents.json

  constructor(dataDir) {
    this.#file = join(dataDir, 'agents.json');
    this.#agents = new Map();
    this._load();
  }

  register(agentId, { parentSessionId, agentType, prompt, pid }) {
    const record = {
      agentId,
      parentSessionId: parentSessionId ?? null,
      agentType: agentType ?? 'unknown',
      prompt: (prompt ?? '').slice(0, 200),
      status: 'running',
      pid: pid ?? null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      exitCode: null,
    };
    this.#agents.set(agentId, record);
    this._save();
    return record;
  }

  complete(agentId, { status, exitCode }) {
    const record = this.#agents.get(agentId);
    if (!record) return null;
    record.status = status;
    record.exitCode = exitCode ?? null;
    record.completedAt = new Date().toISOString();
    this._save();
    return record;
  }

  getChildren(parentSessionId) {
    return [...this.#agents.values()].filter(a => a.parentSessionId === parentSessionId);
  }

  getAll() { return [...this.#agents.values()]; }
  get(agentId) { return this.#agents.get(agentId) ?? null; }

  // Keep last N records, prune old completed ones
  prune(keep = 50) {
    const all = [...this.#agents.values()]
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    const pruned = all.slice(keep);
    for (const r of pruned) this.#agents.delete(r.agentId);
    if (pruned.length > 0) this._save();
  }

  _load() {
    try {
      const data = JSON.parse(readFileSync(this.#file, 'utf-8'));
      for (const r of data) this.#agents.set(r.agentId, r);
    } catch { /* fresh start */ }
  }

  _save() {
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      writeFileSync(this.#file, JSON.stringify([...this.#agents.values()], null, 2));
    } catch (err) {
      console.error('[agent-registry] Save failed:', err.message);
    }
  }
}
```

Pattern: same as `SettingsStore` — JSON file, load on construct, save on mutate.

## Task 2: Integrate registry into agent-spawn.js (existing, lines 25-89)

**Modify `attachAgentSpawnRoutes` signature** — add `registry` and `sessionManager` to deps:

```diff
- export function attachAgentSpawnRoutes(app, { projectRoot, broadcastMessage, requireSensitiveToken }) {
+ export function attachAgentSpawnRoutes(app, { projectRoot, broadcastMessage, requireSensitiveToken, registry, sessionManager }) {
```

**In POST /api/agent/spawn handler** (line 29), after `_agents.set(agentId, agent)` (line 59):

```js
// Derive agent type from prompt heuristics
const agentType = deriveAgentType(prompt);
const parentSessionId = sessionManager?.currentSession?.id ?? null;

// Register with persistent registry
if (registry) {
  registry.register(agentId, { parentSessionId, agentType, prompt, pid: proc.pid });
}

// Broadcast spawn event
broadcastMessage({
  type: 'agentSpawned',
  agentId,
  parentSessionId,
  agentType,
  prompt: prompt.slice(0, 200),
  startedAt: agent.startedAt,
});
```

**In proc.on('close') handler** (line 69), before broadcast:

```js
if (registry) {
  registry.complete(agentId, { status: agent.status, exitCode: code });
}
```

**Remove the 5-minute cleanup** (line 79):

```diff
-     setTimeout(() => _agents.delete(agentId), 300_000);
```

**Add `deriveAgentType` helper** at module top:

```js
function deriveAgentType(prompt) {
  const lower = (prompt ?? '').toLowerCase();
  if (lower.includes('explore') || lower.includes('find features') || lower.includes('map the architecture'))
    return 'compose-explorer';
  if (lower.includes('architect') || lower.includes('competing') || lower.includes('proposal'))
    return 'compose-architect';
  if (lower.includes('review') || lower.includes('codex'))
    return 'codex';
  return 'claude';
}
```

**Add GET /api/agents/tree route** (after existing GET /api/agents, line 107):

```js
app.get('/api/agents/tree', (_req, res) => {
  if (!registry) return res.json({ agents: [] });
  const parentId = sessionManager?.currentSession?.id ?? null;
  const agents = parentId ? registry.getChildren(parentId) : registry.getAll();
  res.json({ sessionId: parentId, agents });
});
```

## Task 3: Wire registry in vision-server.js (line 171)

```diff
+ import { AgentRegistry } from './agent-registry.js';
...
  attach(httpServer, app) {
+   const agentRegistry = new AgentRegistry(getDataDir());
    ...
    attachAgentSpawnRoutes(app, {
      projectRoot: getTargetRoot(),
      broadcastMessage: (msg) => this.broadcastMessage(msg),
      requireSensitiveToken,
+     registry: agentRegistry,
+     sessionManager: this.sessionManager,    // P1 fix: pass sessionManager for parentSessionId
    });
```

## Task 4: Handle agentSpawned in visionMessageHandler.js

**4a:** At line 16, add `setSpawnedAgents` to the destructured setters:
```diff
  const {
    setItems, setConnections, setGates, setGateEvent,
    setRecentChanges, setUICommand, setAgentActivity,
-   setAgentErrors, setSessionState, setSettings, setActiveBuild, setSessions, EMPTY_CHANGES,
+   setAgentErrors, setSessionState, setSpawnedAgents, setSettings, setActiveBuild, setSessions, EMPTY_CHANGES,
  } = setters;
```

**4b:** After the `agentActivity` handler (~line 59), add new message handlers:

```js
} else if (msg.type === 'agentSpawned') {
  setSpawnedAgents(prev => [...prev, {
    agentId: msg.agentId,
    agentType: msg.agentType,
    status: 'running',
    startedAt: msg.startedAt,
    prompt: msg.prompt,
  }]);

} else if (msg.type === 'agentComplete') {
  // Existing handler — enrich with status update
  setSpawnedAgents(prev => prev.map(a =>
    a.agentId === msg.agentId
      ? { ...a, status: msg.status, completedAt: new Date().toISOString() }
      : a
  ));
```

## Task 5: Add spawnedAgents state to useVisionStore.js

**5a: Initial state** — In the store creation (~line 221), add:

```js
spawnedAgents: [],
```

**5b: Setter** — After `setSessionState` (~line 150), add:

```js
setSpawnedAgents: (updater) => set(s => ({
  spawnedAgents: typeof updater === 'function' ? updater(s.spawnedAgents) : updater
})),
```

**5c: Pass setter to message handler** — In the setters object passed to `handleVisionMessage` (~line 127-155), add `setSpawnedAgents` alongside the other setters.

**5d: Thread through App.jsx** — Three changes for the prop chain:
1. Add `spawnedAgents: s.spawnedAgents` to the App.jsx selector (~line 354)
2. Add `spawnedAgents={spawnedAgents}` to `<AttentionQueueSidebar>` call (~line 972)
3. Add `spawnedAgents` to AttentionQueueSidebar function signature (~line 260)
4. Pass `spawnedAgents={spawnedAgents}` to `<AgentPanel>` in AttentionQueueSidebar (~line 355)

## Task 6: Add Subagents section to AgentPanel.jsx

After the "Recent errors" section (~line 248), add:

```jsx
{/* Spawned subagents */}
{spawnedAgents && spawnedAgents.length > 0 && (
  <div className="mt-1.5">
    <p className="text-[10px] font-medium uppercase tracking-wider mb-0.5"
       style={{ color: 'hsl(var(--muted-foreground))' }}>
      Subagents
    </p>
    {spawnedAgents.map(agent => (
      <div key={agent.agentId}
        className="flex items-center gap-1.5 text-[10px] py-0.5"
        style={{ color: 'hsl(var(--muted-foreground))' }}>
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{
          background: agent.status === 'running'
            ? 'var(--color-category-executing)'
            : agent.status === 'complete' ? 'hsl(var(--success))' : 'hsl(var(--destructive))',
          animation: agent.status === 'running' ? 'pulse 1.5s ease-in-out infinite' : 'none',
        }} />
        <span className="font-medium shrink-0">{agent.agentType}</span>
        <span className="truncate opacity-60">{agent.status}</span>
        <span className="tabular-nums ml-auto opacity-50">
          {formatElapsed(Date.now() - new Date(agent.startedAt).getTime())}
        </span>
      </div>
    ))}
  </div>
)}
```

AgentPanel prop: add `spawnedAgents` to the function signature. Thread from App.jsx.

## Verification Table

| Ref | File:Line | Verified |
|-----|-----------|----------|
| attachAgentSpawnRoutes signature | server/agent-spawn.js:25 | deps object, can extend |
| _agents Map | server/agent-spawn.js:27 | in-memory, stays for poll compat |
| 5min cleanup | server/agent-spawn.js:79 | setTimeout, will remove |
| agentComplete broadcast | server/agent-spawn.js:72 | broadcastMessage call |
| VisionServer.attach | server/vision-server.js:60 | creates stores, passes deps |
| spawn routes wiring | server/vision-server.js:171 | deps object, can add registry |
| handleVisionMessage | visionMessageHandler.js:8 | takes msg + refs + setters |
| agentActivity handler | visionMessageHandler.js:51 | pattern for new msg types |
| store state shape | useVisionStore.js:221 | flat state, add spawnedAgents |
| AgentPanel signature | AgentPanel.jsx:53 | props: agentActivity, agentErrors, sessionState |
| AgentPanel errors section | AgentPanel.jsx:230 | insert point for Subagents |
