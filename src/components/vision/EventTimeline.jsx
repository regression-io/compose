/**
 * EventTimeline.jsx — Chronological timeline of feature lifecycle events.
 * Hydrates from session history + gates, live-updates via store.
 * COMP-UX-11
 */
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils.js';
import { assembleTimeline } from './timelineAssembler.js';
import TimelineEvent from './TimelineEvent.jsx';
import { useVisionStore } from './useVisionStore.js';

const CATEGORIES = ['all', 'phase', 'gate', 'session', 'iteration', 'error'];

const CATEGORY_LABELS = {
  all: 'All',
  phase: 'Phase',
  gate: 'Gate',
  session: 'Session',
  iteration: 'Iteration',
  error: 'Error',
};

export default function EventTimeline({ featureCode, itemId, onSelectItem }) {
  const [filter, setFilter] = useState('all');
  const [hydrated, setHydrated] = useState([]);
  const scrollRef = useRef(null);

  const gates = useVisionStore(s => s.gates);
  const liveEvents = useVisionStore(s => s.featureTimeline);
  const setFeatureTimeline = useVisionStore(s => s.setFeatureTimeline);

  // Hydrate from session history on mount / featureCode change
  useEffect(() => {
    if (!featureCode) return;
    let cancelled = false;

    fetch(`/api/session/history?featureCode=${encodeURIComponent(featureCode)}&limit=50`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        const featureGates = itemId
          ? (gates || []).filter(g => g.itemId === itemId)
          : gates || [];
        const events = assembleTimeline(data.sessions || [], featureGates, { id: itemId });
        setHydrated(events);
      })
      .catch(() => {
        if (!cancelled) setHydrated([]);
      });

    return () => { cancelled = true; };
  }, [featureCode, itemId]); // gates excluded intentionally — we only hydrate on mount

  // Merge hydrated + live, deduplicate, filter live events to this feature
  const allEvents = useMemo(() => {
    const map = new Map();
    for (const e of hydrated) map.set(e.id, e);
    for (const e of liveEvents) {
      // Only include live events that belong to this feature
      const eventItemId = e.meta?.itemId;
      const eventFeatureCode = e.meta?.featureCode;
      const isRelevant = !eventItemId && !eventFeatureCode // unscoped events (session, error) — include
        || eventItemId === itemId
        || eventFeatureCode === featureCode;
      if (isRelevant) map.set(e.id, e);
    }
    const merged = [...map.values()];
    merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return merged;
  }, [hydrated, liveEvents, itemId, featureCode]);

  // Apply filter
  const filteredEvents = useMemo(() => {
    if (filter === 'all') return allEvents;
    return allEvents.filter(e => e.category === filter);
  }, [allEvents, filter]);

  // Virtual list
  const virtualizer = useVirtualizer({
    count: filteredEvents.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 48,
    overscan: 5,
  });

  // Clear timeline when featureCode changes
  useEffect(() => {
    if (setFeatureTimeline) setFeatureTimeline([]);
  }, [featureCode]);

  if (!featureCode) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-[11px] text-muted-foreground/50">Select a feature to see its timeline.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Filter chips */}
      <div className="flex flex-wrap gap-1 px-2 py-2 border-b border-border">
        {CATEGORIES.map(cat => (
          <button
            key={cat}
            className={cn(
              'px-2 py-0.5 rounded text-[10px] font-medium transition-colors',
              filter === cat
                ? 'bg-foreground/10 text-foreground'
                : 'text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/30',
            )}
            onClick={() => setFilter(cat)}
          >
            {CATEGORY_LABELS[cat]}
            {cat !== 'all' && (
              <span className="ml-1 text-[9px] opacity-60">
                {allEvents.filter(e => e.category === cat).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Event count */}
      <div className="px-2 py-1">
        <span className="text-[10px] text-muted-foreground/50">
          {filteredEvents.length} event{filteredEvents.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Virtualized event list */}
      <div ref={scrollRef} className="flex-1 overflow-auto">
        {filteredEvents.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/50 px-2 py-4 text-center">
            No events{filter !== 'all' ? ` in "${CATEGORY_LABELS[filter]}"` : ''}.
          </p>
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map(virtualRow => (
              <div
                key={virtualRow.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <TimelineEvent
                  event={filteredEvents[virtualRow.index]}
                  onSelectItem={onSelectItem}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
