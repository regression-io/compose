import React, { useState } from 'react';
import {
  violationDisplayState,
  violationHeaderLabel,
  violationChevron,
} from './violationDetailState.js';

/**
 * ViolationDetail — collapsible list of policy/gate violations.
 *
 * Props:
 *   violations  string[]   List of violation messages. Renders nothing when empty.
 *   expanded    boolean    Optional controlled expanded state (default: false).
 *   onToggle    function   Optional controlled toggle callback. When omitted the
 *                          component manages its own state with useState.
 */
export default function ViolationDetail({ violations = [], expanded: controlledExpanded, onToggle }) {
  const [localExpanded, setLocalExpanded] = useState(false);

  const isControlled = controlledExpanded !== undefined;
  const expanded = isControlled ? controlledExpanded : localExpanded;

  const displayState = violationDisplayState(violations, expanded);
  if (displayState === 'hidden') return null;

  function handleToggle() {
    if (isControlled) {
      onToggle?.();
    } else {
      setLocalExpanded(v => !v);
    }
  }

  const chevron = violationChevron(expanded);
  const label = violationHeaderLabel(violations);

  return (
    <div
      style={{
        background: 'hsl(38 90% 50% / 0.06)',
        borderLeft: '2px solid hsl(38 90% 50% / 0.3)',
        borderRadius: '3px',
        marginTop: '4px',
      }}
    >
      {/* Header row — always visible, clickable */}
      <div
        onClick={handleToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          padding: '3px 8px',
          cursor: 'pointer',
          color: 'hsl(38 90% 70%)',
          fontSize: '10px',
          fontFamily: 'monospace',
          userSelect: 'none',
        }}
      >
        <span style={{ opacity: 0.7 }}>{chevron}</span>
        <span>{label}</span>
      </div>

      {/* Expanded list */}
      {displayState === 'expanded' && (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: '0 8px 6px 16px',
          }}
        >
          {violations.map((v, i) => (
            <li
              key={i}
              style={{
                color: 'hsl(38 50% 60%)',
                fontSize: '10px',
                fontFamily: 'monospace',
                lineHeight: '1.5',
              }}
            >
              {v}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
