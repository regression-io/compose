# Compose Manual Test Guide

A workflow-oriented checklist for verifying the full Compose system by hand.
Run top-to-bottom: each section builds on the ones above.

**Ports:** API `3001` · Agent `3002` · Vite `5173`
**Auth header:** `x-compose-token: $COMPOSE_API_TOKEN`

---

## 1. Install & Setup

```bash
node bin/compose.js install
```

- [ ] `.mcp.json` updated — contains `compose-mcp` and `agent-mcp` entries with relative paths (`./server/…`)
- [ ] `/compose` skill installed at `~/.claude/skills/compose/SKILL.md`
- [ ] `stratum-mcp` found on PATH (or install error message printed and exit 1)
- [ ] `ROADMAP.md` created from template if not already present

---

## 2. Server Startup

```bash
node bin/compose.js start
```

- [ ] Supervisor PID file written: `.compose-supervisor.pid`
- [ ] All three processes start within 3s:
  - `[supervisor] API server running on http://127.0.0.1:3001`
  - `[supervisor] Agent server running on http://127.0.0.1:3002`
  - Vite HMR log line on port `5173`
- [ ] `COMPOSE_API_TOKEN` printed in supervisor log
- [ ] `GET http://127.0.0.1:3001/api/health` → `{ ok: true }`
- [ ] `GET http://127.0.0.1:3001/api/status` → JSON with `upSince`, `session`, `phase`
- [ ] Kill one child (`kill $(lsof -ti:3001)`) → supervisor restarts it within 5s
- [ ] `Ctrl+C` supervisor → all three children exit

---

## 3. Vision Store: CRUD

```bash
TOKEN=$(grep COMPOSE_API_TOKEN .compose-supervisor.log | tail -1 | awk '{print $NF}')
BASE=http://127.0.0.1:3001
```

### Create

```bash
curl -s -X POST $BASE/api/vision/items \
  -H 'Content-Type: application/json' \
  -d '{"type":"task","title":"Test item","status":"planned","confidence":2,"phase":"implementation"}'
```

- [ ] Returns item with `id` (uuid), `slug`, `createdAt`, `updatedAt`
- [ ] POST with `confidence: 5` → 400 validation error
- [ ] POST with `type: "garbage"` → 400 validation error

### Read / Update / Delete

```bash
ID=<id from above>
curl -s $BASE/api/vision/items/$ID
curl -s -X PATCH $BASE/api/vision/items/$ID -H 'Content-Type: application/json' -d '{"status":"in_progress"}'
curl -s -X DELETE $BASE/api/vision/items/$ID
```

- [ ] GET returns full item
- [ ] PATCH updates `status`, `updatedAt` changes
- [ ] Title change regenerates `slug`
- [ ] DELETE removes item; GET returns 404

### Connections

```bash
A=<id1>  B=<id2>
curl -s -X POST $BASE/api/vision/connections \
  -H 'Content-Type: application/json' \
  -d "{\"fromId\":\"$A\",\"toId\":\"$B\",\"type\":\"blocks\"}"
```

- [ ] Connection appears in `GET /api/vision/items/$A` under `connections`
- [ ] `DELETE /api/vision/items/$A` removes item and its connections

### Persistence

- [ ] Kill server, restart, `GET /api/vision/items` → all items present (reloaded from `data/vision-state.json`)

### Summary & Blocked

```bash
curl -s $BASE/api/vision/summary
curl -s $BASE/api/vision/blocked
```

- [ ] `/summary`: counts by phase/status/type, avg confidence, `openQuestions`, `blockedItems`
- [ ] Create item A with `status: blocks` connection to incomplete item B; `/blocked` lists B

---

## 4. WebSocket Broadcast

Open two browser tabs to `http://localhost:5173`. Open DevTools console in each.

```js
// paste in both tabs
const ws = new WebSocket('ws://127.0.0.1:3001/ws/vision');
ws.onmessage = e => console.log(JSON.parse(e.data).type);
```

- [ ] Both tabs receive `visionState` immediately on connect
- [ ] Create an item via REST → both tabs receive `visionState` within 200ms
- [ ] Create 5 items in rapid succession (< 50ms apart) → only 1 broadcast fires (debounce)
- [ ] Close tab 1 → tab 2 continues receiving updates

---

## 5. Activity Hooks & Auto-Status

### Hook script

```bash
# Simulate what the Claude Code hook does
echo '{"tool":"Edit","input":{"file_path":"src/app.js"},"response":""}' | \
  bash scripts/agent-activity-hook.sh
```

- [ ] Hook POSTs to `http://127.0.0.1:3001/api/agent/activity` and exits within 2s
- [ ] Server log shows `[vision] agentActivity: Edit`
- [ ] WebSocket clients receive `agentActivity` message with `tool: "Edit"`, `category: "writing"`

### Auto-status promotion

```bash
# Create planned item with file: src/app.js
curl -s -X POST $BASE/api/vision/items \
  -H 'Content-Type: application/json' \
  -d '{"type":"task","title":"App","status":"planned","phase":"implementation","files":["src/app.js"]}'
ID=<returned id>

# Simulate Write on that file
curl -s -X POST $BASE/api/agent/activity \
  -H 'Content-Type: application/json' \
  -d '{"tool":"Write","input":{"file_path":"src/app.js"}}'

curl -s $BASE/api/vision/items/$ID | jq .status
```

- [ ] Status changed from `planned` → `in_progress`

### Error detection

```bash
curl -s -X POST $BASE/api/agent/activity \
  -H 'Content-Type: application/json' \
  -d '{"tool":"Bash","input":{"command":"npm run build"},"response":"SyntaxError: Unexpected token"}'
```

- [ ] WebSocket clients receive `agentError` with `errorType: "build_error"`, `severity: "error"`
- [ ] `POST /api/agent/error` with `error: "ENOENT: no such file"` → `errorType: "not_found"`, `severity: "warning"`

### Tool category map

| Tool | Expected category |
|---|---|
| `Read`, `TodoRead` | `reading` |
| `Write`, `Edit`, `NotebookEdit`, `TodoWrite` | `writing` |
| `Bash` | `executing` |
| `Glob`, `Grep`, `WebSearch` | `searching` |
| `WebFetch` | `fetching` |
| `Task`, `Skill` | `delegating` |
| anything else | `thinking` |

- [ ] Spot-check 3 entries from the table above

---

## 6. Session Lifecycle

```bash
curl -s -X POST $BASE/api/session/start -H 'Content-Type: application/json' -d '{"source":"manual"}'
```

- [ ] Returns `{ sessionId, startedAt }`
- [ ] `GET /api/session/current` → session object with `toolCount: 0`, `items: {}`

### Accumulation

```bash
for tool in Write Edit Bash Write; do
  curl -s -X POST $BASE/api/agent/activity \
    -H 'Content-Type: application/json' \
    -d "{\"tool\":\"$tool\",\"input\":{\"file_path\":\"src/app.js\"}}" > /dev/null
done
```

- [ ] After 4 significant tools (Write/Edit/Bash): server log shows `[session] Haiku summary distributed`
- [ ] `GET /api/session/current` → `toolCount: 4`, item `src/app.js` has `writes > 0`

### End & persist

```bash
curl -s -X POST $BASE/api/session/end \
  -H 'Content-Type: application/json' \
  -d '{"reason":"manual-test"}'
```

- [ ] Returns serialized session with `endedAt`, `endReason: "manual-test"`, `blocks[]`, `errors[]`
- [ ] `data/sessions.json` contains the session (append-only)
- [ ] `GET /api/session/current` → `null`

---

## 7. Agent Spawn

```bash
curl -s -X POST $BASE/api/agent/spawn \
  -H "x-compose-token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"echo hello from subagent"}'
```

- [ ] Returns `{ agentId, pid, status: "running" }`
- [ ] `GET /api/agents` → agent listed
- [ ] Poll `GET /api/agent/:id` → status changes to `complete` or `failed`; `output` contains response
- [ ] POST same `id` again → `409 conflict`
- [ ] POST without token → `401`
- [ ] 5 minutes after completion → `GET /api/agent/:id` returns `404`

---

## 8. Snapshot

With browser tab open and connected to `/ws/vision`:

```bash
curl -s $BASE/api/snapshot
```

- [ ] Returns snapshot JSON from the browser client within 3s
- [ ] Snapshot includes `activeView`, `selectedPhase`, `totalItems`, `filteredCount`
- [ ] Close browser tab, repeat → `503 No connected clients`
- [ ] `GET /api/snapshot?timeout=100` with no client response → `504 Snapshot timeout`

---

## 9. Speckit

```bash
mkdir -p .specify/auth-system/tasks
echo "# Auth System\nSSO login via OAuth 2.0." > .specify/auth-system/spec.md
echo "# Implement login endpoint" > .specify/auth-system/tasks/task-1.md
echo "# Add session middleware" > .specify/auth-system/tasks/task-2.md

curl -s -X POST $BASE/api/speckit/seed
```

- [ ] Server log: `[vision] Speckit seed: 1 new features, 2 new tasks`
- [ ] `GET /api/speckit/scan` → features array contains `auth-system`
- [ ] Feature item created with `type: "feature"`, `phase: "planning"`
- [ ] Task items created with `type: "task"`, connected to feature via `implements`
- [ ] Run seed again → no duplicates (idempotent via `speckitKey`)
- [ ] Edit `task-1.md` title → re-seed → item title updated

---

## 10. Stratum Sync

```bash
mkdir -p ~/.stratum/flows
cat > ~/.stratum/flows/flow-test-1.json <<'EOF'
{ "id": "flow-test-1", "status": "running", "steps": [] }
EOF

# Bind to a vision item
curl -s -X POST $BASE/api/stratum/bind \
  -H 'Content-Type: application/json' \
  -d "{\"flowId\":\"flow-test-1\",\"itemId\":\"$ID\"}"
```

- [ ] Item gains `stratumFlowId: "flow-test-1"`
- [ ] Wait 15s → item `status` syncs to `in_progress` (flow `running` → `in_progress`)
- [ ] Update flow to `{ "status": "blocked", "exhaustedSteps": ["fix_and_review"] }` → item status → `blocked`, `evidence.stratumViolations` populated
- [ ] `POST /api/stratum/audit/:itemId` with `{ trace: [...], status: "complete" }` → item `status` → `complete`, audit trace saved

---

## 11. MCP Tools

With Claude Code session open in the Compose project:

### compose-mcp

- [ ] `get_vision_items` with no filters → returns all items
- [ ] `get_vision_items` with `phase="implementation"` → filtered list
- [ ] `get_vision_items` with `keyword="auth"` → searches title + description
- [ ] `get_item_detail` with valid id → full item + connections
- [ ] `get_item_detail` with nonexistent id → error message (not a crash)
- [ ] `get_phase_summary` with `phase="vision"` → status/type distribution
- [ ] `get_blocked_items` → list of items with unresolved blockers
- [ ] `get_current_session` → toolCount, items touched, error count

### agent-mcp (requires inference — see §12)

- [ ] `agent_run` with `type="claude"`, `prompt="say HELLO"` → text response containing HELLO
- [ ] `agent_run` with `type="codex"`, `prompt="is 2+2=4?"` → response
- [ ] `agent_run` with `schema={type:object,required:[answer],properties:{answer:{type:string}}}` → `result` is parsed JSON
- [ ] `agent_run` with `type="unknown"` → error: `unknown type 'unknown'. Valid types: claude, codex`

---

## 12. Connector Layer & End-to-End Pipeline (requires auth)

**Prerequisites:**
- [ ] `claude --version` exits 0
- [ ] `opencode auth login` completed (ChatGPT subscription + OAuth)
- [ ] `agent_run` tool visible in `/mcp` listing

See `docs/plans/2026-03-05-18h-acceptance-gate.md` for the full step-by-step pipeline test (connector smoke tests → `review_fix` flow → observability verification).

---

## 13. Frontend UI

Open `http://localhost:5173`.

### Layout & persistence

- [ ] Header renders: font size controls, theme toggle
- [ ] Left/right split is draggable; ratio persists across page reload (`localStorage: compose:splitPercent`)
- [ ] Font size increase/decrease 10–20px, persists (`localStorage: compose:fontSize`)
- [ ] Theme toggle dark/light, persists (`localStorage: compose:theme`)

### Agent Stream (left panel)

- [ ] SSE connects to agent server; status shows "ready"
- [ ] Send a message → status → "working", stop button active
- [ ] Messages render: system init card, assistant text, tool use (tool name + detail)
- [ ] Activity pills appear for each tool event
- [ ] Stop button interrupts; status returns to "ready"

### Canvas (right panel)

- [ ] Open a markdown file from `docs/` via file picker → tab appears
- [ ] Tab title shows filename; content renders as markdown
- [ ] Open same file twice → single tab (deduped)
- [ ] Pin toggle: when pinned, new `openFile` WS event does not switch tabs
- [ ] Popout: open tab in new window → separate window opens, syncs file content
- [ ] Tabs persist across page reload (`localStorage: compose:canvasState`)

### Vision Tracker

- [ ] All 7 view buttons clickable: Roadmap, List, Board, Tree, Graph, Docs, Attention
- [ ] Sidebar: phase filter, search input, agent activity feed, error feed, session stats
- [ ] Click item → detail panel opens: title, description, status, confidence, connections
- [ ] Inline edit title/status in detail panel → updates immediately
- [ ] Search `auth` → only matching items shown
- [ ] Phase filter → items from other phases hidden
- [ ] Graph view renders items as nodes, connections as edges

---

## 14. Security

- [ ] `POST /api/agent/spawn` without `x-compose-token` → 401
- [ ] Same with wrong token value → 401
- [ ] Correct token → 201
- [ ] `GET /api/vision/items` has no token requirement → 200 (public read)
- [ ] CORS: request from `http://evil.com` origin → blocked (no `Access-Control-Allow-Origin` header in response)
- [ ] CORS: request from `http://localhost:5173` → allowed

---

## 15. Resilience

- [ ] Edit a file in `server/` while server is running → **do not restart automatically** (no hot-reload on server files; requires manual restart)
- [ ] Edit a file in `src/` → Vite HMR triggers, page updates without full reload
- [ ] Corrupt `data/vision-state.json` (invalid JSON), restart → server starts cleanly, logs a warning, begins with empty state
- [ ] Corrupt `data/sessions.json`, restart → server starts cleanly, backs up file to `sessions.json.bak`
- [ ] `POST /api/agent/activity` with no body → 400 (does not crash server)
- [ ] Two supervisor instances launched simultaneously → second kills first, takes over PID file

---

## Quick Smoke (< 5 minutes)

If you only have a few minutes, run these 10 checks:

```bash
curl $BASE/api/health                                          # → { ok: true }
curl -X POST $BASE/api/vision/items -H 'Content-Type: application/json' \
  -d '{"type":"task","title":"Smoke","status":"planned","phase":"implementation"}' # → item with id
curl $BASE/api/vision/summary                                  # → counts
curl -X POST $BASE/api/agent/activity -H 'Content-Type: application/json' \
  -d '{"tool":"Bash","input":{"command":"ls"},"response":"ENOENT: no such file"}' # → agentError broadcast
curl -X POST $BASE/api/session/start -H 'Content-Type: application/json' \
  -d '{"source":"smoke"}'                                      # → sessionId
curl $BASE/api/session/current                                 # → session object
curl -X POST $BASE/api/session/end -H 'Content-Type: application/json' \
  -d '{"reason":"smoke"}'                                      # → serialized session
curl $BASE/api/snapshot                                        # → 503 (no browser) or snapshot
node --test test/*.test.js                                     # → 69/69
npm run build                                                  # → Vite build exits 0
```
