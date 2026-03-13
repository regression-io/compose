# Implementation Plan: Active Build Dashboard (STRAT-COMP-8)

**Status:** Plan
**Date:** 2026-03-13
**Blueprint:** `compose/docs/features/STRAT-COMP-8/blueprint.md`
**Design:** `compose/docs/features/STRAT-COMP-8/design.md`

---

## Prerequisites

STRAT-COMP-5 must be implemented before Tasks 8-14 can execute. Task 7 is the prerequisite verification gate itself. Tasks 1-6 (new component files) can compile without STRAT-COMP-5 runtime state, but their runtime acceptance criteria (hydration, WS events, store shape) cannot be fully satisfied until `activeBuild`, `buildState` WS handler, and `GET /api/build/state` exist.

Authoritative upstream contracts for this plan:

- STRAT-COMP-4 / STRAT-COMP-5 own `active-build.json` and `buildState`: flat payload only, `violations: string[]`, `GET /api/build/state` returns `{ state: <object> | null }`
- STRAT-COMP-7 owns `.compose/build-stream.jsonl` and all per-step/audit event schema
- Shared step/gate labels come from `lib/constants.js` via `STEP_LABELS` (created by STRAT-COMP-6 Task 16 — must exist before Task 1)

**Missing STRAT-COMP-5 items (verified 2026-03-13):**
- `useVisionStore.js` has no `activeBuild` state (0 matches)
- `visionMessageHandler.js` has no `buildState` handler (canonical event name per STRAT-COMP-4; STRAT-COMP-5 blueprint/plan may still reference the earlier name `buildStateChanged`)
- No `GET /api/build/state` endpoint exists
- `startFresh()` at `lib/build.js:490` writes only 5 fields (no `pipeline`, `status`, `stepNum`, `totalSteps`, `retries`, `violations`)
- `updateActiveBuildStep()` at `lib/build.js:501` only updates `currentStepId`

---

## Task 1: Create `build-utils.js` utility module

**Files:** `src/components/build/build-utils.js` (new)
**Depends on:** --
**Acceptance criteria:**
- [ ] Exports `stepLabel(stepId)` with this resolution chain:
  1. Shared `STEP_LABELS[stepId]` from `lib/constants.js`
  2. Title-case fallback from `stepId` (replace underscores, capitalize words)
- [ ] `stepLabel` does not define a feature-local `STEP_LABELS` or gate-label map
- [ ] Imports shared `STEP_LABELS` from `../../../lib/constants.js`
- [ ] Exports `formatElapsed(startIso)` returning "2m 34s", "1h 12m" format
- [ ] Exports `formatDuration(startIso, endIso)` for completed step durations
- [ ] Exports `formatMs(ms)` as the underlying formatter
- [ ] Exports `formatTotalDuration(build)` using last step's `completedAt` or falling back to elapsed
- [ ] No `displayFeatureName` utility (featureCode is always bare after STRAT-COMP-4)

## Task 2: Create `BuildStatusCard` component

**Files:** `src/components/build/BuildStatusCard.jsx` (new)
**Depends on:** Task 1
**Acceptance criteria:**
- [ ] When `build` is `undefined` (STRAT-COMP-5 not yet implemented): in non-production (`process.env.NODE_ENV !== 'production'`), renders a dev-mode warning string. In production, falls through to idle state
- [ ] Renders idle state ("No active build") when `build` is `null` or `build.status !== 'running'`, centered, `text-sm text-muted-foreground`
- [ ] Uses `Card`, `CardHeader`, `CardContent` from `@/components/ui/card.jsx`
- [ ] Displays `build.featureCode` directly (no prefix stripping)
- [ ] Displays current phase via `stepLabel(build.currentStepId)` (not `LIFECYCLE_PHASE_LABELS` directly)
- [ ] Shows "Step N of M" text with progress bar (`bg-primary` fill, `bg-muted` track, `h-1.5` rounded)
- [ ] Progress bar width uses inline `style={{ width }}` (accepted exception for dynamic percentage)
- [ ] Elapsed time updates every second via `useEffect` + `setInterval`, cleaned up on unmount/idle
- [ ] Retry badge (`Badge variant="outline"`, amber) when `build.retries > 0`, singular/plural text
- [ ] Violation badge (`Badge variant="outline"`, destructive) when `build.violations.length > 0`, with `title` tooltip listing violation strings (`violations` is `string[]` per STRAT-COMP-4/5 contract)
- [ ] Zero hex color literals, zero additional inline styles
- [ ] Renders correctly in both light and dark mode

## Task 3: Create `StepTimeline` component

**Files:** `src/components/build/StepTimeline.jsx` (new)
**Depends on:** Task 1
**Acceptance criteria:**
- [ ] Props: `steps` (array), `currentStepId` (string), `allStepIds` (array of all pipeline step IDs derived from build-stream / pipeline metadata, not from `activeBuild`)
- [ ] Classifies steps: completed (`status === 'complete'`), skipped (`status === 'skipped'`), current (`id === currentStepId`), upcoming (in `allStepIds` but not yet in `steps`)
- [ ] Completed steps: green checkmark, phase label via `stepLabel`, collapsed to single line with duration
- [ ] Skipped steps: dash/skip icon, phase label via `stepLabel`, `text-muted-foreground/40`
- [ ] Current step: pulsing dot (`animate-pulse`, `bg-primary`), phase label `font-medium`, agent name (from `step.agent`; omitted when null for gate steps), status text (`running` -> "Running", `awaiting_gate` -> "Awaiting gate"), elapsed time
- [ ] Current step: retry count and violation count badges when > 0 (per STRAT-COMP-4)
- [ ] Upcoming steps: dimmed circle outline (`border-muted-foreground/30`), phase label via `stepLabel`, `text-muted-foreground/50`
- [ ] Connecting line between indicators: `w-px bg-border` on left side
- [ ] Gate steps show `Badge variant="outline"` with "Gate" label
- [ ] Collapse triggers when `completedSteps.length + skippedSteps.length > 6` (7+ past steps): shows last 2 past + "N steps completed" summary with expand toggle
- [ ] At exactly 6 completed+skipped steps: no collapse occurs
- [ ] `expanded` state via `useState(false)`, toggle on summary click
- [ ] Uses `cn()` from `@/lib/utils.js` for conditional classes
- [ ] Zero hex color literals, all styling via Tailwind
- [ ] Renders correctly in both light and dark mode

## Task 4: Create `GateAlert` component

**Files:** `src/components/build/GateAlert.jsx` (new)
**Depends on:** --
**Acceptance criteria:**
- [ ] Props: `gates` (array), `items` (array), `onResolve` (function)
- [ ] Returns `null` when `gates.length === 0` (no empty state placeholder)
- [ ] Each gate renders with amber left border (`border-l-2 border-l-amber-400`), `bg-card` background
- [ ] Feature name from `items.find(i => i.id === gate.itemId)?.title`, fallback "Unknown"
- [ ] Phase transition displayed via `stepLabel` for `gate.fromPhase` and `gate.toPhase`
- [ ] Gate summary text displayed when present
- [ ] Artifact link displayed when `gate.artifact` is present (opens in canvas via `POST /api/canvas/open`)
- [ ] Approve/Revise/Kill button trio using `Button variant="outline"` with `>= 48px` tap targets (per STRAT-COMP-4)
- [ ] Approve calls `onResolve(gate.id, 'approve')` (canonical imperative enum per STRAT-COMP-4/6)
- [ ] Revise expands inline input with "Feedback (optional)..." placeholder; calls `onResolve(gate.id, 'revise', comment)`
- [ ] Kill expands inline input with "Kill reason (required)..." placeholder; "Confirm Kill" button disabled when empty; calls `onResolve(gate.id, 'kill', comment)`
- [ ] Enter key submits in inline input
- [ ] Internal state: `expandedGateId`, `expandedAction`, `comment`
- [ ] Gate IDs are composite keys (`flowId:stepId:round`); `encodeURIComponent` used if constructing URL paths
- [ ] New pending gates appear via `gateCreated` WS event; resolving a gate via `GateAlert` updates both `GateAlert` and the sidebar `GateView` through the shared `gateResolved` WebSocket event (both consume `gates` from `useVisionStore`)
- [ ] Zero hex color literals, zero additional inline styles, all styling via Tailwind tokens
- [ ] Renders correctly in both light and dark mode

## Task 5: Create `AuditTrail` component

**Files:** `src/components/build/AuditTrail.jsx` (new)
**Depends on:** Task 1
**Acceptance criteria:**
- [ ] Props: `build` (completed/failed/aborted build object), `onCollapse` (callback)
- [ ] Uses `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent` from `@/components/ui/collapsible.jsx`
- [ ] Header shows "Build Audit" with step count and total duration via `formatTotalDuration(build)`
- [ ] `defaultOpen={true}` (expanded by default)
- [ ] Per-step row: phase label via `stepLabel`, duration via `formatDuration`, retry count badge (if > 0), violation count badge (if `violations.length > 0`), outcome badge, expandable intent text (from `step.intent`)
- [ ] Renders for all terminal statuses: `complete`, `failed`, `aborted`, `killed`, `crashed` (STRAT-COMP-7 build-stream emits `killed` for SIGINT/SIGTERM and synthetic `crashed` for unresponsive builds)
- [ ] Per-step outcome values: `complete` for regular steps, `skipped` for skipped steps, `failed` for failed steps, `approve`/`revise`/`kill` for gate steps
- [ ] Retry badge: amber, `{N}r` format
- [ ] Violation badge: destructive, `{N}v` format, details sourced from `step.violations`
- [ ] Uses `Badge variant="outline"` for all badges
- [ ] Zero hex color literals, zero additional inline styles, all styling via Tailwind tokens
- [ ] Renders correctly in both light and dark mode

## Task 6: Create `BuildDashboard` container

**Files:** `src/components/build/BuildDashboard.jsx` (new)
**Depends on:** Tasks 2, 3, 4, 5
**Acceptance criteria:**
- [ ] Imports and renders `GateAlert`, `BuildStatusCard`, `StepTimeline`, `AuditTrail`
- [ ] Consumes `useVisionStore`: `activeBuild`, `setActiveBuild`, `gates`, `items`, `resolveGate`, `connected`
- [ ] Consumes per-step build history from STRAT-COMP-7's SSE-mapped events (received via the agent-stream SSE endpoint as `{ type: "system", subtype: "build_step" | "build_step_done" | "build_gate" | ... }` — see STRAT-COMP-7 Task 8 event mapping). `activeBuild` remains the flat STRAT-COMP-5 snapshot only
- [ ] Derives `pendingGates` from `gates.filter(g => g.status === 'pending')`; further filtered by `activeBuild.flowId` when `activeBuild` is non-null (including terminal states, since the build snapshot persists on disk); all pending gates shown when `activeBuild` is null
- [ ] `lastCompletedBuild` ref (`useRef(null)`): set when `activeBuild.status` transitions from `running` to a terminal value (`complete`/`failed`/`aborted`/`killed`/`crashed`)
- [ ] `auditVisible` state: set `true` on build completion (status transitions to terminal). After 60 seconds, auto-collapse the `AuditTrail` (set its `Collapsible` to closed) — the trail remains rendered but collapsed, not hidden. The `onCollapse` prop is called by the auto-collapse timer to update parent state if needed
- [ ] `auditCollapseTimer` ref: stores the setTimeout ID, cleaned up via `return () => clearTimeout(...)` in useEffect
- [ ] New build starting (status changes to `running`) clears `lastCompletedBuild` and `auditVisible`
- [ ] Root div: `flex flex-col h-full overflow-y-auto p-3 gap-3`
- [ ] Render order: GateAlert (top), BuildStatusCard, StepTimeline (when `activeBuild?.status === 'running'`), AuditTrail (when build completed)
- [ ] Hydrates from `GET /api/build/state` on mount (initial `useEffect`) and on WebSocket reconnect (triggered by `connected` transitioning from `false` to `true`). Hydration calls `fetch('/api/build/state')` and on success calls `setActiveBuild(data.state ?? null)` to unwrap the response (STRAT-COMP-5 wraps as `{ state: <object> | null }`)
- [ ] `GET /api/build/state` response contract (defined by STRAT-COMP-5): returns `200` with `{ state: <parsed object> }` when file exists, `{ state: null }` when no build has run. Terminal snapshots (`status: 'complete'`/`'failed'`/`'aborted'`) are included since the file persists on disk after build ends. Returns `500` on server error
- [ ] If `GET /api/build/state` fails (network error, 500, etc.), remains in idle state (no crash, no retry loop)
- [ ] Accumulates per-step state from STRAT-COMP-7 SSE events into component-local `buildSteps` array (via `useRef` or `useState`): each `build_step` event pushes a new step entry, `build_step_done` marks it complete, `build_gate`/`build_gate_resolved` update gate status. Passes this derived array to `StepTimeline` and `AuditTrail`. Does not expect `allStepIds` or `steps[]` inside `activeBuild`
- [ ] Zero hex color literals, zero additional inline styles (except progress bar dynamic width), all styling via Tailwind tokens
- [ ] Renders correctly in both light and dark mode

## Task 7: Verify STRAT-COMP-5 prerequisites

**Files:** `src/components/vision/useVisionStore.js` (existing), `src/components/vision/visionMessageHandler.js` (existing)
**Depends on:** --
**Acceptance criteria:**
- [ ] `useVisionStore.js` exports `activeBuild` state and `setActiveBuild` setter
- [ ] `visionMessageHandler.js` handles `buildState` message type (canonical per STRAT-COMP-4), calling `setActiveBuild`
- [ ] `GET /api/build/state` endpoint returns `{ state: <flat active-build object> | null }`
- [ ] Upstream contract confirmed: `activeBuild` remains flat and does NOT grow `allStepIds`, `steps[]`, numeric `violations`, or `violationMessages`
- [ ] **GATE: If any of the above are missing, STOP. STRAT-COMP-5 must be implemented first. Tasks 8-14 cannot proceed.**

## Task 8: Respect the upstream flat `activeBuild` contract

**Files:** `src/components/build/BuildDashboard.jsx` (new), `src/components/build/BuildStatusCard.jsx` (new), `src/components/build/AuditTrail.jsx` (new)
**Depends on:** Task 7
**Acceptance criteria:**
- [ ] Dashboard code assumes only the STRAT-COMP-5 flat fields on `activeBuild`: `featureCode`, `flowId`, `pipeline`, `currentStepId`, `specPath`, `stepNum`, `totalSteps`, `retries`, `violations: string[]`, `status`, `startedAt`, `completedAt?`
- [ ] No STRAT-COMP-8 task requires `allStepIds`, `steps[]`, numeric `violations`, or `violationMessages` to be written into `active-build.json`
- [ ] Badge counts and summary copy derive violation counts from `activeBuild.violations.length`
- [ ] Field names in `active-build.json` match the `buildState` WS payload exactly (no renaming per STRAT-COMP-4)

## Task 9: Build timeline and audit state from STRAT-COMP-7 build-stream events

**Files:** `src/components/build/BuildDashboard.jsx` (new), `src/components/build/StepTimeline.jsx` (new), `src/components/build/AuditTrail.jsx` (new)
**Depends on:** Task 8
**Acceptance criteria:**
- [ ] Introduces a dashboard-local adapter/store that consumes STRAT-COMP-7 SSE-mapped events (subtypes: `build_step`, `build_step_done`, `build_gate`, `build_gate_resolved`, `build_end` — NOT raw JSONL `build_step_start`) and derives the `steps` / audit model used by `StepTimeline` and `AuditTrail`
- [ ] Per-step entries in the derived model use `violations: string[]` (never numeric counts)
- [ ] Per-step history comes from `.compose/build-stream.jsonl` / STRAT-COMP-7, not from `active-build.json`
- [ ] If upcoming-step ordering is needed, it is derived from build-stream / pipeline metadata without expanding the `activeBuild` file contract

## Task 10: Use string-array violations everywhere in dashboard state

**Files:** `src/components/build/BuildStatusCard.jsx` (new), `src/components/build/StepTimeline.jsx` (new), `src/components/build/AuditTrail.jsx` (new)
**Depends on:** Task 9
**Acceptance criteria:**
- [ ] Top-level build violation badges/counts derive from `activeBuild.violations.length`
- [ ] Per-step violation badges/counts derive from `step.violations.length`
- [ ] Tooltip/detail text uses the same `string[]` payload (`activeBuild.violations` / `step.violations`) instead of split count-plus-message fields

## Task 11: Represent gate lifecycle from shared gate/build-stream state

**Files:** `src/components/build/BuildDashboard.jsx` (new), `src/components/build/StepTimeline.jsx` (new), `src/components/build/GateAlert.jsx` (new)
**Depends on:** Task 9
**Acceptance criteria:**
- [ ] Pending gate UI continues to use STRAT-COMP-6 gate objects and canonical outcomes (`approve`, `revise`, `kill`)
- [ ] Timeline/audit gate state is derived from STRAT-COMP-7 gate events plus STRAT-COMP-5 terminal build status; no STRAT-COMP-8-specific gate fields are added to `active-build.json`
- [ ] Dashboard treats `activeBuild.status` as the authoritative aggregate build state and gate objects as the authoritative pending/resolved gate state

## Task 11b: Honor STRAT-COMP-5 terminal snapshot semantics

**Files:** `src/components/build/BuildDashboard.jsx` (new), `src/components/build/AuditTrail.jsx` (new)
**Depends on:** Task 9
**Acceptance criteria:**
- [ ] Dashboard relies on the STRAT-COMP-5 terminal snapshot (`status: 'complete' | 'failed' | 'aborted'`, `completedAt`) without requiring any STRAT-COMP-8-specific file writes
- [ ] File remains on disk (NOT deleted or set to null per STRAT-COMP-4/5)
- [ ] The `buildState` WS broadcast carries the terminal snapshot, and the dashboard captures that snapshot for `AuditTrail`
- [ ] `BuildDashboard` captures the terminal snapshot into `lastCompletedBuild.current` and `AuditTrail` renders from that captured snapshot (not a stale intermediate state)

## Task 11c: Fix `resolveGate` URL encoding for composite gate IDs

**Files:** `src/components/vision/useVisionStore.js` (existing, line 223)
**Depends on:** --
**Acceptance criteria:**
- [ ] `resolveGate` path construction changed from `` `/api/vision/gates/${gateId}/resolve` `` to `` `/api/vision/gates/${encodeURIComponent(gateId)}/resolve` ``
- [ ] Handles composite gate IDs containing colons (e.g., `flowId:stepId:round`) per STRAT-COMP-6
- [ ] If STRAT-COMP-6 already made this fix, verify and skip

## Task 12: Wire `BuildDashboard` into `App.jsx` behind feature flag

**Files:** `src/App.jsx` (existing, lines 5, 279, 295)
**Depends on:** Task 6
**Acceptance criteria:**
- [ ] Adds import: `import BuildDashboard from './components/build/BuildDashboard'`
- [ ] Adds `const USE_BUILD_DASHBOARD = true` at top of App component body
- [ ] Tab label array: `['Canvas', USE_BUILD_DASHBOARD ? 'Build' : 'Stratum']`
- [ ] Conditional render: `rightTab === 'Canvas' ? <Canvas .../> : USE_BUILD_DASHBOARD ? <BuildDashboard /> : <StratumPanel />`
- [ ] Setting `USE_BUILD_DASHBOARD = false` reverts to old StratumPanel behavior

## Task 13: Smoke test — idle state renders

**Files:** --
**Depends on:** Task 12
**Acceptance criteria:**
- [ ] App loads without errors
- [ ] Build tab is labeled "Build" (not "Stratum")
- [ ] Switching to Build tab shows "No active build" text
- [ ] No gate alert cards rendered (or all pending gates shown if any exist)
- [ ] No console errors related to `activeBuild` being undefined
- [ ] No polling requests to `GET /api/stratum/flows` or `GET /api/stratum/gates`

## Task 14: Integration test — live build updates

**Files:** --
**Depends on:** Tasks 10, 11, 11b, 12
**Acceptance criteria:**
- [ ] Run `compose build` for a test feature
- [ ] Dashboard shows `BuildStatusCard` with feature name and current phase label (human-readable, not raw ID)
- [ ] Progress bar advances on step transitions
- [ ] Elapsed time increments every second
- [ ] `StepTimeline` shows completed steps with checkmarks, skipped steps with dash when derivable from build-stream history, current step with pulse + agent name + retry/violation badges
- [ ] Upcoming steps shown with dimmed circles and phase labels
- [ ] Gate alerts appear at top when build reaches gate steps, with `>= 48px` tap targets
- [ ] Current step shows "Awaiting gate" when gate is pending
- [ ] After build completes (`status: 'complete'`), `AuditTrail` shows per-step breakdown with intent, outcome, duration
- [ ] After build fails (`status: 'failed'`), `AuditTrail` renders with last step showing `failed` status
- [ ] After build is aborted (`status: 'aborted'` via gate kill), `AuditTrail` renders with gate step showing `outcome: 'kill'`
- [ ] Gate revise: clicking Revise, entering feedback, and submitting calls `onResolve(gateId, 'revise', feedback)` and gate alert disappears
- [ ] Gate kill: clicking Kill, entering reason, and confirming calls `onResolve(gateId, 'kill', reason)` and build transitions to aborted
- [ ] Collapse boundary: with exactly 6 past steps, no collapse; with 7+ past steps, collapse triggers
- [ ] Hydration unwraps `GET /api/build/state` as `data.state ?? null`
- [ ] Field names identical between `active-build.json` and `buildState` WS message; per-step audit data comes from STRAT-COMP-7 build-stream history instead of `active-build.json`

## Task 15: Remove StratumPanel and feature flag

**Files:** `src/components/StratumPanel.jsx` (existing, delete), `src/App.jsx` (existing)
**Depends on:** Task 14
**Acceptance criteria:**
- [ ] `StratumPanel.jsx` deleted
- [ ] `StratumPanel` import removed from `App.jsx`
- [ ] `USE_BUILD_DASHBOARD` flag removed
- [ ] `<BuildDashboard />` rendered directly (no conditional)
- [ ] Tab label hardcoded to `'Build'`
- [ ] No remaining references to `StratumPanel` in codebase
- [ ] If no other consumer exists for `GET /api/stratum/flows` and `GET /api/stratum/gates` polling endpoints, remove the polling infrastructure (API routes, client-side fetch calls, and any related state). Verify by searching for all call sites before removing

---

## Dependency Graph

```
Task 1 (build-utils) ─────┬─── Task 2 (BuildStatusCard) ──┐
                           ├─── Task 3 (StepTimeline) ─────┤
Task 4 (GateAlert) ───────┤                                ├─── Task 6 (BuildDashboard) ─── Task 12 (App.jsx) ─── Task 13 (smoke)
                           └─── Task 5 (AuditTrail) ───────┘                                      │
                                                                                                   │
Task 7 (STRAT-COMP-5 gate) ─── Task 8 (flat activeBuild contract) ─── Task 9 (build-stream timeline) ──┬─── Task 10 (string[] violations) ──┐
                                                                                                          ├─── Task 11 (gate lifecycle view) ─┤
                                                                                                          └─── Task 11b (terminal snapshot) ──┴─── Task 14 (integration) ─── Task 15 (cleanup)
```

---

## Blueprint Drift Notes

The blueprint (`compose/docs/features/STRAT-COMP-8/blueprint.md`) was written before the design was updated for STRAT-COMP-4 alignment. The following blueprint sections are superseded by the design:
- Blueprint references `buildStateChanged` WS event -> design uses canonical `buildState` per STRAT-COMP-4
- Blueprint assumes `activeBuild` becomes `null` on build end -> design uses terminal `status` field (`complete`/`failed`/`aborted`); file persists on disk
- Blueprint uses past-tense gate outcomes (`approved`/`revised`/`killed`) -> design uses canonical imperative enum (`approve`/`revise`/`kill`) per STRAT-COMP-4/6
- Blueprint expands `active-build.json` with dashboard-specific step history -> this plan follows the authoritative STRAT-COMP-4/5 flat build-state contract and keeps per-step history in STRAT-COMP-7 build-stream data
- Blueprint Section 8 `App.jsx` swap pattern is still valid; component directory `src/components/build/` per AD-1 is still valid

This plan follows the **design** where blueprint and design conflict. The blueprint should be updated post-implementation.

## Risk Notes

- Tasks 1-6 and 12 can compile before STRAT-COMP-5, but runtime acceptance criteria (e.g., hydration, WS events, `activeBuild` state) cannot be verified until STRAT-COMP-5 is complete.
- Tasks 8-11b intentionally avoid expanding `active-build.json`; upstream build-state contracts remain owned by STRAT-COMP-4/5, while STRAT-COMP-7 owns per-step history.
- The progress bar `style={{ width }}` is the single accepted inline style exception (dynamic percentage width).
- Component files live in `src/components/build/` per blueprint AD-1. The design's Section 5 (Migration Plan), Section 6 (Files Changed), and Section 2 (Component Tree) all use `src/components/build/`, consistent with AD-1.
- File paths: doc paths use `compose/docs/...` (repo-root-relative). Source paths use `src/...` and `lib/...` (Compose project-root-relative, i.e., relative to the `compose/` directory). This matches the project convention where source code runs from the `compose/` directory.
