/**
 * AgentRegistry — persistent tracker for spawned subagents.
 *
 * Tracks parent-child relationships between the main Claude Code session
 * and spawned agents (compose-explorer, compose-architect, etc.).
 * JSON file-backed, same pattern as SettingsStore.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export class AgentRegistry {
  #agents;
  #file;

  constructor(dataDir) {
    this.#file = join(dataDir, 'agents.json');
    this.#agents = new Map();
    this._load();
  }

  register(agentId, { parentSessionId, agentType, prompt, pid }) {
    const record = {
      agentId,
      parentSessionId: parentSessionId ?? null,
      agentType: agentType ?? 'unknown',
      prompt: (prompt ?? '').slice(0, 200),
      status: 'running',
      pid: pid ?? null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      exitCode: null,
    };
    this.#agents.set(agentId, record);
    this._save();
    return record;
  }

  complete(agentId, { status, exitCode }) {
    const record = this.#agents.get(agentId);
    if (!record) return null;
    record.status = status;
    record.exitCode = exitCode ?? null;
    record.completedAt = new Date().toISOString();
    this._save();
    return record;
  }

  getChildren(parentSessionId) {
    return [...this.#agents.values()].filter(a => a.parentSessionId === parentSessionId);
  }

  getAll() { return [...this.#agents.values()]; }
  get(agentId) { return this.#agents.get(agentId) ?? null; }

  prune(keep = 50) {
    const all = [...this.#agents.values()]
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    const pruned = all.slice(keep);
    for (const r of pruned) this.#agents.delete(r.agentId);
    if (pruned.length > 0) this._save();
  }

  _load() {
    try {
      const data = JSON.parse(readFileSync(this.#file, 'utf-8'));
      for (const r of data) this.#agents.set(r.agentId, r);
    } catch { /* fresh start */ }
  }

  _save() {
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      writeFileSync(this.#file, JSON.stringify([...this.#agents.values()], null, 2));
    } catch (err) {
      console.error('[agent-registry] Save failed:', err.message);
    }
  }
}
