import React, { useState } from 'react';

const ERROR_RE = /\b(Error|error:|Traceback|FAILED|ENOENT|Cannot find)\b/;
const LINES_PREVIEW = 20;

/**
 * ToolResultBlock — collapsible output block attached below a tool_use block.
 *
 * Props:
 *   summary  string             Short label (e.g. "Read 245 lines from MessageCard.jsx")
 *   output   string|undefined   Full output text (≤2KB, truncated at connector). When
 *                                undefined, renders summary-only with no expand affordance.
 */
export default function ToolResultBlock({ summary, output }) {
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const isError = output ? ERROR_RE.test(output) : false;
  const hasOutput = output != null && output.length > 0;
  const lines = hasOutput ? output.split('\n') : [];
  const needsShowAll = lines.length > LINES_PREVIEW;
  const visibleLines = expanded && !showAll && needsShowAll
    ? lines.slice(0, LINES_PREVIEW)
    : lines;

  const borderColor = isError
    ? 'hsl(var(--destructive, 0 84% 60%))'
    : 'hsl(215 20% 20%)';

  // Summary-only: no expand affordance
  if (!hasOutput) {
    return (
      <div style={{
        marginLeft: 8, opacity: 0.6, fontSize: '10px', padding: '2px 0',
        color: 'hsl(var(--muted-foreground))',
        fontFamily: 'ui-monospace, monospace',
      }}>
        {summary}
      </div>
    );
  }

  return (
    <div style={{
      marginLeft: 8,
      borderLeft: `1px solid ${borderColor}`,
      paddingLeft: 8,
      marginTop: 2,
    }}>
      {/* Collapsed: clickable summary */}
      <div
        onClick={() => setExpanded(e => !e)}
        style={{
          opacity: 0.6, fontSize: '10px', cursor: 'pointer',
          color: 'hsl(var(--muted-foreground))',
          fontFamily: 'ui-monospace, monospace',
          userSelect: 'none',
          display: 'flex', alignItems: 'center', gap: 4,
        }}
      >
        <span style={{ fontSize: 9 }}>{expanded ? '▾' : '▸'}</span>
        {summary}
      </div>

      {/* Expanded: output text */}
      {expanded && (
        <pre style={{
          margin: '4px 0 0 0',
          padding: 0,
          fontSize: '10px',
          fontFamily: 'ui-monospace, monospace',
          color: isError ? 'hsl(var(--destructive, 0 84% 60%))' : 'hsl(var(--muted-foreground))',
          opacity: isError ? 0.9 : 0.7,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          lineHeight: 1.5,
        }}>
          {visibleLines.join('\n')}
          {!showAll && needsShowAll && (
            <>
              {'\n'}
              <span
                onClick={(e) => { e.stopPropagation(); setShowAll(true); }}
                style={{
                  color: 'hsl(var(--accent))',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  fontSize: '10px',
                }}
              >
                Show all ({lines.length} lines)
              </span>
            </>
          )}
        </pre>
      )}
    </div>
  );
}
