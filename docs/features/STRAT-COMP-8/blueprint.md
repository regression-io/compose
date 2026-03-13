# Blueprint: Active Build Dashboard (STRAT-COMP-8)

**Feature:** Replace `StratumPanel` with a design-system-compliant build dashboard driven by WebSocket state
**Status:** Blueprint
**Date:** 2026-03-12

---

## Related Documents

- Design: `docs/features/STRAT-COMP-8/design.md`
- STRAT-COMP-5 blueprint: `docs/features/STRAT-COMP-5/blueprint.md` — data source (extends `active-build.json`, adds `buildStateChanged` WS event, `GET /api/build/state` endpoint, `activeBuild` in `useVisionStore`)
- STRAT-COMP-7 design: `docs/features/STRAT-COMP-7/design.md` — agent stream bridge (build events in `AgentStream.jsx`, `_source: "build"` tagging)
- Producer: `lib/build.js` (writes `active-build.json`)
- Being replaced: `src/components/StratumPanel.jsx`
- Reference patterns: `src/components/vision/GateView.jsx`
- Constants: `src/components/vision/constants.js`
- Client state: `src/components/vision/useVisionStore.js`, `src/components/vision/visionMessageHandler.js`
- Layout: `src/App.jsx`

---

## Corrections Table

| ID | Severity | Design Claim | Actual Code | Required Fix |
|----|----------|-------------|-------------|--------------|
| C1 | P0 | Design Section 5 places new files in `src/components/vision/` (e.g., `src/components/vision/BuildDashboard.jsx`) | No `src/components/build/` directory exists. Design Section 2 component tree says `src/components/vision/`. The vision directory currently contains 21 files (`GateView.jsx`, `useVisionStore.js`, `constants.js`, etc.) | Follow the design: place new files in `src/components/vision/`. The design says `src/components/vision/BuildDashboard.jsx`, not `src/components/build/`. The user's task description said `src/components/build/` but the design doc takes precedence. **Decision: use `src/components/build/`** per the user's explicit request, which groups build-specific components separately from vision concerns |
| C2 | P1 | Design Section 2: "`activeBuild` is added to `useVisionStore` by STRAT-COMP-5" | `useVisionStore.js` has no `activeBuild` state (line 74-91 lists all state: `items`, `connections`, `connected`, `uiCommand`, `recentChanges`, `agentActivity`, `agentErrors`, `sessionState`, `gates`, `gateEvent`, `settings`). Return object (line 255-278) does not include `activeBuild` | STRAT-COMP-5 blueprint (Task 10) adds `activeBuild` to `useVisionStore`. This is a prerequisite. STRAT-COMP-8 **must not ship before STRAT-COMP-5 is implemented**. This blueprint assumes `activeBuild` and `setActiveBuild` exist when implementation begins |
| C3 | P1 | Design Section 2: "`buildStateChanged` WS handler exists in `visionMessageHandler.js`" | `visionMessageHandler.js` has no `buildStateChanged` case (line 8-193). Last case before `snapshotRequest` is `settingsState`/`settingsUpdated` at line 176-177 | STRAT-COMP-5 blueprint (Task 11) adds the `buildStateChanged` handler. Same prerequisite as C2 |
| C4 | P1 | Design Section 2: "Dashboard calls `GET /api/build/state` to hydrate `activeBuild`" | No such endpoint exists currently | STRAT-COMP-5 blueprint (Task 9) adds this endpoint. Same prerequisite as C2 |
| C5 | P0 | Design Section 3.1: "`resolveGate()` from `useVisionStore`" | Confirmed: `resolveGate` exists at `useVisionStore.js:220-235`, calls `POST /api/vision/gates/${gateId}/resolve` with `{ outcome, comment }`. Signature: `resolveGate(gateId, outcome, comment)` | No fix needed. GateAlert can use this directly |
| C6 | P0 | Design Section 7: "Uses `Card` from `@/components/ui/card.jsx`" and other shadcn components | Confirmed present: `src/components/ui/card.jsx`, `badge.jsx`, `button.jsx`, `collapsible.jsx`. Also available: `dropdown-menu.jsx`, `input.jsx`, `scroll-area.jsx`, `select.jsx`, `separator.jsx`, `sheet.jsx`, `sidebar.jsx`, `skeleton.jsx`, `toggle-group.jsx`, `toggle.jsx`, `tooltip.jsx` | No fix needed. All required shadcn primitives exist |
| C7 | P0 | Design Section 5: "In the parent layout that currently renders `<StratumPanel />`" | `App.jsx:295`: `{rightTab === 'Canvas' ? <Canvas fontSize={fontSize} /> : <StratumPanel />}`. Tab array at line 279: `['Canvas', 'Stratum']`. StratumPanel imported at line 5. Right panel is inside `<PanelErrorBoundary>` (line 294). Tab state: `useState('Canvas')` at line 123 | Feature flag goes inside the `else` branch at line 295. Tab label should change from 'Stratum' to 'Build' **only when `USE_BUILD_DASHBOARD = true`**. When false, keep the tab label as 'Stratum' |
| C8 | P2 | Design Section 4.3: Phase name mapping shows `explore_design` -> "Design", etc. | `constants.js:48-61` confirms `LIFECYCLE_PHASE_LABELS` has exactly: `explore_design`, `prd`, `architecture`, `blueprint`, `verification`, `plan`, `execute`, `report`, `docs`, `ship`, `complete`, `killed`. Design also lists these correctly. **However:** gate step IDs like `design_gate`, `prd_gate` have no entries. | Design Section 4.3 proposes stripping `_gate` suffix: `design_gate` -> lookup `explore_design` -> "Design Gate". But `design_gate` minus `_gate` is `design`, not `explore_design`. Need a gate-to-phase mapping or a secondary lookup table. See Architecture Decision AD-2 |
| C9 | P2 | Design Section 3.1: "Feature name from the linked Vision item (`items.find(i => i.id === gate.itemId)?.title`)" | `GateView.jsx:62-173` uses this exact pattern: receives `items` prop, builds `itemMap` at line 237: `new Map(items.map(i => [i.id, i]))`. Gate has `gate.itemId` field | GateAlert needs access to `items` from `useVisionStore`. Since `BuildDashboard` is a top-level component consuming the store, it can pass `items` down |
| C10 | P1 | Design Section 4.1: Extended schema includes `steps[]` array with per-step detail | `lib/build.js` `startFresh()` at line 490-496 writes only 5 fields. `updateActiveBuildStep()` at line 501-507 only updates `currentStepId` | STRAT-COMP-5 blueprint extends `writeActiveBuild()` and `updateActiveBuildStep()` to include `stepNum`, `totalSteps`, `retries`, `violations`. But the `steps[]` array is NOT in the STRAT-COMP-5 blueprint scope — it only adds scalar fields. The `steps[]` array must be added by STRAT-COMP-8 in `lib/build.js` |

---

## Architecture Decisions

### AD-1: Component directory — `src/components/build/`

New dashboard components go in `src/components/build/`, not `src/components/vision/`. Reasons: (1) the vision directory already has 21 files covering board/graph/gate concerns; (2) build dashboard is a distinct domain; (3) clean import boundaries — build components import from vision (`useVisionStore`, `constants.js`) but vision components never import from build.

### AD-2: Gate step label resolution

Gate step IDs follow the pattern `{base}_gate` (e.g., `design_gate`, `prd_gate`, `plan_gate`). The base does not always match a `LIFECYCLE_PHASE_LABELS` key directly:

| Gate step ID | After stripping `_gate` | Actual LIFECYCLE_PHASE_LABELS key |
|---|---|---|
| `design_gate` | `design` | `explore_design` |
| `prd_gate` | `prd` | `prd` |
| `architecture_gate` | `architecture` | `architecture` |
| `plan_gate` | `plan` | `plan` |
| `ship_gate` | `ship` | `ship` |

Only `design_gate` is irregular (`design` != `explore_design`). Solution: a `GATE_STEP_TO_PHASE` lookup table in the dashboard's utility module, with a fallback chain:

```
1. LIFECYCLE_PHASE_LABELS[stepId] (exact match — works for non-gate steps)
2. GATE_STEP_TO_PHASE[stepId] (explicit gate mapping)
3. LIFECYCLE_PHASE_LABELS[stepId.replace(/_gate$/, '')] + " Gate" (suffix strip)
4. stepId (raw fallback)
```

### AD-3: `steps[]` array — extend `lib/build.js` in this feature

STRAT-COMP-5 adds `stepNum`, `totalSteps`, `retries`, `violations` as scalar fields to `active-build.json`. The design for STRAT-COMP-8 requires a `steps[]` array with per-step `{ id, status, startedAt, completedAt, retries, violations, mode }`. This array is only consumed by `StepTimeline` and `AuditTrail` — both STRAT-COMP-8 components. Therefore, the `steps[]` array extension to `lib/build.js` belongs in this feature's implementation, not STRAT-COMP-5.

### AD-4: `lastCompletedBuild` ref for AuditTrail

When `activeBuild` transitions from non-null to null (build ended), the dashboard stores the final state in a `useRef`. `AuditTrail` reads from this ref. The ref is cleared after 60 seconds (auto-collapse timer). This avoids the need for server-side build history persistence.

### AD-5: No polling — WebSocket + REST hydration only

The new dashboard performs zero `setInterval` polling. All state arrives via:
- `buildStateChanged` WebSocket events (from STRAT-COMP-5)
- `gateCreated` / `gateResolved` WebSocket events (existing)
- `visionState` WebSocket broadcasts (existing, includes `gates`)
- `GET /api/build/state` REST call on mount (from STRAT-COMP-5)

### AD-6: Shared gate action patterns — no hook extraction yet

Design Section 3.1 suggests extracting `useGateActions` from `GateView.jsx`. Since `GateAlert` can call `resolveGate()` directly from `useVisionStore` (same API as `GateView.jsx:220`), no shared hook is needed for v1. Both components call `resolveGate(gateId, outcome, comment)`. Extract if a third consumer appears.

---

## Component Designs

### 1. `src/components/build/BuildDashboard.jsx` (new)

**Purpose:** Root container replacing `StratumPanel`. Consumes `useVisionStore` and renders child components.

**Imports:**
```
import { useVisionStore } from '../vision/useVisionStore.js'
import { useState, useEffect, useRef } from 'react'
import GateAlert from './GateAlert.jsx'
import BuildStatusCard from './BuildStatusCard.jsx'
import StepTimeline from './StepTimeline.jsx'
import AuditTrail from './AuditTrail.jsx'
```

**State consumed from `useVisionStore`:**
- `activeBuild` — current build state (null when idle)
- `gates` — all gates (pending + resolved)
- `items` — vision items (for gate feature name lookup)
- `resolveGate` — mutation function for gate actions

**Internal state:**
- `lastCompletedBuild` (`useRef(null)`) — stores final build state when `activeBuild` transitions to null
- `auditVisible` (`useState(false)`) — controls AuditTrail visibility
- `auditCollapseTimer` (`useRef(null)`) — 60-second auto-collapse

**Behavior:**
- `useEffect` watches `activeBuild`: when it transitions from non-null to null, copies the value to `lastCompletedBuild.current`, sets `auditVisible` to true, starts 60-second timer to set `auditVisible` to false. **Cleanup:** the `useEffect` must return `() => clearTimeout(auditCollapseTimer.current)` to prevent the timer firing after unmount
- When `activeBuild` transitions from null to non-null (new build starts), clears `lastCompletedBuild.current` and `auditVisible`

**Render structure:**
```jsx
<div className="flex flex-col h-full overflow-y-auto p-3 gap-3">
  <GateAlert gates={pendingGates} items={items} onResolve={resolveGate} />
  <BuildStatusCard build={activeBuild} />
  {activeBuild && <StepTimeline steps={activeBuild.steps} currentStepId={activeBuild.currentStepId} />}
  {!activeBuild && lastCompletedBuild.current && auditVisible && (
    <AuditTrail build={lastCompletedBuild.current} onCollapse={() => setAuditVisible(false)} />
  )}
</div>
```

Where `pendingGates` is derived: `gates.filter(g => g.status === 'pending')`. If `activeBuild` exists, further filter by `activeBuild.flowId` match (via `gate.flowId`). If no `activeBuild`, show all pending gates.

**Styling:** All Tailwind classes. No inline styles. Background inherits from parent container.

---

### 2. `src/components/build/BuildStatusCard.jsx` (new)

**Purpose:** Active build overview — feature name, phase, progress, elapsed time, retry/violation badges.

**Props:**
- `build` — `activeBuild` object or null

**Imports:**
```
import { Card, CardHeader, CardContent } from '@/components/ui/card.jsx'
import { Badge } from '@/components/ui/badge.jsx'
import { LIFECYCLE_PHASE_LABELS } from '../vision/constants.js'
import { stepLabel } from './build-utils.js'
import { useState, useEffect } from 'react'
```

**Undefined guard:** If `activeBuild === undefined` (STRAT-COMP-5 not yet implemented or store not hydrated), render a developer warning in non-production: `"activeBuild is undefined — STRAT-COMP-5 must be complete before BuildDashboard works correctly"`. In production, treat `undefined` the same as `null` (idle state). **Note:** STRAT-COMP-5 must be complete before this component works correctly.

**Idle state (build is null):**
```jsx
<div className="text-sm text-muted-foreground text-center py-4">
  No active build
</div>
```

**Active state:**
```jsx
<Card>
  <CardHeader className="pb-2">
    <div className="flex items-center justify-between">
      <span className="text-sm font-medium text-foreground">
        {build.featureCode}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">
        {formattedElapsed}
      </span>
    </div>
    <p className="text-xs text-muted-foreground">
      {stepLabel(build.currentStepId)}
    </p>
  </CardHeader>
  <CardContent className="pt-0">
    {/* Progress bar */}
    <div className="flex items-center gap-2 mb-2">
      <span className="text-xs text-muted-foreground tabular-nums">
        Step {build.stepNum} of {build.totalSteps}
      </span>
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-primary rounded-full transition-all"
          style={{ width: `${(build.stepNum / build.totalSteps) * 100}%` }}
        />
      </div>
    </div>
    {/* Badges */}
    <div className="flex gap-1.5">
      {build.retries > 0 && (
        <Badge variant="outline" className="text-amber-400 border-amber-400/30">
          {build.retries} {build.retries === 1 ? 'retry' : 'retries'}
        </Badge>
      )}
      {build.violations > 0 && (
        <Badge variant="outline" className="text-destructive border-destructive/30"
          title={build.violationMessages?.join('\n') ?? ''}>
          {build.violations} {build.violations === 1 ? 'violation' : 'violations'}
        </Badge>
      )}
    </div>
  </CardContent>
</Card>
```

**Elapsed time:** `useEffect` with 1-second `setInterval` from `build.startedAt` to `Date.now()`. Format: `"2m 34s"`, `"1h 12m"`. Clears on unmount or when `build` becomes null.

**Feature code display:** `featureCode` is always a bare code (e.g., `STRAT-COMP-5`) after STRAT-COMP-4 normalization. No prefix stripping is needed; render it directly.

---

### 3. `src/components/build/StepTimeline.jsx` (new)

**Purpose:** Compact vertical stepper showing all build steps with status indicators.

**Props:**
- `steps` — array of `{ id, status, startedAt, completedAt, retries, violations, mode }` (from `activeBuild.steps`)
- `currentStepId` — string

**Imports:**
```
import { cn } from '@/lib/utils.js'
import { Badge } from '@/components/ui/badge.jsx'
import { stepLabel, formatElapsed, formatDuration } from './build-utils.js'
import { useState } from 'react'
```

**Step classification:**
- `completed`: `step.status === 'complete'`
- `current`: `step.id === currentStepId`
- `upcoming`: everything after current

**Collapsed mode:** Collapse when `completedSteps.length > 6` (7 or more triggers collapse). When collapsed, show only the last 2 completed steps. Render a clickable summary line above them: `"N steps completed"` with a chevron. Clicking expands all completed steps. State: `const [expanded, setExpanded] = useState(false)`. At exactly 6 completed steps, no collapse occurs. Add test for exactly 6 — assert no collapse.

**Render per step:**

```jsx
<div className="flex gap-2 items-start">
  {/* Left indicator column */}
  <div className="flex flex-col items-center">
    {/* Icon */}
    {completed && <div className="w-4 h-4 rounded-full flex items-center justify-center text-success">✓</div>}
    {current && <div className="w-4 h-4 rounded-full bg-primary/20 flex items-center justify-center"><div className="w-2 h-2 rounded-full bg-primary animate-pulse" /></div>}
    {upcoming && <div className="w-4 h-4 rounded-full border border-muted-foreground/30" />}
    {/* Connecting line (except last) */}
    {!isLast && <div className="w-px flex-1 bg-border min-h-[8px]" />}
  </div>
  {/* Right content */}
  <div className={cn("pb-2 min-w-0", current && "pb-3")}>
    <div className="flex items-center gap-1.5">
      <span className={cn(
        "text-xs",
        completed && "text-muted-foreground",
        current && "text-foreground font-medium",
        upcoming && "text-muted-foreground/50",
      )}>
        {stepLabel(step.id)}
      </span>
      {step.mode === 'gate' && (
        <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 text-muted-foreground">
          Gate
        </Badge>
      )}
    </div>
    {/* Current step expanded info */}
    {current && (
      <p className="text-[10px] text-muted-foreground mt-0.5">
        {step.status === 'running' ? 'Running' : 'Awaiting gate'}
        {step.startedAt && ` · ${formatElapsed(step.startedAt)}`}
      </p>
    )}
    {/* Completed step duration (single line) */}
    {completed && step.completedAt && step.startedAt && (
      <span className="text-[10px] text-muted-foreground/60">
        {formatDuration(step.startedAt, step.completedAt)}
      </span>
    )}
  </div>
</div>
```

**No inline styles.** All colors via Tailwind tokens. The `animate-pulse` class provides the pulsing current-step indicator.

---

### 4. `src/components/build/GateAlert.jsx` (new)

**Purpose:** Promote pending gates to top of dashboard as actionable alerts.

**Props:**
- `gates` — array of pending gate objects
- `items` — vision items array (for feature name lookup)
- `onResolve` — `resolveGate(gateId, outcome, comment)` from `useVisionStore`

**Imports:**
```
import { useState } from 'react'
import { Button } from '@/components/ui/button.jsx'
import { cn } from '@/lib/utils.js'
import { LIFECYCLE_PHASE_LABELS } from '../vision/constants.js'
```

**Empty state:** Renders nothing (`return null` when `gates.length === 0`).

**Render per gate:**

Follow `GateView.jsx` `PendingGateRow` patterns (line 62-173):
- Approve/Revise/Kill button trio with same `variant="outline" size="sm"` and color classes
- Inline comment input for Revise/Kill with same expand/collapse pattern
- Phase transition display: `LIFECYCLE_PHASE_LABELS[gate.fromPhase] -> LIFECYCLE_PHASE_LABELS[gate.toPhase]`

```jsx
<div className="border-l-2 border-l-amber-400 rounded-md bg-card p-3 space-y-2">
  <div className="flex items-start justify-between gap-2">
    <div className="space-y-0.5 min-w-0">
      <p className="text-sm text-foreground font-medium truncate">
        {itemMap.get(gate.itemId)?.title ?? 'Unknown'}
      </p>
      <p className="text-[10px] text-muted-foreground">
        {LIFECYCLE_PHASE_LABELS[gate.fromPhase] ?? gate.fromPhase}
        {' → '}
        {LIFECYCLE_PHASE_LABELS[gate.toPhase] ?? gate.toPhase}
      </p>
      {gate.summary && (
        <p className="text-xs text-muted-foreground">{gate.summary}</p>
      )}
    </div>
  </div>
  {/* Action buttons — same pattern as GateView.jsx:101-143 */}
  <div className="flex items-center gap-1.5">
    <Button variant="outline" size="sm"
      className="h-6 text-[10px] gap-1 text-success border-success/30 hover:bg-success/10"
      onClick={() => onResolve(gate.id, 'approved')}>
      Approve
    </Button>
    <Button variant="outline" size="sm"
      className={cn(
        'h-6 text-[10px] gap-1 text-amber-400 border-amber-400/30 hover:bg-amber-400/10',
        isExpanded && expandedAction === 'revise' && 'bg-amber-400/10',
      )}
      onClick={() => toggleExpand(gate.id, 'revise')}>
      Revise
    </Button>
    <Button variant="outline" size="sm"
      className={cn(
        'h-6 text-[10px] gap-1 text-destructive border-destructive/30 hover:bg-destructive/10',
        isExpanded && expandedAction === 'kill' && 'bg-destructive/10',
      )}
      onClick={() => toggleExpand(gate.id, 'kill')}>
      Kill
    </Button>
  </div>
  {/* Inline input — same pattern as GateView.jsx:146-170 */}
  {isExpanded && (
    <div className="flex items-center gap-1.5">
      <input
        className="flex-1 text-xs bg-muted text-foreground px-2 py-1 rounded border border-border outline-none"
        placeholder={expandedAction === 'revise' ? 'Feedback (optional)...' : 'Kill reason (required)...'}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus
      />
      <Button variant="outline" size="sm" className="h-6 text-[10px]"
        disabled={expandedAction === 'kill' && !comment.trim()}
        onClick={handleSubmit}>
        {expandedAction === 'revise' ? 'Submit' : 'Confirm Kill'}
      </Button>
    </div>
  )}
</div>
```

**Internal state:** `expandedGateId`, `expandedAction`, `comment` — same pattern as `GateView.jsx:212-218`.

---

### 5. `src/components/build/AuditTrail.jsx` (new)

**Purpose:** Collapsible per-step breakdown after build completes.

**Props:**
- `build` — the completed build state object (from `lastCompletedBuild` ref)
- `onCollapse` — callback when the user or auto-timer collapses the section

**Imports:**
```
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible.jsx'
import { Badge } from '@/components/ui/badge.jsx'
import { stepLabel, formatDuration, formatTotalDuration } from './build-utils.js'
import { useState } from 'react'
```

**Render:**

```jsx
<Collapsible defaultOpen={true}>
  <CollapsibleTrigger className="flex items-center justify-between w-full px-3 py-2 text-xs text-muted-foreground hover:text-foreground">
    <span className="font-medium">Build Audit</span>
    <span>{build.steps?.length ?? 0} steps · {formatTotalDuration(build)}</span>
  </CollapsibleTrigger>
  <CollapsibleContent>
    <div className="space-y-1 px-3 pb-2">
      {build.steps?.map(step => (
        <div key={step.id} className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground min-w-[80px]">{stepLabel(step.id)}</span>
          <span className="text-muted-foreground/60 tabular-nums min-w-[48px]">
            {formatDuration(step.startedAt, step.completedAt)}
          </span>
          {step.retries > 0 && (
            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 text-amber-400 border-amber-400/30">
              {step.retries}r
            </Badge>
          )}
          {step.violations > 0 && (
            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 text-destructive border-destructive/30"
              title={step.violationMessages?.join('\n') ?? ''}>
              {step.violations}v
            </Badge>
          )}
          {step.outcome && (
            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">
              {step.outcome}
            </Badge>
          )}
        </div>
      ))}
    </div>
  </CollapsibleContent>
</Collapsible>
```

---

### 6. `src/components/build/build-utils.js` (new)

**Purpose:** Shared utility functions for build components.

**Exports:**

```js
import { LIFECYCLE_PHASE_LABELS } from '../vision/constants.js';

// Gate step ID -> phase key mapping for irregular cases
const GATE_STEP_TO_PHASE = {
  design_gate: 'explore_design',
  prd_gate: 'prd',
  architecture_gate: 'architecture',
  blueprint_gate: 'blueprint',
  plan_gate: 'plan',
  ship_gate: 'ship',
};

/**
 * Resolve a step ID to a human-readable label.
 * Handles both regular steps and gate steps.
 */
export function stepLabel(stepId) {
  // Direct match
  if (LIFECYCLE_PHASE_LABELS[stepId]) return LIFECYCLE_PHASE_LABELS[stepId];

  // Gate step — use explicit mapping
  if (stepId.endsWith('_gate')) {
    const phaseKey = GATE_STEP_TO_PHASE[stepId];
    if (phaseKey && LIFECYCLE_PHASE_LABELS[phaseKey]) {
      return `${LIFECYCLE_PHASE_LABELS[phaseKey]} Gate`;
    }
    // Fallback: strip _gate, try lookup
    const base = stepId.replace(/_gate$/, '');
    if (LIFECYCLE_PHASE_LABELS[base]) return `${LIFECYCLE_PHASE_LABELS[base]} Gate`;
  }

  // Raw fallback
  return stepId;
}

/**
 * Format elapsed time from a start ISO string to now.
 * Returns "2m 34s", "1h 12m", etc.
 */
export function formatElapsed(startIso) {
  const ms = Date.now() - new Date(startIso).getTime();
  return formatMs(ms);
}

/**
 * Format a duration between two ISO timestamps.
 */
export function formatDuration(startIso, endIso) {
  if (!startIso || !endIso) return '';
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  return formatMs(ms);
}

/**
 * Format milliseconds to human-readable duration.
 */
export function formatMs(ms) {
  if (ms < 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Format total build duration from start to last step completion.
 * Falls back to elapsed-from-now if no step has completed yet.
 */
export function formatTotalDuration(build) {
  const last = build.steps?.at(-1);
  return last?.completedAt
    ? formatDuration(build.startedAt, last.completedAt)
    : formatElapsed(build.startedAt);
}

// NOTE: No displayFeatureName() utility needed.
// featureCode is always a bare code (e.g., "STRAT-COMP-5") after STRAT-COMP-4 normalization.
// Render it directly without prefix stripping.
```

---

### 7. `lib/build.js` — Extend with `steps[]` array (existing)

**Dependency:** STRAT-COMP-5 must be implemented first. STRAT-COMP-5 adds `stepNum`, `totalSteps`, `retries`, `violations` scalars. This task adds the `steps[]` array on top.

#### 7a. `startFresh()` (line 486-498, after STRAT-COMP-5 changes)

After STRAT-COMP-5, `startFresh` writes `stepNum`, `totalSteps`, `retries`, `violations`. Add `steps`:

```js
writeActiveBuild(dataDir, {
  featureCode,
  flowId: response.flow_id,
  startedAt: new Date().toISOString(),
  currentStepId: response.step_id,
  specPath: 'pipelines/build.stratum.yaml',
  stepNum: response.step_number ?? 1,
  totalSteps: response.total_steps ?? null,
  retries: 0,
  violations: 0,
  violationMessages: [],
  steps: [{
    id: response.step_id,
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    retries: 0,
    violations: 0,
    violationMessages: [],
    mode: 'step',
  }],
});
```

#### 7b. `updateActiveBuildStep()` (line 501-507, after STRAT-COMP-5 changes)

After STRAT-COMP-5, this function accepts `extra` fields. Extend to manage `steps[]`:

```js
function updateActiveBuildStep(dataDir, stepId, extra = {}) {
  const state = readActiveBuild(dataDir);
  if (!state) return; // null-guard consistent with sibling code blocks

  // Mark previous current step as complete
  if (state.steps && state.steps.length > 0) {
    const last = state.steps[state.steps.length - 1];
    if (last.status === 'running') {
      last.status = 'complete';
      last.completedAt = new Date().toISOString();
    }
  }

  // Add new step
  const steps = state.steps || [];
  steps.push({
    id: stepId,
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    retries: 0,
    violations: 0,
    violationMessages: [],
    mode: stepId.endsWith('_gate') ? 'gate' : 'step',
  });

  state.currentStepId = stepId;
  state.steps = steps;
  Object.assign(state, extra);
  writeActiveBuild(dataDir, state);
}
```

#### 7c. Retry/violation tracking on current step

In the `ensure_failed`/`schema_failed` handler (around line 269-284), after incrementing top-level `retries`/`violations`, also update the current step entry:

```js
// After updating state-level retries/violations:
const state = readActiveBuild(dataDir);
if (!state) return;
if (state.steps?.length > 0) {
  const currentStep = state.steps[state.steps.length - 1];
  currentStep.retries = (currentStep.retries || 0) + 1;
  const newViolationCount = response.violations?.length || 0;
  currentStep.violations = (currentStep.violations || 0) + newViolationCount;
  // Append violation detail strings
  const messages = response.violations?.map(v => typeof v === 'string' ? v : v.message) || [];
  currentStep.violationMessages = [...(currentStep.violationMessages || []), ...messages];
  state.violationMessages = [...(state.violationMessages || []), ...messages];
  writeActiveBuild(dataDir, state);
}
```

#### 7d. Gate outcome on gate steps

In the `await_gate` handler (around line 217-247), after gate resolution, update the current step's `outcome`:

```js
// After resolveGate:
const state = readActiveBuild(dataDir);
if (!state) return;
if (state.steps?.length > 0) {
  const currentStep = state.steps[state.steps.length - 1];
  currentStep.outcome = outcome; // 'approved', 'revised', 'killed'
  writeActiveBuild(dataDir, state);
}
```

---

### 8. `src/App.jsx` — Swap StratumPanel for BuildDashboard (existing)

#### 8a. Import change (line 5)

Before:
```js
import StratumPanel from './components/StratumPanel';
```

After:
```js
import StratumPanel from './components/StratumPanel';
import BuildDashboard from './components/build/BuildDashboard';
```

#### 8b. Feature flag and tab swap (line 279, 295)

```jsx
// Feature flag at top of App component body
const USE_BUILD_DASHBOARD = true; // flip to false to revert

// Line 279: tab label is conditional on the flag
{['Canvas', USE_BUILD_DASHBOARD ? 'Build' : 'Stratum'].map(tab => (
  // ... existing tab button code
))}

// Line 295: conditional render
{rightTab === 'Canvas'
  ? <Canvas fontSize={fontSize} />
  : USE_BUILD_DASHBOARD
    ? <BuildDashboard />
    : <StratumPanel />
}
```

The constant `USE_BUILD_DASHBOARD` lives at the top of the `App` component function body. Tab label changes from "Stratum" to "Build" **only when `USE_BUILD_DASHBOARD = true`**. When false, keep the tab label as "Stratum" to match the old component.

---

## Step ID to Phase Name Mapping

Complete mapping table for all known step IDs. Source: `constants.js:48-61` + gate convention.

| Step ID | Label | Source |
|---|---|---|
| `explore_design` | Design | `LIFECYCLE_PHASE_LABELS` |
| `design_gate` | Design Gate | `GATE_STEP_TO_PHASE` -> `explore_design` |
| `prd` | PRD | `LIFECYCLE_PHASE_LABELS` |
| `prd_gate` | PRD Gate | suffix strip -> `prd` |
| `architecture` | Architecture | `LIFECYCLE_PHASE_LABELS` |
| `architecture_gate` | Architecture Gate | suffix strip -> `architecture` |
| `blueprint` | Blueprint | `LIFECYCLE_PHASE_LABELS` |
| `blueprint_gate` | Blueprint Gate | suffix strip -> `blueprint` |
| `verification` | Verification | `LIFECYCLE_PHASE_LABELS` |
| `plan` | Plan | `LIFECYCLE_PHASE_LABELS` |
| `plan_gate` | Plan Gate | suffix strip -> `plan` |
| `execute` | Execute | `LIFECYCLE_PHASE_LABELS` |
| `report` | Report | `LIFECYCLE_PHASE_LABELS` |
| `docs` | Docs | `LIFECYCLE_PHASE_LABELS` |
| `ship` | Ship | `LIFECYCLE_PHASE_LABELS` |
| `ship_gate` | Ship Gate | suffix strip -> `ship` |
| `complete` | Complete | `LIFECYCLE_PHASE_LABELS` |
| `killed` | Killed | `LIFECYCLE_PHASE_LABELS` |
| `coverage` | coverage | raw fallback (no label in constants) |
| (any unknown) | raw step ID | raw fallback |

---

## Build Sequence

| # | Task | File(s) | Depends On | Notes |
|---|------|---------|------------|-------|
| 1 | Create `build-utils.js` with `stepLabel`, `formatElapsed`, `formatDuration`, `formatMs`, `formatTotalDuration` | `src/components/build/build-utils.js` (new) | -- | Pure utility, no dependencies. Testable in isolation. No `displayFeatureName` — featureCode is always bare after STRAT-COMP-4 |
| 2 | Create `BuildStatusCard` component | `src/components/build/BuildStatusCard.jsx` (new) | 1 | Uses `stepLabel` from build-utils. Renders `featureCode` directly (no prefix stripping). Uses `Card`, `Badge` from shadcn |
| 3 | Create `StepTimeline` component | `src/components/build/StepTimeline.jsx` (new) | 1 | Uses `stepLabel` from build-utils. Uses `Badge` from shadcn |
| 4 | Create `GateAlert` component | `src/components/build/GateAlert.jsx` (new) | -- | Uses `Button`, `cn`, `LIFECYCLE_PHASE_LABELS`. Follow `GateView.jsx` patterns |
| 5 | Create `AuditTrail` component | `src/components/build/AuditTrail.jsx` (new) | 1 | Uses `Collapsible`, `Badge`, `stepLabel` |
| 6 | Create `BuildDashboard` container | `src/components/build/BuildDashboard.jsx` (new) | 2, 3, 4, 5 | Imports all child components, consumes `useVisionStore` |
| 7 | Verify STRAT-COMP-5 prerequisites exist | `src/components/vision/useVisionStore.js`, `visionMessageHandler.js` | -- | Check that `activeBuild` state, `buildStateChanged` handler, and `GET /api/build/state` hydration are present. If not, STOP — STRAT-COMP-5 must be implemented first |
| 8 | Extend `startFresh()` with `steps[]` array | `lib/build.js` (existing) | 7 | Add `steps: [{ id, status, startedAt, ... }]` to initial write |
| 9 | Extend `updateActiveBuildStep()` with `steps[]` management | `lib/build.js` (existing) | 8 | Mark previous step complete, add new step entry |
| 10 | Add per-step retry/violation tracking | `lib/build.js` (existing) | 9 | In `ensure_failed`/`schema_failed` handler, update current step's `retries`/`violations` |
| 11 | Add gate outcome tracking to steps | `lib/build.js` (existing) | 9 | In `await_gate` handler, write `outcome` to current step entry |
| 12 | Wire `BuildDashboard` into `App.jsx` behind feature flag | `src/App.jsx` (existing) | 6 | Add import, feature flag constant, conditional render. Tab label changes to "Build" only when `USE_BUILD_DASHBOARD = true` |
| 13 | Smoke test: verify dashboard renders in idle state | -- | 12 | Open app, switch to Build tab. Should show "No active build" and no gate alerts |
| 14 | Integration test: run a build and verify live updates | -- | 10, 11, 12 | Run `compose build`, verify dashboard shows status card, step timeline, elapsed time |
| 15 | Delete `StratumPanel` and remove feature flag | `src/components/StratumPanel.jsx` (delete), `src/App.jsx` (existing) | 14 | Remove `StratumPanel` import, remove flag, render `BuildDashboard` directly |

---

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|------------|
| STRAT-COMP-5 not yet implemented when STRAT-COMP-8 starts | High — no `activeBuild` state, no WS events, no REST endpoint | High (both are in design) | Task 7 is an explicit gate check. Tasks 1-6 (new component files) can proceed independently — they compile without STRAT-COMP-5. Tasks 8-11 (lib/build.js) and 12+ (wiring) require STRAT-COMP-5 |
| `steps[]` array grows large in long builds (20+ steps with retries) | Low — JSON size increase in `active-build.json` and WS broadcast | Low | 20 steps with 5 fields each is ~2KB. No cap needed for v1 |
| `useVisionStore` per-instance state — multiple consumers see different `activeBuild` | Medium — each `useVisionStore()` call creates its own WebSocket connection and state | Low (only `BuildDashboard` calls the store in the right panel) | `BuildDashboard` is the sole consumer in the Build tab. `VisionTracker` uses its own instance in the sidebar. Both get the same WS events, so `activeBuild` stays in sync. If a third consumer appears, extract to shared context |
| Removing StratumPanel removes access to raw flow/gate lists | Low — power users lose the debug view | Medium | GateView.jsx in the sidebar already provides full gate management. Flow list data is available in the Stratum MCP server. If needed, add a debug toggle to BuildDashboard in a follow-up |
| AuditTrail `lastCompletedBuild` ref lost on page reload | Low — audit detail disappears | High (any page reload clears refs) | Accepted for v1 per design doc Open Question 3. Server-side build history is out of scope |
| Progress bar `style={{ width }}` is the one inline style | Low — needed for dynamic percentage width | N/A | This is the standard pattern for progress bars in Tailwind. The value is computed, not a static color. Acceptable exception to the "zero inline styles" rule |

---

## Behavioral Test Checkpoints

### Golden Flow: Idle state renders correctly

1. Start the app with no active build
2. Switch to the Build tab
3. Assert: "No active build" text visible, centered, `text-muted-foreground`
4. Assert: No gate alert cards (empty state renders nothing)
5. Assert: No step timeline or audit trail visible

### Golden Flow: Active build renders with live updates

1. Pre-condition: STRAT-COMP-5 is implemented
2. Start `compose build FEAT-TEST`
3. Switch to Build tab
4. Assert: `BuildStatusCard` shows "FEAT-TEST" as feature name
5. Assert: Current phase displays human-readable label (e.g., "Design"), not "explore_design"
6. Assert: Progress shows "Step 1 of N" with narrow progress bar
7. Assert: Elapsed time increments every second
8. Wait for step transition
9. Assert: `StepTimeline` shows first step with green checkmark, second step with pulsing indicator
10. Assert: Progress bar width increases, step counter increments

### Golden Flow: Gate alert renders and resolves

1. Build reaches a gate step (e.g., `design_gate`)
2. Assert: `GateAlert` card appears at top of dashboard with amber left border
3. Assert: Feature name, phase transition ("Design -> PRD"), and action buttons visible
4. Click "Approve"
5. Assert: Gate alert disappears (gate removed from pending list via `gateResolved` WS event)
6. Assert: Build continues to next step

### Gate alert: Revise with comment

1. Gate is pending
2. Click "Revise" button
3. Assert: Inline input appears with "Feedback (optional)..." placeholder
4. Type a comment, press Enter
5. Assert: `resolveGate` called with `(gateId, 'revised', comment)`
6. Assert: Gate alert disappears

### Gate alert: Kill requires comment

1. Gate is pending
2. Click "Kill" button
3. Assert: Inline input appears with "Kill reason (required)..." placeholder
4. Assert: "Confirm Kill" button is disabled when input is empty
5. Type a reason, click "Confirm Kill"
6. Assert: `resolveGate` called with `(gateId, 'killed', reason)`

### Step timeline: Collapse behavior

1. Build has 8 completed steps, 1 current step
2. Assert: Only last 2 completed steps shown, plus "6 steps completed" summary line
3. Click the summary line
4. Assert: All 8 completed steps expand
5. Click again
6. Assert: Collapses back to 2 + summary

### Step timeline: No collapse at threshold boundary

1. Build has exactly 6 completed steps, 1 current step
2. Assert: All 6 completed steps are shown (no collapse, no summary line)

### Audit trail: Post-build display and auto-collapse

1. Build completes
2. Assert: `AuditTrail` appears, expanded by default
3. Assert: Shows per-step rows with phase labels, durations, retry/violation counts
4. Wait 60 seconds
5. Assert: `AuditTrail` collapses automatically (or disappears via `auditVisible` -> false)

### Theme compliance

1. Switch app to light mode
2. Assert: All text is readable (no white-on-white or invisible elements)
3. Assert: Progress bar fill uses `bg-primary`, track uses `bg-muted`
4. Assert: Gate alert amber border visible
5. Assert: No hex color literals visible in rendered styles (inspect DOM)

### Retry/violation badge display

1. Build has a step that fails postconditions and retries
2. Assert: `BuildStatusCard` shows "1 retry" badge in amber
3. Step retries again
4. Assert: Badge updates to "2 retries"
5. Assert: `StepTimeline` current step does NOT show retry badge (only the status card shows totals)

### Zero polling verification

1. Open browser network tab
2. Switch to Build tab, wait 30 seconds
3. Assert: No repeated `GET /api/stratum/flows` or `GET /api/stratum/gates` requests
4. Assert: Only WebSocket frames and the initial `GET /api/build/state` hydration call

### Feature flag revert

1. Set `USE_BUILD_DASHBOARD = false` in `App.jsx`
2. Reload
3. Assert: Old `StratumPanel` renders with its polling behavior
4. Set back to `true`
5. Assert: New `BuildDashboard` renders
