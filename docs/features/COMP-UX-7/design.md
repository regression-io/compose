# COMP-UX-7: Live Metrics on Agent Cards

**Status:** DESIGN
**Date:** 2026-03-28

## Related Documents

- [COMP-UX-2 design](../COMP-UX-2/design.md) — Tier 2 roadmap entry
- [Kangentic reference](../../../.claude/projects/-Users-ruze-reg-my-forge/memory/reference_kangentic.md) — Inspiration: per-agent visual state

---

## Problem

The Dashboard's ActiveAgents card shows `agent-type — running` and nothing else. AgentPanel (in the agent bar area) already has rich telemetry — tool counts, elapsed time, errors, activity bars, current tool. But that data doesn't surface on the Dashboard or anywhere a quick glance would catch it.

An operator watching a multi-agent build has no idea how far along each agent is, whether it's stuck, or what it's doing — unless they switch views.

## Goal

Bring live metrics onto agent cards in the Dashboard. Each running agent shows: elapsed time, tool count, current tool/category, error count. Completed agents show final stats. The same card pattern is reusable outside the Dashboard.

---

## Decision 1: Data Sources

All data already flows through `useVisionStore`. No new server work needed.

| Metric | Store field | Notes |
|--------|-------------|-------|
| Elapsed time | `agent.startedAt` | Compute client-side with interval |
| Tool count | `sessionState.toolCount` | Global session-level, not per-agent |
| Current tool | `agentActivity.tool` | Last activity event |
| Tool category | `agentActivity.category` | Color-coded in AgentPanel |
| Error count | `sessionState.errorCount` | Global session-level |
| Agent status | `agent.status` | running/complete/failed |

**Limitation:** Tool count and error count are session-level, not per-agent. For the current architecture (single active session), this is fine — the metrics represent the build's progress. If multi-agent sessions emerge, this would need per-agent counters (future work).

## Decision 2: Card Layout

Replace the current minimal agent rows with richer cards:

```
┌────────────────────────────────────────────┐
│ compose-explorer          ◆ running  1m 23s│
│ ┊ 12 tools · 0 err · writing (Edit)       │
└────────────────────────────────────────────┘
┌────────────────────────────────────────────┐
│ compose-architect         ● complete  45s  │
│ ┊ 8 tools · 0 err                         │
└────────────────────────────────────────────┘
```

- **Line 1:** Agent type, status dot (green=running pulse, emerald=complete, red=failed), elapsed time
- **Line 2:** Tool count, error count, current tool category + tool name (running only)
- Status dot pulses for running agents (reuse `phase-active-pulse` keyframe from COMP-UX-5)

## Decision 3: Component Architecture

Create a reusable `AgentCard` component in `src/components/shared/AgentCard.jsx`. The Dashboard imports it; AgentPanel could adopt it later.

Props:
```typescript
{
  agent: { agentId, agentType, status, startedAt, completedAt },
  toolCount?: number,
  errorCount?: number,
  currentTool?: string,
  currentCategory?: string,
}
```

The Dashboard's ActiveAgents component computes `toolCount`/`errorCount` from `sessionState` and passes them. `currentTool`/`currentCategory` come from the latest `agentActivity`.

## Decision 4: Elapsed Time

Use a 1-second `setInterval` for running agents. Stop when agent completes. Show final duration for completed agents.

Format: `<1m` → seconds, `1m+` → `Xm Ys`, `1h+` → `Xh Ym`.

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/components/shared/AgentCard.jsx` | new | Reusable agent metric card |
| `src/components/vision/DashboardView.jsx` | modify | Use AgentCard, pass metrics from store |
| `src/App.jsx` | modify | Thread agentActivity + sessionState to Dashboard |

## Acceptance Criteria

- [ ] Running agents show pulsing status dot, elapsed time (ticking), tool count, error count, current tool
- [ ] Completed agents show final elapsed time (static), tool count, error count
- [ ] Failed agents show red status dot
- [ ] Zero errors shows "0 err" in muted color (not hidden)
- [ ] Current tool + category shown only for running agents
- [ ] Dashboard updates in real-time as tool-use events arrive
- [ ] No new server work — all data from existing store
