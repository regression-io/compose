# COMP-OBS-STREAM: Implementation Plan

## Related Documents

- [Design](design.md)
- [Blueprint](blueprint.md)
- [COMP-OBS-SURFACE plan](../COMP-OBS-SURFACE/plan.md) — prerequisite (verbose toggle)

## Prerequisite

COMP-OBS-SURFACE must ship first. The verbose toggle (`_state.verboseStream` in AgentStream) gates whether `tool_use_summary` events reach the UI.

## Tasks

### Phase 1: Backend pipeline (parallelizable)

- [ ] **T1: Enrich opencode-connector tool_use_summary** — `server/connectors/opencode-connector.js` (existing, line 136). Test: extend `test/connectors.test.js`. Add `output: output.slice(0, 2048)` to yielded event.
- [ ] **T2: Enrich claude-sdk-connector tool_use_summary** — `server/connectors/claude-sdk-connector.js` (existing, lines 121-123). Test: extend `test/connectors.test.js`. Add `output: (msg.result ?? msg.output ?? '').slice(0, 2048) || undefined`.
- [ ] **T3: Create ToolResultBlock.jsx** — `src/components/agent/ToolResultBlock.jsx` (new). Test: `test/tool-result-block.test.js` (new). Summary-only, collapsed, expanded (20 lines), "Show all", error detection.

### Phase 2: Pipeline plumbing

- [ ] **T4: Forward tool_use_summary in result-normalizer** — `lib/result-normalizer.js` (existing, insert before line 237). Test: extend `test/result-normalizer.test.js`. Add `streamWriter.write()` for tool_use_summary events. Depends on T1, T2.
- [ ] **T5: Add tool_use_summary to build-stream-bridge** — `server/build-stream-bridge.js` (existing, after line 315). Test: extend `test/build-stream-bridge.test.js`. New `_mapEvent` case: `{ type: 'assistant', subtype: 'tool_use_summary', summary, output, _source: 'build' }`. Depends on T4.
- [ ] **T6: Update agent-connector envelope docs** — `server/connectors/agent-connector.js` (existing, lines 7-11). Add `tool_use_summary` to JSDoc. No test. Depends on T1, T2.

### Phase 3: UI integration

- [ ] **T7: Add pre-grouping to AgentStream** — `src/components/AgentStream.jsx` (existing). Test: `test/agent-stream-grouping.test.js` (new). Export `groupToolResults()`, apply in render. Pairs consecutive tool_use → tool_use_summary, attaches `_toolResult`. Depends on T5.
- [ ] **T8: Wire ToolResultBlock into MessageCard** — `src/components/agent/MessageCard.jsx` (existing, after ToolUseBlock ~line 114). Check `msg._toolResult`, render `<ToolResultBlock>` below. Depends on T3, T7.

## Dependency Graph

```
COMP-OBS-SURFACE (prerequisite)
        |
  [T1, T2, T3]  ← parallel
        |
    [T4, T6]    ← parallel
        |
       T5
        |
       T7
        |
       T8
```

## Verification

1. `node --test` — all tests pass
2. `npm run build` — clean build
3. Manual: `npm run dev` from compose root → trigger build → toggle verbose on → tool results appear attached below tool_use blocks → expand → see output → "Show all" on long output → toggle off → results disappear
