# STRAT-COMP-3: Implementation Plan

**Design:** `docs/features/STRAT-COMP-3/design.md`

---

## Task 1: Create `.compose/compose.json`

**File:** `.compose/compose.json` (new)

Create the manifest file that `build.js:106` requires. The `.compose/` directory already exists with `breadcrumbs.log` and `data/`.

```json
{
  "version": "1.0",
  "capabilities": { "stratum": true },
  "paths": { "docs": "docs", "features": "docs/features" }
}
```

**Acceptance:**
- [ ] `build.js` no longer throws "No .compose/compose.json found"
- [ ] Existing `.compose/breadcrumbs.log` and `.compose/data/` are untouched

---

## Task 2: Add stratum-mcp availability guard

**File:** `lib/stratum-mcp-client.js` (existing, line 39-57)

Add a pre-flight check in `connect()` before spawning the subprocess. Use `execFileSync('which', ['stratum-mcp'])` (or `command -v` on the shell) to verify the binary is on `$PATH`. Throw a clear error if not found.

```js
// In connect(), before creating transport:
import { execFileSync } from 'node:child_process';

const binary = opts.command ?? 'stratum-mcp';
if (binary === 'stratum-mcp') {  // only check default, not test overrides
  try {
    execFileSync('which', [binary], { stdio: 'pipe', timeout: 3000 });
  } catch {
    throw new Error(
      'stratum-mcp not found on $PATH. Install with: pip install stratum-mcp'
    );
  }
}
```

**Test:** `test/stratum-mcp-client.test.js` (existing) — add test that a bad command override throws.

**Acceptance:**
- [ ] `connect()` with default binary throws clear message when `stratum-mcp` is not on `$PATH`
- [ ] `connect({ command: 'custom-binary' })` skips the guard (test harness path)
- [ ] Existing tests still pass

---

## Task 3: Remove dead `skipped` dispatch branch

**File:** `lib/build.js` (existing, lines 229-235)

Verified: stratum-mcp auto-advances past skipped steps and never sends a `skipped` dispatch status to the client. The `skipped` branch in the dispatch loop is dead code. Same for `executeChildFlow` lines 356-361.

Remove both `skipped` branches. Skipped steps appear in the audit trace but never as dispatches.

**Acceptance:**
- [ ] `skipped` branches removed from both `runBuild` dispatch loop and `executeChildFlow`
- [ ] Integration tests with `skip_if` steps still pass (stratum handles skips internally)
- [ ] 315 existing tests still pass

---

## Task 4: Write proof-run integration test

**File:** `test/proof-run.test.js` (new)

Write an integration test that validates the full 12-step `pipelines/build.stratum.yaml` spec with mock connectors. This is the dry run — validates dispatch loop plumbing without API credits.

Uses the existing `build-integration.test.js` pattern:
- `setupProject()` creates temp dir with `.compose/compose.json` and the real `build.stratum.yaml` spec
- `mockConnectorFactory()` returns canned responses matching each step's `output_contract`
- Gate steps use `gateOpts` with piped streams to auto-approve (write `"a\nLGTM\n"` to stdin)
- Sub-flows (`review_fix`, `coverage_sweep`) get contract-matching responses

**Verified behaviors:**
- [ ] All non-skipped steps dispatch in correct order
- [ ] `prd`, `architecture`, `report` are auto-skipped (appear in trace, not dispatched)
- [ ] `design_gate`, `plan_gate`, `ship_gate` prompt and resolve with `approve`
- [ ] `review_fix` sub-flow dispatches review (codex) and fix (claude) steps
- [ ] `coverage_sweep` sub-flow dispatches run_tests and fix_tests steps
- [ ] `audit.json` written with `status: complete` and trace array
- [ ] Vision state: feature item status is `complete`, gates are resolved with `approve`
- [ ] `active-build.json` cleaned up

**Acceptance:**
- [ ] `npm test` passes with new test (316+ tests, 0 fail)
- [ ] Test skips cleanly if stratum-mcp not installed

---

## Task 5: Run `npm test` — full regression

After tasks 1-4, run the full test suite to confirm no regressions.

**Acceptance:**
- [ ] 316+ tests pass, 0 fail
- [ ] No new skips introduced

---

## Task 6: Live proof run (manual, gated)

**Not automated.** This is the Milestone 3 gate — requires human at the terminal and API credentials.

```bash
node bin/compose.js build STRAT-1
```

Authentication uses `@anthropic-ai/claude-agent-sdk` with OAuth (`/login`), not API keys.

**Validation checklist** (from design.md):
- [ ] `docs/features/STRAT-1/audit.json` exists with complete trace
- [ ] Trace includes all step outcomes (skipped, executed, gated)
- [ ] `.compose/data/vision-state.json` has STRAT-1 item with status `complete`
- [ ] All gates resolved with `approve` outcome
- [ ] Sub-flow traces nested inside parent steps
- [ ] 316+ tests still pass
- [ ] No manual intervention beyond gate approvals

**Codex prerequisite:** The spec hardcodes `agent: codex` for review. Either configure Codex credentials or edit `build.stratum.yaml` line 53 to use `agent: claude` before the run.

---

## Dependency Graph

```
Task 1 (compose.json) ──┐
Task 2 (guard)        ──┼── Task 4 (proof-run test) ── Task 5 (regression) ── Task 6 (live run)
Task 3 (dead code)    ──┘
```

Tasks 1, 2, 3 are independent and parallelizable. Task 4 depends on all three. Task 5 is the regression gate. Task 6 is manual.
