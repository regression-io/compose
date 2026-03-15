/**
 * vision-utils.js — Pure/standalone utilities extracted from VisionServer.
 *
 * Functions here have no dependency on the VisionServer class instance and
 * can be unit-tested or reused independently.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getTargetRoot, loadProjectConfig } from './project-root.js';

const PROJECT_ROOT = getTargetRoot();

// ---------------------------------------------------------------------------
// Error detection
// ---------------------------------------------------------------------------

const ERROR_PATTERNS = [
  { type: 'build_error', severity: 'error', patterns: [/SyntaxError/i, /TypeError/i, /Cannot find module/i, /Build failed/i, /npm ERR!/i, /error TS\d/i, /ReferenceError/i] },
  { type: 'test_failure', severity: 'error', patterns: [/FAIL /,  /failures?:/i, /AssertionError/i, /tests? failed/i, /\u2715/, /\u2717/] },
  { type: 'git_conflict', severity: 'error', patterns: [/CONFLICT/i, /merge conflict/i, /rebase failed/i] },
  { type: 'permission_error', severity: 'error', patterns: [/EACCES/i, /EPERM/i, /permission denied/i] },
  { type: 'not_found', severity: 'warning', patterns: [/ENOENT/i, /No such file/i, /command not found/i] },
  { type: 'lint_error', severity: 'warning', patterns: [/eslint.*error/i, /prettier.*error/i] },
  { type: 'runtime_error', severity: 'error', patterns: [/Unhandled/i, /FATAL/i, /panic:/i, /Traceback/i] },
];

/**
 * Pattern-match known error signatures in tool responses or error strings.
 * Returns { type, severity, message } or null.
 *
 * @param {string} tool
 * @param {object} input
 * @param {string} responseText
 * @returns {{ type: string, severity: string, message: string } | null}
 */
export function detectError(tool, input, responseText) {
  if (!responseText || typeof responseText !== 'string') return null;

  const text = responseText;

  for (const { type, severity, patterns } of ERROR_PATTERNS) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const idx = text.indexOf(match[0]);
        const lineStart = text.lastIndexOf('\n', idx) + 1;
        const lineEnd = text.indexOf('\n', idx);
        const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
        const message = line.length > 150 ? line.slice(0, 147) + '...' : line;
        return { type, severity, message };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Journal agent
// ---------------------------------------------------------------------------

/**
 * Spawn a hidden agent to write a journal entry from session data.
 *
 * @param {object} session — serialized session object
 * @param {string} transcriptPath
 * @param {string} [projectRoot] — defaults to PROJECT_ROOT
 */
export function spawnJournalAgent(session, transcriptPath, projectRoot = PROJECT_ROOT) {
  const config = loadProjectConfig();
  const journalRel = config.paths?.journal || 'docs/journal';

  const itemSummaries = Object.entries(session.items || {})
    .map(([_id, data]) => `- ${data.title}: ${data.writes} writes, ${data.reads} reads. ${(data.summaries || []).map(s => s.summary || '').filter(Boolean).join('. ')}`)
    .join('\n');
  const blockSummaries = (session.blocks || [])
    .map((b, i) => `- Block ${i + 1}: ${b.itemIds.length} items, ${b.toolCount} tool uses`)
    .join('\n');

  const startMs = new Date(session.startedAt).getTime();
  const endMs = session.endedAt ? new Date(session.endedAt).getTime() : Date.now();
  const durationSec = Math.round((endMs - startMs) / 1000);

  const today = new Date().toISOString().slice(0, 10);
  let sessionNum = 0;
  try {
    const entries = fs.readdirSync(path.join(projectRoot, journalRel));
    for (const f of entries) {
      const m = f.match(new RegExp(`^${today}-session-(\\d+)`));
      if (m) sessionNum = Math.max(sessionNum, parseInt(m[1]) + 1);
    }
  } catch { /* journal dir might not exist */ }

  const prompt = `You are writing a developer journal entry for the Compose project.
Read the transcript at: ${transcriptPath}
Write a journal entry at ${journalRel}/${today}-session-${sessionNum}-<slug>.md following the exact format of existing entries in ${journalRel}/. Use first person plural ("we"). Be honest about failures.
Session data:
- Duration: ${durationSec}s (${Math.round(durationSec / 60)} minutes)
- Tool uses: ${session.toolCount}
- Items worked on:\n${itemSummaries || '(none resolved)'}
- Work blocks:\n${blockSummaries || '(single block)'}
- Commits: ${(session.commits || []).join(', ') || '(none)'}
After writing the entry, update ${journalRel}/README.md with the new entry row.
Then commit both files.`;

  const cleanEnv = { ...process.env, NO_COLOR: '1' };
  delete cleanEnv.CLAUDECODE;
  const proc = spawn('claude', ['-p', prompt, '--dangerously-skip-permissions'], {
    cwd: projectRoot,
    env: cleanEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.on('close', (code) => {
    console.log(`[session] Journal agent exited (code ${code})`);
  });
  proc.on('error', (err) => {
    console.error(`[session] Journal agent spawn error:`, err.message);
  });
  console.log(`[session] Journal agent spawned (PID ${proc.pid})`);
}

// ---------------------------------------------------------------------------
// File path extraction
// ---------------------------------------------------------------------------

/**
 * Extract slug from a docs/ file path.
 *
 * @param {string} filePath
 * @returns {string|null}
 */
export function extractSlugFromPath(filePath) {
  const filename = filePath.split('/').pop().replace(/\.md$/, '');
  const noDate = filename.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  const noSession = noDate.replace(/^session-\d+-/, '');
  const noSuffix = noSession.replace(/-(roadmap|plan|design|spec|eval|review)$/, '');
  return noSuffix || null;
}

/**
 * Extract file paths from plan/spec markdown content.
 *
 * @param {string} markdown
 * @returns {string[]}
 */
export function extractFilePaths(markdown) {
  const paths = new Set();
  const lines = markdown.split('\n');
  const extRe = /\.(jsx?|tsx?|mjs|css|json|md|sh|py)$/;
  const skipRe = /node_modules|dist\/|\.git\/|example|foo|bar|^node |^npm |^npx |test\.\w+$/;

  let inCodeFence = false;
  for (const line of lines) {
    if (line.trim().startsWith('```')) { inCodeFence = !inCodeFence; continue; }
    if (inCodeFence) continue;

    const backtickMatches = line.matchAll(/`([^`]+)`/g);
    for (const m of backtickMatches) {
      const p = m[1].replace(/^\*\*|\*\*$/g, '').trim();
      if (p.includes('/') && extRe.test(p) && !skipRe.test(p)) {
        paths.add(p.replace(/^\.\//, ''));
      }
    }

    const markerMatch = line.match(/[-*]\s+`?([^\s`]+)`?\s+\((?:new|existing)\)/);
    if (markerMatch) {
      const p = markerMatch[1].replace(/^\*\*|\*\*$/g, '').trim();
      if (p.includes('/') && !skipRe.test(p)) {
        paths.add(p.replace(/^\.\//, ''));
      }
    }
  }

  return Array.from(paths);
}
