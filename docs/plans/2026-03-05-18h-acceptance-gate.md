# 18h — Acceptance Gate: End-to-End Pipeline Manual Test

**Status:** MANUAL GATE — requires live inference backends
**Blocks:** Phase 4.5 sign-off
**Pipeline:** `pipelines/review-fix.stratum.yaml`

## Prerequisites

Before running this gate, confirm:

- [ ] `opencode auth login` completed with a ChatGPT subscription (for CodexConnector)
- [ ] `claude` CLI authenticated (`claude --version` exits 0)
- [ ] Compose server running (`npm run dev` or supervisor)
- [ ] Stratum MCP server running and reachable (check `~/.claude/mcp.json` or `.mcp.json`)
- [ ] `agent_run` MCP tool visible in Claude Code session (run `/mcp` to verify)

---

## Part 1 — Connector Smoke Tests

Run these before the full pipeline to isolate failures to the right layer.

### 1a. ClaudeSDKConnector

```
Ask Claude Code (in the Compose terminal):
  "Use the agent_run tool with type=claude, prompt='Return the string HELLO in uppercase'"
```

- [ ] Tool call appears in terminal activity feed
- [ ] Response contains `HELLO`
- [ ] No `AgentConnector.run() not implemented` error in server log

### 1b. CodexConnector

```
Ask Claude Code:
  "Use the agent_run tool with type=codex, modelID=gpt-5.2-codex,
   prompt='Return the number 42 as JSON: {\"answer\": 42}'"
```

- [ ] OpenCode session spawned (visible in server log: `[agent-mcp] codex run`)
- [ ] Response is valid JSON `{"answer": 42}`
- [ ] No `CodexConnector: '...' is not a supported Codex model` error

### 1c. Schema mode (structured output)

```
Ask Claude Code:
  "Use agent_run with type=codex, prompt='Is 2+2=4?',
   schema={type:object, required:[clean,summary], properties:{clean:{type:boolean}, summary:{type:string}}}"
```

- [ ] Response parses as valid JSON matching the schema
- [ ] `clean` is a boolean, `summary` is a string

---

## Part 2 — Pipeline Execution

Use a simple, self-contained task so the review step has clear acceptance criteria.

### 2a. Prepare inputs

**task** (paste as a single string):
```
Add a helper function `clamp(value, min, max)` to `src/lib/math-utils.js` (new file).
The function must:
- Return min if value < min
- Return max if value > max
- Return value otherwise
Export it as a named export. Add a JSDoc comment.
```

**blueprint** (paste as a single string):
```
Blueprint: clamp utility
- File: src/lib/math-utils.js (new)
- Export: named export `clamp(value, min, max)`
- Behaviour: clamps value to [min, max] range
- JSDoc: must describe all three parameters and return value
- No external dependencies
```

### 2b. Run the pipeline

In a Claude Code session inside the Compose project:

```
"Run the review_fix flow from pipelines/review-fix.stratum.yaml with the
 task and blueprint above. Use stratum_plan to get the first step, then
 execute each step with stratum_step_done, and call stratum_audit at the end."
```

Expected sequence:

- [ ] `stratum_plan` returns `execute` as the first step
- [ ] `execute_task` runs: `agent_run` with `type=claude` creates `src/lib/math-utils.js`
- [ ] `stratum_step_done` on `execute` returns `fix_and_review` as next step
- [ ] `fix_and_review` runs: `agent_run` with `type=codex` reviews and returns `{clean: true, ...}`
  - If `clean=false`: Claude fixes findings, Codex re-reviews (up to 10 retries)
- [ ] Final `stratum_step_done` on `review` confirms `result.clean == true`
- [ ] `stratum_audit` produces a trace with both steps

### 2c. Verify artefacts

- [ ] `src/lib/math-utils.js` exists
- [ ] `clamp` is exported: `node -e "import('./src/lib/math-utils.js').then(m => console.log(typeof m.clamp))"`
- [ ] JSDoc present in file
- [ ] Review loop completed in ≤ 3 iterations (log: `[session] Haiku summary distributed`)

---

## Part 3 — Observability Checks

- [ ] Vision Surface shows tool activity during pipeline execution (agentActivity events)
- [ ] Session accumulator recorded item touches (toolCount > 0 in sessions.json after run)
- [ ] No `[session] Background flush failed` in server log
- [ ] `stratum_audit` trace attached to commit message or saved to `docs/journal/`

---

## Pass Criteria

All checkboxes above checked. The gate passes when:

1. Both connectors respond correctly in isolation (Part 1)
2. The full `review_fix` flow runs to `clean=true` without manual intervention (Part 2)
3. Observability data is present in the session store and Vision Surface (Part 3)

## Failure Triage

| Symptom | Likely cause | Fix |
|---|---|---|
| `CodexConnector: 'X' is not a supported Codex model` | Wrong modelID or CODEX_MODEL env | Check `CODEX_MODEL` env var; use a model from `CODEX_MODEL_IDS` set |
| `opencode` not found | opencode CLI not installed | `npm i -g opencode` |
| `agent_run` tool not visible in `/mcp` | MCP server not running | Restart server; check `.mcp.json` paths are relative (`./server/agent-mcp.js`) |
| `clean=false` after 10 retries | Task/blueprint too ambiguous | Tighten blueprint; check Codex auth |
| `stratum_plan` fails to parse | YAML schema error | Run `python3 -c "import yaml; yaml.safe_load(open('pipelines/review-fix.stratum.yaml'))"` |
