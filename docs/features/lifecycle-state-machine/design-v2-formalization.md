# Feature Lifecycle State Machine (L1): Formalization Design

**Status:** DESIGN
**Date:** 2026-03-06
**Roadmap item:** 22 (Phase 6, L1)
**Prior work:** [design.md](./design.md) — original L1 implementation (shipped 2026-03-05)

## Related Documents

- [Lifecycle Engine Roadmap](../../plans/2026-02-15-lifecycle-engine-roadmap.md) — Layer 1 context
- [Policy Enforcement Design](../policy-enforcement/design.md) — L3 (COMPLETE)
- [Iteration Orchestration Design](../iteration-orchestration/design.md) — L6 (COMPLETE)

---

## Context

The original L1 shipped the LifecycleManager, REST API, MCP tools, reconciliation, and 306 tests. L2–L6 built on top of it. What remains from the roadmap description are two formalization deliverables:

1. `contracts/lifecycle.json` — a formal, machine-readable contract
2. `compose_feature.stratum.yaml` — a Stratum spec for the 10-phase lifecycle

Plus a bookkeeping item: `phase-state.json` was superseded by centralized `vision-state.json` and needs to be documented.

---

## Decisions

### D1: `contracts/lifecycle.json` is the single source of truth

Create a JSON schema that captures everything currently spread across `lifecycle-constants.js` and `policy-engine.js`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "_source": "L1 — Feature Lifecycle State Machine",
  "_roadmap": "Item 22",
  "version": "1.0.0",
  "phases": [
    {
      "id": "explore_design",
      "label": "Explore & Design",
      "artifact": "design.md",
      "skippable": false,
      "defaultPolicy": null,
      "description": "Entry phase — codebase exploration and design doc"
    },
    {
      "id": "prd",
      "label": "PRD",
      "artifact": "prd.md",
      "skippable": true,
      "defaultPolicy": "skip",
      "description": "Product requirements document"
    },
    {
      "id": "architecture",
      "label": "Architecture",
      "artifact": "architecture.md",
      "skippable": true,
      "defaultPolicy": "skip",
      "description": "Architecture doc with competing proposals"
    },
    {
      "id": "blueprint",
      "label": "Blueprint",
      "artifact": "blueprint.md",
      "skippable": false,
      "defaultPolicy": "gate",
      "description": "Implementation blueprint with file:line references"
    },
    {
      "id": "verification",
      "label": "Blueprint Verification",
      "artifact": null,
      "skippable": false,
      "defaultPolicy": "gate",
      "description": "Verify all blueprint references against actual code"
    },
    {
      "id": "plan",
      "label": "Implementation Plan",
      "artifact": "plan.md",
      "skippable": false,
      "defaultPolicy": "gate",
      "description": "Ordered task list with dependencies"
    },
    {
      "id": "execute",
      "label": "Execute",
      "artifact": null,
      "skippable": false,
      "defaultPolicy": "flag",
      "description": "TDD execution + E2E + review loop + coverage sweep"
    },
    {
      "id": "report",
      "label": "Implementation Report",
      "artifact": "report.md",
      "skippable": true,
      "defaultPolicy": "skip",
      "description": "Post-implementation report"
    },
    {
      "id": "docs",
      "label": "Update Docs",
      "artifact": null,
      "skippable": false,
      "defaultPolicy": "flag",
      "description": "Update CHANGELOG, README, ROADMAP, CLAUDE.md"
    },
    {
      "id": "ship",
      "label": "Ship",
      "artifact": null,
      "skippable": false,
      "defaultPolicy": "gate",
      "description": "Final verification and commit"
    }
  ],
  "transitions": {
    "explore_design": ["prd", "architecture", "blueprint"],
    "prd": ["architecture", "blueprint"],
    "architecture": ["blueprint"],
    "blueprint": ["verification"],
    "verification": ["plan", "blueprint"],
    "plan": ["execute"],
    "execute": ["report", "docs"],
    "report": ["docs"],
    "docs": ["ship"],
    "ship": []
  },
  "terminal": ["complete", "killed"],
  "gateOutcomes": ["approved", "revised", "killed"],
  "policyModes": ["gate", "flag", "skip"],
  "iterationDefaults": {
    "review": { "maxIterations": 10 },
    "coverage": { "maxIterations": 15 }
  }
}
```

### D2: `lifecycle-constants.js` derives from the contract

Rewrite the constants module to read `contracts/lifecycle.json` and export the same shapes all consumers expect. Synchronous `readFileSync` + `JSON.parse`. No consumer changes needed.

The derivation:
- `PHASES` = `contract.phases.map(p => p.id)`
- `TERMINAL` = `new Set(contract.terminal)`
- `SKIPPABLE` = `new Set(contract.phases.filter(p => p.skippable).map(p => p.id))`
- `TRANSITIONS` = `contract.transitions`
- `PHASE_ARTIFACTS` = phases with non-null artifact, keyed by id
- `ITERATION_DEFAULTS` = `contract.iterationDefaults`

Additionally derive and export:
- `DEFAULT_POLICIES` = phases with non-null defaultPolicy, keyed by id

This means `policy-engine.js` can import `DEFAULT_POLICIES` from `lifecycle-constants.js` instead of defining its own copy. One source of truth.

### D3: `compose_feature.stratum.yaml` — generated Stratum spec

A script reads the contract and generates a Stratum spec with the 10 phases as steps. Each phase step has:
- `function` matching the phase id
- `ensure` expressions checking artifact existence (for phases with artifacts)
- `depends_on` reflecting the transition graph

The generated spec is committed. Regenerated on contract changes. A test verifies parity.

### D4: `phase-state.json` formally superseded

Update the roadmap item 22 description to note that per-feature `phase-state.json` was replaced by centralized `data/vision-state.json`. No code changes.

### D5: Contract validation test

A test verifies:
- Contract schema is valid JSON
- All phase IDs match what `lifecycle-constants.js` exports
- Transition targets only reference defined phases
- Skippable phases have appropriate default policies
- Terminal states don't appear in phase list
- Derivation parity: constants module exports match contract content

---

## Scope

### In scope

- `contracts/lifecycle.json` (new)
- `server/lifecycle-constants.js` (rewrite as contract loader)
- `server/policy-engine.js` (import DEFAULT_POLICIES from constants instead of defining locally)
- `pipelines/compose_feature.stratum.yaml` (new, generated)
- `scripts/generate-stratum-spec.js` (new)
- `test/lifecycle-contract.test.js` (new)
- ROADMAP.md update

### Out of scope

- Changes to lifecycle-manager.js, vision-routes.js, compose-mcp-tools.js (already correct)
- UI changes
- Runtime contract reloading

---

## File Impact

| File | Change |
|------|--------|
| `contracts/lifecycle.json` | New — the contract |
| `server/lifecycle-constants.js` | Rewrite — derive from contract |
| `server/policy-engine.js` | Minor — import DEFAULT_POLICIES from constants |
| `pipelines/compose_feature.stratum.yaml` | New — generated |
| `scripts/generate-stratum-spec.js` | New — generator |
| `test/lifecycle-contract.test.js` | New — validation + parity |
| `ROADMAP.md` | Update L1 description + status |

---

## Open Questions

None.
