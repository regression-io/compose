/**
 * gate-prompt.js — CLI readline interface for gate resolution.
 *
 * Prompts the user to approve, revise, or kill a gate dispatch,
 * collecting an outcome and rationale.
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
 * @param {NodeJS.ReadableStream} [options.input] - Readable stream (default: process.stdin)
 * @param {NodeJS.WritableStream} [options.output] - Writable stream (default: process.stdout)
 * @returns {Promise<{ outcome: string, rationale: string }>}
 */
export async function promptGate(gateDispatch, { input, output } = {}) {
  const rl = createInterface({
    input: input ?? process.stdin,
    output: output ?? process.stdout,
  });

  try {
    const { step_id, on_approve, on_revise, on_kill } = gateDispatch;

    rl.output.write(
      `Gate: ${step_id}\n` +
      `  Approve → ${on_approve ?? '(complete)'}\n` +
      `  Revise  → ${on_revise ?? '(kill)'}\n` +
      `  Kill    → ${on_kill ?? '(terminate)'}\n`,
    );

    // Prompt for outcome
    let outcome;
    while (!outcome) {
      const raw = await ask(rl, '[a]pprove / [r]evise / [k]ill: ');
      const key = raw.trim().toLowerCase();
      if (OUTCOME_MAP[key]) {
        outcome = OUTCOME_MAP[key];
      } else {
        rl.output.write('Invalid choice. Enter a, r, or k.\n');
      }
    }

    // Prompt for rationale
    let rationale;
    while (!rationale) {
      const raw = await ask(rl, 'Rationale: ');
      const trimmed = raw.trim();
      if (trimmed) {
        rationale = trimmed;
      } else {
        rl.output.write('Rationale required.\n');
      }
    }

    return { outcome, rationale };
  } finally {
    rl.close();
  }
}
