# STRAT-COMP-8: Active Build Dashboard

**Status:** Design
**Created:** 2026-03-12
**Roadmap:** [ROADMAP.md](../../../ROADMAP.md) — Milestone 4, item 51

## Related Documents

- [STRAT-COMP-4 design](../STRAT-COMP-4/design.md) — parent feature, Unified Interface
- [STRAT-COMP-5 design](../STRAT-COMP-5/design.md) — build visibility (data source for this feature)
- [STRAT-COMP-6 design](../STRAT-COMP-6/design.md) — web gate resolution (gate UI patterns)

---

## 0. Scope

### Goals

- Replace `StratumPanel.jsx` with a design-system-compliant build dashboard
- Show active build status, step timeline, pending gate alerts, and post-build audit trail
- Drive all state from WebSocket events (zero polling)
- Use design system tokens throughout (light/dark theme support)
- Meet STRAT-COMP-4 UX requirements: human-readable labels, agent name on current step, retry/violation badges on current step, `>=48px` gate action tap targets, expandable audit trail with intent+outcome+duration

### Non-Goals (explicitly out of scope for v1)

- **Agent stream integration:** Real-time agent output in the current step row is deferred. STRAT-COMP-7's `AgentStream.jsx` is a separate panel.
- **Concurrent builds:** `active-build.json` is single-build. Multiple simultaneous builds are not supported.
- **Audit trail persistence:** `lastCompletedBuild` is a React ref, lost on page reload. Server-side build history is out of scope.
- **Orphaned gate cleanup:** Gates from ended builds remain in the pending list until resolved or the server clears them. No automatic cleanup.
- **Estimated remaining time:** Requires historical build data. The `steps[]` schema supports this for future use.

---

## 1. Problem Statement

### What exists today

`StratumPanel.jsx` is a developer debug view that renders raw Stratum data. It has no awareness of `active-build.json`, no design system integration, and no meaningful information hierarchy.

**Concrete UX failures:**

1. **No build awareness.** The panel polls `GET /api/stratum/flows` every 15 seconds and `GET /api/stratum/gates` every 10 seconds. It has no connection to `active-build.json` and no ability to receive `buildState` WebSocket events from STRAT-COMP-5. A build can advance three steps before the UI notices.

2. **Raw identifiers instead of human names.** Steps render as monospace IDs (`explore_design`, `prd_gate`) in an `<ol>` list. The panel does not use `LIFECYCLE_PHASE_LABELS` to show "Design", "PRD", "Architecture" — labels that already exist in `constants.js` and are used correctly by `GateView.jsx`.

3. **Flat structure, no grouping.** Flows render as a flat clickable list. Gates render as a separate flat list. There is no grouping by feature, no hierarchy between a build and its steps, and no connection between a pending gate and the build that produced it.

4. **Hardcoded dark-mode colors.** The panel uses inline `style` attributes with hex values: `#2a2a2a`, `#7c3aed`, `#166534`, `#7f1d1d`, `#18181b`, `#3f3f46`, `#e4e4e7`, `#e5e7eb`, `#9ca3af`, `#1e3a5f`, `#6366f1`, `#1e1b4b`, `#f59e0b`, `#ef4444`. These are not design system tokens. The panel is unreadable in light mode.

5. **No step progress visualization.** Steps are shown as a numbered `<ol>` with completed steps at `opacity: 0.4`. There is no progress bar, no stepper, no visual indication of "3 of 12 steps complete".

6. **Gates buried in a separate section.** Pending gates render in a `GateQueue` component at the top of the panel with tiny inline buttons (Approve/Reject/Revise) using hardcoded background colors. They have no connection to the build context — the user sees `flow_id` and `step_id` but not "Design Review for FEAT-1".

### What should exist

A build dashboard that shows:
- Active build as a prominent card with feature name, current phase (human-readable), step progress
- Steps as a compact timeline — completed steps collapsed, current step expanded with status
- Pending gates promoted to top-level alerts with full context
- Design system tokens throughout, light/dark theme support
- Live updates via WebSocket, not polling

---

## 2. Architecture

### Component Tree

```
BuildDashboard (replaces StratumPanel)
  ├── GateAlert (0..n)         — promoted pending gates, top of dashboard
  ├── BuildStatusCard (0..1)   — active build overview
  │   ├── feature name + phase label
  │   ├── step progress bar (stepNum / totalSteps)
  │   ├── elapsed time (live)
  │   └── retry/violation badges
  ├── StepTimeline             — compact stepper for build steps
  │   ├── completed steps (collapsed, checkmark)
  │   ├── current step (expanded, spinner + status)
  │   └── upcoming steps (dimmed)
  └── AuditTrail (0..1)       — expandable per-step detail after build completes
      └── per-step: duration, retries, violations, outcome
```

### State Sources

**Primary: `useVisionStore`**

The dashboard reads from two pieces of state already managed by `useVisionStore`:

| State | Source | Description |
|---|---|---|
| `activeBuild` | `buildState` WS event (STRAT-COMP-4 canonical name; STRAT-COMP-5 blueprint/plan may reference the earlier name `buildStateChanged` — this design uses the canonical `buildState` per STRAT-COMP-4) | Current build state from `active-build.json` |
| `gates` | `visionState` WS broadcast + `gateCreated`/`gateResolved` events | All gates (pending + resolved) |

`activeBuild` is added to `useVisionStore` by STRAT-COMP-5. When a `buildState` WS message arrives, `activeBuild` is set to the message payload (the full `active-build.json` contents with `type: "buildState"` prepended). Per STRAT-COMP-4: the file remains on disk with a terminal `status` (`complete`/`failed`/`aborted`) after the build ends — it is NOT deleted or set to null. The dashboard detects build completion by checking `activeBuild.status !== 'running'`.

**Fallback: REST hydration**

On mount (or WebSocket reconnect), the dashboard calls `GET /api/build/state` (added by STRAT-COMP-5) to hydrate `activeBuild` in case a build is already running.

**No more polling.** The dashboard does not poll `GET /api/stratum/flows` or `GET /api/stratum/gates`. All state arrives via WebSocket push. If the WebSocket disconnects, `useVisionStore` already reconnects automatically (2-second retry in the existing implementation).

**REST hydration fallback:** On mount and on WebSocket reconnect, `BuildDashboard` calls `GET /api/build/state` (STRAT-COMP-5) to hydrate `activeBuild`. This covers: (1) initial page load when a build is already running, (2) recovery after WebSocket disconnect where `buildState` events may have been missed, (3) stale state from file-watcher debounce gaps. If the REST call fails, the dashboard remains in idle state until the next WebSocket event arrives.

### Data Flow

```
lib/build.js
  writeActiveBuild() → .compose/data/active-build.json
                                   ↓
server/file-watcher.js (STRAT-COMP-5)
  fs.watch → debounce 100ms → onBuildStateChanged(state)
                                   ↓
server/index.js
  → visionServer.broadcastMessage({ type: 'buildState', ...fields })
                                   ↓
/ws/vision
                                   ↓
visionMessageHandler.js
  → setActiveBuild(fields)          // extended schema (see §4)
                                   ↓
BuildDashboard
  ├── BuildStatusCard (reads activeBuild)
  ├── StepTimeline (reads activeBuild.steps + activeBuild.allStepIds)
  ├── GateAlert (reads gates, filtered by activeBuild.flowId)
  └── AuditTrail (reads lastCompletedBuild ref — captured from the terminal activeBuild snapshot when status transitions to complete/failed/aborted)
```

---

## 3. Component Design

### 3.1 GateAlert

**Purpose:** Promote pending gates to the top of the dashboard as urgent, actionable alerts. Gates should never be buried below build status.

**Position:** Top of `BuildDashboard`, above `BuildStatusCard`.

**Pattern:** Reuse the interaction patterns from `GateView.jsx` — specifically `PendingGateRow`'s Approve/Revise/Kill button trio, inline comment input, and `stepLabel()` for phase names. Do not duplicate the component; extract shared gate action logic into a `useGateActions` hook if needed.

**Rendering:**
- Each pending gate renders as a card with amber left border (`border-l-2 border-l-amber-400`)
- Feature name: resolved via `items.find(i => i.id === gate.itemId)?.title`, with fallback to literal "Unknown" if the Vision item is missing or stale. **Note:** `gate.featureCode` is not part of the STRAT-COMP-6 gate schema. If a richer fallback is needed in the future, `featureCode` should be added to the gate creation contract upstream. For v1, the fallback chain is: (1) Vision item title, (2) "Unknown"
- Phase transition: `LIFECYCLE_PHASE_LABELS[gate.fromPhase] → LIFECYCLE_PHASE_LABELS[gate.toPhase]`
- Summary text (from `gate.summary`, added in STRAT-COMP-6)
- Artifact link (opens in canvas via `POST /api/canvas/open`)
- Approve / Revise / Kill buttons — use `Button` from `@/components/ui/button.jsx` with `variant="outline"`. Per STRAT-COMP-4 requirement, gate action buttons must have `>= 48px` tap targets. Use `size="default"` (not `size="sm"`) to meet this requirement, with `min-h-[48px]` if the default size is smaller than 48px
- Inline comment input for Revise/Kill (same pattern as `PendingGateRow`)

**Empty state:** When no gates are pending, `GateAlert` renders nothing (no placeholder, no "No gates pending" text at the top).

**Gate outcome vocabulary:** Per STRAT-COMP-4/6, the canonical outcome enum is `approve`/`revise`/`kill` (imperative). The existing `GateView.jsx` currently sends past-tense values (`approved`/`revised`/`killed`), but STRAT-COMP-6 design specifies server-side normalization to imperative form. `GateAlert` must use the canonical imperative values: `onResolve(gate.id, 'approve')`, `onResolve(gate.id, 'revise', comment)`, `onResolve(gate.id, 'kill', comment)`. The server normalizes these consistently regardless of whether the caller sends imperative or past-tense.

**Relationship to GateView.jsx:** `GateView.jsx` remains the full gate management view in the sidebar. `GateAlert` is a lightweight promotion of pending gates into the build dashboard context. Both call the same `resolveGate()` from `useVisionStore`. Resolving a gate in either location updates both via the `gateResolved` WebSocket event.

### 3.2 BuildStatusCard

**Purpose:** Show the active build at a glance — what feature, what phase, how far along, how long it has been running.

**Rendering:**
- Uses `Card` from `@/components/ui/card.jsx` with `CardHeader` and `CardContent`
- Feature name: `activeBuild.featureCode` displayed directly — featureCode is always a bare code (e.g., `STRAT-COMP-5`) after STRAT-COMP-4 normalization
- Current phase: `stepLabel(activeBuild.currentStepId)` — uses the shared `stepLabel()` utility (see Section 4.3) which resolves gate steps via `GATE_STEP_TO_PHASE` lookup and falls back to raw `currentStepId` if no label exists
- Step progress: `activeBuild.stepNum` / `activeBuild.totalSteps` rendered as:
  - Text: "Step 3 of 12"
  - Progress bar: a `div` with `bg-primary` fill at `(stepNum / totalSteps * 100)%` width, inside a `bg-muted` track. Height `h-1.5`, rounded.
- Elapsed time: live counter from `activeBuild.startedAt` to `Date.now()`, updated every second via `useEffect` interval. Format: "2m 34s", "1h 12m", etc.
- Badges (when non-zero):
  - Retries: `Badge` with `variant="outline"` and warning color, e.g., "2 retries"
  - Violations: `Badge` with `variant="outline"` and destructive color, e.g., "1 violation". `build.violations` is a numeric count. For detail display (e.g., tooltips), read `build.violationMessages` (a `string[]`)

**Undefined guard:** If `activeBuild === undefined` (STRAT-COMP-5 not yet implemented or store not hydrated), render a developer warning in non-production: `"activeBuild is undefined — STRAT-COMP-5 must be complete before BuildDashboard works correctly"`. In production, treat `undefined` the same as `null` (idle state). **Note:** STRAT-COMP-5 must be complete before this component works correctly.

**Empty state:** When `activeBuild` is `null`/`undefined` or `activeBuild.status !== 'running'`, `BuildStatusCard` renders a quiet idle state:
```
No active build
```
Single line, `text-sm text-muted-foreground`, centered in the card area.

### 3.3 StepTimeline

**Purpose:** Show build steps as a compact vertical stepper, not a numbered list. The user should see where the build is at a glance.

**Rendering:**
- Vertical layout, each step as a row with a left-side indicator
- **Completed steps:** Collapsed. Green checkmark icon (`text-success`), phase label (via `stepLabel()`), duration if available. `text-muted-foreground`, single line.
- **Current step:** Expanded. Animated spinner or pulsing dot (`text-primary`), phase label in `text-foreground font-medium`, agent name (from `step.agent` — e.g., "claude", "codex"; omitted for gate steps), status text derived from `step.status`: `running` -> "Running", `awaiting_gate` -> "Awaiting gate" (gate steps transition from `running` to `awaiting_gate` when the gate is created and waiting for human resolution), retry/violation badges (per STRAT-COMP-4: "Retry count and violation count render as numeric badges on the current step row"), elapsed time for this step. Per STRAT-COMP-4: the current step must show `label + agent name + status`. **Agent stream detail (STRAT-COMP-7):** Showing real-time agent output (e.g., streaming text from the executing agent) in the current step is explicitly deferred to a future feature. STRAT-COMP-8 shows the agent name and status label but not streaming output. STRAT-COMP-7's `AgentStream.jsx` operates in a separate panel and is not integrated into `StepTimeline`.
- **Upcoming steps:** Dimmed. Circle outline (`text-muted-foreground/50`), phase label in `text-muted-foreground`.
- Connecting line between step indicators: `border-l border-border` on the left side, running through all steps.

**Step list source:** `activeBuild.steps` array (see Section 4 for schema) provides completed and current steps with `{ id, status, startedAt, completedAt, retries, violations, mode }`. For upcoming steps, the dashboard uses `activeBuild.allStepIds` — an ordered array of all step IDs in the build (written at build start from the pipeline spec). Steps in `allStepIds` that do not yet appear in `steps[]` are rendered as upcoming. This decouples the step name list (known at plan time) from the step detail (accumulated at runtime).

**Skipped steps:** When Stratum skips a step (via `skip_if` conditions), `lib/build.js` adds the step to `steps[]` with `status: 'skipped'` and no `startedAt`/`completedAt`. `StepTimeline` renders skipped steps with a dash or skip icon (`text-muted-foreground/40`), grouped with completed steps. Skipped steps count toward progress (`stepNum` increments). `allStepIds` always reflects the full static pipeline; skipped steps are distinguished by their `status` in `steps[]`, not by omission from `allStepIds`.

**Collapsed mode:** Collapse when `completedSteps.length + skippedSteps.length > 6` (7 or more triggers collapse). When collapsed, show only the last 2 completed/skipped steps plus a summary line: "N steps completed" with a chevron to expand. At exactly 6 completed+skipped steps, no collapse occurs.

**Gate indicator:** Steps with `mode: 'gate'` show a small gate icon or `Badge variant="outline"` with "Gate" label next to the phase name.

### 3.4 AuditTrail

**Purpose:** After a build completes (or is killed), show a detailed per-step breakdown. This replaces the raw `FlowDetail` component's `<ol>` of step IDs.

**Rendering:**
- Collapsible section (using `Collapsible` from `@/components/ui/collapsible.jsx`)
- Header: "Build Audit" with step count and total duration
- Each step row (per STRAT-COMP-4: "click to reveal intent + outcome + duration"):
  - Phase label (human-readable)
  - Duration
  - Retry count (if > 0)
  - Violation count (if > 0)
  - Outcome badge: `complete` (regular steps) / `skipped` (skipped steps) / `failed` (failed steps — runtime error or exhausted retries) / `approve` / `revise` / `kill` (gate steps — canonical imperative enum per STRAT-COMP-4/6)
  - Intent text (expandable, from `step.intent`) — shown on click/expand per STRAT-COMP-4 requirement

**Terminal state write requirement:** On build completion, `lib/build.js` writes a final `active-build.json` snapshot that: (1) marks the last running step as its terminal status with `completedAt`, (2) sets the top-level `status` field to `complete`/`failed`/`aborted` per STRAT-COMP-4 canonical values, and (3) sets `completedAt` at the top level. **The file remains on disk** (it is NOT deleted or set to null — per STRAT-COMP-4 canonical terminal state design). It is overwritten on next build start.

**Terminal status values (aligned with STRAT-COMP-4/5):**

| `status` value | Meaning | Per-step status |
|---|---|---|
| `running` | Build in progress | Current step: `running` or `awaiting_gate` |
| `complete` | Build finished successfully | Last step: `complete` |
| `failed` | Runtime error or exhausted retries | Last step: `failed` |
| `aborted` | User killed the build via gate | Last step: `complete` with `outcome: kill` |

The dashboard detects build completion via `activeBuild.status !== 'running'`. When `status` transitions to a terminal value, the `buildState` WS broadcast carries the terminal snapshot. The dashboard stores this in `lastCompletedBuild.current` and shows the `AuditTrail`. A new build start overwrites `active-build.json`, triggering a new `buildState` broadcast that replaces the terminal state with `status: 'running'`.

**Visibility:** Only renders when the build has finished. When `activeBuild.status` transitions from `running` to a terminal value (`complete`/`failed`/`aborted`), the dashboard stores the terminal snapshot in `lastCompletedBuild.current` and shows the audit trail. The file persists on disk with terminal status — it is NOT deleted. When a new build starts (status changes back to `running`), `lastCompletedBuild` is cleared and the audit trail is hidden. The audit trail auto-collapses after 60 seconds via a `setTimeout` stored in `auditCollapseTimer.current`. The `useEffect` that starts this timer must include a cleanup function: `return () => clearTimeout(auditCollapseTimer.current)` to prevent the timer firing after unmount.

---

## 4. Data Requirements

### 4.1 Extended `active-build.json` Schema

**Current schema** (written by `build.js:writeActiveBuild`):

```json
{
  "featureCode": "STRAT-COMP-5",
  "flowId": "7f9d436c-2968-40a1-863e-6d76987f9ca0",
  "startedAt": "2026-03-12T04:41:42.337Z",
  "currentStepId": "explore_design",
  "specPath": "pipelines/build.stratum.yaml"
}
```

**Extended schema** (required by the dashboard):

```json
{
  "featureCode": "STRAT-COMP-5",
  "flowId": "7f9d436c-2968-40a1-863e-6d76987f9ca0",
  "startedAt": "2026-03-12T04:41:42.337Z",
  "currentStepId": "architecture",
  "specPath": "pipelines/build.stratum.yaml",
  "pipeline": "build",
  "status": "running",
  "allStepIds": ["explore_design", "design_review", "design_gate", "prd", "prd_review", "prd_gate", "architecture", "architecture_review", "architecture_gate", "blueprint", "verification", "blueprint_review", "plan", "plan_review", "plan_gate", "execute", "review", "coverage", "report", "report_review", "report_gate", "docs", "ship", "ship_gate"],
  "stepNum": 7,
  "totalSteps": 24,
  "retries": 1,
  "violations": 0,
  "violationMessages": [],
  "steps": [
    {
      "id": "explore_design",
      "status": "complete",
      "startedAt": "2026-03-12T04:41:43.000Z",
      "completedAt": "2026-03-12T04:48:12.000Z",
      "retries": 0,
      "violations": 0,
      "violationMessages": [],
      "mode": "step"
    },
    {
      "id": "design_review",
      "status": "complete",
      "startedAt": "2026-03-12T04:48:12.000Z",
      "completedAt": "2026-03-12T04:48:45.000Z",
      "retries": 0,
      "violations": 0,
      "violationMessages": [],
      "mode": "step"
    },
    {
      "id": "design_gate",
      "status": "complete",
      "startedAt": "2026-03-12T04:48:45.000Z",
      "completedAt": "2026-03-12T04:49:01.000Z",
      "retries": 0,
      "violations": 0,
      "violationMessages": [],
      "mode": "gate",
      "outcome": "approve"
    },
    {
      "id": "prd",
      "status": "skipped",
      "startedAt": null,
      "completedAt": null,
      "retries": 0,
      "violations": 0,
      "violationMessages": [],
      "mode": "step"
    },
    {
      "id": "prd_review",
      "status": "skipped",
      "startedAt": null,
      "completedAt": null,
      "retries": 0,
      "violations": 0,
      "violationMessages": [],
      "mode": "step"
    },
    {
      "id": "prd_gate",
      "status": "skipped",
      "startedAt": null,
      "completedAt": null,
      "retries": 0,
      "violations": 0,
      "violationMessages": [],
      "mode": "gate"
    },
    {
      "id": "architecture",
      "status": "running",
      "startedAt": "2026-03-12T04:49:02.000Z",
      "completedAt": null,
      "retries": 1,
      "violations": 0,
      "violationMessages": [],
      "mode": "step",
      "agent": "claude"
    }
  ]
}
```

### 4.2 Changes to `lib/build.js`

The `writeActiveBuild()` and `updateActiveBuildStep()` functions must be extended to write the additional fields.

**`writeActiveBuild(dataDir, state)`** — called at build start. Must include `allStepIds` (ordered array of all step IDs from the pipeline spec, used by `StepTimeline` for upcoming step rendering), `stepNum: 1`, `totalSteps: allStepIds.length` (always equal to `allStepIds.length` — these represent the same count, `totalSteps` is the scalar shorthand for progress bar math), `retries: 0`, `violations: 0`, `steps: [{ id, status, startedAt, completedAt, retries, violations, violationMessages, mode, agent, intent }]`.

**Per-step fields:**
- `id` (string) — step ID from pipeline spec
- `status` (string) — one of: `running`, `awaiting_gate` (gate step waiting for human resolution), `complete`, `skipped`, `failed`. Note: killed builds set the top-level `status` to `aborted`; the last gate step has `status: 'complete'` with `outcome: 'kill'`. There is no per-step `killed` status
- `startedAt` (ISO string | null) — null for skipped steps
- `completedAt` (ISO string | null)
- `retries` (number)
- `violations` (number)
- `violationMessages` (string[])
- `mode` (string) — `step` or `gate`
- `agent` (string | null) — the agent executing the step (e.g., `"claude"`, `"codex"`), from the pipeline spec's `agent` field. Null for gate steps and skipped steps
- `intent` (string | null) — the step's intent description from the pipeline spec. Stored at build start from the spec so the audit trail can display it without re-reading the spec. Null for gate steps

**`updateActiveBuildStep(dataDir, stepId)`** — called on each step transition. Must:
1. Mark the previous current step as `complete` with `completedAt`
2. Increment `stepNum`
3. Add the new step to the `steps` array with `status: 'running'`
4. Update `currentStepId`

**Gate step status transition:** Gate steps use two fields: `status` for lifecycle state and `outcome` for the resolution result.

| Transition | `status` | `outcome` |
|---|---|---|
| Gate step starts | `running` | null |
| Gate created, waiting for human | `awaiting_gate` | null |
| Human approves | `complete` | `approve` |
| Human revises | `complete` | `revise` |
| Human kills | `complete` | `kill` |

When a gate step enters the `await_gate` handler in `lib/build.js`, it updates the current step's `status` from `running` to `awaiting_gate` via `readActiveBuild` + write. This is a same-step-ID status change (no step transition). After gate resolution, `status` transitions to `complete` and `outcome` is set to the resolution value. Both writes trigger `buildState` WS events. The `status` field drives the UI rendering (spinner vs "Awaiting gate" vs checkmark). The `outcome` field is displayed in the audit trail.

**Retry and violation tracking:** When `executeStep` catches a retry or postcondition violation (already tracked in `build.js`'s step execution loop), increment `retries` or `violations` on both the top-level counters and the current step entry. Append violation detail strings to `violationMessages` (top-level) and the current step's `violationMessages`. After calling `readActiveBuild()`, add a null-guard: `if (!state) return;` — consistent with the pattern used in the sibling step-transition code block.

### 4.3 Gate Payload Shape and Build Linkage

`GateAlert` filters pending gates to show only those relevant to the active build. This requires a stable linkage field on each gate object.

**Gate object shape** (as stored in `useVisionStore.gates[]` and broadcast via `gateCreated` WS events, defined by STRAT-COMP-6):

```json
{
  "id": "7f9d436c-2968-40a1-863e-6d76987f9ca0:design_gate:1",
  "itemId": "vision-item-uuid",
  "flowId": "7f9d436c-2968-40a1-863e-6d76987f9ca0",
  "stepId": "design_gate",
  "fromPhase": "explore_design",
  "toPhase": "prd",
  "summary": "Design review complete, ready for PRD",
  "artifact": "compose/docs/features/STRAT-COMP-8/design.md",
  "status": "pending",
  "createdAt": "2026-03-12T04:48:12.000Z"
}
```

The `artifact` field is used by `GateAlert` to render the artifact link (opens in canvas via `POST /api/canvas/open`). If `artifact` is null or absent, the artifact link is not rendered.

**Gate ID format:** Per STRAT-COMP-6, gate IDs are deterministic composite keys in the format `flowId:stepId:round` (e.g., `7f9d436c-...:design_gate:1`). The colon characters require `encodeURIComponent(gateId)` when constructing REST paths. The existing `resolveGate` in `useVisionStore.js:223` constructs the path as `` `/api/vision/gates/${gateId}/resolve` `` — this must be updated to use `encodeURIComponent(gateId)` to handle colons. This is a prerequisite fix (may be done by STRAT-COMP-6; if not, STRAT-COMP-8 must add it).

**Build linkage:** `gate.flowId` matches `activeBuild.flowId`. When `activeBuild` is non-null, `GateAlert` filters: `gates.filter(g => g.status === 'pending' && g.flowId === activeBuild.flowId)`. When `activeBuild` is null (idle), all pending gates are shown regardless of `flowId`. This ensures gates are always visible even if the build that created them has ended.

### 4.4 Phase Name Mapping

The dashboard uses `stepLabel(stepId)` from `build-utils.js` to map step IDs to human names. This utility combines two sources:

**Source 1: `LIFECYCLE_PHASE_LABELS` from `constants.js`** — covers core lifecycle phases only:

| Step ID | Human Label |
|---|---|
| `explore_design` | Design |
| `prd` | PRD |
| `architecture` | Architecture |
| `blueprint` | Blueprint |
| `verification` | Verification |
| `plan` | Plan |
| `execute` | Execute |
| `report` | Report |
| `docs` | Docs |
| `ship` | Ship |

**Source 2: `STEP_LABELS` in `build-utils.js`** — dashboard-specific labels for step IDs not in `LIFECYCLE_PHASE_LABELS`:

| Step ID | Human Label |
|---|---|
| `design_review` | Design Review |
| `prd_review` | PRD Review |
| `architecture_review` | Architecture Review |
| `blueprint_review` | Blueprint Review |
| `plan_review` | Plan Review |
| `report_review` | Report Review |
| `review` | Code Review |
| `coverage` | Test Coverage |

**Resolution chain in `stepLabel(stepId)`:**

1. `LIFECYCLE_PHASE_LABELS[stepId]` — exact match for lifecycle phases
2. `STEP_LABELS[stepId]` — dashboard-specific labels for review/coverage steps
3. `GATE_STEP_TO_PHASE[stepId]` — returns a phase key (e.g., `design_gate` -> `explore_design`), then `LIFECYCLE_PHASE_LABELS[phaseKey] + " Gate"` (e.g., `LIFECYCLE_PHASE_LABELS['explore_design']` = "Design", result = "Design Gate")
4. `LIFECYCLE_PHASE_LABELS[stepId.replace(/_gate$/, '')]` + " Gate" — suffix strip for regular gates (e.g., `prd_gate` -> strip to `prd` -> `LIFECYCLE_PHASE_LABELS['prd']` = "PRD" -> "PRD Gate")
5. `stepId` — raw fallback (should never be reached for known pipeline steps)

Gate steps (e.g., `design_gate`, `prd_gate`) do not have entries in `LIFECYCLE_PHASE_LABELS`. The `GATE_STEP_TO_PHASE` lookup table in `build-utils.js` handles the irregular `design_gate` -> `explore_design` case. All components that display step labels use `stepLabel()` — never `LIFECYCLE_PHASE_LABELS` directly.

---

## 5. Migration Plan

### Step 1: Build the new components (additive)

Create the following new files (in `src/components/build/` per blueprint AD-1):
- `src/components/build/BuildDashboard.jsx` — root component
- `src/components/build/BuildStatusCard.jsx` — active build card
- `src/components/build/StepTimeline.jsx` — step stepper
- `src/components/build/GateAlert.jsx` — promoted pending gates
- `src/components/build/AuditTrail.jsx` — post-build detail
- `src/components/build/build-utils.js` — shared utility functions

These are new files. `StratumPanel.jsx` continues to work unchanged. The app remains functional throughout this step.

### Step 2: Wire in behind feature flag

In the parent layout that currently renders `<StratumPanel />`, add a conditional:

```jsx
const useBuildDashboard = true; // flip to false to revert

{useBuildDashboard ? <BuildDashboard /> : <StratumPanel />}
```

This allows quick revert if the new dashboard has issues. The flag is a simple constant, not a runtime feature flag system.

### Step 3: Remove old

Once the dashboard is validated:
- Delete `src/components/StratumPanel.jsx`
- Remove the conditional, render `<BuildDashboard />` directly
- Remove unused `GET /api/stratum/flows` and `GET /api/stratum/gates` polling infrastructure if no other consumer exists

---

## 6. Files Changed

| File | Status | Change |
|---|---|---|
| `src/components/build/BuildDashboard.jsx` | new | Root dashboard component, replaces `StratumPanel` (per blueprint AD-1) |
| `src/components/build/BuildStatusCard.jsx` | new | Active build overview card |
| `src/components/build/StepTimeline.jsx` | new | Compact vertical step stepper |
| `src/components/build/GateAlert.jsx` | new | Promoted pending gates at top of dashboard |
| `src/components/build/AuditTrail.jsx` | new | Expandable post-build step detail |
| `src/components/build/build-utils.js` | new | Shared utility functions (`stepLabel`, `formatElapsed`, etc.) |
| `lib/build.js` | existing | Extend `writeActiveBuild` and `updateActiveBuildStep` with `stepNum`, `totalSteps`, `retries`, `violations`, `steps[]` |
| `src/components/vision/useVisionStore.js` | existing | Add `activeBuild` state (may already exist from STRAT-COMP-5) |
| `src/components/vision/visionMessageHandler.js` | existing | Handle `buildState` → `setActiveBuild` (may already exist from STRAT-COMP-5) |
| `src/App.jsx` (or parent layout) | existing | Swap `<StratumPanel />` for `<BuildDashboard />` with feature flag |
| `src/components/StratumPanel.jsx` | existing (delete) | Removed after dashboard is validated |

---

## 7. Theme Integration

The dashboard uses design system tokens exclusively. No hex color literals.

### Token Usage

| Element | Light mode resolves to | Dark mode resolves to | Token |
|---|---|---|---|
| Card background | white | `hsl(240 10% 6%)` | `bg-card` |
| Card border | `hsl(0 0% 89.8%)` | `hsl(240 4% 16%)` | `border-border` |
| Primary text | near-black | near-white | `text-foreground` |
| Secondary text | gray | blue-gray | `text-muted-foreground` |
| Progress bar fill | dark | indigo | `bg-primary` |
| Progress bar track | light gray | dark gray | `bg-muted` |
| Success (completed) | green | green | `text-success` |
| Warning (retries) | amber | amber | `text-warning` or `text-amber-400` |
| Error (violations/killed) | red | red | `text-destructive` |
| Gate alert border | amber | amber | `border-l-amber-400` (TODO: define `border-warning` CSS variable in a future design system pass) |
| Active step indicator | primary | indigo | `text-primary` |

### Accepted Exceptions

The following inline styles and non-token classes are explicitly permitted:

1. **Progress bar width:** `style={{ width: \`${percentage}%\` }}` — required for dynamic percentage widths. This is the standard Tailwind pattern for progress bars; the value is computed, not a static color.
2. **Amber palette classes:** `border-l-amber-400`, `text-amber-400`, `border-amber-400/30`, `hover:bg-amber-400/10` — Tailwind's amber scale is used for warning/gate states. These are not hex literals; they are Tailwind utility classes that respond to the design system's color mode. A future design system pass may replace these with a `--warning` CSS variable (noted as TODO in the token table above).
3. **Destructive palette classes:** `text-destructive`, `border-destructive/30` — these reference the existing `--destructive` CSS variable from the design system.

### Forbidden Patterns

- No `style={{ ... }}` with hex values (dynamic percentage widths are the sole exception — see above)
- No `var(--compose-raised, #fallback)` inline fallbacks — if a token is missing, add it to `index.css`
- No `opacity: 0.4` for dimming — use `text-muted-foreground` or Tailwind opacity utilities (`text-foreground/50`)
- All spacing via Tailwind utilities (`p-3`, `gap-2`, `mt-4`), not pixel values in style attributes

### shadcn Component Usage

| Component | Import | Usage |
|---|---|---|
| `Card`, `CardHeader`, `CardContent` | `@/components/ui/card.jsx` | `BuildStatusCard` wrapper |
| `Badge` | `@/components/ui/badge.jsx` | Status badges, retry/violation counts |
| `Button` | `@/components/ui/button.jsx` | Gate action buttons |
| `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent` | `@/components/ui/collapsible.jsx` | `AuditTrail` expand/collapse |
| `cn()` | `@/lib/utils.js` | Conditional class merging |

---

## 8. Acceptance Criteria

### Build status
- [ ] `BuildStatusCard` renders when `activeBuild` is non-null
- [ ] Feature name displays `featureCode` directly (always a bare code after STRAT-COMP-4 normalization, no prefix stripping needed)
- [ ] Current phase displays via `stepLabel()` utility (Section 4.4), not raw step ID. Handles both regular steps and gate steps (e.g., `design_gate` -> "Design Gate")
- [ ] Step progress shows "Step N of M" text and a visual progress bar
- [ ] Elapsed time updates live (1-second interval) from `activeBuild.startedAt`
- [ ] Retry count renders as `Badge` when > 0
- [ ] Violation count renders as `Badge` when > 0
- [ ] Idle state ("No active build") renders when `activeBuild` is null
- [ ] When `activeBuild` is `undefined` (STRAT-COMP-5 not yet implemented), renders a dev-mode warning string in non-production; in production, treats `undefined` same as `null` (idle state)

### Step timeline
- [ ] Steps render as vertical stepper with left-side indicators and connecting line
- [ ] Completed steps show green checkmark, phase label, collapsed to single line
- [ ] Current step shows spinner/pulse, phase label, agent name (from `step.agent`; omitted for gate steps where `agent` is null), expanded with status (per STRAT-COMP-4: `label + agent name + status` — gate steps show `label + status` only since they have no executing agent)
- [ ] Current step shows retry count and violation count as numeric badges when > 0 (per STRAT-COMP-4)
- [ ] Upcoming steps show dimmed circle outline, phase label
- [ ] Gate steps show gate indicator badge
- [ ] When `completedSteps.length + skippedSteps.length > 6` (7+ past steps triggers collapse), collapse into summary with expand toggle. At exactly 6 past steps, no collapse
- [ ] Test: exactly 6 completed+skipped steps — assert no collapse occurs

### Gate alerts
- [ ] Pending gates render at top of dashboard, above build status
- [ ] Each gate shows feature name (Vision item title, fallback "Unknown"), phase transition, summary, and artifact link (when `artifact` is present)
- [ ] Approve button calls `onResolve(gate.id, 'approve')` directly (no comment required)
- [ ] Revise button toggles inline input with "Feedback (optional)..." placeholder; Enter key or Submit button calls `onResolve(gate.id, 'revise', comment)`
- [ ] Kill button toggles inline input with "Kill reason (required)..." placeholder; "Confirm Kill" button is disabled when input is empty; Enter key or Confirm Kill button calls `onResolve(gate.id, 'kill', comment)`
- [ ] Resolving a gate updates both `GateAlert` and `GateView` via `gateResolved` WS event
- [ ] Gate action buttons have `>= 48px` tap targets per STRAT-COMP-4 requirement
- [ ] No "empty state" placeholder when no gates are pending

### Audit trail
- [ ] Renders after build ends — all terminal statuses trigger the audit trail: `status: 'complete'`, `status: 'failed'`, `status: 'aborted'`
- [ ] Terminal snapshot captured into `lastCompletedBuild.current` when `activeBuild.status` transitions from `running` to a terminal value
- [ ] Collapsible, expanded by default (showing the completed build's audit trail immediately is more useful than hiding it — the user just finished a build and wants to see what happened)
- [ ] Shows per-step: phase label, duration, retry count, violation count, outcome, and expandable intent text (from `step.intent`)
- [ ] Per-step outcome values: `complete` for regular steps, `skipped` for skipped steps, `failed` for failed steps, `approve`/`revise`/`kill` for gate steps (canonical imperative enum)
- [ ] Auto-collapses after 60 seconds; timer cleaned up on unmount via `clearTimeout(auditCollapseTimer.current)`

### Data requirements
- [ ] `lib/build.js` `writeActiveBuild` writes `pipeline` (string, workflow name), `status` (string), `stepNum`, `totalSteps`, `retries` (number), `violations` (number — count of violations; STRAT-COMP-4 also defines `violations` as `string[]` in the WS message — this design uses numeric `violations` + separate `violationMessages: string[]` to satisfy both: the count for badges, the messages for tooltips), `violationMessages` (string[]), `steps[]`
- [ ] `lib/build.js` `updateActiveBuildStep` marks previous step complete, adds new step, increments `stepNum`
- [ ] Step retries and violations tracked per-step in `steps[]` entries

### Terminal state requirements
- [ ] On build completion, `lib/build.js` writes a final `active-build.json` with `status` set to `complete`/`failed`/`aborted` and `completedAt` timestamp
- [ ] Final write marks the last step with its terminal status and `completedAt`
- [ ] File remains on disk (NOT deleted or set to null — per STRAT-COMP-4); overwritten on next build start
- [ ] `buildState` WS event carries the terminal snapshot
- [ ] `BuildDashboard` `useEffect` captures the terminal snapshot into `lastCompletedBuild.current` when `status` transitions from `running` to terminal
- [ ] `AuditTrail` renders from the terminal snapshot (not a stale intermediate state)

### Data model acceptance criteria
- [ ] `allStepIds` array written at build start with all pipeline step IDs in order
- [ ] `totalSteps` equals `allStepIds.length`
- [ ] Each `steps[]` entry includes: `id`, `status`, `startedAt`, `completedAt`, `retries`, `violations`, `violationMessages`, `mode`, `agent`, `intent`
- [ ] `steps[].agent` set from pipeline spec's `agent` field (null for gate/skipped steps)
- [ ] `steps[].intent` set from pipeline spec's `intent` field (null for gate steps)
- [ ] `steps[].mode` is `'gate'` when `stepId.endsWith('_gate')`, else `'step'`
- [ ] `awaiting_gate` status written when gate step creates a gate and waits for resolution
- [ ] Skipped steps added to `steps[]` with `status: 'skipped'`, null timestamps
- [ ] When `activeBuild` is null (no build has run yet), all pending gates shown regardless of `flowId`

### Theme and design system
- [ ] Zero hex color literals in all new components
- [ ] Zero inline `style` attributes except the progress bar dynamic width (see Section 7 Accepted Exceptions)
- [ ] All colors via design system tokens or Tailwind utility classes (see Section 7 Token Usage and Accepted Exceptions)
- [ ] Renders correctly in both light and dark mode
- [ ] Uses shadcn components: `Card`, `Badge`, `Button`, `Collapsible`

### Migration
- [ ] Feature flag allows switching between `StratumPanel` and `BuildDashboard`
- [ ] `StratumPanel.jsx` deleted only after dashboard is validated
- [ ] No polling of `GET /api/stratum/flows` or `GET /api/stratum/gates` in new dashboard

### Live updates
- [ ] Field names in `active-build.json` and the `buildState` WS message are identical (no renaming between file and wire — per STRAT-COMP-4 canonical contract)
- [ ] Dashboard receives `buildState` events via WebSocket (STRAT-COMP-5)
- [ ] Dashboard hydrates from `GET /api/build/state` on mount and on WebSocket reconnect
- [ ] If `GET /api/build/state` fails, dashboard remains in idle state (no crash)
- [ ] Gate state arrives via existing `gateCreated` / `gateResolved` WS events (STRAT-COMP-6 canonical event names)
- [ ] Gate IDs use composite format `flowId:stepId:round` with `encodeURIComponent` for REST paths
- [ ] No `setInterval` polling in any new component

---

## 9. Open Questions

1. **Should `StepTimeline` show estimated remaining time?** This would require historical build data (average step durations). Not in scope for v1 but the `steps[]` data model supports it in the future.

2. **Should the dashboard show multiple concurrent builds?** The current `active-build.json` model is single-build. If `compose build` is called for two features simultaneously, the second write overwrites the first. This is an `active-build.json` limitation, not a dashboard limitation. Out of scope.

3. **Should `AuditTrail` persist across page reloads?** Currently it relies on a React ref that dies on reload. A persisted build history would require server-side storage. Out of scope for v1.
