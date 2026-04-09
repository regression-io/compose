/**
 * DesignDocPanel — renders the live draft design document in the context panel
 * when the design view is active.
 *
 * COMP-DESIGN-1c: Live Design Doc
 *
 * Two modes:
 *   Preview (default) — rendered markdown via react-markdown
 *   Edit — raw textarea with monospace font
 *
 * Props: none — reads everything from useDesignStore.
 */
import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useDesignStore } from '../vision/useDesignStore.js';
import { useShallow } from 'zustand/react/shallow';

export default function DesignDocPanel() {
  const { draftDoc, docManuallyEdited, updateDraftDoc, resetDocEdited } = useDesignStore(
    useShallow(s => ({
      draftDoc: s.draftDoc,
      docManuallyEdited: s.docManuallyEdited,
      updateDraftDoc: s.updateDraftDoc,
      resetDocEdited: s.resetDocEdited,
    }))
  );

  const [editing, setEditing] = useState(false);

  const isEmpty = !draftDoc;

  // Status badge text and style
  let statusLabel = 'empty';
  let statusStyle = { color: 'hsl(var(--muted-foreground))' };
  if (docManuallyEdited) {
    statusLabel = 'edited';
    statusStyle = { color: 'hsl(var(--primary))' };
  } else if (!isEmpty) {
    statusLabel = 'draft';
    statusStyle = { color: 'hsl(var(--muted-foreground))' };
  }

  return (
    <div
      className="h-full flex flex-col"
      style={{ fontFamily: 'inherit' }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2 shrink-0"
        style={{ borderBottom: '1px solid hsl(var(--border))' }}
      >
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
            Design Document
          </span>
          <span
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{
              ...statusStyle,
              background: 'hsl(var(--muted))',
            }}
          >
            {statusLabel}
          </span>
        </div>
        {!isEmpty && (
          <button
            onClick={() => setEditing(v => !v)}
            className="text-[11px] px-2 py-1 rounded transition-colors"
            style={{
              color: 'hsl(var(--muted-foreground))',
              background: editing ? 'hsl(var(--accent))' : 'transparent',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = 'hsl(var(--foreground))'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'hsl(var(--muted-foreground))'; }}
          >
            {editing ? 'Preview' : 'Edit'}
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-auto">
        {isEmpty ? (
          <div
            className="p-4 text-[12px] italic"
            style={{ color: 'hsl(var(--muted-foreground))' }}
          >
            Start the design conversation to see the document build here.
          </div>
        ) : editing ? (
          <div className="h-full flex flex-col p-2 gap-2">
            <textarea
              className="flex-1 min-h-0 w-full resize-none rounded p-2 text-[12px]"
              style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                background: 'hsl(var(--background))',
                color: 'hsl(var(--foreground))',
                border: '1px solid hsl(var(--border))',
                outline: 'none',
              }}
              value={draftDoc}
              onChange={e => updateDraftDoc(e.target.value)}
              spellCheck={false}
            />
            <button
              onClick={() => {
                resetDocEdited();
                setEditing(false);
              }}
              className="shrink-0 text-[11px] px-3 py-1.5 rounded transition-colors self-start"
              style={{
                color: 'hsl(var(--muted-foreground))',
                border: '1px solid hsl(var(--border))',
                background: 'transparent',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.color = 'hsl(var(--foreground))';
                e.currentTarget.style.borderColor = 'hsl(var(--foreground))';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.color = 'hsl(var(--muted-foreground))';
                e.currentTarget.style.borderColor = 'hsl(var(--border))';
              }}
            >
              Reset to auto-generated
            </button>
          </div>
        ) : (
          <div
            className="p-4 prose prose-sm max-w-none"
            style={{
              color: 'hsl(var(--foreground))',
              '--tw-prose-body': 'hsl(var(--foreground))',
              '--tw-prose-headings': 'hsl(var(--foreground))',
              '--tw-prose-code': 'hsl(var(--foreground))',
              '--tw-prose-bold': 'hsl(var(--foreground))',
              '--tw-prose-links': 'hsl(var(--primary))',
              fontSize: '12px',
            }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {draftDoc}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
