# COMP-UX-2c: Dashboard Landing View — Implementation Blueprint

**Date:** 2026-03-27
**Depends on:** COMP-UX-2d (group field), COMP-UX-2a (focus state for feature detection)

## Related Documents

- [Design](design.md)
- [COMP-UX-2 parent](../COMP-UX-2/design.md)

---

## Corrections Table

| Design Assumption | Reality | Impact |
|---|---|---|
| `get_feature_lifecycle` MCP call available | No direct MCP call from client. Feature lifecycle data lives on `item.lifecycle` in useVisionStore | Dashboard reads lifecycle from items, not MCP |
| Artifacts from `/api/files` | `/api/files` returns file list for docs tree. No word count or "writing" status. | Artifacts card: check file existence via item.lifecycle artifacts, word count not available without extra API |
| Dashboard needs its own data fetching | All data already in useVisionStore (items, gates, sessions, activeBuild, spawnedAgents) | Pure component — receives all data via props from CockpitView |

---

## Architecture

DashboardView is a **pure presentation component** receiving props from CockpitView, following the GateView pattern. No store access, no fetch calls — all data threaded via App.jsx.

### Props Interface

```typescript
interface DashboardViewProps {
  items: Item[];
  gates: Gate[];
  sessions: Session[];
  activeBuild: Build | null;
  spawnedAgents: Agent[];
  featureCode: string | null;
  onSelect: (id: string) => void;
  onResolveGate: (gateId: string, outcome: string, comment?: string) => void;
  onOpenGate: (gateId: string) => void;
}
```

## Task Breakdown

### Task 1: Register Dashboard tab (existing files)

**File:** `src/components/cockpit/viewTabsState.js` (existing)
- **Line ~10 (`DEFAULT_MAIN_TABS`):** Add `'dashboard'` as first entry:
  ```javascript
  export const DEFAULT_MAIN_TABS = [
    'dashboard', 'graph', 'tree', 'docs', 'design', 'gates', 'pipeline', 'sessions'
  ];
  ```

**File:** `src/components/cockpit/ViewTabs.jsx` (existing)
- **Lines 8-16 (`TAB_META`):** Add dashboard entry:
  ```javascript
  dashboard: { label: 'Dashboard', icon: LayoutDashboard },
  ```
- **Import:** Add `LayoutDashboard` from `lucide-react`

### Task 2: Add Dashboard route in App.jsx (existing)

**File:** `src/App.jsx`

1. **Import DashboardView** at top
2. **CockpitView switch (line ~223):** Add case before 'tree':
   ```javascript
   case 'dashboard':
     return (
       <DashboardView
         items={phaseFilteredItems}
         gates={phaseFilteredGates}
         sessions={sessions}
         activeBuild={activeBuild}
         spawnedAgents={spawnedAgents}
         featureCode={featureCode}
         onSelect={onSelect}
         onResolveGate={onResolveGate}
         onOpenGate={onOpenGate}
       />
     );
   ```
3. **Default view (line ~371):** Change fallback from `'graph'` to `'dashboard'`:
   ```javascript
   localStorage.getItem('compose:activeView') || 'dashboard'
   ```

### Task 3: Create DashboardView.jsx (new)

**File:** `src/components/vision/DashboardView.jsx`

**Layout (from design):**

```
┌─────────────────────────────────────────────────┐
│ Feature Header: name + phase progress bar        │
├──────────────────────┬──────────────────────────┤
│ Phase Timeline       │ Active Agents + Artifacts │
├──────────────────────┴──────────────────────────┤
│ Pending Gates (inline approve/revise/kill)        │
├─────────────────────────────────────────────────┤
│ Recent Sessions                                   │
└─────────────────────────────────────────────────┘
```

**Sections:**

#### A. Feature Header
- Find the feature item: `items.find(i => i.featureCode === featureCode)`
- Show: title, current phase, progress bar (phases completed / total phases)
- Phases list: `['vision', 'requirements', 'design', 'planning', 'implementation', 'verification', 'release']`
- Progress: index of current phase / total phases

#### B. Phase Timeline (left column)
- List all phases with status indicators:
  - `checkmark` for completed phases
  - `arrow` for current phase
  - `circle` for future phases
- Current phase derived from `item.phase` or `activeBuild.currentStep`

#### C. Active Agents + Artifacts (right column)
- **Agents:** `spawnedAgents.filter(a => a.status === 'running')` — show agent type + status
- **Artifacts:** Derive from feature folder convention: `design.md`, `blueprint.md`, `plan.md`
  - Check `activeBuild.steps` for artifact status (done = checkmark, active = spinner)

#### D. Pending Gates
- `gates.filter(g => g.status === 'pending')` scoped to feature items
- Each gate row: step name, item title, approve/revise/kill buttons
- Reuse GateView's button pattern (lines 30-43):
  ```jsx
  <Button variant="outline" size="sm" className="h-6 text-[10px] gap-1 text-success border-success/30 hover:bg-success/10"
    onClick={() => onResolveGate(gate.id, 'approved')}>Approve</Button>
  ```
- Gate item lookup: `items.find(i => i.id === gate.itemId)`

#### E. Recent Sessions
- Last 5 sessions: `sessions.slice(-5).reverse()`
- Each row: agent icon, featureCode badge, relative time, status
- Follow SessionsView row pattern (lines 130-183)

#### F. Empty State
- When no `featureCode`: show guidance message + list of recent completed features
- Pattern: use EmptyState component from `src/components/vision/shared/EmptyState.jsx`

**UI Components to import:**
- `Card, CardHeader, CardTitle, CardContent` from `@/components/ui/card.jsx`
- `Badge` from `@/components/ui/badge.jsx`
- `Button` from `@/components/ui/button.jsx`
- `ScrollArea` from `@/components/ui/scroll-area.jsx`

**Color tokens (from index.css):**
- Card bg: `var(--card)` / `#1e293b`
- Primary blue: `#3b82f6`
- Success green: `var(--success)` / `hsl(142, 71%, 45%)`
- Warning amber: `#f59e0b`
- Destructive red: `var(--destructive)`
- Border: `var(--border)` / `#334155`
- Muted text: `#64748b`

---

## Verification Checklist

- [ ] Dashboard tab appears first in ViewTabs
- [ ] Dashboard is default view for new sessions (no prior localStorage)
- [ ] Feature header shows name, phase, progress bar when featureCode bound
- [ ] Phase timeline shows completed/current/future phases
- [ ] Active agents card shows running agents with type
- [ ] Pending gates show with inline approve/revise/kill buttons
- [ ] Gate resolution works from dashboard (calls onResolveGate correctly)
- [ ] Recent sessions show last 5 with agent + feature info
- [ ] Empty state shows when no featureCode bound
- [ ] Empty state lists recent completed features
- [ ] Scrollable when content overflows
- [ ] No regressions: other views still accessible via tabs
