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

/**
 * Build a live draft design document from conversation messages and decisions.
 * Pure function — no side effects.
 *
 * @param {Array<{role: string, type: string, content: any}>} messages
 * @param {Array<{question: string, selectedOption: object, comment: string|null, superseded: boolean}>} decisions
 * @returns {string} Markdown document, or empty string if no active decisions yet.
 */
export function buildDraftDoc(messages, decisions) {
  const activeDecisions = (decisions || []).filter(d => !d.superseded);
  if (activeDecisions.length === 0) return '';

  let doc = '# Design Document\n\n';

  // Extract problem statement from first 2-3 human text messages
  const humanTextMessages = (messages || [])
    .filter(m => m.role === 'human' && m.type === 'text')
    .slice(0, 3);

  if (humanTextMessages.length > 0) {
    doc += '## Problem\n\n';
    doc += humanTextMessages.map(m => m.content).join('\n\n');
    doc += '\n\n';
  }

  // One section per active decision
  for (const decision of activeDecisions) {
    const opt = decision.selectedOption || {};
    doc += `## ${decision.question}\n\n`;
    doc += `**Decision:** ${opt.title || opt.id || 'Selected option'}\n\n`;

    if (Array.isArray(opt.bullets) && opt.bullets.length > 0) {
      doc += opt.bullets.map(b => `- ${b}`).join('\n');
      doc += '\n\n';
    }

    if (decision.comment) {
      doc += `*Note: ${decision.comment}*\n\n`;
    }
  }

  // Open Threads: find unanswered questions from messages after the last decision
  const lastDecisionTime = activeDecisions[activeDecisions.length - 1]?.timestamp;
  const recentAssistantMessages = lastDecisionTime
    ? (messages || []).filter(
        m => m.role === 'assistant' && m.timestamp > lastDecisionTime
      )
    : [];

  // Heuristic: lines ending with "?" in recent assistant messages are open threads
  const openThreads = [];
  for (const msg of recentAssistantMessages) {
    if (typeof msg.content !== 'string') continue;
    const lines = msg.content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.endsWith('?') && trimmed.length > 10 && trimmed.length < 200) {
        openThreads.push(trimmed);
      }
    }
  }

  doc += '## Open Threads\n\n';
  if (openThreads.length > 0) {
    doc += openThreads.map(t => `- ${t}`).join('\n');
    doc += '\n';
  } else {
    doc += '_No open threads._\n';
  }

  return doc;
}

/**
 * Build a topic outline from decisions (and optionally messages).
 * Pure function — no side effects.
 *
 * @param {Array<{role: string, type: string, content: any}>} messages
 * @param {Array<{question: string, selectedOption: object, superseded: boolean}>} decisions
 * @returns {Array<{title: string, type: 'decision', decided: boolean}>}
 */
export function buildTopicOutline(messages, decisions) {
  const activeDecisions = (decisions || []).filter(d => !d.superseded);
  return activeDecisions.map(d => ({
    title: d.question,
    type: 'decision',
    decided: true,
  }));
}
