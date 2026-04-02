import React, { useState } from 'react';
import { getVerboseStream, setVerboseStream } from '../agent-stream-helpers.js';

/**
 * VerboseToggle — { } icon button for agent bar header.
 * Toggles verbose stream mode (shows tool_progress + tool_use_summary events).
 */
export default function VerboseToggle() {
  const [active, setActive] = useState(getVerboseStream);

  function handleClick() {
    const next = !active;
    setVerboseStream(next);
    setActive(next);
  }

  return (
    <button
      className="compose-btn-icon shrink-0"
      onClick={handleClick}
      title={active ? 'Hide verbose events' : 'Show verbose events'}
      aria-label="Toggle verbose stream"
      style={active ? {
        background: 'hsl(210 60% 60% / 0.15)',
        color: 'hsl(210 60% 60%)',
        borderRadius: '3px',
        padding: '1px 4px',
        fontSize: '10px',
      } : {
        fontSize: '10px',
      }}
    >
      {'{ }'}
    </button>
  );
}
