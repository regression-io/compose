/**
 * new.js — Product kickoff runner for `compose new`.
 *
 * Orchestrates project creation through a Stratum workflow:
 * research → brainstorm → gate → roadmap → gate → scaffold.
 *
 * Reuses the same dispatch loop pattern as build.js.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

import { StratumMcpClient } from './stratum-mcp-client.js';
import { runAndNormalize } from './result-normalizer.js';
import { buildStepPrompt, buildRetryPrompt } from './step-prompt.js';
import { promptGate } from './gate-prompt.js';
import { VisionWriter } from './vision-writer.js';

import { validateStep } from './step-validator.js';

import { ClaudeSDKConnector } from '../server/connectors/claude-sdk-connector.js';
import { CodexConnector } from '../server/connectors/codex-connector.js';

// ---------------------------------------------------------------------------
// Agent registry (same as build.js)
// ---------------------------------------------------------------------------

const DEFAULT_AGENTS = new Map([
  ['claude', (opts) => new ClaudeSDKConnector(opts)],
  ['codex', (opts) => new CodexConnector(opts)],
]);

function defaultConnectorFactory(agentType, opts) {
  const factory = DEFAULT_AGENTS.get(agentType);
  if (!factory) throw new Error(`Unknown agent type: ${agentType}`);
  return factory(opts);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Run the product kickoff pipeline.
 *
 * @param {string} intent - Product description / intent
 * @param {object} opts
 * @param {string}   [opts.cwd]              - Working directory (default: process.cwd())
 * @param {string}   [opts.projectName]      - Project name override
 * @param {boolean}  [opts.skipResearch]     - Skip the research step
 * @param {Function} [opts.connectorFactory] - Override agent connector creation (for testing)
 * @param {object}   [opts.gateOpts]         - Options for gate prompt (input/output streams)
 */
export async function runNew(intent, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const getConnector = opts.connectorFactory ?? defaultConnectorFactory;
  const projectName = opts.projectName ?? basename(cwd);
  const skipResearch = opts.skipResearch ?? false;

  // Resolve project paths
  const composeDir = join(cwd, '.compose');
  const dataDir = join(composeDir, 'data');

  // Ensure compose is initialized
  const configPath = join(composeDir, 'compose.json');
  if (!existsSync(configPath)) {
    throw new Error(`No .compose/compose.json found at ${cwd}. Run 'compose init' first.`);
  }

  // Ensure discovery dir exists for brainstorm output
  mkdirSync(join(cwd, 'docs', 'discovery'), { recursive: true });

  // Load kickoff spec
  const specPath = join(cwd, 'pipelines', 'new.stratum.yaml');
  if (!existsSync(specPath)) {
    throw new Error(`Kickoff spec not found: ${specPath}. Run 'compose init' to get default pipelines.`);
  }

  // If skipResearch, temporarily add skip_if to research step
  if (skipResearch) {
    const { parse, stringify } = await import('yaml');
    const spec = parse(readFileSync(specPath, 'utf-8'));
    const researchStep = spec.flows?.new?.steps?.find(s => s.id === 'research');
    if (researchStep && !researchStep.skip_if) {
      researchStep.skip_if = 'true';
      researchStep.skip_reason = 'Skipped by user (questionnaire)';
      writeFileSync(specPath, stringify(spec, { lineWidth: 120 }));
      console.log('Skipping research step (per questionnaire).\n');
    }
  }

  const specYaml = readFileSync(specPath, 'utf-8');

  // Parse spec to extract validate configs per step
  const { parse: parseYaml, stringify: stringifyYaml } = await import('yaml');
  const specObj = parseYaml(specYaml);
  const validateConfigs = new Map();
  for (const step of specObj.flows?.new?.steps ?? []) {
    if (step.validate) {
      validateConfigs.set(step.id, step.validate);
      delete step.validate;  // strip before sending to stratum
    }
  }
  // Re-serialize with validate fields stripped
  const cleanSpecYaml = stringifyYaml(specObj, { lineWidth: 120 });

  // Vision writer
  const visionWriter = new VisionWriter(dataDir);
  const itemId = await visionWriter.ensureFeatureItem(projectName, projectName);

  // Stratum MCP client
  const stratum = new StratumMcpClient();
  await stratum.connect({ cwd });

  try {
    console.log(`Starting product kickoff for "${projectName}"...`);
    console.log(`Intent: ${intent}\n`);

    let response = await stratum.plan(cleanSpecYaml, 'new', { projectName, intent });

    await visionWriter.updateItemStatus(itemId, 'in_progress');

    const context = { cwd, featureCode: projectName, projectName, intent };

    // Dispatch loop — same pattern as build.js
    while (response.status !== 'complete' && response.status !== 'killed') {
      const stepId = response.step_id;
      const flowId = response.flow_id;
      const stepNum = response.step_number ?? '?';
      const totalSteps = response.total_steps ?? '?';

      if (response.status === 'execute_step') {
        console.log(`[${stepNum}/${totalSteps}] ${stepId}...`);

        await visionWriter.updateItemPhase(itemId, stepId);

        const agentType = response.agent ?? 'claude';
        const prompt = buildStepPrompt(response, context);
        const connector = getConnector(agentType, { cwd });
        const { result } = await runAndNormalize(connector, prompt, response);

        // Agent-as-validator: if step has validate config, check the artifact
        const valConfig = validateConfigs.get(stepId);
        if (valConfig) {
          console.log(`  ✓ Validating ${stepId}...`);
          const valConnector = getConnector('claude', { cwd });
          const { valid, issues } = await validateStep({
            artifact: valConfig.artifact,
            criteria: valConfig.criteria,
            stepId,
            connector: valConnector,
          });
          if (!valid) {
            console.log(`  ✗ Validation failed:`);
            for (const issue of issues) console.log(`    - ${issue}`);
            console.log(`  ↻ Fix (claude) for ${stepId}`);
            const fixPrompt =
              `Read "${valConfig.artifact}" and fix these issues:\n` +
              issues.map(i => `- ${i}`).join('\n') + '\n\n' +
              `Update the file in place. Do not skip any issue.\n\n` +
              `## Context\nWorking directory: ${cwd}\nProject: ${projectName}`;
            const fixConnector = getConnector('claude', { cwd });
            await runAndNormalize(fixConnector, fixPrompt, response);
          }
        }

        // Print step summary
        const valConfig2 = validateConfigs.get(stepId);
        const artifactPath = valConfig2?.artifact;
        if (result?.summary) {
          console.log(`  ✓ ${result.summary}`);
        } else if (artifactPath && existsSync(join(cwd, artifactPath))) {
          // Summarize from artifact — first few lines
          const content = readFileSync(join(cwd, artifactPath), 'utf-8');
          const heading = content.split('\n').find(l => l.startsWith('# '));
          const lineCount = content.split('\n').length;
          console.log(`  ✓ Wrote ${artifactPath} (${lineCount} lines)${heading ? ' — ' + heading.replace(/^#+\s*/, '') : ''}`);
        } else {
          console.log(`  ✓ ${stepId} complete`);
        }

        response = await stratum.stepDone(flowId, stepId, result ?? { summary: 'Step complete' });

      } else if (response.status === 'await_gate') {
        console.log(`\nGate: ${stepId}`);

        // Show the artifact that's being gated so user can make an informed decision
        // Try multiple sources for the prior step: gate's on_revise, depends_on, or spec lookup
        const priorStepId = response.on_revise ?? response.depends_on?.[0]
          ?? specObj.flows?.new?.steps?.find(s => s.id === stepId)?.on_revise;
        const priorValConfig = priorStepId ? validateConfigs.get(priorStepId) : null;
        if (priorValConfig?.artifact) {
          const artPath = join(cwd, priorValConfig.artifact);
          if (existsSync(artPath)) {
            const content = readFileSync(artPath, 'utf-8');
            console.log(`\n--- ${priorValConfig.artifact} ---`);
            // Show full content (it's a discovery doc, should be readable)
            const lines = content.split('\n');
            if (lines.length <= 80) {
              console.log(content);
            } else {
              console.log(lines.slice(0, 60).join('\n'));
              console.log(`\n... (${lines.length - 60} more lines — see ${priorValConfig.artifact})`);
            }
            console.log(`--- end ---\n`);
          }
        }

        const gateId = await visionWriter.createGate(flowId, stepId, itemId);

        // Resolve artifact path for this gate
        const gateArtifact = priorValConfig?.artifact
          ? join(cwd, priorValConfig.artifact)
          : null;

        // Agent Q&A callback for interactive gate
        const askAgent = async (question, artifactPath) => {
          const connector = getConnector('claude', { cwd });
          const fileRef = artifactPath
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
          artifact: gateArtifact ?? cwd,
          askAgent,
        });
        await visionWriter.resolveGate(gateId, outcome);
        response = await stratum.gateResolve(flowId, stepId, outcome, rationale, 'human');

      } else if (response.status === 'execute_flow') {
        const parentFlowId = response.parent_flow_id;
        const parentStepId = response.parent_step_id;
        const childFlowName = response.child_flow_name ?? 'sub-flow';
        console.log(`[sub-flow] ${childFlowName}...`);

        const childResult = await executeChildFlow(
          response, stratum, getConnector, context,
          visionWriter, itemId, opts.gateOpts ?? {}
        );

        response = await stratum.stepDone(parentFlowId, parentStepId, childResult);

      } else if (response.status === 'ensure_failed' || response.status === 'schema_failed') {
        console.log(`  ↻ Retrying ${stepId} (postconditions failed)`);
        const violations = response.violations ?? [];
        const agentType = response.agent ?? 'claude';

        // Fix pass before retry
        const fixAgent = agentType === 'codex' ? 'claude' : agentType;
        console.log(`  ↻ Fix (${fixAgent}) for ${stepId}`);
        const fixPrompt =
          `Fix step "${stepId}" — postconditions failed:\n` +
          violations.map(v => `- ${v}`).join('\n') + '\n\n' +
          `Fix every issue. Do not skip any.\n\n` +
          `## Context\nWorking directory: ${cwd}\nProject: ${projectName}`;
        const fixConnector = getConnector(fixAgent, { cwd });
        await runAndNormalize(fixConnector, fixPrompt, response);

        console.log(`  ↻ Retrying ${stepId} (${agentType})`);
        const prompt = buildRetryPrompt(response, violations, context);
        const connector = getConnector(agentType, { cwd });
        const { result } = await runAndNormalize(connector, prompt, response);

        response = await stratum.stepDone(
          response.flow_id, response.step_id,
          result ?? { summary: 'Retry complete' }
        );

      } else {
        console.warn(`Unknown dispatch status: ${response.status}`);
        break;
      }
    }

    // Flow complete
    if (response.status === 'complete') {
      console.log('\nProduct kickoff complete.');
      await visionWriter.updateItemStatus(itemId, 'complete');
    } else if (response.status === 'killed') {
      console.log('\nProduct kickoff killed.');
      await visionWriter.updateItemStatus(itemId, 'killed');
    }

    // Write audit trace
    if (response.trace) {
      try {
        const auditPath = join(cwd, 'docs', 'discovery', 'kickoff-audit.json');
        writeFileSync(auditPath, JSON.stringify(response, null, 2));
        console.log(`Audit trace written to docs/discovery/kickoff-audit.json`);
      } catch (err) {
        console.warn(`Warning: could not write audit trace: ${err.message}`);
      }
    }

    // Summary
    if (response.status === 'complete') {
      console.log('\nNext steps:');
      console.log('  compose pipeline show          # review the build pipeline');
      console.log('  compose build <FEATURE-CODE>   # build the first feature');
    }

  } finally {
    await stratum.close();
  }
}

// ---------------------------------------------------------------------------
// Child flow execution (simplified from build.js — no active-build tracking)
// ---------------------------------------------------------------------------

async function executeChildFlow(
  flowDispatch, stratum, getConnector, context,
  visionWriter, itemId, gateOpts
) {
  let resp = flowDispatch.child_step;
  const childFlowId = flowDispatch.child_flow_id;
  const childFlowName = flowDispatch.child_flow_name ?? 'sub-flow';

  while (resp.status !== 'complete' && resp.status !== 'killed') {
    if (resp.status === 'execute_step') {
      console.log(`  [${childFlowName}] ${resp.step_id}...`);
      await visionWriter.updateItemPhase(itemId, `${childFlowName}:${resp.step_id}`);

      const agentType = resp.agent ?? 'claude';
      const prompt = buildStepPrompt(resp, context);
      const connector = getConnector(agentType, { cwd: context.cwd });
      const { result } = await runAndNormalize(connector, prompt, resp);

      resp = await stratum.stepDone(
        childFlowId, resp.step_id,
        result ?? { summary: 'Step complete' }
      );

    } else if (resp.status === 'await_gate') {
      console.log(`  [${childFlowName}] Gate: ${resp.step_id}`);
      const gateId = await visionWriter.createGate(childFlowId, resp.step_id, itemId);
      const { outcome, rationale } = await promptGate(resp, gateOpts);
      await visionWriter.resolveGate(gateId, outcome);
      resp = await stratum.gateResolve(childFlowId, resp.step_id, outcome, rationale, 'human');

    } else if (resp.status === 'ensure_failed' || resp.status === 'schema_failed') {
      const violations = resp.violations ?? [];
      const stepAgent = resp.agent ?? 'claude';
      const fixAgent = stepAgent === 'codex' ? 'claude' : stepAgent;

      console.log(`  [${childFlowName}] ↻ Fix (${fixAgent}) for ${resp.step_id}`);
      const fixPrompt =
        `Fix step "${resp.step_id}" — postconditions failed:\n` +
        violations.map(v => `- ${v}`).join('\n') + '\n\n' +
        `Fix every issue.\n\n` +
        `## Context\nWorking directory: ${context.cwd}\nProject: ${context.projectName}`;
      const fixConnector = getConnector(fixAgent, { cwd: context.cwd });
      await runAndNormalize(fixConnector, fixPrompt, resp);

      console.log(`  [${childFlowName}] ↻ Retrying ${resp.step_id} (${stepAgent})`);
      const prompt = buildRetryPrompt(resp, violations, context);
      const connector = getConnector(stepAgent, { cwd: context.cwd });
      const { result } = await runAndNormalize(connector, prompt, resp);

      resp = await stratum.stepDone(
        resp.flow_id ?? childFlowId, resp.step_id,
        result ?? { summary: 'Retry complete' }
      );

    } else if (resp.status === 'execute_flow') {
      const nestedParentFlowId = resp.parent_flow_id;
      const nestedParentStepId = resp.parent_step_id;
      const nestedResult = await executeChildFlow(
        resp, stratum, getConnector, context,
        visionWriter, itemId, gateOpts
      );
      resp = await stratum.stepDone(nestedParentFlowId, nestedParentStepId, nestedResult);

    } else {
      console.warn(`  [${childFlowName}] Unknown status: ${resp.status}`);
      break;
    }
  }

  return resp;
}
