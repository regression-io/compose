/**
 * session-store.js — Session persistence: serialize, persist, and read context.
 *
 * Extracted from SessionManager. All functions are pure/stateless helpers
 * that operate on plain session objects and the sessions.json file path.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Convert session state (with Maps/Sets) to a plain serializable object.
 * @param {object} session
 * @returns {object}
 */
export function serializeSession(session) {
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

/**
 * Append a completed session to data/sessions.json.
 * @param {object} session — serialized session data
 * @param {string} sessionsFile — absolute path to sessions.json
 */
export function persistSession(session, sessionsFile) {
  try {
    fs.mkdirSync(path.dirname(sessionsFile), { recursive: true });

    let sessions = [];
    try {
      const raw = fs.readFileSync(sessionsFile, 'utf-8');
      sessions = JSON.parse(raw);
      if (!Array.isArray(sessions)) sessions = [];
    } catch (parseErr) {
      if (parseErr.code !== 'ENOENT') {
        const backup = sessionsFile + '.bak';
        try { fs.copyFileSync(sessionsFile, backup); } catch { /* best effort */ }
        console.warn(`[session] Corrupted sessions.json backed up to ${backup}`);
      }
    }

    sessions.push(session);
    fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2), 'utf-8');
    console.log(`[session] Persisted to ${sessionsFile} (${sessions.length} total sessions)`);
  } catch (err) {
    console.error('[session] Failed to persist session:', err.message);
  }
}

/**
 * Read the most recent session from sessions.json.
 * @param {string} sessionsFile — absolute path to sessions.json
 * @returns {object|null}
 */
export function readLastSession(sessionsFile) {
  try {
    const raw = fs.readFileSync(sessionsFile, 'utf-8');
    const sessions = JSON.parse(raw);
    if (Array.isArray(sessions) && sessions.length > 0) {
      return sessions[sessions.length - 1];
    }
  } catch {
    // No sessions file yet — that's fine
  }
  return null;
}
