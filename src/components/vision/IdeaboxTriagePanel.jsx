/**
 * IdeaboxTriagePanel — modal-style triage flow for untriaged ideas.
 *
 * Shows untriaged ideas one at a time.
 * Actions: P0 / P1 / P2 / Promote / Kill / Skip
 * Progress: "5 of 12 untriaged ideas"
 * Summary on completion: "Triaged 8 ideas: 2 P0, 3 P1, 3 P2"
 *
 * Similar ideas (v1): match by tag overlap with other ideas in the same session.
 */

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { X, ChevronRight, Lightbulb, SkipForward } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { Badge } from '@/components/ui/badge.jsx';
import { Button } from '@/components/ui/button.jsx';
import { useIdeaboxStore } from './useIdeaboxStore.js';

// ---------------------------------------------------------------------------
// Tag overlap similarity (v1 dedup — no LLM)
// ---------------------------------------------------------------------------

function tagOverlap(a, b) {
  if (!a.tags?.length || !b.tags?.length) return 0;
  const setA = new Set(a.tags);
  const matches = b.tags.filter(t => setA.has(t)).length;
  return matches / Math.max(a.tags.length, b.tags.length);
}

function findSimilar(idea, allIdeas) {
  return allIdeas
    .filter(other => other.id !== idea.id)
    .map(other => ({ idea: other, score: tagOverlap(idea, other) }))
    .filter(({ score }) => score > 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ idea }) => idea);
}

// ---------------------------------------------------------------------------
// Summary screen
// ---------------------------------------------------------------------------

function TriageSummary({ results, onClose }) {
  const counts = useMemo(() => {
    const c = { P0: 0, P1: 0, P2: 0, killed: 0, promoted: 0, skipped: 0 };
    for (const r of results) {
      if (r.action === 'skip') c.skipped++;
      else if (r.action === 'kill') c.killed++;
      else if (r.action === 'promote') c.promoted++;
      else if (r.priority === 'P0') c.P0++;
      else if (r.priority === 'P1') c.P1++;
      else if (r.priority === 'P2') c.P2++;
    }
    return c;
  }, [results]);

  const triaged = results.filter(r => r.action !== 'skip').length;

  return (
    <div className="flex flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="w-10 h-10 rounded-full bg-emerald-400/20 flex items-center justify-center">
        <Lightbulb className="w-5 h-5 text-emerald-400" />
      </div>
      <h3 className="text-sm font-semibold text-foreground">Triage complete</h3>
      <p className="text-[12px] text-muted-foreground">
        Triaged {triaged} of {results.length} ideas
      </p>
      <div className="flex gap-3 text-[11px]">
        {counts.P0 > 0 && <span className="text-red-400">{counts.P0} P0</span>}
        {counts.P1 > 0 && <span className="text-amber-400">{counts.P1} P1</span>}
        {counts.P2 > 0 && <span className="text-blue-400">{counts.P2} P2</span>}
        {counts.promoted > 0 && <span className="text-emerald-400">{counts.promoted} promoted</span>}
        {counts.killed > 0 && <span className="text-muted-foreground">{counts.killed} killed</span>}
        {counts.skipped > 0 && <span className="text-muted-foreground/60">{counts.skipped} skipped</span>}
      </div>
      <Button size="sm" onClick={onClose} className="mt-2">Done</Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// IdeaboxTriagePanel
// ---------------------------------------------------------------------------

export default function IdeaboxTriagePanel({ ideas: initialIdeas, onClose }) {
  const { setPriority, killIdea, promoteIdea, ideas: allIdeas } = useIdeaboxStore();

  const [queue, setQueue] = useState(() => [...initialIdeas]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [results, setResults] = useState([]);
  const [done, setDone] = useState(false);
  const [killReason, setKillReason] = useState('');
  const [showKillInput, setShowKillInput] = useState(false);
  const [processing, setProcessing] = useState(false);

  const currentIdea = queue[currentIndex] ?? null;
  const remaining = queue.length - currentIndex;

  const similarIdeas = useMemo(() => {
    if (!currentIdea) return [];
    return findSimilar(currentIdea, allIdeas.filter(i => i.id !== currentIdea.id));
  }, [currentIdea, allIdeas]);

  const advance = useCallback(() => {
    const next = currentIndex + 1;
    if (next >= queue.length) {
      setDone(true);
    } else {
      setCurrentIndex(next);
      setShowKillInput(false);
      setKillReason('');
    }
  }, [currentIndex, queue.length]);

  const handlePriority = useCallback(async (priority) => {
    if (!currentIdea || processing) return;
    setProcessing(true);
    try {
      await setPriority(currentIdea.id, priority);
      setResults(r => [...r, { id: currentIdea.id, action: 'priority', priority }]);
      advance();
    } finally {
      setProcessing(false);
    }
  }, [currentIdea, processing, setPriority, advance]);

  const handleKill = useCallback(async () => {
    if (!currentIdea || processing) return;
    setProcessing(true);
    try {
      await killIdea(currentIdea.id, killReason);
      setResults(r => [...r, { id: currentIdea.id, action: 'kill' }]);
      setShowKillInput(false);
      setKillReason('');
      advance();
    } finally {
      setProcessing(false);
    }
  }, [currentIdea, processing, killIdea, killReason, advance]);

  const handleSkip = useCallback(() => {
    if (!currentIdea) return;
    setResults(r => [...r, { id: currentIdea.id, action: 'skip' }]);
    advance();
  }, [currentIdea, advance]);

  const handlePromote = useCallback(async () => {
    if (!currentIdea || processing) return;
    setProcessing(true);
    try {
      await promoteIdea(currentIdea.id);
      setResults(r => [...r, { id: currentIdea.id, action: 'promote' }]);
      advance();
    } finally {
      setProcessing(false);
    }
  }, [currentIdea, processing, promoteIdea, advance]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (showKillInput) return;
      if (e.key === '0') handlePriority('P0');
      if (e.key === '1') handlePriority('P1');
      if (e.key === '2') handlePriority('P2');
      if (e.key === 's' || e.key === 'ArrowRight') handleSkip();
      if (e.key === 'k') setShowKillInput(true);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showKillInput, handlePriority, handleSkip, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'hsl(var(--background) / 0.8)', backdropFilter: 'blur(4px)' }}
    >
      <div className="w-full max-w-lg mx-4 rounded-xl border border-border bg-card shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <Lightbulb className="w-4 h-4 text-amber-400 shrink-0" />
          <span className="text-sm font-semibold text-foreground">Triage</span>
          {!done && (
            <span className="text-[11px] text-muted-foreground ml-1">
              {currentIndex + 1} of {queue.length} untriaged
            </span>
          )}
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="text-muted-foreground/60 hover:text-foreground transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Progress bar */}
        {!done && (
          <div className="h-1 bg-muted">
            <div
              className="h-full bg-accent transition-all duration-300"
              style={{ width: `${Math.round((currentIndex / queue.length) * 100)}%` }}
            />
          </div>
        )}

        {/* Body */}
        <div className="flex-1 p-4">
          {done ? (
            <TriageSummary results={results} onClose={onClose} />
          ) : currentIdea ? (
            <div className="space-y-4">
              {/* Idea card */}
              <div className="rounded-lg border border-border bg-muted/30 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 font-mono">
                    {currentIdea.id}
                  </Badge>
                  {currentIdea.cluster && (
                    <span className="text-[10px] text-muted-foreground/60">{currentIdea.cluster}</span>
                  )}
                </div>

                <h3 className="text-[14px] text-foreground font-semibold leading-snug mb-2">
                  {currentIdea.title}
                </h3>

                {currentIdea.description && (
                  <p className="text-[12px] text-muted-foreground leading-relaxed mb-2">
                    {currentIdea.description}
                  </p>
                )}

                <div className="flex flex-wrap gap-1.5 mt-2">
                  {(currentIdea.tags || []).map(tag => (
                    <span key={tag} className="text-[10px] bg-muted px-1.5 py-0.5 rounded font-mono text-muted-foreground">
                      {tag}
                    </span>
                  ))}
                </div>

                {currentIdea.source && (
                  <p className="text-[10px] text-muted-foreground/50 mt-2">
                    Source: {currentIdea.source}
                  </p>
                )}
              </div>

              {/* Similar ideas */}
              {similarIdeas.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1.5">
                    Similar to:
                  </p>
                  <div className="space-y-1">
                    {similarIdeas.map(sim => (
                      <div key={sim.id} className="flex items-center gap-2 px-2 py-1.5 rounded bg-muted/30 border border-border/40">
                        <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 font-mono opacity-70">
                          {sim.id}
                        </Badge>
                        <span className="text-[11px] text-muted-foreground truncate">{sim.title}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Kill reason input */}
              {showKillInput && (
                <div className="space-y-2">
                  <input
                    autoFocus
                    type="text"
                    placeholder="Reason for killing (optional)…"
                    value={killReason}
                    onChange={e => setKillReason(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleKill(); if (e.key === 'Escape') setShowKillInput(false); }}
                    className="w-full text-[12px] bg-muted text-foreground px-3 py-2 rounded border border-border outline-none focus:border-ring"
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1 h-7 text-[11px]"
                      onClick={() => { setShowKillInput(false); setKillReason(''); }}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      className="flex-1 h-7 text-[11px] bg-destructive/80 hover:bg-destructive text-destructive-foreground"
                      onClick={handleKill}
                      disabled={processing}
                    >
                      Confirm Kill
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-[12px] text-muted-foreground text-center py-8">No more untriaged ideas.</p>
          )}
        </div>

        {/* Actions */}
        {!done && currentIdea && !showKillInput && (
          <div className="px-4 pb-4 space-y-2">
            {/* Priority row */}
            <div className="grid grid-cols-3 gap-2">
              <Button
                size="sm"
                className="h-9 text-[12px] bg-red-500/80 hover:bg-red-500 text-white border-0"
                onClick={() => handlePriority('P0')}
                disabled={processing}
                title="Press 0"
              >
                P0 <kbd className="ml-1 text-[9px] opacity-60 font-mono">0</kbd>
              </Button>
              <Button
                size="sm"
                className="h-9 text-[12px] bg-amber-500/80 hover:bg-amber-500 text-white border-0"
                onClick={() => handlePriority('P1')}
                disabled={processing}
                title="Press 1"
              >
                P1 <kbd className="ml-1 text-[9px] opacity-60 font-mono">1</kbd>
              </Button>
              <Button
                size="sm"
                className="h-9 text-[12px] bg-blue-500/80 hover:bg-blue-500 text-white border-0"
                onClick={() => handlePriority('P2')}
                disabled={processing}
                title="Press 2"
              >
                P2 <kbd className="ml-1 text-[9px] opacity-60 font-mono">2</kbd>
              </Button>
            </div>

            {/* Secondary actions */}
            <div className="grid grid-cols-3 gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[11px] text-emerald-400 border-emerald-400/30 hover:bg-emerald-400/10"
                onClick={handlePromote}
                disabled={processing}
              >
                Promote
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[11px] text-destructive border-destructive/30 hover:bg-destructive/10"
                onClick={() => setShowKillInput(true)}
                title="Press k"
              >
                Kill <kbd className="ml-1 text-[9px] opacity-60 font-mono">k</kbd>
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[11px] text-muted-foreground gap-1"
                onClick={handleSkip}
                title="Press s or →"
              >
                <SkipForward className="w-3 h-3" />
                Skip <kbd className="ml-1 text-[9px] opacity-60 font-mono">s</kbd>
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
