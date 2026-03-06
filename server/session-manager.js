/**
 * SessionManager — session lifecycle, per-item accumulator, batched Haiku summaries.
 *
 * Sessions are NOT tracker entities — they're execution context that accumulates
 * tool-use events, groups them into work blocks by resolved tracker item, and
 * periodically summarises batches via Haiku.
 */

import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdir } from 'node:fs/promises';
import { buildSummaryPrompt, summarize } from './summarizer.js';
import { updateBlock, closeCurrentBlock } from './block-tracker.js';
import { serializeSession, persistSession, readLastSession, readSessionsByFeature } from './session-store.js';

import { TARGET_ROOT, DATA_DIR } from './project-root.js';

const PROJECT_ROOT = TARGET_ROOT;
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

/** Tools whose events count toward the Haiku summary batch threshold */
const SIGNIFICANT_TOOLS = new Set(['Write', 'Edit', 'Bash', 'NotebookEdit']);

/** Number of significant events before triggering a Haiku summary call */
const BATCH_SIZE = 4;

export class SessionManager {
  constructor({ getFeaturePhase, featureRoot, sessionsFile } = {}) {
    /** @type {object|null} Current active session */
    this.currentSession = null;

    /** @type {function} Callback to get current phase for a featureCode */
    this._getFeaturePhase = getFeaturePhase || (() => null);

    /** @type {string} Root directory for feature folders */
    this._featureRoot = featureRoot || 'docs/features';

    /** @type {string} Path to sessions.json — injectable for tests */
    this._sessionsFile = sessionsFile || SESSIONS_FILE;

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
      id: `session-${Date.now()}-${randomBytes(3).toString('hex')}`,
      startedAt: now,
      source,
      toolCount: 0,
      items: new Map(),          // itemId → { title, summaries[], reads, writes, firstTouched, lastTouched }
      currentBlock: null,        // { itemIds: Set, startedAt, toolCount } | null
      blocks: [],                // closed blocks: { itemIds[], startedAt, endedAt, toolCount }
      commits: [],
      errors: [],                // { type, severity, tool, message, itemIds, timestamp }
      featureCode: null,
      featureItemId: null,
      phaseAtBind: null,
      boundAt: null,
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

    // Capture phaseAtEnd for bound sessions
    if (session.featureCode) {
      session.phaseAtEnd = this._getFeaturePhase(session.featureCode);
    }

    // Auto-file transcript to feature folder — awaited to ensure copy completes before process exit
    if (session.featureCode && transcriptPath) {
      try {
        await this._fileTranscript(session.featureCode, session.id, transcriptPath);
      } catch (err) {
        console.error(`[session] Failed to file transcript to ${session.featureCode}:`, err.message);
      }
    }

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
  getContext(featureCode) {
    if (featureCode) {
      return readSessionsByFeature(featureCode, 1, this._sessionsFile)[0] || null;
    }
    return readLastSession(this._sessionsFile);
  }

  /** Bind the current session to a lifecycle feature. One-shot — re-bind returns already_bound. */
  bindToFeature(featureCode, itemId, phase) {
    const session = this.currentSession;
    if (!session) throw new Error('No active session');
    if (session.featureCode) {
      return { already_bound: true, featureCode: session.featureCode };
    }
    session.featureCode = featureCode;
    session.featureItemId = itemId;
    session.phaseAtBind = phase;
    session.boundAt = new Date().toISOString();
    return { bound: true, featureCode, itemId, phase };
  }

  /** Expose sessions file path for use by routes. */
  get sessionsFile() { return this._sessionsFile; }

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
      const prompt = buildSummaryPrompt(batch, PROJECT_ROOT);
      const result = await summarize(prompt, { projectRoot: PROJECT_ROOT });
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

  async _fileTranscript(featureCode, sessionId, transcriptPath) {
    const ext = path.extname(transcriptPath) || '.transcript';
    const sessionsDir = path.join(this._featureRoot, featureCode, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const dest = path.join(sessionsDir, `${sessionId}${ext}`);
    await copyFile(transcriptPath, dest);
  }

  _serialize(session) { return serializeSession(session); }
  _persist(session)   { persistSession(session, this._sessionsFile); }
}
