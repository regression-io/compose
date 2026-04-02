import React, { useState } from 'react';
import ViolationDetail from './ViolationDetail.jsx';

/**
 * StepOutcome — renders the headline for build_step_done messages.
 *
 * Props:
 *   msg   object   build_step_done message (stepId, retries, violations)
 *   mode  string   "stream" (full with ViolationDetail) | "strip" (badge only)
 */
export default function StepOutcome({ msg, mode = 'stream' }) {
  const [expanded, setExpanded] = useState(false);
  const retries = msg.retries ?? 0;
  const violations = msg.violations ?? [];
  const hasViolations = violations.length > 0;

  if (mode === 'strip') {
    if (retries === 0) return null;
    return (
      <span style={{
        background: 'hsl(38 90% 50% / 0.2)',
        color: 'hsl(38 90% 60%)',
        padding: '0 5px',
        borderRadius: '9999px',
        fontSize: '9px',
      }}>
        {retries}
      </span>
    );
  }

  // Stream mode
  return (
    <div className="text-[10px] py-0.5">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* Step complete text */}
        <span style={{ color: 'hsl(var(--success, 142 60% 50%))', opacity: 0.7 }}>
          step complete -- {msg.stepId}
        </span>

        {/* Retry badge */}
        {retries > 0 && (
          <span
            onClick={() => setExpanded(e => !e)}
            style={{
              background: 'hsl(38 90% 50% / 0.15)',
              color: 'hsl(38 90% 60%)',
              padding: '1px 6px',
              borderRadius: '9999px',
              fontSize: '10px',
              cursor: 'pointer',
            }}
          >
            {retries} {retries === 1 ? 'retry' : 'retries'}
          </span>
        )}

        {/* Checks label */}
        {hasViolations ? (
          <span
            onClick={() => setExpanded(e => !e)}
            style={{
              color: 'hsl(38 90% 60%)',
              fontSize: '10px',
              cursor: 'pointer',
            }}
          >
            {violations.length} {violations.length === 1 ? 'violation' : 'violations'}
          </span>
        ) : (
          <span style={{
            color: 'hsl(var(--success, 142 60% 50%))',
            opacity: 0.4,
            fontSize: '10px',
          }}>
            &#10003; checks passed
          </span>
        )}
      </div>

      {/* Expandable violation detail */}
      {expanded && hasViolations && (
        <ViolationDetail
          violations={violations}
          expanded={true}
          onToggle={() => setExpanded(false)}
        />
      )}
    </div>
  );
}
