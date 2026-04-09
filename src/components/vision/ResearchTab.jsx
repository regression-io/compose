/**
 * ResearchTab.jsx
 *
 * COMP-DESIGN-1d: Research tab content for DesignSidebar.
 *
 * Three collapsible sections:
 *   1. Topic Outline — decisions + discovered topics
 *   2. Codebase References — Read/Grep/Glob tool uses
 *   3. Web Searches — WebSearch tool uses
 *
 * Props:
 *   researchItems  Array<{ tool, input, summary?, timestamp }>
 *   topicOutline   Array<{ title, type, decided }>
 */

import React, { useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area.jsx';

// Tool names that represent codebase access
const CODEBASE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'read_file', 'search_files', 'list_directory']);
// Tool names that represent web searches
const WEB_SEARCH_TOOLS = new Set(['WebSearch', 'web_search']);

// Chevron icon — down when expanded, right when collapsed
function Chevron({ expanded }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      style={{
        transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
        transition: 'transform 150ms ease',
        flexShrink: 0,
      }}
    >
      <path d="M3 2L7 5L3 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Check circle icon for decided topics
function CheckIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="5" cy="5" r="4" stroke="hsl(var(--accent))" strokeWidth="1.2" />
      <path d="M3 5l1.5 1.5L7 3.5" stroke="hsl(var(--accent))" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Open circle icon for undecided topics
function OpenCircleIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="5" cy="5" r="4" stroke="hsl(var(--muted-foreground))" strokeWidth="1.2" />
    </svg>
  );
}

// Collapsible section wrapper
function Section({ title, count, defaultExpanded, children }) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div className="border-b" style={{ borderColor: 'hsl(var(--sidebar-border))' }}>
      <button
        onClick={() => setExpanded(e => !e)}
        className="flex items-center gap-1.5 w-full px-3 py-2 text-left transition-colors hover:bg-sidebar-accent/30"
      >
        <Chevron expanded={expanded} />
        <span
          className="text-[10px] font-semibold uppercase tracking-wider flex-1"
          style={{ color: 'hsl(var(--muted-foreground))' }}
        >
          {title}
        </span>
        {count > 0 && (
          <span
            className="text-[9px] min-w-[14px] h-3.5 flex items-center justify-center rounded-full px-1 tabular-nums"
            style={{
              background: 'hsl(var(--accent) / 0.12)',
              color: 'hsl(var(--accent))',
            }}
          >
            {count}
          </span>
        )}
      </button>
      {expanded && (
        <div className="pb-1">
          {children}
        </div>
      )}
    </div>
  );
}

// Truncate a string to maxLen characters
function truncate(str, maxLen = 80) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

// Extract a display label from the tool input
function inputLabel(tool, input) {
  if (!input) return '';
  if (typeof input === 'string') return input;
  // input is likely an object — pick the most relevant field
  return input.path || input.pattern || input.query || input.file_path || JSON.stringify(input).slice(0, 60);
}

export default function ResearchTab({ researchItems = [], topicOutline = [] }) {
  const codebaseItems = researchItems.filter(r => CODEBASE_TOOLS.has(r.tool));
  const webItems = researchItems.filter(r => WEB_SEARCH_TOOLS.has(r.tool));

  // Most recent first
  const codebaseReversed = [...codebaseItems].reverse();
  const webReversed = [...webItems].reverse();

  return (
    <ScrollArea className="flex-1">
      <div>

        {/* Topic Outline */}
        <Section
          title="Topic Outline"
          count={topicOutline.length}
          defaultExpanded={topicOutline.length > 0}
        >
          {topicOutline.length === 0 ? (
            <p
              className="px-3 py-2 text-[10px]"
              style={{ color: 'hsl(var(--muted-foreground))' }}
            >
              No topics yet
            </p>
          ) : (
            <ul className="px-3 space-y-1 pt-0.5">
              {topicOutline.map((item, i) => (
                <li key={i} className="flex items-start gap-1.5 py-0.5">
                  <span className="mt-0.5">
                    {item.decided ? <CheckIcon /> : <OpenCircleIcon />}
                  </span>
                  <span
                    className="text-[11px] leading-snug"
                    style={{ color: item.decided ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))' }}
                  >
                    {item.title}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Codebase References */}
        <Section
          title="Codebase Refs"
          count={codebaseItems.length}
          defaultExpanded={codebaseItems.length > 0}
        >
          {codebaseItems.length === 0 ? (
            <p
              className="px-3 py-2 text-[10px]"
              style={{ color: 'hsl(var(--muted-foreground))' }}
            >
              No file references yet
            </p>
          ) : (
            <ul className="px-2 space-y-1 pt-0.5">
              {codebaseReversed.map((item, i) => (
                <li
                  key={i}
                  className="px-2 py-1.5 rounded-md"
                  style={{ background: 'hsl(var(--sidebar-accent) / 0.3)' }}
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className="text-[9px] font-medium uppercase tracking-wider px-1 rounded"
                      style={{
                        background: 'hsl(var(--accent) / 0.12)',
                        color: 'hsl(var(--accent))',
                      }}
                    >
                      {item.tool}
                    </span>
                    <span
                      className="text-[10px] font-mono leading-tight truncate flex-1"
                      style={{ color: 'hsl(var(--foreground))' }}
                      title={typeof item.input === 'string' ? item.input : JSON.stringify(item.input)}
                    >
                      {truncate(inputLabel(item.tool, item.input), 50)}
                    </span>
                  </div>
                  {item.summary && (
                    <p
                      className="text-[10px] leading-snug mt-1"
                      style={{ color: 'hsl(var(--muted-foreground))' }}
                    >
                      {truncate(item.summary, 100)}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Web Searches */}
        <Section
          title="Web Searches"
          count={webItems.length}
          defaultExpanded={webItems.length > 0}
        >
          {webItems.length === 0 ? (
            <p
              className="px-3 py-2 text-[10px]"
              style={{ color: 'hsl(var(--muted-foreground))' }}
            >
              No web searches yet
            </p>
          ) : (
            <ul className="px-2 space-y-1 pt-0.5">
              {webReversed.map((item, i) => (
                <li
                  key={i}
                  className="px-2 py-1.5 rounded-md"
                  style={{ background: 'hsl(var(--sidebar-accent) / 0.3)' }}
                >
                  <p
                    className="text-[10px] font-medium leading-snug"
                    style={{ color: 'hsl(var(--foreground))' }}
                  >
                    {truncate(inputLabel(item.tool, item.input), 80)}
                  </p>
                  {item.summary && (
                    <p
                      className="text-[10px] leading-snug mt-1"
                      style={{ color: 'hsl(var(--muted-foreground))' }}
                    >
                      {truncate(item.summary, 100)}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

      </div>
    </ScrollArea>
  );
}
