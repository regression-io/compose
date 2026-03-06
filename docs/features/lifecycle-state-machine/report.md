# L1 Implementation Report: Feature Lifecycle State Machine

## Summary

Formalized the existing lifecycle state machine as a contract-driven system. A single JSON contract (`contracts/lifecycle.json`) is now the source of truth for all lifecycle constants, transitions, policies, and artifacts. All runtime code derives from the contract — no hardcoded lifecycle definitions remain.

## Delivered vs Planned

| Planned | Delivered | Notes |
|---------|-----------|-------|
| `contracts/lifecycle.json` as single source of truth | Yes | 10 phases, transitions, terminal states, policies, iteration defaults |
| `lifecycle-constants.js` derives from contract | Yes | Thin derivation layer, all existing import paths preserved |
| `policy-engine.js` imports from constants | Yes | Uses `CONTRACT.policyModes` instead of hardcoded array |
| Stratum spec generated from contract | Yes | `scripts/generate-stratum-spec.mjs` → `pipelines/compose_feature.stratum.yaml` |
| Contract validation tests | Yes | 28 tests: schema, derivation parity, policy re-exports, Stratum parity |
| Revision edges modeled in Stratum | Yes | Compound steps with retries (e.g., `blueprint_and_verification`) |

## Architecture Deviations

None. The design called for a contract file, derived constants, and generated Stratum spec — all delivered as specified.

## Key Implementation Decisions

1. **Synchronous contract loading**: `lifecycle-constants.js` uses `readFileSync` at import time. The contract is a static file that never changes at runtime, so synchronous loading is appropriate and avoids async initialization complexity.

2. **Compound steps for revision edges**: Stratum flows are DAGs — they cannot have circular `depends_on`. Revision edges (e.g., `verification → blueprint`) are modeled as compound steps (`blueprint_and_verification`) with `retries: 3`, matching the existing `review-fix.stratum.yaml` pattern.

3. **Skip paths preserved in depends_on**: The generator uses the earliest forward predecessor from the contract's transition graph, preserving skip paths. For example, `prd`, `architecture`, and `blueprint_and_verification` all depend on `explore_design` (not on each other), matching the contract's skip-path topology.

4. **Entry phase gets explicit gate policy**: `explore_design` was changed from `defaultPolicy: null` to `defaultPolicy: "gate"` during review. The null policy caused `evaluatePolicy('explore_design')` to silently return `'skip'` — semantically wrong for a non-skippable entry phase.

## Test Coverage

| Test File | Tests | What It Covers |
|-----------|-------|----------------|
| `test/lifecycle-contract.test.js` | 28 | Contract schema (9), derivation parity (9), policy re-exports (4), Stratum parity (5), non-null policy invariant (1) |
| `test/policy-engine.test.js` | 8 | DEFAULT_POLICIES shape, evaluatePolicy defaults + overrides + errors, explore_design gate |

Existing test suites (`lifecycle-manager.test.js`, `lifecycle-routes.test.js`) updated to accommodate the contract-derived constants. Full suite: 335 tests, 0 failures.

## Files Changed

### New
- `contracts/lifecycle.json` — single source of truth for the lifecycle state machine
- `scripts/generate-stratum-spec.mjs` — generates Stratum YAML from contract
- `test/lifecycle-contract.test.js` — contract validation and parity tests

### Modified
- `server/lifecycle-constants.js` — rewritten to derive all exports from contract
- `server/policy-engine.js` — imports from lifecycle-constants, validates against contract policyModes
- `pipelines/compose_feature.stratum.yaml` — regenerated from contract (now includes compound steps)
- `test/policy-engine.test.js` — updated for 10-entry DEFAULT_POLICIES and explore_design gate
- `test/lifecycle-manager.test.js` — bypassPolicy helper includes explore_design

## Known Issues & Tech Debt

1. **Substring fragility in test**: The compound step test uses segment-exact matching (`split('_and_')`) which is robust, but the `_and_` separator convention is implicit — not enforced by the generator or documented in the contract.

2. **No contract versioning enforcement**: The contract has a `version` field but nothing validates that consumers are compatible with the version they load.

## Lessons Learned

1. **Revision edges need explicit modeling**: The initial generator dropped back-edges entirely. Stratum's DAG constraint means revision loops must be modeled as compound steps with retries — this pattern was already established in `review-fix.stratum.yaml` but wasn't obvious until the test caught it.

2. **Null policies are semantic traps**: A `defaultPolicy: null` that silently falls back to `'skip'` via `??` chaining is invisible until a test explicitly checks the entry phase. Every phase should have an explicit policy.

3. **Contract tests catch derivation drift**: The parity tests caught real bugs — the Stratum generator's skip-path topology and compound step modeling were both wrong in early iterations. The contract-test-generator triangle provides strong guarantees.
