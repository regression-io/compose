# Session-Lifecycle Binding: Blueprint

**Status:** BLUEPRINT
**Date:** 2026-03-06
**Roadmap item:** 26 (Phase 6, L5)

## Related Documents

- [Design](design.md)
- [Policy Enforcement Design](../policy-enforcement/design.md) — L3
- [Lifecycle Engine Roadmap](../../plans/2026-02-15-lifecycle-engine-roadmap.md)

---

## Corrections Table

| Design Assumption | Reality | Resolution |
|---|---|---|
| `session-manager.js` has `fs` import for transcript filing | No `fs` import — only `path`, `fileURLToPath`, and local imports | Add `import { copyFile, mkdir } from 'node:fs/promises'` |
| `endSession` can capture `phaseAtEnd` from lifecycle state | `SessionManager` has no access to vision store or lifecycle manager | Inject a `getFeaturePhase(featureCode)` callback via constructor |
| `session-routes.js` receives `store` in deps | `attachSessionRoutes` receives `{ sessionManager, scheduleBroadcast, broadcastMessage, spawnJournalAgent }` — no `store` | Add `store` to deps; update call site in `vision-server.js:52-58` |
| `SESSIONS_FILE` available in `session-routes.js` for history route | Not imported or defined — only used in `session-manager.js:17` | Expose via `sessionManager.sessionsFile` getter, or delegate history query to a manager method |
| `GET /api/session/current` exposes binding fields | Response at `session-routes.js:79-84` doesn't include `featureCode`, `phaseAtBind`, `boundAt` | Add fields to response object |
| `AgentPanel` receives navigation callback for click-to-item | No `onSelectItem` prop or navigation mechanism | Add `onSelectItem` prop threaded from `VisionTracker` → `AppSidebar` → `AgentPanel` |
| `ItemDetailPanel` already has a lifecycle section | No lifecycle rendering at all — `item.lifecycle` is absent from render | Sessions section is standalone, guarded by `item.lifecycle?.featureCode` |
| `toolGetCurrentSession` called with args in dispatch | Called as `toolGetCurrentSession()` with no args at `compose-mcp.js:258` | Change to `toolGetCurrentSession(args)` |
| `readSessionsByFeature` can be added to `session-store.js` | Confirmed — file exports pure functions | Straightforward addition |
| Phase enrichment has access to `item.lifecycle` | `resolveItems` returns full item objects — `lifecycle` field is present | Confirmed — one-line change |

---

## File Plan

### 1. `server/session-manager.js` (existing)

**Add imports** at top (after line 3):
```js
import { copyFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
```
Note: `path` is already imported at line 2 as default. Use named imports from `node:path` alongside it, or use the existing `path.join` / `path.extname`.

**Constructor change** — accept options object (constructor currently takes no args, line 26):
```js
// line 26, constructor()
constructor({ getFeaturePhase, featureRoot } = {}) {
  // existing fields...
  this._getFeaturePhase = getFeaturePhase || (() => null);
  this._featureRoot = featureRoot || 'docs/features';
}
```

**`startSession(source)`** — add binding fields to session object at line 64-74:
```js
// After errors: [] (line 73)
featureCode: null,
featureItemId: null,
phaseAtBind: null,
boundAt: null,
```

**New method `bindToFeature(featureCode, itemId, phase)`** — insert after `getContext()` at line 200:
```js
bindToFeature(featureCode, itemId, phase) {
  const session = this.currentSession;
  if (!session) throw new Error('No active session');
  if (session.featureCode) {
    return { already_bound: true, featureCode: session.featureCode };
  }
  session.featureCode = featureCode;
  session.featureItemId = itemId;
  session.phaseAtBind = phase;
  session.boundAt = new Date().toISOString();
  return { bound: true, featureCode, itemId, phase };
}
```

**`endSession` changes** — after line 100 (`session.transcriptPath = transcriptPath`):
```js
// Capture phaseAtEnd for bound sessions
if (session.featureCode) {
  session.phaseAtEnd = this._getFeaturePhase(session.featureCode);
}
```

After line 100 (`if (transcriptPath) session.transcriptPath = transcriptPath`) — transcript auto-filing (before persist, so failures are visible):
```js
// Auto-file transcript to feature folder — awaited to ensure copy completes before process exit
if (session.featureCode && transcriptPath) {
  try {
    await this._fileTranscript(session.featureCode, session.id, transcriptPath);
  } catch (err) {
    console.error(`[session] Failed to file transcript to ${session.featureCode}:`, err.message);
  }
}
```

This runs before `_persist` and before `this.currentSession = null`, so it's part of the awaited `endSession` path. The session-end hook awaits `endSession`, so the copy completes before the process can exit. Errors are logged but don't block session persistence.

**New private method `_fileTranscript`** — after `_persist` at ~line 278:
```js
async _fileTranscript(featureCode, sessionId, transcriptPath) {
  const ext = extname(transcriptPath) || '.transcript';
  const sessionsDir = join(this._featureRoot, featureCode, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  const dest = join(sessionsDir, `${sessionId}${ext}`);
  await copyFile(transcriptPath, dest);
}
```

This needs `_featureRoot` — already defined in the constructor change above (line 46: `this._featureRoot = featureRoot || 'docs/features'`). No additional constructor change needed.

**`getContext` change** — add optional `featureCode` parameter:
```js
// line 198-200
getContext(featureCode) {
  if (featureCode) {
    return readSessionsByFeature(featureCode, 1, SESSIONS_FILE)[0] || null;
  }
  return readLastSession(SESSIONS_FILE);
}
```

### 2. `server/session-store.js` (existing)

**`serializeSession`** — add binding fields after line 32 (before closing brace):
```js
featureCode: session.featureCode || null,
featureItemId: session.featureItemId || null,
phaseAtBind: session.phaseAtBind || null,
phaseAtEnd: session.phaseAtEnd || null,
boundAt: session.boundAt || null,
```

**New function `readSessionsByFeature`** — after `readLastSession` at line 82:
```js
export function readSessionsByFeature(featureCode, limit, sessionsFile) {
  try {
    const raw = fs.readFileSync(sessionsFile, 'utf8');
    const sessions = JSON.parse(raw);
    return sessions
      .filter(s => s.featureCode === featureCode)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  } catch {
    return [];
  }
}
```

Import `readSessionsByFeature` in `session-manager.js` alongside existing imports.

### 3. `server/session-routes.js` (existing)

**Deps change** — add `store` to destructured deps at line 22:
```js
export function attachSessionRoutes(app, { sessionManager, scheduleBroadcast, broadcastMessage, spawnJournalAgent, store }) {
```

**New endpoint `POST /api/session/bind`** — insert after the end handler (~line 64):
```js
app.post('/api/session/bind', (req, res) => {
  try {
    const { featureCode } = req.body;
    if (!featureCode) return res.status(400).json({ error: 'featureCode required' });

    const session = sessionManager.currentSession;
    if (!session) return res.status(409).json({ error: 'No active session' });

    // Look up the vision item for this feature
    const item = store.getItemByFeatureCode(featureCode);
    const itemId = item?.id || null;
    const phase = item?.lifecycle?.currentPhase || null;

    const result = sessionManager.bindToFeature(featureCode, itemId, phase);

    if (!result.already_bound) {
      broadcastMessage({
        type: 'sessionBound',
        sessionId: session.id,
        featureCode,
        itemId,
        phase,
        timestamp: new Date().toISOString(),
      });
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

**New endpoint `GET /api/session/history`** — insert after bind:
```js
app.get('/api/session/history', (req, res) => {
  try {
    const { featureCode, limit } = req.query;
    if (!featureCode) return res.status(400).json({ error: 'featureCode required' });
    const sessions = readSessionsByFeature(featureCode, parseInt(limit) || 10, sessionManager.sessionsFile);
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

Import `readSessionsByFeature` from `./session-store.js` at top of file.

Expose `sessionsFile` on `SessionManager` — add a getter:
```js
get sessionsFile() { return SESSIONS_FILE; }
```

**Enrich `sessionEnd` broadcast** at lines 53-62 — add feature fields:
```js
broadcastMessage({
  type: 'sessionEnd',
  sessionId: session.id,
  reason,
  toolCount: session.toolCount,
  duration: ...,
  journalSpawned,
  featureCode: session.featureCode || null,    // NEW
  phaseAtEnd: session.phaseAtEnd || null,       // NEW
  timestamp: new Date().toISOString(),
});
```

**Enrich `GET /api/session/current`** response at lines 79-84 — add binding fields:
```js
featureCode: session.featureCode || null,
featureItemId: session.featureItemId || null,
phaseAtBind: session.phaseAtBind || null,
boundAt: session.boundAt || null,
```

### 4. `server/activity-routes.js` (existing)

**Phase enrichment** — at line 84, change the items mapping:
```js
// FROM:
items: items.map(i => ({ id: i.id, title: i.title, status: i.status }))
// TO:
items: items.map(i => ({ id: i.id, title: i.title, status: i.status, phase: i.lifecycle?.currentPhase || null }))
```

One-line change. Non-breaking — existing clients ignore unknown fields.

### 5. `server/vision-store.js` (existing)

**New method** — after `getGatesForItem` at line 254:
```js
getItemByFeatureCode(featureCode) {
  for (const item of this.items.values()) {
    if (item.lifecycle?.featureCode === featureCode) return item;
  }
  return null;
}
```

### 6. `server/vision-server.js` (existing)

**Pass `store` to session routes** — at lines 52-58, add `store: this.store`:
```js
attachSessionRoutes(app, {
  sessionManager: this.sessionManager,
  scheduleBroadcast: () => this.scheduleBroadcast(),
  broadcastMessage: (msg) => this.broadcastMessage(msg),
  spawnJournalAgent: ...,
  store: this.store,          // NEW
});
```

**Inject `getFeaturePhase` into SessionManager** — `SessionManager` is constructed in `index.js:57` as `new SessionManager()`, not in `vision-server.js`. Change to:
```js
const sessionManager = new SessionManager({
  getFeaturePhase: (featureCode) => {
    const item = visionStore.getItemByFeatureCode(featureCode);
    return item?.lifecycle?.currentPhase || null;
  },
  featureRoot: path.join(process.cwd(), 'docs', 'features'),
});
```
Note: `visionStore` is constructed at line 56, one line before `sessionManager`, so it's available.

### 7. `server/compose-mcp-tools.js` (existing)

**New tool `toolBindSession`** — after `toolGetCurrentSession` at line 173:
```js
export async function toolBindSession({ featureCode }) {
  const postData = JSON.stringify({ featureCode });
  return new Promise((resolve, reject) => {
    const url = new URL(`${_getComposeApi()}/api/session/bind`);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve({ raw: body }); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}
```

Follows the exact pattern of `_postLifecycle` (line 179).

**Modify `toolGetCurrentSession`** — change to async and add optional `featureCode` parameter at line 148. When `featureCode` is provided, delegate to the Compose REST API (MCP tools run in a separate process and cannot access `SessionManager` directly):

```js
export async function toolGetCurrentSession({ featureCode } = {}) {
  if (featureCode) {
    // Delegate to REST API which can access the live session + lifecycle state
    return _getSessionContext(featureCode);
  }
  // Existing disk-read path for generic (no featureCode) case
  const sessions = loadSessions();
  if (sessions.length === 0) return { session: null };
  // ... existing code ...
}

async function _getSessionContext(featureCode) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${_getComposeApi()}/api/session/current?featureCode=${encodeURIComponent(featureCode)}`);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: 'GET' },
      (res) => {
        let buf = '';
        res.on('data', chunk => buf += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); } catch { resolve({ session: null }); }
        });
      },
    );
    req.on('error', () => resolve({ session: null }));
    req.end();
  });
}
```

**Corresponding REST change** — `GET /api/session/current` gains an optional `featureCode` query param:
```js
app.get('/api/session/current', (_req, res) => {
  const { featureCode } = _req.query;
  if (!sessionManager?.currentSession) {
    if (featureCode) {
      return res.json(_buildFeatureContext(featureCode, null));
    }
    return res.json({ session: null });
  }
  const s = sessionManager.currentSession;
  // ... existing session serialization ...
  // Add binding fields:
  const sessionData = {
    id: s.id, startedAt: s.startedAt, source: s.source, toolCount: s.toolCount,
    blockCount: s.blocks.length, errorCount: (s.errors || []).length, items,
    summaries: allSummaries,
    featureCode: s.featureCode || null,
    featureItemId: s.featureItemId || null,
    phaseAtBind: s.phaseAtBind || null,
    boundAt: s.boundAt || null,
  };

  // When featureCode requested and active session is bound to THAT feature:
  // return the live session + lifecycle enrichment
  if (featureCode && s.featureCode === featureCode) {
    return res.json(_buildFeatureContext(featureCode, sessionData));
  }

  // When featureCode requested but active session is for a DIFFERENT feature:
  // return the last persisted session for the requested feature, not the unrelated active session
  if (featureCode && s.featureCode !== featureCode) {
    return res.json(_buildFeatureContext(featureCode, null));
  }

  // No featureCode requested — return generic active session (existing behavior)
  res.json({ session: sessionData });
});

// Helper: normalize feature-aware response shape across all branches
// Always returns { session, lifecycle, recentSummaries } when featureCode is present
function _buildFeatureContext(featureCode, sessionData) {
  const item = store.getItemByFeatureCode(featureCode);
  const recentSessions = readSessionsByFeature(featureCode, 3, sessionManager.sessionsFile);
  const recentSummaries = recentSessions
    .flatMap(rs => Object.values(rs.items || {}).flatMap(i => i.summaries || []))
    .slice(-10);
  return {
    session: sessionData || recentSessions[0] || null,
    lifecycle: item?.lifecycle ? {
      currentPhase: item.lifecycle.currentPhase,
      phaseHistory: (item.lifecycle.phaseHistory || []).map(h => ({ phase: h.phase, enteredAt: h.enteredAt, exitedAt: h.exitedAt })),
      artifacts: item.lifecycle.artifacts || {},
      pendingGate: item.lifecycle.pendingGate || null,
    } : null,
    recentSummaries,
  };
}
```

This ensures the compose skill's post-bind call to `get_current_session({ featureCode })` returns the live in-memory session with lifecycle enrichment, not stale disk data.

### 8. `server/compose-mcp.js` (existing)

**Add tool definition** in `TOOLS` array (after line 233 or wherever get_current_session is defined):
```js
{
  name: 'bind_session',
  description: 'Bind the current agent session to a lifecycle feature. Call once per session after creating/identifying the feature. Binding is one-shot — calling again on a bound session returns already_bound.',
  inputSchema: {
    type: 'object',
    properties: {
      featureCode: { type: 'string', description: 'The feature code (e.g., "gate-ui")' },
    },
    required: ['featureCode'],
  },
},
```

**Update `get_current_session` schema** — add optional `featureCode`:
```js
// Find existing get_current_session entry, add to properties:
featureCode: { type: 'string', description: 'Optional: get context for a specific feature' },
```

**Update dispatch** at line 258 — now async since featureCode path makes HTTP request:
```js
// FROM:
case 'get_current_session': result = toolGetCurrentSession(); break;
// TO:
case 'get_current_session': result = await toolGetCurrentSession(args); break;
```

**Add dispatch case:**
```js
case 'bind_session': result = await toolBindSession(args); break;
```

**Add import** at line 29-44:
```js
import { ..., toolBindSession } from './compose-mcp-tools.js';
```

### 9. `src/components/vision/useVisionStore.js` (existing)

**Enrich `sessionStart` handler** at lines 138-147 — add binding fields to initial shape:
```js
setSessionState(prev => {
  if (prev && prev.id === msg.sessionId) return { ...prev, active: true };
  return {
    id: msg.sessionId, active: true, startedAt: msg.timestamp,
    source: msg.source, toolCount: 0, errorCount: 0, summaries: [],
    featureCode: null, featureItemId: null, phaseAtBind: null, boundAt: null,  // NEW
  };
});
```

**New `sessionBound` handler** — insert after `sessionSummary` block at line 163:
```js
} else if (msg.type === 'sessionBound') {
  setSessionState(prev => prev ? {
    ...prev,
    featureCode: msg.featureCode,
    featureItemId: msg.itemId,
    phaseAtBind: msg.phase,
    boundAt: msg.timestamp,
  } : prev);
```

**Enrich `sessionEnd` handler** at lines 148-156 — add feature fields:
```js
// Inside the spread, add:
featureCode: msg.featureCode || prev?.featureCode || null,
phaseAtEnd: msg.phaseAtEnd || null,
```

**Enrich hydration** at lines 209-223 — add binding fields to hydrated shape:
```js
featureCode: data.session.featureCode || null,
featureItemId: data.session.featureItemId || null,
phaseAtBind: data.session.phaseAtBind || null,
boundAt: data.session.boundAt || null,
```

### 10. `src/components/vision/AgentPanel.jsx` (existing)

**Add `onSelectItem` prop** to function signature at line 53:
```js
AgentPanel({ agentActivity, agentErrors, sessionState, onSelectItem })
```

**Add feature context header** — inside the `{sessionState && (...)}` block, before line 97:
```jsx
{sessionState?.featureCode && (
  <div className="px-3 py-1.5 mb-1 rounded bg-muted/50">
    <div className="flex items-center gap-1.5 text-[10px]">
      <span className="text-muted-foreground">Working on</span>
      <button
        className="font-medium text-foreground hover:underline"
        onClick={() => sessionState.featureItemId && onSelectItem?.(sessionState.featureItemId)}
      >
        {sessionState.featureCode}
      </button>
    </div>
    {sessionState.phaseAtBind && (
      <div className="text-[10px] text-muted-foreground mt-0.5">
        Phase: {sessionState.phaseAtBind.replace(/_/g, ' ')}
      </div>
    )}
  </div>
)}
```

### 11. `src/components/vision/VisionTracker.jsx` (existing)

**Thread `onSelectItem` to AppSidebar** — `AgentPanel` is rendered inside `AppSidebar` (at `AppSidebar.jsx:137`), not in `VisionTracker`. Add `onSelectItem` to the `AppSidebar` props at line 125:
```jsx
<AppSidebar
  items={items}
  activeView={activeView}
  onViewChange={setActiveView}
  // ... existing props ...
  onSelectItem={handleSelect}  // NEW — reuse existing handleSelect
/>
```

### 11b. `src/components/vision/AppSidebar.jsx` (existing)

**Add `onSelectItem` prop** to function signature at line 68:
```jsx
function AppSidebar({ ..., onSelectItem }) {
```

**Thread to AgentPanel** at line 137:
```jsx
<AgentPanel
  agentActivity={agentActivity}
  agentErrors={agentErrors}
  sessionState={sessionState}
  onSelectItem={onSelectItem}  // NEW
/>
```

### 12. `src/components/vision/ItemDetailPanel.jsx` (existing)

**Add session history section** — after ConnectionGraph block (line 358), before evidence blocks (line 360):

```jsx
{item.lifecycle?.featureCode && (
  <SessionHistory featureCode={item.lifecycle.featureCode} />
)}
```

**`SessionHistory` as a local component** within `ItemDetailPanel.jsx`:
```jsx
function SessionHistory({ featureCode }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/session/history?featureCode=${encodeURIComponent(featureCode)}&limit=10`)
      .then(r => r.json())
      .then(data => setSessions(data.sessions || []))
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, [featureCode]);

  if (loading) return null;
  if (sessions.length === 0) return null;

  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1.5">
        Sessions ({sessions.length})
      </div>
      <div className="space-y-2">
        {sessions.map(s => (
          <div key={s.id} className="text-xs text-muted-foreground border-l-2 border-border pl-2">
            <div className="font-medium text-foreground">
              {s.phaseAtBind?.replace(/_/g, ' ') || '—'}
              {s.phaseAtEnd && s.phaseAtEnd !== s.phaseAtBind && ` → ${s.phaseAtEnd.replace(/_/g, ' ')}`}
            </div>
            <div>{s.toolCount} tools · {Math.round((new Date(s.endedAt) - new Date(s.startedAt)) / 60000)}m</div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

Add `useState, useEffect` to imports if not already present.

### 13. `test/session-binding.test.js` (new)

Golden flow tests:

1. **Bind session to feature** — start session, bind with featureCode, verify session fields set, verify `sessionBound` broadcast
2. **Already-bound rejection** — bind once, bind again, verify `already_bound: true` returned, no mutation
3. **Phase capture on end** — bind session, advance lifecycle phase, end session, verify `phaseAtEnd` captured
4. **Transcript auto-filing** — bind session, end with transcriptPath, verify file copied to `docs/features/<code>/sessions/<id>.<ext>`
5. **Session history query** — persist 3 sessions (2 bound to feature A, 1 to feature B), query history for A, verify 2 returned in descending order
6. **Feature-aware handoff context** — persist bound session, call `getContext(featureCode)`, verify feature-scoped session returned
7. **Activity phase enrichment** — POST activity with resolved item that has lifecycle, verify `agentActivity` broadcast includes `phase` field
8. **Unbound session end** — end session without binding, verify no transcript filing, no `phaseAtEnd`
9. **Bind to feature with no lifecycle item** — bind with featureCode that has no vision item, verify `itemId: null, phase: null`, session still bound

Error-path tests via table-driven harness:
- `POST /api/session/bind` with no active session → 409
- `POST /api/session/bind` with missing featureCode → 400
- `GET /api/session/history` with missing featureCode → 400

---

## Verification Checklist

All line references verified against actual code on 2026-03-06:

- [x] `session-manager.js:64-74` — session object fields: id, startedAt, source, toolCount, items (Map), currentBlock, blocks, commits, errors
- [x] `session-manager.js:198-200` — `getContext()` takes no args, returns `readLastSession(SESSIONS_FILE)`
- [x] `session-manager.js:100` — `if (transcriptPath) session.transcriptPath = transcriptPath`
- [x] `session-manager.js:26` — constructor takes no args: `constructor()`
- [x] `session-store.js:16-33` — `serializeSession` returns: id, startedAt, endedAt, endReason, source, toolCount, items, blocks, commits, errors, transcriptPath
- [x] `session-store.js:71-82` — `readLastSession` reads from file, returns last element
- [x] `session-routes.js:22` — `attachSessionRoutes(app, { sessionManager, scheduleBroadcast, broadcastMessage, spawnJournalAgent })` — no `store`, no `projectRoot` in destructured deps (JSDoc at line 19 mentions `projectRoot` but it's not destructured)
- [x] `session-routes.js:53-61` — `sessionEnd` broadcast: type, sessionId, reason, toolCount, duration, journalSpawned, timestamp
- [x] `session-routes.js:79-84` — current response: id, startedAt, source, toolCount, blockCount, errorCount, items, summaries
- [x] `activity-routes.js:84` — `items: items.map(i => ({ id: i.id, title: i.title, status: i.status }))`
- [x] `vision-store.js:254-255` — `getGatesForItem` is last method, class closes at 255
- [x] `vision-server.js:52-58` — `attachSessionRoutes` called with `sessionManager`, `scheduleBroadcast`, `broadcastMessage`, `spawnJournalAgent`, `projectRoot`
- [x] `index.js:57` — `const sessionManager = new SessionManager()` — no args. `visionStore` constructed at line 56 (available)
- [x] `compose-mcp-tools.js:148` — `export function toolGetCurrentSession()` — no params
- [x] `compose-mcp-tools.js:179-208` — `_getComposeApi()` + `_postLifecycle` HTTP pattern confirmed
- [x] `compose-mcp.js:258` — `case 'get_current_session': result = toolGetCurrentSession(); break;` — no args
- [x] `compose-mcp.js:29-44` — import block, `toolGetCurrentSession` imported
- [x] `useVisionStore.js:138-147` — `sessionStart` handler: id, active, startedAt, source, toolCount, errorCount, summaries
- [x] `useVisionStore.js:148-156` — `sessionEnd` handler: spreads prev, sets active, endedAt, toolCount, duration, journalSpawned
- [x] `useVisionStore.js:157-163` — `sessionSummary` block: summary, intent, component, timestamp
- [x] `useVisionStore.js:209-222` — hydration: id, active, startedAt, source, toolCount, errorCount, summaries
- [x] `AgentPanel.jsx:53` — `function AgentPanel({ agentActivity, agentErrors, sessionState })`
- [x] `AgentPanel.jsx:96-118` — session info block inside `{sessionState && (...)}`, starts with `<div className="px-3 pb-1">`
- [x] `AppSidebar.jsx:137-141` — `<AgentPanel agentActivity={...} agentErrors={...} sessionState={...} />`
- [x] `AppSidebar.jsx:68-80` — function signature, does not include `onSelectItem`
- [x] `VisionTracker.jsx:125-137` — `<AppSidebar>` props, no `onSelectItem`
- [x] `ItemDetailPanel.jsx:352-360` — ConnectionGraph ends at 358, Evidence starts at 360
