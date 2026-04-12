/**
 * team-flag.js — --team CLI flag parsing for COMP-TEAMS.
 *
 * Extracted from compose.js for testability (compose.js has top-level
 * side effects that prevent clean import in test files).
 */

export const KNOWN_TEAMS = ['review', 'research', 'feature'];

/**
 * Parse and validate the --team flag from CLI args.
 * Rewrites --team <name> into a template name and strips it from args.
 *
 * @param {string[]} args - CLI arguments (after subcommand is stripped)
 * @returns {{ template: string|null, args: string[] }}
 * @throws {Error} On invalid usage
 */
export function parseTeamFlag(args) {
  const teamIdx = args.indexOf('--team');
  if (teamIdx === -1) return { template: null, args: [...args] };

  const teamName = args[teamIdx + 1];
  if (!teamName || teamName.startsWith('-')) {
    throw new Error('--team requires a team name (available: ' + KNOWN_TEAMS.join(', ') + ')');
  }

  if (!KNOWN_TEAMS.includes(teamName)) {
    throw new Error(`Unknown team "${teamName}". Available: ${KNOWN_TEAMS.join(', ')}`);
  }

  if (args.includes('--template')) {
    throw new Error('--team cannot be used with --template');
  }

  const cleaned = args.filter((_, i) => i !== teamIdx && i !== teamIdx + 1);

  if (cleaned.includes('--all')) {
    throw new Error('--team cannot be used with batch builds (--all or multiple features)');
  }
  const featureCodes = cleaned.filter(a => !a.startsWith('-'));
  if (featureCodes.length > 1) {
    throw new Error('--team cannot be used with batch builds (--all or multiple features)');
  }

  return { template: `team-${teamName}`, args: cleaned };
}
