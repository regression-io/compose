import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTeamFlag, KNOWN_TEAMS } from '../lib/team-flag.js';

describe('KNOWN_TEAMS', () => {
  it('contains review, research, feature', () => {
    assert.ok(KNOWN_TEAMS.includes('review'));
    assert.ok(KNOWN_TEAMS.includes('research'));
    assert.ok(KNOWN_TEAMS.includes('feature'));
  });
});

// Note: parseTeamFlag receives args AFTER the subcommand is stripped
// (i.e., process.argv minus [node, script, cmd]). So args are like
// ['--team', 'review', 'FEAT-1'], not ['build', '--team', 'review', 'FEAT-1'].

describe('parseTeamFlag', () => {
  it('rewrites --team review to template team-review', () => {
    const result = parseTeamFlag(['--team', 'review', 'FEAT-1']);
    assert.equal(result.template, 'team-review');
    assert.deepEqual(result.args, ['FEAT-1']);
  });

  it('rewrites --team feature to template team-feature', () => {
    const result = parseTeamFlag(['--team', 'feature', 'FEAT-1']);
    assert.equal(result.template, 'team-feature');
  });

  it('returns null template when --team is absent', () => {
    const result = parseTeamFlag(['FEAT-1']);
    assert.equal(result.template, null);
    assert.deepEqual(result.args, ['FEAT-1']);
  });

  it('throws when --team has no value', () => {
    assert.throws(() => parseTeamFlag(['--team']), /requires a team name/);
  });

  it('throws when --team value starts with -', () => {
    assert.throws(() => parseTeamFlag(['--team', '--all']), /requires a team name/);
  });

  it('throws when --team is used with --all (batch)', () => {
    assert.throws(() => parseTeamFlag(['--team', 'review', '--all']), /cannot be used with batch/i);
  });

  it('throws when --team is used with multiple feature codes', () => {
    assert.throws(() => parseTeamFlag(['--team', 'review', 'FEAT-1', 'FEAT-2']), /cannot be used with batch/i);
  });

  it('throws when --team is used with --template', () => {
    assert.throws(() => parseTeamFlag(['--team', 'review', '--template', 'custom']), /cannot be used with --template/i);
  });

  it('throws for unknown team name', () => {
    assert.throws(() => parseTeamFlag(['--team', 'unknown']), /unknown team.*available/i);
  });
});
