# COMP-OBS-STREAM: Tool Result Streaming

## Related Documents

- [ROADMAP.md](/ROADMAP.md) — COMP-OBS-STREAM items 145, 151-152
- [COMP-OBS-SURFACE design](../COMP-OBS-SURFACE/design.md) — sibling feature (verbose toggle gates this feature's visibility)
- [LaneKeep](https://github.com/algorismo-au/lanekeep) — inspiration: structured visibility into every evaluation tier

## Overview

Surface tool results in the Compose UI so users can see what tools returned, not just what was called. Extends the existing `tool_use_summary` event type with full output content. Results render as collapsible blocks attached below their corresponding `tool_use` blocks.

**Audience:** General awareness. Gated by COMP-OBS-SURFACE's verbose toggle — results only appear when verbose mode is on.

## Design Decisions

- **Enrich existing event type** (not new `tool_result` type) — `tool_use_summary` already exists in both connectors' vocabulary. Adding an `output` field avoids new plumbing through the bridge and AgentStream filter.
- **Connector-side truncation** — output truncated at 2KB at the connector, before it enters the pipeline. Bridge and UI never see large payloads.
- **Consecutive position pairing** — tool_use and tool_use_summary are paired by position in the message list, not by ID. Connectors yield them consecutively. No `tool_use_id` needed (not carried today).
- **Single toggle** — COMP-OBS-SURFACE's verbose toggle controls both tool_progress and tool_use_summary. No separate "show results" toggle.
- **Roadmap deviation** — ROADMAP.md items 145, 151-152 originally specified a new `tool_result` event type, `tool_use_id` matching, and a separate "Show tool results" global toggle. This design deviates: enriches existing `tool_use_summary` instead (less plumbing), uses positional pairing (IDs not carried), and reuses COMP-OBS-SURFACE's verbose toggle (one knob). Approved during design brainstorming. ROADMAP.md to be updated after design approval.

## Data Flow

```
Connector (claude-sdk / opencode)
  → yields { type: 'tool_use_summary', summary: '80 chars', output: '≤2KB' }
  → result-normalizer.js forwards to streamWriter (currently missing — needs fix)
  → build-stream.jsonl
  → bridge._mapEvent forwards to SSE
  → AgentStream appends if verbose toggle is on (COMP-OBS-SURFACE)
  → MessageCard pairs with preceding tool_use
  → ToolResultBlock renders collapsible output
```

### result-normalizer.js (`lib/result-normalizer.js`)

`runAndNormalize` (line 148) iterates connector events and selectively forwards to `streamWriter`. Currently forwards `tool_use` (line 218) and `assistant` (line 207) but **not** `tool_use_summary` — it only logs summaries to progress/stderr (line 237-245). Needs a streamWriter write for `tool_use_summary` events:

```
if (streamWriter && event.type === 'tool_use_summary') {
  streamWriter.write({ type: 'tool_use_summary', summary: event.summary, output: event.output });
}
```

### Claude SDK connector (`server/connectors/claude-sdk-connector.js`)

`_normalizeAll` (line 94) already forwards `tool_use_summary` events from the SDK (line 121-123), but these only carry a `summary` string — no full output. The SDK does not stream tool result content as a separate event type.

Two options to get result content:
1. **If the SDK provides result content in `tool_use_summary.result` or similar field**: extract and forward as `output`. Check SDK version for available fields.
2. **If not available from SDK**: the Claude SDK connector cannot provide `output`. This feature works fully with the opencode connector and partially with Claude SDK (summary-only, no expandable output).

The connector already handles `tool_use_summary` passthrough. Enrich it:
```
if (msg.type === 'tool_use_summary') {
  return [{ type: 'tool_use_summary', summary: msg.summary, output: (msg.result ?? msg.output ?? '').slice(0, 2048) || undefined }];
}
```

If the SDK provides no result content, `output` will be undefined and ToolResultBlock renders summary-only (no expand).

### Opencode connector (`server/connectors/opencode-connector.js`)

Already has output access (line 133). Currently yields:
```
{ type: 'tool_use_summary', summary: output.slice(0, 77) + '...' }
```

Change to:
```
{ type: 'tool_use_summary', summary: short, output: output.slice(0, 2048) }
```

### Build-stream bridge (`server/build-stream-bridge.js`)

Add `tool_use_summary` case to `_mapEvent` switch (currently missing — these events are yielded but never mapped):

```
case 'tool_use_summary':
  return {
    type: 'assistant', subtype: 'tool_use_summary',
    summary: event.summary, output: event.output,
    _source: 'build',
  };
```

### AgentStream

No changes. `tool_use_summary` is already controlled by the verbose toggle from COMP-OBS-SURFACE. When verbose is on, these events flow into the message list. When off, they're filtered.

### AgentStream pre-grouping

AgentStream groups consecutive `tool_use` → `tool_use_summary` pairs before passing to MessageCard. When building the message list for rendering:

- Scan forward from each `tool_use` message to find its following `tool_use_summary` (if any)
- Attach the summary as a `result` property on the tool_use message object (shallow copy, don't mutate store)
- For assistant messages with multiple `tool_use` content blocks: collect the N consecutive `tool_use_summary` messages that follow and attach them in order to each content block

This replaces the simpler `nextMessage` prop approach — pre-grouping handles the multi-tool case cleanly and keeps MessageCard simple.

### MessageCard rendering

MessageCard checks each `tool_use` content block for an attached `result`. If present, renders ToolResultBlock below the tool_use input block. No pairing logic in MessageCard — it just renders what AgentStream provides.

**Rendering model (reconciled with COMP-OBS-SURFACE):** When verbose mode is on, `tool_use_summary` events are consumed by the pre-grouping step and attached to their tool_use. They do NOT also render as standalone dimmed messages. `tool_progress` events (the other verbose type) still render as standalone dimmed messages since they have no tool_use to attach to. COMP-OBS-SURFACE design to be updated: verbose toggle un-filters both event types, but `tool_use_summary` is consumed by pairing (renders attached) while `tool_progress` renders standalone.

## Components

### ToolResultBlock.jsx (new)

Collapsible output block attached below a `tool_use` block.

**Props:** `summary` (string), `output` (string, may be null), `isError` (boolean)

**Summary-only** (output is null/undefined): renders summary as a non-expandable muted one-liner. No click interaction.

**Collapsed state** (output present, default): shows `summary` as a muted one-liner with expand affordance. Click to expand.

**Expanded state**: monospace pre-formatted text. First 20 lines visible. "Show all (N lines)" button if output exceeds 20 lines. Full content on second click.

**Error detection**: pattern match on output for `Error`, `error:`, `Traceback`, `FAILED`, `ENOENT`, `Cannot find`. Sets `isError` automatically. Error results get `hsl(var(--destructive))` left border instead of the default muted border.

**Visual treatment:**
- Container: `opacity: 0.7`, muted background, 1px left border
- Font: monospace, 10px, `hsl(var(--muted-foreground))`
- Error variant: left border `hsl(var(--destructive))`, slightly higher opacity

### claude-sdk-connector.js (modified)

Enrich existing `tool_use_summary` passthrough (line 121-123) to forward `output` field if the SDK provides it. Graceful fallback: if SDK yields summary-only, ToolResultBlock renders without expandable content.

### opencode-connector.js (modified)

Extend line 134-136: keep 80-char `summary`, add `output: output.slice(0, 2048)`.

### build-stream-bridge.js (modified)

Add `tool_use_summary` case to `_mapEvent` switch. Forward `summary` and `output` fields.

### MessageCard.jsx (modified)

Render `ToolResultBlock` below `tool_use` content blocks when an attached `result` is present (set by AgentStream pre-grouping). No pairing logic — just reads what's provided.

## Edge Cases

| Case | Behavior |
|---|---|
| Missing summary (tool had no output) | No ToolResultBlock renders |
| Verbose toggle off | tool_use_summary filtered by AgentStream, no nextMessage match, no ToolResultBlock |
| Multiple tool_use in one assistant message | Pair with consecutive summaries in order |
| Output exactly at 2KB boundary | Truncated at connector, no "Show all" needed |
| Output is binary/garbage | Render as-is in monospace pre. User can collapse. |
| Connector yields tool_use with no following summary | No ToolResultBlock, tool_use renders as today |
| Claude SDK yields summary without output | ToolResultBlock renders summary one-liner only, no expand |

## File Inventory

| File | Status | Change |
|---|---|---|
| `src/components/agent/ToolResultBlock.jsx` | new | Collapsible output block for tool results |
| `server/connectors/claude-sdk-connector.js` | existing | Extract tool_result content, yield enriched tool_use_summary |
| `server/connectors/opencode-connector.js` | existing | Add output field to tool_use_summary events |
| `server/build-stream-bridge.js` | existing | Add tool_use_summary case to _mapEvent |
| `src/components/agent/MessageCard.jsx` | existing | Accept nextMessage prop, pair tool_use with tool_use_summary |
| `lib/result-normalizer.js` | existing | Forward tool_use_summary events to streamWriter (currently missing) |
| `src/components/AgentStream.jsx` | existing | Pre-group tool_use → tool_use_summary pairs before rendering |

## Testing

### Unit tests
- `ToolResultBlock`: renders summary when collapsed, output when expanded
- `ToolResultBlock`: "Show all" button appears when output exceeds 20 lines
- `ToolResultBlock`: error styling activates on error patterns
- `ToolResultBlock`: renders summary-only (no expand) when output is null/undefined
- `claude-sdk-connector`: forwards `output` field from SDK if available, undefined otherwise
- `claude-sdk-connector`: output truncated at 2KB when present
- `opencode-connector`: yields `output` field alongside existing `summary`
- `opencode-connector`: output truncated at 2KB
- `build-stream-bridge._mapEvent`: forwards `tool_use_summary` events with summary and output

### Integration tests
- AgentStream pre-groups tool_use → tool_use_summary pairs
- MessageCard renders ToolResultBlock when attached result is present
- Verbose toggle off → no pairing, no ToolResultBlock
- Verbose toggle on → results appear attached to tool_use blocks

### Golden flow
Run build → toggle verbose on → tool_use blocks show attached result summaries → expand a result → see output → "Show all" on long output → toggle verbose off → results disappear

## Acceptance Criteria

- [ ] Claude SDK connector forwards output field from tool_use_summary if SDK provides it (graceful fallback to summary-only)
- [ ] Opencode connector yields output field (≤2KB) alongside summary
- [ ] Build-stream bridge forwards tool_use_summary events
- [ ] Verbose toggle on: tool results render as collapsible blocks below tool_use
- [ ] Verbose toggle off: no tool results visible (same as today)
- [ ] Collapsed state shows summary one-liner
- [ ] Expanded state shows first 20 lines with "Show all" for longer output
- [ ] Error results detected and styled with destructive color
- [ ] AgentStream pre-groups tool_use → tool_use_summary pairs correctly
- [ ] Multiple tool_use in one message pair correctly with consecutive summaries
- [ ] Missing summary gracefully handled (no ToolResultBlock)
- [ ] Summary-only (no output) renders non-expandable one-liner
- [ ] result-normalizer.js forwards tool_use_summary to streamWriter
- [ ] All unit and integration tests pass
