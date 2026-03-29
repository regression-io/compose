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

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

/**
 * Render a boxed gate panel with artifact, phase, and action info.
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

  out.write(empty + '\n');
  out.write(line(`${GREEN}[a]${RESET} Approve  \u2192  ${on_approve ?? '(complete)'}`) + '\n');
  out.write(line(`${YELLOW}[r]${RESET} Revise   \u2192  ${on_revise ?? '(kill)'}`) + '\n');
  out.write(line(`${RED}[k]${RESET} Kill     \u2192  ${on_kill ?? '(terminate)'}`) + '\n');
  out.write(empty + '\n');
  out.write(line(`${DIM}Type a question to ask the agent.${RESET}`) + '\n');
  out.write(`  \u2514${bottomRule}\u2518\n`);
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

    drawGatePanel(rl.output, gateDispatch, { artifact, gateExtras });

    const notes = [];
    let outcome;

    while (!outcome) {
      const raw = await ask(rl, '\n> ');
      const trimmed = raw.trim();
      if (!trimmed) continue;

      const key = trimmed.toLowerCase();
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
