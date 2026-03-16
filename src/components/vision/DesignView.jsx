import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useDesignStore } from './useDesignStore.js';
import DesignCard from './DesignCard.jsx';
import { parseDecisionBlocks } from './designSessionState.js';
import { cn } from '@/lib/utils.js';
import { MessageSquare, Send, Sparkles } from 'lucide-react';

/**
 * DesignView — Interactive design conversation with decision cards.
 *
 * Renders a chat-style thread where assistant messages may contain
 * ```decision blocks parsed into DesignCard components. The input area
 * switches between text input and card-selection confirmation depending
 * on whether the user has clicked a card.
 */
export default function DesignView() {
  const {
    session, messages, decisions, status, error, streamingMessage,
    designDocPath,
    hydrate, startSession, sendMessage, selectCard, completeDesign,
    connectSSE, disconnectSSE,
  } = useDesignStore();

  const [inputValue, setInputValue] = useState('');
  const [selectedCard, setSelectedCard] = useState(null); // { messageIndex: number, cardId: string } | null
  const [cardComment, setCardComment] = useState('');
  const messagesEndRef = useRef(null);

  // Hydrate on mount — hydrate() handles SSE connection after setting state
  // Clear in-memory scope first so hydrate falls through to localStorage/default
  // (important after project switch which remounts via key={projectRoot})
  useEffect(() => {
    useDesignStore.setState({ scope: null, featureCode: null });
    hydrate();
    return () => disconnectSSE();
  }, []);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingMessage]);

  // Handle text submit
  const handleSend = useCallback(() => {
    if (!inputValue.trim()) return;
    sendMessage(inputValue.trim());
    setInputValue('');
  }, [inputValue, sendMessage]);

  // Handle card selection (click on a card) — track message index to avoid ID collisions
  const handleCardSelect = useCallback((cardId, messageIndex) => {
    setSelectedCard({ messageIndex, cardId });
  }, []);

  // Handle card submit (with optional comment)
  const handleCardSend = useCallback(() => {
    if (!selectedCard) return;
    selectCard(selectedCard.cardId, cardComment || null);
    setSelectedCard(null);
    setCardComment('');
  }, [selectedCard, cardComment, selectCard]);

  const isStreaming = status === 'streaming' || status === 'summarizing';

  // Find the last message index that contains decision blocks — only that message's cards are clickable
  const lastDecisionIndex = messages.reduce((acc, msg, i) => {
    if (msg.role === 'assistant' && msg.content && parseDecisionBlocks(msg.content).parts.some(p => p.type === 'decision')) return i;
    return acc;
  }, -1);

  // ── No session state ──────────────────────────────────────────────────
  if (!session) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
        <MessageSquare className="text-muted-foreground" style={{ width: 48, height: 48 }} />
        <h2 className="text-[14px] font-semibold text-foreground">Start a Design Conversation</h2>
        <p className="text-[12px] text-muted-foreground text-center max-w-md">
          Have an interactive design conversation with the AI. It will ask questions,
          present options with trade-offs, and build a design document from your decisions.
        </p>
        {error && (
          <p className="text-[11px] text-red-400 text-center max-w-md">{error}</p>
        )}
        <div className="flex gap-2">
          <button
            onClick={() => startSession('product')}
            className="px-4 py-2 text-[11px] font-medium rounded bg-accent text-accent-foreground hover:opacity-90 transition-opacity"
          >
            Product Design
          </button>
          <button
            onClick={() => {
              const code = prompt('Feature code:');
              if (code) startSession('feature', code);
            }}
            className="px-4 py-2 text-[11px] font-medium rounded border border-border text-foreground hover:bg-muted transition-colors"
          >
            Feature Design
          </button>
        </div>
      </div>
    );
  }

  // ── Active session ────────────────────────────────────────────────────
  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Error banner */}
      {error && (
        <div className="px-3 py-1.5 text-[11px] text-red-400 bg-red-500/10 border-b border-red-500/20 shrink-0">
          {error}
        </div>
      )}

      {/* Completion banner */}
      {status === 'complete' && (
        <div className="px-3 py-2 text-[11px] bg-green-500/10 border-b border-green-500/20 shrink-0 flex items-center gap-2">
          <Sparkles style={{ width: 12, height: 12 }} className="text-green-400" />
          <span className="text-green-400 font-medium">Design complete.</span>
          {designDocPath && (
            <span className="text-muted-foreground">
              Document written to <code className="text-foreground">{designDocPath}</code>
            </span>
          )}
        </div>
      )}

      {/* Message thread */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg, i) => (
          <MessageBubble
            key={i}
            messageIndex={i}
            message={msg}
            onCardSelect={handleCardSelect}
            selectedCard={selectedCard}
            isStreaming={isStreaming}
            cardsDisabled={isStreaming || i !== lastDecisionIndex}
          />
        ))}

        {/* Streaming message (partial) */}
        {streamingMessage && (
          <MessageBubble
            message={streamingMessage}
            onCardSelect={handleCardSelect}
            selectedCard={selectedCard}
            isStreaming={isStreaming}
          />
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area — hidden when session is complete */}
      {status !== 'complete' && (
      <div className="border-t border-border p-3 shrink-0">
        {selectedCard ? (
          /* Card selected — show confirmation with optional comment */
          <div className="flex flex-col gap-2">
            <div className="text-[11px] text-muted-foreground">
              Selected: <span className="font-semibold text-foreground">{selectedCard.cardId}</span>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={cardComment}
                onChange={(e) => setCardComment(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCardSend()}
                placeholder="Add a comment (optional)..."
                className="flex-1 bg-muted border border-border rounded px-3 py-1.5 text-[12px] text-foreground placeholder:text-muted-foreground outline-none focus:border-accent"
              />
              <button
                onClick={handleCardSend}
                disabled={isStreaming}
                className="px-3 py-1.5 text-[11px] font-medium rounded bg-accent text-accent-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                Send
              </button>
              <button
                onClick={() => { setSelectedCard(null); setCardComment(''); }}
                className="px-3 py-1.5 text-[11px] rounded border border-border text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          /* Normal text input */
          <div className="flex gap-2">
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
              placeholder={isStreaming ? 'Waiting for response...' : 'Type a response...'}
              disabled={isStreaming}
              className="flex-1 bg-muted border border-border rounded px-3 py-1.5 text-[12px] text-foreground placeholder:text-muted-foreground outline-none focus:border-accent disabled:opacity-50"
            />
            <button
              onClick={handleSend}
              disabled={isStreaming || !inputValue.trim()}
              className="px-3 py-1.5 rounded bg-accent text-accent-foreground disabled:opacity-50 transition-opacity"
            >
              <Send style={{ width: 14, height: 14 }} />
            </button>
          </div>
        )}

        {/* Complete design button — visible after 2+ decisions */}
        {status === 'active' && decisions.length >= 2 && (
          <button
            onClick={completeDesign}
            className="mt-2 w-full py-1.5 text-[11px] font-medium rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground transition-colors flex items-center justify-center gap-1.5"
          >
            <Sparkles style={{ width: 12, height: 12 }} />
            Complete Design
          </button>
        )}
      </div>
      )}
    </div>
  );
}

// ── MessageBubble — renders a single message ────────────────────────────

function MessageBubble({ message, messageIndex, onCardSelect, selectedCard, isStreaming, cardsDisabled }) {
  const isHuman = message.role === 'human';

  // Parse decision blocks from assistant messages
  const parsedContent = !isHuman && message.content
    ? parseDecisionBlocks(message.content)
    : null;

  return (
    <div className={cn('flex', isHuman ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-lg px-3 py-2 text-[12px]',
          isHuman
            ? 'bg-accent/20 text-foreground'
            : 'bg-muted text-foreground',
        )}
      >
        {isHuman ? (
          /* Human message */
          <div>
            {message.type === 'card_select' ? (
              <span>
                Selected <strong>{message.content?.cardId}</strong>
                {message.content?.comment ? `: ${message.content.comment}` : ''}
              </span>
            ) : (
              <span>{message.content}</span>
            )}
          </div>
        ) : parsedContent ? (
          /* Assistant message with possible decision blocks */
          <div className="space-y-3">
            {parsedContent.parts.map((part, i) => (
              part.type === 'text' ? (
                <div key={i} className="whitespace-pre-wrap">{part.content}</div>
              ) : (
                <div key={i} className="space-y-2">
                  {/* Decision cards */}
                  <div className="flex flex-col gap-2 mt-2">
                    {part.content.options?.map(card => (
                      <DesignCard
                        key={card.id}
                        card={card}
                        recommended={part.content.recommendation?.id === card.id}
                        selected={selectedCard?.messageIndex === messageIndex && selectedCard?.cardId === card.id}
                        disabled={cardsDisabled}
                        onSelect={(cardId) => onCardSelect(cardId, messageIndex)}
                      />
                    ))}
                  </div>
                  {/* Recommendation rationale */}
                  {part.content.recommendation?.rationale && (
                    <div className="text-[11px] text-muted-foreground italic mt-1">
                      {part.content.recommendation.rationale}
                    </div>
                  )}
                </div>
              )
            ))}
          </div>
        ) : (
          /* Plain assistant message */
          <div className="whitespace-pre-wrap">{message.content}</div>
        )}
      </div>
    </div>
  );
}
