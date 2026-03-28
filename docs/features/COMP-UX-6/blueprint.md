# COMP-UX-6: Per-Agent Log Viewer Tabs — Implementation Blueprint

**Date:** 2026-03-28

## Related Documents

- [Design](design.md)

---

## Corrections Table

| Design Assumption | Reality | Impact |
|---|---|---|
| AgentPanel is rendered from App.jsx | Rendered inside AttentionQueueSidebar (~line 340), which is rendered from App.jsx | Modify AgentPanel directly — sidebar just threads props |
| agentRelays not passed to AgentPanel | agentRelays in App.jsx store selector (line ~385) but NOT passed through sidebar render (line ~995) to AgentPanel | Thread through App.jsx sidebar render → AttentionQueueSidebar props → AgentPanel props |
| Agent API returns `stdout` field | `GET /api/agent/:id` returns `output` (not `stdout`) per agent-spawn.js line ~136 | Use `data.output` in AgentLogViewer |
| Completed agents are removed from store | Completed agents are updated in place (status changes), kept in spawnedAgents array, hydrated on reconnect | Don't reset selectedAgent on completion — tab stays selectable with final output |
| New shared components go in `src/components/shared/` | Vision-scoped shared primitives live in `src/components/vision/shared/` (e.g., RelativeTime.jsx, EmptyState.jsx) | Place AgentLogViewer and AgentRelayFeed in `src/components/vision/shared/` |
| Tab styling uses hardcoded hex | Existing sidebar/agent UI uses CSS variable classes and theme tokens | Use `border-border`, `bg-primary`, `text-primary-foreground` etc. for tab buttons |
| Popout path needs coverage | PopoutView renders deprecated VisionTracker which doesn't pass agent data | Skip popout — deprecated path, not worth covering |

---

## Task Breakdown

### Task 1: Thread agentRelays to AgentPanel

**File:** `src/App.jsx` (existing)
- Find where AttentionQueueSidebar is rendered (~line 995). Add `agentRelays={agentRelays}` prop.

**File:** `src/components/vision/AttentionQueueSidebar.jsx` (existing)
- Accept `agentRelays` prop in function signature
- Find where AgentPanel is rendered (~line 340). Pass `agentRelays={agentRelays}` to it.

### Task 2: Create AgentLogViewer.jsx (NEW)

**File:** `src/components/vision/shared/AgentLogViewer.jsx`

Polls `GET /api/agent/:id` and displays the `output` field.

```jsx
Props: { agentId, status }
```

- **Polling:** `useEffect` with 2s `setInterval` calling `fetch('/api/agent/${agentId}')`. Parse JSON, read `data.output` and `data.stderr`. Stop interval when `status !== 'running'` (do one final fetch on completion).
- **Display:** `<pre>` with `text-[10px] font-mono text-muted-foreground` inside a div with `overflow-auto max-h-[300px]`
- **Auto-scroll:** `useRef` on container + `useEffect` that scrolls to bottom when output changes. Track `userScrolled` — set true if user scrolls up (check `scrollTop + clientHeight < scrollHeight - 20`), reset when they scroll back to bottom.
- **Stderr:** If `data.stderr` is non-empty, show below stdout with `text-destructive` color and a small "stderr" label.
- **Empty state:** "Waiting for output..." in muted text while output is empty and agent is running. "No output" if completed with empty output.

### Task 3: Create AgentRelayFeed.jsx (NEW)

**File:** `src/components/vision/shared/AgentRelayFeed.jsx`

```jsx
Props: { agentId, relays }
```

- Filter `relays` where `fromAgentId === agentId || toAgentId === agentId`
- Render each relay:
  - Dispatch (`direction='dispatch'`): `← {messagePreview}` in `text-muted-foreground`
  - Result (`direction='result'`): `→ {messagePreview}` in `text-foreground`
- Timestamp as relative time (reuse pattern from DashboardView's `relativeTime()`)
- `text-[10px] font-mono`
- If no relays found, return null (don't render section)

### Task 4: Add tab bar and per-agent routing to AgentPanel

**File:** `src/components/vision/AgentPanel.jsx` (existing)

1. **Add props:** `agentRelays` to function signature (line 53)

2. **Add state:** `const [selectedAgent, setSelectedAgent] = useState(null);`

3. **Add tab bar** at top of return JSX, only when agents exist. Use theme-aware classes:
   ```jsx
   {spawnedAgents && spawnedAgents.length > 0 && (
     <div className="flex items-center gap-0.5 mb-1.5 overflow-x-auto">
       <button
         onClick={() => setSelectedAgent(null)}
         className={cn(
           'text-[10px] px-2 py-0.5 rounded cursor-pointer transition-colors border',
           !selectedAgent
             ? 'bg-primary text-primary-foreground border-primary'
             : 'bg-transparent text-muted-foreground border-border hover:text-foreground'
         )}
       >Session</button>
       {spawnedAgents.map(a => (
         <button
           key={a.agentId}
           onClick={() => setSelectedAgent(a.agentId)}
           className={cn(
             'text-[10px] px-2 py-0.5 rounded cursor-pointer transition-colors border flex items-center gap-1',
             selectedAgent === a.agentId
               ? 'bg-primary text-primary-foreground border-primary'
               : 'bg-transparent text-muted-foreground border-border hover:text-foreground'
           )}
         >
           <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{
             background: a.status === 'running' ? 'hsl(var(--success))' :
               a.status === 'complete' ? 'hsl(142 71% 45%)' : 'hsl(var(--destructive))',
             animation: a.status === 'running' ? 'phase-active-pulse 2s ease-in-out infinite' : 'none',
           }} />
           {a.agentType}
         </button>
       ))}
     </div>
   )}
   ```

4. **Conditional rendering:** Wrap ALL existing content in a fragment that only shows when `!selectedAgent`. When `selectedAgent` is set, render AgentLogViewer + AgentRelayFeed:
   ```jsx
   {selectedAgent ? (
     <div className="space-y-2">
       <AgentLogViewer agentId={selectedAgent} status={spawnedAgents.find(a => a.agentId === selectedAgent)?.status} />
       <AgentRelayFeed agentId={selectedAgent} relays={agentRelays} />
     </div>
   ) : (
     <>{/* ALL existing AgentPanel content */}</>
   )}
   ```

5. **No reset on completion** — completed agents stay selectable. Their final output is visible.

---

## Verification Checklist

- [ ] agentRelays threaded: App.jsx → AttentionQueueSidebar → AgentPanel
- [ ] Tab bar appears when agents are spawned
- [ ] "Session" tab shows existing AgentPanel content unchanged
- [ ] Per-agent tab shows AgentLogViewer with `output` from API
- [ ] Polling stops when agent completes (final fetch on status change)
- [ ] Auto-scroll works, pauses when user scrolls up
- [ ] Stderr shown in red when present
- [ ] AgentRelayFeed shows dispatch/result for selected agent
- [ ] Status dots: pulsing green=running, static green=complete, red=failed
- [ ] Completed agent tabs stay selectable with final output
- [ ] No tabs when no agents spawned (backward compatible)
- [ ] New components in `src/components/vision/shared/`
- [ ] Tab styling uses theme tokens, not hardcoded hex
- [ ] Build passes
