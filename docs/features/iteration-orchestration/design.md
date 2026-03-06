# Iteration Orchestration (L6): Design

**Status:** DESIGN
**Date:** 2026-03-06
**Roadmap item:** 27 (Phase 6, L6)

## Related Documents

- [Lifecycle Engine Roadmap](../../plans/2026-02-15-lifecycle-engine-roadmap.md) — Layer 6 context
- [Policy Enforcement Design](../policy-enforcement/design.md) — L3 (dependency, COMPLETE)
- [Gate UI Design](../gate-ui/design.md) — L4 (dependency, COMPLETE)
- [Compose Skill](../../../.claude/skills/compose/SKILL.md) — Phase 7 steps 3-4 define current loops
- [review-fix.stratum.yaml](../../../pipelines/review-fix.stratum.yaml) — existing Stratum loop primitive

---

## Problem

Phase 7 of the compose lifecycle has four exit steps: execute tasks, E2E smoke test, review loop, and coverage sweep. Today, the review and coverage loops are prompt instructions in SKILL.md — the agent is told to "loop until REVIEW CLEAN" and "loop until TESTS PASSING" with max iteration caps. There is no enforcement:

1. **No server-side tracking.** Compose doesn't know an iteration loop is running, what iteration it's on, or whether exit criteria were met.
2. **No structured exit signal.** Completion is detected by scanning for text strings (`REVIEW CLEAN`, `TESTS PASSING`) in agent output. Text strings can be hallucinated, omitted, or misinterpreted.
3. **No max-iteration enforcement.** The cap (10 for review, 15 for coverage) is a prompt instruction the agent can ignore.
4. **No visibility.** The Vision Surface shows no loop progress. The human can't see "review loop: iteration 4/10, 3 findings remaining."
5. **No lifecycle integration.** The loops aren't tracked in the lifecycle's phase history. Session summaries don't know a loop is running.

Meanwhile, `review-fix.stratum.yaml` already solves the review loop correctly: `agent_run` with structured JSON schema (`{ clean: boolean, findings: [] }`), `ensure: result.clean == true`, `retries: 10`. But this pipeline is standalone — it's not wired to the lifecycle manager and produces no visibility events.

## Goal

Make iteration loops a Compose-managed primitive. Compose tracks loop state, enforces max iterations, requires structured exit signals, and broadcasts progress to the Vision Surface. The agent reports iteration results via MCP tools, not text strings.

---

## Decisions

### D1: Iteration state lives in the lifecycle object

**Why:** The lifecycle object (`item.lifecycle`) already tracks `currentPhase`, `phaseHistory`, `pendingGate`, and `policyLog`. Iteration is a sub-phase concern within `execute`. Adding `iterationState` to the lifecycle object keeps all lifecycle data in one place, persisted atomically via `store.updateLifecycle()`.

**Shape:**

```js
iterationState: null | {
  loopType: 'review' | 'coverage',
  loopId: 'iter-<uuid>',
  phase: 'execute',
  count: 0,
  maxIterations: 10 | 15,
  exitCriteria: 'result.clean == true' | 'result.passing == true',
  startedAt: ISO,
  completedAt: null | ISO,
  outcome: null | 'clean' | 'max_reached' | 'aborted',
  iterations: [
    { n: 1, startedAt, completedAt, result: { clean, findings?, ... } }
  ],
}
```

**Constraint:** Only one loop can be active at a time (review runs before coverage). This matches the single-slot `pendingGate` pattern. No parallel loop support needed.

### D2: Agents signal completion via MCP tools, not text

**Why:** The current text-string approach (`REVIEW CLEAN`, `TESTS PASSING`) is unreliable. The `review-fix.stratum.yaml` pipeline already proves the structured approach works: `agent_run` with a JSON schema returns `{ clean: boolean, findings: [] }`.

**New MCP tools:**

- `start_iteration_loop` — agent declares it's entering a loop (review or coverage). Compose creates the `iterationState`, broadcasts `iterationStarted`.
- `report_iteration_result` — agent reports one iteration's result as structured JSON. Compose validates against exit criteria, increments counter, broadcasts `iterationUpdate`, and returns whether to continue or stop.
- `get_iteration_status` — agent reads current loop state (iteration count, max, last result).

**Exit criteria evaluation:**

- Review loop: `result.clean === true`
- Coverage loop: `result.passing === true`

Compose evaluates, not the agent. The agent reports; Compose decides.

### D3: Max iteration enforcement is server-side

**Why:** If the agent controls the counter, it can reset or ignore it. The lifecycle manager owns the counter and refuses to accept more iteration reports after max is reached.

**Behavior when max reached:**

1. `iterationState.outcome = 'max_reached'`
2. Broadcast `iterationLimitReached` — this is the "problem is in the spec" signal from SKILL.md
3. The loop does NOT auto-gate. Instead, the `iterationState` stays on the lifecycle with `outcome: 'max_reached'`, and the agent is told to surface this to the human.
4. The agent can then call `start_iteration_loop` again (with human approval context) to retry, or the human can intervene via the Gate UI.

### D4: Iteration events broadcast to Vision Surface

**New WS message types:**

| Type | When | Payload |
|------|------|---------|
| `iterationStarted` | Agent starts a loop | `{ itemId, loopId, loopType, phase, maxIterations, timestamp }` |
| `iterationUpdate` | Agent reports one iteration | `{ itemId, loopId, count, maxIterations, exitCriteriaMet, findingsCount, timestamp }` |
| `iterationComplete` | Loop exits (clean or max) | `{ itemId, loopId, outcome, finalCount, timestamp }` |

These flow through `broadcastMessage()` like all other WS messages. The client can render loop progress in the agent panel or a dedicated iteration indicator.

### D5: No new UI components in this feature

**Why:** L4 (Gate UI) just shipped. The iteration events will be surfaced in the existing agent activity panel as activity entries. A dedicated "iteration progress bar" or "loop dashboard" is a follow-up concern. The data flows first; the UI follows.

What the client does with iteration messages:
- `iterationStarted` → shows in agent activity feed: "Review loop started (0/10)"
- `iterationUpdate` → shows in agent activity feed: "Review iteration 3/10: 2 findings"
- `iterationComplete` → shows in agent activity feed: "Review loop complete (clean after 4 iterations)"

This requires no new components — just new message type handling in `visionMessageHandler.js`, rendered through the existing `AgentPanel`.

### D6: Coverage sweep gets a Stratum pipeline

**Why:** `review-fix.stratum.yaml` exists for the review loop but there's no equivalent for coverage. To make both loops structurally identical, create `coverage-sweep.stratum.yaml` with the same pattern: `agent_run` with schema, `ensure: result.passing == true`, `retries: 15`.

**Contract:**

```yaml
CoverageResult:
  passing: {type: boolean}
  summary: {type: string}
  failures: {type: array}
```

### D7: Lifecycle manager integration, not Stratum delegation

**Why:** The exploration revealed two paths: (a) let Stratum own the loop via `retries:` + `ensure:`, (b) let the lifecycle manager own the loop with Compose-native iteration tracking.

Path (a) is simpler but invisible — Stratum runs the loop internally and Compose only sees the final result. No per-iteration visibility, no lifecycle state, no WS broadcasts.

Path (b) gives Compose full control: per-iteration state, WS broadcasts, max-iteration enforcement, lifecycle integration. The MCP tools (`start_iteration_loop`, `report_iteration_result`) are the Compose-native loop control surface.

**Decision:** Path (b). The Stratum pipelines remain useful as templates for how the agent structures each iteration, but Compose — not Stratum — owns the loop counter and exit criteria evaluation.

---

## Scope

### In scope

- `iterationState` field on lifecycle object
- 3 new MCP tools: `start_iteration_loop`, `report_iteration_result`, `get_iteration_status`
- 3 new REST endpoints mirroring the MCP tools
- 3 new WS message types for iteration events
- Server-side max iteration enforcement
- Client handling of iteration messages in `visionMessageHandler.js` (activity feed integration)
- `coverage-sweep.stratum.yaml` pipeline definition
- Tests for lifecycle manager iteration methods, REST routes, and WS handler

### Out of scope

- Dedicated iteration UI components (follow-up)
- Automatic dispatch of review/coverage agents (agent decides when to call the tools)
- Modification of the `review-fix.stratum.yaml` pipeline (it continues to work standalone)
- Per-iteration gating (human approval per iteration — possible via policy overrides but not default)
- Backward phase transitions for loops (the loop happens within a phase, not across phases)

---

## Architecture

```
Agent (Claude Code)
  ↓ calls MCP tool
compose-mcp.js → compose-mcp-tools.js
  ↓ HTTP POST
vision-routes.js → lifecycle-manager.js
  ↓ updates lifecycle object
vision-store.js → data/vision-state.json
  ↓ broadcasts
vision-server.js → WS clients
  ↓ handled by
visionMessageHandler.js → AgentPanel (activity feed)
```

This is the exact same data flow as gates (L3/L4). No new infrastructure.

---

## File Impact

| File | Change |
|------|--------|
| `server/lifecycle-manager.js` | Add `startIterationLoop`, `reportIterationResult`, `getIterationStatus` methods |
| `server/lifecycle-constants.js` | Add `ITERATION_DEFAULTS` (max iterations per loop type) |
| `server/vision-routes.js` | Add 3 iteration REST endpoints + WS broadcasts |
| `server/compose-mcp-tools.js` | Add 3 tool implementations |
| `server/compose-mcp.js` | Register 3 new tools in TOOLS array + switch cases |
| `src/components/vision/visionMessageHandler.js` | Handle `iterationStarted`, `iterationUpdate`, `iterationComplete` messages |
| `src/components/vision/AgentPanel.jsx` | Render iteration activity entries (minor — follows existing activity pattern) |
| `pipelines/coverage-sweep.stratum.yaml` | New pipeline definition |
| `test/iteration-*.test.js` | Tests for lifecycle methods, routes, and client handler |

---

## Open Questions

None — all key decisions resolved above. The design deliberately avoids UI complexity (D5) and backward phase transitions (scope exclusion) to keep the feature focused on the server-side primitive.
