/**
 * compose pipeline — view and edit build.stratum.yaml
 *
 * Subcommands:
 *   show                          Print the current pipeline
 *   set <step> --agent <agent>    Change a step's agent
 *   set <step> --mode gate        Convert step to a human gate
 *   set <step> --mode review      Convert step to a codex review sub-flow
 *   set <step> --mode agent       Convert step back to a regular agent step
 *   add --id <id> --after <step> --agent <agent> --intent <intent>  Insert a step
 *   remove <step>                 Remove a step
 *   enable <steps...>             Enable skipped steps (remove skip_if)
 *   disable <steps...>            Disable steps (set skip_if: "true")
 */
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { parse, stringify } from 'yaml'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadSpec(cwd) {
  const specPath = join(cwd, 'pipelines', 'build.stratum.yaml')
  if (!existsSync(specPath)) {
    throw new Error(`No pipeline found at ${specPath}. Run 'compose init' first.`)
  }
  return { specPath, spec: parse(readFileSync(specPath, 'utf-8')) }
}

function saveSpec(specPath, spec) {
  writeFileSync(specPath, stringify(spec, { lineWidth: 120 }))
}

function findStep(steps, stepId) {
  const idx = steps.findIndex(s => s.id === stepId)
  if (idx === -1) throw new Error(`Step "${stepId}" not found in pipeline.`)
  return { step: steps[idx], idx }
}

function findFlow(spec, flowName) {
  return spec.flows?.[flowName]
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

const LEVEL_COLORS = {
  gate: '\x1b[33m',    // yellow
  skip: '\x1b[90m',    // gray
  flow: '\x1b[36m',    // cyan
  agent: '\x1b[32m',   // green
}
const RESET = '\x1b[0m'

export function pipelineShow(cwd) {
  const { spec } = loadSpec(cwd)
  const mainFlow = spec.flows?.build
  if (!mainFlow) throw new Error('No "build" flow found in pipeline spec.')

  console.log(`\n  Pipeline: build (${mainFlow.steps.length} steps)\n`)

  for (const step of mainFlow.steps) {
    const isGate = !!step.function
    const isFlow = !!step.flow
    const isSkipped = step.skip_if === 'true' || step.skip_if === true
    const agent = step.agent ?? (isFlow ? flowAgent(spec, step.flow) : null)

    let kind, color, detail
    if (isSkipped) {
      kind = 'skip'
      color = LEVEL_COLORS.skip
      detail = step.skip_reason || 'skipped'
    } else if (isGate) {
      kind = 'gate'
      color = LEVEL_COLORS.gate
      detail = `human gate (timeout: ${gateTimeout(spec, step.function)}s)`
    } else if (isFlow) {
      kind = 'flow'
      color = LEVEL_COLORS.flow
      const subFlow = findFlow(spec, step.flow)
      const subSteps = subFlow?.steps?.map(s => s.id).join(' → ') || '?'
      detail = `${step.flow}: ${subSteps} (agent: ${agent})`
    } else {
      kind = 'agent'
      color = LEVEL_COLORS.agent
      const ensures = step.ensure?.length ? ` [${step.ensure.length} ensures]` : ''
      const retries = step.retries ? ` (retries: ${step.retries})` : ''
      const onFail = step.on_fail ? ` → on_fail: ${step.on_fail}` : ''
      detail = `agent: ${agent}${ensures}${retries}${onFail}`
    }

    const num = String(mainFlow.steps.indexOf(step) + 1).padStart(2)
    console.log(`  ${color}${num}. ${step.id.padEnd(18)}${kind.padEnd(6)} ${detail}${RESET}`)
  }

  // Show sub-flows
  const subFlowNames = mainFlow.steps.filter(s => s.flow).map(s => s.flow)
  if (subFlowNames.length > 0) {
    console.log(`\n  Sub-flows:`)
    for (const name of subFlowNames) {
      const flow = findFlow(spec, name)
      if (!flow) continue
      console.log(`\n    ${name}:`)
      for (const step of flow.steps) {
        const ensures = step.ensure?.length ? ` [${step.ensure.join(', ')}]` : ''
        const retries = step.retries ? ` (retries: ${step.retries})` : ''
        console.log(`      - ${step.id} (${step.agent})${ensures}${retries}`)
      }
    }
  }

  // Show contracts
  if (spec.contracts) {
    console.log(`\n  Contracts: ${Object.keys(spec.contracts).join(', ')}`)
  }

  console.log('')
}

function flowAgent(spec, flowName) {
  const flow = spec.flows?.[flowName]
  if (!flow?.steps?.length) return '?'
  return flow.steps[0].agent ?? 'claude'
}

function gateTimeout(spec, funcName) {
  return spec.functions?.[funcName]?.timeout ?? '?'
}

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------

export function pipelineSet(cwd, stepId, flags) {
  const { specPath, spec } = loadSpec(cwd)
  const mainFlow = spec.flows?.build
  if (!mainFlow) throw new Error('No "build" flow found.')

  const { step, idx } = findStep(mainFlow.steps, stepId)

  // --agent <agent>
  const agentIdx = flags.indexOf('--agent')
  if (agentIdx !== -1) {
    const agent = flags[agentIdx + 1]
    if (!agent) throw new Error('--agent requires a value (claude, codex, gemini)')
    if (step.flow) {
      // Change the agent inside the sub-flow
      const flow = findFlow(spec, step.flow)
      if (flow?.steps?.length) {
        flow.steps[0].agent = agent
        console.log(`Set ${step.flow} → ${flow.steps[0].id} agent to ${agent}`)
      }
    } else if (step.function) {
      throw new Error(`"${stepId}" is a gate — gates don't have agents. Use --mode to change it.`)
    } else {
      step.agent = agent
      console.log(`Set ${stepId} agent to ${agent}`)
    }
  }

  // --mode gate|review|agent
  const modeIdx = flags.indexOf('--mode')
  if (modeIdx !== -1) {
    const mode = flags[modeIdx + 1]
    if (!mode) throw new Error('--mode requires a value (gate, review, agent)')

    if (mode === 'gate') {
      convertToGate(spec, mainFlow, step, stepId)
    } else if (mode === 'review') {
      convertToReview(spec, mainFlow, step, stepId)
    } else if (mode === 'agent') {
      convertToAgent(spec, mainFlow, step, stepId)
    } else {
      throw new Error(`Unknown mode "${mode}". Use: gate, review, agent`)
    }
  }

  // --retries <n>
  const retriesIdx = flags.indexOf('--retries')
  if (retriesIdx !== -1) {
    const n = parseInt(flags[retriesIdx + 1], 10)
    if (isNaN(n)) throw new Error('--retries requires a number')
    if (step.flow) {
      const flow = findFlow(spec, step.flow)
      if (flow?.steps?.length) flow.steps[0].retries = n
    } else {
      step.retries = n
    }
    console.log(`Set ${stepId} retries to ${n}`)
  }

  saveSpec(specPath, spec)
}

function convertToGate(spec, mainFlow, step, stepId) {
  const funcName = `${stepId}_gate`
  // Add gate function if missing
  spec.functions = spec.functions || {}
  if (!spec.functions[funcName]) {
    spec.functions[funcName] = { mode: 'gate', timeout: 3600 }
  }

  // Find the next step id for on_approve
  const idx = mainFlow.steps.indexOf(step)
  const nextStep = mainFlow.steps[idx + 1]

  // Find previous agent step for on_revise
  let prevAgent = null
  for (let i = idx - 1; i >= 0; i--) {
    if (mainFlow.steps[i].agent && !mainFlow.steps[i].skip_if) {
      prevAgent = mainFlow.steps[i].id
      break
    }
  }

  // Replace step properties
  const deps = step.depends_on
  Object.keys(step).forEach(k => delete step[k])
  step.id = stepId
  step.function = funcName
  step.on_approve = nextStep?.id || null
  step.on_revise = prevAgent
  step.on_kill = null
  if (deps) step.depends_on = deps

  console.log(`Converted ${stepId} to human gate`)
}

function convertToReview(spec, mainFlow, step, stepId) {
  const flowName = `${stepId}_review`

  // Create review sub-flow if missing
  if (!spec.flows[flowName]) {
    spec.flows[flowName] = {
      input: { task: { type: 'string' } },
      output: 'ReviewResult',
      steps: [{
        id: 'review',
        agent: 'codex',
        intent: `Review the output of the ${stepId} step. Return { "clean": boolean, "summary": string, "findings": string[] }.`,
        inputs: { task: '$.input.task' },
        output_contract: 'ReviewResult',
        ensure: ['result.clean == True'],
        retries: 5,
      }],
    }
  }

  // Ensure ReviewResult contract exists
  spec.contracts = spec.contracts || {}
  if (!spec.contracts.ReviewResult) {
    spec.contracts.ReviewResult = {
      clean: { type: 'boolean' },
      summary: { type: 'string' },
      findings: { type: 'array' },
    }
  }

  // Find the previous step for input reference
  const idx = mainFlow.steps.indexOf(step)
  let prevStepId = null
  for (let i = idx - 1; i >= 0; i--) {
    if (mainFlow.steps[i].agent && !mainFlow.steps[i].skip_if) {
      prevStepId = mainFlow.steps[i].id
      break
    }
  }

  // Replace step properties
  const deps = step.depends_on
  Object.keys(step).forEach(k => delete step[k])
  step.id = stepId
  step.flow = flowName
  step.inputs = { task: prevStepId ? `$.steps.${prevStepId}.output.summary` : '$.input.description' }
  step.ensure = ['result.clean == True']
  if (deps) step.depends_on = deps

  console.log(`Converted ${stepId} to codex review loop (flow: ${flowName})`)
}

function convertToAgent(spec, mainFlow, step, stepId) {
  const deps = step.depends_on
  const wasFlow = step.flow
  const wasGate = step.function

  Object.keys(step).forEach(k => delete step[k])
  step.id = stepId
  step.agent = 'claude'
  step.intent = `Execute the ${stepId} phase.`
  step.inputs = {
    featureCode: '$.input.featureCode',
    description: '$.input.description',
  }
  step.output_contract = 'PhaseResult'
  step.retries = 2
  if (deps) step.depends_on = deps

  const from = wasFlow ? `flow:${wasFlow}` : wasGate ? `gate:${wasGate}` : 'unknown'
  console.log(`Converted ${stepId} to agent step (from ${from})`)
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

export function pipelineAdd(cwd, flags) {
  const { specPath, spec } = loadSpec(cwd)
  const mainFlow = spec.flows?.build
  if (!mainFlow) throw new Error('No "build" flow found.')

  const id = flagVal(flags, '--id')
  const after = flagVal(flags, '--after')
  const agent = flagVal(flags, '--agent') || 'claude'
  const intent = flagVal(flags, '--intent') || `Execute the ${id} step.`

  if (!id) throw new Error('--id is required')
  if (!after) throw new Error('--after is required')

  // Check id doesn't already exist
  if (mainFlow.steps.some(s => s.id === id)) {
    throw new Error(`Step "${id}" already exists.`)
  }

  const { idx } = findStep(mainFlow.steps, after)

  const newStep = {
    id,
    agent,
    intent,
    inputs: {
      featureCode: '$.input.featureCode',
      description: '$.input.description',
    },
    output_contract: 'PhaseResult',
    retries: 2,
    depends_on: [after],
  }

  // Fix depends_on of the step that previously depended on `after`
  const nextStep = mainFlow.steps[idx + 1]
  if (nextStep?.depends_on?.includes(after)) {
    nextStep.depends_on = nextStep.depends_on.map(d => d === after ? id : d)
  }

  mainFlow.steps.splice(idx + 1, 0, newStep)
  saveSpec(specPath, spec)
  console.log(`Added step "${id}" after "${after}" (agent: ${agent})`)
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

export function pipelineRemove(cwd, stepId) {
  const { specPath, spec } = loadSpec(cwd)
  const mainFlow = spec.flows?.build
  if (!mainFlow) throw new Error('No "build" flow found.')

  const { step, idx } = findStep(mainFlow.steps, stepId)

  // Rewire depends_on: anything depending on this step now depends on its deps
  const removedDeps = step.depends_on || []
  for (const s of mainFlow.steps) {
    if (s.depends_on?.includes(stepId)) {
      s.depends_on = s.depends_on
        .filter(d => d !== stepId)
        .concat(removedDeps)
      // Deduplicate
      s.depends_on = [...new Set(s.depends_on)]
    }
  }

  // Rewire gate references
  for (const s of mainFlow.steps) {
    if (s.on_approve === stepId) s.on_approve = mainFlow.steps[idx + 1]?.id || null
    if (s.on_revise === stepId) s.on_revise = null
    if (s.on_fail === stepId) s.on_fail = null
  }

  mainFlow.steps.splice(idx, 1)
  saveSpec(specPath, spec)
  console.log(`Removed step "${stepId}"`)
}

// ---------------------------------------------------------------------------
// enable / disable
// ---------------------------------------------------------------------------

export function pipelineEnable(cwd, stepIds) {
  const { specPath, spec } = loadSpec(cwd)
  const mainFlow = spec.flows?.build
  if (!mainFlow) throw new Error('No "build" flow found.')

  for (const stepId of stepIds) {
    const { step } = findStep(mainFlow.steps, stepId)
    delete step.skip_if
    delete step.skip_reason
    console.log(`Enabled ${stepId}`)
  }

  saveSpec(specPath, spec)
}

export function pipelineDisable(cwd, stepIds) {
  const { specPath, spec } = loadSpec(cwd)
  const mainFlow = spec.flows?.build
  if (!mainFlow) throw new Error('No "build" flow found.')

  for (const stepId of stepIds) {
    const { step } = findStep(mainFlow.steps, stepId)
    step.skip_if = 'true'
    step.skip_reason = `Disabled via compose pipeline disable`
    console.log(`Disabled ${stepId} (skip_if: "true")`)
  }

  saveSpec(specPath, spec)
}

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------

function flagVal(flags, name) {
  const idx = flags.indexOf(name)
  return idx !== -1 ? flags[idx + 1] : null
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

export function runPipelineCli(cwd, subArgs) {
  const sub = subArgs[0]
  const rest = subArgs.slice(1)

  if (!sub || sub === '--help') {
    printHelp()
    return
  }

  switch (sub) {
    case 'show':
      pipelineShow(cwd)
      break
    case 'set':
      if (!rest[0]) throw new Error('Usage: compose pipeline set <step-id> --agent <agent> | --mode <mode>')
      pipelineSet(cwd, rest[0], rest.slice(1))
      break
    case 'add':
      pipelineAdd(cwd, rest)
      break
    case 'remove':
      if (!rest[0]) throw new Error('Usage: compose pipeline remove <step-id>')
      pipelineRemove(cwd, rest[0])
      break
    case 'enable':
      if (!rest.length) throw new Error('Usage: compose pipeline enable <step-id> [step-id...]')
      pipelineEnable(cwd, rest)
      break
    case 'disable':
      if (!rest.length) throw new Error('Usage: compose pipeline disable <step-id> [step-id...]')
      pipelineDisable(cwd, rest)
      break
    default:
      console.error(`Unknown pipeline subcommand: ${sub}`)
      printHelp()
      process.exit(1)
  }
}

function printHelp() {
  console.log(`
Usage: compose pipeline <command>

Commands:
  show                                    Print the current pipeline
  set <step> --agent <agent>              Change a step's agent
  set <step> --mode gate                  Convert to human gate
  set <step> --mode review                Convert to codex review loop
  set <step> --mode agent                 Convert to regular agent step
  set <step> --retries <n>                Set retry count
  add --id <id> --after <step> [opts]     Insert a new step
  remove <step>                           Remove a step
  enable <steps...>                       Enable skipped steps
  disable <steps...>                      Disable steps (skip)
`)
}
