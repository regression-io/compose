# COMP-DESIGN Wave 0 Implementation Plan

**Items:** 85 (1c — Live Design Doc), 86 (1d — Research Sidebar)
**Blueprint:** `docs/features/COMP-DESIGN/blueprint.md`

---

## Task Order

Tasks 1–3 are shared foundation. Tasks 4–6 are 1c (live doc). Tasks 7–10 are 1d (research sidebar). Tasks 4–6 and 7–10 are independent and can run in parallel after task 3.

---

### Task 1: Add pure functions to designSessionState.js

**File:** `src/components/vision/designSessionState.js` (existing)
**Pattern:** Follow existing pure function style (no side effects, return new objects)

- [ ] Add `buildDraftDoc(messages, decisions)` → returns markdown string
  - Extract problem statement from first 2-3 human messages
  - Each non-superseded decision becomes a "## Decision: {question}" section with selected option, rationale, and comment
  - End with "## Open Threads" listing unresolved topics from recent messages
  - Keep it simple — this is a live draft, not the final doc
- [ ] Add `buildTopicOutline(messages, decisions)` → returns `Array<{ title, type: 'decision'|'topic', decided: boolean }>`
  - Each decision question becomes a topic (decided: true)
  - Heuristic: scan assistant messages for "##" headings or "let's discuss" patterns as undecided topics
- [ ] Tests in `test/design-session-state.test.js` (existing): add test cases for both functions

### Task 2: Extend useDesignStore with new state

**File:** `src/components/vision/useDesignStore.js` (existing)
**Pattern:** Follow existing Zustand store pattern — state fields + actions

- [ ] Add state fields: `draftDoc: ''`, `docManuallyEdited: false`, `researchItems: []`, `topicOutline: []`
- [ ] Add action `updateDraftDoc(text)` — sets `draftDoc` and `docManuallyEdited: true`
- [ ] Add action `resetDocEdited()` — sets `docManuallyEdited: false` AND immediately calls `buildDraftDoc(messages, decisions)` to rebuild `draftDoc` from current state (so reset has visible effect)
- [ ] In `done` SSE handler (around line 255-268): after finalizing message, call `buildDraftDoc` and `buildTopicOutline` to update state (only if `!docManuallyEdited`). **Important:** preserve `researchItems` across the rehydration — do NOT reset them in the done handler. Research items accumulate across the full session, not per-turn.
- [ ] Add SSE handler for `research` event → append to `researchItems` with `{ tool, input, timestamp, summary: null }`
- [ ] Add SSE handler for `research_result` event → update the last research item that has `summary === null` (positional pairing — server pairs tool_use_summary with preceding tool_use, so order is reliable)
- [ ] In `hydrate()`: rebuild `draftDoc` and `topicOutline` from loaded session data. Do NOT clear `researchItems` if they already exist (hydrate may be called mid-session after a `done` event)
- [ ] In `completeDesign()`: pass `draftDoc` as body field to POST /complete

### Task 3: Broadcast research SSE events from server

**File:** `server/design-routes.js` (existing)
**Location:** `dispatchDesignAgent()` for-await loop, before line 128

- [ ] Add `tool_use` event handling: broadcast as `research` with `{ tool, input, timestamp }`. Track `lastToolName` variable in the dispatch loop scope.
- [ ] Add `tool_use_summary` event handling: broadcast as `research_result` with `{ tool: lastToolName, summary, timestamp }`. This pairs the summary with the preceding tool_use since `tool_use_summary` events don't carry tool identity.
- [ ] In POST /complete handler: accept optional `draftDoc` body field; if present, modify LLM prompt to "Polish and finalize this draft" instead of generating from scratch
- [ ] Test in `test/design-routes.test.js` (existing): add test that POST /complete with `draftDoc` body field stores it on the session and returns successfully (HTTP-level test, not LLM prompt verification — the route instantiates the connector directly)

---

### Task 4: Build DesignDocPanel component

**File:** `src/components/cockpit/DesignDocPanel.jsx` (new)
**Pattern:** Follow ContextItemDetail.jsx structure — reads from store, renders in context panel

- [ ] Import `useDesignStore` for `draftDoc`, `docManuallyEdited`, `updateDraftDoc`, `resetDocEdited`
- [ ] Two modes via local state `editing: boolean` (default false)
- [ ] **Preview mode:** react-markdown with remark-gfm rendering `draftDoc`. "Edit" button in header.
- [ ] **Edit mode:** textarea (monospace, full-height) with raw markdown. "Preview" button + "Reset to auto-generated" button (calls `resetDocEdited` + triggers rebuild)
- [ ] Header bar: "Design Document" title, mode toggle button, doc status indicator (empty/draft/manually edited)
- [ ] Empty state when no decisions yet: "Start the design conversation to see the document build here."
- [ ] Styling: match existing context panel components (hsl vars, tailwind utilities)

### Task 5: Wire DesignDocPanel into App.jsx context panel

**File:** `src/App.jsx` (existing)

- [ ] When `activeView === 'design'`, auto-set `contextSelection = { type: 'design-doc' }` (useEffect on activeView)
- [ ] Clear design-doc selection when leaving design view
- [ ] In context panel render section: add `contextSelection?.type === 'design-doc'` case → render `<DesignDocPanel />`
- [ ] Import DesignDocPanel

### Task 6: Test live doc end-to-end

- [ ] Test `buildDraftDoc` produces valid markdown from sample messages/decisions
- [ ] Test `updateDraftDoc` sets `docManuallyEdited` flag
- [ ] Test `done` SSE handler rebuilds doc only when not manually edited
- [ ] Test POST /complete with draftDoc body field uses it as seed
- [ ] Manual smoke: start design session → make 2 decisions → verify doc preview updates → edit doc → verify edits persist through new decisions → complete → verify final doc includes edits

---

### Task 7: Add tab bar to DesignSidebar

**File:** `src/components/vision/DesignSidebar.jsx` (existing)

- [ ] Add local state `activeTab: 'decisions' | 'research'` (default 'decisions')
- [ ] Add tab bar at top: two buttons styled as tabs (active = accent border-bottom, inactive = muted)
- [ ] Existing decision log content renders when `activeTab === 'decisions'`
- [ ] New ResearchTab component renders when `activeTab === 'research'`
- [ ] Pass `researchItems` and `topicOutline` from store to ResearchTab

### Task 8: Build ResearchTab component

**File:** `src/components/vision/ResearchTab.jsx` (new)
**Pattern:** Follow DesignSidebar's existing scroll-area + list style

- [ ] Three sections, each collapsible:
  - **Topic Outline:** list of `topicOutline` items with check icon (decided) or circle (open). Click scrolls to relevant message in DesignView (stretch goal — skip for v1)
  - **Codebase References:** filter `researchItems` where tool is Read/Grep/Glob. Show file path or search pattern. Grouped by tool.
  - **Web Searches:** filter `researchItems` where tool is WebSearch. Show query + summary.
- [ ] Empty state per section when no items
- [ ] Live updates as research events stream in
- [ ] Research item count badge on the "Research" tab in the tab bar

### Task 9: Wire research tab to store

**File:** `src/components/vision/DesignSidebar.jsx` (existing)

- [ ] Import `useDesignStore` to read `researchItems` and `topicOutline`
- [ ] Pass as props to ResearchTab
- [ ] Badge count: `researchItems.length` shown on Research tab

### Task 10: Test research sidebar end-to-end

- [ ] Test `buildTopicOutline` extracts topics from decisions
- [ ] Test SSE `research` event appends to `researchItems`
- [ ] Test SSE `research_result` event updates matching item
- [ ] Test server broadcasts `research`/`research_result` for tool_use/tool_use_summary events
- [ ] Manual smoke: start design session → ask question that triggers codebase research → verify Research tab shows file references → verify Topic Outline shows decided topics

---

## Parallel Execution

```
Task 1 (pure functions) → Task 2 (store) → Task 3 (server)
                                          ↓
                            ┌─────────────┴─────────────┐
                            ↓                           ↓
                     Tasks 4-6 (1c)              Tasks 7-10 (1d)
                     Live Design Doc             Research Sidebar
```

Tasks 4-6 and 7-10 are independent — can be dispatched to parallel agents.
