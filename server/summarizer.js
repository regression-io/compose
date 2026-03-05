/**
 * summarizer.js — Spawn a Claude CLI subprocess to summarize batch events as JSON.
 *
 * Model-agnostic: defaults to haiku for cost efficiency but accepts any model.
 * Extracted from SessionManager for independent reuse and testing.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const DEFAULT_MODEL = process.env.SUMMARIZER_MODEL || 'haiku';

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Format batch events into a prompt asking the model for structured JSON.
 *
 * @param {Array} batch — array of buffered tool-use events
 * @param {string} [projectRoot]
 * @returns {string}
 */
export function buildSummaryPrompt(batch, projectRoot = PROJECT_ROOT) {
  const eventLines = batch.map(evt => {
    const itemLabel = evt.itemTitles.length > 0
      ? ` [${evt.itemTitles.join(', ')}]`
      : '';
    const fileLabel = evt.filePath
      ? ` on ${path.relative(projectRoot, evt.filePath) || evt.filePath}`
      : ' on (no file)';
    return `- ${evt.tool}${fileLabel}${itemLabel}: ${evt.input}`;
  }).join('\n');

  return `Summarize these developer tool actions as a JSON object. Return ONLY valid JSON, no markdown.

Events:
${eventLines}

JSON schema:
{
  "summary": "one sentence describing what these actions accomplish together",
  "intent": "feature|bugfix|refactor|test|docs|config|debug",
  "component": "which part of the system (derived from file paths)",
  "complexity": "trivial|low|medium|high",
  "signals": ["string tags like new_file, error_handling, api_change, test_added"],
  "status_hint": "review_ready|needs_test|blocked|null"
}`;
}

// ---------------------------------------------------------------------------
// Summarize caller
// ---------------------------------------------------------------------------

/**
 * Spawn `claude -p <prompt> --model <model> --max-turns 1` with CLAUDECODE unset.
 * Parse JSON from output. Returns parsed object or null on failure.
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @param {string} [opts.model]       — model to use (default: haiku or SUMMARIZER_MODEL env)
 * @param {string} [opts.projectRoot]
 * @returns {Promise<object|null>}
 */
export function summarize(prompt, { model = DEFAULT_MODEL, projectRoot = PROJECT_ROOT } = {}) {
  return new Promise((resolve) => {
    const cleanEnv = { ...process.env, NO_COLOR: '1' };
    delete cleanEnv.CLAUDECODE;

    const proc = spawn('claude', [
      '-p', prompt,
      '--model', model,
      '--max-turns', '1',
    ], {
      cwd: projectRoot,
      env: cleanEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('error', (err) => {
      console.error('[session] Summarizer spawn error:', err.message);
      resolve(null);
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`[session] Summarizer exited with code ${code}:`, stderr.slice(0, 200));
        resolve(null);
        return;
      }

      try {
        const json = extractJSON(stdout);
        resolve(json);
      } catch (err) {
        console.error('[session] Summarizer JSON parse failed:', err.message, 'raw:', stdout.slice(0, 300));
        resolve(null);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// JSON extractor
// ---------------------------------------------------------------------------

/**
 * Extract JSON from model output, handling possible markdown fences.
 *
 * @param {string} text — raw stdout
 * @returns {object}
 * @throws {Error} if no JSON found
 */
export function extractJSON(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      return JSON.parse(fenceMatch[1].trim());
    }
    const braceMatch = trimmed.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      return JSON.parse(braceMatch[0]);
    }
    throw new Error('No JSON found in output');
  }
}
