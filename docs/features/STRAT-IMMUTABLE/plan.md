# STRAT-IMMUTABLE Implementation Plan

**Items:** 110-111, 140
**Scope:** Stratum executor changes — SHA-256 checksumming of specs and gate policy during execution.

## Architecture

### Threat model

`stratum_plan` receives inline YAML as a string parameter (not a file path). The MCP server parses it, builds a `FlowDefinition`, and stores flow state in memory. During step transitions (`stratum_step_done`, `stratum_parallel_done`), the executor operates on the in-memory `FlowDefinition` — it never re-reads the spec from disk. Therefore:

1. **In-memory tampering** — An agent could mutate the `FlowDefinition` or `FlowState` object after creation. Protection: checksum the spec string at flow start, verify in-memory integrity at every step transition.
2. **Re-plan attack** — An agent could call `stratum_plan` again with a modified spec for the same feature during the same session, silently replacing the flow. Protection: in `build.js`, hash the pipeline YAML file at build start and verify it hasn't changed before each `stepDone`/`parallelDone` call.
3. **Gate policy tampering** — An agent could modify `.compose/data/settings.json` to weaken gate policies mid-build. Protection: hash the policy fields from `settings.json` at build start, verify before gate resolution.

### Design

Two layers of protection:

- **Layer 1 (stratum-mcp, Python):** `spec_checksum` on `FlowState`. Computed at flow creation from the raw spec YAML string. Verified at `stratum_step_done` and `stratum_parallel_done` by recomputing from the stored `FlowDefinition`. Detects in-memory mutation.
- **Layer 2 (build.js, JS):** Pipeline file hash and settings hash. Computed at build start. Verified before each `stepDone`/`parallelDone` call. Detects on-disk tampering of the pipeline YAML or gate policy.

## Tasks

### Task 1: Add spec_checksum to FlowState

**File:** `stratum-mcp/src/stratum_mcp/executor.py` (existing)

- [ ] Add `spec_checksum: str = ""` field to `FlowState` dataclass (~line 112)
- [ ] New function `compute_spec_checksum(flow_def: FlowDefinition) -> str`: deterministically serialize the `FlowDefinition` (sorted step IDs, sorted fields), SHA-256 hash. This checksums the parsed structure, not raw text, so whitespace/comment changes don't cause false positives
- [ ] Populate `spec_checksum` when creating `FlowState` (caller passes it in or it's set immediately after construction)

### Task 2: Integrity check in stratum_step_done

**File:** `stratum-mcp/src/stratum_mcp/executor.py` (existing)

- [ ] New function `verify_spec_integrity(flow_def: FlowDefinition, state: FlowState) -> dict | None`: recompute `compute_spec_checksum(flow_def)`, compare with `state.spec_checksum`. Return error dict on mismatch, `None` on success
- [ ] Call `verify_spec_integrity()` at the top of `compute_next_dispatch()` (~line 181), before any state mutation. On mismatch return `{"status": "spec_modified", "error": "Flow definition was modified during execution. Revert changes and retry.", "expected_checksum": state.spec_checksum, "actual_checksum": computed}`
- [ ] This automatically guards both `stratum_step_done` and `stratum_parallel_done` since both call `compute_next_dispatch()` to advance state

### Task 3: Integrity check in handle_parallel_done

**File:** `stratum-mcp/src/stratum_mcp/executor.py` (existing)

- [ ] Add `verify_spec_integrity()` call at the top of `handle_parallel_done()` (~line 293), before validation logic
- [ ] On mismatch return the same `spec_modified` error envelope as Task 2

### Task 4: Pipeline file integrity in build.js

**File:** `lib/build.js` (existing)

- [ ] After `readFileSync(specPath, 'utf-8')` (~line 267): compute `crypto.createHash('sha256').update(specYaml).digest('hex')`, store as `specFileHash`
- [ ] New function `verifyPipelineIntegrity(specPath, expectedHash)`: re-read pipeline YAML from disk, hash, compare. Throws `StratumError('PIPELINE_MODIFIED', ...)` on mismatch
- [ ] Call `verifyPipelineIntegrity()` before each `stratum.stepDone()` call in the dispatch loop (~line 387+)
- [ ] Call `verifyPipelineIntegrity()` before each `stratum.parallelDone()` call

### Task 5: Gate policy integrity in build.js

**File:** `lib/build.js` (existing)

- [ ] After loading `settings.json` (~line 279): compute `crypto.createHash('sha256').update(JSON.stringify(policySettings.policies ?? {})).digest('hex')`, store as `policyHash`
- [ ] New function `verifyPolicyIntegrity(settingsPath, expectedHash)`: re-read `settings.json`, extract `.policies`, hash, compare. Throws `StratumError('POLICY_MODIFIED', ...)` on mismatch
- [ ] Call `verifyPolicyIntegrity()` before gate resolution steps (when `response.status === 'await_gate'`)

### Task 6: Tests

**File:** `stratum-mcp/tests/invariants/test_spec_integrity.py` (new)

- [ ] Test: `FlowState` created with `spec_checksum` populated and non-empty
- [ ] Test: `verify_spec_integrity` passes when `FlowDefinition` is unmodified
- [ ] Test: `verify_spec_integrity` returns `spec_modified` error when a step's `intent` is mutated
- [ ] Test: `verify_spec_integrity` returns `spec_modified` error when a step's `ensure` list is mutated
- [ ] Test: `handle_parallel_done` returns `spec_modified` when flow_def is tampered
- [ ] Test: backward compat — `FlowState` without `spec_checksum` field (empty string default) does not block execution

**File:** `test/build-integrity.test.js` (new)

- [ ] Test: `verifyPipelineIntegrity` passes with unchanged file
- [ ] Test: `verifyPipelineIntegrity` throws when file content differs
- [ ] Test: `verifyPolicyIntegrity` passes with unchanged settings
- [ ] Test: `verifyPolicyIntegrity` throws when policy fields change
- [ ] Test: missing `settings.json` at verify time does not crash (graceful degradation — file may not exist)
