/**
 * CommandPalette — Cmd+K search overlay.
 *
 * Data source: useVisionStore() — NO React Query.
 * Default (empty query): pending gates section + blocked items section.
 * Typed query (≥1 char): filtered items/gates/sessions grouped with section headers.
 *
 * Compose field names: item.title (not item.name), g.itemId (not g.item_id).
 *
 * Props: {
 *   open:         boolean
 *   onClose:      () => void
 *   onSelectItem: (id: string) => void
 *   onSelectGate: (id: string) => void
 * }
 */
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Search, ShieldCheck, AlertTriangle, Activity } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { useVisionStore } from '../useVisionStore.js';
import { useShallow } from 'zustand/react/shallow';
import { LIFECYCLE_PHASE_LABELS } from '../constants.js';
import StatusBadge from './StatusBadge.jsx';

export default function CommandPalette({ open, onClose, onSelectItem, onSelectGate }) {
  const { items, gates, sessions } = useVisionStore(useShallow(s => ({ items: s.items, gates: s.gates, sessions: s.sessions })));
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef(null);

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const results = useMemo(() => {
    if (!open) return [];

    if (!query.trim()) {
      // Default: pending gates + blocked items
      const pendingGates = gates
        .filter(g => g.status === 'pending')
        .slice(0, 3)
        .map(g => ({
          type: 'gate',
          id: g.id,
          label: `${LIFECYCLE_PHASE_LABELS[g.fromPhase] ?? g.fromPhase} Gate`,
          sub: items.find(i => i.id === g.itemId)?.title ?? g.itemId,
          status: 'pending',
          gate: g,
        }));

      const blockedItems = items
        .filter(i => i.status === 'blocked')
        .slice(0, 3)
        .map(i => ({
          type: 'item',
          id: i.id,
          label: i.title,
          sub: i.type,
          status: i.status,
          item: i,
        }));

      return [
        ...(pendingGates.length ? [{ type: 'section', label: 'Pending Gates' }] : []),
        ...pendingGates,
        ...(blockedItems.length ? [{ type: 'section', label: 'Blocked Items' }] : []),
        ...blockedItems,
      ];
    }

    const q = query.toLowerCase();

    // Items: match title, featureCode, description — cap 5
    const matchedItems = items
      .filter(i =>
        i.title?.toLowerCase().includes(q) ||
        i.featureCode?.toLowerCase().includes(q) ||
        (i.description || '').toLowerCase().includes(q)
      )
      .slice(0, 5)
      .map(i => ({
        type: 'item',
        id: i.id,
        label: i.title,
        sub: `${i.type} · ${i.phase ?? ''}`,
        status: i.status,
        item: i,
      }));

    // Gates: match fromPhase, toPhase, item title — cap 3
    const matchedGates = gates
      .filter(g =>
        (g.fromPhase || '').toLowerCase().includes(q) ||
        (g.toPhase || '').toLowerCase().includes(q) ||
        (items.find(i => i.id === g.itemId)?.title ?? '').toLowerCase().includes(q)
      )
      .slice(0, 3)
      .map(g => ({
        type: 'gate',
        id: g.id,
        label: `${LIFECYCLE_PHASE_LABELS[g.fromPhase] ?? g.fromPhase} → ${LIFECYCLE_PHASE_LABELS[g.toPhase] ?? g.toPhase}`,
        sub: items.find(i => i.id === g.itemId)?.title ?? g.itemId,
        status: g.status,
        gate: g,
      }));

    // Sessions: match featureCode, summary — cap 2
    const matchedSessions = (sessions || [])
      .filter(s =>
        (s.featureCode || '').toLowerCase().includes(q) ||
        (s.summary || '').toLowerCase().includes(q)
      )
      .slice(0, 2)
      .map(s => ({
        type: 'session',
        id: s.id,
        label: s.featureCode || s.id,
        sub: s.summary || s.agent || '',
        status: s.status,
        session: s,
      }));

    return [
      ...(matchedItems.length ? [{ type: 'section', label: 'Items' }] : []),
      ...matchedItems,
      ...(matchedGates.length ? [{ type: 'section', label: 'Gates' }] : []),
      ...matchedGates,
      ...(matchedSessions.length ? [{ type: 'section', label: 'Sessions' }] : []),
      ...matchedSessions,
    ];
  }, [open, query, items, gates, sessions]);

  // Selectable results (filter out section headers)
  const selectables = results.filter(r => r.type !== 'section');

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => (c + 1) % Math.max(1, selectables.length)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => (c - 1 + Math.max(1, selectables.length)) % Math.max(1, selectables.length)); return; }
    if (e.key === 'Enter') {
      const item = selectables[cursor];
      if (!item) return;
      if (item.type === 'gate') onSelectGate?.(item.id);
      else if (item.type === 'item') onSelectItem?.(item.id);
      else onClose();
      return;
    }
    if (e.key === 'Backspace' && query === '') { onClose(); return; }
  }, [selectables, cursor, query, onClose, onSelectGate, onSelectItem]);

  // Map flat results to cursor index for selectables
  let selectableIdx = 0;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]" onClick={onClose}>
      <div
        className="w-full max-w-[640px] mx-4 rounded-xl border border-slate-700 bg-card shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-700/50">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setCursor(0); }}
            onKeyDown={handleKeyDown}
            placeholder="Search items, gates, sessions…"
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
          />
          <kbd className="text-[10px] text-muted-foreground border border-border rounded px-1 py-0.5">esc</kbd>
        </div>

        {/* Results */}
        <div className="max-h-80 overflow-y-auto py-1">
          {results.length === 0 && (
            <div className="py-8 text-center text-xs text-muted-foreground">
              {query ? 'No results' : 'No pending gates or blocked items'}
            </div>
          )}
          {results.map((result, idx) => {
            if (result.type === 'section') {
              return (
                <div key={`section-${idx}`} className="px-4 pt-2 pb-1">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {result.label}
                  </span>
                </div>
              );
            }

            const selIdx = selectableIdx++;
            const isActive = cursor === selIdx;

            return (
              <button
                key={result.id}
                className={cn(
                  'flex w-full items-center gap-3 px-4 py-2 text-left transition-colors',
                  isActive ? 'bg-accent/10' : 'hover:bg-muted/50',
                )}
                onMouseEnter={() => setCursor(selIdx)}
                onClick={() => {
                  if (result.type === 'gate') onSelectGate?.(result.id);
                  else if (result.type === 'item') onSelectItem?.(result.id);
                  else onClose();
                }}
              >
                {/* Icon */}
                {result.type === 'gate' && <ShieldCheck className="h-4 w-4 text-amber-400 shrink-0" />}
                {result.type === 'item' && <AlertTriangle className="h-4 w-4 text-muted-foreground/60 shrink-0" />}
                {result.type === 'session' && <Activity className="h-4 w-4 text-blue-400 shrink-0" />}

                {/* Text */}
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-foreground truncate">{result.label}</div>
                  {result.sub && (
                    <div className="text-[10px] text-muted-foreground truncate">{result.sub}</div>
                  )}
                </div>

                {/* Status badge */}
                {result.status && (
                  <StatusBadge status={result.status} />
                )}
              </button>
            );
          })}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-3 px-4 py-2 border-t border-slate-700/50 text-[10px] text-muted-foreground">
          <span><kbd className="border border-border rounded px-1">↑↓</kbd> navigate</span>
          <span><kbd className="border border-border rounded px-1">↵</kbd> select</span>
          <span><kbd className="border border-border rounded px-1">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
