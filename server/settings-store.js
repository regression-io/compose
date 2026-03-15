/**
 * Settings Store — JSON-file-backed storage for user preferences.
 * Loads from disk on startup, saves after every mutation.
 * Returns merged view: contract defaults + user overrides.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDataDir as getDefaultDataDir } from './project-root.js';

const VALID_VIEWS = ['attention', 'gates', 'roadmap', 'list', 'board', 'tree', 'graph', 'docs', 'settings'];
const VALID_THEMES = ['light', 'dark', 'system'];

export class SettingsStore {
  constructor(dataDir, contract) {
    const dir = dataDir || getDefaultDataDir();
    this._file = path.join(dir, 'settings.json');
    this._contract = contract;
    this._userSettings = {};
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this._file, 'utf-8');
      this._userSettings = JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[settings] Failed to load settings, using defaults:', err.message);
      }
      this._userSettings = {};
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this._file), { recursive: true });
      fs.writeFileSync(this._file, JSON.stringify(this._userSettings, null, 2), 'utf-8');
    } catch (err) {
      console.error('[settings] Failed to save settings:', err.message);
    }
  }

  _defaults() {
    return {
      policies: Object.fromEntries(
        this._contract.phases.map(p => [p.id, p.defaultPolicy])
      ),
      iterations: { ...this._contract.iterationDefaults },
      models: {
        interactive: 'claude-sonnet-4-6',
        agentRun: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
        summarizer: process.env.SUMMARIZER_MODEL || 'haiku',
      },
      ui: { theme: 'system', defaultView: 'attention' },
    };
  }

  /** Returns merged defaults + user overrides. */
  get() {
    const defaults = this._defaults();
    const user = this._userSettings;
    return {
      policies: { ...defaults.policies, ...user.policies },
      iterations: {
        review: { ...defaults.iterations.review, ...user.iterations?.review },
        coverage: { ...defaults.iterations.coverage, ...user.iterations?.coverage },
      },
      models: { ...defaults.models, ...user.models },
      ui: { ...defaults.ui, ...user.ui },
    };
  }

  /** Validate and apply a partial settings update. */
  update(patch) {
    this._validate(patch);
    // Deep merge into user settings
    for (const section of ['policies', 'iterations', 'models', 'ui']) {
      if (patch[section]) {
        if (!this._userSettings[section]) this._userSettings[section] = {};
        if (section === 'iterations') {
          for (const [key, val] of Object.entries(patch.iterations)) {
            this._userSettings.iterations[key] = { ...this._userSettings.iterations[key], ...val };
          }
        } else {
          Object.assign(this._userSettings[section], patch[section]);
        }
      }
    }
    this._save();
    return this.get();
  }

  /** Reset user overrides. If section given, reset only that section. */
  reset(section) {
    if (section) {
      delete this._userSettings[section];
    } else {
      this._userSettings = {};
    }
    this._save();
    return this.get();
  }

  _validate(patch) {
    const validModes = new Set(this._contract.policyModes);

    // Reject unknown top-level keys
    for (const key of Object.keys(patch)) {
      if (!['policies', 'iterations', 'models', 'ui'].includes(key)) {
        throw new Error(`Unknown settings section: ${key}`);
      }
    }

    if (patch.policies) {
      for (const [phase, mode] of Object.entries(patch.policies)) {
        if (mode !== null && !validModes.has(mode)) {
          throw new Error(`Invalid policy mode for ${phase}: ${mode}`);
        }
      }
    }

    if (patch.iterations) {
      for (const [type, config] of Object.entries(patch.iterations)) {
        if (config.maxIterations !== undefined) {
          const n = config.maxIterations;
          if (!Number.isInteger(n) || n < 1 || n > 100) {
            throw new Error(`Invalid maxIterations for ${type}: must be integer 1-100`);
          }
        }
      }
    }

    if (patch.models) {
      for (const [key, val] of Object.entries(patch.models)) {
        if (typeof val !== 'string' || val.length === 0) {
          throw new Error(`Invalid model for ${key}: must be non-empty string`);
        }
      }
    }

    if (patch.ui) {
      if (patch.ui.theme !== undefined && !VALID_THEMES.includes(patch.ui.theme)) {
        throw new Error(`Invalid theme: ${patch.ui.theme} (must be ${VALID_THEMES.join(', ')})`);
      }
      if (patch.ui.defaultView !== undefined && !VALID_VIEWS.includes(patch.ui.defaultView)) {
        throw new Error(`Invalid defaultView: ${patch.ui.defaultView} (must be ${VALID_VIEWS.join(', ')})`);
      }
    }
  }
}
