# HOOK-CACHE Implementation Plan

**Items:** 103-106
**Scope:** PreToolUse hook blocking redundant file reads. Standalone — no Compose/Stratum deps.

## Architecture

A `read-cache.sh` hook already exists at `~/.claude/hooks/read-cache.sh` with basic mtime caching. HOOK-CACHE formalizes this into a proper Python implementation with:
- Line-range tracking (partial reads via offset/limit)
- PostToolUse invalidation on Edit/Write
- PreCompact cache clear
- Per-agent isolation (already in existing hook)
- Metrics tracking

**Hook locations:**
- PreToolUse on Read: block redundant reads
- PostToolUse on Edit/Write: invalidate cache for modified file
- PreCompact: clear entire cache (context no longer has the content)

**Cache dir:** `~/.claude/read-cache/<session_id>/<agent_id>/`

## Tasks

### Task 1: Read cache core (PreToolUse on Read)

**File:** `~/.claude/hooks/read-cache.py` (new, replaces read-cache.sh)

- [ ] Read JSON from stdin: `{ tool_name, tool_input: { file_path, offset, limit }, session_id, agent_id }`
- [ ] Cache key: SHA-256 of absolute file path
- [ ] Cache dir: `~/.claude/read-cache/{session_id}/{agent_id}/`
- [ ] Cache entry (JSON): `{ mtime, ranges: [[start, end], ...] }`
- [ ] **First read of file:** record mtime + range `[offset, offset+limit]` (or `[0, MAX]` for full reads). Allow (exit 0).
- [ ] **Subsequent read of same file:**
  - Check mtime: if changed → clear entry, allow, record new mtime + range
  - Check range coverage: if requested range `[offset, offset+limit]` is fully contained within cached ranges → block (exit 2) with message "file already in context (lines {start}-{end})"
  - If partially covered or uncovered → allow, merge new range into cached ranges
- [ ] Range merge: sort by start, merge overlapping intervals
- [ ] Output on block: `{ "decision": "block", "reason": "File {path} unchanged since last read (lines {start}-{end} already in context). Use offset/limit for uncovered ranges." }`

### Task 2: Edit/Write invalidation (PostToolUse)

**File:** `~/.claude/hooks/read-cache-invalidate.py` (new)

- [ ] Triggered on PostToolUse for Edit, Write, MultiEdit
- [ ] Read JSON from stdin: `{ tool_name, tool_input: { file_path }, session_id, agent_id }`
- [ ] Delete cache entry for the modified file
- [ ] Always exit 0 (never block, just invalidate)

### Task 3: PreCompact cache clear

**File:** `~/.claude/hooks/read-cache-compact.py` (new)

- [ ] Triggered on PreCompact
- [ ] Read JSON from stdin: `{ session_id }`
- [ ] Delete entire `~/.claude/read-cache/{session_id}/` directory
- [ ] Always exit 0

### Task 4: Metrics

**File:** `~/.claude/hooks/read-cache.py` (same as task 1)

- [ ] On each decision, append to `~/.claude/read-cache/stats.json`:
  - `{ timestamp, session_id, decision: "allow"|"block", file_path, estimated_tokens_saved }`
  - Token estimate: (limit ?? 2000) * 4 chars/token (rough heuristic)
- [ ] Metrics are for the human, NOT injected into agent context

### Task 5: Hook registration

**File:** `~/.claude/hooks.json` (existing)

- [ ] Replace existing `read-cache.sh` PreToolUse matcher with `read-cache.py`
- [ ] Add PostToolUse matcher for Edit/Write/MultiEdit → `read-cache-invalidate.py`
- [ ] Add PreCompact matcher → `read-cache-compact.py`

### Task 6: Tests

**File:** `compose/test/hook-read-cache.test.js` (new) — functional tests that invoke the Python scripts

- [ ] Test: first read of file → allow (exit 0)
- [ ] Test: second read of unchanged file, same range → block (exit 2)
- [ ] Test: second read of changed file (different mtime) → allow
- [ ] Test: partial read then full read → allow (uncovered range)
- [ ] Test: full read then partial read within range → block
- [ ] Test: Edit invalidation clears cache entry
- [ ] Test: PreCompact clears entire session cache
- [ ] Test: range merge works correctly for overlapping intervals
