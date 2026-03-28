# Pipeline Authoring Loop: Implementation Blueprint

**Status:** BLUEPRINT
**Date:** 2026-03-28
**Design:** [design.md](design.md)

---

## File Plan

| File | Action | Purpose |
|------|--------|---------|
| `compose/pipelines/build.stratum.yaml` | existing | Add `metadata:` block (id, label, description, category, steps, estimated_minutes) |
| `compose/pipelines/review-fix.stratum.yaml` | existing | Add `metadata:` block |
| `compose/pipelines/coverage-sweep.stratum.yaml` | existing | Add `metadata:` block |
| `compose/pipelines/bug-fix.stratum.yaml` | new | Bug-fix template (6 steps) with metadata |
| `compose/pipelines/refactor.stratum.yaml` | new | Refactor template (7 steps) with metadata |
| `compose/pipelines/content.stratum.yaml` | new | Content/docs template (4 steps) with metadata |
| `compose/pipelines/research.stratum.yaml` | new | Research template (3 steps) with metadata |
| `compose/server/pipeline-routes.js` | new | `GET /api/pipeline/templates`, `GET /api/pipeline/templates/:id/spec`, `POST /api/pipeline/draft`, `GET /api/pipeline/draft`, `POST /api/pipeline/draft/approve`, `POST /api/pipeline/draft/reject` |
| `compose/server/vision-server.js` | existing | Import and attach pipeline-routes (after stratum block at line 206) |
| `compose/lib/stratum-mcp-client.js` | existing | No changes -- drafting is a REST concern, not MCP |
| `compose/lib/build.js` | existing | Add `writePipelineDraft()`, `readPipelineDraft()`, `deletePipelineDraft()` helpers alongside `writeActiveBuild` (after line 97); update `runBuild()` spec resolution to accept template ID (line 206) |
| `compose/src/components/vision/useVisionStore.js` | existing | Add `pipelineDraft: null` to initial state (after line 248); add `setPipelineDraft` setter in message handler wiring (line 168); add draft hydration in `ws.onopen` (after line 112) |
| `compose/src/components/vision/visionMessageHandler.js` | existing | Add `pipelineDraft` + `pipelineDraftResolved` handlers after `buildState` handler (after line 328) |
| `compose/src/components/vision/PipelineView.jsx` | existing | Add draft/active/empty mode switching; wire `pipelineDraft` from store; add approve/reject buttons in draft mode |
| `compose/src/components/vision/TemplateSelector.jsx` | new | Template picker component (fetches `/api/pipeline/templates`, renders cards) |
| `compose/src/components/vision/constants.js` | existing | Add `@deprecated` JSDoc to `PIPELINE_STEPS` (line 87) |

---

## Integration Points (verified line references)

### PIPE-1: Template Library

**compose/pipelines/build.stratum.yaml (existing)**
- Line 1-5: Current top-level structure is `version: "0.3"` then `workflow:` block. The `metadata:` block must be inserted as a sibling of `workflow:` (after line 1, before `workflow:` at line 3) to stay valid YAML. Stratum `spec.py` must tolerate the new key or it will be treated as unknown top-level field.
- No `metadata:` key exists today. All three existing templates (`build`, `review-fix`, `coverage-sweep`) need the same addition.

**compose/server/pipeline-routes.js (new)**
- New file. Template list endpoint reads `compose/pipelines/*.stratum.yaml`, parses YAML frontmatter for `metadata:` blocks, returns sorted array.
- Must use `getTargetRoot()` from `server/project-root.js` to resolve the `pipelines/` directory path (same pattern as `vision-server.js` line 76, 96).
- Route attachment pattern: export an `attachPipelineRoutes(app, deps)` function matching the convention used by `attachVisionRoutes`, `attachSessionRoutes`, etc.

**compose/server/vision-server.js (existing)**
- Line 190-206: Stratum conditional block. Pipeline routes are independent of Stratum capability (templates are filesystem-based, not MCP-based). Attach pipeline routes **outside** the stratum conditional, after the build state hydration block (after line 140), or in a new block before the stratum block.
- Line 68: `broadcastMessage` callback pattern — pipeline routes need this for draft broadcast.
- Line 47: `getTargetRoot()` and `getDataDir()` imports — pipeline routes need both.

**compose/src/components/vision/TemplateSelector.jsx (new)**
- Fetches from `GET /api/pipeline/templates`.
- Rendered inside `PipelineView.jsx` in the empty state (currently lines 89-95 show `EmptyState` component when `!activeBuild`).
- On template selection: calls `POST /api/pipeline/draft` with the template spec. Does NOT create a draft directly in Zustand. The server persists to `pipeline-draft.json` and broadcasts `pipelineDraft`, which hydrates the store via the standard message handler. Single source of truth: `pipeline-draft.json` on disk, hydrated via `GET /api/pipeline/draft` on reconnect.

**compose/src/components/vision/PipelineView.jsx (existing)**
- Line 4: `import { PIPELINE_STEPS, PIPELINE_PHASE_CONFIG } from './constants.js'` — template mode still needs `PIPELINE_PHASE_CONFIG` for phase grouping colors, but steps come from the template.
- Lines 42-53: `stepSource` construction merges `PIPELINE_STEPS` with live data. In draft mode, `stepSource` should come from `pipelineDraft.steps` instead.
- Lines 56-60: `phaseGroups` grouped by `PIPELINE_PHASE_CONFIG` keys. Draft steps may use phases not in this config (new templates may have different phase names). Need a fallback color for unknown phases.
- Lines 89-94: Empty state — replace with `TemplateSelector` component.

**compose/src/components/vision/constants.js (existing)**
- Lines 87-112: `PIPELINE_STEPS` — add `@deprecated` JSDoc. Not removed yet; still used by existing build runner path.
- Lines 114-119: `PIPELINE_PHASE_CONFIG` — extend with any new phase keys used by new templates, or switch to dynamic phase detection from template metadata.

### PIPE-2: Draft Pipeline Tool

**compose/lib/stratum-mcp-client.js (existing) -- NO CHANGES**
- No `draftPipeline()` method is added. Drafting is a compose REST concern, not an MCP concern. The agent (via the compose lifecycle skill) calls `POST /api/pipeline/draft` directly via fetch, same pattern as other compose REST calls in the skill.
- The MCP server tool `stratum_draft_pipeline` exists at `/Users/ruze/reg/my/forge/stratum/stratum-mcp/src/stratum_mcp/server.py:1073` but is not used by the compose draft flow. It writes to `.stratum/pipeline-draft.json` with a different schema (`{name, phases[]}`), which does not match the compose draft shape. Keeping it unused avoids overloading StratumMcpClient with REST responsibilities.

**compose/lib/build.js (existing)**
- Lines 75-97: `activeBuildPath()`, `readActiveBuild()`, `writeActiveBuild()` — the draft file helpers follow the identical pattern:
  - `pipelineDraftPath(dataDir)` returns `join(dataDir, 'pipeline-draft.json')`
  - `readPipelineDraft(dataDir)` — same try/catch as `readActiveBuild` (lines 79-87)
  - `writePipelineDraft(dataDir, draft)` — same atomic `.tmp` rename pattern as lines 89-97 (but without PID stamping)
  - `deletePipelineDraft(dataDir)` — same pattern as `deleteActiveBuild` at line 146-149
- Line 206: `const specPath = join(cwd, 'pipelines', 'build.stratum.yaml')` — **hardcoded** to `build.stratum.yaml`. Must be updated to accept a `template` option (from `opts.template`) that resolves to a different pipeline file. Fallback to `build.stratum.yaml` for backward compatibility.
- Line 210: `const specYaml = readFileSync(specPath, 'utf-8')` — no change needed, just follows the resolved path.

**compose/server/pipeline-routes.js (new)**
- `POST /api/pipeline/draft`: accepts two input shapes: (1) `{ spec: string, metadata: { id, label, description } }` for a full spec, or (2) `{ templateId: string }` as shorthand -- the server fetches the template spec internally via `GET /api/pipeline/templates/:id/spec`. Validates via basic YAML parse check (is it valid YAML?) and presence of `metadata` block -- does NOT validate spec structure (no `workflow.name` or `steps` array check), since full IR validation happens at approval time via `stratum_validate`. This accepts all template formats (v0.1 `functions`+`flows`, v0.3 `workflow`+`steps`). Parses steps from spec and stores them in the draft as `steps` array (array of `{ id, name, agent, phase }`). Generates a `draftId` (UUID), sets `status: 'pending'`, writes via `writePipelineDraft()`, broadcasts `{ type: 'pipelineDraft', draft }` (including `draftId`, `steps`, `status`) via `broadcastMessage()`. Called directly by the agent/skill via fetch (no MCP indirection).
- `GET /api/pipeline/draft`: reads `pipeline-draft.json` for hydration on reconnect. Returns `{ draft: { draftId, spec, metadata, steps, createdAt, status } | null }`. `steps` is derived from parsing the spec YAML at creation time (array of `{ id, name, agent, phase }`). `status` is `'pending'` (awaiting approve/reject). Returns `{ draft: null }` if no file.
- `POST /api/pipeline/draft/approve`: requires `{ draftId }` in request body; returns 409 Conflict if `draftId` doesn't match current draft. Called by the UI Approve button directly. Does NOT start execution directly. It: (1) validates the spec via `stratum_validate`, (2) writes the approved spec to `.compose/data/approved-specs/` as a named file (NOT `pipelines/` -- that directory is exclusively for curated templates), (3) deletes `pipeline-draft.json` only after spec file is successfully written, (4) broadcasts `{ type: 'pipelineDraftResolved', draftId, outcome: 'approved', specPath }`, (5) returns `{ outcome: 'approved', specPath, draftId }`. The broadcast notifies both the UI (to transition PipelineView) and the agent (which picks up `specPath` and calls `stratum_plan(spec)` to begin execution). When Stratum is disabled, approve still writes the spec file; the agent uses it as a flat prompt chain template.
- `POST /api/pipeline/draft/reject`: requires `{ draftId }` in request body; returns 409 Conflict if `draftId` doesn't match current draft. Deletes `pipeline-draft.json` immediately (no execution to protect), broadcasts `{ type: 'pipelineDraftResolved', draftId, outcome: 'rejected' }`.

**Stratum MCP server (external -- `/Users/ruze/reg/my/forge/stratum/stratum-mcp/src/stratum_mcp/server.py`)**
- Lines 1065-1092: `stratum_draft_pipeline` tool exists and writes to `.stratum/pipeline-draft.json`. This tool is NOT used by the compose draft flow. The Compose REST endpoint (`POST /api/pipeline/draft`) is the sole canonical draft path. No `draftPipeline()` wrapper is added to StratumMcpClient.

**Approval-to-execution handoff (concrete flow):**
1. The user clicks the Approve button in PipelineView, which calls `POST /api/pipeline/draft/approve` directly (same pattern as existing gate approval in the UI).
2. The approve endpoint validates the spec via `stratum_validate`, writes to `.compose/data/approved-specs/`, deletes the draft, broadcasts `pipelineDraftResolved` with `{ draftId, outcome: 'approved', specPath }`, and returns `{ outcome: 'approved', specPath, draftId }`.
3. The broadcast notifies both the UI (to transition PipelineView from draft to empty/active mode) and the agent (which is watching WebSocket messages).
4. The compose lifecycle skill (`/compose`), waiting for draft resolution, picks up `specPath` from the broadcast and calls `stratum_plan(spec)` to begin execution.
5. This mirrors the existing gate approval pattern: UI resolves, agent reacts.

### PIPE-3: Live Refresh

**compose/src/components/vision/useVisionStore.js (existing)**
- Line 232-248: Initial state object. Add `pipelineDraft: null` after `activeBuild: null` at line 248.
- Lines 141-172: Setter callbacks passed to `handleVisionMessage`. Add `setPipelineDraft` following the same pattern as `setActiveBuild` at line 168:
  ```
  setPipelineDraft: (updater) => set(s => ({ pipelineDraft: typeof updater === 'function' ? updater(s.pipelineDraft) : updater })),
  ```
- Line 106-112: `ws.onopen` handler — hydrates build state via `GET /api/build/state`. Add parallel fetch to `GET /api/pipeline/draft` with `set({ pipelineDraft: data.draft ?? null })`.
- Line 261: `setActiveBuild` action exposed at top level — add matching `setPipelineDraft` action for direct store manipulation.

**compose/src/components/vision/visionMessageHandler.js (existing)**
- Line 11: Function signature destructures `setters` — must add `setPipelineDraft` to the destructuring at line 20.
- Line 326-328: `buildState` handler — add new handlers immediately after:
  ```
  } else if (msg.type === 'pipelineDraft') {
    if (setPipelineDraft) setPipelineDraft(msg.draft);
  } else if (msg.type === 'pipelineDraftResolved') {
    if (setPipelineDraft) setPipelineDraft(null);
  }
  ```
- Line 343: End of function — the new handlers must be before the closing `}`.

**compose/src/components/vision/PipelineView.jsx (existing)**
- Line 18: Component signature `{ activeBuild, onSelectStep, onRefresh }` — add `pipelineDraft` prop (or read from store directly via `useVisionStore`).
- Lines 62-147: Render body — restructure with mode detection:
  ```
  const mode = pipelineDraft ? 'draft' : activeBuild ? 'active' : 'empty';
  ```
- Lines 89-94: Empty state block — show `TemplateSelector` instead of generic `EmptyState`.
- Lines 97-110: Live banner — in draft mode, show "Draft Pipeline: {name}" with Approve/Reject buttons instead of "Active Build" banner. Approve/Reject send `draftId` in request body.
- Lines 112-145: Phase groups rendering — in draft mode, render from `pipelineDraft.steps` grouped by phase, with dashed-border visual treatment. Steps are **read-only** in V1 (inline reorder/rename/delete is deferred to V2).

**compose/server/vision-server.js (existing)**
- Line 128-139: `GET /api/build/state` endpoint — add analogous `GET /api/pipeline/draft` in the pipeline-routes module.
- Line 274-285: `broadcastMessage()` method — used by pipeline-routes for draft/resolved broadcasts. No changes needed; just pass as dependency.

---

## Corrections Table

| Design Assumption | Reality | Resolution |
|---|---|---|
| "`stratum_draft_pipeline` tool already exists on the Stratum MCP server (visible in the tool list) but has no client-side wrapper in Compose" (line 112) | Tool exists at `stratum/stratum-mcp/src/stratum_mcp/server.py:1073`. It writes to `.stratum/pipeline-draft.json`, **not** `.compose/data/pipeline-draft.json`. Its `draft` schema expects `{name, phases[]}` format, not a full `.stratum.yaml` spec string. | Compose REST endpoint (`POST /api/pipeline/draft`) is the sole canonical draft path. No `draftPipeline()` wrapper is added to StratumMcpClient -- the MCP tool is unused by the compose flow. Draft file lives in `{dataDir}/pipeline-draft.json` per the design. |
| "Add `draftPipeline()` to `StratumMcpClient` (after `parallelDone()` at line 312)" | Drafting is a compose REST concern, not an MCP concern. Adding `draftPipeline()` to StratumMcpClient overloads that class with REST responsibilities. | Removed. No `draftPipeline()` method added. Agent calls `POST /api/pipeline/draft` directly via fetch. |
| "Zustand store additions in `useVisionStore.js` initial state at line 232" | Line 232 is `return {` — the initial state object. `activeBuild: null` is at line 248. | Add `pipelineDraft: null` after line 248 (correct location, line ref in design was to the return statement, not the field). |
| "Message handler after the `buildState` handler at line 328" | `buildState` handler is at lines 326-328. The handlers after it are `snapshotRequest` at line 330. | Insert `pipelineDraft` / `pipelineDraftResolved` handlers between line 328 and line 330. |
| "Server routes attach after line ~97, same pattern as other `attach*Routes` calls" | Route attachment calls span lines 66-206. The last `attach*` call before the stratum block is `attachGraphExportRoutes` at line 188. Build state hydration is at line 128-139. Stratum conditional is at lines 190-206. | Attach pipeline routes after line 188 (after graph export, before stratum conditional), since pipeline templates are filesystem-based and independent of stratum capability. |
| "`broadcastMessage()` at `vision-server.js:130+`" | `broadcastMessage()` is defined at lines 274-285. It is passed as a dependency closure `(msg) => this.broadcastMessage(msg)` at lines 68, 75, 85, 93, 175, 197. | Use the same closure pattern when passing to `attachPipelineRoutes`. |
| Design says "No changes to Stratum IR schema (templates already conform to `spec.py`)" | Verified: `spec.py:169` (`parse_and_validate`) reads `version` then dispatches to `_validate_v02` (line 197, no-op) or `_validate_v03` (line 208, checks steps/contracts/flows only). Neither validator checks for unknown top-level keys. A `metadata:` sibling is safe. | Confirmed correct. No `spec.py` changes needed. |
| Design says three existing templates at `compose/pipelines/` | Confirmed: `build.stratum.yaml` (332 lines), `review-fix.stratum.yaml` (3357 bytes), `coverage-sweep.stratum.yaml` (1080 bytes). No metadata blocks exist in any of them. | Correct. All three need metadata blocks added. |
| Design references `lib/constants.js` for `PIPELINE_STEPS` | Actual location is `src/components/vision/constants.js`. The import at `PipelineView.jsx:4` confirms this. | All references to `lib/constants.js` should be `src/components/vision/constants.js`. |
| Design says approve endpoint "triggers `stratum_plan` with the stored draft" (server starts execution) | Server should not start execution -- Compose uses a CLI-driven execution model where the agent executes, not the server. | Approve endpoint validates spec, writes to `.compose/data/approved-specs/` (not `pipelines/` -- that's for curated templates only), broadcasts `pipelineDraftResolved` with `{ outcome: 'approved', specPath, draftId }`, returns `{ outcome: 'approved', specPath, draftId }`. The UI Approve button calls the endpoint directly (same as gate approval). The broadcast notifies the agent, which picks up `specPath` and calls `stratum_plan(spec)`. |
| Design says template selection "populates a draft in the store" (Zustand only) | Zustand-only drafts are lost on refresh. Agent-initiated and user-initiated drafts should follow the same persistence path. | Template selection calls `POST /api/pipeline/draft` — server persists, broadcasts, store hydrates from broadcast. Single source of truth: `pipeline-draft.json` on disk. |
| Design draft schema has no `draftId`; approve/reject have no concurrency guard | Stale approve can act on a replaced draft if two drafts are created in quick succession. | Added `draftId` (UUID) to draft schema. Approve/reject require `draftId` in request body; server returns 409 if mismatch. |
| Design lists inline editing of draft steps as "stretch goal for PIPE-3" | Inline editing adds significant UI complexity and is not needed for core approve/reject flow. | Deferred to V2. V1 PipelineView shows draft steps read-only with approve/reject buttons. Added to "Not in scope" in design. |

---

## Verification Checklist

### PIPE-1: Template Library

- [x] `compose/pipelines/build.stratum.yaml:1-5` — `metadata:` key is tolerated by Stratum `spec.py` (verified: `_validate_v03` at spec.py:208 only checks steps/contracts/flows, ignores unknown top-level keys)
- [ ] `compose/pipelines/review-fix.stratum.yaml` — confirm top-level structure accepts `metadata:` sibling
- [ ] `compose/pipelines/coverage-sweep.stratum.yaml` — confirm top-level structure accepts `metadata:` sibling
- [ ] `compose/server/vision-server.js:47` — `getTargetRoot()` and `getDataDir()` already imported
- [ ] `compose/server/vision-server.js:188` — insertion point for `attachPipelineRoutes` (after `attachGraphExportRoutes`)
- [ ] `compose/server/vision-server.js:68` — `broadcastMessage` closure pattern to replicate for pipeline routes
- [ ] `compose/src/components/vision/PipelineView.jsx:89-94` — empty state block to replace with `TemplateSelector`
- [ ] `compose/src/components/vision/PipelineView.jsx:4` — import of `PIPELINE_STEPS` still needed for active mode
- [ ] `compose/src/components/vision/PipelineView.jsx:56-60` — `phaseGroups` construction needs fallback for unknown phases
- [ ] `compose/src/components/vision/constants.js:87` — `PIPELINE_STEPS` add `@deprecated` JSDoc
- [ ] `compose/src/components/vision/constants.js:114-119` — `PIPELINE_PHASE_CONFIG` may need extension for new template phases

### PIPE-2: Draft Pipeline Tool

- [x] `compose/lib/stratum-mcp-client.js` — NO CHANGES (drafting is a REST concern; no `draftPipeline()` method added)
- [ ] `compose/lib/build.js:75-97` — `activeBuildPath/read/write` pattern to replicate for draft helpers
- [ ] `compose/lib/build.js:146-149` — `deleteActiveBuild` pattern to replicate for `deletePipelineDraft`
- [ ] `compose/lib/build.js:206` — hardcoded `build.stratum.yaml` path must accept template parameter
- [x] `stratum/stratum-mcp/src/stratum_mcp/server.py:1073-1092` — MCP tool `stratum_draft_pipeline` exists but is NOT used by compose draft flow (different schema, different storage path)
- [ ] `compose/server/pipeline-routes.js` (new) — follows `attachVisionRoutes` pattern from `compose/server/vision-routes.js`
- [ ] `compose/server/pipeline-routes.js` — `POST /api/pipeline/draft` generates `draftId` (UUID) and includes it in broadcast
- [ ] `compose/server/pipeline-routes.js` — approve endpoint validates `draftId`, returns 409 on mismatch
- [ ] `compose/server/pipeline-routes.js` — approve writes spec to `.compose/data/approved-specs/` before deleting `pipeline-draft.json`
- [ ] `compose/server/pipeline-routes.js` — approve broadcasts `specPath` in `pipelineDraftResolved` for UI reactivity and returns `{ outcome: 'approved', specPath, draftId }` to caller
- [ ] `compose/server/pipeline-routes.js` — approve does NOT call `stratum_plan` (UI calls approve directly, broadcast notifies agent which drives execution)

### PIPE-3: Live Refresh

- [ ] `compose/src/components/vision/useVisionStore.js:248` — `activeBuild: null` line, add `pipelineDraft: null` after
- [ ] `compose/src/components/vision/useVisionStore.js:168` — `setActiveBuild` setter in message wiring, add `setPipelineDraft` after
- [ ] `compose/src/components/vision/useVisionStore.js:106-112` — `ws.onopen` hydration block, add `GET /api/pipeline/draft` fetch
- [ ] `compose/src/components/vision/useVisionStore.js:261` — `setActiveBuild` public action, add matching `setPipelineDraft`
- [ ] `compose/src/components/vision/visionMessageHandler.js:20` — `setters` destructuring, add `setPipelineDraft`
- [ ] `compose/src/components/vision/visionMessageHandler.js:326-328` — `buildState` handler, insert `pipelineDraft` handlers after line 328
- [ ] `compose/src/components/vision/PipelineView.jsx:18` — component props, add `pipelineDraft` or read from store
- [ ] `compose/src/components/vision/PipelineView.jsx:42-53` — `stepSource` construction, add draft mode branch
- [ ] `compose/src/components/vision/PipelineView.jsx:97-110` — live banner, add draft mode banner with approve/reject (sends `draftId`)
- [ ] `compose/src/components/vision/TemplateSelector.jsx` — calls `POST /api/pipeline/draft` (not Zustand directly) on template selection
- [ ] `compose/src/components/vision/PipelineView.jsx` — draft mode is read-only (no inline editing in V1)
- [ ] `compose/server/vision-server.js:128-139` — build state hydration pattern to replicate for draft hydration
- [ ] `compose/server/vision-server.js:274-285` — `broadcastMessage()` used by draft broadcast, no changes needed
