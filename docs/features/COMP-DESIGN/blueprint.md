# COMP-DESIGN Wave 0 Blueprint

**Items:** 85 (COMP-DESIGN-1c — Live Design Doc), 86 (COMP-DESIGN-1d — Research Sidebar)
**Scope:** Two UI features on the existing design conversation view.

## Related Documents

- `ROADMAP.md` items 85–86 (COMP-DESIGN)
- `compose/server/design-routes.js` — REST + SSE API
- `compose/server/design-session.js` — session persistence
- `compose/src/components/vision/DesignView.jsx` — main conversation UI
- `compose/src/components/vision/DesignSidebar.jsx` — decision log sidebar
- `compose/src/components/vision/useDesignStore.js` — Zustand store
- `compose/src/components/vision/designSessionState.js` — pure state logic

---

## Current Architecture

### Layout

```
┌──────────────────────────────────────────────────────┐
│ Header: [ViewTabs]                                   │
├──────────┬────────────────────────┬──────────────────┤
│ SIDEBAR  │  MAIN: DesignView     │  CONTEXT PANEL   │
│ (220px)  │  (conversation thread) │  (420px, toggle) │
│          │                        │                  │
│ Decision │  Messages + Cards      │  ItemDetailPanel │
│ Log      │  Input area            │  (unrelated to   │
│          │  Complete button       │   design today)  │
├──────────┴────────────────────────┴──────────────────┤
│ OpsStrip │ AgentBar │ NotificationBar                │
└──────────────────────────────────────────────────────┘
```

- DesignView renders in main content area via switch in `App.jsx:328`
- DesignSidebar replaces AttentionQueueSidebar when `activeView === 'design'` (`App.jsx:1035-1084`)
- Context panel currently shows ItemDetailPanel or ContextStepDetail — no design-specific content

### Data Flow

```
Human input → useDesignStore.sendMessage() → POST /api/design/message
  → Server appends to session, dispatches LLM agent (fire-and-forget)
  → LLM streams via ClaudeSDKConnector
  → Server parses text/decision/done events
  → SSE broadcast → useDesignStore.connectSSE() handlers
  → DesignView re-renders from store state
```

### Session Model (design-session.js)

```javascript
{
  id: string,
  scope: 'product' | 'feature',
  featureCode: string | null,
  messages: [{ role, type, content, timestamp }],
  decisions: [{ question, selectedOption, comment, timestamp, superseded }],
  status: 'active' | 'complete',
  createdAt: string
}
```

### SSE Events (design-routes.js:40-51)

| Event | Payload | When |
|-------|---------|------|
| `text` | `{ content }` | LLM text chunk |
| `decision` | `{ question, options, recommendation }` | Decision block parsed |
| `done` | `{}` | LLM response complete |
| `error` | `{ message }` | LLM or dispatch error |
| `ack` | `{ messageCount }` | Message receipt confirmed |
| `revision` | `{ decisionIndex }` | Decision marked superseded |
| `complete` | `{ designDocPath }` | Design doc generated |

---

## COMP-DESIGN-1c: Live Design Doc

### Goal

Show the design document building up live during the conversation, not just generated post-completion. Human can edit the doc inline.

### Design

**New component:** `DesignDocPanel.jsx` (new) — renders in the context panel when design view is active.

**Layout change:**

```
┌──────────┬────────────────────────┬──────────────────┐
│ SIDEBAR  │  MAIN: DesignView     │  CONTEXT PANEL   │
│          │  (conversation thread) │                  │
│ Decision │                        │  DesignDocPanel  │
│ Log      │  Messages + Cards      │  ┌────────────┐ │
│ ──────── │  Input area            │  │ Live MD    │ │
│ Research │  Complete button       │  │ preview    │ │
│ (1d)     │                        │  │            │ │
│          │                        │  │ [Edit] btn │ │
│          │                        │  └────────────┘ │
└──────────┴────────────────────────┴──────────────────┘
```

**Incremental doc building:**

The design doc accumulates from decisions — not generated only at completion. After each decision, the store rebuilds a draft doc from the conversation so far.

1. **New store field:** `draftDoc: string` in useDesignStore (alongside existing fields)
2. **New pure function:** `buildDraftDoc(messages, decisions)` in designSessionState.js — constructs markdown from decisions made so far (problem statement from early messages, decisions with rationale, open threads)
3. **Trigger:** After each `done` SSE event (when a full LLM response completes), call `buildDraftDoc()` and update `draftDoc` in store
4. **Server-side:** No changes needed for the draft — it's client-side only. The existing `POST /api/design/complete` still generates the final polished doc via LLM.

**Rendering:**

- `DesignDocPanel.jsx` (new) reads `draftDoc` from useDesignStore
- Two modes: **Preview** (rendered markdown, default) and **Edit** (textarea)
- Preview uses a lightweight markdown renderer (react-markdown already in deps, or raw `dangerouslySetInnerHTML` with a sanitizer)
- Edit mode: textarea with the raw markdown, `onChange` updates `draftDoc` in store
- Human edits are preserved — `buildDraftDoc()` only runs if the human hasn't manually edited (track `docManuallyEdited: boolean` flag)
- "Complete Design" uses the edited `draftDoc` as seed content for the final LLM polish pass

**Context panel integration:**

- When `activeView === 'design'`, context panel auto-shows `DesignDocPanel` instead of item detail
- Follow the existing pattern: `contextSelection = { type: 'design-doc' }` in App.jsx
- Auto-set this selection when entering design view, clear when leaving

**Server changes for Complete:**

- `POST /api/design/complete` gains optional `draftDoc` body field
- If present, LLM prompt becomes "Polish and finalize this draft design document" instead of generating from scratch
- This means human edits survive into the final doc

### File Changes

| File | Change |
|------|--------|
| `src/components/vision/designSessionState.js` (existing) | Add `buildDraftDoc(messages, decisions)` function |
| `src/components/vision/useDesignStore.js` (existing) | Add `draftDoc`, `docManuallyEdited` state; call `buildDraftDoc` on `done` events; `updateDraftDoc(text)` action for manual edits |
| `src/components/cockpit/DesignDocPanel.jsx` (new) | Context panel component: markdown preview + edit toggle |
| `src/App.jsx` (existing) | Wire context panel to show DesignDocPanel when activeView=design |
| `server/design-routes.js` (existing) | Accept `draftDoc` in POST /complete, use as seed |

---

## COMP-DESIGN-1d: Research Sidebar

### Goal

Show research context (web search results, codebase file references, topic outline) in the sidebar alongside the decision log.

### Design

**Sidebar tabs:** DesignSidebar gains two tabs: **Decisions** (existing content) and **Research** (new).

**Research data sources:**

The LLM agent already has access to tools (Read, Grep, Glob, WebSearch) via ClaudeSDKConnector. Tool use events flow through the SSE stream but are currently filtered out at `design-routes.js:128` ("Ignore system init/complete and tool_use events").

The fix: stop filtering tool_use events. Instead, broadcast them as a new SSE event type so the UI can display research activity.

**New SSE event:** `research`

```javascript
// In dispatchDesignAgent() for-await loop, before line 128 comment
// Track last tool name for pairing with tool_use_summary (which lacks tool identity)
let lastToolName = null;

} else if (event.type === 'tool_use') {
  lastToolName = event.tool;
  broadcastDesignEvent(key, 'research', {
    tool: event.tool,    // 'Read', 'Grep', 'WebSearch', etc.
    input: event.input,  // tool input (file path, search query, etc.)
    timestamp: new Date().toISOString()
  });
} else if (event.type === 'tool_use_summary') {
  broadcastDesignEvent(key, 'research_result', {
    tool: lastToolName,  // paired with preceding tool_use
    summary: (event.summary || '').slice(0, 200),
    timestamp: new Date().toISOString()
  });
}
```

**Store changes:**

- New field: `researchItems: Array<{ tool, input, summary?, timestamp }>` in useDesignStore
- SSE handler for `research` and `research_result` events appends to array
- New derived field: `topicOutline` — computed from decisions + message content, structured as section headings

**Sidebar UI:**

```
┌─────────────────┐
│ [Decisions] [Research] │  ← tab bar
├─────────────────┤
│                 │
│ Research tab:   │
│                 │
│ TOPIC OUTLINE   │
│ ├ Problem       │
│ ├ Architecture  │
│ └ Data Model    │
│                 │
│ CODEBASE REFS   │
│ ├ server/foo.js │
│ ├ src/Bar.jsx   │
│                 │
│ WEB SEARCHES    │
│ ├ "auth patterns│
│ │  for React"   │
│                 │
└─────────────────┘
```

**Topic outline generation:**

- Pure function `buildTopicOutline(messages, decisions)` in designSessionState.js
- Extracts section headings from: decision questions (each maps to a topic), and conversation context
- Rebuilt after each `done` event (same trigger as draftDoc)
- Simple heuristic: each decision question becomes a topic heading, ordered chronologically

**Session persistence:**

- Research items are ephemeral (not persisted to design-sessions.json) — they're derivable from the conversation
- Topic outline is computed, not stored

### File Changes

| File | Change |
|------|--------|
| `server/design-routes.js` (existing) | Broadcast `research` and `research_result` SSE events from tool_use/tool_result |
| `src/components/vision/designSessionState.js` (existing) | Add `buildTopicOutline(messages, decisions)` function |
| `src/components/vision/useDesignStore.js` (existing) | Add `researchItems`, `topicOutline` state; SSE handlers for research events; rebuild outline on `done` |
| `src/components/vision/DesignSidebar.jsx` (existing) | Add tab bar (Decisions/Research), render ResearchTab when active |
| `src/components/vision/ResearchTab.jsx` (new) | Research tab content: topic outline + codebase refs + web searches |

---

## Corrections Table

| Blueprint Assumption | Actual Code | Impact |
|---------------------|-------------|--------|
| react-markdown in deps | **Confirmed:** `react-markdown@^10.1.0` + `remark-gfm@^4.0.1` in package.json:50-51 | Use react-markdown for preview |
| tool_use events filtered at line 128 | **Confirmed:** `design-routes.js:128` — comment-only filter, events silently dropped in the for-await loop | Add tool_use handling before line 128 |
| `tool_result` event type from connector | **Corrected:** Connector yields `tool_use_summary` (not `tool_result`) with `{ summary, output }` — see `claude-sdk-connector.js:121-123` | Use `tool_use_summary` not `tool_result` for research results |
| Context panel auto-opens on selection | **Confirmed:** `App.jsx:738-743` — `useEffect` sets `contextOpen=true` when `contextSelection` changes | Set `contextSelection={type:'design-doc'}` on design view enter |
| DesignSidebar replaces AttentionQueueSidebar | **Confirmed:** `App.jsx:1035-1042` — ternary on `activeView === 'design'` | No issue |
| DesignSidebar width prop | **Confirmed:** prop `widthPx` with 208px default, passed from `App.jsx:1041` as `sidebarWidthPx` | No issue |
| useDesignStore is Zustand singleton | **Confirmed:** `create()` at module level | No issue |
| DesignView renders at App.jsx:328 | **Confirmed:** `case 'design': return <DesignView key={projectRoot} />` | No issue |

---

## Risk Assessment

- **Low risk:** Both features are additive UI. No existing behavior changes. No server data model changes (research is ephemeral, draftDoc is client-side).
- **Medium risk:** The `buildDraftDoc` heuristic quality — if the auto-generated draft is poor, the feature feels broken. Mitigation: keep it simple (list decisions with rationale), let the final LLM polish pass do the heavy lifting.
- **Low risk:** SSE event volume increase from research events. Mitigation: only broadcast during active design sessions, truncate summaries.
