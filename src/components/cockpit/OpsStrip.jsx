import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useVisionStore } from '../vision/useVisionStore.js';
import { useShallow } from 'zustand/react/shallow';
import OpsStripEntry from './OpsStripEntry.jsx';
import { deriveEntries } from './opsStripLogic.js';

/**
 * OpsStrip — Persistent 36px bar surfacing active builds, pending gates, and recent errors.
 *
 * Sits between the main workspace and any future agent bar.
 * Hidden when activeView === 'docs'. Self-contained: calls useVisionStore internally.
 */

export default function OpsStrip({ activeView, onSelectFeature }) {
  const { activeBuild, gates, items, recentErrors, resolveGate, iterationStates } = useVisionStore(
    useShallow(s => ({ activeBuild: s.activeBuild, gates: s.gates, items: s.items, recentErrors: s.recentErrors, resolveGate: s.resolveGate, iterationStates: s.iterationStates }))
  );

  // Animation state per entry key
  const [animStates, setAnimStates] = useState(new Map());
  const prevEntriesRef = useRef([]);
  const dismissedRef = useRef(new Set());
  const completedRef = useRef(new Set());

  // COMP-STATE-3: Keep last completed build in memory for flash animation.
  // When activeBuild transitions from non-null to null (poll clears it),
  // we inject a synthetic 'done' build so the flash can fire.
  const prevBuildRef = useRef(activeBuild);
  const [completedBuild, setCompletedBuild] = useState(null);
  useEffect(() => {
    const prev = prevBuildRef.current;
    if (prev && prev.featureCode && !activeBuild) {
      // Build just disappeared — synthesize a 'done' entry for 3s
      setCompletedBuild({ ...prev, status: 'complete' });
      const timer = setTimeout(() => setCompletedBuild(null), 3000);
      prevBuildRef.current = activeBuild;
      return () => clearTimeout(timer);
    }
    prevBuildRef.current = activeBuild;
  }, [activeBuild]);

  const effectiveBuild = activeBuild || completedBuild;

  const entries = useMemo(
    () => deriveEntries({ activeBuild: effectiveBuild, gates, items, recentErrors, iterationStates }),
    [effectiveBuild, gates, items, recentErrors, iterationStates],
  );

  // Filter out dismissed entries
  const visibleEntries = useMemo(
    () => entries.filter(e => !dismissedRef.current.has(e.key)),
    [entries],
  );

  // Manage enter animations for new entries
  useEffect(() => {
    const prevKeys = new Set(prevEntriesRef.current.map(e => e.key));
    const newKeys = visibleEntries.filter(e => !prevKeys.has(e.key)).map(e => e.key);

    if (newKeys.length > 0) {
      setAnimStates(prev => {
        const next = new Map(prev);
        for (const key of newKeys) {
          next.set(key, 'enter');
        }
        return next;
      });

      // Transition to steady after animation
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setAnimStates(prev => {
            const next = new Map(prev);
            for (const key of newKeys) {
              if (next.get(key) === 'enter') next.set(key, 'steady');
            }
            return next;
          });
        });
      });
    }

    // Detect completed builds (was 'build', now 'done')
    for (const entry of visibleEntries) {
      if (entry.type === 'done' && !completedRef.current.has(entry.key)) {
        completedRef.current.add(entry.key);
        setAnimStates(prev => {
          const next = new Map(prev);
          next.set(entry.key, 'flash');
          return next;
        });
        // After 2s flash, fade out
        setTimeout(() => {
          setAnimStates(prev => {
            const next = new Map(prev);
            next.set(entry.key, 'exit');
            return next;
          });
          // Remove after fade
          setTimeout(() => {
            dismissedRef.current.add(entry.key);
            setAnimStates(prev => {
              const next = new Map(prev);
              next.delete(entry.key);
              return next;
            });
          }, 500);
        }, 2000);
      }
    }

    prevEntriesRef.current = visibleEntries;
  }, [visibleEntries]);

  const handleDismiss = useCallback((key) => {
    setAnimStates(prev => {
      const next = new Map(prev);
      next.set(key, 'exit');
      return next;
    });
    setTimeout(() => {
      dismissedRef.current.add(key);
      setAnimStates(prev => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
    }, 200);
  }, []);

  const handleApprove = useCallback((gateId) => {
    if (resolveGate) {
      resolveGate(gateId, 'approve', 'Approved from ops strip');
    }
  }, [resolveGate]);

  // Hidden when activeView is 'docs' or no entries
  if (activeView === 'docs' || visibleEntries.length === 0) {
    return null;
  }

  return (
    <div
      className="ops-strip"
      style={{
        height: '36px',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '0 12px',
        overflowX: 'auto',
        overflowY: 'hidden',
        borderTop: '1px solid hsl(var(--border))',
        background: 'hsl(var(--background))',
        flexShrink: 0,
      }}
    >
      {visibleEntries.map(entry => (
        <OpsStripEntry
          key={entry.key}
          type={entry.type}
          label={entry.label}
          retries={entry.retries}
          animationState={animStates.get(entry.key) || 'steady'}
          onClick={onSelectFeature ? () => onSelectFeature(entry.featureCode) : undefined}
          onApprove={entry.type === 'gate' && entry.gateId ? () => handleApprove(entry.gateId) : undefined}
          onDismiss={entry.type === 'error' ? () => handleDismiss(entry.key) : undefined}
        />
      ))}
    </div>
  );
}
