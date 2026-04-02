# COMP-OBS-SURFACE: Implementation Blueprint

## Related Documents

- [Design](design.md)
- [COMP-OBS-STREAM blueprint](../COMP-OBS-STREAM/blueprint.md)

## Integration Points

### 1. AgentStream.jsx — verbose filter (`src/components/AgentStream.jsx`)

**Line 227-228:** Hard filter for noisy events.
```javascript
if (msg.type === 'stream_event' || msg.type === 'tool_progress' || msg.type === 'tool_use_summary') {
  return; // don't render these
}
```

**Change:** Replace with conditional based on `verboseStream` state.

```javascript
if (msg.type === 'stream_event') return; // always filter stream_event (unused)
if (!_state.verboseStream && (msg.type === 'tool_progress' || msg.type === 'tool_use_summary')) {
  return;
}
if (msg.type === 'tool_progress' || msg.type === 'tool_use_summary') {
  msg = { ...msg, verbose: true }; // tag for dimmed rendering
}
```

**State access:** `_state` is module-scoped (not Zustand). Add `_state.verboseStream = false` to the module-level `_state` object. Expose a setter that the VerboseToggle calls. Persist to localStorage under `compose:verboseStream`.

**Message rendering:** Line 231 appends to `_state.messages`. Messages with `verbose: true` render dimmed in MessageCard.

### 2. MessageCard.jsx — build_step_done rendering (`src/components/agent/MessageCard.jsx`)

**Lines 221-227:** Current `build_step_done` renderer — simple one-liner.

**Change:** Replace with `<StepOutcome>` component.

```jsx
// Before (lines 221-227):
if (msg.type === 'system' && msg.subtype === 'build_step_done') {
  return (
    <div className="text-[10px] py-0.5"
      style={{ color: 'hsl(var(--success, 142 60% 50%))', opacity: 0.7 }}>
      step complete -- {msg.stepId}
    </div>
  );
}

// After:
if (msg.type === 'system' && msg.subtype === 'build_step_done') {
  return <StepOutcome msg={msg} mode="stream" />;
}
```

**Verbose message rendering:** Add after line 175-178 (where existing type checks happen):

```jsx
if (msg.verbose) {
  return <VerboseMessage msg={msg} />;
}
```

VerboseMessage renders dimmed one-liner: type pill + content. Inline in MessageCard or extracted as small component.

### 3. OpsStripEntry.jsx — retry badge (`src/components/cockpit/OpsStripEntry.jsx`)

**Props (line 45-52):** `type`, `label`, `onClick`, `onApprove`, `onDismiss`, `animationState`.

**Change:** Add `retries` prop. Render badge after label span (line 96).

```jsx
{/* Label */}
<span>{label}</span>

{/* Retry badge (new) */}
{retries > 0 && (
  <span style={{
    background: 'hsl(38 90% 50% / 0.2)',
    color: 'hsl(38 90% 60%)',
    padding: '0 5px',
    borderRadius: '9999px',
    fontSize: '9px',
  }}>
    {retries}
  </span>
)}
```

### 4. opsStripLogic.js — pass retries to entries (`src/components/cockpit/opsStripLogic.js`)

**Line 22-27:** Active build entry derivation. `activeBuild` object from store.

**Change:** Include retries in entry.

```javascript
entries.push({
  key: `build-${activeBuild.featureCode}-${buildId}`,
  type: activeBuild.status === 'complete' ? 'done' : 'build',
  label: `${activeBuild.featureCode} · ${stepLabel}${progress}`,
  featureCode: activeBuild.featureCode,
  retries: activeBuild.retries ?? 0,  // new
});
```

**Data source:** `activeBuild` is hydrated from `.compose/data/active-build.json` via file-watcher (`server/file-watcher.js:212-236`) → WebSocket broadcast → store. The `retries` field is already written to `active-build.json` by `build.js:664`.

### 5. OpsStrip.jsx — pass retries to OpsStripEntry (`src/components/cockpit/OpsStrip.jsx`)

**Lines 158-167:** Renders `visibleEntries` → `OpsStripEntry`.

**Change:** Pass `retries` prop.

```jsx
<OpsStripEntry
  key={entry.key}
  type={entry.type}
  label={entry.label}
  retries={entry.retries}  // new
  ...
/>
```

### 6. AgentBar.jsx — VerboseToggle placement (`src/components/cockpit/AgentBar.jsx`)

**Line 124:** End of status text span. Line 126: start of parallel progress bar.

**Change:** Insert VerboseToggle between status text and parallel progress (after line 124).

```jsx
{/* Status text */}
<span ...>{statusText}</span>

{/* Verbose toggle (new) */}
<VerboseToggle />

{/* Parallel progress bar */}
{parallelProgress && ...}
```

**VerboseToggle** reads/writes `_state.verboseStream` in AgentStream module scope via exported getter/setter. Also persists to localStorage.

### 7. build.js — fix emission sites (`lib/build.js`)

**Site 1 (line ~527):** Successful main-flow step.
```javascript
// Current:
streamWriter.write({ type: 'build_step_done', stepId, summary, retries: 0, violations: [], flowId });

// Change: read from active build state
const buildState = readActiveBuild(dataDir);
const stepState = buildState?.steps?.[stepId] ?? {};
streamWriter.write({
  type: 'build_step_done', stepId, summary,
  retries: stepState.retries ?? 0,
  violations: stepState.violations ?? [],
  flowId,
});
```

`readActiveBuild` is defined at line ~112, available in scope.

**Site 2 (line ~1038):** Child-flow completion. Add `retries: 0, violations: []` defaults.

**Site 3 (line ~1359):** Parallel task completion. Add `retries: 0, violations: []` defaults.

**Site 4 (line ~1503):** Parallel dispatch batch. Add `retries: 0, violations: []` defaults.

### 8. useVisionStore.js — verboseStream state (`src/components/vision/useVisionStore.js`)

**Not needed.** The verbose toggle state lives in AgentStream's module-scoped `_state` (not Zustand), because:
- AgentStream messages are module-scoped, not in the Zustand store
- The toggle controls filtering in `processMessage`, which is module-scoped
- localStorage persistence follows the pattern in `agentBarState.js`

## New Components

### StepOutcome.jsx (new, `src/components/agent/StepOutcome.jsx`)

**Props:** `msg` (build_step_done message), `mode` ("stream" | "strip")

**Stream mode:**
- Flex row: step complete text + retry badge + checks label
- Retry badge: amber pill, only when `msg.retries > 0`, format `"retry {retries}/{max}"`
  - Max retries: not in event data. Show just the count: `"retry {retries}"` or `"{retries} retries"`
- Checks label: muted "checks passed" when `msg.violations.length === 0`, amber "{N} violations" otherwise
- On click (retry badge or checks label): toggle ViolationDetail expand

**Strip mode:**
- Just the retry count as amber pill (for OpsStripEntry)

**Pattern to follow:** MessageCard's existing build_step_done renderer (line 221-227) — same color tokens, same font sizes.

### ViolationDetail.jsx (new, `src/components/agent/ViolationDetail.jsx`)

**Props:** `violations` (string[]), `expanded` (boolean), `onToggle` (callback)

- Renders nothing when `violations.length === 0`
- Collapsed: clickable header "violations ({N})" with chevron
- Expanded: left-bordered list, each violation as a line item
- Colors: amber palette from design doc

**Pattern to follow:** Collapsible from `src/components/ui/collapsible.jsx` (Radix wrapper). Or keep it simple with local boolean state + conditional render — matches MessageCard's ToolUseBlock pattern.

### VerboseToggle.jsx (new, `src/components/agent/VerboseToggle.jsx`)

**Props:** none (reads/writes AgentStream module state directly)

- `{ }` icon button, 10px, matches AgentBar header control style
- Calls exported `setVerboseStream(bool)` on AgentStream
- Reads `getVerboseStream()` for current state
- Highlighted when on: `background: hsl(210 60% 60% / 0.15)`, blue text

**Pattern to follow:** AgentBar's existing button style (line 95-108) — `compose-btn-icon` class.

## Corrections Table

| Design assumption | Reality | Impact |
|---|---|---|
| useVisionStore for verboseStream | AgentStream uses module-scoped `_state`, not Zustand | VerboseToggle reads/writes AgentStream module state, not store. localStorage still works. |
| "N checks" in StepOutcome | Total check count not in event data | Changed to "checks passed" / "N violations" in design doc. Blueprint matches. |
| Retry max available in event | Only retry count in event, not max | Show just count: "2 retries" instead of "retry 2/3" |
| OpsStripEntry click navigates to message | No message-level navigation in OpsStrip today | Ops strip click selects feature (existing behavior). Message-level scroll deferred. |
