/**
 * compose-mcp-tools.js — Tool implementations for the Compose MCP server.
 *
 * Reads directly from disk (no HTTP, no daemon dependency) so the MCP server
 * works even when the Compose server is not running.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ArtifactManager, ARTIFACT_SCHEMAS } from './artifact-manager.js';
import { getTargetRoot, getDataDir, resolveProjectPath } from './project-root.js';
import { ClaudeSDKConnector } from './connectors/claude-sdk-connector.js';
import { CodexConnector } from './connectors/codex-connector.js';

export const PROJECT_ROOT = getTargetRoot();
export const VISION_FILE = path.join(getDataDir(), 'vision-state.json');
export const SESSIONS_FILE = path.join(getDataDir(), 'sessions.json');

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

export function loadVisionState() {
  try {
    const raw = fs.readFileSync(VISION_FILE, 'utf-8');
    const state = JSON.parse(raw);
    if (Array.isArray(state.gates)) {
      const seen = new Map();
      for (const g of state.gates) seen.set(g.id, g);
      state.gates = Array.from(seen.values());
    }
    return state;
  } catch {
    return { items: [], connections: [], gates: [] };
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

export async function toolGetCurrentSession({ featureCode } = {}) {
  if (featureCode) {
    // Delegate to REST API for live session + lifecycle context
    return new Promise((resolve, reject) => {
      const url = new URL(`${_getComposeApi()}/api/session/current?featureCode=${encodeURIComponent(featureCode)}`);
      const req = http.request(
        { hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: 'GET' },
        (res) => {
          let buf = '';
          res.on('data', chunk => buf += chunk);
          res.on('end', () => {
            try { resolve(JSON.parse(buf)); } catch { resolve({ session: null }); }
          });
        },
      );
      req.on('error', () => resolve({ session: null }));
      req.end();
    });
  }
  // Existing disk-read path (keep as-is)
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

export async function toolBindSession({ featureCode }) {
  const postData = JSON.stringify({ featureCode });
  return new Promise((resolve, reject) => {
    const url = new URL(`${_getComposeApi()}/api/session/bind`);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } },
      (res) => {
        let buf = '';
        res.on('data', chunk => buf += chunk);
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(buf); } catch { parsed = { error: buf }; }
          if (res.statusCode >= 400) {
            reject(new Error(parsed.error || `HTTP ${res.statusCode}: ${buf}`));
          } else {
            resolve(parsed);
          }
        });
      },
    );
    req.on('error', (err) => reject(new Error(`Compose server unreachable: ${err.message}`)));
    req.write(postData);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Lifecycle tools — read from disk, mutations delegate to Compose REST API
// ---------------------------------------------------------------------------

function _getComposeApi() {
  return `http://127.0.0.1:${process.env.COMPOSE_PORT || process.env.PORT || 3001}`;
}

function _postLifecycle(itemId, action, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(`${_getComposeApi()}/api/vision/items/${itemId}/lifecycle/${action}`);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', (chunk) => buf += chunk);
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(buf); }
          catch { parsed = { error: buf }; }
          if (res.statusCode >= 400) {
            reject(new Error(parsed.error || `HTTP ${res.statusCode}: ${buf}`));
          } else {
            resolve(parsed);
          }
        });
      },
    );
    req.on('error', (err) => reject(new Error(`Compose server unreachable: ${err.message}`)));
    req.end(data);
  });
}

function _postGate(gateId, action, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(`${_getComposeApi()}/api/vision/gates/${gateId}/${action}`);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', (chunk) => buf += chunk);
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(buf); }
          catch { parsed = { error: buf }; }
          if (res.statusCode >= 400) {
            reject(new Error(parsed.error || `HTTP ${res.statusCode}: ${buf}`));
          } else {
            resolve(parsed);
          }
        });
      },
    );
    req.on('error', (err) => reject(new Error(`Compose server unreachable: ${err.message}`)));
    req.end(data);
  });
}

export function toolGetFeatureLifecycle({ id }) {
  const { items } = loadVisionState();
  const item = items.find(i => i.id === id || i.semanticId === id || i.slug === id);
  if (!item) return { error: `Item not found: ${id}` };
  if (!item.lifecycle) return { error: 'No lifecycle on this item' };
  return item.lifecycle;
}

export async function toolKillFeature({ id, reason }) {
  return _postLifecycle(id, 'kill', { reason });
}

export async function toolCompleteFeature({ id }) {
  return _postLifecycle(id, 'complete', {});
}

export async function toolIterationStart({ id, loopType, maxIterations }) {
  return _postLifecycle(id, 'iteration/start', { loopType, maxIterations });
}

export async function toolIterationReport({ id, result }) {
  return _postLifecycle(id, 'iteration/report', { result });
}

export async function toolIterationAbort({ id, reason }) {
  return _postLifecycle(id, 'iteration/abort', { reason });
}

// ---------------------------------------------------------------------------
// Artifact tools — read/write directly (no REST delegation needed)
// ---------------------------------------------------------------------------

export function toolAssessFeatureArtifacts({ featureCode }) {
  const featureRoot = resolveProjectPath('features');
  if (!fs.existsSync(featureRoot)) {
    // Return empty assessments — feature root hasn't been created yet
    const empty = {};
    for (const filename of Object.keys(ARTIFACT_SCHEMAS)) {
      empty[filename] = { exists: false, wordCount: 0, meetsMinWordCount: false, sections: { found: [], missing: [], optional: [] }, completeness: 0, lastModified: null };
    }
    return { artifacts: empty };
  }
  const manager = new ArtifactManager(featureRoot);
  return manager.assess(featureCode);
}

export function toolScaffoldFeature({ featureCode, only }) {
  const featureRoot = resolveProjectPath('features');
  const manager = new ArtifactManager(featureRoot);
  return manager.scaffold(featureCode, only ? { only } : undefined);
}

// ---------------------------------------------------------------------------
// Gate tools — mutations delegate to Compose REST API
// ---------------------------------------------------------------------------

export async function toolApproveGate({ gateId, outcome, comment }) {
  return _postGate(gateId, 'resolve', { outcome, comment });
}

export function toolGetPendingGates({ itemId }) {
  const { gates } = loadVisionState();
  if (!gates) return { count: 0, gates: [] };
  const pending = gates.filter(g => g.status === 'pending' && (!itemId || g.itemId === itemId));
  return { count: pending.length, gates: pending };
}

// ---------------------------------------------------------------------------
// Agent run — dispatch prompts to claude or codex
// ---------------------------------------------------------------------------

const VALID_AGENT_TYPES = new Set(['claude', 'codex']);

/**
 * Build a context preamble for agent_run prompts.
 * The spawned agent (especially codex via opencode run) has no project context —
 * no CLAUDE.md, no feature folder awareness, no compose/stratum semantics.
 * This function reads project files and prepends them so the agent can do useful work.
 */
function _buildContext({ featureCode }) {
  const sections = [];

  // Project instructions
  const claudeMd = path.join(PROJECT_ROOT, 'CLAUDE.md');
  if (fs.existsSync(claudeMd)) {
    try {
      const content = fs.readFileSync(claudeMd, 'utf-8');
      sections.push(`## Project Instructions (CLAUDE.md)\n\n${content}`);
    } catch { /* ignore read errors */ }
  }

  // Feature artifacts (if feature code detected)
  // Cap total feature context to ~20KB to avoid exceeding model input limits.
  // Prioritize design.md first, then most recent files by mtime.
  const MAX_FEATURE_BYTES = 20_000;
  if (featureCode) {
    const featureRoot = resolveProjectPath('features');
    const featureDir = path.join(featureRoot, featureCode);
    if (fs.existsSync(featureDir)) {
      const artifacts = [];
      let totalBytes = 0;
      try {
        const files = fs.readdirSync(featureDir)
          .filter(f => f.endsWith('.md') || f.endsWith('.json'))
          .map(f => ({ name: f, path: path.join(featureDir, f), stat: fs.statSync(path.join(featureDir, f)) }))
          .filter(f => f.stat.isFile())
          // design.md first, then most recently modified
          .sort((a, b) => {
            if (a.name === 'design.md') return -1;
            if (b.name === 'design.md') return 1;
            return b.stat.mtimeMs - a.stat.mtimeMs;
          });
        for (const file of files) {
          if (totalBytes >= MAX_FEATURE_BYTES) break;
          try {
            const content = fs.readFileSync(file.path, 'utf-8');
            const trimmed = content.slice(0, MAX_FEATURE_BYTES - totalBytes);
            artifacts.push(`### ${file.name}\n\n${trimmed}`);
            totalBytes += trimmed.length;
          } catch { /* skip unreadable files */ }
        }
      } catch { /* ignore readdir errors */ }
      if (artifacts.length > 0) {
        sections.push(`## Feature: ${featureCode}\n\n${artifacts.join('\n\n---\n\n')}`);
      }
    }
  }

  if (sections.length === 0) return '';
  return `# Context\n\n${sections.join('\n\n---\n\n')}\n\n---\n\n`;
}

/**
 * Extract a feature code from the prompt if one is referenced.
 * Looks for common patterns like "FEAT-1", "AUTH-2", or feature folder paths.
 */
function _extractFeatureCode(prompt) {
  // Match uppercase CODE-N patterns (e.g. FEAT-1, AUTH-2, STRAT-COMP-3)
  const codeMatch = prompt.match(/\b([A-Z][\w-]*-\d+)\b/);
  if (codeMatch) return codeMatch[1];

  // Match feature folder references
  const pathMatch = prompt.match(/features\/([a-zA-Z][\w-]+)/);
  if (pathMatch) return pathMatch[1];

  return null;
}

export async function toolAgentRun({ type = 'claude', prompt, schema, modelID, cwd, featureCode }) {
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('agent_run: prompt is required');
  }
  if (!VALID_AGENT_TYPES.has(type)) {
    throw new Error(`agent_run: unknown type '${type}'. Valid: ${[...VALID_AGENT_TYPES].join(', ')}`);
  }

  // Resolve feature code from explicit param or prompt text
  const resolvedFeature = featureCode || _extractFeatureCode(prompt);

  // Build context preamble and prepend to prompt
  const context = _buildContext({ featureCode: resolvedFeature });
  const fullPrompt = context ? `${context}# Task\n\n${prompt}` : prompt;

  const resolvedCwd = cwd || PROJECT_ROOT;
  const connector = type === 'codex'
    ? new CodexConnector({ modelID, cwd: resolvedCwd })
    : new ClaudeSDKConnector({ model: modelID, cwd: resolvedCwd });

  const parts = [];
  for await (const event of connector.run(fullPrompt, { schema, modelID, cwd: resolvedCwd })) {
    if (event.type === 'assistant' && event.content) {
      parts.push(event.content);
    } else if (event.type === 'error') {
      throw new Error(`agent_run (${type}): ${event.message}`);
    }
  }

  const text = parts.join('');

  if (schema) {
    try {
      return { text, result: JSON.parse(text) };
    } catch {
      return { text, result: null, parseError: 'Response was not valid JSON' };
    }
  }

  return { text };
}

