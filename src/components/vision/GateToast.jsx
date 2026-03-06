import React, { useEffect, useState } from 'react';
import { LIFECYCLE_PHASE_LABELS } from './constants.js';

export default function GateToast({ event, items, onNavigate }) {
  const [visible, setVisible] = useState(false);
  const [current, setCurrent] = useState(null);

  useEffect(() => {
    if (!event) return;
    setCurrent(event);
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 5000);
    return () => clearTimeout(timer);
  }, [event]);

  if (!visible || !current) return null;

  const item = items.find(i => i.id === current.itemId);
  const title = item?.title ?? 'Unknown';
  const message = current.type === 'pending'
    ? `Gate pending: ${title} — ${LIFECYCLE_PHASE_LABELS[current.fromPhase] ?? current.fromPhase} → ${LIFECYCLE_PHASE_LABELS[current.toPhase] ?? current.toPhase}`
    : `Gate ${current.outcome}: ${title}`;

  return (
    <button
      onClick={() => { onNavigate(); setVisible(false); }}
      className="fixed bottom-4 right-4 z-50 max-w-sm px-4 py-3 rounded-lg border border-border bg-card shadow-lg text-sm text-foreground cursor-pointer hover:bg-muted/50 transition-all animate-in fade-in slide-in-from-bottom-2"
    >
      {message}
    </button>
  );
}
