/**
 * gate-prompt.js — CLI readline interface for gate resolution.
 *
 * Prompts the user to approve, revise, or kill a gate dispatch,
 * with interactive Q&A: typing a question dispatches it to an agent
 * that reads the artifact and answers.
 */
import { createInterface } from 'node:readline';

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const ESC = '\x1b[';
const RESET   = `${ESC}0m`;
const BOLD    = `${ESC}1m`;
const DIM     = `${ESC}2m`;
const CYAN    = `${ESC}36m`;
const GREEN   = `${ESC}32m`;
const RED     = `${ESC}31m`;
const YELLOW  = `${ESC}33m`;
const GRAY    = `${ESC}90m`;

const OUTCOME_MAP = {
  a: 'approve',
  approve: 'approve',
  r: 'revise',
  revise: 'revise',
  k: 'kill',
  kill: 'kill',
};

// ---------------------------------------------------------------------------
// COMP-UX-3b: Generate a recommendation sentence and default action from the
// gate's artifact assessment (if present in gateExtras.artifactAssessment).
// ---------------------------------------------------------------------------

/**
 * Build a 1-sentence recommendation from gate metadata.
 * Returns { sentence, defaultOutcome } where defaultOutcome is 'approve' or 'revise'.
 */
function buildRecommendation(gateDispatch, gateExtras) {
  const assessment = gateExtras?.artifactAssessment;
  const summary = gateExtras?.summary;

  // If there's an explicit summary from Stratum, use it
  if (summary) {
    const defaultOutcome = /critical|error|fail|missing/i.test(summary) ? 'revise' : 'approve';
    const action = defaultOutcome === 'approve' ? 'Ship it?' : 'Revise?';
    return { sentence: `${summary} ${action}`, defaultOutcome };
  }

  if (!assessment) {
    return { sentence: null, defaultOutcome: null };
  }

  // Missing artifact — never recommend approve
  if (assessment.exists === false) {
    return { sentence: 'Required artifact is missing. Revise?', defaultOutcome: 'revise' };
  }

  const { completeness, wordCount, sections, meetsMinWordCount, findings } = assessment;

  // Count critical findings
  const criticalCount = (findings ?? []).filter(
    f => /critical|error|fatal/i.test(f.severity ?? f.level ?? '')
  ).length;
  const findingCount = (findings ?? []).length;
  const missingCount = sections?.missing?.length ?? 0;

  if (criticalCount > 0) {
    return {
      sentence: `${criticalCount} critical finding${criticalCount > 1 ? 's' : ''}. Revise?`,
      defaultOutcome: 'revise',
    };
  }

  if (!meetsMinWordCount && wordCount !== undefined) {
    return {
      sentence: `Artifact is thin (${wordCount} words). Revise?`,
      defaultOutcome: 'revise',
    };
  }

  if (missingCount > 0) {
    return {
      sentence: `Missing ${missingCount} section${missingCount > 1 ? 's' : ''} (${(sections.missing ?? []).slice(0, 2).join(', ')}). Revise?`,
      defaultOutcome: 'revise',
    };
  }

  if (findingCount > 0) {
    return {
      sentence: `${findingCount} finding${findingCount > 1 ? 's' : ''}, ${Math.round((completeness ?? 1) * 100)}% complete. Ship it?`,
      defaultOutcome: 'approve',
    };
  }

  const pct = completeness !== undefined ? `${Math.round(completeness * 100)}% complete` : null;
  const wc = wordCount !== undefined ? `${wordCount} words` : null;
  const detail = [pct, wc].filter(Boolean).join(', ');
  return {
    sentence: detail ? `${detail}. Ship it?` : 'Ready to proceed? Ship it?',
    defaultOutcome: 'approve',
  };
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

/**
 * Render a boxed gate panel with artifact, phase, and action info.
 * COMP-UX-3b: Shows a recommendation sentence and accepts Enter as default.
 */
function drawGatePanel(out, gateDispatch, { artifact, gateExtras } = {}) {
  const { step_id, on_approve, on_revise, on_kill } = gateDispatch;
  const cols = (out.columns ?? process.stdout.columns) || 80;
  const innerW = Math.max(40, Math.min(cols - 6, 70));

  const pad = (str, w) => {
    const plainLen = str.replace(/\x1b\[[0-9;]*m/g, '').length;
    return plainLen >= w ? str : str + ' '.repeat(w - plainLen);
  };

  const line = (content) => `  \u2502 ${pad(content, innerW)} \u2502`;
  const empty = line('');
  const topLabel = ` Gate: ${step_id} `;
  const topRule = '\u2500'.repeat(Math.max(0, innerW + 2 - topLabel.length - 1));
  const bottomRule = '\u2500'.repeat(innerW + 2);

  // COMP-UX-3b: build recommendation
  const { sentence: recSentence, defaultOutcome } = buildRecommendation(gateDispatch, gateExtras);
  const recColor = defaultOutcome === 'approve' ? GREEN : YELLOW;
  const defaultLabel = defaultOutcome === 'approve' ? 'a' : 'r';

  out.write(`  \u250C\u2500${BOLD}${CYAN}${topLabel}${RESET}${topRule}\u2510\n`);
  out.write(empty + '\n');

  if (artifact) {
    out.write(line(`${DIM}Artifact:${RESET} ${artifact}`) + '\n');
  }

  if (gateExtras) {
    const from = gateExtras.fromPhase ?? '?';
    const to = gateExtras.toPhase ?? '?';
    out.write(line(`${DIM}Phase:${RESET}    ${from} \u2192 ${to}`) + '\n');
  }

  // Recommendation line
  if (recSentence) {
    out.write(empty + '\n');
    out.write(line(`${recColor}${BOLD}${recSentence}${RESET}`) + '\n');
    out.write(line(`${DIM}[Enter] = ${defaultOutcome}   [d] = show details${RESET}`) + '\n');
  }

  out.write(empty + '\n');
  out.write(line(`${GREEN}[a]${RESET} Approve  \u2192  ${on_approve ?? '(complete)'}`) + '\n');
  out.write(line(`${YELLOW}[r]${RESET} Revise   \u2192  ${on_revise ?? '(kill)'}`) + '\n');
  out.write(line(`${RED}[k]${RESET} Kill     \u2192  ${on_kill ?? '(terminate)'}`) + '\n');
  out.write(empty + '\n');
  out.write(line(`${DIM}Type a question to ask the agent.${RESET}`) + '\n');
  out.write(`  \u2514${bottomRule}\u2518\n`);

  return { defaultOutcome, defaultLabel };
}

/**
 * Prompt the user to resolve a gate dispatch.
 *
 * @param {object} gateDispatch - Gate dispatch with step_id, on_approve, on_revise, on_kill
 * @param {object} [options]
 * @param {NodeJS.ReadableStream} [options.input]
 * @param {NodeJS.WritableStream} [options.output]
 * @param {string}   [options.artifact]    - Path to the artifact being reviewed
 * @param {Function} [options.askAgent]    - async (question, artifact) => answer string
 * @param {object}   [options.gateExtras]  - { fromPhase, toPhase } for panel display
 * @returns {Promise<{ outcome: string, rationale: string }>}
 */
export async function promptGate(gateDispatch, { input, output, artifact, askAgent, gateExtras, nonInteractive } = {}) {
  if (nonInteractive) {
    return { outcome: 'approve', rationale: 'auto-approved (--all mode)' };
  }

  const rl = createInterface({
    input: input ?? process.stdin,
    output: output ?? process.stdout,
  });

  try {
    const { step_id, on_approve, on_revise, on_kill } = gateDispatch;

    // COMP-UX-3b: drawGatePanel returns recommendation context
    const { defaultOutcome } = drawGatePanel(rl.output, gateDispatch, { artifact, gateExtras });

    // Full assessment detail for 'd' key
    const fullDetail = (() => {
      const assessment = gateExtras?.artifactAssessment;
      if (!assessment) return null;
      const lines = [];
      if (assessment.wordCount !== undefined) lines.push(`Words: ${assessment.wordCount}`);
      if (assessment.completeness !== undefined) lines.push(`Completeness: ${Math.round(assessment.completeness * 100)}%`);
      if (assessment.sections?.missing?.length) lines.push(`Missing sections: ${assessment.sections.missing.join(', ')}`);
      if (!assessment.meetsMinWordCount) lines.push('Below minimum word count');
      const findings = assessment.findings ?? [];
      if (findings.length) {
        lines.push(`Findings (${findings.length}):`);
        for (const f of findings.slice(0, 5)) {
          lines.push(`  - ${f.severity ?? f.level ?? '?'}: ${f.message ?? f.text ?? JSON.stringify(f)}`);
        }
        if (findings.length > 5) lines.push(`  ... and ${findings.length - 5} more`);
      }
      return lines.length ? lines.join('\n') : null;
    })();

    const notes = [];
    let outcome;

    while (!outcome) {
      const raw = await ask(rl, '\n> ');
      const trimmed = raw.trim();

      // COMP-UX-3b: Enter alone → use recommended default action (only if recommendation was shown)
      if (!trimmed && defaultOutcome) {
        outcome = defaultOutcome;
        rl.output.write(`  (using recommended: ${defaultOutcome})\n`);
        continue;
      }
      if (!trimmed) continue;  // no recommendation — ignore bare Enter

      const key = trimmed.toLowerCase();

      // COMP-UX-3b: 'd' shows full artifact detail
      if (key === 'd' || key === 'detail' || key === 'details') {
        if (fullDetail) {
          rl.output.write('\n  Artifact detail:\n');
          for (const l of fullDetail.split('\n')) rl.output.write(`  ${l}\n`);
        } else {
          rl.output.write('  (no artifact assessment available)\n');
        }
        continue;
      }

      if (OUTCOME_MAP[key]) {
        outcome = OUTCOME_MAP[key];
      } else if (askAgent) {
        // Dispatch question to agent
        rl.output.write('  Asking agent...\n');
        try {
          const answer = await askAgent(trimmed, artifact);
          rl.output.write(`\n  ${answer}\n`);
        } catch (err) {
          rl.output.write(`  (agent error: ${err.message})\n`);
        }
        notes.push(trimmed);
      } else {
        // No agent available — just collect as notes
        notes.push(trimmed);
        rl.output.write('  (noted — enter a/r/k when ready to decide)\n');
      }
    }

    // Build rationale
    let rationale;
    if (notes.length > 0) {
      rationale = notes.join('\n');
      const addMore = await ask(rl, '  Additional rationale (or Enter to use notes): ');
      if (addMore.trim()) {
        rationale += '\n' + addMore.trim();
      }
    } else if (outcome === 'approve') {
      rationale = 'approved';
    } else {
      while (!rationale) {
        const raw = await ask(rl, 'Rationale: ');
        const trimmed = raw.trim();
        if (trimmed) {
          rationale = trimmed;
        } else {
          rl.output.write('Rationale required.\n');
        }
      }
    }

    return { outcome, rationale };
  } finally {
    rl.close();
  }
}
