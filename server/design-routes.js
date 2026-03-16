/**
 * design-routes.js — Design conversation REST + SSE routes.
 *
 * Routes:
 *   POST /api/design/start
 *   POST /api/design/message
 *   GET  /api/design/session
 *   POST /api/design/complete
 *   POST /api/design/revise
 *   GET  /api/design/stream
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseDecisionBlocks } from '../src/components/vision/designSessionState.js';

/** @type {Map<string, Set<import('node:http').ServerResponse>>} — key is `${scope}:${featureCode || ''}` */
export const designListeners = new Map();

/** In-flight guard — prevents overlapping agent runs for the same session. */
const _inFlight = new Set();

/**
 * Build a session key for SSE listener scoping.
 * @param {string} scope
 * @param {string|null|undefined} featureCode
 * @returns {string}
 */
export function sessionKey(scope, featureCode, projectRoot) {
  const project = projectRoot || '';
  return `${project}:${scope || 'product'}:${featureCode || ''}`;
}

/**
 * Broadcast an SSE event to listeners matching a session key.
 * @param {string} key — session key from sessionKey()
 * @param {string} type — event name
 * @param {object} data — JSON-serialisable payload
 */
export function broadcastDesignEvent(key, type, data) {
  const listeners = designListeners.get(key);
  if (!listeners) return;
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of listeners) {
    try {
      res.write(payload);
    } catch {
      listeners.delete(res);
    }
  }
}

/**
 * Dispatch the LLM agent after a human message. Fire-and-forget.
 *
 * Creates a fresh connector per dispatch so concurrent sessions
 * (product + feature) don't block each other.
 *
 * @param {import('./design-session.js').DesignSessionManager} sessionManager
 * @param {string} projectRoot — cwd for the new connector
 * @param {string} scope
 * @param {string|null} featureCode
 */
async function dispatchDesignAgent(sessionManager, projectRoot, scope, featureCode) {
  const key = sessionKey(scope, featureCode, projectRoot);
  if (_inFlight.has(key)) return; // already running
  _inFlight.add(key);
  // Snapshot message count so we can detect new messages arriving during the run
  let promptMessageCount = 0;
  try {
    const session = sessionManager.getSession(scope, featureCode);
    if (!session) return;

    promptMessageCount = session.messages.length;

    // Build formatted conversation history
    const formattedMessages = session.messages
      .map(m => {
        if (m.role === 'human' && m.type === 'text') {
          return `Human: ${m.content}`;
        }
        if (m.role === 'human' && m.type === 'card_select') {
          return `Human: [Selected option "${m.content?.cardId}"${m.content?.comment ? ` — ${m.content.comment}` : ''}]`;
        }
        if (m.role === 'assistant') {
          return `Assistant: ${m.content}`;
        }
        return `${m.role}: ${JSON.stringify(m.content)}`;
      })
      .join('\n\n');

    const systemPrompt = `You are a product design partner. Your job is to help the human design a product or feature through an interactive conversation.

Rules:
1. Ask ONE question at a time. Never dump multiple questions.
2. When presenting options, use a \`\`\`decision fenced block with this JSON format:
   {"question": "...", "options": [{"id": "A", "title": "...", "bullets": ["...", "..."]}, ...], "recommendation": {"id": "A", "rationale": "..."}}
3. Always include a recommendation after presenting options.
4. Track the decisions made so far (provided in context) and build on them.
5. When you have enough context (typically 5-10 decisions), offer to complete the design document.
6. Research the codebase when relevant — announce what you're looking at.

Decisions made so far:
${JSON.stringify(session.decisions, null, 2)}

Conversation history:
${formattedMessages}`;

    let fullContent = '';

    const { ClaudeSDKConnector } = await import('./connectors/claude-sdk-connector.js');
    const connector = new ClaudeSDKConnector({ cwd: projectRoot });

    for await (const event of connector.run(systemPrompt)) {
      if (event.type === 'assistant' && event.content) {
        fullContent += event.content;
        broadcastDesignEvent(key, 'text', { content: event.content });
      } else if (event.type === 'result' && event.content) {
        // Final aggregated text — use it if we haven't accumulated anything
        if (!fullContent) {
          fullContent = event.content;
          broadcastDesignEvent(key, 'text', { content: event.content });
        }
      } else if (event.type === 'error') {
        broadcastDesignEvent(key, 'error', { message: event.message });
        return;
      }
      // Ignore system init/complete and tool_use events
    }

    // Parse for decision blocks and broadcast them
    if (fullContent) {
      const { parts } = parseDecisionBlocks(fullContent);
      for (const part of parts) {
        if (part.type === 'decision') {
          broadcastDesignEvent(key, 'decision', part.content);
        }
      }

      // Append assistant message to session
      sessionManager.appendMessage(scope, featureCode, {
        role: 'assistant',
        type: 'text',
        content: fullContent,
        timestamp: new Date().toISOString(),
      });
    }

    broadcastDesignEvent(key, 'done', {});
  } catch (err) {
    broadcastDesignEvent(key, 'error', { message: err.message || String(err) });
  } finally {
    _inFlight.delete(key);
    // Check for human messages that arrived during the run (after our prompt snapshot)
    const updated = sessionManager.getSession(scope, featureCode);
    if (updated) {
      const newMessages = updated.messages.slice(promptMessageCount);
      const hasNewHumanMessage = newMessages.some(m => m.role === 'human');
      if (hasNewHumanMessage) {
        // Re-dispatch to answer the queued message(s)
        dispatchDesignAgent(sessionManager, projectRoot, scope, featureCode);
      }
    }
  }
}

/**
 * Attach design conversation routes to an Express app.
 *
 * Accepts getter functions so that deps resolve dynamically per-request,
 * surviving project switches via /api/project/switch.
 *
 * @param {object} app — Express app
 * @param {{ getSessionManager: () => import('./design-session.js').DesignSessionManager, getConnector: () => import('./connectors/claude-sdk-connector.js').ClaudeSDKConnector|null, getProjectRoot: () => string }} deps
 */
export function attachDesignRoutes(app, { getSessionManager, getConnector, getProjectRoot }) {
  // POST /api/design/start
  app.post('/api/design/start', (req, res) => {
    const { scope, featureCode } = req.body || {};
    if (!scope || !['product', 'feature'].includes(scope)) {
      return res.status(400).json({ error: 'scope must be "product" or "feature"' });
    }
    if (scope === 'feature' && !featureCode) {
      return res.status(400).json({ error: 'featureCode required for feature scope' });
    }
    try {
      const sessionManager = getSessionManager();
      const session = sessionManager.startSession(scope, featureCode);
      res.json({ session });
    } catch (err) {
      if (err.message.includes('already active')) {
        return res.status(409).json({ error: err.message });
      }
      res.status(400).json({ error: err.message });
    }
  });

  // POST /api/design/message
  app.post('/api/design/message', (req, res) => {
    const { scope, featureCode, type, content, cardId, comment } = req.body || {};
    if (!scope || !['product', 'feature'].includes(scope)) {
      return res.status(400).json({ error: 'scope must be "product" or "feature"' });
    }
    if (!type || !['text', 'card_select'].includes(type)) {
      return res.status(400).json({ error: 'type must be "text" or "card_select"' });
    }
    try {
      const sessionManager = getSessionManager();
      const projectRoot = getProjectRoot();
      const existingSession = sessionManager.getSession(scope, featureCode);
      if (!existingSession) {
        return res.status(404).json({ error: 'No session found' });
      }
      if (existingSession.status === 'complete') {
        return res.status(409).json({ error: 'Session is complete. Start a new session to continue.' });
      }
      const key = sessionKey(scope, featureCode, projectRoot);
      const timestamp = new Date().toISOString();
      let session;
      if (type === 'text') {
        session = sessionManager.appendMessage(scope, featureCode, {
          role: 'human',
          type: 'text',
          content,
          timestamp,
        });
      } else {
        // card_select — extract question and full card from last assistant decision block
        let question = 'pending';
        let card = { id: cardId };

        const currentSession = sessionManager.getSession(scope, featureCode);
        if (currentSession) {
          // Walk messages in reverse to find the last assistant message with decision blocks
          for (let i = currentSession.messages.length - 1; i >= 0; i--) {
            const msg = currentSession.messages[i];
            if (msg.role === 'assistant' && typeof msg.content === 'string') {
              const { parts } = parseDecisionBlocks(msg.content);
              const decisionPart = parts.find(p => p.type === 'decision');
              if (decisionPart) {
                const block = decisionPart.content;
                if (block.question) {
                  question = block.question;
                }
                // Find the full card object by matching cardId
                if (Array.isArray(block.options)) {
                  const matched = block.options.find(o => o.id === cardId);
                  if (matched) {
                    card = matched;
                  }
                }
                break;
              }
            }
          }
        }

        sessionManager.recordDecision(scope, featureCode, question, card, comment);
        session = sessionManager.appendMessage(scope, featureCode, {
          role: 'human',
          type: 'card_select',
          content: { cardId, comment },
          timestamp,
        });
      }
      broadcastDesignEvent(key, 'ack', { messageCount: session.messages.length });
      res.json({ session });

      // Fire-and-forget LLM dispatch (don't block the HTTP response)
      if (projectRoot) {
        dispatchDesignAgent(sessionManager, projectRoot, scope, featureCode);
      }
    } catch (err) {
      if (err.message.includes('No session found')) {
        return res.status(404).json({ error: err.message });
      }
      res.status(400).json({ error: err.message });
    }
  });

  // GET /api/design/session
  app.get('/api/design/session', (req, res) => {
    const { scope, featureCode } = req.query;
    try {
      const sessionManager = getSessionManager();
      const session = sessionManager.getSession(scope || 'product', featureCode);
      res.json({ session });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // POST /api/design/complete — generate design doc and mark session complete
  app.post('/api/design/complete', async (req, res) => {
    const { scope, featureCode } = req.body || {};
    try {
      const sessionManager = getSessionManager();
      const projectRoot = getProjectRoot();
      const key = sessionKey(scope, featureCode, projectRoot);
      const session = sessionManager.getSession(scope, featureCode);
      if (!session) {
        return res.status(404).json({ error: `No session found for ${scope}${featureCode ? `:${featureCode}` : ''}` });
      }

      // Mark session complete
      const completedSession = sessionManager.completeSession(scope, featureCode);

      // If no connector available or no projectRoot, skip doc generation
      if (!getConnector() || !projectRoot) {
        res.json({ session: completedSession });
        return;
      }

      // Build the design doc generation prompt
      const activeDecisions = session.decisions.filter(d => !d.superseded);
      const formattedMessages = session.messages
        .map(m => {
          if (m.role === 'human' && m.type === 'text') return `Human: ${m.content}`;
          if (m.role === 'human' && m.type === 'card_select') {
            return `Human: [Selected option "${m.content?.cardId}"${m.content?.comment ? ` — ${m.content.comment}` : ''}]`;
          }
          if (m.role === 'assistant') return `Assistant: ${m.content}`;
          return `${m.role}: ${JSON.stringify(m.content)}`;
        })
        .join('\n\n');

      const docPrompt = `Based on the following design conversation, write a comprehensive design document.

Decisions made:
${JSON.stringify(activeDecisions, null, 2)}

Conversation history:
${formattedMessages}

Write the design document in Markdown format. Include:
- Problem statement (from early conversation)
- Key decisions with rationale
- Architecture approach
- Open questions (if any remain)
- Recommended next steps

Output ONLY the Markdown content, no code fences.`;

      // Generate the design doc via a fresh connector
      const { ClaudeSDKConnector } = await import('./connectors/claude-sdk-connector.js');
      const connector = new ClaudeSDKConnector({ cwd: projectRoot });
      let docContent = '';
      try {
        for await (const event of connector.run(docPrompt)) {
          if (event.type === 'assistant' && event.content) {
            docContent += event.content;
          } else if (event.type === 'result' && event.content && !docContent) {
            docContent = event.content;
          }
        }
      } catch (err) {
        // If generation fails, still return the completed session
        console.error('[design] Doc generation failed:', err.message);
        res.json({ session: completedSession });
        return;
      }

      // Determine the output path
      let designDocPath;
      if (scope === 'feature' && featureCode) {
        designDocPath = path.join('docs', 'features', featureCode, 'design.md');
      } else {
        designDocPath = path.join('docs', 'design.md');
      }

      // Write the design doc
      const absPath = path.join(projectRoot, designDocPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, docContent, 'utf-8');

      broadcastDesignEvent(key, 'complete', { designDocPath });
      res.json({ session: completedSession, designDocPath });
    } catch (err) {
      if (err.message.includes('No session found')) {
        return res.status(404).json({ error: err.message });
      }
      res.status(400).json({ error: err.message });
    }
  });

  // POST /api/design/revise — mark a decision as superseded and re-ask
  app.post('/api/design/revise', (req, res) => {
    const { scope, featureCode, decisionIndex } = req.body || {};
    if (!scope || !['product', 'feature'].includes(scope)) {
      return res.status(400).json({ error: 'scope must be "product" or "feature"' });
    }
    if (typeof decisionIndex !== 'number' || decisionIndex < 0) {
      return res.status(400).json({ error: 'decisionIndex must be a non-negative number' });
    }
    try {
      const sessionManager = getSessionManager();
      const existingSession = sessionManager.getSession(scope, featureCode);
      if (!existingSession) {
        return res.status(404).json({ error: 'No session found' });
      }
      if (existingSession.status === 'complete') {
        return res.status(409).json({ error: 'Cannot revise a completed session' });
      }
      const projectRoot = getProjectRoot();
      const key = sessionKey(scope, featureCode, projectRoot);
      const decision = existingSession.decisions[decisionIndex];
      const session = sessionManager.reviseDecision(scope, featureCode, decisionIndex);
      // Atomically append the re-ask message so revision + message are one operation
      const reaskContent = `I want to revise my decision on "${decision?.question || 'this question'}". I previously chose "${decision?.selectedOption?.title || decision?.selectedOption?.id || 'an option'}". Let me reconsider.`;
      sessionManager.appendMessage(scope, featureCode, {
        role: 'human',
        type: 'text',
        content: reaskContent,
        timestamp: new Date().toISOString(),
      });
      broadcastDesignEvent(key, 'revision', { decisionIndex });
      // Dispatch agent to re-ask the question
      if (projectRoot) {
        dispatchDesignAgent(sessionManager, projectRoot, scope, featureCode);
      }
      res.json({ session: sessionManager.getSession(scope, featureCode) });
    } catch (err) {
      if (err.message.includes('No session found')) {
        return res.status(404).json({ error: err.message });
      }
      res.status(400).json({ error: err.message });
    }
  });

  // GET /api/design/stream — SSE endpoint (scoped by session key)
  app.get('/api/design/stream', (req, res) => {
    const { scope, featureCode } = req.query;
    const key = sessionKey(scope, featureCode, getProjectRoot());

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    if (!designListeners.has(key)) {
      designListeners.set(key, new Set());
    }
    designListeners.get(key).add(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(':keepalive\n\n');
      } catch {
        clearInterval(heartbeat);
        designListeners.get(key)?.delete(res);
      }
    }, 30_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      const listeners = designListeners.get(key);
      if (listeners) {
        listeners.delete(res);
        if (listeners.size === 0) designListeners.delete(key);
      }
    });
  });
}
