/**
 * questionnaire.js — Interactive pre-flight for compose new.
 *
 * Asks the user questions to refine intent before launching the pipeline.
 * Supports: single-line input, multi-choice, yes/no, free-form notes.
 */

import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function createRL(opts = {}) {
  return createInterface({
    input: opts.input ?? process.stdin,
    output: opts.output ?? process.stdout,
  });
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

// ---------------------------------------------------------------------------
// Question types
// ---------------------------------------------------------------------------

async function askText(rl, prompt, defaultVal = '') {
  const suffix = defaultVal ? ` [${defaultVal}]` : '';
  const answer = await ask(rl, `  ${prompt}${suffix}: `);
  return answer.trim() || defaultVal;
}

async function askChoice(rl, prompt, options, defaultVal = '') {
  const defaultIdx = defaultVal ? options.indexOf(defaultVal) : -1;
  const defaultNum = defaultIdx >= 0 ? defaultIdx + 1 : 1;
  console.log(`  ${prompt}`);
  for (let i = 0; i < options.length; i++) {
    const marker = i === defaultNum - 1 ? ' *' : '';
    console.log(`    ${i + 1}. ${options[i]}${marker}`);
  }
  const answer = await ask(rl, `  Choice [${defaultNum}]: `);
  const idx = parseInt(answer.trim(), 10) - 1;
  return options[idx >= 0 && idx < options.length ? idx : defaultNum - 1];
}

async function askYesNo(rl, prompt, defaultVal = true) {
  const hint = defaultVal ? '[Y/n]' : '[y/N]';
  const answer = await ask(rl, `  ${prompt} ${hint}: `);
  const a = answer.trim().toLowerCase();
  if (!a) return defaultVal;
  return a === 'y' || a === 'yes';
}

async function askMultiline(rl, prompt) {
  console.log(`  ${prompt} (blank line to finish):`);
  const lines = [];
  while (true) {
    const line = await ask(rl, '  > ');
    if (!line.trim()) break;
    lines.push(line);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main questionnaire
// ---------------------------------------------------------------------------

/**
 * Run the interactive questionnaire.
 *
 * @param {string} name - Project name
 * @param {string} intent - Initial intent from CLI
 * @param {object} [opts]
 * @param {boolean} [opts.hasExistingContent] - Whether the project dir has existing files
 * @returns {Promise<{ enrichedIntent: string, options: object }>}
 */
// ---------------------------------------------------------------------------
// Persistence — save/load previous answers
// ---------------------------------------------------------------------------

function loadPrevious(cwd) {
  const p = join(cwd, '.compose', 'questionnaire.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return {}; }
}

function savePrevious(cwd, answers) {
  const dir = join(cwd, '.compose');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'questionnaire.json'), JSON.stringify(answers, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Main questionnaire
// ---------------------------------------------------------------------------

export async function runQuestionnaire(name, intent, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const prev = loadPrevious(cwd);
  const rl = createRL();

  console.log(`\n  Setting up: ${name}`);
  console.log(`  Intent: ${intent}\n`);
  if (Object.keys(prev).length > 0) {
    console.log('  (Previous answers loaded as defaults — press Enter to keep)\n');
  }

  try {
    // 1. Refine intent
    const refined = await askText(rl, 'Refine the description (or press Enter to keep)', prev.refined ?? intent);

    // 2. Project type
    const projectType = await askChoice(rl, 'What kind of project?', [
      'CLI tool',
      'Web API / server',
      'Library / SDK',
      'Full-stack app',
      'Other',
    ], prev.projectType);

    // 3. Language/runtime
    const language = await askChoice(rl, 'Primary language/runtime?', [
      'Node.js (JavaScript)',
      'Node.js (TypeScript)',
      'Python',
      'Go',
      'Rust',
      'Other',
    ], prev.language);

    // 4. Complexity
    const complexity = await askChoice(rl, 'Scope?', [
      'Small (1-3 features, single module)',
      'Medium (3-8 features, multiple modules)',
      'Large (8+ features, multi-component)',
    ], prev.complexity);

    // 5. Research
    const doResearch = await askYesNo(rl, 'Research prior art before brainstorming?', prev.doResearch ?? true);

    // 6. Additional context
    const hasNotes = await askYesNo(rl, 'Any additional context or constraints to add?', prev.notes ? true : false);
    let notes = '';
    if (hasNotes) {
      if (prev.notes) console.log(`  Previous notes: ${prev.notes.split('\n')[0]}...`);
      notes = await askMultiline(rl, 'Type your notes (or blank to keep previous)');
      if (!notes && prev.notes) notes = prev.notes;
    }

    // 7. Review agents
    const reviewAgent = await askChoice(rl, 'Who should review designs?', [
      'Human (gate prompt)',
      'Codex (automated review)',
      'Skip review',
    ], prev.reviewAgent);

    // 8. Confirm
    console.log('\n  Summary:');
    console.log(`    Project:    ${name}`);
    console.log(`    Type:       ${projectType}`);
    console.log(`    Language:   ${language}`);
    console.log(`    Scope:      ${complexity}`);
    console.log(`    Research:   ${doResearch ? 'yes' : 'skip'}`);
    console.log(`    Review:     ${reviewAgent}`);
    if (notes) console.log(`    Notes:      ${notes.split('\n')[0]}...`);

    const proceed = await askYesNo(rl, '\n  Launch kickoff?', true);
    if (!proceed) {
      console.log('  Aborted.');
      return null;
    }

    // Save answers for next run
    savePrevious(cwd, { refined, projectType, language, complexity, doResearch, notes, reviewAgent });

    // Build enriched intent
    const parts = [refined];
    parts.push(`\n## Project Constraints`);
    parts.push(`- Type: ${projectType}`);
    parts.push(`- Language/Runtime: ${language}`);
    parts.push(`- Scope: ${complexity}`);
    if (notes) parts.push(`\n## Additional Context\n${notes}`);

    return {
      enrichedIntent: parts.join('\n'),
      options: {
        projectType,
        language,
        complexity,
        doResearch,
        reviewAgent,
        notes,
      },
    };

  } finally {
    rl.close();
  }
}
