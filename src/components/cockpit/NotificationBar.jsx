/**
 * NotificationBar — thin strip at the bottom of the cockpit for transient
 * system notifications (errors, info, connection status).
 *
 * Listens for a `compose:notify` CustomEvent with detail:
 *   { message: string, level: 'info'|'warn'|'error', ttl?: number }
 *
 * Auto-dismisses after `ttl` ms (default 4 000).
 * Hidden when there are no active notifications.
 *
 * Props: none — fully event-driven.
 */
import React, { useState, useEffect, useRef } from 'react';

const DEFAULT_TTL = 4000;

const LEVEL_STYLES = {
  info:  { color: 'hsl(var(--foreground))',    bg: 'hsl(var(--muted))' },
  warn:  { color: 'hsl(var(--warning, 32 95% 52%))', bg: 'hsl(var(--muted))' },
  error: { color: 'hsl(var(--destructive))',   bg: 'hsl(var(--destructive) / 0.08)' },
};

export default function NotificationBar() {
  const [notification, setNotification] = useState(null);
  const timerRef = useRef(null);

  useEffect(() => {
    function handleNotify(e) {
      const { message, level = 'info', ttl = DEFAULT_TTL } = e.detail ?? {};
      if (!message) return;

      clearTimeout(timerRef.current);
      setNotification({ message, level });

      if (ttl > 0) {
        timerRef.current = setTimeout(() => setNotification(null), ttl);
      }
    }

    window.addEventListener('compose:notify', handleNotify);
    return () => {
      window.removeEventListener('compose:notify', handleNotify);
      clearTimeout(timerRef.current);
    };
  }, []);

  if (!notification) return null;

  const style = LEVEL_STYLES[notification.level] ?? LEVEL_STYLES.info;

  return (
    <div
      className="h-6 flex items-center justify-between px-3 gap-2 shrink-0 text-[11px] font-mono"
      style={{
        background: style.bg,
        color: style.color,
        borderTop: '1px solid hsl(var(--border))',
      }}
      role="status"
      aria-live="polite"
    >
      <span className="flex-1 min-w-0 truncate">{notification.message}</span>
      <button
        className="shrink-0 opacity-60 hover:opacity-100 text-[10px]"
        onClick={() => {
          clearTimeout(timerRef.current);
          setNotification(null);
        }}
        aria-label="Dismiss notification"
      >
        ✕
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helper: fire a compose:notify event from anywhere in the app
// ---------------------------------------------------------------------------

export function notify(message, level = 'info', ttl = DEFAULT_TTL) {
  try {
    window.dispatchEvent(
      new CustomEvent('compose:notify', { detail: { message, level, ttl } })
    );
  } catch {
    // ignore SSR / test env
  }
}
