# COMP-OBS-STREAM: Implementation Blueprint

## Related Documents

- [Design](design.md)
- [COMP-OBS-SURFACE blueprint](../COMP-OBS-SURFACE/blueprint.md) — verbose toggle dependency

## Integration Points

### 1. opencode-connector.js — enrich tool_use_summary (`server/connectors/opencode-connector.js`)

**Lines 127-137:** tool_use handling and summary emission.

```javascript
// Current (lines 134-136):
if (output && typeof output === 'string') {
  const short = output.length > 80 ? output.slice(0, 77) + '...' : output;
  yield { type: 'tool_use_summary', summary: short };
}

// Change:
if (output && typeof output === 'string') {
  const short = output.length > 80 ? output.slice(0, 77) + '...' : output;
  yield { type: 'tool_use_summary', summary: short, output: output.slice(0, 2048) };
}
```

One-line change: add `output` field with 2KB truncation.

### 2. claude-sdk-connector.js — enrich tool_use_summary (`server/connectors/claude-sdk-connector.js`)

**Lines 121-123:** Current passthrough.

```javascript
// Current:
if (msg.type === 'tool_use_summary') {
  return [{ type: 'tool_use_summary', summary: msg.summary }];
}

// Change:
if (msg.type === 'tool_use_summary') {
  const output = (msg.result ?? msg.output ?? '');
  return [{
    type: 'tool_use_summary',
    summary: msg.summary,
    output: output ? output.slice(0, 2048) : undefined,
  }];
}
```

Attempts to extract output from SDK message. If SDK doesn't provide it, `output` is undefined — ToolResultBlock renders summary-only.

### 3. result-normalizer.js — forward to streamWriter (`lib/result-normalizer.js`)

**Lines 217-220:** tool_use forwarded to stream.
**Lines 237-245:** tool_use_summary logged to stderr only.

**Change:** Add streamWriter forwarding before the progress logging block.

```javascript
// Add at line 237, before existing tool_use_summary handling:
if (streamWriter && event.type === 'tool_use_summary') {
  streamWriter.write({
    type: 'tool_use_summary',
    summary: event.summary,
    output: event.output,
  });
}
// Existing progress/stderr logging continues after
```

### 4. build-stream-bridge.js — add _mapEvent case (`server/build-stream-bridge.js`)

**Line 310-315:** Existing `tool_use` case in the switch.

**Change:** Add `tool_use_summary` case after the `tool_use` case.

```javascript
case 'tool_use_summary':
  return {
    type: 'assistant', subtype: 'tool_use_summary',
    summary: event.summary,
    output: event.output,
    _source: 'build',
  };
```

**Pattern:** Follows the `tool_use` case structure (line 310-315) — maps to `type: 'assistant'` with a subtype.

### 5. agent-connector.js — update envelope spec (`server/connectors/agent-connector.js`)

**Lines 7-11:** Message envelope documentation.

**Change:** Add tool_use_summary to the documented types.

```javascript
*   { type: 'tool_use',          tool: string, input: object }
*   { type: 'tool_use_summary',  summary: string, output?: string }  // new
```

### 6. AgentStream.jsx — pre-grouping (`src/components/AgentStream.jsx`)

**Line 231:** Messages appended to `_state.messages`.

**Change:** In the rendering pipeline, before passing messages to MessageCard, group consecutive `tool_use` → `tool_use_summary` pairs. This happens in the component's render, not in `processMessage`.

The component reads `_state.messages` via the `onMessagesChange` callback (line 236). In the render function, transform the message array:

```javascript
function groupToolResults(messages) {
  const grouped = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const next = messages[i + 1];
    if (msg.type === 'assistant' && msg.message?.content?.some(b => b.type === 'tool_use')
        && next?.type === 'assistant' && next?.subtype === 'tool_use_summary') {
      grouped.push({ ...msg, _toolResult: next });
      i++; // skip the summary, it's consumed
    } else if (msg.subtype === 'tool_use_summary') {
      // Standalone summary (not preceded by tool_use) — render as dimmed verbose
      grouped.push(msg);
    } else {
      grouped.push(msg);
    }
  }
  return grouped;
}
```

Apply in render: `const displayMessages = groupToolResults(messages)`.

**Note:** Only groups when verbose is on (summaries are filtered when off). When COMP-OBS-SURFACE's verbose toggle is off, `tool_use_summary` events never enter `_state.messages`, so no grouping occurs.

### 7. MessageCard.jsx — render ToolResultBlock (`src/components/agent/MessageCard.jsx`)

**Lines 82-96:** Existing ToolUseBlock rendering for tool_use content blocks.

```javascript
// Current pattern (simplified):
{block.type === 'tool_use' && (
  <ToolUseBlock name={block.name} input={block.input} />
)}
```

**Change:** Check for `msg._toolResult` (attached by pre-grouping). If present, render ToolResultBlock below.

```jsx
{block.type === 'tool_use' && (
  <>
    <ToolUseBlock name={block.name} input={block.input} />
    {msg._toolResult && (
      <ToolResultBlock
        summary={msg._toolResult.summary}
        output={msg._toolResult.output}
      />
    )}
  </>
)}
```

**Multi-tool case:** When an assistant message has multiple `tool_use` blocks, the pre-grouping only attaches one `_toolResult` per message. For multi-tool, would need `_toolResults` array matched by index. For v1, support single tool_use per message — multi-tool is an edge case in build streams.

## New Components

### ToolResultBlock.jsx (new, `src/components/agent/ToolResultBlock.jsx`)

**Props:** `summary` (string), `output` (string | undefined)

**States:**
1. `output` undefined → render summary as non-expandable muted one-liner
2. `output` present, collapsed (default) → summary one-liner with expand chevron
3. `output` present, expanded → monospace pre, first 20 lines
4. `output` present, fully expanded → all lines

**Error detection:** Pattern match on output string:
```javascript
const isError = output && /\b(Error|error:|Traceback|FAILED|ENOENT|Cannot find)\b/.test(output);
```

**Visual treatment:**
- Container: inline below tool_use, slight indent (margin-left: 8px)
- Collapsed: `opacity: 0.6`, `font-size: 10px`, `color: hsl(var(--muted-foreground))`
- Expanded: `font-family: monospace`, `font-size: 10px`, `white-space: pre-wrap`
- Error: left border `2px solid hsl(var(--destructive))` instead of default muted border
- "Show all (N lines)" button: small link-style text, same 10px

**Pattern to follow:** ToolUseBlock in MessageCard (line 82-96) — same indentation and font treatment for collapsible content.

## Corrections Table

| Design assumption | Reality | Impact |
|---|---|---|
| Bridge has no tool_use_summary case | Confirmed: `_mapEvent` switch has no case for it | Add case — straightforward |
| result-normalizer forwards tool_use_summary | Confirmed: only logs to stderr (line 237-245) | Add streamWriter.write before stderr logging |
| Claude SDK provides output in tool_use_summary | SDK's `tool_use_summary` only has `summary` field | `output` will be undefined for Claude SDK. ToolResultBlock renders summary-only. Full output works with opencode connector. |
| AgentStream uses Zustand store | Uses module-scoped `_state` object | Pre-grouping happens in render function, reads `_state.messages` via React state |
| Multi-tool pairing | Pre-grouping attaches one result per message | v1: single tool_use per message. Multi-tool is edge case in build streams. |
| opencode connector output always string | Guarded by `typeof output === 'string'` (line 134) | Safe — only strings get forwarded |
