#!/usr/bin/env node
/**
 * compose CLI
 *
 * compose init     — initialize Compose in the current project (project-local)
 * compose setup    — install global skill + register stratum-mcp (user-global)
 * compose install  — run init + setup (backwards-compat alias)
 * compose start    — start the compose app (supervisor.js)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve, join, basename, dirname } from 'path'
import { homedir } from 'os'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { findProjectRoot } from '../server/find-root.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(__dirname, '..')

const [,, cmd, ...args] = process.argv

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log('Usage: compose <command>')
  console.log('')
  console.log('Commands:')
  console.log('  init      Initialize Compose in the current project')
  console.log('  setup     Install global skill + register stratum-mcp')
  console.log('  install   Run init + setup (backwards-compat)')
  console.log('  start     Start the compose app')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// compose init — project-local setup
// ---------------------------------------------------------------------------

function runInit(flags) {
  const noStratum = flags.includes('--no-stratum')
  const noLifecycle = flags.includes('--no-lifecycle')
  const cwd = process.cwd()

  // 1. Create .compose/ directory
  const composeDir = join(cwd, '.compose')
  mkdirSync(composeDir, { recursive: true })

  // 2. Detect capabilities
  const hasStratum = !noStratum && spawnSync('which', ['stratum-mcp'], { encoding: 'utf-8' }).status === 0
  const hasLifecycle = !noLifecycle

  // 3. Write .compose/compose.json (merge with existing if present)
  const configPath = join(composeDir, 'compose.json')
  let existing = {}
  if (existsSync(configPath)) {
    try { existing = JSON.parse(readFileSync(configPath, 'utf-8')) } catch {}
  }

  const config = {
    version: 1,
    capabilities: {
      ...(existing.capabilities || {}),
      stratum: hasStratum,
      lifecycle: hasLifecycle,
    },
    paths: {
      docs: 'docs',
      features: 'docs/features',
      journal: 'docs/journal',
      ...(existing.paths || {}),
    },
  }

  // Flags override existing values
  if (noStratum) config.capabilities.stratum = false
  if (noLifecycle) config.capabilities.lifecycle = false

  writeFileSync(configPath, JSON.stringify(config, null, 2))
  console.log(`Wrote ${configPath}`)

  // 4. Create .compose/data/
  mkdirSync(join(composeDir, 'data'), { recursive: true })

  // 5. Register compose-mcp in .mcp.json
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
  writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2))
  console.log(`Registered compose-mcp in ${mcpPath}`)

  // 6. Scaffold ROADMAP.md from template if absent
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

  // 7. Summary
  console.log('')
  console.log('Compose initialized:')
  console.log(`  Stratum:   ${config.capabilities.stratum ? 'enabled' : 'disabled'}`)
  console.log(`  Lifecycle: ${config.capabilities.lifecycle ? 'enabled' : 'disabled'}`)
}

// ---------------------------------------------------------------------------
// compose setup — user-global setup
// ---------------------------------------------------------------------------

function runSetup() {
  // 1. Install /compose skill to ~/.claude/skills/compose/
  const skillSrc = join(PACKAGE_ROOT, '.claude', 'skills', 'compose', 'SKILL.md')
  const skillDestDir = join(homedir(), '.claude', 'skills', 'compose')
  const skillDest = join(skillDestDir, 'SKILL.md')
  if (existsSync(skillSrc)) {
    mkdirSync(skillDestDir, { recursive: true })
    writeFileSync(skillDest, readFileSync(skillSrc))
    console.log(`Installed /compose skill to ${skillDest}`)
  }

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
  runInit(args)
  process.exit(0)
}

if (cmd === 'setup') {
  runSetup()
  process.exit(0)
}

if (cmd === 'install') {
  // Backwards-compat: run both init + setup
  runInit(args)
  runSetup()
  process.exit(0)
}

if (cmd === 'start') {
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
} else {
  console.error(`Unknown command: ${cmd}`)
  process.exit(1)
}
