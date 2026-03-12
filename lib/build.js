/**
 * build.js — Headless lifecycle runner for `compose build`.
 *
 * Orchestrates feature execution through a Stratum workflow:
 * load spec → stratum_plan → dispatch steps to agents → enforce gates → audit.
 *
 * No server required. Vision state written directly to disk.
 * Gates resolved via CLI readline prompt.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

import { StratumMcpClient } from './stratum-mcp-client.js';
import { runAndNormalize } from './result-normalizer.js';
import { buildStepPrompt, buildRetryPrompt } from './step-prompt.js';
import { promptGate } from './gate-prompt.js';
import { VisionWriter } from './vision-writer.js';
import { CliProgress } from './cli-progress.js';

import { ClaudeSDKConnector } from '../server/connectors/claude-sdk-connector.js';
import { CodexConnector } from '../server/connectors/codex-connector.js';

// ---------------------------------------------------------------------------
// Agent registry
// ---------------------------------------------------------------------------

const DEFAULT_AGENTS = new Map([
  ['claude', (opts) => new ClaudeSDKConnector(opts)],
  ['codex', (opts) => new CodexConnector(opts)],
]);

function defaultConnectorFactory(agentType, opts) {
  const factory = DEFAULT_AGENTS.get(agentType);
  if (!factory) {
    throw new Error(
      `compose build: step requires agent "${agentType}" but no connector is registered.\n` +
      `Known agents: ${[...DEFAULT_AGENTS.keys()].join(', ')}\n` +
      `Check your .stratum.yaml spec or install the agent.`
    );
  }
  return factory(opts);
}

// ---------------------------------------------------------------------------
// Active build state (resume/abort)
// ---------------------------------------------------------------------------

function activeBuildPath(dataDir) {
  return join(dataDir, 'active-build.json');
}

function readActiveBuild(dataDir) {
  const p = activeBuildPath(dataDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function writeActiveBuild(dataDir, state) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(activeBuildPath(dataDir), JSON.stringify(state, null, 2));
}

export function deleteActiveBuild(dataDir) {
  const p = activeBuildPath(dataDir);
  if (existsSync(p)) unlinkSync(p);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run a feature through the Stratum lifecycle.
 *
 * @param {string} featureCode - Feature code (e.g. 'FEAT-1')
 * @param {object} opts
 * @param {string}   [opts.cwd]              - Working directory (default: process.cwd())
 * @param {boolean}  [opts.abort]            - Abort active build instead of running
 * @param {string}   [opts.description]      - Feature description override
 * @param {Function} [opts.connectorFactory] - Override agent connector creation (for testing)
 * @param {object}   [opts.gateOpts]         - Options for gate prompt (input/output streams)
 */
export async function runBuild(featureCode, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const getConnector = opts.connectorFactory ?? defaultConnectorFactory;

  // Resolve project paths
  const composeDir = join(cwd, '.compose');
  const dataDir = join(composeDir, 'data');

  // Handle --abort early (featureCode may be null)
  if (opts.abort) {
    await abortBuild(dataDir, featureCode);
    return;
  }

  const featureDir = join(cwd, 'docs', 'features', featureCode);

  // Read compose.json
  const configPath = join(composeDir, 'compose.json');
  if (!existsSync(configPath)) {
    throw new Error(`No .compose/compose.json found at ${cwd}. Run 'compose init' first.`);
  }

  // Load lifecycle spec
  const specPath = join(cwd, 'pipelines', 'build.stratum.yaml');
  if (!existsSync(specPath)) {
    throw new Error(`Lifecycle spec not found: ${specPath}`);
  }
  const specYaml = readFileSync(specPath, 'utf-8');

  // Build description from feature folder
  const description = opts.description ?? loadFeatureDescription(featureDir, featureCode);

  // Vision writer
  const visionWriter = new VisionWriter(dataDir);
  const itemId = visionWriter.ensureFeatureItem(featureCode, featureCode);

  // CLI progress renderer
  const progress = new CliProgress();

  // Stratum MCP client
  const stratum = new StratumMcpClient();
  await stratum.connect({ cwd });

  try {
    // Check for active build (resume)
    const active = readActiveBuild(dataDir);
    let response;

    if (active && active.featureCode === featureCode && active.flowId) {
      console.log(`Found previous build for ${featureCode} (flow: ${active.flowId})`);
      try {
        response = await stratum.resume(active.flowId);
        if (response.status === 'complete' || response.status === 'killed') {
          console.log(`Previous build already ${response.status}. Starting fresh.`);
          deleteActiveBuild(dataDir);
          response = await startFresh(stratum, specYaml, featureCode, description, dataDir);
        } else {
          console.log(`Resuming from step: ${response.step_id}`);
        }
      } catch (err) {
        const recoverable = err?.code === 'flow_not_found'
          || err?.code === 'STRATUM_ERROR'
          || err?.message?.includes('No active flow');
        if (recoverable) {
          console.log('Previous flow not found. Starting fresh.');
          deleteActiveBuild(dataDir);
          response = await startFresh(stratum, specYaml, featureCode, description, dataDir);
        } else {
          throw err;
        }
      }
    } else if (active && active.featureCode !== featureCode) {
      throw new Error(
        `Another build is active for ${active.featureCode}. ` +
        `Use 'compose build --abort' to cancel it.`
      );
    } else {
      response = await startFresh(stratum, specYaml, featureCode, description, dataDir);
    }

    // Update vision state
    visionWriter.updateItemStatus(itemId, 'in_progress');

    // Dispatch loop
    const context = { cwd, featureCode };

    while (response.status !== 'complete' && response.status !== 'killed') {
      const stepId = response.step_id;
      const flowId = response.flow_id;
      const stepNum = response.step_number ?? '?';
      const totalSteps = response.total_steps ?? '?';

      if (response.status === 'execute_step') {
        progress.stepStart(stepNum, totalSteps, stepId);

        // Update tracking
        visionWriter.updateItemPhase(itemId, stepId);
        updateActiveBuildStep(dataDir, stepId);

        // Build prompt and dispatch to agent
        const agentType = response.agent ?? 'claude';
        const prompt = buildStepPrompt(response, context);
        const connector = getConnector(agentType, { cwd });
        const { result } = await runAndNormalize(connector, prompt, response, { progress });

        response = await stratum.stepDone(flowId, stepId, result ?? { summary: 'Step complete' });

      } else if (response.status === 'await_gate') {
        // Pause progress key listener so readline can use stdin
        progress.pause();
        console.log(`\nGate: ${stepId}`);
        const gateId = visionWriter.createGate(flowId, stepId, itemId);

        const askAgent = async (question, artifactPath) => {
          const connector = getConnector('claude', { cwd: context.cwd });
          const fileRef = artifactPath && !artifactPath.endsWith('/')
            ? `Read the file "${artifactPath}" and answer`
            : `Look at the project files in the working directory and answer`;
          const qaPrompt =
            `${fileRef} this question concisely:\n\n` +
            `${question}\n\n` +
            `Keep your answer brief — 2-3 sentences max.`;
          const parts = [];
          for await (const event of connector.run(qaPrompt, {})) {
            if (event.type === 'assistant' && event.content) parts.push(event.content);
            if (event.type === 'result' && event.content && parts.length === 0) parts.push(event.content);
          }
          return parts.join('') || '(no answer)';
        };

        const { outcome, rationale } = await promptGate(response, {
          ...(opts.gateOpts ?? {}),
          artifact: context.cwd,
          askAgent,
        });
        visionWriter.resolveGate(gateId, outcome);
        response = await stratum.gateResolve(flowId, stepId, outcome, rationale, 'human');
        progress.resume();

      } else if (response.status === 'execute_flow') {
        // Flow dispatch shape: { parent_flow_id, parent_step_id, child_flow_id,
        //   child_flow_name, child_step: { step dispatch or gate dispatch } }
        // Must execute the ENTIRE child flow to completion, then report
        // the child's output back to the parent via step_done on the parent step.
        const parentFlowId = response.parent_flow_id;
        const parentStepId = response.parent_step_id;
        const childFlowName = response.child_flow_name ?? 'sub-flow';
        progress.subFlowStep(childFlowName, '');

        const childResult = await executeChildFlow(
          response, stratum, getConnector, context,
          visionWriter, itemId, dataDir, opts.gateOpts ?? {}, progress
        );

        // Report child completion envelope to parent flow step.
        // Stratum's step_done unwraps flow-step results via result.get("output"),
        // so we pass the full envelope { status, flow_id, output, trace, ... }.
        response = await stratum.stepDone(parentFlowId, parentStepId, childResult);

      } else if (response.status === 'ensure_failed' || response.status === 'schema_failed') {
        progress.retry('build', stepId, response.agent);
        const violations = response.violations ?? [];
        const agentType = response.agent ?? 'claude';
        const prompt = buildRetryPrompt(response, violations, context);
        const connector = getConnector(agentType, { cwd });
        const { result } = await runAndNormalize(connector, prompt, response, { progress });

        response = await stratum.stepDone(
          response.flow_id, response.step_id,
          result ?? { summary: 'Retry complete' }
        );

      } else {
        // Unknown status — log and try to continue
        console.warn(`Unknown dispatch status: ${response.status}`);
        break;
      }
    }

    // Flow complete
    if (response.status === 'complete') {
      console.log('\nBuild complete.');
      visionWriter.updateItemStatus(itemId, 'complete');
    } else if (response.status === 'killed') {
      console.log('\nBuild killed.');
      visionWriter.updateItemStatus(itemId, 'killed');
    }

    // Write audit trace from the completion/killed envelope.
    // Stratum deletes persisted flows on completion, so stratum_audit()
    // would return flow_not_found. The completion envelope already includes
    // { trace, total_duration_ms, output, flow_id }.
    if (response.trace) {
      try {
        mkdirSync(featureDir, { recursive: true });
        writeFileSync(
          join(featureDir, 'audit.json'),
          JSON.stringify(response, null, 2)
        );
        console.log(`Audit trace written to docs/features/${featureCode}/audit.json`);
      } catch (err) {
        console.warn(`Warning: could not write audit trace: ${err.message}`);
      }
    } else {
      // Fallback: try stratum_audit (works for killed flows that may still be persisted)
      try {
        const audit = await stratum.audit(response.flow_id);
        mkdirSync(featureDir, { recursive: true });
        writeFileSync(
          join(featureDir, 'audit.json'),
          JSON.stringify(audit, null, 2)
        );
        console.log(`Audit trace written to docs/features/${featureCode}/audit.json`);
      } catch (err) {
        console.warn(`Warning: could not write audit trace: ${err.message}`);
      }
    }

    // Clean up active build state
    deleteActiveBuild(dataDir);

  } finally {
    progress.finish();
    await stratum.close();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Execute a child flow to completion, returning the child's completion envelope.
 * Handles the child's internal step loop (execute_step, await_gate, ensure_failed, etc.)
 * including nested execute_flow (recursive).
 */
async function executeChildFlow(
  flowDispatch, stratum, getConnector, context,
  visionWriter, itemId, dataDir, gateOpts, progress
) {
  let resp = flowDispatch.child_step;
  const childFlowId = flowDispatch.child_flow_id;
  const childFlowName = flowDispatch.child_flow_name ?? 'sub-flow';

  while (resp.status !== 'complete' && resp.status !== 'killed') {
    if (resp.status === 'execute_step') {
      if (progress) {
        progress.subFlowStep(childFlowName, resp.step_id);
      } else {
        console.log(`  [${childFlowName}] ${resp.step_id}...`);
      }
      visionWriter.updateItemPhase(itemId, `${childFlowName}:${resp.step_id}`);

      const agentType = resp.agent ?? 'claude';
      const prompt = buildStepPrompt(resp, context);
      const connector = getConnector(agentType, { cwd: context.cwd });
      const { result } = await runAndNormalize(connector, prompt, resp, { progress });

      resp = await stratum.stepDone(
        childFlowId, resp.step_id,
        result ?? { summary: 'Step complete' }
      );

    } else if (resp.status === 'await_gate') {
      if (progress) progress.pause();
      console.log(`  [${childFlowName}] Gate: ${resp.step_id}`);
      const gateId = visionWriter.createGate(childFlowId, resp.step_id, itemId);

      const askAgent = async (question, artifactPath) => {
        const connector = getConnector('claude', { cwd: context.cwd });
        const fileRef = artifactPath && !artifactPath.endsWith('/')
          ? `Read the file "${artifactPath}" and answer`
          : `Look at the project files in the working directory and answer`;
        const qaPrompt =
          `${fileRef} this question concisely:\n\n` +
          `${question}\n\n` +
          `Keep your answer brief — 2-3 sentences max.`;
        const parts = [];
        for await (const event of connector.run(qaPrompt, {})) {
          if (event.type === 'assistant' && event.content) parts.push(event.content);
          if (event.type === 'result' && event.content && parts.length === 0) parts.push(event.content);
        }
        return parts.join('') || '(no answer)';
      };

      const { outcome, rationale } = await promptGate(resp, {
        ...gateOpts,
        artifact: context.cwd,
        askAgent,
      });
      visionWriter.resolveGate(gateId, outcome);
      resp = await stratum.gateResolve(childFlowId, resp.step_id, outcome, rationale, 'human');
      if (progress) progress.resume();

    } else if (resp.status === 'ensure_failed' || resp.status === 'schema_failed') {
      const violations = resp.violations ?? [];
      const stepAgent = resp.agent ?? 'claude';
      const fixAgent = stepAgent === 'codex' ? 'claude' : stepAgent;

      if (progress) {
        progress.fix(childFlowName, fixAgent, resp.step_id);
      } else {
        console.log(`  [${childFlowName}] ↻ Fix (${fixAgent}) for ${resp.step_id}`);
      }
      const fixPrompt =
        `Fix step "${resp.step_id}" — postconditions failed:\n` +
        violations.map(v => `- ${v}`).join('\n') + '\n\n' +
        `Fix every issue. Do not skip any.\n\n` +
        `## Context\nWorking directory: ${context.cwd}\nFeature: ${context.featureCode}`;
      const fixConnector = getConnector(fixAgent, { cwd: context.cwd });
      await runAndNormalize(fixConnector, fixPrompt, resp, { progress });

      if (progress) {
        progress.retry(childFlowName, resp.step_id, stepAgent);
      } else {
        console.log(`  [${childFlowName}] ↻ Retrying ${resp.step_id} (${stepAgent})`);
      }
      const prompt = buildRetryPrompt(resp, violations, context);
      const connector = getConnector(stepAgent, { cwd: context.cwd });
      const { result } = await runAndNormalize(connector, prompt, resp, { progress });

      resp = await stratum.stepDone(
        resp.flow_id ?? childFlowId, resp.step_id,
        result ?? { summary: 'Retry complete' }
      );

    } else if (resp.status === 'execute_flow') {
      // Nested sub-flow — recurse
      const nestedParentFlowId = resp.parent_flow_id;
      const nestedParentStepId = resp.parent_step_id;
      const nestedResult = await executeChildFlow(
        resp, stratum, getConnector, context,
        visionWriter, itemId, dataDir, gateOpts, progress
      );
      // Pass full envelope — server unwraps via result.get("output")
      resp = await stratum.stepDone(
        nestedParentFlowId, nestedParentStepId, nestedResult
      );

    } else {
      console.warn(`  [${childFlowName}] Unknown status: ${resp.status}`);
      break;
    }
  }

  return resp; // completion or killed envelope with { output, trace, ... }
}

async function startFresh(stratum, specYaml, featureCode, description, dataDir) {
  console.log(`Starting build for ${featureCode}...`);
  const response = await stratum.plan(specYaml, 'build', { featureCode, description });

  writeActiveBuild(dataDir, {
    featureCode,
    flowId: response.flow_id,
    startedAt: new Date().toISOString(),
    currentStepId: response.step_id,
    specPath: 'pipelines/build.stratum.yaml',
  });

  return response;
}

function updateActiveBuildStep(dataDir, stepId) {
  const state = readActiveBuild(dataDir);
  if (state) {
    state.currentStepId = stepId;
    writeActiveBuild(dataDir, state);
  }
}

function loadFeatureDescription(featureDir, featureCode) {
  // Try design.md, then spec.md, then fall back to feature code
  for (const name of ['design.md', 'spec.md']) {
    const p = join(featureDir, name);
    if (existsSync(p)) {
      const content = readFileSync(p, 'utf-8');
      // Extract first paragraph or heading as description
      const firstLine = content.split('\n').find(l => l.trim() && !l.startsWith('#'));
      return firstLine?.trim() ?? featureCode;
    }
  }
  return featureCode;
}

async function abortBuild(dataDir, featureCode) {
  const active = readActiveBuild(dataDir);
  if (!active) {
    console.log('No active build to abort.');
    return;
  }

  if (featureCode && active.featureCode !== featureCode) {
    console.log(`Active build is for ${active.featureCode}, not ${featureCode}.`);
    return;
  }

  console.log(`Aborting build for ${active.featureCode}...`);

  // Try to kill via Stratum gate resolve if at a gate
  const stratum = new StratumMcpClient();
  try {
    await stratum.connect();
    const audit = await stratum.audit(active.flowId);
    if (audit.status === 'complete' || audit.status === 'killed') {
      console.log(`Flow already ${audit.status}.`);
    } else {
      // Try direct flow file deletion (known contract gap)
      const flowFile = join(homedir(), '.stratum', 'flows', `${active.flowId}.json`);
      if (existsSync(flowFile)) {
        unlinkSync(flowFile);
        console.log('Deleted Stratum flow state.');
      }
    }
  } catch {
    // Flow might not exist; try direct cleanup
    const flowFile = join(homedir(), '.stratum', 'flows', `${active.flowId}.json`);
    if (existsSync(flowFile)) {
      unlinkSync(flowFile);
      console.log('Deleted Stratum flow state.');
    }
  } finally {
    await stratum.close();
  }

  // Update vision state
  const visionWriter = new VisionWriter(dataDir);
  const itemId = visionWriter.findFeatureItem(active.featureCode)?.id;
  if (itemId) {
    visionWriter.updateItemStatus(itemId, 'killed');
  }

  deleteActiveBuild(dataDir);
  console.log('Build aborted.');
}
