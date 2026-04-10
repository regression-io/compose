# Session 20: Runtime Capability Violation Detection

**Date:** 2026-04-09
**Feature:** COMP-CAPS-ENFORCE

## What happened

The ask was to make Compose's capability profiles runtime-enforced, not just declared. Prior work (COMP-AGENT-CAPS) defined templates like `read-only-reviewer` with allowed/disallowed tool lists, but nothing actually checked whether agents honored those lists during execution.

Four roadmap items to implement: a normalizer event tap, a violation checker, build-stream audit events, and an enforcement mode setting.

The key architectural decision was where to hook in. The normalizer (`runAndNormalize`) is the single chokepoint through which all connector output flows — every tool_use event surfaces there before anything else sees it. Adding a passive `onToolUse` callback at that layer gave us per-event visibility without altering the event flow at all.

The violation check itself needed to distinguish two cases: explicit deny (tool in `disallowedTools`) counts as `violation`; tool not in `allowedTools` (when that list is non-null) counts as `warning`. Both are flagged as violations to the caller — the severity field lets the stream consumer categorize them.

Enforcement mode lives in settings.json under `capabilities.enforcement` (default: `'log'`). In `'log'` mode, violations are written to the build stream and logged to the console but execution continues. In `'block'` mode, any violation throws a `StratumError('CAPABILITY_VIOLATION', ...)` and halts the step. The enforcement setting is read fresh from disk at each step — this means you can change it without restarting a build (though in practice most builds are short).

## What we built

**New files:**
- `lib/capability-checker.js` — `checkCapabilityViolation(toolName, agentString)` → `{ violation, severity, reason }`
- `test/capability-checker.test.js` — 11 tests covering all template scenarios

**Modified files:**
- `lib/result-normalizer.js` — `runAndNormalize()` accepts `opts.onToolUse` callback; called on every `tool_use` event with `{ tool, input, timestamp }`
- `lib/build.js` — imports `checkCapabilityViolation`; collects `observedTools` per step via `onToolUse`; post-step audit loop writes `capability_violation` events and logs violations; throws `StratumError` in block mode
- `server/settings-store.js` — `capabilities: { enforcement: 'log' }` added to defaults, merged in `get()`, accepted in `update()`, validated in `_validate()`

## What we learned

1. **Passive taps beat middleware.** Adding `onToolUse` as a callback option rather than intercepting the event stream keeps the normalizer's event flow unchanged and makes the feature trivially removable.

2. **Violation vs warning distinction matters for UX.** A tool not in `allowedTools` is suspicious but maybe not catastrophic — a warning lets the audit trail surface it without failing the build by default. A tool in `disallowedTools` is a clear policy breach.

3. **Read enforcement from disk per step.** This allows enforcement mode changes to take effect mid-build if needed, and avoids a stale snapshot problem for long builds.

4. **Test the checker in isolation first.** The 11 tests cover all template states (no template, unrestricted implementer, read-only-reviewer, orchestrator, unknown template) before any build.js wiring is tested. The surface area is small and clean.

## Open threads

- [ ] Test the `block` mode path in an integration context (requires a mock connector that emits tool_use events for disallowed tools)
- [ ] Expose `capabilities.enforcement` in the settings UI panel
- [ ] Consider whether `warning`-severity violations should be counted separately from `violation`-severity in build summary output

The session was four items, eleven tests, one new module, and a clean Vite build — compact work with no structural surprises.
