/**
 * agent-spawn.js — Hidden Claude subagent spawn/poll routes.
 *
 * Routes: POST /api/agent/spawn, GET /api/agent/:id, GET /api/agents
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

/** Tracks running agents: Map<id, { process, output, stderr, status, prompt, startedAt, exitCode }> */
const _agents = new Map();

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Attach agent spawn/poll routes to an Express app.
 *
 * @param {object} app — Express app
 * @param {{ projectRoot: string, broadcastMessage: function, requireSensitiveToken: function }} deps
 */
export function attachAgentSpawnRoutes(app, { projectRoot = PROJECT_ROOT, broadcastMessage, requireSensitiveToken }) {
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

    proc.stdout.on('data', (chunk) => {
      agent.output += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      agent.stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      agent.status = code === 0 ? 'complete' : 'failed';
      agent.exitCode = code;
      broadcastMessage({
        type: 'agentComplete',
        agentId,
        status: agent.status,
        output: agent.output,
      });
      // Clean up after 5 minutes
      setTimeout(() => _agents.delete(agentId), 300_000);
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
}
