/**
 * designSessionState.js — Pure logic for design session state management.
 * No React, no Node-specific APIs. Fully testable.
 */

/**
 * Create a new design session.
 * @param {'product'|'feature'} scope
 * @param {string|null} featureCode
 */
export function createSession(scope, featureCode = null) {
  return {
    id: crypto.randomUUID(),
    scope,
    featureCode,
    messages: [],
    decisions: [],
    status: 'active',
    createdAt: new Date().toISOString(),
  };
}

/**
 * Append a message to a session (immutable).
 * @param {object} session
 * @param {{ role: string, type: string, content: any, timestamp: string }} message
 */
export function appendMessage(session, message) {
  return { ...session, messages: [...session.messages, message] };
}

/**
 * Record a decision on a session (immutable).
 * @param {object} session
 * @param {string} question
 * @param {object} card - the selected option card
 * @param {string|null} comment
 */
export function recordDecision(session, question, card, comment = null) {
  const decision = {
    question,
    selectedOption: card,
    comment,
    timestamp: new Date().toISOString(),
    superseded: false,
  };
  return { ...session, decisions: [...session.decisions, decision] };
}

/**
 * Mark a decision as superseded (immutable).
 * @param {object} session
 * @param {number} decisionIndex
 */
export function reviseDecision(session, decisionIndex) {
  const decisions = session.decisions.map((d, i) =>
    i === decisionIndex ? { ...d, superseded: true } : d
  );
  return { ...session, decisions };
}

/**
 * Parse markdown text containing ```decision fenced blocks.
 * Returns { parts: Array<{ type: 'text'|'decision', content: string|object }> }.
 */
export function parseDecisionBlocks(text) {
  const parts = [];
  const regex = /```decision\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Text before this block
    if (match.index > lastIndex) {
      parts.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }

    const raw = match[1].trim();
    try {
      parts.push({ type: 'decision', content: JSON.parse(raw) });
    } catch {
      parts.push({ type: 'text', content: raw });
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last block
  if (lastIndex < text.length) {
    parts.push({ type: 'text', content: text.slice(lastIndex) });
  }

  // If no blocks found at all, return the whole text
  if (parts.length === 0) {
    parts.push({ type: 'text', content: text });
  }

  return { parts };
}

/**
 * Check if a session is complete.
 * @param {object} session
 */
export function isSessionComplete(session) {
  return session.status === 'complete';
}
