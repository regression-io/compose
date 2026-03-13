/**
 * build.js — Headless lifecycle runner for `compose build`.
 *
 * Orchestrates feature execution through a Stratum workflow:
 * load spec → stratum_plan → dispatch steps to agents → enforce gates → audit.
 *
 * No server required. Vision state written directly to disk.
 * Gates resolved via CLI readline prompt.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

import { StratumMcpClient } from './stratum-mcp-client.js';
import { runAndNormalize } from './result-normalizer.js';
import { buildStepPrompt, buildRetryPrompt } from './step-prompt.js';
import { promptGate } from './gate-prompt.js';
import { VisionWriter, ServerUnreachableError } from './vision-writer.js';
import { resolvePort } from './resolve-port.js';
import { probeServer } from './server-probe.js';
import { CliProgress } from './cli-progress.js';
import { BuildStreamWriter } from './build-stream-writer.js';

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
  const target = activeBuildPath(dataDir);
  const tmp = target + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, target);
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
  const itemId = await visionWriter.ensureFeatureItem(featureCode, featureCode);

  // CLI progress renderer
  const progress = new CliProgress();

  // Stratum MCP client
  const stratum = new StratumMcpClient();
  await stratum.connect({ cwd });

  // Hoisted for finally-block visibility
  let streamWriter = null;
  let buildStatus = 'complete';
  let signalHandler = null;

  try {
    // Check for active build (resume)
    const active = readActiveBuild(dataDir);
    let response;

    if (active && active.featureCode === featureCode && active.flowId) {
      // Terminal statuses don't block — start fresh (file overwritten by startFresh)
      if (active.status && active.status !== 'running') {
        console.log(`Previous build ${active.status}. Starting fresh.`);
        response = await startFresh(stratum, specYaml, featureCode, description, dataDir);
      } else {
        console.log(`Found previous build for ${featureCode} (flow: ${active.flowId})`);
        try {
          response = await stratum.resume(active.flowId);
          if (response.status === 'complete' || response.status === 'killed') {
            console.log(`Previous build already ${response.status}. Starting fresh.`);
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
            response = await startFresh(stratum, specYaml, featureCode, description, dataDir);
          } else {
            throw err;
          }
        }
      }
    } else if (active && active.featureCode !== featureCode && active.status === 'running') {
      throw new Error(
        `Another build is active for ${active.featureCode}. ` +
        `Use 'compose build --abort' to cancel it.`
      );
    } else {
      response = await startFresh(stratum, specYaml, featureCode, description, dataDir);
    }

    // Update vision state
    await visionWriter.updateItemStatus(itemId, 'in_progress');

    // Stream writer — instantiated after plan/resume succeeds to prevent
    // a rejected/duplicate invocation from truncating an active build's stream
    streamWriter = new BuildStreamWriter(composeDir, featureCode);
    streamWriter.write({
      type: 'build_start',
      featureCode,
      flowId: response.flow_id,
      specPath: 'pipelines/build.stratum.yaml',
    });

    // SIGINT/SIGTERM: mark build as killed
    signalHandler = () => {
      buildStatus = 'killed';
      streamWriter.close('killed');
    };
    process.on('SIGINT', signalHandler);
    process.on('SIGTERM', signalHandler);

    // Dispatch loop
    const context = { cwd, featureCode };

    while (response.status !== 'complete' && response.status !== 'killed') {
      const stepId = response.step_id;
      const flowId = response.flow_id;
      const stepNum = response.step_number ?? '?';
      const totalSteps = response.total_steps ?? '?';

      if (response.status === 'execute_step') {
        progress.stepStart(stepNum, totalSteps, stepId);

        // Stream: step start
        streamWriter.write({
          type: 'build_step_start',
          stepId, stepNum, totalSteps,
          agent: response.agent ?? 'claude',
          intent: response.intent ?? null,
          flowId,
        });

        // Update tracking
        await visionWriter.updateItemPhase(itemId, stepId);
        updateActiveBuildStep(dataDir, stepId, { stepNum: response.step_number, totalSteps: response.total_steps });

        // Build prompt and dispatch to agent
        const agentType = response.agent ?? 'claude';
        const prompt = buildStepPrompt(response, context);
        const connector = getConnector(agentType, { cwd });
        let mainResult;
        try {
          mainResult = await runAndNormalize(connector, prompt, response, { progress, streamWriter });
        } catch (err) {
          streamWriter.write({ type: 'build_error', message: err.message, stepId });
          throw err;
        }
        const { result } = mainResult;

        response = await stratum.stepDone(flowId, stepId, result ?? { summary: 'Step complete' });

        // Stream: step done
        streamWriter.write({
          type: 'build_step_done',
          stepId,
          summary: (result ?? {}).summary ?? 'Step complete',
          retries: 0,
          violations: [],
          flowId,
        });

      } else if (response.status === 'await_gate') {
        updateActiveBuildStep(dataDir, stepId);

        // Stream: gate pending
        streamWriter.write({
          type: 'build_gate',
          stepId, flowId,
          gateType: response.gate_type ?? 'approval',
        });

        // Pause progress key listener so readline can use stdin
        progress.pause();
        console.log(`\nGate: ${stepId}`);

        // Gate enrichment extras for STRAT-COMP-6
        const gateExtras = {
          fromPhase: response.from_phase ?? null,
          toPhase: response.to_phase ?? null,
          artifact: response.artifact ?? null,
          summary: response.summary ?? null,
        };

        const serverUp = await probeServer();
        let outcome, rationale;

        if (serverUp) {
          // Server-up path: delegate gate to web UI
          const gateId = await visionWriter.createGate(flowId, stepId, itemId, gateExtras);
          console.log('Gate delegated to web UI. Waiting for resolution...');
          const resolved = await pollGateResolution(visionWriter, gateId);
          if (resolved) {
            outcome = resolved.outcome;
            rationale = resolved.comment ?? '';
          } else {
            // Mid-poll server loss — fall back to readline
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
            const result = await promptGate(response, {
              ...(opts.gateOpts ?? {}),
              artifact: context.cwd,
              askAgent,
            });
            outcome = result.outcome;
            rationale = result.rationale;
            await visionWriter.resolveGate(gateId, outcome);
            // Try REST sync (best-effort, server may still be down)
            try { await visionWriter._restResolveGate(gateId, outcome); } catch { /* ignore */ }
          }
        } else {
          // Server-down path: readline fallback
          const gateId = await visionWriter.createGate(flowId, stepId, itemId, gateExtras);

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

          const result = await promptGate(response, {
            ...(opts.gateOpts ?? {}),
            artifact: context.cwd,
            askAgent,
          });
          outcome = result.outcome;
          rationale = result.rationale;
          await visionWriter.resolveGate(gateId, outcome);
        }

        response = await stratum.gateResolve(flowId, stepId, outcome, rationale, 'human');
        progress.resume();

        // Stream: gate resolved
        streamWriter.write({
          type: 'build_gate_resolved',
          stepId, outcome, rationale: rationale ?? '', flowId,
        });

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
          visionWriter, itemId, dataDir, opts.gateOpts ?? {}, progress,
          streamWriter
        );

        // Report child completion envelope to parent flow step.
        // Stratum's step_done unwraps flow-step results via result.get("output"),
        // so we pass the full envelope { status, flow_id, output, trace, ... }.
        response = await stratum.stepDone(parentFlowId, parentStepId, childResult);

      } else if (response.status === 'ensure_failed' || response.status === 'schema_failed') {
        {
          const currentState = readActiveBuild(dataDir);
          const violationList = (response.violations || []).slice(-10);
          updateActiveBuildStep(dataDir, response.step_id ?? stepId, {
            retries: ((currentState?.retries) || 0) + 1,
            violations: violationList,
          });
        }
        progress.retry('build', stepId, response.agent);
        const violations = response.violations ?? [];
        const agentType = response.agent ?? 'claude';
        const prompt = buildRetryPrompt(response, violations, context);
        const connector = getConnector(agentType, { cwd });
        const { result } = await runAndNormalize(connector, prompt, response, { progress, streamWriter });

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

    // Flow complete — write terminal state (file retained per STRAT-COMP-4 contract)
    if (response.status === 'complete') {
      console.log('\nBuild complete.');
      await visionWriter.updateItemStatus(itemId, 'complete');
      const termState = readActiveBuild(dataDir);
      if (termState) {
        writeActiveBuild(dataDir, { ...termState, status: 'complete', completedAt: new Date().toISOString() });
      }
    } else if (response.status === 'killed') {
      console.log('\nBuild killed.');
      await visionWriter.updateItemStatus(itemId, 'killed');
      const termState = readActiveBuild(dataDir);
      if (termState) {
        writeActiveBuild(dataDir, { ...termState, status: 'aborted', completedAt: new Date().toISOString() });
      }
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

    // File retained on disk per STRAT-COMP-4 — overwritten on next build start

  } finally {
    // Close stream writer with appropriate status (idempotent — signal handler may have already closed)
    if (streamWriter) {
      streamWriter.close(buildStatus);
    }
    if (signalHandler) {
      process.removeListener('SIGINT', signalHandler);
      process.removeListener('SIGTERM', signalHandler);
    }
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
  visionWriter, itemId, dataDir, gateOpts, progress,
  streamWriter
) {
  let resp = flowDispatch.child_step;
  const childFlowId = flowDispatch.child_flow_id;
  const parentFlowId = flowDispatch.parent_flow_id;
  const childFlowName = flowDispatch.child_flow_name ?? 'sub-flow';

  while (resp.status !== 'complete' && resp.status !== 'killed') {
    if (resp.status === 'execute_step') {
      if (progress) {
        progress.subFlowStep(childFlowName, resp.step_id);
      } else {
        console.log(`  [${childFlowName}] ${resp.step_id}...`);
      }
      await visionWriter.updateItemPhase(itemId, `${childFlowName}:${resp.step_id}`);
      updateActiveBuildStep(dataDir, resp.step_id);

      // Stream: child step start
      if (streamWriter) {
        streamWriter.write({
          type: 'build_step_start',
          stepId: resp.step_id,
          stepNum: resp.step_number ?? '?',
          totalSteps: resp.total_steps ?? '?',
          agent: resp.agent ?? 'claude',
          flowId: childFlowId,
          parentFlowId,
        });
      }

      const agentType = resp.agent ?? 'claude';
      const prompt = buildStepPrompt(resp, context);
      const connector = getConnector(agentType, { cwd: context.cwd });
      let childMainResult;
      try {
        childMainResult = await runAndNormalize(connector, prompt, resp, { progress, streamWriter });
      } catch (err) {
        if (streamWriter) streamWriter.write({ type: 'build_error', message: err.message, stepId: resp.step_id });
        throw err;
      }
      const { result } = childMainResult;

      resp = await stratum.stepDone(
        childFlowId, resp.step_id,
        result ?? { summary: 'Step complete' }
      );

      // Stream: child step done
      if (streamWriter) {
        streamWriter.write({
          type: 'build_step_done',
          stepId: resp.step_id,
          summary: (result ?? {}).summary ?? 'Step complete',
          flowId: childFlowId,
          parentFlowId,
        });
      }

    } else if (resp.status === 'await_gate') {
      updateActiveBuildStep(dataDir, resp.step_id);

      // Stream: child gate pending
      if (streamWriter) {
        streamWriter.write({
          type: 'build_gate',
          stepId: resp.step_id,
          gateType: resp.gate_type ?? 'approval',
          flowId: childFlowId,
          parentFlowId,
        });
      }

      if (progress) progress.pause();
      console.log(`  [${childFlowName}] Gate: ${resp.step_id}`);
      const gateId = await visionWriter.createGate(childFlowId, resp.step_id, itemId);

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
      await visionWriter.resolveGate(gateId, outcome);
      resp = await stratum.gateResolve(childFlowId, resp.step_id, outcome, rationale, 'human');
      if (progress) progress.resume();

      // Stream: child gate resolved
      if (streamWriter) {
        streamWriter.write({
          type: 'build_gate_resolved',
          stepId: resp.step_id,
          outcome, rationale: rationale ?? '',
          flowId: childFlowId,
          parentFlowId,
        });
      }

    } else if (resp.status === 'ensure_failed' || resp.status === 'schema_failed') {
      {
        const currentState = readActiveBuild(dataDir);
        const violationList = (resp.violations || []).slice(-10);
        updateActiveBuildStep(dataDir, resp.step_id, {
          retries: ((currentState?.retries) || 0) + 1,
          violations: violationList,
        });
      }
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
      await runAndNormalize(fixConnector, fixPrompt, resp, { progress, streamWriter });

      if (progress) {
        progress.retry(childFlowName, resp.step_id, stepAgent);
      } else {
        console.log(`  [${childFlowName}] ↻ Retrying ${resp.step_id} (${stepAgent})`);
      }
      const prompt = buildRetryPrompt(resp, violations, context);
      const connector = getConnector(stepAgent, { cwd: context.cwd });
      const { result } = await runAndNormalize(connector, prompt, resp, { progress, streamWriter });

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
        visionWriter, itemId, dataDir, gateOpts, progress,
        streamWriter
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
    pipeline: 'build',
    currentStepId: response.step_id,
    specPath: 'pipelines/build.stratum.yaml',
    stepNum: response.step_number ?? 1,
    totalSteps: response.total_steps ?? null,
    retries: 0,
    violations: [],
    status: 'running',
    startedAt: new Date().toISOString(),
  });

  return response;
}

function updateActiveBuildStep(dataDir, stepId, extra = {}) {
  const state = readActiveBuild(dataDir);
  if (state) {
    state.currentStepId = stepId;
    Object.assign(state, extra);
    writeActiveBuild(dataDir, state);
  }
}

/**
 * Poll gate resolution via REST. Returns resolved gate or null on server loss.
 * @param {VisionWriter} visionWriter
 * @param {string} gateId
 * @param {number} [intervalMs=2000]
 * @returns {Promise<object|null>} resolved gate or null (server lost mid-poll)
 */
async function pollGateResolution(visionWriter, gateId, intervalMs = 2000) {
  let consecutiveFailures = 0;
  while (true) {
    try {
      const gate = await visionWriter.getGate(gateId, { requireServer: true });
      consecutiveFailures = 0;
      if (!gate) throw new Error(`Gate ${gateId} not found (404)`);
      if (gate.status === 'expired') throw new Error(`Gate ${gateId} expired`);
      if (gate.status !== 'pending') return gate;
    } catch (err) {
      if (err instanceof ServerUnreachableError) {
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
          console.log('Server lost during gate poll — falling back to readline.');
          return null;
        }
      } else {
        throw err;
      }
    }
    await new Promise(r => setTimeout(r, intervalMs));
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
  const item = await visionWriter.findFeatureItem(active.featureCode);
  const itemId = item?.id;
  if (itemId) {
    await visionWriter.updateItemStatus(itemId, 'killed');
  }

  // Write terminal state (file retained per STRAT-COMP-4 contract)
  writeActiveBuild(dataDir, { ...active, status: 'aborted', completedAt: new Date().toISOString() });
  console.log('Build aborted.');
}
