# COMP-UX-6: Per-Agent Log Viewer Tabs

**Status:** DESIGN
**Date:** 2026-03-28

## Related Documents

- [COMP-UX-2 design](../COMP-UX-2/design.md) — Tier 2 roadmap entry
- [Kangentic reference](../../../.claude/projects/-Users-ruze-reg-my-forge/memory/reference_kangentic.md) — Inspiration: per-session terminals

---

## Problem

When multiple subagents are running (explorers, architects, reviewers), their work blends into one global stream. The operator can see "3 agents running" but can't drill into what each one is doing. Agent output (`stdout`) is captured server-side (`GET /api/agent/:id`) but never surfaced in the UI. Agent relay messages (dispatch/result) exist per-agent but aren't displayed in a focused view.

## Goal

Add a tabbed agent panel where each spawned agent gets its own tab. Each tab shows:
1. **Log viewer** — scrollable read-only output from the agent's stdout
2. **Activity feed** — relay messages (dispatch prompt, result output) scoped to that agent

No terminal multiplexing. No PTY. Just text viewers with auto-scroll.

---

## Decision 1: Panel Location

Replace or augment the existing AgentPanel (in the agent bar area at the bottom of the screen). When agents are spawned, the panel shows tabs. When no agents are active, it shows the current session view (existing AgentPanel behavior).

Tab bar: `[Session] [explorer-1] [architect-1] [codex-1]`

## Decision 2: Data Sources

| Data | Source | Per-agent? | Polling? |
|------|--------|------------|----------|
| Agent stdout | `GET /api/agent/:id` → `output` field | Yes | 2s interval while running |
| Agent stderr | `GET /api/agent/:id` → `stderr` field | Yes | Same poll |
| Agent status | `spawnedAgents` array in store | Yes | WebSocket push |
| Relay messages | `agentRelays` in store (has `fromAgentId`/`toAgentId`) | Yes | WebSocket push |
| Tool activity | `agentActivity` in store | No (session-global) | WebSocket push |

**V1 scope:** Log viewer uses stdout polling. Activity feed uses agentRelays filtered by agentId. Session-global activity stays on the "Session" tab (existing AgentPanel). Per-agent activity (adding agentId to activity messages) is future work.

## Decision 3: Log Viewer Component

A scrollable `<pre>` that:
- Polls `GET /api/agent/:id` every 2 seconds while agent is running
- Stops polling when agent completes
- Auto-scrolls to bottom (with "scroll locked" toggle if user scrolls up)
- Monospace, dark theme, `text-[10px]`
- Shows stderr in red if present

## Decision 4: Tab Bar

Reuse the ViewTabs pattern (inline style buttons) but scoped to the agent panel area.

- "Session" tab always present (shows existing AgentPanel content)
- One tab per spawned agent: label = `agentType` (e.g., "explorer-1")
- Running agents: pulsing dot on tab
- Failed agents: red dot on tab
- Completed agents: green dot, tab stays for 30s then fades

## Decision 5: Relay Feed

Each agent tab shows its relay messages below the log viewer:
- **Dispatch:** "← Prompt: {first 80 chars}" (when agent was spawned)
- **Result:** "→ Result: {first 80 chars}" (when agent completed)
- Already in `agentRelays` with direction field

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/components/vision/AgentPanel.jsx` | modify | Add tab bar, route to per-agent view |
| `src/components/shared/AgentLogViewer.jsx` | new | Scrollable log viewer with polling |
| `src/components/shared/AgentRelayFeed.jsx` | new | Per-agent relay message display |

## Acceptance Criteria

- [ ] Tab bar appears when agents are spawned
- [ ] "Session" tab shows existing AgentPanel content
- [ ] Per-agent tab shows scrolling stdout log
- [ ] Log auto-scrolls while agent is running
- [ ] Log polling stops when agent completes
- [ ] Stderr shown in red below stdout (if present)
- [ ] Relay messages shown per-agent (dispatch + result)
- [ ] Running agent tab has pulsing indicator
- [ ] Completed agent tab shows green dot
- [ ] Failed agent tab shows red dot
- [ ] No agents = no tabs, just Session view (backward compatible)
