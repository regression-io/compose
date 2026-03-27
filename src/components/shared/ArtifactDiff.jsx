import React, { useState, useMemo } from 'react';
import { diffLines } from 'diff';

export default function ArtifactDiff({ oldText, newText }) {
  const [expanded, setExpanded] = useState(false);

  const { parts, addCount, removeCount } = useMemo(() => {
    if (!oldText || !newText) return { parts: [], addCount: 0, removeCount: 0 };
    const diff = diffLines(oldText, newText);
    let adds = 0, removes = 0;
    for (const part of diff) {
      const lines = part.value.split('\n').filter(l => l !== '').length;
      if (part.added) adds += lines;
      if (part.removed) removes += lines;
    }
    return { parts: diff, addCount: adds, removeCount: removes };
  }, [oldText, newText]);

  if (!oldText || !newText) {
    return null;
  }

  if (addCount === 0 && removeCount === 0) {
    return (
      <span className="text-[9px] text-muted-foreground/50 italic">No changes</span>
    );
  }

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="text-[9px] text-blue-400 hover:text-blue-300 transition-colors"
      >
        Show changes (+{addCount} -{removeCount})
      </button>
    );
  }

  return (
    <div className="mt-1.5">
      <button
        onClick={() => setExpanded(false)}
        className="text-[9px] text-blue-400 hover:text-blue-300 transition-colors mb-1"
      >
        Hide changes
      </button>
      <div className="rounded border border-border bg-muted/30 overflow-x-auto max-h-[300px] overflow-y-auto">
        <pre className="text-[10px] font-mono leading-relaxed">
          {parts.map((part, i) => {
            const lines = part.value.split('\n');
            // Remove trailing empty string from split
            if (lines[lines.length - 1] === '') lines.pop();
            return lines.map((line, j) => (
              <div
                key={`${i}-${j}`}
                className={
                  part.added ? 'bg-emerald-500/15 text-emerald-300' :
                  part.removed ? 'bg-red-500/15 text-red-300 line-through' :
                  'text-muted-foreground'
                }
                style={{ padding: '0 8px' }}
              >
                <span className="inline-block w-3 text-muted-foreground/40 select-none mr-1">
                  {part.added ? '+' : part.removed ? '-' : ' '}
                </span>
                {line || ' '}
              </div>
            ));
          })}
        </pre>
      </div>
    </div>
  );
}
