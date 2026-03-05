/**
 * compose-mcp-tools.js — Tool implementations for the Compose MCP server.
 *
 * Reads directly from disk (no HTTP, no daemon dependency) so the MCP server
 * works even when the Compose server is not running.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const VISION_FILE = path.join(PROJECT_ROOT, 'data', 'vision-state.json');
export const SESSIONS_FILE = path.join(PROJECT_ROOT, 'data', 'sessions.json');

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

export function loadVisionState() {
  try {
    const raw = fs.readFileSync(VISION_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { items: [], connections: [] };
  }
}

export function loadSessions() {
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
    const sessions = JSON.parse(raw);
    return Array.isArray(sessions) ? sessions : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

export function toolGetVisionItems({ phase, status, type, keyword, limit = 30 }) {
  const { items } = loadVisionState();

  let results = items;
  if (phase) results = results.filter(i => i.phase === phase);
  if (status) {
    const statuses = status.split(',').map(s => s.trim());
    results = results.filter(i => statuses.includes(i.status));
  }
  if (type) results = results.filter(i => i.type === type);
  if (keyword) {
    const kw = keyword.toLowerCase();
    results = results.filter(i =>
      i.title?.toLowerCase().includes(kw) ||
      i.description?.toLowerCase().includes(kw)
    );
  }

  const sliced = results.slice(0, limit);
  return {
    count: results.length,
    returned: sliced.length,
    items: sliced.map(i => ({
      id: i.id,
      title: i.title,
      type: i.type,
      phase: i.phase,
      status: i.status,
      confidence: i.confidence ?? null,
      description: i.description ?? null,
    })),
  };
}

export function toolGetItemDetail({ id }) {
  const { items, connections } = loadVisionState();

  const item = items.find(i => i.id === id || i.semanticId === id || i.slug === id);
  if (!item) return { error: `Item not found: ${id}` };

  const resolvedId = item.id;
  const related = connections.filter(c => c.fromId === resolvedId || c.toId === resolvedId);
  const connectionDetails = related.map(c => {
    const other = items.find(i => i.id === (c.fromId === resolvedId ? c.toId : c.fromId));
    return {
      direction: c.fromId === resolvedId ? 'outgoing' : 'incoming',
      type: c.type,
      otherId: other?.id,
      otherTitle: other?.title ?? '(unknown)',
      otherStatus: other?.status,
    };
  });

  return { ...item, connections: connectionDetails };
}

export function toolGetPhasesSummary({ phase }) {
  const { items } = loadVisionState();

  const scoped = phase ? items.filter(i => i.phase === phase) : items;
  const byStatus = {};
  const byType = {};
  for (const item of scoped) {
    const s = item.status || 'unknown';
    byStatus[s] = (byStatus[s] || 0) + 1;
    const t = item.type || 'unknown';
    byType[t] = (byType[t] || 0) + 1;
  }

  const confidences = scoped.map(i => i.confidence).filter(c => typeof c === 'number');
  const avgConfidence = confidences.length
    ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100) / 100
    : null;

  return { phase: phase || 'all', total: scoped.length, byStatus, byType, avgConfidence };
}

export function toolGetBlockedItems() {
  const { items, connections } = loadVisionState();
  const itemMap = new Map(items.map(i => [i.id, i]));

  const blocked = [];
  for (const conn of connections) {
    if (conn.type === 'blocks') {
      const blocker = itemMap.get(conn.fromId);
      const target = itemMap.get(conn.toId);
      if (
        blocker && target &&
        blocker.status !== 'complete' &&
        blocker.status !== 'killed'
      ) {
        blocked.push({
          item: { id: target.id, title: target.title, status: target.status, phase: target.phase },
          blockedBy: { id: blocker.id, title: blocker.title, status: blocker.status },
        });
      }
    }
  }

  return { count: blocked.length, blocked };
}

export function toolGetCurrentSession() {
  const sessions = loadSessions();
  if (sessions.length === 0) return { session: null };

  const last = sessions[sessions.length - 1];
  const allSummaries = [];
  for (const [, acc] of Object.entries(last.items || {})) {
    for (const s of acc.summaries || []) {
      if (s) allSummaries.push(typeof s === 'string' ? { summary: s } : s);
    }
  }

  return {
    session: {
      id: last.id,
      startedAt: last.startedAt,
      endedAt: last.endedAt ?? null,
      source: last.source,
      toolCount: last.toolCount,
      blockCount: (last.blocks || []).length,
      errorCount: (last.errors || []).length,
      itemCount: Object.keys(last.items || {}).length,
      recentSummaries: allSummaries.slice(-5),
    },
  };
}
