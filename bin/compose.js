#!/usr/bin/env node
/**
 * compose CLI
 *
 * compose init     — initialize Compose in the current project (project-local)
 * compose setup    — install global skill + register stratum-mcp (user-global)
 * compose install  — run init + setup (backwards-compat alias)
 * compose start    — start the compose app (supervisor.js)
 * compose build    — headless feature lifecycle runner
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync, readdirSync } from 'fs'
import { resolve, join, basename, dirname } from 'path'
import { homedir } from 'os'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { findProjectRoot } from '../server/find-root.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(__dirname, '..')

// ---------------------------------------------------------------------------
// --team flag (COMP-TEAMS)
// ---------------------------------------------------------------------------

export const KNOWN_TEAMS = ['review', 'research', 'feature'];

/**
 * Parse and validate the --team flag from CLI args.
 * Rewrites --team <name> into a template name and strips it from args.
 *
 * @param {string[]} args - Raw CLI arguments
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
  if (featureCodes.length > 2) {
    throw new Error('--team cannot be used with batch builds (--all or multiple features)');
  }

  return { template: `team-${teamName}`, args: cleaned };
}

const [,, cmd, ...args] = process.argv

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log('Usage: compose <command>')
  console.log('')
  console.log('Commands:')
  console.log('  new       Kickoff a product (research, brainstorm, roadmap, scaffold)')
  console.log('  import    Scan existing project and generate structured analysis')
  console.log('  feature   Add a single feature (folder, design seed, ROADMAP entry)')
  console.log('  build     Run a feature through the headless lifecycle')
  console.log('  pipeline  View and edit the build pipeline')
  console.log('  roadmap            Show roadmap status and next buildable features')
  console.log('  roadmap generate   Regenerate ROADMAP.md from feature.json files')
  console.log('  roadmap migrate    Extract ROADMAP.md entries into feature.json files')
  console.log('  roadmap check      Verify feature.json and ROADMAP.md are in sync')
  console.log('  triage    Analyze a feature and recommend build profile')
  console.log('  qa-scope  Show affected routes from a feature\'s changed files')
  console.log('  init      Initialize Compose in the current project')
  console.log('  setup     Install global skill + register stratum-mcp')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// compose init — project-local setup
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Agent detection + skill installation
// ---------------------------------------------------------------------------

function detectAgents() {
  const agents = []
  const home = homedir()

  // Claude Code
  const hasClaude = spawnSync('which', ['claude'], { encoding: 'utf-8' }).status === 0
    || existsSync(join(home, '.claude'))
  if (hasClaude) {
    agents.push({ name: 'claude', skillDir: join(home, '.claude', 'skills', 'stratum') })
  }

  // Codex (via opencode) — shares ~/.claude/skills/ with Claude Code
  const hasCodex = spawnSync('which', ['opencode'], { encoding: 'utf-8' }).status === 0
    || existsSync(join(home, '.codex'))
  if (hasCodex) {
    agents.push({ name: 'codex', skillDir: join(home, '.claude', 'skills', 'stratum'), sharedWith: 'claude' })
  }

  // Gemini CLI
  const hasGemini = spawnSync('which', ['gemini-cli'], { encoding: 'utf-8' }).status === 0
    || existsSync(join(home, '.gemini'))
  if (hasGemini) {
    agents.push({ name: 'gemini', skillDir: join(home, '.gemini', 'skills', 'stratum') })
  }

  return agents
}

/**
 * Sync compose-owned skills to ~/.claude/skills/ (and other agent skill dirs).
 * Copies all skills from source dirs, removes previously-installed skills that
 * no longer exist in source. Tracks installed set via a manifest file.
 *
 * Source dirs:
 *   - PACKAGE_ROOT/.claude/skills/*   (compose skill)
 *   - PACKAGE_ROOT/skills/*           (stratum base skill)
 */
function syncSkills(agents) {
  // Collect source skills: { name -> sourcePath }
  const sourceSkills = new Map()
  const skillSourceDirs = [
    join(PACKAGE_ROOT, '.claude', 'skills'),
    join(PACKAGE_ROOT, 'skills'),
  ]
  for (const dir of skillSourceDirs) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir)) {
      const skillFile = join(dir, entry, 'SKILL.md')
      if (existsSync(skillFile)) {
        sourceSkills.set(entry, skillFile)
      }
    }
  }

  if (sourceSkills.size === 0) {
    console.log('Warning: no skills found to install')
    return
  }

  console.log('\nSyncing skills...')
  const syncedRoots = new Set()
  for (const agent of agents) {
    if (agent.name === 'gemini') {
      console.log(`  - ${agent.name} — detected but skill sync skipped (unverified path)`)
      continue
    }
    // Skip if this agent shares a skill dir already synced (e.g. codex → ~/.claude/skills/)
    const agentRoot = dirname(agent.skillDir)
    if (syncedRoots.has(agentRoot)) {
      console.log(`  ~ ${agent.name} — shares skill dir with ${agent.sharedWith ?? 'another agent'}, skipped`)
      continue
    }
    syncedRoots.add(agentRoot)

    const agentSkillsRoot = agentRoot
    const manifestPath = join(agentSkillsRoot, '.compose-skills.json')

    // Load previous manifest
    let previousSkills = []
    if (existsSync(manifestPath)) {
      try { previousSkills = JSON.parse(readFileSync(manifestPath, 'utf-8')) } catch {}
    }

    // Install current skills
    for (const [name, srcPath] of sourceSkills) {
      const destDir = join(agentSkillsRoot, name)
      mkdirSync(destDir, { recursive: true })
      copyFileSync(srcPath, join(destDir, 'SKILL.md'))
      console.log(`  + ${agent.name}/${name}`)
    }

    // Remove skills we previously installed that no longer exist in source
    const removed = previousSkills.filter(name => !sourceSkills.has(name))
    for (const name of removed) {
      const destDir = join(agentSkillsRoot, name)
      if (existsSync(destDir)) {
        rmSync(destDir, { recursive: true })
        console.log(`  - ${agent.name}/${name} (removed)`)
      }
    }

    // Write updated manifest
    writeFileSync(manifestPath, JSON.stringify([...sourceSkills.keys()], null, 2))
  }

  // Report undetected agents
  const detected = new Set(agents.map(a => a.name))
  for (const name of ['claude', 'codex', 'gemini']) {
    if (!detected.has(name)) {
      console.log(`  - ${name} — not found`)
    }
  }
}

// ---------------------------------------------------------------------------
// compose init — project-local setup
// ---------------------------------------------------------------------------

async function runInit(flags) {
  const noStratum = flags.includes('--no-stratum')
  const noLifecycle = flags.includes('--no-lifecycle')
  const cwd = process.cwd()

  // 1. Create .compose/ directory
  const composeDir = join(cwd, '.compose')
  mkdirSync(composeDir, { recursive: true })

  // 2. Detect / auto-install stratum
  let hasStratum = !noStratum && spawnSync('which', ['stratum-mcp'], { encoding: 'utf-8' }).status === 0
  if (!noStratum && !hasStratum) {
    console.log('stratum-mcp not found — installing via pip...')
    const pipResult = spawnSync('pip', ['install', 'stratum'], {
      stdio: 'inherit',
      encoding: 'utf-8',
    })
    if (pipResult.status === 0) {
      // Verify the binary is now on PATH
      hasStratum = spawnSync('which', ['stratum-mcp'], { encoding: 'utf-8' }).status === 0
      if (hasStratum) {
        console.log('stratum-mcp installed successfully')
      } else {
        console.warn('Warning: pip install stratum succeeded but stratum-mcp not found on PATH')
      }
    } else {
      console.warn('Warning: pip install stratum failed — Stratum will be disabled')
      console.warn('  Install manually: pip install stratum')
    }
  }
  const hasLifecycle = !noLifecycle

  // 3. Detect agents
  const agents = detectAgents()

  // 4. Write .compose/compose.json (merge with existing if present)
  const configPath = join(composeDir, 'compose.json')
  let existing = {}
  if (existsSync(configPath)) {
    try { existing = JSON.parse(readFileSync(configPath, 'utf-8')) } catch {}
  }

  const agentsConfig = {}
  for (const agent of agents) {
    agentsConfig[agent.name] = { detected: true, skillInstalled: agent.name !== 'gemini' }
  }
  for (const name of ['claude', 'codex', 'gemini']) {
    if (!agentsConfig[name]) {
      agentsConfig[name] = { detected: false }
    }
  }

  const config = {
    version: 2,
    capabilities: {
      ...(existing.capabilities || {}),
      stratum: hasStratum,
      lifecycle: hasLifecycle,
    },
    agents: {
      ...(existing.agents || {}),
      ...agentsConfig,
    },
    paths: {
      docs: 'docs',
      features: 'docs/features',
      journal: 'docs/journal',
      context: 'docs/context',
      ideabox: 'docs/product/ideabox.md',
      ...(existing.paths || {}),
    },
  }

  // Flags override existing values
  if (noStratum) config.capabilities.stratum = false
  if (noLifecycle) config.capabilities.lifecycle = false

  writeFileSync(configPath, JSON.stringify(config, null, 2))
  console.log(`Wrote ${configPath}`)

  // 5. Create .compose/data/
  mkdirSync(join(composeDir, 'data'), { recursive: true })

  // 5b. Scaffold docs/context/ with ambient context templates
  const contextDir = join(cwd, config.paths.context)
  mkdirSync(contextDir, { recursive: true })
  const contextTemplates = {
    'tech-stack.md': '# Tech Stack\n\nDescribe your technology stack here.\n',
    'conventions.md': '# Conventions\n\nDescribe coding conventions here.\n',
    'decisions.md': '# Decision Log\n\nDecisions accumulate here during builds.\n',
  }
  for (const [filename, content] of Object.entries(contextTemplates)) {
    const dest = join(contextDir, filename)
    if (!existsSync(dest)) {
      writeFileSync(dest, content)
      console.log(`Created ${dest}`)
    }
  }

  // 5c. Scaffold docs/product/ideabox.md if absent
  const ideaboxRel = config.paths.ideabox || 'docs/product/ideabox.md'
  const ideaboxDest = join(cwd, ideaboxRel)
  if (!existsSync(ideaboxDest)) {
    mkdirSync(dirname(ideaboxDest), { recursive: true })
    const { IDEABOX_TEMPLATE } = await import('../lib/ideabox.js')
    writeFileSync(ideaboxDest, IDEABOX_TEMPLATE)
    console.log(`Created ${ideaboxDest}`)
  }

  // 6. Register compose-mcp in .mcp.json
  const mcpPath = join(cwd, '.mcp.json')
  let mcpConfig = {}
  if (existsSync(mcpPath)) {
    try { mcpConfig = JSON.parse(readFileSync(mcpPath, 'utf-8')) } catch {}
  }
  mcpConfig.mcpServers = mcpConfig.mcpServers || {}
  mcpConfig.mcpServers.compose = {
    command: 'node',
    args: [join(PACKAGE_ROOT, 'server', 'compose-mcp.js')],
  }
  // Register agents MCP server (provides agent_run for codex reviews)
  if (!mcpConfig.mcpServers.agents) {
    mcpConfig.mcpServers.agents = {
      command: 'node',
      args: [join(PACKAGE_ROOT, 'server', 'agent-mcp.js')],
    }
    console.log('Registered agents MCP server in .mcp.json')
  }
  if (hasStratum && !mcpConfig.mcpServers.stratum) {
    // Use absolute path — miniconda/pip binaries may not be on Claude Code's PATH
    const stratumPath = spawnSync('which', ['stratum-mcp'], { encoding: 'utf-8' }).stdout.trim()
    mcpConfig.mcpServers.stratum = {
      command: stratumPath || 'stratum-mcp',
    }
    console.log('Registered stratum-mcp in .mcp.json')
  }
  writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2))
  console.log(`Registered compose-mcp + agents in ${mcpPath}`)

  // 6b. Run stratum-mcp install to register hooks + CLAUDE.md in this project
  if (hasStratum) {
    console.log('Running stratum-mcp install for hooks...')
    const stratumResult = spawnSync('stratum-mcp', ['install'], { cwd, stdio: 'inherit' })
    if (stratumResult.status !== 0) {
      console.warn('Warning: stratum-mcp install failed (hooks may not be registered)')
    }
  }

  // 7. Scaffold ROADMAP.md from template if absent
  const roadmapDest = join(cwd, 'ROADMAP.md')
  if (!existsSync(roadmapDest)) {
    const roadmapSrc = join(PACKAGE_ROOT, 'templates', 'ROADMAP.md')
    if (existsSync(roadmapSrc)) {
      const projectName = basename(cwd)
      const today = new Date().toISOString().slice(0, 10)
      let template = readFileSync(roadmapSrc, 'utf-8')
      template = template
        .replace(/\{\{PROJECT_NAME\}\}/g, projectName)
        .replace(/\{\{PROJECT_DESCRIPTION\}\}/g, 'describe your project here')
        .replace(/\{\{DATE\}\}/g, today)
      writeFileSync(roadmapDest, template)
      console.log('Created ROADMAP.md from template')
    }
  }

  // 8. Copy default pipeline specs if absent
  const pipelinesDir = join(cwd, 'pipelines')
  mkdirSync(pipelinesDir, { recursive: true })
  for (const specName of ['build.stratum.yaml', 'new.stratum.yaml']) {
    const dest = join(pipelinesDir, specName)
    if (!existsSync(dest)) {
      const src = join(PACKAGE_ROOT, 'pipelines', specName)
      if (existsSync(src)) {
        copyFileSync(src, dest)
        console.log(`Copied default pipeline to ${dest}`)
      }
    }
  }

  // 9. Sync all compose-owned skills to detected agents
  syncSkills(agents)

  // 10. Summary
  console.log('')
  console.log('Compose initialized:')
  console.log(`  Stratum:   ${config.capabilities.stratum ? 'enabled' : 'disabled'}`)
  console.log(`  Lifecycle: ${config.capabilities.lifecycle ? 'enabled' : 'disabled'}`)
  console.log(`  Agents:    ${agents.map(a => a.name).join(', ') || 'none detected'}`)
}

// ---------------------------------------------------------------------------
// compose setup — user-global setup
// ---------------------------------------------------------------------------

function runSetup() {
  // 1. Sync all compose-owned skills to detected agents
  const agents = detectAgents()
  syncSkills(agents)

  // 2. Register stratum-mcp if available
  const hasStratum = spawnSync('which', ['stratum-mcp'], { encoding: 'utf-8' }).status === 0
  if (hasStratum) {
    console.log('Registering stratum-mcp with Claude Code...')
    const result = spawnSync('stratum-mcp', ['install'], { stdio: 'inherit' })
    if (result.status !== 0) {
      console.warn('Warning: stratum-mcp install failed (non-fatal)')
    }
  } else {
    console.log('stratum-mcp not found — skipping global registration')
    console.log('  Install later: pip install stratum && compose setup')
  }
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

if (cmd === 'init') {
  await runInit(args)
  process.exit(0)
}

if (cmd === 'setup') {
  runSetup()
  process.exit(0)
}

if (cmd === 'install') {
  // Backwards-compat: run both init + setup
  await runInit(args)
  runSetup()
  process.exit(0)
}

if (cmd === 'import') {
  const cwd = process.cwd()

  // Auto-init if needed
  if (!existsSync(join(cwd, '.compose', 'compose.json'))) {
    console.log('No .compose/ found — running init first...\n')
    await runInit(args.filter(a => a.startsWith('--')))
    console.log('')
  }

  const { runImport } = await import('../lib/import.js')
  try {
    await runImport({ cwd })
  } catch (err) {
    console.error(`\nError: ${err.message}`)
    process.exit(1)
  }
  process.exit(0)
}

if (cmd === 'new') {
  const autoMode = args.includes('--auto')
  const askMode = args.includes('--ask')
  const fromIdeaIdx = args.indexOf('--from-idea')
  const fromIdeaId = fromIdeaIdx !== -1 ? args[fromIdeaIdx + 1] : null
  const intent = args.filter((a, i) => !a.startsWith('-') && i !== fromIdeaIdx + 1).join(' ')

  if (!intent) {
    console.error('Usage: compose new "description of the product" [--auto] [--ask]')
    console.error('')
    console.error('Run from inside your project directory.')
    console.error('')
    console.error('Options:')
    console.error('  --auto    Skip questionnaire entirely')
    console.error('  --ask     Re-run questionnaire (uses previous answers as defaults)')
    console.error('')
    console.error('Examples:')
    console.error('  cd myapp && compose new "Structured log analyzer CLI for JSON-lines files"')
    console.error('  compose new "REST API for managing team todo lists" --auto')
    process.exit(1)
  }

  const cwd = process.cwd()
  const name = basename(cwd)

  // --from-idea <ID>: pre-populate intent from a promoted ideabox entry (Item 184)
  let fromIdeaIntent = ''
  if (fromIdeaId) {
    try {
      const { readIdeabox: _ribNew } = await import('../lib/ideabox.js')
      const ibCfgNew = (() => { try { return JSON.parse(readFileSync(join(cwd, '.compose', 'compose.json'), 'utf-8')) } catch { return {} } })()
      const ibRelNew = ibCfgNew?.paths?.ideabox || 'docs/product/ideabox.md'
      const ibDataNew = _ribNew(cwd, ibRelNew)
      const foundIdea = [...ibDataNew.ideas, ...ibDataNew.killed].find(
        i => i.id.toUpperCase() === fromIdeaId.toUpperCase()
      )
      if (foundIdea) {
        const parts = [`Feature idea: ${foundIdea.title}`]
        if (foundIdea.description) parts.push(`Description: ${foundIdea.description}`)
        if (foundIdea.cluster) parts.push(`Cluster: ${foundIdea.cluster}`)
        fromIdeaIntent = parts.join('\n')
        console.log(`Pre-populating intent from ${foundIdea.id}: ${foundIdea.title}`)
      } else {
        console.warn(`--from-idea: idea not found: ${fromIdeaId}`)
      }
    } catch (err) {
      console.warn(`--from-idea: could not load idea: ${err.message}`)
    }
  }

  // Read any existing context to enrich intent
  let existingContext = ''

  // Project analysis from compose import (richest source)
  const analysisPath = join(cwd, 'docs', 'discovery', 'project-analysis.md')
  if (existsSync(analysisPath)) {
    existingContext += `\n\n--- project-analysis.md (from compose import) ---\n${readFileSync(analysisPath, 'utf-8')}`
  }

  // Key project files
  for (const contextFile of ['README.md', 'package.json', 'pyproject.toml', 'Cargo.toml']) {
    const p = join(cwd, contextFile)
    if (existsSync(p)) {
      existingContext += `\n\n--- ${contextFile} ---\n${readFileSync(p, 'utf-8')}`
    }
  }

  // Auto-init if not already initialized (or missing pipeline specs)
  if (!existsSync(join(cwd, '.compose', 'compose.json')) || !existsSync(join(cwd, 'pipelines', 'new.stratum.yaml'))) {
    console.log('Running compose init...\n')
    await runInit(args.filter(a => a.startsWith('--')))
    console.log('')
  }

  // Questionnaire: runs on first time automatically, then only with --ask
  // Skip questionnaire if a design doc exists — it provides the enriched intent
  // Also skip if --from-idea provided — the idea already carries title/description/cluster
  const hasDesignDoc = existsSync(join(cwd, 'docs', 'design.md'))
  let finalIntent = fromIdeaIntent ? `${fromIdeaIntent}${intent ? '\n\n' + intent : ''}` : intent
  let skipResearch = false
  const hasAnswers = existsSync(join(cwd, '.compose', 'questionnaire.json'))
  const runQuestionnaireNow = !autoMode && !hasDesignDoc && (!hasAnswers || askMode) && !fromIdeaId

  if (runQuestionnaireNow) {
    const { runQuestionnaire } = await import('../lib/questionnaire.js')
    const hasExisting = existingContext.length > 0
    const result = await runQuestionnaire(name, intent, { cwd, hasExistingContent: hasExisting })
    if (!result) process.exit(0) // user aborted

    finalIntent = result.enrichedIntent
    skipResearch = !result.options.doResearch

    // Apply pipeline customizations from questionnaire
    if (result.options.reviewAgent === 'Codex (automated review)') {
      const { pipelineSet } = await import('../lib/pipeline-cli.js')
      try {
        pipelineSet(cwd, 'review_gate', ['--mode', 'review'])
      } catch { /* gate may not exist in new.stratum.yaml */ }
    } else if (result.options.reviewAgent === 'Skip review') {
      const { pipelineDisable } = await import('../lib/pipeline-cli.js')
      try {
        pipelineDisable(cwd, ['review_gate'])
      } catch { /* ignore */ }
    }
  } else if (hasAnswers && !autoMode) {
    // Load saved answers to enrich intent without prompting
    const saved = JSON.parse(readFileSync(join(cwd, '.compose', 'questionnaire.json'), 'utf-8'))
    const parts = [saved.refined ?? intent]
    parts.push(`\n## Project Constraints`)
    parts.push(`- Type: ${saved.projectType ?? 'unknown'}`)
    parts.push(`- Language/Runtime: ${saved.language ?? 'unknown'}`)
    parts.push(`- Scope: ${saved.complexity ?? 'unknown'}`)
    if (saved.notes) parts.push(`\n## Additional Context\n${saved.notes}`)
    finalIntent = parts.join('\n')
    skipResearch = saved.doResearch === false
  }

  // Build final enriched intent with existing context
  const enrichedIntent = existingContext
    ? `${finalIntent}\n\n## Existing project context\n${existingContext}`
    : finalIntent

  const { runNew } = await import('../lib/new.js')
  try {
    await runNew(enrichedIntent, { cwd, projectName: name, skipResearch })
  } catch (err) {
    console.error(`\nError: ${err.message}`)
    process.exit(1)
  }
  process.exit(0)
}

if (cmd === 'feature') {
  const featureCode = args.find(a => !a.startsWith('-'))
  const description = args.filter(a => !a.startsWith('-')).slice(1).join(' ')

  if (!featureCode) {
    console.error('Usage: compose feature <CODE> "description of the feature"')
    console.error('')
    console.error('Examples:')
    console.error('  compose feature LOG-1 "CLI tool for parsing JSON-lines log files"')
    console.error('  compose feature AUTH-2 "Add OAuth2 login flow with PKCE"')
    process.exit(1)
  }

  if (!description) {
    console.error(`Usage: compose feature ${featureCode} "description of the feature"`)
    process.exit(1)
  }

  const cwd = process.cwd()
  const configPath = join(cwd, '.compose', 'compose.json')
  if (!existsSync(configPath)) {
    console.error("No .compose/compose.json found. Run 'compose init' first.")
    process.exit(1)
  }

  let config = {}
  try { config = JSON.parse(readFileSync(configPath, 'utf-8')) } catch {}
  const featuresDir = config.paths?.features || 'docs/features'

  // 1. Create feature folder + seed design doc
  const featureDir = join(cwd, featuresDir, featureCode)
  const designPath = join(featureDir, 'design.md')

  if (existsSync(designPath)) {
    console.error(`Feature ${featureCode} already exists at ${featureDir}/`)
    process.exit(1)
  }

  mkdirSync(featureDir, { recursive: true })

  // ── COMP-UX-3a: Infer project defaults ────────────────────────────────────
  // Detect language from lock files / manifests
  let detectedLang = null
  if (existsSync(join(cwd, 'package.json'))) detectedLang = 'node'
  else if (existsSync(join(cwd, 'pyproject.toml')) || existsSync(join(cwd, 'setup.py'))) detectedLang = 'python'
  else if (existsSync(join(cwd, 'Cargo.toml'))) detectedLang = 'rust'
  else if (existsSync(join(cwd, 'go.mod'))) detectedLang = 'go'

  // Detect test framework
  let detectedTestFramework = null
  if (detectedLang === 'node') {
    if (existsSync(join(cwd, 'jest.config.js')) || existsSync(join(cwd, 'jest.config.ts')) || existsSync(join(cwd, 'jest.config.mjs'))) detectedTestFramework = 'jest'
    else if (existsSync(join(cwd, 'vitest.config.js')) || existsSync(join(cwd, 'vitest.config.ts')) || existsSync(join(cwd, 'vitest.config.mjs'))) detectedTestFramework = 'vitest'
    else {
      // Check package.json devDependencies
      try {
        const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'))
        const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
        if (deps.jest) detectedTestFramework = 'jest'
        else if (deps.vitest) detectedTestFramework = 'vitest'
        else if (deps.mocha) detectedTestFramework = 'mocha'
      } catch { /* ignore */ }
    }
  } else if (detectedLang === 'python') {
    if (existsSync(join(cwd, 'pytest.ini')) || existsSync(join(cwd, 'conftest.py'))) detectedTestFramework = 'pytest'
  }

  // Count existing features for complexity estimate
  const existingFeatureCount = (() => {
    try {
      const fdir = join(cwd, featuresDir)
      if (!existsSync(fdir)) return 0
      return readdirSync(fdir, { withFileTypes: true })
        .filter(e => e.isDirectory() && existsSync(join(fdir, e.name, 'feature.json')))
        .length
    } catch { return 0 }
  })()

  // Infer smart defaults for feature.json profile
  const isSmallProject = existingFeatureCount < 3
  const profile = {
    needs_prd: !isSmallProject,
    needs_architecture: existingFeatureCount >= 3,
    needs_verification: true,
    needs_report: !isSmallProject,
    ...(detectedLang ? { language: detectedLang } : {}),
    ...(detectedTestFramework ? { test_framework: detectedTestFramework } : {}),
  }

  if (detectedLang) console.log(`Detected language: ${detectedLang}${detectedTestFramework ? ` (${detectedTestFramework})` : ''}`)
  if (existingFeatureCount > 0) console.log(`Existing features: ${existingFeatureCount} — profile: ${JSON.stringify({ needs_prd: profile.needs_prd, needs_architecture: profile.needs_architecture })}`)
  // ── end COMP-UX-3a ─────────────────────────────────────────────────────────

  // Write feature.json (source of truth)
  const { writeFeature } = await import('../lib/feature-json.js')
  const today = new Date().toISOString().slice(0, 10)
  writeFeature(cwd, {
    code: featureCode,
    description,
    status: 'PLANNED',
    created: today,
    profile,
  }, featuresDir)
  console.log(`Created ${join(featureDir, 'feature.json')}`)

  const designContent = `# ${featureCode}: ${description}

**Status:** PLANNED
**Created:** ${today}

---

## Intent

${description}

---

## Notes

_This is a seed design doc created by \`compose feature\`. The \`compose build\` pipeline will expand it into a full design, blueprint, and implementation plan._
`

  writeFileSync(designPath, designContent)
  console.log(`Created ${designPath}`)

  // 2. Add entry to ROADMAP.md
  const roadmapPath = join(cwd, 'ROADMAP.md')
  if (existsSync(roadmapPath)) {
    let roadmap = readFileSync(roadmapPath, 'utf-8')

    // Find the last table row with a number to get the next item number
    const itemNums = [...roadmap.matchAll(/^\| (\d+) \|/gm)].map(m => parseInt(m[1], 10))
    const nextNum = itemNums.length > 0 ? Math.max(...itemNums) + 1 : 1

    // Find the first PLANNED phase table and append, or append to the last table
    const tableRowPattern = /^(\| \d+ \|.*\| PLANNED \|)$/m
    const match = roadmap.match(tableRowPattern)

    if (match) {
      // Insert after the last row of this table
      const tableEnd = roadmap.indexOf(match[0]) + match[0].length
      // Find end of table (next blank line or ---)
      let insertPos = tableEnd
      const rest = roadmap.slice(tableEnd)
      const nextRows = rest.match(/^(\| \d+ \|.*\|)$/gm)
      if (nextRows) {
        for (const row of nextRows) {
          insertPos = roadmap.indexOf(row, insertPos) + row.length
        }
      }
      const newRow = `\n| ${nextNum} | ${featureCode} | ${description} | PLANNED |`
      roadmap = roadmap.slice(0, insertPos) + newRow + roadmap.slice(insertPos)
    } else {
      // No PLANNED table found — append a features section
      roadmap += `\n\n## Features\n\n| # | Feature | Item | Status |\n|---|---------|------|--------|\n| ${nextNum} | ${featureCode} | ${description} | PLANNED |\n`
    }

    writeFileSync(roadmapPath, roadmap)
    console.log(`Added ${featureCode} to ROADMAP.md (item #${nextNum})`)
  }

  // 3. Update project description in ROADMAP if still placeholder
  if (existsSync(roadmapPath)) {
    let roadmap = readFileSync(roadmapPath, 'utf-8')
    if (roadmap.includes('describe your project here')) {
      // Use the first feature description as a hint
      roadmap = roadmap.replace('describe your project here', description)
      writeFileSync(roadmapPath, roadmap)
    }
  }

  console.log('')
  console.log(`Feature ${featureCode} ready. Next:`)
  console.log(`  compose build ${featureCode}`)
  process.exit(0)
}

if (cmd === 'roadmap') {
  const subcmd = args[0]

  // compose roadmap generate — regenerate ROADMAP.md from feature.json files
  if (subcmd === 'generate' || subcmd === 'gen') {
    const { writeRoadmap } = await import('../lib/roadmap-gen.js')
    const cwd = process.cwd()
    const path = writeRoadmap(cwd)
    console.log(`Generated ${path} from feature.json files`)
    process.exit(0)
  }

  // compose roadmap migrate — extract ROADMAP.md entries into feature.json files
  if (subcmd === 'migrate') {
    const { migrateRoadmap } = await import('../lib/migrate-roadmap.js')
    const cwd = process.cwd()
    const dryRun = args.includes('--dry-run')
    const overwrite = args.includes('--overwrite')
    const result = migrateRoadmap(cwd, { dryRun, overwrite })
    if (!dryRun) {
      console.log(`Created: ${result.created.length} feature.json files`)
      if (result.created.length > 0) console.log(`  ${result.created.join(', ')}`)
      console.log(`Updated: ${result.updated.length}`)
      if (result.updated.length > 0) console.log(`  ${result.updated.join(', ')}`)
      console.log(`Skipped: ${result.skipped.length} (already exist, use --overwrite to replace)`)
      if (result.skipped.length > 0) console.log(`  ${result.skipped.join(', ')}`)
    }
    process.exit(0)
  }

  // compose roadmap check — verify feature.json ↔ ROADMAP.md consistency
  if (subcmd === 'check') {
    const { listFeatures } = await import('../lib/feature-json.js')
    const { parseRoadmap } = await import('../lib/roadmap-parser.js')
    const cwd = process.cwd()
    const roadmapPath = join(cwd, 'ROADMAP.md')
    if (!existsSync(roadmapPath)) {
      console.error('No ROADMAP.md found. Run: compose roadmap generate')
      process.exit(1)
    }
    const features = listFeatures(cwd)
    const roadmapEntries = parseRoadmap(readFileSync(roadmapPath, 'utf-8'))
    const roadmapCodes = new Set(roadmapEntries.filter(e => !e.code.startsWith('_anon_')).map(e => e.code))
    const featureCodes = new Set(features.map(f => f.code))

    let clean = true
    // Features in feature.json but missing from ROADMAP.md
    for (const f of features) {
      if (!roadmapCodes.has(f.code)) {
        console.log(`MISSING from ROADMAP.md: ${f.code}`)
        clean = false
      }
    }
    // Features in ROADMAP.md but missing feature.json
    for (const e of roadmapEntries) {
      if (e.code.startsWith('_anon_')) continue
      if (!featureCodes.has(e.code)) {
        console.log(`NO feature.json: ${e.code}`)
        clean = false
      }
    }
    // Status mismatches
    const roadmapMap = new Map(roadmapEntries.map(e => [e.code, e]))
    for (const f of features) {
      const rm = roadmapMap.get(f.code)
      if (rm && rm.status !== f.status) {
        console.log(`STATUS MISMATCH: ${f.code} — feature.json=${f.status}, ROADMAP.md=${rm.status}`)
        clean = false
      }
    }

    if (clean) {
      console.log('feature.json and ROADMAP.md are in sync.')
    } else {
      console.log('\nRun `compose roadmap generate` to regenerate ROADMAP.md from feature.json.')
      process.exit(1)
    }
    process.exit(0)
  }

  // Default: compose roadmap (show status)
  const { parseRoadmap, filterBuildable } = await import('../lib/roadmap-parser.js')
  const { buildDag, topoSort } = await import('../lib/build-dag.js')
  const { readdirSync, statSync } = await import('fs')

  const SYM = { COMPLETE: '\x1b[32m✓\x1b[0m', PLANNED: '\x1b[90m○\x1b[0m', IN_PROGRESS: '\x1b[33m◐\x1b[0m', PARTIAL: '\x1b[33m◐\x1b[0m', SUPERSEDED: '\x1b[90m✗\x1b[0m', PARKED: '\x1b[90m⏸\x1b[0m' }

  function showRoadmap(roadmapPath, fallbackLabel) {
    const text = readFileSync(roadmapPath, 'utf-8')
    // Extract project name from "# Title Roadmap" or "# Title" heading
    const titleMatch = text.match(/^#\s+(.+?)(?:\s+Roadmap)?\s*$/m)
    const label = titleMatch ? titleMatch[1].trim() : fallbackLabel
    const allEntries = parseRoadmap(text)
    const named = allEntries.filter(e => !e.code.startsWith('_anon_'))

    if (named.length === 0) return

    // Group by phase
    const phases = new Map()
    for (const entry of named) {
      const phase = entry.phaseId || '(ungrouped)'
      if (!phases.has(phase)) phases.set(phase, [])
      phases.get(phase).push(entry)
    }

    // Counts
    const counts = {}
    for (const e of named) counts[e.status] = (counts[e.status] ?? 0) + 1
    const total = named.length

    console.log(`\n\x1b[1m${label}\x1b[0m  (${total} features)\n`)

    for (const [phase, entries] of phases) {
      const complete = entries.filter(e => e.status === 'COMPLETE').length
      const phaseColor = complete === entries.length ? '\x1b[32m' : entries.some(e => e.status === 'IN_PROGRESS' || e.status === 'PARTIAL') ? '\x1b[33m' : '\x1b[0m'
      const shortPhase = phase.includes(' > ') ? phase.split(' > ').pop() : phase
      console.log(`${phaseColor}${shortPhase}\x1b[0m  (${complete}/${entries.length})`)
      for (const e of entries) {
        const sym = SYM[e.status] ?? '?'
        const desc = e.description.length > 70 ? e.description.slice(0, 67) + '...' : e.description
        console.log(`  ${sym} ${e.code.padEnd(16)} ${desc}`)
      }
      console.log('')
    }

    // Summary bar
    const bar = []
    if (counts.COMPLETE > 0) bar.push(`\x1b[32m${counts.COMPLETE} complete\x1b[0m`)
    if ((counts.IN_PROGRESS ?? 0) + (counts.PARTIAL ?? 0) > 0) bar.push(`\x1b[33m${(counts.IN_PROGRESS ?? 0) + (counts.PARTIAL ?? 0)} in progress\x1b[0m`)
    if (counts.PLANNED > 0) bar.push(`\x1b[90m${counts.PLANNED} planned\x1b[0m`)
    if (counts.SUPERSEDED > 0) bar.push(`\x1b[90m${counts.SUPERSEDED} superseded\x1b[0m`)
    if (counts.PARKED > 0) bar.push(`\x1b[90m${counts.PARKED} parked\x1b[0m`)
    console.log(bar.join('  '))

    // Next buildable
    const buildable = filterBuildable(allEntries)
    if (buildable.length > 0) {
      const dag = buildDag(allEntries)
      const order = topoSort(dag)
      const buildableSet = new Set(buildable.map(e => e.code))
      const buildOrder = order.filter(code => buildableSet.has(code))
      const descMap = new Map(named.map(e => [e.code, e.description]))
      const next = buildOrder.slice(0, 5)
      console.log(`\n\x1b[1mNext up:\x1b[0m`)
      for (const code of next) {
        const desc = descMap.get(code) ?? ''
        const short = desc.length > 60 ? desc.slice(0, 57) + '...' : desc
        console.log(`  compose build ${code}${short ? `  — ${short}` : ''}`)
      }
      if (buildOrder.length > 5) {
        console.log(`  ... and ${buildOrder.length - 5} more`)
      }
    }
  }

  const cwd = process.cwd()
  const roadmapPath = join(cwd, 'ROADMAP.md')

  if (existsSync(roadmapPath)) {
    // Show cwd roadmap
    showRoadmap(roadmapPath, basename(cwd))

    // Also scan immediate subdirs for sibling roadmaps
    const subdirs = []
    try {
      for (const entry of readdirSync(cwd)) {
        if (entry.startsWith('.')) continue
        const sub = join(cwd, entry)
        if (statSync(sub).isDirectory() && existsSync(join(sub, 'ROADMAP.md'))) {
          subdirs.push({ name: entry, path: join(sub, 'ROADMAP.md') })
        }
      }
    } catch { /* ignore permission errors */ }

    for (const { name, path } of subdirs) {
      showRoadmap(path, name)
    }
  } else {
    // No roadmap in cwd — scan subdirs (parent folder of multiple projects)
    const subdirs = []
    try {
      for (const entry of readdirSync(cwd)) {
        if (entry.startsWith('.')) continue
        const sub = join(cwd, entry)
        if (statSync(sub).isDirectory() && existsSync(join(sub, 'ROADMAP.md'))) {
          subdirs.push({ name: entry, path: join(sub, 'ROADMAP.md') })
        }
      }
    } catch { /* ignore */ }

    if (subdirs.length === 0) {
      console.error('No ROADMAP.md found in the current directory or any subdirectory.')
      process.exit(1)
    }

    for (const { name, path } of subdirs) {
      showRoadmap(path, name)
    }
  }

  console.log('')
  process.exit(0)
}

if (cmd === 'pipeline') {
  const { runPipelineCli } = await import('../lib/pipeline-cli.js')
  try {
    runPipelineCli(process.cwd(), args)
  } catch (err) {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  }
  process.exit(0)
}

if (cmd === 'build') {
  // Parse --cwd <path> for cross-repo builds
  let agentWorkDir = null
  const cwdIdx = args.indexOf('--cwd')
  if (cwdIdx !== -1) {
    const cwdValue = args[cwdIdx + 1]
    if (!cwdValue || cwdValue.startsWith('-')) {
      console.error('Error: --cwd requires a path argument')
      process.exit(1)
    }
    agentWorkDir = resolve(cwdValue)
  }
  let filteredArgs = args.filter((a, i) => i !== cwdIdx && (cwdIdx === -1 || i !== cwdIdx + 1))

  // --team flag (COMP-TEAMS)
  let teamTemplate = null
  try {
    const teamResult = parseTeamFlag(filteredArgs)
    teamTemplate = teamResult.template
    if (teamTemplate) filteredArgs = teamResult.args
  } catch (err) {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  }

  // --template <name>
  let templateName = null
  const templateIdx = filteredArgs.indexOf('--template')
  if (templateIdx !== -1) {
    const templateValue = filteredArgs[templateIdx + 1]
    if (!templateValue || templateValue.startsWith('-')) {
      console.error('Error: --template requires a name argument')
      process.exit(1)
    }
    templateName = templateValue
  }
  if (teamTemplate && !templateName) {
    templateName = teamTemplate
  }
  const filteredArgs2 = filteredArgs.filter((a, i) => i !== templateIdx && (templateIdx === -1 || i !== templateIdx + 1))

  const featureCodes = filteredArgs2.filter(a => !a.startsWith('-'))
  const featureCode = featureCodes[0]
  const abort = filteredArgs2.includes('--abort')
  const all = filteredArgs2.includes('--all')
  const dryRun = filteredArgs2.includes('--dry-run')
  const skipTriage = filteredArgs2.includes('--skip-triage')

  // Multiple codes: compose build FEAT-1 FEAT-2 FEAT-3
  const isMulti = featureCodes.length > 1
  // Single prefix: compose build STRAT-COMP (no trailing digit)
  const isPrefix = featureCodes.length === 1 && featureCode && !/\d$/.test(featureCode)
  const isBatch = all || isPrefix || isMulti

  if (abort && isBatch) {
    console.error('Error: --abort and --all/prefix/multi are mutually exclusive')
    process.exit(1)
  }

  if (!featureCode && !abort && !all) {
    console.error('Usage: compose build <feature-code> [feature-code...]')
    console.error('       compose build STRAT-COMP          (prefix — builds all matching)')
    console.error('       compose build --all               (builds entire roadmap)')
    console.error('')
    console.error('Options:')
    console.error('  --abort        Abort the active build')
    console.error('  --all          Build all PLANNED features in dependency order')
    console.error('  --dry-run      Print build order without executing')
    console.error('  --cwd <path>   Agent working directory (for cross-repo features)')
    process.exit(1)
  }

  // Auto-init if needed
  const buildCwd = process.cwd()
  if (!existsSync(join(buildCwd, '.compose', 'compose.json')) || !existsSync(join(buildCwd, 'pipelines', 'build.stratum.yaml'))) {
    console.log('Running compose init...\n')
    await runInit(args.filter(a => a.startsWith('--')))
    console.log('')
  }

  if (isBatch) {
    import('../lib/build-all.js').then(({ runBuildAll }) => {
      const batchOpts = { cwd: buildCwd, dryRun }
      if (agentWorkDir) batchOpts.workingDirectory = agentWorkDir
      if (isMulti) {
        batchOpts.features = featureCodes
      } else if (isPrefix) {
        batchOpts.filter = featureCode
      }
      runBuildAll(batchOpts).then((result) => {
        process.exit(result.failed.length > 0 ? 1 : 0)
      }).catch((err) => {
        console.error(`Build all failed: ${err.message}`)
        process.exit(1)
      })
    })
  } else {
    import('../lib/build.js').then(({ runBuild }) => {
      const singleOpts = { abort }
      if (agentWorkDir) singleOpts.workingDirectory = agentWorkDir
      if (skipTriage) singleOpts.skipTriage = true
      if (templateName) singleOpts.template = templateName
      runBuild(featureCode, singleOpts).then(() => {
        process.exit(0)
      }).catch((err) => {
        console.error(`Build failed: ${err.message}`)
        process.exit(1)
      })
    })
  }
} else if (cmd === 'triage') {
  const triageCode = args.find(a => !a.startsWith('-'))
  if (!triageCode) {
    console.error('Usage: compose triage <feature-code>')
    process.exit(1)
  }
  import('../lib/triage.js').then(({ runTriage }) => {
    import('../lib/feature-json.js').then(({ readFeature, writeFeature, updateFeature }) => {
      const trCwd = process.cwd()
      runTriage(triageCode, { cwd: trCwd }).then((result) => {
        console.log(`\nFeature: ${triageCode}`)
        console.log(`Tier:     ${result.tier}`)
        console.log(`Rationale: ${result.rationale}`)
        console.log(`\nProfile:`)
        for (const [k, v] of Object.entries(result.profile)) {
          console.log(`  ${k}: ${v}`)
        }
        console.log(`\nSignals:`)
        console.log(`  file paths found:  ${result.signals.fileCount}`)
        console.log(`  task count:        ${result.signals.taskCount}`)
        console.log(`  security paths:    ${result.signals.securityPaths}`)
        console.log(`  core paths:        ${result.signals.corePaths}`)

        // Persist to feature.json
        const triageTimestamp = new Date().toISOString()
        const existing = readFeature(trCwd, triageCode)
        if (!existing) {
          writeFeature(trCwd, {
            code: triageCode,
            description: triageCode,
            status: 'PLANNED',
            complexity: String(result.tier),
            profile: result.profile,
            triageTimestamp,
          })
          console.log(`\nCreated feature.json for ${triageCode}`)
        } else {
          updateFeature(trCwd, triageCode, {
            complexity: String(result.tier),
            profile: result.profile,
            triageTimestamp,
          })
          console.log(`\nUpdated feature.json for ${triageCode}`)
        }
        process.exit(0)
      }).catch((err) => {
        console.error(`Triage failed: ${err.message}`)
        process.exit(1)
      })
    })
  })
} else if (cmd === 'start') {
  // Resolve target root BEFORE spawning supervisor
  const explicitTarget = process.env.COMPOSE_TARGET
  const targetRoot = explicitTarget
    ? resolve(explicitTarget)
    : findProjectRoot(process.cwd())

  if (explicitTarget && !existsSync(resolve(explicitTarget))) {
    console.error(`[compose] COMPOSE_TARGET=${explicitTarget} does not exist.`)
    process.exit(1)
  }
  if (!targetRoot || !existsSync(join(targetRoot, '.compose', 'compose.json'))) {
    console.error('[compose] No .compose/ found (searched from cwd upward).')
    console.error("[compose] Run 'compose init' first, or set COMPOSE_TARGET.")
    process.exit(1)
  }

  const child = spawn('node', [join(PACKAGE_ROOT, 'server', 'supervisor.js')], {
    stdio: 'inherit',
    cwd: PACKAGE_ROOT,
    env: { ...process.env, COMPOSE_TARGET: targetRoot },
  })
  child.on('error', (err) => {
    console.error(`Failed to start compose: ${err.message}`)
    process.exit(1)
  })
  child.on('exit', (code) => process.exit(code ?? 0))
} else if (cmd === 'ideabox') {
  // ---------------------------------------------------------------------------
  // compose ideabox — idea management CLI
  // ---------------------------------------------------------------------------
  const ibSubcmd = args[0]
  const ibCwd = process.cwd()

  // Resolve compose config (paths, etc.)
  function loadComposeConfig(cwd) {
    const cfgPath = join(cwd, '.compose', 'compose.json')
    if (existsSync(cfgPath)) {
      try { return JSON.parse(readFileSync(cfgPath, 'utf-8')) } catch {}
    }
    return {}
  }
  function getIdeaboxRelPath(cwd) {
    return loadComposeConfig(cwd)?.paths?.ideabox || 'docs/product/ideabox.md'
  }
  const ibConfig = loadComposeConfig(ibCwd)

  const {
    parseIdeabox: _parseIdeabox,
    serializeIdeabox: _serializeIdeabox,
    addIdea: _addIdea,
    promoteIdea: _promoteIdea,
    killIdea: _killIdea,
    setPriority: _setPriority,
    loadLens: _loadLens,
    readIdeabox: _readIdeabox,
    writeIdeabox: _writeIdeabox,
    addDiscussion: _addDiscussion,
  } = await import('../lib/ideabox.js')

  const ibRelPath = getIdeaboxRelPath(ibCwd)
  const ibFullPath = join(ibCwd, ibRelPath)

  if (!ibSubcmd || ibSubcmd === '--help' || ibSubcmd === '-h') {
    console.log('Usage: compose ideabox <subcommand>')
    console.log('')
    console.log('Subcommands:')
    console.log('  add "<title>"                Add a new idea')
    console.log('  list                         List all ideas')
    console.log('  promote <ID>                 Mark idea as PROMOTED (creates feature folder)')
    console.log('  kill <ID> "<reason>"         Move idea to Killed Ideas')
    console.log('  pri <ID> <P0|P1|P2>          Set priority')
    console.log('  discuss <ID> "<comment>"     Add a discussion comment')
    console.log('  triage [--lens <name>]       Walk untriaged ideas and assign priorities')
    process.exit(0)
  }

  if (ibSubcmd === 'add') {
    const title = args.slice(1).find(a => !a.startsWith('-')) || args[1]
    if (!title) {
      console.error('Usage: compose ideabox add "<title>" [--source "..."] [--desc "..."] [--cluster "..."]')
      process.exit(1)
    }
    // Parse optional flags
    const sourceIdx = args.indexOf('--source')
    const descIdx = args.indexOf('--desc')
    const clusterIdx = args.indexOf('--cluster')
    const tagsIdx = args.indexOf('--tags')
    const source = sourceIdx !== -1 ? args[sourceIdx + 1] : ''
    const description = descIdx !== -1 ? args[descIdx + 1] : ''
    const cluster = clusterIdx !== -1 ? args[clusterIdx + 1] : null
    const tagsRaw = tagsIdx !== -1 ? args[tagsIdx + 1] : ''
    const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim().startsWith('#') ? t.trim() : `#${t.trim()}`) : []

    if (!existsSync(ibFullPath)) {
      const { IDEABOX_TEMPLATE } = await import('../lib/ideabox.js')
      mkdirSync(dirname(ibFullPath), { recursive: true })
      writeFileSync(ibFullPath, IDEABOX_TEMPLATE)
    }

    const parsed = _readIdeabox(ibCwd, ibRelPath)
    _addIdea(parsed, { title, description, source, tags, cluster })
    _writeIdeabox(ibCwd, ibRelPath, parsed)
    const newIdea = parsed.ideas[parsed.ideas.length - 1]
    console.log(`Added ${newIdea.id}: ${newIdea.title}`)
    process.exit(0)
  }

  if (ibSubcmd === 'list') {
    if (!existsSync(ibFullPath)) {
      console.log('No ideabox found. Run: compose ideabox add "<title>"')
      process.exit(0)
    }
    const parsed = _readIdeabox(ibCwd, ibRelPath)
    if (parsed.ideas.length === 0 && parsed.killed.length === 0) {
      console.log('No ideas yet.')
      process.exit(0)
    }

    // Group by status then priority
    const byStatus = {}
    for (const idea of parsed.ideas) {
      const s = idea.status.startsWith('PROMOTED') ? 'PROMOTED' : idea.status
      if (!byStatus[s]) byStatus[s] = []
      byStatus[s].push(idea)
    }

    const statusOrder = ['NEW', 'DISCUSSING', 'PROMOTED']
    const priorityOrder = { P0: 0, P1: 1, P2: 2, '—': 3 }

    for (const status of statusOrder) {
      const group = byStatus[status]
      if (!group || group.length === 0) continue
      group.sort((a, b) => (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3))
      console.log(`\n[${status}]`)
      for (const idea of group) {
        const pri = idea.priority !== '—' ? ` [${idea.priority}]` : ''
        const tags = idea.tags.length ? ` ${idea.tags.join(' ')}` : ''
        console.log(`  ${idea.id}${pri}  ${idea.title}${tags}`)
      }
    }

    if (parsed.killed.length > 0) {
      console.log(`\n[KILLED] (${parsed.killed.length})`)
      for (const idea of parsed.killed) {
        console.log(`  ${idea.id}  ${idea.title}  — ${idea.killedReason}`)
      }
    }
    process.exit(0)
  }

  if (ibSubcmd === 'promote') {
    const ideaId = args[1]
    if (!ideaId) {
      console.error('Usage: compose ideabox promote <ID> [<FEATURE-CODE>]')
      process.exit(1)
    }
    const featureCode = args[2] || ''

    if (!existsSync(ibFullPath)) {
      console.error(`Ideabox not found at ${ibFullPath}`)
      process.exit(1)
    }

    const parsed = _readIdeabox(ibCwd, ibRelPath)
    const idea = parsed.ideas.find(i => i.id.toUpperCase() === ideaId.toUpperCase())
    if (!idea) {
      console.error(`Idea not found: ${ideaId}`)
      process.exit(1)
    }

    // Generate feature code if not provided
    let resolvedCode = featureCode
    if (!resolvedCode) {
      // Derive a slug from the title
      const slug = idea.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20).replace(/-+$/, '')
      resolvedCode = `IDEA-${idea.num}-${slug}`.toUpperCase()
    }

    // Create feature folder if missing — respect paths.features from compose.json
    const featuresRel = ibConfig.paths?.features || 'docs/features'
    const featuresDir = join(ibCwd, featuresRel, resolvedCode)
    if (!existsSync(featuresDir)) {
      mkdirSync(featuresDir, { recursive: true })
      writeFileSync(join(featuresDir, 'feature.json'), JSON.stringify({
        code: resolvedCode,
        description: idea.title,
        status: 'PLANNED',
        promotedFrom: ideaId,
        createdAt: new Date().toISOString(),
      }, null, 2))
      console.log(`Created feature folder: ${featuresRel}/${resolvedCode}/`)
    }

    _promoteIdea(parsed, ideaId, resolvedCode)
    _writeIdeabox(ibCwd, ibRelPath, parsed)
    console.log(`Promoted ${ideaId} → ${resolvedCode}`)
    process.exit(0)
  }

  if (ibSubcmd === 'kill') {
    const ideaId = args[1]
    const reason = args[2] || ''
    if (!ideaId) {
      console.error('Usage: compose ideabox kill <ID> "<reason>"')
      process.exit(1)
    }
    if (!existsSync(ibFullPath)) {
      console.error(`Ideabox not found at ${ibFullPath}`)
      process.exit(1)
    }

    const parsed = _readIdeabox(ibCwd, ibRelPath)
    _killIdea(parsed, ideaId, reason)
    _writeIdeabox(ibCwd, ibRelPath, parsed)
    console.log(`Killed ${ideaId}: ${reason}`)
    process.exit(0)
  }

  if (ibSubcmd === 'pri') {
    const ideaId = args[1]
    const priority = args[2]
    if (!ideaId || !priority) {
      console.error('Usage: compose ideabox pri <ID> <P0|P1|P2>')
      process.exit(1)
    }
    if (!existsSync(ibFullPath)) {
      console.error(`Ideabox not found at ${ibFullPath}`)
      process.exit(1)
    }

    const parsed = _readIdeabox(ibCwd, ibRelPath)
    _setPriority(parsed, ideaId, priority)
    _writeIdeabox(ibCwd, ibRelPath, parsed)
    console.log(`Set ${ideaId} priority → ${priority}`)
    process.exit(0)
  }

  if (ibSubcmd === 'discuss') {
    const ideaId = args[1]
    const comment = args[2]
    if (!ideaId || !comment) {
      console.error('Usage: compose ideabox discuss <ID> "<comment>"')
      process.exit(1)
    }
    if (!existsSync(ibFullPath)) {
      console.error(`Ideabox not found at ${ibFullPath}`)
      process.exit(1)
    }

    const parsed = _readIdeabox(ibCwd, ibRelPath)
    _addDiscussion(parsed, ideaId, 'human', comment)
    _writeIdeabox(ibCwd, ibRelPath, parsed)
    const today = new Date().toISOString().slice(0, 10)
    console.log(`[${today}] human: ${comment}`)
    process.exit(0)
  }

  if (ibSubcmd === 'triage') {
    const lensIdx = args.indexOf('--lens')
    const lensName = lensIdx !== -1 ? args[lensIdx + 1] : null

    if (!existsSync(ibFullPath)) {
      console.log('No ideabox found. Run: compose ideabox add "<title>" first.')
      process.exit(0)
    }

    const parsed = _readIdeabox(ibCwd, ibRelPath)
    const untriaged = parsed.ideas.filter(i => i.priority === '—' && i.status === 'NEW')

    if (untriaged.length === 0) {
      console.log('No untriaged ideas.')
      process.exit(0)
    }

    let lens = null
    if (lensName) {
      lens = _loadLens(ibCwd, lensName)
      if (!lens) {
        console.warn(`Lens not found: docs/product/ideabox-priority-${lensName}.md`)
      } else {
        console.log(`Using lens: ${lensName}`)
      }
    }

    // Interactive triage using readline
    const { createInterface } = await import('node:readline')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const question = (q) => new Promise(resolve => rl.question(q, resolve))

    let changed = false
    for (const idea of untriaged) {
      console.log(`\n${idea.id}: ${idea.title}`)
      if (idea.description) console.log(`  ${idea.description.slice(0, 120)}`)
      if (lens) console.log(`  [lens: ${lensName}]`)

      const ans = await question('  Priority [P0/P1/P2/skip]: ')
      const p = ans.trim().toUpperCase()
      if (['P0', 'P1', 'P2'].includes(p)) {
        _setPriority(parsed, idea.id, p)
        changed = true
        console.log(`  Set ${idea.id} → ${p}`)
      } else {
        console.log('  Skipped')
      }
    }

    rl.close()

    if (changed) {
      _writeIdeabox(ibCwd, ibRelPath, parsed)
      console.log('\nSaved.')
    }
    process.exit(0)
  }

  console.error(`Unknown ideabox subcommand: ${ibSubcmd}`)
  console.error('Run: compose ideabox --help')
  process.exit(1)

} else if (cmd === 'qa-scope') {
  // ---------------------------------------------------------------------------
  // compose qa-scope <featureCode>
  // COMP-QA item 116: inspect which routes are affected by a feature's filesChanged
  // ---------------------------------------------------------------------------
  const qsCode = args.find(a => !a.startsWith('-'))
  if (!qsCode) {
    console.error('Usage: compose qa-scope <feature-code>')
    process.exit(1)
  }

  const qsCwd = process.cwd()

  import('../lib/feature-json.js').then(({ readFeature }) => {
    import('../lib/qa-scoping.js').then(({ mapFilesToRoutes, classifyRoutes }) => {
      const feature = readFeature(qsCwd, qsCode)
      if (!feature) {
        console.error(`Feature not found: ${qsCode}`)
        process.exit(1)
      }

      const filesChanged = feature.filesChanged ?? []
      if (filesChanged.length === 0) {
        console.log(`No filesChanged recorded for ${qsCode}.`)
        console.log('Run a build first so the pipeline tracks touched files.')
        process.exit(0)
      }

      const result = mapFilesToRoutes(filesChanged, { cwd: qsCwd })
      const allKnown = []  // v1: no known-routes registry
      const { affected, adjacent } = classifyRoutes(result.affectedRoutes, allKnown)

      console.log(`\nQA Scope for ${qsCode}`)
      console.log(`Framework:  ${result.framework}`)
      console.log(`Docs-only:  ${result.docsOnly}`)
      console.log(`\nAffected routes (${affected.length}):`)
      if (affected.length === 0) {
        console.log('  (none — no code files mapped to known routes)')
      } else {
        for (const r of affected) console.log(`  ${r}`)
      }

      console.log(`\nAdjacent routes (${adjacent.length}):`)
      if (adjacent.length === 0) {
        console.log('  (none)')
      } else {
        for (const r of adjacent) console.log(`  ${r}`)
      }

      console.log(`\nUnmapped files (${result.unmappedFiles.length}):`)
      if (result.unmappedFiles.length === 0) {
        console.log('  (none)')
      } else {
        for (const f of result.unmappedFiles) console.log(`  ${f}`)
      }

      process.exit(0)
    })
  }).catch((err) => {
    console.error(`qa-scope failed: ${err.message}`)
    process.exit(1)
  })

} else {
  console.error(`Unknown command: ${cmd}`)
  process.exit(1)
}
