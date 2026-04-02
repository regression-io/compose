# COMP-OBS-SURFACE: Step Detail Surface

## Related Documents

- [ROADMAP.md](/ROADMAP.md) — COMP-OBS-SURFACE items 146, 148, 150
- [COMP-OBS-STREAM design](../COMP-OBS-STREAM/design.md) — sibling feature (tool result streaming)
- [LaneKeep](https://github.com/algorismo-au/lanekeep) — inspiration: tiered evaluation pipeline, append-only audit trail

## Overview

Render existing but invisible agent data in the Compose UI. Retry counts, postcondition results, and filtered SDK events already flow through build-stream events and audit traces — they just aren't displayed.

**Audience:** General awareness — single headline items visible by default, detail hidden/expandable.

## Data Flow

### Retry and violation data

`build_step_done` events carry `retries` (integer) and `violations` (string array) in the main build loop (`build.js:527-531`). However, there are gaps:

- **Successful main-flow steps** emit `retries: 0, violations: []` — even if the step retried before succeeding. The actual retry count is tracked in `active-build.json` via `updateActiveBuildStep` (`build.js:664`) but the final success emission resets to 0.
- **Child-flow completions** (`build.js:1037`) and **parallel task completions** (`build.js:1359`) omit `retries` and `violations` entirely.

**Required backend fix:** 4 emission sites in `build.js`:

1. **Line ~527** (successful main-flow step): reads `retries: 0, violations: []` hardcoded — should read from active build state (already persisted via `updateActiveBuildStep`)
2. **Line ~1038** (child-flow completion): omits both fields — add `retries: 0, violations: []` defaults
3. **Line ~1359** (parallel task completion): omits both fields — add defaults
4. **Line ~1503** (parallel_dispatch batch): omits both fields — add defaults

### Verbose events

`tool_progress` (tool name + elapsed) and `tool_use_summary` (summary text) are emitted by both `claude-sdk-connector.js` and `opencode-connector.js` — the feature is connector-agnostic. Currently filtered at `AgentStream.jsx` (line 227). The filter becomes conditional based on verbose toggle state.

### Pipeline changes

Two changes to the data pipeline:
1. `build.js`: fix 3-4 `build_step_done` emission sites to carry actual retry/violation data
2. `AgentStream.jsx`: replace hard filter with conditional based on verbose toggle

## Components

### StepOutcome.jsx (new)

Renders the headline for `build_step_done` messages. Two render modes:

**Stream mode** (used by MessageCard):
- Replaces the current one-line "step complete -- {stepId}" with a headline row
- Step complete text + retry badge + checks label
- Retry badge: amber pill ("retry 2/3"), only renders when `retries > 0`
- Checks label: muted "checks passed" on clean pass, amber "N violations" on failure
- Click checks label or retry badge to expand ViolationDetail

**Strip mode** (used by OpsStripEntry):
- Retry count as small amber pill next to step name
- No expand — click sets the selected feature/step in the store, which AgentBar auto-scrolls to via existing message list

### ViolationDetail.jsx (new)

Expandable violation list. Collapsed by default. Renders violation strings as a left-bordered amber list. Only renders when violations array is non-empty. Used by StepOutcome in stream mode.

**Visual treatment:**
- Container: `hsl(38 90% 50% / 0.06)` background, 2px left border `hsl(38 90% 50% / 0.3)`
- Header: clickable, shows "violations (N)" with expand/collapse chevron
- Items: each violation string as a list item, `10px` font, muted amber

### VerboseToggle.jsx (new)

`{ }` icon button in AgentBar header, next to existing collapse/expand controls.

- Toggles `verboseStream` boolean in Zustand store (`useVisionStore`)
- Persisted to localStorage under its own key `compose:verboseStream` (cannot share `compose:agentBarState` which stores a single string)
- Off: muted icon, matches other header controls
- On: highlighted background `hsl(210 60% 60% / 0.15)`, blue text

### AgentStream.jsx (modified)

The hard filter at line 227 becomes conditional:
- `verboseStream === false` (default): filter `tool_progress`, `tool_use_summary`, `stream_event` as today
- `verboseStream === true`: append these events but tag with `verbose: true`

MessageCard renders verbose-tagged messages with dimmed styling:
- Opacity 0.6, smaller font (10px), left border `1px solid hsl(215 20% 20%)`
- Type pill showing "progress" or "summary" in muted blue

**Note:** When COMP-OBS-STREAM ships, `tool_use_summary` events will be consumed by AgentStream's pre-grouping step and rendered attached to their `tool_use` blocks (not as standalone dimmed messages). Only `tool_progress` events will render as standalone dimmed messages. The verbose toggle still gates both event types.

## Rendering Rules

### Postcondition display (subtle on pass, prominent on fail)

The total check count ("N checks") is not currently in the event data — only violations (failures) are. Rather than extending the backend, derive the display from what's available:

| Condition | Headline | Expandable |
|---|---|---|
| Clean pass, no retries (`violations.length === 0`) | Muted checkmark + "checks passed" | No |
| Clean pass after retries (`retries > 0, violations.length === 0`) | Amber retry badge + muted "checks passed" | No (violations were from prior attempts — step ultimately passed clean) |
| Failed (`violations.length > 0`) | Amber "N violations" | Yes (violation list) |

### Retry badge

Only renders when `retries > 0`. Shows `retry {current}/{max}` as amber pill. Max retries comes from the step's `retries` config (default 2).

### Verbose events

When toggle is on, filtered events render inline in the message stream between the tool_use messages they relate to. They appear dimmed and smaller — visually subordinate to regular messages. Toggle is session-scoped (persisted to localStorage, not to settings).

## File Inventory

| File | Status | Change |
|---|---|---|
| `src/components/agent/StepOutcome.jsx` | new | Headline renderer for build_step_done |
| `src/components/agent/ViolationDetail.jsx` | new | Expandable violation list |
| `src/components/agent/VerboseToggle.jsx` | new | Toggle icon for agent bar header |
| `src/components/AgentStream.jsx` | existing | Conditional filter based on verboseStream |
| `src/components/agent/MessageCard.jsx` | existing | Delegate build_step_done to StepOutcome |
| `src/components/cockpit/OpsStripEntry.jsx` | existing | Render StepOutcome in strip mode |
| `src/components/cockpit/AgentBar.jsx` | existing | Add VerboseToggle to header |
| `src/components/vision/useVisionStore.js` | existing | Add verboseStream state + localStorage persistence |
| `lib/build.js` | existing | Fix 4 build_step_done emissions to carry actual retry/violation data |

## Testing

### Unit tests
- `StepOutcome`: renders retry badge only when `retries > 0`
- `StepOutcome`: renders muted check label on clean pass, amber on failure
- `StepOutcome`: strip mode renders badge without expand
- `ViolationDetail`: expands/collapses on click
- `ViolationDetail`: does not render when violations is empty
- `VerboseToggle`: toggles store state
- `VerboseToggle`: persists to localStorage

### Integration tests
- `MessageCard` renders `StepOutcome` for `build_step_done` subtype
- `OpsStripEntry` renders strip-mode `StepOutcome` with retry badge
- `AgentStream` filters events when verbose off, shows when on

### Golden flow
Build with retries -> ops strip shows retry badge -> click step in stream -> violations expand -> toggle verbose on -> tool_progress events appear dimmed -> toggle off -> events disappear

## Acceptance Criteria

- [ ] Clean step completions show muted "checks passed" label
- [ ] Retried steps show amber "retry N/M" badge in message stream
- [ ] Retried steps show amber pill in ops strip
- [ ] Clicking retry badge or checks label expands violation list
- [ ] Violation list shows each violation string
- [ ] Verbose toggle icon in agent bar header
- [ ] Verbose off (default): tool_progress and tool_use_summary filtered as today
- [ ] Verbose on: filtered events render dimmed and smaller inline
- [ ] Verbose state persisted to localStorage
- [ ] build.js emissions carry actual retry/violation data from active build state
- [ ] All unit and integration tests pass
