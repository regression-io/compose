/**
 * design-session.js — Manages design conversation sessions for product and feature scopes.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const FILENAME = 'design-sessions.json';

export class DesignSessionManager {
  constructor(dataDir) {
    this._dataDir = dataDir;
    this._saveTimer = null;
    this._sessions = { product: null, features: Object.create(null) };

    try {
      const raw = readFileSync(join(dataDir, FILENAME), 'utf-8');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this._sessions = parsed;
          // Ensure features map uses null prototype to prevent prototype pollution
          if (parsed.features) {
            this._sessions.features = Object.create(null);
            for (const [k, v] of Object.entries(parsed.features)) {
              this._sessions.features[k] = v;
            }
          }
        }
      }
    } catch {
      // No file or corrupt — start fresh
    }
  }

  _validateFeatureCode(code) {
    if (!code || typeof code !== 'string') throw new Error('featureCode is required');
    if (/^(__proto__|constructor|prototype|toString|valueOf|hasOwnProperty)$/.test(code)) {
      throw new Error(`Invalid featureCode: "${code}"`);
    }
    // Also validate format — should be alphanumeric with hyphens
    if (!/^[A-Za-z0-9][\w-]*$/.test(code)) {
      throw new Error(`Invalid featureCode format: "${code}"`);
    }
  }

  getSession(scope, featureCode = null) {
    if (scope === 'product') {
      return this._sessions.product || null;
    }
    this._validateFeatureCode(featureCode);
    return this._sessions.features[featureCode] || null;
  }

  startSession(scope, featureCode = null) {
    const existing = this.getSession(scope, featureCode);
    if (existing && existing.status === 'active') {
      throw new Error(`Session already active for ${scope}${featureCode ? `:${featureCode}` : ''}`);
    }

    const session = {
      id: randomUUID(),
      scope,
      featureCode: featureCode || null,
      messages: [],
      decisions: [],
      status: 'active',
      createdAt: new Date().toISOString(),
    };

    if (scope === 'product') {
      this._sessions.product = session;
    } else {
      this._sessions.features[featureCode] = session;
    }

    this._saveNow();
    return session;
  }

  appendMessage(scope, featureCode, message) {
    const session = this._getSessionOrThrow(scope, featureCode);
    session.messages.push({
      ...message,
      timestamp: message.timestamp || new Date().toISOString(),
    });
    this._scheduleSave();
    return session;
  }

  recordDecision(scope, featureCode, question, card, comment = null) {
    const session = this._getSessionOrThrow(scope, featureCode);
    session.decisions.push({
      question,
      selectedOption: card,
      comment,
      timestamp: new Date().toISOString(),
      superseded: false,
    });
    this._scheduleSave();
    return session;
  }

  reviseDecision(scope, featureCode, decisionIndex) {
    const session = this._getSessionOrThrow(scope, featureCode);
    if (decisionIndex >= session.decisions.length) {
      throw new Error(`decisionIndex ${decisionIndex} out of range (${session.decisions.length} decisions)`);
    }
    session.decisions[decisionIndex].superseded = true;
    this._scheduleSave();
    return session;
  }

  completeSession(scope, featureCode = null) {
    const session = this._getSessionOrThrow(scope, featureCode);
    session.status = 'complete';
    this._saveNow();
    return session;
  }

  _getSessionOrThrow(scope, featureCode) {
    const session = this.getSession(scope, featureCode);
    if (!session) {
      throw new Error(`No session found for ${scope}${featureCode ? `:${featureCode}` : ''}`);
    }
    return session;
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveNow();
    }, 500);
  }

  _saveNow() {
    try {
      mkdirSync(this._dataDir, { recursive: true });
      const data = {
        product: this._sessions.product,
        features: { ...this._sessions.features },
      };
      writeFileSync(
        join(this._dataDir, FILENAME),
        JSON.stringify(data, null, 2),
        'utf-8',
      );
    } catch {
      // Best-effort persistence
    }
  }

  destroy() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this._saveNow();
    }
  }
}
