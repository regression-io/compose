# COMP-UX-2b: Fix Broken Views — Implementation Blueprint

**Status:** BLUEPRINT
**Date:** 2026-03-27
**Design:** [design.md](design.md)

---

## File Plan

| File | Action | Purpose |
|------|--------|---------|
| `server/vision-server.js` (existing) | modify | Include sessions in visionState broadcast |
| `server/session-manager.js` (existing) | modify | Add `getRecentSessions()` method |
| `src/components/vision/SessionsView.jsx` (existing) | modify | Wire real data from store |
| `src/components/vision/PipelineView.jsx` (existing) | modify | Use dynamic steps when build active |
| `server/design-routes.js` (existing) | modify | Create gate after design completion |
| `src/components/vision/SettingsPanel.jsx` (existing) | modify | Fix VIEWS constant |
| `src/components/vision/GraphView.jsx` (existing) | modify | Empty state + dynamic prefixes |

---

## Fix 1: Sessions — Wire the Data

### Server: session-manager.js

Add `getRecentSessions(limit)` method. SessionManager already tracks currentSession and persists via session-store.js. Need a method that returns an array of recent sessions for the WS broadcast.

```javascript
// Add after existing methods (~line 194)
getRecentSessions(limit = 20) {
  const sessions = [];
  if (this.currentSession) {
    sessions.push(this._serializeSession(this.currentSession));
  }
  // Read persisted sessions from session-store
  const persisted = this.sessionStore?.getRecent?.(limit) || [];
  sessions.push(...persisted);
  return sessions.slice(0, limit);
}
```

Need to check if session-store.js has a `getRecent()` method. If not, read from the sessions JSON file directly.

### Server: vision-server.js

**Line 237-238** (`broadcastState`): Add sessions to the spread.
**Lines 245-247** (initial client state): Same addition.

```javascript
// Line 238:
broadcastState() {
  this.broadcastMessage({
    type: 'visionState',
    ...this.store.getState(),
    sessions: this.sessionManager?.getRecentSessions?.() || [],
  });
}

// Line 245 (initial send to new WS client):
ws.send(JSON.stringify({
  type: 'visionState',
  ...this.store.getState(),
  sessions: this.sessionManager?.getRecentSessions?.() || [],
}));
```

### Client: Already wired

- `visionMessageHandler.js` line 47: `setSessions(msg.sessions || [])` — already handles the array
- `useVisionStore.js` line 231: `sessions: []` — state field exists
- `App.jsx` line 354: `sessions` extracted from store selector
- SessionsView receives `sessions` as prop

**No client changes needed for basic wiring.** The data just needs to arrive.

### SessionsView data shape

The component expects (from lines 40-78):
```javascript
{
  id, status, agent, featureCode, summary, startedAt,
  reads, writes, errors, workType
}
```

The serialized session from SessionManager has:
```javascript
{
  id, startedAt, source, toolCount, featureCode, featureItemId,
  phaseAtBind, items: Map, errors: [], ...
}
```

Need to map: `status` (derive from active flag), `agent` (always 'claude' for now), `reads`/`writes` (sum from items Map), `errors` (array length), `workType` (derive from phaseAtBind).

Do this mapping in `getRecentSessions()` on the server.

---

## Fix 2: Pipeline — Dynamic Steps

### Current state

PipelineView (line 49) reads from `PIPELINE_STEPS` constant (24 hardcoded steps). `activeBuild` overlays live status via `liveStatusMap` (lines 25-28).

### Change

When `activeBuild?.steps` exists and is an array, use those as the step source instead of `PIPELINE_STEPS`. Fall back to the constant when no build is active.

```javascript
// PipelineView line 49, replace:
const steps = PIPELINE_STEPS.filter(s => s.phase === phase);

// With:
const dynamicSteps = activeBuild?.steps?.length > 0;
const stepSource = dynamicSteps
  ? activeBuild.steps.map(s => ({
      ...PIPELINE_STEPS.find(t => t.id === s.id) || { id: s.id, name: s.id, agent: 'claude', phase: 'implementation' },
      ...s,
    }))
  : PIPELINE_STEPS;

const phaseGroups = Object.keys(PIPELINE_PHASE_CONFIG).map(phase => ({
  phase,
  config: PIPELINE_PHASE_CONFIG[phase],
  steps: stepSource.filter(s => s.phase === phase),
}));
```

This merges live step data with static metadata (name, agent, phase) from the constant.

---

## Fix 3: Design — Connect to Lifecycle

### Server: design-routes.js

After the design doc is written (~line 375), add gate creation:

```javascript
// After doc write succeeds:
// Create gate if policy mode is 'gate'
const settings = settingsStore?.get?.() || {};
const policyMode = settings.phases?.explore_design || 'gate';

if (policyMode === 'gate' && featureItemId) {
  const gate = {
    flowId: `design-${featureCode}`,
    stepId: 'design_gate',
    round: 1,
    itemId: featureItemId,
    artifact: designDocPath,
    fromPhase: 'explore_design',
    toPhase: 'prd',
    summary: 'Design doc generated. Approve to advance.',
    policyMode: 'gate',
  };
  store.createGate(gate);
  broadcastMessage({ type: 'gatePending', ...gate });
}
```

Need to verify: does design-routes.js have access to `store`, `settingsStore`, and `broadcastMessage`? Check the route attachment function signature.

### Client: No changes needed

DesignView already shows completion state (line 115-133). GateView will pick up the new gate automatically via WebSocket.

---

## Fix 4: Settings — Clean Ghost Views

### SettingsPanel.jsx line 4

```javascript
// Current:
const VIEWS = ['attention', 'gates', 'roadmap', 'list', 'board', 'tree', 'graph', 'docs', 'settings'];

// Fixed:
const VIEWS = ['graph', 'tree', 'pipeline', 'gates', 'docs', 'design', 'sessions', 'settings'];
```

Matches the actual routable views in App.jsx CockpitView switch (lines 223-297). Order matches the tab bar.

---

## Fix 5: Graph — Empty State + Dynamic Prefixes

### Empty state (GraphView.jsx ~line 684)

Wrap the Cytoscape container in a conditional:

```jsx
{filteredItems.length === 0 ? (
  <div className="flex-1 flex items-center justify-center">
    <div style={{ textAlign: 'center', color: '#64748b', fontSize: 12 }}>
      <div style={{ marginBottom: 6 }}>No items match the current filters</div>
      <div style={{ fontSize: 11, color: '#475569' }}>
        Try adjusting the status or group filters
      </div>
    </div>
  </div>
) : (
  <div className="flex-1 relative min-h-0">
    <div ref={containerRef} className="w-full h-full" />
    {/* ... existing overlays ... */}
  </div>
)}
```

### Dynamic prefixes (GraphView.jsx lines 60-82)

Replace hardcoded `KNOWN_PREFIXES` with a function that derives prefixes from item data:

```javascript
function deriveGroups(items) {
  const groups = new Set();
  for (const item of items) {
    const title = item.title || '';
    const match = title.match(/^([A-Z]+-[A-Z]+)/);
    if (match) groups.add(match[1]);
    const fc = item.lifecycle?.featureCode || item.featureCode;
    if (fc) {
      const fcMatch = fc.match(/^([A-Z]+-[A-Z]+)/);
      if (fcMatch) groups.add(fcMatch[1]);
    }
  }
  return groups;
}
```

Call in `buildElements()` instead of iterating `KNOWN_PREFIXES`. The `getGroup()` function uses the derived set.

---

## Corrections Table

| Spec Assumption | Reality | Resolution |
|----------------|---------|------------|
| Design said "Sessions WS stub" | `setSessions` already wired in message handler (line 47) + store (line 231). Only server broadcast missing. | Server-only fix for basic wiring |
| Design said "Pipeline hardcoded" | Steps overlay live status correctly via `liveStatusMap`. Issue is step list itself is static. | Merge dynamic steps with static metadata |
| Design said "Design disconnected from lifecycle" | design-routes.js writes design.md to feature folder. Missing: gate creation. | Add gate creation in design-routes after doc write |
| Design said "No general sessions list endpoint" | `GET /api/session/history?featureCode=` exists. But visionState broadcast is the real feed. | Use broadcast, not REST polling |
| Assumed `sessionStore.getRecent()` exists | Need to verify session-store.js API | May need to read persisted sessions from disk |
