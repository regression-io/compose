# COMP-OBS-SURFACE: Implementation Plan

## Related Documents

- [Design](design.md)
- [Blueprint](blueprint.md)

## Tasks

### Phase 1: Independent foundations (parallelizable)

- [ ] **S1: Fix build.js emission sites** — `lib/build.js` (existing). Test: `test/build-emission.test.js` (new). Site 1 (line ~527): read `readActiveBuild(dataDir)` for actual retries/violations. Sites 2-4 (lines ~1038, ~1359, ~1503): add `retries: 0, violations: []` defaults.
- [ ] **S2: Create ViolationDetail.jsx** — `src/components/agent/ViolationDetail.jsx` (new). Test: `test/violation-detail.test.js` (new). Renders nothing when empty, collapsed "violations (N)" header, expanded amber list.
- [ ] **S3: Add verbose toggle to AgentStream** — `src/components/AgentStream.jsx` (existing, line 227). Test: `test/verbose-stream.test.js` (new). Module-scoped `_state.verboseStream`, export getter/setter, localStorage persist, conditional filter.

### Phase 2: First dependents

- [ ] **S4: Create StepOutcome.jsx** — `src/components/agent/StepOutcome.jsx` (new). Test: `test/step-outcome.test.js` (new). Stream mode: step text + retry badge + checks label + ViolationDetail. Strip mode: retry pill only. Depends on S2.
- [ ] **S5: Create VerboseToggle.jsx** — `src/components/agent/VerboseToggle.jsx` (new). Test: `test/verbose-toggle.test.js` (new). `{ }` icon button, reads/writes AgentStream module state. Depends on S3.
- [ ] **S6: Add retries to opsStripLogic** — `src/components/cockpit/opsStripLogic.js` (existing, line 22-27). Test: extend `test/ops-strip.test.js`. Add `retries: activeBuild.retries ?? 0`. Depends on S1.

### Phase 3: Integration wiring

- [ ] **S7: Wire StepOutcome into MessageCard** — `src/components/agent/MessageCard.jsx` (existing, lines 221-227). Replace build_step_done one-liner with `<StepOutcome>`. Add verbose message rendering. Depends on S4.
- [ ] **S8: Wire VerboseToggle into AgentBar** — `src/components/cockpit/AgentBar.jsx` (existing, between lines 124-126). Insert `<VerboseToggle />`. Depends on S5.
- [ ] **S9: Add retry pill to OpsStripEntry** — `src/components/cockpit/OpsStripEntry.jsx` (existing, props line 45, render after line 96). Add `retries` prop, amber pill. Depends on S6.
- [ ] **S10: Wire retries through OpsStrip** — `src/components/cockpit/OpsStrip.jsx` (existing, lines 158-167). Pass `retries={entry.retries}`. Depends on S6, S9.

## Dependency Graph

```
[S1, S2, S3]  ← parallel
     |
[S4, S5, S6]  ← parallel
     |
[S7, S8, S9]  ← parallel
     |
    S10
```

## Verification

1. `node --test` — all tests pass
2. `npm run build` — clean build
3. Manual: `npm run dev` from compose root → trigger build with retries → retry badge in ops strip + message stream → expand violations → toggle verbose on/off
