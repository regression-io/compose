# COMP-AGENT-CAPS Implementation Plan

**Items:** 133-136
**Scope:** Agent capability profiles with tool restrictions. Review agents can't modify code, implementers can't self-review.

## Related Documents

- Pipeline spec: `compose/pipelines/build.stratum.yaml`
- Connector: `compose/server/connectors/claude-sdk-connector.js`
- Build engine: `compose/lib/build.js`
- Stream writer: `compose/lib/build-stream-writer.js`

## Architecture

Agent templates define allowed tools per role. A centralized `parseAgentString()` utility resolves the `"provider:template"` format used in pipeline specs. The connector passes tool restrictions to the SDK. Violations are informational-only in v1 — logged to build audit via the stream writer, never blocking.

Currently, `claude-sdk-connector.js:46` hardcodes `tools: { type: 'preset', preset: 'claude_code' }`. The SDK supports `allowedTools` and `disallowedTools` for restriction. We add a template layer between the pipeline spec and the connector.

### v1 Scope (core value)

1. Template registry (4 profiles)
2. Centralized agent string parsing utility
3. Connector passes `allowedTools`/`disallowedTools` to SDK
4. Pipeline spec updated for review sub-flow steps
5. Violation logging is informational only — log to build audit, don't block

### Stretch (v2)

- Runtime violation detection (requires normalizer event stream integration)
- Enforcement mode (block on violation)
- Custom template definitions in `.compose/compose.json`

## Tasks

### Task 1: Agent template registry

**File:** `compose/server/agent-templates.js` (new)

- [ ] Export `AGENT_TEMPLATES` map:
  ```js
  {
    'read-only-reviewer': { allowedTools: ['Read', 'Grep', 'Glob', 'Agent'], disallowedTools: ['Edit', 'Write', 'Bash'], description: 'Read-only review agent' },
    'implementer': { allowedTools: null, disallowedTools: null, description: 'Full access implementation agent' },
    'orchestrator': { allowedTools: ['Read', 'Grep', 'Glob', 'Agent', 'Bash'], disallowedTools: ['Edit', 'Write'], description: 'Meta-config orchestrator' },
    'security-auditor': { allowedTools: ['Read', 'Grep', 'Glob', 'Bash'], disallowedTools: ['Edit', 'Write'], description: 'Security audit agent' }
  }
  ```
- [ ] Export `resolveTemplate(templateName)` — returns template or null (falls back to no restrictions)
- [ ] Export `validateCapabilities(template, toolName)` — returns `{ allowed: bool, reason: string }`

### Task 2: Centralized agent string parsing utility

**File:** `compose/lib/agent-string.js` (new)

The agent string format `"claude:read-only-reviewer"` is consumed in at least 5 locations in `build.js` (lines 441, 685, 998, 1129, 1224) plus `new.js` and `pipeline-cli.js`. Parsing must happen in one place, not inline at each call site.

- [ ] Export `parseAgentString(raw)` — splits `"provider:template"` into `{ provider, template }`:
  - `"claude:read-only-reviewer"` → `{ provider: 'claude', template: 'read-only-reviewer' }`
  - `"claude"` → `{ provider: 'claude', template: null }`
  - `"codex"` → `{ provider: 'codex', template: null }`
  - `null` / `undefined` → `{ provider: 'claude', template: null }` (backward compat default)
- [ ] Export `resolveAgentConfig(raw)` — calls `parseAgentString` + `resolveTemplate`, returns `{ provider, template, allowedTools, disallowedTools }` ready to pass to connector factory
- [ ] All `response.agent ?? 'claude'` sites in `build.js` call `parseAgentString()` instead of doing raw string handling

### Task 3: Connector tool restriction

**File:** `compose/server/connectors/claude-sdk-connector.js` (existing)

- [ ] Accept `allowedTools` and `disallowedTools` in constructor opts
- [ ] In `run()` method (~line 40-48): if `allowedTools` provided, replace the hardcoded `tools: { type: 'preset', preset: 'claude_code' }` with SDK's `allowedTools` parameter
- [ ] If `disallowedTools` provided, pass SDK's `disallowedTools` parameter
- [ ] If neither provided, keep existing `preset: 'claude_code'` behavior (backward compat)

### Task 4: Build.js connector factory integration

**File:** `compose/lib/build.js` (existing)

- [ ] Import `resolveAgentConfig` from `agent-string.js`
- [ ] Update `defaultConnectorFactory` (~line 92-101): accept full agent string, call `resolveAgentConfig()`, pass `allowedTools`/`disallowedTools` to connector constructor
- [ ] Update every `response.agent ?? 'claude'` site to use `parseAgentString()` for the provider lookup — currently at lines 441, 685, 998, 1129, 1224 (and stream writer metadata at 400, 474, 710, 992)
- [ ] The `getConnector()` calls at these sites pass the full agent string (including template suffix) so the factory can resolve restrictions

### Task 5: Violation logging (informational only)

**File:** `compose/lib/build-stream-writer.js` (existing) and `compose/lib/build.js` (existing)

Violation detection cannot happen inside `runAndNormalize()` because it only returns `{ text, result }`, not structured tool events. Instead, violations are logged as build-stream events.

- [ ] Add a `writeViolation(stepId, agent, templateName, detail)` convenience method to `BuildStreamWriter`
- [ ] After each `runAndNormalize()` call in `build.js`, if the step has a template with restrictions, emit an informational `capability_profile` event to the stream writer noting which template was active:
  ```js
  streamWriter.write({ type: 'capability_profile', stepId, agent, template: templateName, allowedTools, disallowedTools });
  ```
- [ ] **Stretch:** For actual violation detection (seeing which tools the agent used), hook into the normalizer's event stream or the SDK's message envelope — this is a v2 concern

### Task 6: Pipeline spec update

**File:** `compose/pipelines/build.stratum.yaml` (existing)

The review agent fields live inside sub-flows (`review_check`, `parallel_review`), not at the top-level `review` step. The top-level `review` step just references `flow: parallel_review`.

- [ ] In `review_check` sub-flow: update `steps[0]` (id: `review`, currently `agent: codex`) — keep as codex (codex has its own restrictions via the Codex model, not our template system)
- [ ] In `parallel_review` sub-flow:
  - `triage` step (currently `agent: claude`) — change to `agent: "claude:orchestrator"` (reads code, decides lenses, doesn't modify)
  - `review_lenses` step (`type: parallel_dispatch`) — update `intent_template` to include `agent: "claude:read-only-reviewer"` so dispatched lens agents are read-only
  - `merge` step (currently `agent: claude`) — change to `agent: "claude:orchestrator"` (aggregates findings, doesn't modify code)
- [ ] Implementation steps (`execute`, `explore_design`, `blueprint`, etc.) stay `agent: "claude"` — defaults to implementer (no restrictions)
- [ ] Codex steps stay `agent: "codex"` — no change

### Task 7: Tests

**File:** `compose/test/agent-templates.test.js` (new)

- [ ] Test: `resolveTemplate` returns correct template for known types
- [ ] Test: `resolveTemplate` returns null for unknown types
- [ ] Test: `validateCapabilities` correctly allows/denies tools
- [ ] Test: `parseAgentString("claude:read-only-reviewer")` → `{ provider: 'claude', template: 'read-only-reviewer' }`
- [ ] Test: `parseAgentString("claude")` → `{ provider: 'claude', template: null }`
- [ ] Test: `parseAgentString(null)` → `{ provider: 'claude', template: null }`
- [ ] Test: `resolveAgentConfig("claude:read-only-reviewer")` returns allowedTools/disallowedTools from template
- [ ] Test: connector passes `allowedTools` to SDK when provided
- [ ] Test: connector uses default preset when no restrictions provided (backward compat)

## Implementation Order

1. **Task 1** (template registry) — no dependencies
2. **Task 2** (agent string parser) — depends on Task 1
3. **Task 3** (connector restriction) — no dependencies, can parallel with 1+2
4. **Task 4** (build.js integration) — depends on Tasks 1, 2, 3
5. **Task 6** (pipeline spec) — depends on Task 2 (format must be defined)
6. **Task 5** (violation logging) — depends on Task 4
7. **Task 7** (tests) — after all implementation tasks
