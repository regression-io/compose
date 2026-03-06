/**
 * lifecycle-constants.js — Shared constants derived from contracts/lifecycle.json.
 *
 * The contract is the single source of truth for phases, transitions, policies,
 * artifacts, and iteration defaults. This module reads it at import time and
 * exports the same shapes all consumers expect.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = resolve(__dirname, '..', 'contracts', 'lifecycle.json');
const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));

export const PHASES = contract.phases.map(p => p.id);

export const TERMINAL = new Set(contract.terminal);

export const SKIPPABLE = new Set(contract.phases.filter(p => p.skippable).map(p => p.id));

export const TRANSITIONS = contract.transitions;

export const ITERATION_DEFAULTS = contract.iterationDefaults;

export const PHASE_ARTIFACTS = Object.fromEntries(
  contract.phases.filter(p => p.artifact).map(p => [p.id, p.artifact])
);

/** Default policy modes per phase, derived from contract. */
export const DEFAULT_POLICIES = Object.fromEntries(
  contract.phases.filter(p => p.defaultPolicy).map(p => [p.id, p.defaultPolicy])
);

/** Valid gate outcomes. */
export const VALID_GATE_OUTCOMES = contract.gateOutcomes;

/** The raw contract object, for tools that need full phase metadata. */
export const CONTRACT = contract;
