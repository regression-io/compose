/**
 * gate-prompt.js — CLI readline interface for gate resolution.
 *
 * Prompts the user to approve, revise, or kill a gate dispatch,
 * with interactive Q&A: typing a question dispatches it to an agent
 * that reads the artifact and answers.
 */
import { createInterface } from 'node:readline';

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
 * Prompt the user to resolve a gate dispatch.
 *
 * @param {object} gateDispatch - Gate dispatch with step_id, on_approve, on_revise, on_kill
 * @param {object} [options]
 * @param {NodeJS.ReadableStream} [options.input]
 * @param {NodeJS.WritableStream} [options.output]
 * @param {string}   [options.artifact]    - Path to the artifact being reviewed
 * @param {Function} [options.askAgent]    - async (question, artifact) => answer string
 * @returns {Promise<{ outcome: string, rationale: string }>}
 */
export async function promptGate(gateDispatch, { input, output, artifact, askAgent, nonInteractive } = {}) {
  if (nonInteractive) {
    return { outcome: 'approve', rationale: 'auto-approved (--all mode)' };
  }

  const rl = createInterface({
    input: input ?? process.stdin,
    output: output ?? process.stdout,
  });

  try {
    const { step_id, on_approve, on_revise, on_kill } = gateDispatch;

    rl.output.write(
      `  [a]pprove → ${on_approve ?? '(complete)'}\n` +
      `  [r]evise  → ${on_revise ?? '(kill)'}\n` +
      `  [k]ill    → ${on_kill ?? '(terminate)'}\n` +
      `  Or type a question to ask the agent.\n`,
    );

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
