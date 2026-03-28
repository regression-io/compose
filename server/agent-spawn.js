/**
 * agent-spawn.js — Hidden Claude subagent spawn/poll routes.
 *
 * Routes: POST /api/agent/spawn, GET /api/agent/:id, GET /api/agents
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

import { getTargetRoot } from './project-root.js';
import { gracefulKill } from './agent-health.js';

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

export function attachAgentSpawnRoutes(app, { projectRoot = PROJECT_ROOT, broadcastMessage, requireSensitiveToken, registry, sessionManager, healthMonitor, worktreeGC }) {
  const _agents = new Map();
  // POST /api/agent/spawn — spawn a hidden Claude subagent
  app.post('/api/agent/spawn', requireSensitiveToken, (req, res) => {
    const { prompt, id } = req.body || {};
    if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt is required and must be a string' });

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
    broadcastMessage({
      type: 'agentRelay',
      fromAgentId: parentSessionId || 'session',
      toAgentId: agentId,
      direction: 'dispatch',
      messagePreview: (prompt || '').slice(0, 80),
      timestamp: new Date().toISOString(),
    });

    proc.stdout.on('data', (chunk) => {
      agent.output += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      agent.stderr += chunk.toString();
    });

    // COMP-AGT-1: Wire health monitor after stdout/stderr listeners
    if (healthMonitor) healthMonitor.track(agentId, proc);

    proc.on('close', (code) => {
      // COMP-AGT-1: Untrack from health monitor, preserve terminal reason
      if (healthMonitor) {
        const terminalReason = healthMonitor.getTerminalReason(agentId);
        healthMonitor.untrack(agentId);
        if (terminalReason) {
          agent.status = 'killed';
          agent.terminalReason = terminalReason;
          agent.exitCode = code;
          if (registry) {
            registry.updateStatus(agentId, 'killed', terminalReason);
          }
          broadcastMessage({
            type: 'agentComplete',
            agentId,
            agentType,
            status: 'killed',
            terminalReason,
            output: agent.output,
          });
          broadcastMessage({
            type: 'agentRelay',
            fromAgentId: agentId,
            toAgentId: parentSessionId || 'session',
            direction: 'result',
            messagePreview: `Killed: ${terminalReason}`,
            timestamp: new Date().toISOString(),
          });
          return; // skip normal close handling
        }
      }
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
      broadcastMessage({
        type: 'agentRelay',
        fromAgentId: agentId,
        toAgentId: parentSessionId || 'session',
        direction: 'result',
        messagePreview: (agent.output || '').slice(0, 80),
        timestamp: new Date().toISOString(),
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

  // POST /api/agent/:id/stop — COMP-AGT-1: graceful stop (SIGTERM → 5s → SIGKILL)
  app.post('/api/agent/:id/stop', requireSensitiveToken, (req, res) => {
    const agentId = req.params.id;
    const agent = _agents.get(agentId);

    // For SDK sessions, proxy to agent-server's interrupt endpoint
    const currentSessionId = sessionManager?.currentSession?.id ?? null;
    if (agentId === currentSessionId) {
      const agentPort = process.env.AGENT_PORT || 4002;
      const headers = { 'Content-Type': 'application/json' };
      if (process.env.COMPOSE_API_TOKEN) headers['x-compose-token'] = process.env.COMPOSE_API_TOKEN;
      fetch(`http://127.0.0.1:${agentPort}/api/agent/interrupt`, {
        method: 'POST',
        headers,
      }).then(r => {
          if (!r.ok) {
            return res.status(r.status).json({ ok: false, error: `Interrupt proxy failed: ${r.status}` });
          }
          return r.json().then(data => res.json({ ok: true, proxied: true, ...data }));
        })
        .catch(err => res.status(502).json({ error: `Interrupt proxy failed: ${err.message}` }));
      return;
    }

    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (agent.status !== 'running') return res.json({ ok: true, status: agent.status, note: 'already stopped' });

    // Set terminal reason before killing
    if (healthMonitor) healthMonitor.setTerminalReason(agentId, 'manual_stop');

    gracefulKill(agent.process);

    res.json({ ok: true, agentId, action: 'SIGTERM sent, SIGKILL in 5s if needed' });
  });

  // POST /api/agent/gc — COMP-AGT-1: trigger worktree garbage collection
  app.post('/api/agent/gc', requireSensitiveToken, async (_req, res) => {
    if (!worktreeGC) return res.status(503).json({ error: 'WorktreeGC not available' });
    try {
      const removed = await worktreeGC.runNow();
      broadcastMessage({ type: 'agentGC', removed, timestamp: new Date().toISOString() });
      res.json({ ok: true, removed });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
