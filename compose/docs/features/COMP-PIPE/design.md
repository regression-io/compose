# Pipeline Authoring Loop: Design

**Status:** DESIGN
**Date:** 2026-03-28
**Feature Code:** COMP-PIPE (items PIPE-1 through PIPE-3)

## Related Documents

- [Compose Roadmap](../../plans/) -- COMP-PIPE feature group
- `compose/pipelines/build.stratum.yaml` -- existing 332-line full-lifecycle template (15 steps)
- `compose/pipelines/review-fix.stratum.yaml` -- existing execute+review loop template
- `compose/pipelines/coverage-sweep.stratum.yaml` -- existing single-iteration loop template
- `compose/lib/stratum-mcp-client.js` -- MCP protocol client (13 tools, unchanged -- drafting is a REST concern)
- `compose/stratum-mcp/` -- Stratum MCP server (Python, `spec.py` IR validator)

---

## Problem

Compose currently hardcodes three pipeline templates. The agent selects `build.stratum.yaml` unconditionally via `stratum_plan`, and the user has no way to preview, edit, or approve a pipeline before execution starts. PipelineView (`src/components/vision/PipelineView.jsx`) is read-only -- it renders whatever `activeBuild` contains, with no draft/active distinction and no template selection.

This creates two gaps:

1. **No template variety.** Bug fixes, refactors, and research tasks run through a 15-step feature-dev pipeline that is overkill. There is no lightweight alternative the agent or user can choose.
2. **No review before execution.** The agent calls `stratum_plan` and execution begins immediately. The user cannot inspect the planned steps, reorder them, or reject the plan before work starts.

## Goal

**In scope:**

- A template library with metadata, discoverable by both agent and UI (PIPE-1)
- A REST-based draft flow that lets the agent push a drafted pipeline into the UI for human review (PIPE-2)
- Live refresh of PipelineView when a draft arrives, with approve/reject controls (PIPE-3)

**Not in scope:**

- Visual drag-and-drop pipeline editor (future -- too much UI complexity for V1)
- Custom user-authored templates saved to disk (future -- templates are code-managed for now)
- Pipeline versioning or rollback
- Inline editing of draft steps (reorder, rename, delete) -- deferred to V2
- Changes to Stratum IR schema (templates already conform to `spec.py`)

---

## Decision 1: Template Library Structure

### Context

Three templates exist on disk at `compose/pipelines/*.stratum.yaml`. They have no metadata -- the agent must know the filename to use one. The frontend has no way to list available templates.

### Approach: Filesystem-based library with sidecar metadata

Each template gets a YAML frontmatter block (already valid in stratum `version: "0.3"` specs) with structured metadata:

```yaml
# pipelines/build.stratum.yaml (existing, add metadata block)
metadata:
  id: feature-dev
  label: "Feature Development"
  description: "Full lifecycle: design -> plan -> execute -> review -> ship"
  category: feature
  steps: 15
  estimated_minutes: 30
```

New templates to add:

| Template ID | File | Steps | Use case |
|---|---|---|---|
| `feature-dev` | `build.stratum.yaml` (existing) | 15 | Full feature lifecycle |
| `bug-fix` | `bug-fix.stratum.yaml` (new) | 6 | Reproduce -> fix -> test -> review |
| `refactor` | `refactor.stratum.yaml` (new) | 7 | Analysis -> refactor -> test -> review |
| `content` | `content.stratum.yaml` (new) | 4 | Draft -> review -> publish |
| `research` | `research.stratum.yaml` (new) | 3 | Explore -> synthesize -> report |
| `review-fix` | `review-fix.stratum.yaml` (existing) | 3 | Execute + review loop |
| `coverage-sweep` | `coverage-sweep.stratum.yaml` (existing) | 2 | Test iteration loop |

**Server endpoints:**

- `GET /api/pipeline/templates` -- returns metadata list (for UI display). Reads `compose/pipelines/*.stratum.yaml`, parses the `metadata` block from each, returns an array sorted by category. This avoids a separate registry file that could drift from the actual templates.
- `GET /api/pipeline/templates/:id/spec` -- returns the full YAML spec for a given template ID (for draft creation). The UI fetches this after the user selects a template, then passes the spec to `POST /api/pipeline/draft`.

**Template selection flow:** UI fetches metadata list via `GET /api/pipeline/templates` -> user picks a template -> UI fetches the full spec via `GET /api/pipeline/templates/:id/spec` -> UI calls `POST /api/pipeline/draft` with the spec.

```json
// GET /api/pipeline/templates response
{
  "templates": [
    {
      "id": "feature-dev",
      "label": "Feature Development",
      "description": "Full lifecycle: design -> plan -> execute -> review -> ship",
      "category": "feature",
      "steps": 15,
      "file": "build.stratum.yaml"
    }
  ]
}
```

```json
// GET /api/pipeline/templates/:id/spec response
{
  "id": "feature-dev",
  "spec": "version: \"0.3\"\nmetadata:\n  id: feature-dev\n  ...\nworkflow:\n  ..."
}
```

**Agent selection:** The agent calls `POST /api/pipeline/draft` with one of two input shapes: (1) `{ spec: string, metadata: { id, label, description } }` when supplying a full spec directly, or (2) `{ templateId: string }` as shorthand -- the server fetches the template spec internally via the template library and populates the draft. When skipping the draft flow entirely, the agent calls `stratum_plan` directly with the spec.

**UI selector:** A template picker component renders the template list. Available from PipelineView's empty state (no active build) or from a "New Pipeline" action.

### Alternatives considered

1. **JSON registry file (`pipelines/index.json`).** Rejected -- adds a file that must be kept in sync with the YAML files. Parsing metadata from the source is more reliable.
2. **Database/store-backed templates.** Rejected -- overengineered for 5-7 templates. Filesystem is the right level of complexity.
3. **Hardcoded constant array in `constants.js`.** Rejected -- the current `PIPELINE_STEPS` array at `lib/constants.js` already demonstrates the maintenance burden of duplicating pipeline structure in JS. The YAML files are the source of truth.

---

## Decision 2: Draft Pipeline Tool Design

### Context

`stratum-mcp-client.js:1-313` wraps 13 Stratum MCP tools. A `stratum_draft_pipeline` tool exists on the Stratum MCP server but is not used by this flow -- it writes to a different path with a different schema. The Compose draft flow is purely REST-based: agent POSTs a spec to `/api/pipeline/draft` -> UI shows draft -> user reviews -> user approves -> agent calls `stratum_plan` to start execution.

### Approach: REST endpoint + file-backed draft (no StratumMcpClient changes)

Drafting is a compose REST concern, not an MCP concern. The agent calls `POST /api/pipeline/draft` directly via fetch (same pattern as other compose REST calls in the lifecycle skill). No `draftPipeline()` method is added to `StratumMcpClient` -- that client stays focused on Stratum execution tools.

**1. REST endpoints** in a new `server/pipeline-routes.js`:

- `GET /api/pipeline/draft` -- returns the current draft from `pipeline-draft.json` if it exists, or `{ draft: null }` if no draft is pending. Response: `{ draft: { draftId, spec, metadata, steps, createdAt, status } | null }`. `steps` is derived from parsing the spec YAML at creation time (array of `{ id, name, agent, phase }`). `status` is `'pending'` (awaiting approve/reject). Used by the UI on WebSocket reconnect to hydrate any pending draft (see Decision 3, hydration on reconnect).

- `POST /api/pipeline/draft`:

- Accepts two input shapes: (1) `{ spec: string, metadata: { id, label, description } }` for a full spec, or (2) `{ templateId: string }` as shorthand -- the server fetches the template spec internally
- Validates spec via basic YAML parse check (is it valid YAML?) and presence of `metadata` block. Full structural/IR validation happens at approval time via `stratum_validate` -- this accepts all template formats (v0.1 `functions`+`flows`, v0.3 `workflow`+`steps`)
- Writes draft to `{dataDir}/pipeline-draft.json` with atomic `.tmp` rename (same pattern as `writeActiveBuild` at `lib/build.js:89-97`)
- Broadcasts `{ type: 'pipelineDraft', draft }` via `broadcastMessage()`
- Returns `{ draftId }` (the generated UUID for concurrency tracking)

**2. Draft lifecycle:**

```
Agent POSTs to /api/pipeline/draft { spec, metadata: { id, label, description } } or { templateId } (direct fetch, no MCP indirection)
  -> Server validates YAML syntax + metadata presence, parses steps from spec, writes pipeline-draft.json, broadcasts pipelineDraft
  -> UI shows draft in PipelineView
  -> User clicks Approve
  -> UI POSTs to /api/pipeline/draft/approve { draftId }
  -> Server validates spec via stratum_validate
  -> Server writes approved spec to .compose/data/approved-specs/ as named file
  -> Server deletes pipeline-draft.json
  -> Server broadcasts pipelineDraftResolved { draftId, outcome: 'approved', specPath: '.compose/data/approved-specs/...' }
  -> Server returns { outcome: 'approved', specPath, draftId } to the approve caller
```

**Approval-to-execution handoff:**

The UI is the approval owner. Concrete flow:

1. The user clicks the Approve button in PipelineView, which calls `POST /api/pipeline/draft/approve` directly (same pattern as existing gate approval in the UI).
2. The approve endpoint validates the spec via `stratum_validate`, writes the approved spec to `.compose/data/approved-specs/`, deletes `pipeline-draft.json`, and returns `{ outcome: 'approved', specPath: '...', draftId }`.
3. The endpoint broadcasts `pipelineDraftResolved` with `{ draftId, outcome: 'approved', specPath }`. This notifies both the UI (to update PipelineView from draft to empty/active mode) and the agent (which is watching WebSocket messages).
4. The compose lifecycle skill (`/compose`), which has been waiting for draft resolution, picks up the `specPath` from the broadcast and calls `stratum_plan(spec)` to begin execution.

This mirrors how existing gate approval works: the UI resolves, the agent reacts to the resolution event.

**3. Approve/Reject endpoints:**

- `POST /api/pipeline/draft/approve` -- requires `{ draftId }` in request body (returns 409 if stale). Called by the UI Approve button directly. Does NOT start execution directly. It: (1) validates the spec via `stratum_validate`, (2) writes the approved spec to `.compose/data/approved-specs/` as a named file (NOT `pipelines/` -- that directory is exclusively for curated templates), (3) deletes `pipeline-draft.json` only after the spec file is successfully written, (4) broadcasts `{ type: 'pipelineDraftResolved', draftId, outcome: 'approved', specPath }`, (5) returns `{ outcome: 'approved', specPath, draftId }`. The broadcast notifies both the UI (to transition PipelineView) and the agent (which picks up `specPath` and calls `stratum_plan(spec)` to begin execution). This mirrors the existing gate approval pattern: UI resolves, agent reacts.
- `POST /api/pipeline/draft/reject` -- requires `{ draftId }` in request body (returns 409 if stale). Deletes `pipeline-draft.json` immediately (no execution to protect), broadcasts `{ type: 'pipelineDraftResolved', draftId, outcome: 'rejected' }`

**Execution handoff (Stratum disabled):** When Stratum is not available, approve still writes the spec file to `.compose/data/approved-specs/`. The agent uses it as a flat prompt chain template instead of calling `stratum_plan`.

**4. Draft identity:** Each draft gets a `draftId` (UUID, generated on creation). The `draftId` is included in the `pipelineDraft` broadcast so the UI can track it. Approve and reject endpoints require `draftId` in the request body; the server returns 409 Conflict if `draftId` doesn't match the current draft on disk. This prevents stale approvals when a new draft has replaced an old one.

**Draft JSON shape:**

```json
{
  "draftId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "createdAt": "2026-03-28T12:00:00Z",
  "metadata": {
    "templateId": "bug-fix",
    "featureCode": "COMP-PIPE",
    "description": "Fix the flaky test in build.js"
  },
  "spec": "version: \"0.3\"\nworkflow:\n  name: bug-fix\n  ...",
  "steps": [
    { "id": "reproduce", "label": "Reproduce Bug", "phase": "investigate" },
    { "id": "fix", "label": "Implement Fix", "phase": "execute" },
    { "id": "test", "label": "Run Tests", "phase": "verify" }
  ],
  "status": "pending"
}
```

**Step derivation:** The `steps` array in the draft JSON is extracted from the spec YAML at draft creation time. Extraction is version-aware:

- **v0.3 templates** (e.g. `build.stratum.yaml`): Steps come from `workflow.steps[]`. Each entry has `id`, `name` (or derived from `id` by replacing hyphens/underscores with spaces and title-casing), `agent` (from the step's function mode, defaults to `'claude'`), and `phase` (from step metadata or inferred from position).

- **v0.1 templates** (e.g. `review-fix.stratum.yaml`, `coverage-sweep.stratum.yaml`): Steps come from `flows.<flowName>.steps[]`, using the first (or only) flow. Each step has `id` and a `function` reference; `name` is derived from `id`, `agent` defaults to `'claude'`. If no `flows` block exists, fall back to `functions` keys as single-step entries (one step per function, `id` = function key).

- **Fallback:** If step extraction fails for any reason (malformed YAML, unexpected structure), set `steps: []`. PipelineView renders "Steps unavailable" in draft mode rather than crashing. The user can still approve or reject the draft based on the raw spec metadata.

### Alternatives considered

1. **Agent calls `stratum_plan` directly, user pauses before first step.** Rejected -- `stratum_plan` starts the flow. There is no pause-before-start in the Stratum protocol. A separate draft stage is cleaner.
2. **Draft stored only in Zustand (no file).** Rejected -- if the vision server restarts, the draft is lost. File persistence with broadcast mirrors the `active-build.json` pattern.
3. **Draft stored in the Stratum server.** Rejected -- Stratum manages validated, executing flows. A pre-validation draft belongs in Compose's data layer.

---

## Decision 3: Live Refresh Architecture

### Context

The existing broadcast pattern is well-established: server emits a typed WebSocket message via `broadcastMessage()` (`vision-server.js:130+`), `visionMessageHandler.js` dispatches to Zustand setters, components re-render from store selectors. Build state already follows this pattern (`buildState` message type at `visionMessageHandler.js:326-328`).

### Approach: New message types + store slice + PipelineView modes

**1. WebSocket messages:**

| Message type | Payload | Trigger |
|---|---|---|
| `pipelineDraft` | `{ type, draft }` | Draft created via POST /api/pipeline/draft |
| `pipelineDraftResolved` | `{ type, draftId, outcome: 'approved'\|'rejected', specPath? }` | Draft approved or rejected |
| `pipelineTemplates` | `{ type, templates }` | Template list changed (optional, for future hot-reload) |

**2. Zustand store additions** (in `useVisionStore.js` initial state at line 232):

```js
pipelineDraft: null,    // current pending draft or null
```

Plus a setter wired through the same ref-proxy pattern used by all other setters (lines 141-172):

```js
setPipelineDraft: (updater) => set(s => ({
  pipelineDraft: typeof updater === 'function' ? updater(s.pipelineDraft) : updater
})),
```

**3. Message handler** (in `visionMessageHandler.js`, after the `buildState` handler at line 328):

```js
} else if (msg.type === 'pipelineDraft') {
  if (setPipelineDraft) setPipelineDraft(msg.draft);
} else if (msg.type === 'pipelineDraftResolved') {
  if (setPipelineDraft) setPipelineDraft(null);
}
```

**4. PipelineView modes:**

PipelineView currently receives `activeBuild` as its sole data source. It will gain three visual modes:

| Mode | Data source | Controls shown |
|---|---|---|
| **Empty** | No draft, no active build | Template selector |
| **Draft** | `pipelineDraft !== null` | Step list (read-only), Approve button, Reject button |
| **Active** | `activeBuild !== null` | Current step progress (existing behavior) |

Priority: `Draft > Active > Empty`. If a draft exists while a build is active (edge case -- should not happen in normal flow), the draft takes precedence with a warning.

**5. Draft step rendering:**

The draft includes a pre-parsed `steps` array. PipelineView renders these with a distinct visual treatment (dashed borders, muted colors, "DRAFT" badge) to distinguish from active execution steps. No merge with `PIPELINE_STEPS` from constants -- the draft is self-describing.

**6. Inline editing -- Deferred (V2):**

Inline reorder/rename/delete of draft steps is out of scope for V1. In V1, PipelineView in draft mode shows steps read-only with approve/reject buttons. Inline editing may be added in V2 once the core draft lifecycle is proven.

**7. Hydration on reconnect:**

On WebSocket reconnect (`ws.onopen` at `useVisionStore.js:106`), fetch `GET /api/pipeline/draft` to hydrate any pending draft. Same pattern as the existing `GET /api/build/state` call at line 109.

### Alternatives considered

1. **Polling for draft state (like build state at 5s interval).** Rejected -- drafts are infrequent, event-driven. WebSocket push is more responsive and avoids unnecessary polling.
2. **Separate DraftView component.** Rejected -- the draft and active pipeline share the same visual structure (step list grouped by phase). A mode flag inside PipelineView is simpler than a parallel component.
3. **Store draft in `activeBuild` with a `status: 'draft'` field.** Rejected -- conflates two distinct concepts. A build that is "draft" vs "active" would require guard clauses everywhere `activeBuild` is read. Separate state is cleaner.

---

## Approach Summary

| Item | What | How |
|---|---|---|
| PIPE-1 | Template library | YAML metadata blocks + `GET /api/pipeline/templates` endpoint + UI template picker |
| PIPE-2 | Draft pipeline flow | `POST /api/pipeline/draft` REST endpoint + file-backed storage + approve/reject endpoints + skill-driven execution handoff |
| PIPE-3 | Live refresh | `pipelineDraft` WebSocket message + Zustand slice + PipelineView draft/active/empty modes + reconnect hydration |

## Files

| File | Action | Purpose |
|---|---|---|
| `compose/pipelines/build.stratum.yaml` | existing | Add `metadata` frontmatter block |
| `compose/pipelines/review-fix.stratum.yaml` | existing | Add `metadata` frontmatter block |
| `compose/pipelines/coverage-sweep.stratum.yaml` | existing | Add `metadata` frontmatter block |
| `compose/pipelines/bug-fix.stratum.yaml` | new | Bug-fix pipeline template (6 steps) |
| `compose/pipelines/refactor.stratum.yaml` | new | Refactor pipeline template (7 steps) |
| `compose/pipelines/content.stratum.yaml` | new | Content/docs pipeline template (4 steps) |
| `compose/pipelines/research.stratum.yaml` | new | Research pipeline template (3 steps) |
| `compose/server/pipeline-routes.js` | new | `GET /api/pipeline/templates`, `GET /api/pipeline/templates/:id/spec`, `POST /api/pipeline/draft`, `GET /api/pipeline/draft`, `POST /api/pipeline/draft/approve`, `POST /api/pipeline/draft/reject` |
| `compose/server/vision-server.js` | existing | Import and attach `pipeline-routes.js` (after line ~97, same pattern as other `attach*Routes` calls) |
| `compose/lib/stratum-mcp-client.js` | existing | No changes -- drafting is a REST concern, not MCP |
| `compose/lib/build.js` | existing | Add draft file write/read/delete helpers alongside `writeActiveBuild` at line 89 |
| `compose/src/components/vision/useVisionStore.js` | existing | Add `pipelineDraft: null` to initial state (line 248), add `setPipelineDraft` setter, add hydration fetch in `ws.onopen` |
| `compose/src/components/vision/visionMessageHandler.js` | existing | Add `pipelineDraft` and `pipelineDraftResolved` handlers after `buildState` handler (line 328) |
| `compose/src/components/vision/PipelineView.jsx` | existing | Add draft/active/empty modes, template selector, approve/reject controls |
| `compose/src/components/vision/TemplateSelector.jsx` | new | Template list UI component (fetches from `/api/pipeline/templates`) |

## Resolved Questions

**Q: Should template metadata live in a separate index file or inline in the YAML?**
A: Inline. Parsing metadata from the source file eliminates drift between a registry and the actual templates. The `GET /api/pipeline/templates` endpoint reads and parses at request time (templates are small, count is <10).

**Q: Should the draft go through Stratum validation before showing in the UI?**
A: No, not before showing the draft. The Compose REST endpoint does only a basic YAML parse check (is it valid YAML?) and verifies the presence of a `metadata` block on creation. It does NOT validate spec structure (e.g., `workflow.name` or `steps` array) -- that is Stratum's job. Full validation via `stratum_validate` happens at approval time, before writing the approved spec to disk. This lets the user see and reject malformed drafts without blocking on validation errors, and accepts all template formats (v0.1 `functions`+`flows` structure used by `review-fix` and `coverage-sweep`, as well as v0.3 `workflow`+`steps` structure).

**Q: What happens if the agent calls `stratum_plan` directly, bypassing the draft?**
A: It works -- `stratum_plan` is unchanged. The draft flow is opt-in. When the agent is confident (e.g., using a known template for a bound feature), it can skip drafting. The draft flow exists for cases where the agent constructs a custom or modified pipeline that benefits from human review.

**Q: How does the template selector interact with the draft flow?**
A: User selects a template -> UI calls `POST /api/pipeline/draft` with the template spec -> server persists to `pipeline-draft.json`, broadcasts `pipelineDraft` -> all clients see it. This means template selection and agent-initiated drafts go through the same persistence path. Single source of truth: `pipeline-draft.json` on disk, hydrated via `GET /api/pipeline/draft` on reconnect. No drafts are created directly in Zustand -- the store is always populated from server broadcasts or hydration fetches.

**Q: Should we deprecate `PIPELINE_STEPS` in `lib/constants.js`?**
A: Not yet. `PIPELINE_STEPS` is used by the existing build runner for the default `build.stratum.yaml` pipeline. Once PIPE-1 templates are live and the build runner reads step metadata from the template, `PIPELINE_STEPS` can be removed. Mark it with a `@deprecated` JSDoc comment in this round.
