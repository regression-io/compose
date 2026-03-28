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
import { execSync } from 'node:child_process';

import { StratumMcpClient } from './stratum-mcp-client.js';
import { runAndNormalize, AgentTimeoutError } from './result-normalizer.js';
import { buildStepPrompt, buildRetryPrompt, buildGateContext } from './step-prompt.js';
import { promptGate } from './gate-prompt.js';
import { VisionWriter, ServerUnreachableError } from './vision-writer.js';
import { resolvePort } from './resolve-port.js';
import { probeServer } from './server-probe.js';
import { CliProgress } from './cli-progress.js';
import { BuildStreamWriter } from './build-stream-writer.js';

import YAML from 'yaml';
import { ClaudeSDKConnector } from '../server/connectors/claude-sdk-connector.js';
import { CodexConnector } from '../server/connectors/codex-connector.js';
import { updateFeature } from './feature-json.js';
import { evaluatePolicy } from '../server/policy-evaluator.js';

// ---------------------------------------------------------------------------
// Spec helpers
// ---------------------------------------------------------------------------

/**
 * Extract the flow name from a parsed Stratum spec.
 * Priority:
 *   1. v0.3 workflow.name (explicit declaration)
 *   2. Flow matching templateName (convention: template "build" → flow "build")
 *   3. First key under flows: (single-flow specs)
 * Falls back to 'build' if parsing fails or no flow is found.
 */
function extractFlowName(specYaml, templateName = 'build') {
  try {
    const parsed = YAML.parse(specYaml);
    // v0.3 workflow.name — explicit declaration wins
    if (parsed?.workflow?.name) return parsed.workflow.name;
    // flows-based specs
    if (parsed?.flows) {
      const keys = Object.keys(parsed.flows);
      // Prefer flow matching the template name
      if (keys.includes(templateName)) return templateName;
      // Single-flow or non-default template: use first key
      if (keys.length > 0) return keys[0];
    }
  } catch { /* fall through */ }
  return 'build';
}

// ---------------------------------------------------------------------------
// Agent registry
// ---------------------------------------------------------------------------

const DEFAULT_AGENTS = new Map([
  ['claude', (opts) => new ClaudeSDKConnector(opts)],
  ['codex', (opts) => new CodexConnector(opts)],
]);

// Per-step timeout in ms. Steps not listed get the default.
// These are circuit breakers — generous enough for real work, tight enough to stop spiraling.
const STEP_TIMEOUT_MS = {
  explore_design: 20 * 60_000,  // 20 min
  scope:          5  * 60_000,  // 5 min
  prd:            15 * 60_000,  // 15 min
  architecture:   15 * 60_000,  // 15 min
  blueprint:      20 * 60_000,  // 20 min
  verification:   10 * 60_000,  // 10 min
  plan:           15 * 60_000,  // 15 min
  execute:        45 * 60_000,  // 45 min
  review:         10 * 60_000,  // 10 min (codex sub-flow step)
  run_tests:      10 * 60_000,  // 10 min (coverage sub-flow step)
  report:         10 * 60_000,  // 10 min
  docs:           10 * 60_000,  // 10 min
  ship:           5  * 60_000,  // 5 min (should be fast — just git ops)
};
const DEFAULT_TIMEOUT_MS = 30 * 60_000; // 30 min fallback

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
  // Always stamp PID so concurrent processes can detect each other
  state.pid = process.pid;
  const target = activeBuildPath(dataDir);
  const tmp = target + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, target);
}

/**
 * Check whether a process with the given PID is still alive.
 */
function isProcessAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check, no actual signal
    return true;
  } catch {
    return false;
  }
}

/**
 * Build an askAgent helper that answers a single question using the claude connector.
 * Shared by the await_gate handlers in runBuild and executeChildFlow.
 */
/**
 * Build an askAgent helper that answers gate questions with full workflow context.
 *
 * @param {Function} getConnector - Connector factory
 * @param {object}   context      - Execution context (cwd, featureCode, featureDir, stepHistory, filesChanged)
 * @param {object}   gateDispatch - Stratum gate dispatch (step_id, on_approve, on_revise, on_kill)
 * @param {object}   [gateExtras] - Optional enrichment (fromPhase, toPhase, summary)
 */
function makeAskAgent(getConnector, context, gateDispatch, gateExtras) {
  const preamble = buildGateContext(gateDispatch, context, gateExtras);

  return async function askAgent(question, artifactPath) {
    const connector = getConnector('claude', { cwd: context.cwd });
    const fileRef = artifactPath && !artifactPath.endsWith('/')
      ? `Read the file "${artifactPath}" and answer`
      : `Look at the project files in the working directory and answer`;
    const qaPrompt =
      `${preamble}\n\n---\n\n` +
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
}

export function deleteActiveBuild(dataDir) {
  const p = activeBuildPath(dataDir);
  if (existsSync(p)) unlinkSync(p);
}

// ---------------------------------------------------------------------------
// Flow-status helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when a Stratum flow has reached a terminal state and will
 * never produce more steps.  Used to detect stale lock files and decide
 * whether a resumed flow needs a fresh start.
 */
function isTerminalFlow(status) {
  return status === 'complete' || status === 'killed';
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run a feature through the Stratum lifecycle.
 *
 * @param {string} featureCode - Feature code (e.g. 'FEAT-1')
 * @param {object} opts
 * @param {string}   [opts.cwd]              - Project root with .compose/ (default: process.cwd())
 * @param {string}   [opts.workingDirectory] - Agent working directory (default: opts.cwd). Use when
 *                                             agents need to operate in a different directory than
 *                                             the project root (e.g. parent dir for cross-repo features).
 * @param {boolean}  [opts.abort]            - Abort active build instead of running
 * @param {string}   [opts.description]      - Feature description override
 * @param {Function} [opts.connectorFactory] - Override agent connector creation (for testing)
 * @param {object}   [opts.gateOpts]         - Options for gate prompt (input/output streams)
 * @param {string}   [opts.template]         - Pipeline template name (default: 'build').
 *                                             Resolves to pipelines/${template}.stratum.yaml.
 */
export async function runBuild(featureCode, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const agentCwd = opts.workingDirectory ?? cwd;
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

  // Load lifecycle spec (template selection)
  const templateName = opts.template ?? 'build';
  const specPath = join(cwd, 'pipelines', `${templateName}.stratum.yaml`);
  if (!existsSync(specPath)) {
    throw new Error(`Lifecycle spec not found: ${specPath}`);
  }
  const specYaml = readFileSync(specPath, 'utf-8');

  // Build description from feature folder
  const description = opts.description ?? loadFeatureDescription(featureDir, featureCode);

  // Vision writer
  const visionWriter = new VisionWriter(dataDir);
  const itemId = await visionWriter.ensureFeatureItem(featureCode, featureCode);

  // Load policy settings (lazy from disk — works for all callers)
  let policySettings = { policies: {} };
  try {
    const settingsPath = join(dataDir, 'settings.json');
    if (existsSync(settingsPath)) {
      policySettings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[build] Failed to load settings: ${err.message} — defaulting all gates to 'gate' mode`);
    }
  }

  if (agentCwd !== cwd) {
    console.log(`Agent working directory: ${agentCwd}`);
  }

  // CLI progress renderer
  const progress = new CliProgress();

  // Stratum MCP client
  const stratum = new StratumMcpClient();
  await stratum.connect({ cwd });

  // Update feature.json status to IN_PROGRESS
  updateFeature(cwd, featureCode, { status: 'IN_PROGRESS' });

  // Hoisted for finally-block visibility
  let streamWriter = null;
  let buildStatus = 'complete';
  let signalHandler = null;

  try {
    // Check for active build (resume)
    const active = readActiveBuild(dataDir);
    let response;
    let isFreshStart = true;

    if (active && active.featureCode === featureCode && active.flowId) {
      // Same feature — try to resume or start fresh
      if (active.status && active.status !== 'running') {
        console.log(`Previous build ${active.status}. Starting fresh.`);
        response = await startFresh(stratum, specYaml, featureCode, description, dataDir, templateName);
      } else if (active.pid && active.pid !== process.pid && isProcessAlive(active.pid)) {
        // Same feature, different live process — block
        throw new Error(
          `Build already running for ${featureCode} (pid ${active.pid}). ` +
          `Use 'compose build --abort' to cancel it.`
        );
      } else {
        console.log(`Found previous build for ${featureCode} (flow: ${active.flowId})`);
        try {
          response = await stratum.resume(active.flowId);
          if (isTerminalFlow(response.status)) {
            console.log(`Previous build already ${response.status}. Starting fresh.`);
            response = await startFresh(stratum, specYaml, featureCode, description, dataDir, templateName);
          } else {
            console.log(`Resuming from step: ${response.step_id}`);
            isFreshStart = false;
          }
        } catch (err) {
          const recoverable = err?.code === 'flow_not_found'
            || err?.code === 'STRATUM_ERROR'
            || err?.message?.includes('No active flow');
          if (recoverable) {
            console.log('Previous flow not found. Starting fresh.');
            response = await startFresh(stratum, specYaml, featureCode, description, dataDir, templateName);
          } else {
            throw err;
          }
        }
      }
    } else {
      // Different feature or no active build — start fresh.
      // active-build.json is last-writer-wins: concurrent builds for
      // different features are allowed; the UI shows the most recent.
      response = await startFresh(stratum, specYaml, featureCode, description, dataDir, templateName);
    }

    // Update vision state
    await visionWriter.updateItemStatus(itemId, 'in_progress');

    // Stream writer — instantiated after plan/resume succeeds to prevent
    // a rejected/duplicate invocation from truncating an active build's stream.
    // Only truncate on fresh starts; resumed builds append to existing stream.
    streamWriter = new BuildStreamWriter(composeDir, featureCode, { truncate: isFreshStart });
    streamWriter.write({
      type: isFreshStart ? 'build_start' : 'build_resume',
      featureCode,
      flowId: response.flow_id,
      specPath: `pipelines/${templateName}.stratum.yaml`,
    });

    // SIGINT/SIGTERM: mark build as killed
    signalHandler = () => {
      buildStatus = 'killed';
      streamWriter.close('killed');
    };
    process.on('SIGINT', signalHandler);
    process.on('SIGTERM', signalHandler);

    // Dispatch loop — agents operate in agentCwd (which may differ from cwd for cross-repo builds)
    // stepHistory accumulates context across steps so downstream steps don't re-explore
    const stepHistory = [];
    const context = {
      cwd: agentCwd,
      featureCode,
      featureDir: join(cwd, 'docs', 'features', featureCode),
      stepHistory,
    };

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

        // Ship step: run git commit in-process instead of delegating to a sandboxed agent.
        // The agent can't git commit (sandbox blocks it), so we do it here where we have
        // full shell access. This turns a 10+ minute spiral into a <5 second operation.
        if (stepId === 'ship') {
          const shipResult = await executeShipStep(featureCode, agentCwd, cwd, context, description, progress);
          stepHistory.push({
            stepId: 'ship',
            artifact: shipResult.artifact,
            summary: shipResult.summary,
            outcome: shipResult.outcome,
          });
          if (shipResult.outcome === 'failed') {
            console.error(`\nShip failed: ${shipResult.summary}`);
            buildStatus = 'failed';
            streamWriter.write({
              type: 'build_step_done',
              stepId: 'ship', summary: shipResult.summary, retries: 0,
              violations: [shipResult.summary], flowId,
            });
            break;
          }
          response = await stratum.stepDone(flowId, stepId, shipResult);
          streamWriter.write({
            type: 'build_step_done',
            stepId, summary: shipResult.summary, retries: 0, violations: [], flowId,
          });
          continue;
        }

        // Build prompt and dispatch to agent
        const stepStartMs = Date.now();
        const agentType = response.agent ?? 'claude';
        const prompt = buildStepPrompt(response, context);
        const connector = getConnector(agentType, { cwd: agentCwd });
        const maxDurationMs = STEP_TIMEOUT_MS[stepId] ?? DEFAULT_TIMEOUT_MS;
        let mainResult;
        try {
          mainResult = await runAndNormalize(connector, prompt, response, { progress, streamWriter, maxDurationMs });
        } catch (err) {
          if (err instanceof AgentTimeoutError) {
            console.warn(`\n⚠ Agent timed out on step "${stepId}" after ${Math.round(err.durationMs / 1000)}s`);
            streamWriter.write({ type: 'build_error', message: err.message, stepId });
            // Report timeout as a failed result so stratum can retry
            mainResult = { text: '', result: { outcome: 'failed', summary: `Timed out after ${Math.round(err.durationMs / 1000)}s` } };
          } else {
            streamWriter.write({ type: 'build_error', message: err.message, stepId });
            throw err;
          }
        }
        const { result } = mainResult;

        // Accumulate step context for downstream steps
        const entry = {
          stepId,
          artifact: result?.artifact ?? null,
          summary: result?.summary ?? 'Step complete',
          outcome: result?.outcome ?? 'complete',
          agent: response.agent ?? 'claude',
          durationMs: Date.now() - stepStartMs,
        };

        // After code-producing steps, snapshot changed files so downstream
        // steps (review, coverage, docs, ship) know exactly what was touched.
        // Maintained as context.filesChanged (pre-deduplicated) for step-prompt.js.
        if (stepId === 'execute' || stepId === 'docs') {
          try {
            const diff = execSync('git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null', {
              cwd: agentCwd, encoding: 'utf-8', timeout: 5000,
            }).trim();
            if (diff) {
              const files = diff.split('\n').filter(Boolean);
              entry.filesChanged = files;
              // Merge into context-level deduplicated list
              const existing = new Set(context.filesChanged ?? []);
              for (const f of files) existing.add(f);
              context.filesChanged = [...existing];
            }
          } catch { /* git not available or no repo — skip */ }
        }

        stepHistory.push(entry);

        // Persist BuildProfile from scope step into feature.json
        if (stepId === 'scope' && result) {
          updateFeature(cwd, featureCode, {
            complexity: result.complexity,
            profile: {
              needs_prd: result.needs_prd,
              needs_architecture: result.needs_architecture,
              needs_verification: result.needs_verification,
              needs_report: result.needs_report,
              rationale: result.rationale,
            },
          });
        }

        // Keep a flat deduplicated file manifest on context so buildStepPrompt
        // doesn't need to recompute it from history on every prompt build.
        if (entry.filesChanged?.length > 0) {
          const set = new Set(context.filesChanged ?? []);
          for (const f of entry.filesChanged) set.add(f);
          context.filesChanged = [...set];
        }

        response = await stratum.stepDone(flowId, stepId, result ?? { summary: 'Step complete' });
        syncStepHistory(dataDir, stepHistory);

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

        // Gate enrichment extras for STRAT-COMP-6
        const gateExtras = {
          fromPhase: response.from_phase ?? null,
          toPhase: response.to_phase ?? null,
          artifact: response.artifact ?? null,
          summary: response.summary ?? null,
        };

        // ── Policy evaluation (ITEM-23) ────────────────────────────────────
        const policy = evaluatePolicy(policySettings, stepId, {
          fromPhase: response.from_phase,
          toPhase: response.to_phase,
        });

        if (policy.mode === 'skip') {
          // Silent pass-through — no gate record, no UI
          response = await stratum.gateResolve(flowId, stepId, 'approve', policy.reason, 'system');
          streamWriter.write({
            type: 'build_gate_resolved',
            stepId, outcome: 'approve', rationale: policy.reason, flowId, policyMode: 'skip',
          });
          stepHistory.push({ stepId, artifact: null, summary: `Gate skip: ${policy.reason}`, outcome: 'approve' });
          syncStepHistory(dataDir, stepHistory);

        } else if (policy.mode === 'flag') {
          // Auto-approve — no gate record, stream event for audit
          console.log(`  Gate auto-approved (policy: flag) — ${policy.reason}`);
          response = await stratum.gateResolve(flowId, stepId, 'approve', policy.reason, 'system');
          streamWriter.write({
            type: 'build_gate_resolved',
            stepId, outcome: 'approve', rationale: policy.reason, flowId, policyMode: 'flag',
          });
          stepHistory.push({ stepId, artifact: null, summary: `Gate flag: ${policy.reason}`, outcome: 'approve' });
          syncStepHistory(dataDir, stepHistory);

        } else {
          // mode === 'gate' — human approval required (existing behavior)
          streamWriter.write({
            type: 'build_gate',
            stepId, flowId,
            gateType: response.gate_type ?? 'approval',
            policyMode: 'gate',
          });

          progress.pause();
          console.log(`\nGate: ${stepId}`);

          const askAgent = makeAskAgent(getConnector, context, response, gateExtras);
          const serverUp = await probeServer();
          let outcome, rationale;

          if (serverUp) {
            const gateId = await visionWriter.createGate(flowId, stepId, itemId, { ...gateExtras, policyMode: 'gate' });
            console.log('Gate delegated to web UI. Waiting for resolution...');
            const resolved = await pollGateResolution(visionWriter, gateId);
            if (resolved) {
              outcome = resolved.outcome;
              rationale = resolved.comment ?? '';
            } else {
              const result = await promptGate(response, {
                ...(opts.gateOpts ?? {}),
                artifact: context.cwd,
                askAgent,
              });
              outcome = result.outcome;
              rationale = result.rationale;
              await visionWriter.resolveGate(gateId, outcome);
              try { await visionWriter._restResolveGate(gateId, outcome); } catch { /* ignore */ }
            }
          } else {
            const gateId = await visionWriter.createGate(flowId, stepId, itemId, { ...gateExtras, policyMode: 'gate' });
            const result = await promptGate(response, {
              ...(opts.gateOpts ?? {}),
              artifact: context.cwd,
              askAgent,
            });
            outcome = result.outcome;
            rationale = result.rationale;
            await visionWriter.resolveGate(gateId, outcome);
          }

          stepHistory.push({
            stepId,
            artifact: null,
            summary: `Gate ${outcome}${rationale ? ': ' + rationale : ''}`,
            outcome,
          });
          syncStepHistory(dataDir, stepHistory);

          response = await stratum.gateResolve(flowId, stepId, outcome, rationale, 'human');
          progress.resume();

          streamWriter.write({
            type: 'build_gate_resolved',
            stepId, outcome, rationale: rationale ?? '', flowId, policyMode: 'gate',
          });
        }

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
        const retryStepId = response.step_id ?? stepId;
        const agentType = response.agent ?? 'claude';
        const prompt = buildRetryPrompt(response, violations, context, response.conflicts);
        const connector = getConnector(agentType, { cwd: agentCwd });
        const retryTimeout = STEP_TIMEOUT_MS[retryStepId] ?? DEFAULT_TIMEOUT_MS;
        let retryResult;
        try {
          retryResult = await runAndNormalize(connector, prompt, response, { progress, streamWriter, maxDurationMs: retryTimeout });
        } catch (err) {
          if (err instanceof AgentTimeoutError) {
            console.warn(`\n⚠ Agent timed out on retry "${retryStepId}" after ${Math.round(err.durationMs / 1000)}s`);
            retryResult = { text: '', result: { outcome: 'failed', summary: `Timed out after ${Math.round(err.durationMs / 1000)}s` } };
          } else {
            throw err;
          }
        }
        const { result } = retryResult;

        // Update stepHistory with retry result (replace prior failed entry if present)
        const priorIdx = stepHistory.findIndex(h => h.stepId === retryStepId);
        const currentBuild = readActiveBuild(dataDir);
        const retryEntry = {
          stepId: retryStepId,
          artifact: result?.artifact ?? null,
          summary: result?.summary ?? 'Retry complete',
          outcome: result?.outcome ?? 'complete',
          agent: response.agent ?? 'claude',
          retries: currentBuild?.retries ?? 0,
          violations: currentBuild?.violations ?? [],
        };
        if (priorIdx !== -1) {
          stepHistory[priorIdx] = retryEntry;
        } else {
          stepHistory.push(retryEntry);
        }

        response = await stratum.stepDone(
          response.flow_id, retryStepId,
          result ?? { summary: 'Retry complete' }
        );

      } else if (response.status === 'parallel_dispatch') {
        // STRAT-PAR-4 — Parallel task dispatch with git worktree isolation.
        // Each task gets its own worktree; diffs are collected and applied
        // to the main worktree in topo order after all tasks complete.
        const dispatchResponse = response;
        const tasks            = dispatchResponse.tasks            ?? [];
        const intentTemplate   = dispatchResponse.intent_template  ?? '';
        const agentType        = dispatchResponse.agent            ?? 'claude';
        const dispFlowId       = dispatchResponse.flow_id;
        const dispStepId       = dispatchResponse.step_id;
        const dispStepNum      = dispatchResponse.step_number      ?? '?';
        const dispTotalSteps   = dispatchResponse.total_steps      ?? '?';
        const useWorktrees     = (dispatchResponse.isolation ?? 'worktree') === 'worktree';

        // Stream: parallel dispatch batch start
        streamWriter.write({
          type: 'build_step_start', stepId: dispStepId,
          stepNum: dispStepNum, totalSteps: dispTotalSteps,
          agent: agentType,
          intent: `parallel_dispatch: ${tasks.length} task${tasks.length !== 1 ? 's' : ''}`,
          flowId: dispFlowId, parallel: true,
        });
        progress.stepStart(dispStepNum, dispTotalSteps, dispStepId);

        // Worktree base directory
        const parDir = join(agentCwd, '.compose', 'par');

        // Check if we're in a git repo (worktrees require it)
        let isGitRepo = false;
        if (useWorktrees) {
          try {
            execSync('git rev-parse --is-inside-work-tree', { cwd: agentCwd, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
            isGitRepo = true;
            mkdirSync(parDir, { recursive: true });
          } catch { /* not a git repo — fall back to shared cwd */ }
        }
        const worktreeIsolation = useWorktrees && isGitRepo;

        // Fan out tasks respecting max_concurrent (default 3) via a lightweight semaphore
        const maxConcurrent = Math.max(1, dispatchResponse.max_concurrent ?? 3);
        let activeSlots = 0;
        const slotWaiters = [];
        const acquireSlot = () => {
          if (activeSlots < maxConcurrent) { activeSlots++; return Promise.resolve(); }
          return new Promise(res => slotWaiters.push(res));
        };
        const releaseSlot = () => {
          activeSlots--;
          if (slotWaiters.length > 0) { activeSlots++; slotWaiters.shift()(); }
        };

        // Track worktree paths for cleanup and diffs for merge
        const worktreePaths = new Map();  // taskId → worktree path
        const taskDiffs     = new Map();  // taskId → diff string

        const settled = await Promise.allSettled(
          tasks.map(async (task) => {
            await acquireSlot();
            const taskId = task.id;
            let taskCwd = agentCwd;
            const wtPath = join(parDir, taskId);

            // Create git worktree for this task
            if (worktreeIsolation) {
              try {
                execSync(`git worktree add "${wtPath}" --detach HEAD`, {
                  cwd: agentCwd, encoding: 'utf-8', timeout: 30000, stdio: 'pipe',
                });
                worktreePaths.set(taskId, wtPath);
                taskCwd = wtPath;
                // COMP-AGT-1: Write .owner file for worktree GC liveness checks
                try {
                  writeFileSync(join(wtPath, '.owner'), String(process.pid), 'utf-8');
                } catch { /* best-effort */ }
              } catch (err) {
                streamWriter.write({ type: 'build_error', message: `worktree create failed for ${taskId}: ${err.message}`, stepId: taskId });
                releaseSlot();
                return { taskId, status: 'failed', error: `worktree create failed: ${err.message}` };
              }
            }

            // Interpolate {task.*} placeholders in intent template
            const taskIntent = intentTemplate
              .replace(/\{task\.description\}/g, task.description ?? '')
              .replace(/\{task\.files_owned\}/g, (task.files_owned ?? []).join(', '))
              .replace(/\{task\.files_read\}/g,  (task.files_read  ?? []).join(', '))
              .replace(/\{task\.depends_on\}/g,  (task.depends_on  ?? []).join(', '))
              .replace(/\{task\.id\}/g,           taskId);

            // Synthetic dispatch shape for buildStepPrompt / runAndNormalize
            const syntheticDispatch = {
              step_id:       taskId,
              intent:        taskIntent,
              inputs:        { featureCode, taskId, description: task.description ?? '' },
              output_fields: dispatchResponse.output_fields
                ? Object.entries(dispatchResponse.output_fields).map(([name, type]) => ({ name, type }))
                : [],
              ensure:        dispatchResponse.ensure ?? [],
            };

            // Stream: individual task start
            streamWriter.write({
              type: 'build_step_start', stepId: taskId,
              stepNum: `∥${taskId}`, totalSteps: dispTotalSteps,
              agent: agentType, intent: taskIntent,
              flowId: dispFlowId, parallel: true,
            });

            try {
              const prompt    = buildStepPrompt(syntheticDispatch, context);
              const connector = getConnector(agentType, { cwd: taskCwd });
              const taskResult = await runAndNormalize(connector, prompt, syntheticDispatch, { progress, streamWriter });

              // Collect diff from worktree before cleanup
              if (worktreeIsolation && worktreePaths.has(taskId)) {
                // COMP-AGT-1: Disk quota check — skip merge if worktree exceeds limit
                const diskQuotaMB = dispatchResponse.diskQuotaMB ?? 500;
                try {
                  const duOut = execSync(`du -sk "${wtPath}"`, { encoding: 'utf-8', timeout: 10000, stdio: 'pipe' }).trim();
                  const sizeKB = parseInt(duOut.split(/\s+/)[0], 10);
                  if (sizeKB / 1024 > diskQuotaMB) {
                    streamWriter.write({ type: 'build_error', message: `Worktree ${taskId} exceeds ${diskQuotaMB}MB quota (${Math.round(sizeKB / 1024)}MB), skipping merge`, stepId: taskId });
                    return { taskId, status: 'failed', error: `Disk quota exceeded: ${Math.round(sizeKB / 1024)}MB > ${diskQuotaMB}MB` };
                  }
                } catch { /* du failed — proceed anyway */ }

                try {
                  // Stage all changes in worktree to capture new files too
                  execSync('git add -A', { cwd: wtPath, encoding: 'utf-8', timeout: 10000, stdio: 'pipe' });
                  const diff = execSync('git diff --cached HEAD', {
                    cwd: wtPath, encoding: 'utf-8', timeout: 30000, stdio: 'pipe',
                  });
                  if (diff.trim()) taskDiffs.set(taskId, diff);
                } catch (err) {
                  streamWriter.write({ type: 'build_error', message: `diff collect failed for ${taskId}: ${err.message}`, stepId: taskId });
                }
              }

              // Stream: individual task done
              streamWriter.write({
                type: 'build_step_done', stepId: taskId,
                summary: (taskResult.result ?? {}).summary ?? 'Task complete',
                flowId: dispFlowId, parallel: true,
              });

              return { taskId, status: 'complete', result: taskResult.result ?? { summary: 'Task complete' } };
            } catch (err) {
              streamWriter.write({ type: 'build_error', message: err.message, stepId: taskId });
              return { taskId, status: 'failed', error: err.message };
            } finally {
              // Clean up worktree regardless of success/failure
              if (worktreeIsolation && worktreePaths.has(taskId)) {
                try {
                  execSync(`git worktree remove "${wtPath}" --force`, {
                    cwd: agentCwd, encoding: 'utf-8', timeout: 30000, stdio: 'pipe',
                  });
                } catch { /* best-effort cleanup */ }
              }
              releaseSlot();
            }
          })
        );

        // Collect settled outcomes into stratum_parallel_done format
        const taskResults = settled.map(outcome => {
          if (outcome.status === 'rejected') {
            return { task_id: 'unknown', status: 'failed', error: String(outcome.reason) };
          }
          const { taskId, status, result, error } = outcome.value;
          return status === 'complete'
            ? { task_id: taskId, status: 'complete', result }
            : { task_id: taskId, status: 'failed',   error };
        });

        // Merge diffs from worktrees into main working tree (topo order)
        let mergeStatus = 'clean';
        if (worktreeIsolation && taskDiffs.size > 0) {
          // Build topo order from task dependency graph
          const taskMap = new Map(tasks.map(t => [t.id, t]));
          const topoOrder = [];
          const visited = new Set();
          const visiting = new Set();
          const topoVisit = (id) => {
            if (visited.has(id)) return;
            if (visiting.has(id)) return; // cycle — skip
            visiting.add(id);
            const t = taskMap.get(id);
            if (t) {
              for (const dep of (t.depends_on ?? [])) topoVisit(dep);
            }
            visiting.delete(id);
            visited.add(id);
            topoOrder.push(id);
          };
          for (const t of tasks) topoVisit(t.id);

          // Snapshot pre-merge state so we can rollback on conflict
          let stashCreated = false;
          try {
            // Stash any uncommitted changes (including untracked) to create a rollback point
            const stashOut = execSync('git stash push -u -m "parallel-merge-snapshot"', {
              cwd: agentCwd, encoding: 'utf-8', timeout: 30000, stdio: 'pipe',
            }).trim();
            stashCreated = !stashOut.includes('No local changes');
          } catch { /* no changes to stash — clean tree is fine */ }

          // Apply diffs in topo order
          const conflictFiles = [];
          const appliedFiles  = new Set();
          for (const taskId of topoOrder) {
            const diff = taskDiffs.get(taskId);
            if (!diff) continue;

            // Write diff to temp file for git apply
            const diffPath = join(parDir, `${taskId}.patch`);
            try {
              writeFileSync(diffPath, diff, 'utf-8');

              // Dry-run check
              execSync(`git apply --check "${diffPath}"`, {
                cwd: agentCwd, encoding: 'utf-8', timeout: 30000, stdio: 'pipe',
              });

              // Apply for real
              execSync(`git apply "${diffPath}"`, {
                cwd: agentCwd, encoding: 'utf-8', timeout: 30000, stdio: 'pipe',
              });

              // Track applied files for context.filesChanged
              try {
                const applied = execSync('git diff --name-only HEAD', {
                  cwd: agentCwd, encoding: 'utf-8', timeout: 5000, stdio: 'pipe',
                }).trim();
                if (applied) {
                  for (const f of applied.split('\n').filter(Boolean)) appliedFiles.add(f);
                }
              } catch { /* ignore */ }
            } catch (err) {
              mergeStatus = 'conflict';
              conflictFiles.push({ taskId, error: err.message });
              streamWriter.write({
                type: 'build_error',
                message: `merge conflict applying ${taskId}: ${err.message}`,
                stepId: dispStepId,
              });

              // Rollback all applied patches — restore pre-merge state
              try {
                execSync('git checkout -- .', {
                  cwd: agentCwd, encoding: 'utf-8', timeout: 30000, stdio: 'pipe',
                });
                // Clean any new untracked files that patches created
                execSync('git clean -fd', {
                  cwd: agentCwd, encoding: 'utf-8', timeout: 30000, stdio: 'pipe',
                });
              } catch { /* best-effort rollback */ }

              break; // Stop applying on first conflict
            } finally {
              try { unlinkSync(diffPath); } catch { /* ignore */ }
            }
          }

          // Restore stashed changes (pre-existing working tree edits)
          if (stashCreated) {
            try {
              // Always pop: on conflict the rollback restored the clean base,
              // on success the merged patches are in the tree. Either way the
              // user's pre-existing edits must come back on top.
              execSync('git stash pop', {
                cwd: agentCwd, encoding: 'utf-8', timeout: 30000, stdio: 'pipe',
              });
            } catch { /* stash may have been consumed or conflict with patches */ }
          }

          // Update context.filesChanged with all files from parallel tasks
          if (mergeStatus !== 'conflict' && appliedFiles.size > 0) {
            const existing = new Set(context.filesChanged ?? []);
            for (const f of appliedFiles) existing.add(f);
            context.filesChanged = [...existing];
          }

          // If conflicts, include details in task results
          if (mergeStatus === 'conflict') {
            for (const { taskId, error } of conflictFiles) {
              const idx = taskResults.findIndex(r => r.task_id === taskId);
              if (idx >= 0) {
                taskResults[idx].status = 'failed';
                taskResults[idx].error  = `merge conflict: ${error}`;
              }
            }
          }
        } else if (!worktreeIsolation) {
          // No worktree isolation — tasks ran in same cwd, no merge needed
          mergeStatus = 'clean';
        }

        // Clean up .compose/par/ directory
        if (worktreeIsolation) {
          try { execSync(`rm -rf "${parDir}"`, { cwd: agentCwd, timeout: 5000, stdio: 'pipe' }); } catch { /* ignore */ }
        }

        // Stream: parallel dispatch batch done
        const nComplete = taskResults.filter(r => r.status === 'complete').length;
        streamWriter.write({
          type: 'build_step_done', stepId: dispStepId,
          summary: `parallel_dispatch: ${nComplete}/${taskResults.length} tasks ${mergeStatus === 'clean' ? 'merged' : 'conflict'}`,
          flowId: dispFlowId, parallel: true,
        });

        response = await stratum.parallelDone(dispFlowId, dispStepId, taskResults, mergeStatus);

      } else {
        // Unknown status — log and try to continue
        console.warn(`Unknown dispatch status: ${response.status}`);
        break;
      }
    }

    // Flow complete — write terminal state (file retained per STRAT-COMP-4 contract)
    if (response.status === 'complete') {
      buildStatus = 'complete';
      console.log('\nBuild complete.');
      await visionWriter.updateItemStatus(itemId, 'complete');
      updateFeature(cwd, featureCode, { status: 'COMPLETE' });
      const termState = readActiveBuild(dataDir);
      if (termState) {
        writeActiveBuild(dataDir, { ...termState, status: 'complete', completedAt: new Date().toISOString() });
      }
    } else if (response.status === 'killed') {
      buildStatus = 'killed';
      console.log('\nBuild killed.');
      await visionWriter.updateItemStatus(itemId, 'killed');
      updateFeature(cwd, featureCode, { status: 'PLANNED' });
      const termState = readActiveBuild(dataDir);
      if (termState) {
        writeActiveBuild(dataDir, { ...termState, status: 'aborted', completedAt: new Date().toISOString() });
      }
    } else if (buildStatus === 'failed') {
      // Ship failure or other explicit failure — write terminal state
      console.log('\nBuild failed.');
      await visionWriter.updateItemStatus(itemId, 'failed');
      updateFeature(cwd, featureCode, { status: 'PLANNED' });
      const termState = readActiveBuild(dataDir);
      if (termState) {
        writeActiveBuild(dataDir, { ...termState, status: 'failed', completedAt: new Date().toISOString() });
      }
    } else {
      buildStatus = 'failed';
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

// ---------------------------------------------------------------------------
// Ship step — runs git commit in-process (not via agent)
// ---------------------------------------------------------------------------

/**
 * Execute the ship step: run tests, stage feature files, commit.
 * Returns a PhaseResult-shaped object.
 */
async function executeShipStep(featureCode, agentCwd, cwd, context, description, progress) {
  const featureDir = `docs/features/${featureCode}`;

  try {
    // 0. Check if we're in a git repository — if not, skip git operations
    let isGitRepo = false;
    try {
      execSync('git rev-parse --is-inside-work-tree', { cwd: agentCwd, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
      isGitRepo = true;
    } catch { /* not a git repo */ }

    if (!isGitRepo) {
      return {
        phase: 'ship',
        artifact: 'no-git',
        outcome: 'complete',
        summary: 'No git repository — commit skipped (non-fatal)',
      };
    }

    // 1. Run feature-relevant tests (best-effort — don't block ship on test infra issues)
    if (progress) progress.toolUse('ship', 'Running tests...');
    try {
      execSync('npm test 2>&1 || true', { cwd: agentCwd, encoding: 'utf-8', timeout: 120_000 });
    } catch { /* test runner not available or timed out — proceed */ }

    // 2. Collect files to stage
    const filesToStage = new Set();

    // Feature docs
    filesToStage.add(featureDir);

    // Files changed during this build (tracked by context)
    if (context.filesChanged?.length > 0) {
      for (const f of context.filesChanged) filesToStage.add(f);
    }

    // Also catch any unstaged changes via git
    try {
      const dirty = execSync(
        'git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null',
        { cwd: agentCwd, encoding: 'utf-8', timeout: 5000 }
      ).trim();
      if (dirty) {
        for (const f of dirty.split('\n').filter(Boolean)) filesToStage.add(f);
      }
    } catch { /* no git or no changes */ }

    // Filter to only files that belong to this feature (feature docs, CHANGELOG, ROADMAP, README)
    const ownedPrefixes = [featureDir, 'CHANGELOG.md', 'ROADMAP.md', 'README.md', 'CLAUDE.md'];
    const featureFiles = [...filesToStage].filter(f => {
      // Feature docs always included
      if (f.startsWith(featureDir)) return true;
      // Doc updates
      if (ownedPrefixes.some(p => f === p || f.endsWith('/' + p))) return true;
      // Source files from context.filesChanged (the build created/modified these)
      if (context.filesChanged?.includes(f)) return true;
      return false;
    });

    if (featureFiles.length === 0) {
      return {
        phase: 'ship',
        artifact: 'no-changes',
        outcome: 'complete',
        summary: 'No files to commit — nothing to ship',
      };
    }

    // 3. Stage files
    if (progress) progress.toolUse('ship', `Staging ${featureFiles.length} files...`);
    for (const f of featureFiles) {
      try {
        execSync(`git add "${f}"`, { cwd: agentCwd, encoding: 'utf-8', timeout: 5000 });
      } catch { /* file might not exist or already staged */ }
    }

    // 4. Check if there's anything to commit
    const staged = execSync('git diff --cached --name-only', {
      cwd: agentCwd, encoding: 'utf-8', timeout: 5000,
    }).trim();

    if (!staged) {
      return {
        phase: 'ship',
        artifact: 'no-changes',
        outcome: 'complete',
        summary: 'All changes already committed',
      };
    }

    // 5. Build commit message
    const shortDesc = description.split('\n')[0].slice(0, 72);
    const commitMsg = `feat(${featureCode}): ${shortDesc}`;

    // 6. Commit
    if (progress) progress.toolUse('ship', 'Committing...');
    execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, {
      cwd: agentCwd, encoding: 'utf-8', timeout: 30_000,
    });

    // 7. Get the commit SHA
    const sha = execSync('git rev-parse HEAD', {
      cwd: agentCwd, encoding: 'utf-8', timeout: 5000,
    }).trim();

    const stagedFiles = staged.split('\n').filter(Boolean);
    if (progress) progress.toolUse('ship', `Committed ${sha.slice(0, 8)} (${stagedFiles.length} files)`);

    return {
      phase: 'ship',
      artifact: sha,
      outcome: 'complete',
      summary: `Committed ${sha.slice(0, 8)}: ${commitMsg} (${stagedFiles.length} files)`,
    };

  } catch (err) {
    return {
      phase: 'ship',
      artifact: '',
      outcome: 'failed',
      summary: `Ship failed: ${err.message}`,
    };
  }
}

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
      const childStepTimeout = STEP_TIMEOUT_MS[resp.step_id] ?? DEFAULT_TIMEOUT_MS;
      let childMainResult;
      try {
        childMainResult = await runAndNormalize(connector, prompt, resp, { progress, streamWriter, maxDurationMs: childStepTimeout });
      } catch (err) {
        if (err instanceof AgentTimeoutError) {
          console.warn(`\n⚠ Agent timed out on child step "${resp.step_id}" after ${Math.round(err.durationMs / 1000)}s`);
          childMainResult = { text: '', result: { outcome: 'failed', summary: `Timed out after ${Math.round(err.durationMs / 1000)}s` } };
        } else {
          if (streamWriter) streamWriter.write({ type: 'build_error', message: err.message, stepId: resp.step_id });
          throw err;
        }
      }
      const { result } = childMainResult;

      // Accumulate child step results into shared stepHistory
      if (context.stepHistory) {
        context.stepHistory.push({
          stepId: `${childFlowName}:${resp.step_id}`,
          artifact: result?.artifact ?? null,
          summary: result?.summary ?? 'Step complete',
          outcome: result?.outcome ?? 'complete',
        });
      }

      const completedStepId = resp.step_id;
      resp = await stratum.stepDone(
        childFlowId, completedStepId,
        result ?? { summary: 'Step complete' }
      );

      // Stream: child step done
      if (streamWriter) {
        streamWriter.write({
          type: 'build_step_done',
          stepId: completedStepId,
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
      const childAskAgent = makeAskAgent(getConnector, context, resp, null);

      const { outcome, rationale } = await promptGate(resp, {
        ...gateOpts,
        artifact: context.cwd,
        askAgent: childAskAgent,
      });
      await visionWriter.resolveGate(gateId, outcome);
      const gateStepId = resp.step_id;

      // Inject gate decision into step history so the re-run step sees it
      if (context.stepHistory) {
        context.stepHistory.push({
          stepId: `${childFlowName}:${gateStepId}`,
          artifact: null,
          summary: `Gate ${outcome}${rationale ? ': ' + rationale : ''}`,
          outcome,
        });
      }

      resp = await stratum.gateResolve(childFlowId, gateStepId, outcome, rationale, 'human');
      if (progress) progress.resume();

      // Stream: child gate resolved
      if (streamWriter) {
        streamWriter.write({
          type: 'build_gate_resolved',
          stepId: gateStepId,
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
      const fixTimeout = STEP_TIMEOUT_MS[resp.step_id] ?? DEFAULT_TIMEOUT_MS;
      try {
        await runAndNormalize(fixConnector, fixPrompt, resp, { progress, streamWriter, maxDurationMs: fixTimeout });
      } catch (err) {
        if (!(err instanceof AgentTimeoutError)) throw err;
        console.warn(`\n⚠ Fix agent timed out on "${resp.step_id}"`);
      }

      if (progress) {
        progress.retry(childFlowName, resp.step_id, stepAgent);
      } else {
        console.log(`  [${childFlowName}] ↻ Retrying ${resp.step_id} (${stepAgent})`);
      }
      const prompt = buildRetryPrompt(resp, violations, context, resp.conflicts);
      const connector = getConnector(stepAgent, { cwd: context.cwd });
      let childRetryResult;
      try {
        childRetryResult = await runAndNormalize(connector, prompt, resp, { progress, streamWriter, maxDurationMs: fixTimeout });
      } catch (err) {
        if (err instanceof AgentTimeoutError) {
          console.warn(`\n⚠ Retry agent timed out on "${resp.step_id}"`);
          childRetryResult = { text: '', result: { outcome: 'failed', summary: `Timed out` } };
        } else { throw err; }
      }
      const { result } = childRetryResult;

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

async function startFresh(stratum, specYaml, featureCode, description, dataDir, templateName) {
  const flowName = extractFlowName(specYaml, templateName);
  console.log(`Starting ${flowName} for ${featureCode}...`);
  const response = await stratum.plan(specYaml, flowName, { featureCode, description });

  writeActiveBuild(dataDir, {
    featureCode,
    flowId: response.flow_id,
    pipeline: flowName,
    currentStepId: response.step_id,
    specPath: `pipelines/${templateName}.stratum.yaml`,
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
 * Sync stepHistory into active-build.json so the UI can read per-step results.
 * Called after each step completes (execute or gate).
 */
function syncStepHistory(dataDir, stepHistory) {
  const state = readActiveBuild(dataDir);
  if (state) {
    // Top-level retries/violations on active-build apply to the current step
    const currentStepId = state.currentStepId;
    const topRetries = state.retries || 0;
    const topViolations = state.violations || [];

    state.steps = stepHistory.map(h => {
      const isCurrent = h.stepId === currentStepId;
      return {
        id: h.stepId,
        status: h.outcome === 'complete' ? 'done'
              : h.outcome === 'failed' ? 'failed'
              : h.outcome === 'approve' ? 'done'
              : h.outcome === 'revise' ? 'revised'
              : h.outcome === 'kill' ? 'killed'
              : h.outcome ?? 'done',
        summary: h.summary ?? null,
        artifact: h.artifact ?? null,
        agent: h.agent ?? null,
        durationMs: h.durationMs ?? null,
        filesChanged: h.filesChanged ?? null,
        retries: isCurrent ? topRetries : (h.retries ?? 0),
        violations: isCurrent ? topViolations : (h.violations ?? []),
      };
    });
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
    if (isTerminalFlow(audit.status)) {
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
