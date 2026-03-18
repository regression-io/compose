# Item 23: Policy Enforcement Runtime — Design Plan

## Related Documents

- [ROADMAP.md](../../ROADMAP.md) — Item 23 definition
- [Lifecycle Engine Roadmap](../../plans/2026-02-15-lifecycle-engine-roadmap.md) — Layer 3 detail
- Downstream: Item 24 (Gate UI) depends on policyMode field added here

## Problem

Settings define per-phase policy modes (`gate`, `flag`, `skip`) but nothing enforces them. `build.js` always creates a gate and waits for human resolution regardless of the configured policy. The policy system is data without behavior.

## Current State

**What exists:**
- `SettingsStore` reads/writes policy modes per phase (`settings.json`)
- Default policies defined in `SETTINGS_DEFAULTS` (vision-server.js:27-38)
- Gate data model in `VisionStore` (id, itemId, flowId, stepId, status, outcome)
- Gate REST API (list, get, resolve) with WebSocket broadcasts
- `build.js:455-533` handles `await_gate` — always creates gate, always waits
- `resolveGate` hardcodes `resolvedBy: 'human'`

**What's missing:**
- No code evaluates the policy before creating/waiting on a gate
- No `flag` handler (auto-approve + notify)
- No `skip` handler (silent pass-through)
- No `policyMode` field on gate records
- No `resolvedBy` distinction (human vs system)

## Design

### New module: `server/policy-evaluator.js`

Pure function, no state, no side effects. Testable in isolation.

```js
// server/policy-evaluator.js

/**
 * Evaluate the policy for a phase transition.
 *
 * @param {object} settings — merged settings from SettingsStore.get()
 * @param {string} stepId   — the Stratum step ID (often matches phase name)
 * @param {object} [opts]
 * @param {string} [opts.fromPhase] — source phase
 * @param {string} [opts.toPhase]   — target phase (used for policy lookup)
 * @param {string} [opts.featureOverride] — per-feature policy override (future)
 * @returns {{ mode: 'gate'|'flag'|'skip'|null, reason: string }}
 */
export function evaluatePolicy(settings, stepId, opts = {}) {
  const phase = opts.toPhase ?? stepId;

  // Future: check opts.featureOverride first (item 23 V2)

  const mode = settings.policies?.[phase] ?? null;

  if (mode === null) {
    // No policy configured — default to gate (safe default)
    return { mode: 'gate', reason: `no policy configured for phase '${phase}', defaulting to gate` };
  }

  return { mode, reason: `phase '${phase}' policy is '${mode}'` };
}
```

### Integration point: `lib/build.js`

Modify the `await_gate` handler (line 455) to evaluate policy before creating/waiting:

```
} else if (response.status === 'await_gate') {
    const policy = evaluatePolicy(settings, stepId, {
      fromPhase: response.from_phase,
      toPhase: response.to_phase,
    });

    if (policy.mode === 'skip') {
      // Silent pass-through — no gate created, no UI notification
      response = await stratum.gateResolve(flowId, stepId, 'approve', policy.reason, 'policy:skip');
      streamWriter.write({ type: 'build_gate_resolved', stepId, outcome: 'approve', rationale: policy.reason, flowId, policyMode: 'skip' });

    } else if (policy.mode === 'flag') {
      // Auto-approve — no gate record (avoids pointless create+resolve write).
      // Stream event provides audit trail; UI sees the flag in the build log.
      console.log(`  Gate auto-approved (policy: flag) — ${policy.reason}`);
      response = await stratum.gateResolve(flowId, stepId, 'approve', policy.reason, 'policy:flag');
      streamWriter.write({ type: 'build_gate_resolved', stepId, outcome: 'approve', rationale: policy.reason, flowId, policyMode: 'flag' });

    } else {
      // mode === 'gate' — existing behavior (human approval required)
      // ... current code unchanged, but add policyMode: 'gate' to gate record
    }
}
```

### Gate record changes: `server/vision-store.js`

Add `policyMode` to gate creation. For `resolvedBy`, thread it through the
existing positional API rather than changing the signature (avoids breaking
all callers).

```diff
  createGate(gate) {
+   gate.policyMode = gate.policyMode ?? 'gate';
    this.gates.set(gate.id, gate);
    ...
  }

- resolveGate(gateId, { outcome, comment }) {
+ resolveGate(gateId, { outcome, comment, resolvedBy } = {}) {
    ...
    gate.status = 'resolved';
    gate.outcome = outcome;
    gate.resolvedAt = new Date().toISOString();
-   gate.resolvedBy = 'human';
+   gate.resolvedBy = resolvedBy ?? 'human';
    gate.comment = comment || null;
    ...
  }
```

**Note:** VisionStore.resolveGate already takes `{ outcome, comment }` as an
object. We add `resolvedBy` to the same object — no signature break.

VisionWriter.resolveGate (positional: `gateId, outcome, comment`) is the
caller that differs. Add optional 4th param `resolvedBy`:

```diff
- async resolveGate(gateId, outcome, comment) {
+ async resolveGate(gateId, outcome, comment, resolvedBy) {
    if (await this._serverAvailable()) {
-     return this._restResolveGate(gateId, outcome, comment);
+     return this._restResolveGate(gateId, outcome, comment, resolvedBy);
    }
-   return this._directResolveGate(gateId, outcome, comment);
+   return this._directResolveGate(gateId, outcome, comment, resolvedBy);
  }
```

Existing callers pass 2-3 args (`gateId, outcome` or `gateId, outcome, comment`).
Adding an optional 4th is backward-compatible. REST route and _directResolveGate
thread `resolvedBy` through to VisionStore.resolveGate.

### Settings access in build.js

`build.js` needs settings to evaluate policy. The callers:
- `bin/compose.js:902` — CLI entry point, no VisionServer access
- `lib/build-all.js:132` — batch builds
- `server/compose-mcp-tools.js` — MCP entry, has VisionServer

**Decision: Option B (lazy-load from disk).** `build.js` already reads
`.compose/data/` for other state. Read `settings.json` once at build start,
same pattern as `loadActiveBuild`. This works for all callers without
threading opts through 3 call sites.

```js
// At build start, inside runBuild():
const settingsPath = path.join(dataDir, 'settings.json');
let settings = { policies: {} };
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
} catch { /* use empty defaults — evaluatePolicy defaults to gate */ }
```

If settings file doesn't exist, `evaluatePolicy` gets empty policies and
defaults every gate to `mode: 'gate'` (safe fallback, same as current behavior).

### Phase name mapping (step ID → policy key)

Stratum `await_gate` responses include `to_phase` (e.g. `"blueprint"`,
`"execute"`). These map directly to `SETTINGS_DEFAULTS.phases[].id` keys.

`evaluatePolicy` uses `opts.toPhase ?? stepId` — so if Stratum provides
`to_phase`, it takes precedence. If not, `stepId` is the fallback. Both are
valid policy keys. If neither matches a configured phase, `mode` is `null` →
defaults to gate.

### null policy semantics

`explore_design` has `defaultPolicy: null` in SETTINGS_DEFAULTS. This means
"no enforcement" — the phase doesn't have gates in Stratum, so `await_gate`
is never emitted for it. The null→gate fallback in evaluatePolicy is a safety
net that should never trigger in practice. If it does, gating is the safe choice.

### Build stream event shape

Add `policyMode` to gate events so the UI can distinguish:

```js
// build_gate — only emitted for mode='gate' (human approval)
{ type: 'build_gate', stepId, flowId, gateType, policyMode: 'gate' }

// build_gate_resolved — emitted for all modes
{ type: 'build_gate_resolved', stepId, outcome, rationale, flowId, policyMode: 'gate'|'flag'|'skip' }
```

## Acceptance Criteria

- [ ] `evaluatePolicy(settings, stepId, opts)` returns correct mode for each phase
- [ ] `policy='skip'` → no gate created, silent auto-approve, Stratum advances
- [ ] `policy='flag'` → no gate created, auto-approve, stream event emitted, Stratum advances
- [ ] `policy='gate'` → existing behavior (human approval required)
- [ ] `policy=null` → defaults to gate (safe default)
- [ ] Gate records include `policyMode` field (set at creation, 'gate' for human gates)
- [ ] VisionWriter.resolveGate accepts optional `resolvedBy` (4th param, backward-compatible)
- [ ] Build stream events include `policyMode` on `build_gate_resolved`
- [ ] Settings loaded from disk at build start (no caller threading needed)

### Test case table: `evaluatePolicy`

| # | policies config | stepId | toPhase | expected mode | reason |
|---|----------------|--------|---------|---------------|--------|
| 1 | `{ blueprint: 'gate' }` | `review` | `blueprint` | `gate` | toPhase lookup |
| 2 | `{ execute: 'flag' }` | `execute` | `undefined` | `flag` | stepId fallback |
| 3 | `{ prd: 'skip' }` | `prd` | `prd` | `skip` | explicit skip |
| 4 | `{}` (empty) | `blueprint` | `blueprint` | `gate` | null→gate default |
| 5 | `{ ship: 'gate' }` | `unknown` | `undefined` | `gate` | unknown→gate default |
| 6 | `{ execute: 'flag' }` | `execute` | `ship` | `gate` | toPhase overrides stepId |

### Test case table: build integration

| # | policy mode | gate created? | stratum advanced? | stream event? |
|---|-------------|--------------|-------------------|---------------|
| 1 | `gate` | yes | after human resolve | `build_gate` + `build_gate_resolved` |
| 2 | `flag` | no | immediately | `build_gate_resolved` with `policyMode:'flag'` |
| 3 | `skip` | no | immediately | `build_gate_resolved` with `policyMode:'skip'` |
| 4 | missing settings file | yes (gate default) | after human resolve | same as gate |

## Files Modified

| File | Action |
|------|--------|
| `server/policy-evaluator.js` | CREATE — evaluatePolicy pure function |
| `server/vision-store.js` | MODIFY — policyMode on createGate, resolvedBy on resolveGate |
| `lib/vision-writer.js` | MODIFY — add optional resolvedBy 4th param (backward-compatible) |
| `lib/build.js` | MODIFY — load settings, evaluate policy before gate handling |
| `test/policy-evaluator.test.js` | CREATE — unit tests (6 scenarios) |
| `test/build-policy.test.js` | CREATE — integration tests (4 scenarios) |

## Out of Scope (deferred)

- **Feature-level policy overrides** — evaluatePolicy accepts `featureOverride` param but V1 doesn't populate it. Deferred to Item 23 V2 or Item 24.
- **Settings UI** — editing policies in the Vision Surface. Deferred to Item 24 (Gate UI).
- **Policy audit dashboard** — visual breakdown of gate/flag/skip decisions. Deferred to Item 24.

## Risks

- **Stratum `await_gate` bypass** — When mode is `skip` or `flag`, we call `gateResolve` without waiting. Stratum accepts this (gateResolve just advances the flow regardless of how the decision was made).
- **Settings file missing** — If `.compose/data/settings.json` doesn't exist (fresh project), evaluatePolicy gets empty policies → all gates default to `mode: 'gate'`. Same as current behavior. No regression.
- **Existing gate tests** — Adding `policyMode` to gate records is additive. `resolvedBy` field already exists but was hardcoded. Tests that assert `resolvedBy: 'human'` still pass since that's the default. VisionWriter's new 4th param is optional — existing 2-3 arg calls are unchanged.
- **Concurrent settings change** — Settings loaded once at build start. If user changes policy mid-build, the build uses the snapshot. Acceptable for V1 — builds are short-lived.

## Review Findings Addressed

Per Codex review (2026-03-17):

| Finding | Severity | Resolution |
|---------|----------|------------|
| resolveGate signature break | P1 | Keep VisionStore object API, add `resolvedBy` to existing object. VisionWriter gets optional 4th positional param — backward-compatible. |
| Settings not available in build | P1 | Lazy-load from disk at build start (Option B). Works for all callers. |
| toPhase derivation ambiguous | P1 | Stratum `to_phase` maps directly to SETTINGS_DEFAULTS phase IDs. Documented in plan. |
| explore_design null policy | P1 | Documented: null means "no enforcement" — phase has no gates in Stratum. Fallback to gate is safety net only. |
| Flag gate creation overhead | P2 | Removed — flag mode skips gate creation, only emits stream event for audit. |
| Test gaps | P2 | Added test case tables for both evaluatePolicy (6 cases) and build integration (4 cases). |
