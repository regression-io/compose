#!/usr/bin/env node
/**
 * run-pipeline.mjs — drive the review-fix pipeline end-to-end.
 *
 * Usage:
 *   node scripts/run-pipeline.mjs [--task "..."] [--blueprint "..."] [--dry-run] [--max-retries N]
 *
 * Defaults to a trivial clamp() utility task if no --task is provided.
 * Writes an audit trace to stdout and to .compose/pipeline-audit.json.
 *
 * This script exercises the 18h acceptance gate:
 *   1. agent_run(type=claude) — execute the task
 *   2. agent_run(type=codex, schema) — review against blueprint
 *   3. If not clean, claude fixes + codex re-reviews (up to --max-retries)
 *   4. Audit trace logged
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values: flags } = parseArgs({
  options: {
    task:         { type: 'string',  default: '' },
    blueprint:    { type: 'string',  default: '' },
    'dry-run':    { type: 'boolean', default: false },
    'max-retries':{ type: 'string',  default: '10' },
    cwd:          { type: 'string',  default: REPO_ROOT },
    help:         { type: 'boolean', default: false },
  },
  strict: false,
});

if (flags.help) {
  console.log(`
Usage: node scripts/run-pipeline.mjs [options]

Options:
  --task "..."         Task description (default: add clamp utility)
  --blueprint "..."    Blueprint to review against (default: generated)
  --dry-run            Print what would run without calling agents
  --max-retries N      Max review-fix iterations (default: 10)
  --cwd PATH           Working directory for agents (default: repo root)
  --help               Show this help
`);
  process.exit(0);
}

const MAX_RETRIES = parseInt(flags['max-retries'], 10) || 10;
const DRY_RUN = flags['dry-run'];
const CWD = flags.cwd;

const DEFAULT_TASK = `
Add a clamp(value, min, max) utility function to src/lib/math-utils.js (create the file if it doesn't exist).

Requirements:
- Export a named function: export function clamp(value, min, max)
- If value < min, return min
- If value > max, return max
- Otherwise return value
- Handle edge case: if min > max, swap them
- No dependencies
`.trim();

const DEFAULT_BLUEPRINT = `
## clamp() utility — acceptance criteria

- [ ] File exists at src/lib/math-utils.js
- [ ] Named export: clamp(value, min, max)
- [ ] Returns min when value < min
- [ ] Returns max when value > max
- [ ] Returns value when min <= value <= max
- [ ] Swaps min/max if min > max
- [ ] No external dependencies
- [ ] No side effects
`.trim();

const task = flags.task || DEFAULT_TASK;
const blueprint = flags.blueprint || DEFAULT_BLUEPRINT;

// ---------------------------------------------------------------------------
// Connector imports
// ---------------------------------------------------------------------------

const { ClaudeSDKConnector } = await import(
  resolve(REPO_ROOT, 'server/connectors/claude-sdk-connector.js')
);
const { CodexConnector } = await import(
  resolve(REPO_ROOT, 'server/connectors/codex-connector.js')
);
const { injectSchema } = await import(
  resolve(REPO_ROOT, 'server/connectors/agent-connector.js')
);

// ---------------------------------------------------------------------------
// Agent helpers
// ---------------------------------------------------------------------------

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['clean', 'summary', 'findings'],
  properties: {
    clean:    { type: 'boolean' },
    summary:  { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
  },
};

async function runAgent(type, prompt, { schema } = {}) {
  const connector = type === 'codex'
    ? new CodexConnector({ cwd: CWD })
    : new ClaudeSDKConnector({ cwd: CWD });

  const parts = [];
  for await (const event of connector.run(prompt, { schema, cwd: CWD })) {
    if (event.type === 'assistant' && event.content) {
      parts.push(event.content);
    } else if (event.type === 'error') {
      throw new Error(`${type}: ${event.message}`);
    }
  }

  const text = parts.join('');

  if (schema) {
    // Try full text parse, then code block extraction (matches agent-mcp.js)
    try {
      return { text, result: JSON.parse(text) };
    } catch {
      const match = text.match(/```json\s*\n([\s\S]*?)\n\s*```/g);
      if (match) {
        const lastBlock = match[match.length - 1]
          .replace(/^```json\s*\n/, '')
          .replace(/\n\s*```$/, '');
        try {
          return { text, result: JSON.parse(lastBlock) };
        } catch { /* fall through */ }
      }
      return { text, result: null };
    }
  }

  return { text };
}

// ---------------------------------------------------------------------------
// Pipeline execution
// ---------------------------------------------------------------------------

const audit = {
  pipeline: 'review-fix',
  startedAt: new Date().toISOString(),
  task: task.slice(0, 200),
  steps: [],
  result: null,
  completedAt: null,
};

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

async function run() {
  log('Pipeline: review-fix');
  log(`Task: ${task.slice(0, 80)}...`);
  log(`Max retries: ${MAX_RETRIES}`);
  log('');

  if (DRY_RUN) {
    log('[dry-run] Step 1: agent_run(type=claude) — execute task');
    log('[dry-run] Step 2: agent_run(type=codex, schema=ReviewResult) — review');
    log('[dry-run] Step 2 loops up to ' + MAX_RETRIES + ' times if not clean');
    log('[dry-run] Done.');
    return;
  }

  // ── Step 1: Execute ──────────────────────────────────────────────────────
  log('Step 1/2: execute_task (claude)');
  const executeStart = Date.now();

  const executeResult = await runAgent('claude', task);
  const executeSummary = executeResult.text.slice(0, 500);

  const executeStep = {
    id: 'execute',
    function: 'execute_task',
    agent: 'claude',
    startedAt: new Date(executeStart).toISOString(),
    durationMs: Date.now() - executeStart,
    outputLength: executeResult.text.length,
    summary: executeSummary.slice(0, 200),
  };
  audit.steps.push(executeStep);
  log(`  Done (${executeStep.durationMs}ms, ${executeResult.text.length} chars)`);

  // ── Step 2: Review-fix loop ──────────────────────────────────────────────
  let reviewResult = null;
  let iteration = 0;
  let previousFindings = [];

  while (iteration < MAX_RETRIES) {
    iteration++;
    log(`Step 2/2: fix_and_review — iteration ${iteration}/${MAX_RETRIES}`);
    const iterStart = Date.now();

    // Fix pass (skip on first iteration if no findings)
    if (previousFindings.length > 0) {
      log('  Fixing findings...');
      const fixPrompt = [
        'Fix the following issues found during code review.',
        '',
        'Original task:',
        task,
        '',
        'Findings to fix:',
        ...previousFindings.map((f, i) => `${i + 1}. ${f}`),
        '',
        'Fix every finding. Do not introduce new issues.',
      ].join('\n');

      await runAgent('claude', fixPrompt);
      log('  Fix complete.');
    }

    // Review pass
    log('  Reviewing (codex)...');
    const reviewPrompt = [
      'Review the following implementation against the blueprint.',
      '',
      '## Task',
      task,
      '',
      '## What was implemented',
      executeSummary,
      '',
      '## Blueprint (acceptance criteria)',
      blueprint,
      '',
      'List actionable findings with confidence >= 80.',
      'Set clean=true only if no actionable findings remain.',
    ].join('\n');

    const { result } = await runAgent('codex', reviewPrompt, { schema: REVIEW_SCHEMA });

    const iterStep = {
      id: `review_iteration_${iteration}`,
      function: 'fix_and_review',
      agents: previousFindings.length > 0 ? ['claude', 'codex'] : ['codex'],
      iteration,
      durationMs: Date.now() - iterStart,
      result: result || { clean: false, summary: 'parse error', findings: [] },
    };
    audit.steps.push(iterStep);

    if (!result) {
      log(`  Review parse error — treating as not clean`);
      previousFindings = ['Review response was not parseable JSON'];
      continue;
    }

    log(`  clean=${result.clean}, findings=${result.findings?.length || 0}`);
    if (result.summary) log(`  summary: ${result.summary.slice(0, 120)}`);

    if (result.clean) {
      reviewResult = result;
      break;
    }

    previousFindings = result.findings || [];
    if (previousFindings.length === 0) {
      log('  Not clean but no findings — treating as clean');
      reviewResult = result;
      break;
    }
  }

  // ── Audit ────────────────────────────────────────────────────────────────
  audit.result = reviewResult || { clean: false, summary: 'max retries exceeded' };
  audit.completedAt = new Date().toISOString();
  audit.totalIterations = iteration;
  audit.success = !!reviewResult?.clean;

  const auditPath = resolve(REPO_ROOT, '.compose/pipeline-audit.json');
  mkdirSync(dirname(auditPath), { recursive: true });
  writeFileSync(auditPath, JSON.stringify(audit, null, 2) + '\n');

  log('');
  log(`Result: ${audit.success ? 'CLEAN' : 'NOT CLEAN'} after ${iteration} iteration(s)`);
  log(`Audit trace: .compose/pipeline-audit.json`);
  log(`Total steps: ${audit.steps.length}`);

  if (!audit.success) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  log(`FATAL: ${err.message}`);
  audit.result = { clean: false, summary: err.message };
  audit.completedAt = new Date().toISOString();
  const auditPath = resolve(REPO_ROOT, '.compose/pipeline-audit.json');
  mkdirSync(dirname(auditPath), { recursive: true });
  writeFileSync(auditPath, JSON.stringify(audit, null, 2) + '\n');
  process.exitCode = 1;
});
