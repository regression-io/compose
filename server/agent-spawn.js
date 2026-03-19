/**
 * agent-spawn.js — Hidden Claude subagent spawn/poll routes.
 *
 * Routes: POST /api/agent/spawn, GET /api/agent/:id, GET /api/agents
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

import { getTargetRoot } from './project-root.js';

const PROJECT_ROOT = getTargetRoot();

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Attach agent spawn/poll routes to an Express app.
 * Each call creates an isolated agent registry — safe for multiple instances.
 *
 * @param {object} app — Express app
 * @param {{ projectRoot: string, broadcastMessage: function, requireSensitiveToken: function }} deps
 */
function deriveAgentType(prompt) {
  const lower = (prompt ?? '').toLowerCase();
  if (lower.includes('explore') || lower.includes('find features') || lower.includes('map the architecture'))
    return 'compose-explorer';
  if (lower.includes('architect') || lower.includes('competing') || lower.includes('proposal'))
    return 'compose-architect';
  if (lower.includes('review') || lower.includes('codex'))
    return 'codex';
  return 'claude';
}

export function attachAgentSpawnRoutes(app, { projectRoot = PROJECT_ROOT, broadcastMessage, requireSensitiveToken, registry, sessionManager }) {
  const _agents = new Map();
  // POST /api/agent/spawn — spawn a hidden Claude subagent
  app.post('/api/agent/spawn', requireSensitiveToken, (req, res) => {
    const { prompt, id } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    const agentId = id || `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    if (_agents.has(agentId)) {
      return res.status(409).json({ error: `Agent ${agentId} already running` });
    }

    const cleanEnv = { ...process.env, NO_COLOR: '1' };
    delete cleanEnv.CLAUDECODE;

    const proc = spawn('claude', [
      '-p', prompt,
      '--dangerously-skip-permissions',
    ], {
      cwd: projectRoot,
      env: cleanEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const agent = {
      process: proc,
      output: '',
      stderr: '',
      status: 'running',
      prompt,
      startedAt: new Date().toISOString(),
    };
    _agents.set(agentId, agent);

    // Register with persistent registry + broadcast spawn event
    const agentType = deriveAgentType(prompt);
    const parentSessionId = sessionManager?.currentSession?.id ?? null;
    if (registry) {
      registry.register(agentId, { parentSessionId, agentType, prompt, pid: proc.pid });
    }
    broadcastMessage({
      type: 'agentSpawned',
      agentId,
      parentSessionId,
      agentType,
      prompt: prompt.slice(0, 200),
      startedAt: agent.startedAt,
    });

    proc.stdout.on('data', (chunk) => {
      agent.output += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      agent.stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      agent.status = code === 0 ? 'complete' : 'failed';
      agent.exitCode = code;
      if (registry) {
        registry.complete(agentId, { status: agent.status, exitCode: code });
      }
      broadcastMessage({
        type: 'agentComplete',
        agentId,
        agentType,
        status: agent.status,
        output: agent.output,
      });
    });

    proc.on('error', (err) => {
      agent.status = 'failed';
      agent.stderr += err.message;
      console.error(`[vision] Agent ${agentId} spawn error:`, err.message);
    });

    console.log(`[vision] Agent ${agentId} spawned (PID ${proc.pid})`);
    res.status(201).json({ agentId, pid: proc.pid, status: 'running' });
  });

  // GET /api/agent/:id — poll agent status + output
  app.get('/api/agent/:id', (req, res) => {
    const agent = _agents.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json({
      agentId: req.params.id,
      status: agent.status,
      output: agent.output,
      stderr: agent.stderr,
      exitCode: agent.exitCode,
      startedAt: agent.startedAt,
    });
  });

  // GET /api/agents — list all agents
  app.get('/api/agents', (_req, res) => {
    const agents = [];
    for (const [id, agent] of _agents) {
      agents.push({
        agentId: id,
        status: agent.status,
        startedAt: agent.startedAt,
        outputLength: agent.output.length,
      });
    }
    res.json({ agents });
  });

  // GET /api/agents/tree — agent hierarchy for current session
  app.get('/api/agents/tree', (_req, res) => {
    if (!registry) return res.json({ agents: [] });
    const parentId = sessionManager?.currentSession?.id ?? null;
    const agents = parentId ? registry.getChildren(parentId) : registry.getAll();
    res.json({ sessionId: parentId, agents });
  });
}
