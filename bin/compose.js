#!/usr/bin/env node
/**
 * compose CLI
 *
 * compose install  — register compose-mcp in the project's .mcp.json
 * compose start    — start the compose app (supervisor.js)
 */
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve, join } from 'path'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(__dirname, '..')

const [,, cmd, ...args] = process.argv

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log('Usage: compose <command>')
  console.log('')
  console.log('Commands:')
  console.log('  install   Register stratum-mcp + compose-mcp (run once per machine/project)')
  console.log('  start     Start the compose app')
  process.exit(0)
}

if (cmd === 'install') {
  // 1. Register stratum-mcp with Claude Code (required — compose runs on stratum)
  const stratumMcp = spawnSync('which', ['stratum-mcp'], { encoding: 'utf-8' })
  if (stratumMcp.status !== 0) {
    console.error('Error: stratum-mcp not found. Install it first:')
    console.error('  pip install stratum')
    process.exit(1)
  }
  console.log('Registering stratum-mcp with Claude Code...')
  const stratumInstall = spawnSync('stratum-mcp', ['install'], { stdio: 'inherit' })
  if (stratumInstall.status !== 0) {
    console.error('Error: stratum-mcp install failed.')
    process.exit(1)
  }

  // 2. Register compose-mcp in this project's .mcp.json
  const mcpPath = join(process.cwd(), '.mcp.json')
  let config = {}
  if (existsSync(mcpPath)) {
    try { config = JSON.parse(readFileSync(mcpPath, 'utf-8')) } catch {}
  }
  config.mcpServers = config.mcpServers || {}
  config.mcpServers.compose = {
    command: 'node',
    args: [join(PACKAGE_ROOT, 'server', 'compose-mcp.js')],
  }
  writeFileSync(mcpPath, JSON.stringify(config, null, 2))
  console.log(`Registered compose-mcp in ${mcpPath}`)
  process.exit(0)
}

if (cmd === 'start') {
  const child = spawn('node', [join(PACKAGE_ROOT, 'server', 'supervisor.js')], {
    stdio: 'inherit',
    cwd: PACKAGE_ROOT,
  })
  child.on('error', (err) => {
    console.error(`Failed to start compose: ${err.message}`)
    process.exit(1)
  })
  child.on('exit', (code) => process.exit(code ?? 0))
  // Do NOT exit here — stay alive so the caller's exit code reflects the supervisor's
}

console.error(`Unknown command: ${cmd}`)
process.exit(1)
