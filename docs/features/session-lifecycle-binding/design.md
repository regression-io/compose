# Session-Lifecycle Binding: Design

**Status:** COMPLETE
**Date:** 2026-03-06
**Roadmap item:** 26 (Phase 6, L5)

## Related Documents

- [Lifecycle State Machine Design](../lifecycle-state-machine/design.md) — L1 (dependency)
- [Lifecycle Engine Roadmap](../../plans/2026-02-15-lifecycle-engine-roadmap.md) — Layer 5 context
- [Session Tracking Design](../session-tracking/design.md) — Phase 3 (dependency, COMPLETE)
- [Compose Skill](../../../.claude/skills/compose/SKILL.md) — session-lifecycle expectations

---

## Problem

Sessions and lifecycle features are two independent tracking systems that don't know about each other. The session manager accumulates per-item activity, Haiku summaries, and work blocks. The lifecycle manager tracks which phase each feature is in. But:

1. **No session-to-feature binding** — a session has no `featureCode` or `featureItemId`. When an agent works on feature `gate-ui` for 45 minutes, the session records tool counts and touched items, but doesn't know it was a `gate-ui` session.
2. **No phase context** — activity events include resolved item IDs but not the lifecycle phase those items are in. A Write to `blueprint.md` during the `blueprint` phase is indistinguishable from a Write during `execute`.
3. **No feature-grouped activity** — the AgentPanel shows a chronological activity feed. There's no view of "all sessions that worked on feature X" or "activity for feature X across sessions."
4. **No auto-filing of transcripts** — transcripts go to `docs/journal/` regardless of which feature was being worked on. The compose skill expects transcripts in `docs/features/<featureCode>/sessions/`.
5. **No handoff context** — `getContext()` returns the last session regardless of feature. A new session on `gate-ui` should receive `gate-ui`'s lifecycle context (current phase, artifacts, recent summaries), not the last session's generic context.

## Goal

Bind sessions to lifecycle features so that activity, summaries, transcripts, and handoff context are feature-aware. The session becomes a first-class participant in the lifecycle — you can see which sessions worked on which features, in which phases, and what they accomplished.

Scope: server-side session model changes, API additions, WebSocket message enrichment, and client-side display. No changes to the lifecycle state machine itself.

---

## Decision 1: Binding Model

A session can be bound to **at most one feature** at a time. Binding is explicit — triggered by the compose skill (or agent) calling a new endpoint, not inferred from file paths.

**Why explicit over inferred:**
- File-path inference is fragile — an agent might read 5 features' files while exploring, but is only "working on" one
- The compose skill already knows which feature it's operating on — it creates the feature folder and tracks the feature code
- Explicit binding is auditable — you can see exactly when and why a session was bound

**Binding fields on session:**

```js
{
  // Existing fields...

  // New binding fields:
  featureCode: null,        // string — e.g. 'gate-ui'
  featureItemId: null,      // string — Vision item ID
  phaseAtBind: null,        // string — lifecycle phase when binding happened
  boundAt: null,            // ISO timestamp
}
```

**Binding is one-shot and immutable.** Once bound, a session stays bound to that feature until it ends. Calling `bind` on an already-bound session returns `{ already_bound: true }` without modifying the binding. This matches the compose skill's model — a compose invocation works on one feature per session — and preserves provenance (transcript filing, `phaseAtBind`, and history records are never rewritten).

**Unbinding:** Not supported. If the agent switches features mid-session (unusual), the session stays tagged to the original feature. The per-item accumulators still track all items touched, so no data is lost — the binding just indicates the primary feature.

**Late binding is expected.** The compose skill creates the feature folder and vision item during Phase 1 exploration. Only after that can it call `bind_session`. This means the session starts unbound and binds partway through — see Decision 6 for how handoff context handles this timing.

---

## Decision 2: Binding API

New endpoint:

```
POST /api/session/bind
Body: { featureCode: string }
```

Behavior:
1. Validate that a session is currently active
2. If session is already bound, return `{ already_bound: true, featureCode: session.featureCode }` (HTTP 200, no mutation)
3. Look up the Vision item with `lifecycle.featureCode === featureCode`
4. If found, capture `item.id`, `item.lifecycle.currentPhase`
5. Set `session.featureCode`, `session.featureItemId`, `session.phaseAtBind`, `session.boundAt`
6. Broadcast `sessionBound` WebSocket message
7. Return `{ bound: true, featureCode, itemId, phase }`

If no matching item is found (feature exists on disk but has no lifecycle), bind with `featureItemId: null` and `phaseAtBind: null`. The session is still feature-tagged for transcript filing and history, just not lifecycle-aware.

### MCP Tool

New tool: `bind_session({ featureCode })` — delegates to `POST /api/session/bind`. The compose skill calls this at the start of Phase 1 after creating the feature folder.

---

## Decision 3: Phase Snapshot on Session End

When a bound session ends, capture the feature's current phase at that moment:

```js
{
  // On session end, added to serialized session:
  phaseAtEnd: 'blueprint',  // lifecycle.currentPhase at session end time
}
```

This gives the session record a phase range: `phaseAtBind → phaseAtEnd`. A session that started in `explore_design` and ended in `blueprint` clearly made progress through two phases. A session that started and ended in `execute` was a pure implementation session.

---

## Decision 4: Activity Enrichment

When `recordActivity` resolves items that have a lifecycle, the activity broadcast includes the lifecycle phase:

Current `agentActivity` message:
```json
{ "type": "agentActivity", "tool": "Write", "items": [{ "id": "...", "title": "..." }] }
```

Enriched:
```json
{ "type": "agentActivity", "tool": "Write", "items": [{ "id": "...", "title": "...", "phase": "blueprint" }] }
```

This is a non-breaking addition — existing clients ignore the `phase` field. The enrichment happens in `activity-routes.js` where `resolvedItems` are already available — look up each item's `lifecycle?.currentPhase` and attach it.

---

## Decision 5: Transcript Auto-Filing

When a bound session ends with a `transcriptPath`:

1. Copy (not move) the transcript to `docs/features/<featureCode>/sessions/<session-id><original-extension>`
2. The original journal filing continues unchanged — the journal gets the narrative, the feature folder gets the raw transcript

**Why copy, not move:** The journal serves a different purpose (human-readable narrative). The feature-folder transcript is the raw record for the lifecycle. Both are valuable.

**Naming and format:** The copied file preserves the original transcript's extension (typically `.jsonl` from Claude Code). The filename is `<session-id><ext>` — e.g., `session-1709123456.jsonl`. This avoids mislabeling raw transcript data as Markdown. If the transcript path has no extension, `.transcript` is used as the fallback.

**Implementation:** Add a `fileTranscript(session)` step to `endSession()` in `session-manager.js`. Only fires when `session.featureCode` is set and `transcriptPath` is non-null. Uses `fs.copyFile` — no new dependencies.

---

## Decision 6: Feature-Aware Handoff Context

`getContext()` currently returns the last session. With binding, it gains feature awareness:

```
getContext(featureCode?)
```

- If `featureCode` is provided: return the last session bound to that feature (from `data/sessions.json`)
- If not provided: return the last session (existing behavior)

The handoff context for a feature-bound session includes:

```js
{
  lastSession: {
    id, featureCode, phaseAtBind, phaseAtEnd,
    toolCount, duration, summaries,   // existing
  },
  lifecycle: {
    currentPhase,
    phaseHistory,     // abbreviated — just phase names and durations
    artifacts,        // which artifacts exist
    pendingGate,      // if there's a gate waiting
  },
  recentSummaries: [...]  // Haiku summaries from the last 3 sessions on this feature
}
```

### Timing: Two-Phase Context Injection

The `SessionStart` hook fires before the compose skill runs, so it cannot know the `featureCode` yet. Context injection happens in two stages:

1. **At session start** — `SessionStart` hook calls `getContext()` (no featureCode). Returns generic last-session context. This is unchanged from today.
2. **After binding** — The compose skill calls `bind_session({ featureCode })`, then immediately calls `get_current_session({ featureCode })` to retrieve the enriched feature-aware context. The skill injects this into its own working context (not via a hook — via the MCP tool response).

This means the first few seconds of a session use generic context, then the compose skill self-enriches once it knows which feature it's working on. No changes to the `SessionStart` hook are needed.

### MCP Tool

Existing `get_current_session` tool gains an optional `featureCode` parameter. When provided, returns the enriched feature-aware context.

---

## Decision 7: Feature Session History Query

New endpoint:

```
GET /api/session/history?featureCode=<code>&limit=10
```

Returns the last N sessions bound to the given feature, ordered by `startedAt` descending. Each session record includes `phaseAtBind`, `phaseAtEnd`, `toolCount`, `duration`, and summary count.

This powers the "session history" section in the item detail panel — showing all sessions that worked on a feature with their phase ranges and outcomes.

### VisionStore Addition

```
store.getItemByFeatureCode(featureCode) → item | null
```

Linear scan of `store.items.values()` checking `item.lifecycle?.featureCode`. No index needed — the number of lifecycle items is small (typically < 50).

---

## Decision 8: WebSocket Messages

New message:

```json
{
  "type": "sessionBound",
  "sessionId": "session-...",
  "featureCode": "gate-ui",
  "itemId": "...",
  "phase": "explore_design",
  "timestamp": "ISO8601"
}
```

Broadcast on `POST /api/session/bind`. The client uses this to update `sessionState` with the bound feature info.

Enriched existing messages:

- `sessionStart` — no change (binding happens after start)
- `sessionEnd` — add `featureCode` and `phaseAtEnd` fields (non-breaking)

---

## Decision 9: Client-Side Display

### AgentPanel Enrichment

When the session is bound, `AgentPanel.jsx` shows a feature context header:

```
┌─────────────────────────────────┐
│ Working on: gate-ui             │
│ Phase: blueprint                │
│ ⏱ 12m · 47 tools · 0 errors   │
└─────────────────────────────────┘
```

The feature name is clickable — navigates to the item in the detail panel.

### ItemDetailPanel Session History

When viewing an item with a lifecycle, the detail panel gains a "Sessions" section below the lifecycle section:

```
┌─────────────────────────────────┐
│ Sessions                    [3] │
│                                 │
│ session-1709... · 45m           │
│ explore_design → blueprint      │
│ 82 tools · 3 summaries         │
│                                 │
│ session-1709... · 12m           │
│ blueprint → blueprint           │
│ 23 tools · 1 summary           │
└─────────────────────────────────┘
```

Data fetched from `GET /api/session/history?featureCode=<code>` on item selection. Cached in component state — not in the global store (session history is item-specific, not global).

---

## Decision 10: What This Does NOT Do

- **No multi-feature binding** — one feature per session. Multi-feature work is tracked via per-item accumulators (existing).
- **No automatic binding from file paths** — binding is explicit via API call.
- **No session splitting** — if an agent works on two features in one session, the session is tagged to the first. Future work could add re-binding or split sessions.
- **No UI for manual binding** — binding is agent-initiated via MCP tool. The human sees the result, not the trigger.
- **No changes to lifecycle state machine** — this layer reads lifecycle state, it doesn't modify transitions.
- **No session-based phase inference** — the lifecycle manager determines phases, not session activity patterns.

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `server/session-manager.js` | **Edit** | Add binding fields to session model, `bindToFeature()` method, phase snapshot on end, transcript auto-filing |
| `server/session-store.js` | **Edit** | Add `featureCode`/`featureItemId`/`phaseAtBind`/`phaseAtEnd` to serialization, add `readSessionsByFeature()` |
| `server/session-routes.js` | **Edit** | Add `POST /api/session/bind` and `GET /api/session/history` endpoints |
| `server/activity-routes.js` | **Edit** | Enrich `agentActivity` broadcast with `phase` field on resolved items |
| `server/vision-store.js` | **Edit** | Add `getItemByFeatureCode()` method |
| `server/vision-server.js` | **Edit** | Add `sessionBound` broadcast, enrich `sessionEnd` with feature fields |
| `server/compose-mcp-tools.js` | **Edit** | Add `bind_session` tool, add `featureCode` param to `get_current_session` |
| `server/compose-mcp.js` | **Edit** | Add tool definitions + switch cases |
| `src/components/vision/useVisionStore.js` | **Edit** | Handle `sessionBound` message, add feature fields to `sessionState` |
| `src/components/vision/AgentPanel.jsx` | **Edit** | Add feature context header when session is bound |
| `src/components/vision/ItemDetailPanel.jsx` | **Edit** | Add session history section for lifecycle items |
| `test/session-binding.test.js` | **Create** | Binding lifecycle, transcript filing, history query, handoff context tests |
