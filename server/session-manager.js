/**
 * SessionManager — session lifecycle, per-item accumulator, batched Haiku summaries.
 *
 * Sessions are NOT tracker entities — they're execution context that accumulates
 * tool-use events, groups them into work blocks by resolved tracker item, and
 * periodically summarises batches via Haiku.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHaikuPrompt, callHaiku } from './haiku-summarizer.js';
import { updateBlock, closeCurrentBlock } from './block-tracker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SESSIONS_FILE = path.join(PROJECT_ROOT, 'data', 'sessions.json');

/** Tools whose events count toward the Haiku summary batch threshold */
const SIGNIFICANT_TOOLS = new Set(['Write', 'Edit', 'Bash', 'NotebookEdit']);

/** Number of significant events before triggering a Haiku summary call */
const BATCH_SIZE = 4;

export class SessionManager {
  constructor() {
    /** @type {object|null} Current active session */
    this.currentSession = null;

    /** @type {Array<{tool,filePath,input,itemIds,timestamp}>} Buffered significant events */
    this._pendingBatch = [];

    /** @type {boolean} Whether a Haiku flush is currently in-flight */
    this._flushing = false;

    /** @type {Promise|null} In-flight flush promise for awaiting */
    this._flushPromise = null;

    /** @type {Array<function>} Callbacks for when summaries arrive */
    this._summaryListeners = [];
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Start a new session.
   * @param {'startup'|'resume'|'clear'|'compact'} source — what triggered the session
   */
  startSession(source = 'startup') {
    // Close any lingering session synchronously (skip Haiku flush to avoid async race)
    if (this.currentSession) {
      closeCurrentBlock(this.currentSession);
      const old = this.currentSession;
      old.endedAt = new Date().toISOString();
      old.endReason = 'replaced';
      this._persist(this._serialize(old));
      console.log(`[session] Ended ${old.id} (reason: replaced, tools: ${old.toolCount})`);
      this.currentSession = null;
    }

    const now = new Date().toISOString();
    this.currentSession = {
      id: `session-${Date.now()}`,
      startedAt: now,
      source,
      toolCount: 0,
      items: new Map(),          // itemId → { title, summaries[], reads, writes, firstTouched, lastTouched }
      currentBlock: null,        // { itemIds: Set, startedAt, toolCount } | null
      blocks: [],                // closed blocks: { itemIds[], startedAt, endedAt, toolCount }
      commits: [],
      errors: [],                // { type, severity, tool, message, itemIds, timestamp }
    };

    this._pendingBatch = [];
    this._flushing = false;
    this._flushPromise = null;

    console.log(`[session] Started ${this.currentSession.id} (source: ${source})`);
    return this.currentSession;
  }

  /**
   * End the current session, persist it, return session data.
   * @param {string} reason — why the session ended
   * @param {string} [transcriptPath] — optional path to conversation transcript
   * @returns {object|null} The completed session data, or null if no session active
   */
  async endSession(reason = 'manual', transcriptPath = null) {
    if (!this.currentSession) return null;

    await this.flush();

    closeCurrentBlock(this.currentSession);

    const session = this.currentSession;
    session.endedAt = new Date().toISOString();
    session.endReason = reason;
    if (transcriptPath) session.transcriptPath = transcriptPath;

    const serializable = this._serialize(session);

    this._persist(serializable);

    console.log(`[session] Ended ${session.id} (reason: ${reason}, tools: ${session.toolCount})`);

    this.currentSession = null;
    this._pendingBatch = [];
    return serializable;
  }

  /** Record a tool-use event. Accumulates per-item stats, detects block boundaries,
   * and buffers significant events for Haiku summarization. */
  recordActivity(tool, category, filePath, input, resolvedItems = []) {
    if (!this.currentSession) return;

    const now = new Date().toISOString();
    const session = this.currentSession;
    session.toolCount++;

    const isWrite = ['Write', 'Edit', 'NotebookEdit'].includes(tool);
    const isRead = tool === 'Read';

    for (const item of resolvedItems) {
      let acc = session.items.get(item.id);
      if (!acc) {
        acc = {
          title: item.title,
          summaries: [],
          reads: 0,
          writes: 0,
          firstTouched: now,
          lastTouched: now,
        };
        session.items.set(item.id, acc);
      }
      acc.lastTouched = now;
      if (isRead) acc.reads++;
      if (isWrite) acc.writes++;
    }

    const itemIds = resolvedItems.map(i => i.id);
    if (itemIds.length > 0) {
      updateBlock(session, itemIds, now, category);
    }

    if (SIGNIFICANT_TOOLS.has(tool)) {
      this._pendingBatch.push({
        tool,
        category,
        filePath,
        input: this._truncateInput(input),
        itemIds,
        itemTitles: resolvedItems.map(i => i.title),
        timestamp: now,
      });

      if (this._pendingBatch.length >= BATCH_SIZE && !this._flushing) {
        this._flushPromise = this._flushSummary().catch(err => {
          console.error('[session] Background flush failed:', err.message);
        });
      }
    }
  }

  /** Record a detected error. Stored for persistence + Haiku batch context. */
  recordError(tool, filePath, errorType, severity, message, resolvedItems = []) {
    if (!this.currentSession) return;

    this.currentSession.errors.push({
      type: errorType,
      severity,
      tool,
      filePath: filePath || null,
      message: message.length > 200 ? message.slice(0, 197) + '...' : message,
      itemIds: resolvedItems.map(i => i.id),
      timestamp: new Date().toISOString(),
    });
  }

  /** Force-flush any pending events to Haiku. Awaitable. */
  async flush() {
    if (this._flushPromise) {
      await this._flushPromise;
    }
    if (this._pendingBatch.length > 0) {
      await this._flushSummary();
    }
  }

  /** Register a callback for when Haiku summaries arrive. */
  onSummary(fn) {
    this._summaryListeners.push(fn);
  }

  /** Return the most recent session summary for the SessionStart hook. */
  getContext() {
    try {
      const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
      const sessions = JSON.parse(raw);
      if (Array.isArray(sessions) && sessions.length > 0) {
        return sessions[sessions.length - 1];
      }
    } catch {
      // No sessions file yet — that's fine
    }
    return null;
  }

  /** True if the current session crosses the journal-worthiness threshold. */
  meetsJournalThreshold() {
    if (!this.currentSession) return false;
    if (this.currentSession.toolCount > 20) return true;
    const elapsed = Date.now() - new Date(this.currentSession.startedAt).getTime();
    return elapsed > 10 * 60 * 1000;
  }

  // ── Internal: Haiku pipeline ─────────────────────────────────────────────

  async _flushSummary() {
    if (this._pendingBatch.length === 0) return;
    this._flushing = true;

    const batch = this._pendingBatch.splice(0);

    try {
      const prompt = buildHaikuPrompt(batch, PROJECT_ROOT);
      const result = await callHaiku(prompt, PROJECT_ROOT);
      if (result) {
        this._distributeSummary(result, batch);
        for (const fn of this._summaryListeners) {
          try { fn(result, batch); } catch { /* listener errors don't propagate */ }
        }
      }
    } catch (err) {
      console.error('[session] Haiku summary failed, raw data preserved:', err.message);
    } finally {
      this._flushing = false;
      this._flushPromise = null;
    }
  }

  _distributeSummary(result, batch) {
    if (!this.currentSession) return;

    const itemIds = new Set();
    for (const evt of batch) {
      for (const id of evt.itemIds) {
        itemIds.add(id);
      }
    }

    const summary = {
      ...result,
      batchSize: batch.length,
      timestamp: new Date().toISOString(),
    };

    for (const id of itemIds) {
      const acc = this.currentSession.items.get(id);
      if (acc) {
        acc.summaries.push(summary);
      }
    }

    console.log(`[session] Haiku summary distributed to ${itemIds.size} items: "${result.summary}"`);
  }

  // ── Internal: Utilities ──────────────────────────────────────────────────

  _truncateInput(input) {
    if (!input) return '(no input)';
    const raw = input.content
      || input.new_string
      || input.command
      || input.new_source
      || input.old_string
      || input.pattern
      || input.query
      || (typeof input === 'string' ? input : JSON.stringify(input));
    const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
    return str.length > 200 ? str.slice(0, 197) + '...' : str;
  }

  _serialize(session) {
    const items = {};
    for (const [id, acc] of session.items) {
      items[id] = { ...acc };
    }
    return {
      id: session.id,
      startedAt: session.startedAt,
      endedAt: session.endedAt || null,
      endReason: session.endReason || null,
      source: session.source,
      toolCount: session.toolCount,
      items,
      blocks: session.blocks,
      commits: session.commits,
      errors: session.errors || [],
      transcriptPath: session.transcriptPath || null,
    };
  }

  _persist(session) {
    try {
      const dir = path.dirname(SESSIONS_FILE);
      fs.mkdirSync(dir, { recursive: true });

      let sessions = [];
      try {
        const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
        sessions = JSON.parse(raw);
        if (!Array.isArray(sessions)) sessions = [];
      } catch (parseErr) {
        if (parseErr.code !== 'ENOENT') {
          const backup = SESSIONS_FILE + '.bak';
          try { fs.copyFileSync(SESSIONS_FILE, backup); } catch { /* best effort */ }
          console.warn(`[session] Corrupted sessions.json backed up to ${backup}`);
        }
      }

      sessions.push(session);
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf-8');
      console.log(`[session] Persisted to ${SESSIONS_FILE} (${sessions.length} total sessions)`);
    } catch (err) {
      console.error('[session] Failed to persist session:', err.message);
    }
  }
}
