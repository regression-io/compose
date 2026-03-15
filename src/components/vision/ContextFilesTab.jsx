/**
 * ContextFilesTab — file list from the feature's docs folder.
 *
 * Fetches from /api/files, filters to docs/features/{featureCode}/.
 *
 * Props:
 *   featureCode {string}  feature code to determine folder path
 *   onOpenFile  {fn}      called with file path when a file is clicked
 */
import React, { useState, useEffect, useMemo } from 'react';
import { FileText, Folder } from 'lucide-react';

function formatBytes(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export default function ContextFilesTab({ featureCode, onOpenFile }) {
  const [allFiles, setAllFiles] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);

    fetch('/api/files', { signal: controller.signal })
      .then(r => r.json())
      .then(data => {
        if (controller.signal.aborted) return;
        setAllFiles(Array.isArray(data) ? data : data.files || []);
        setLoading(false);
      })
      .catch(err => {
        if (controller.signal.aborted) return;
        setAllFiles([]);
        setLoading(false);
      });

    return () => controller.abort();
  }, [featureCode]);

  const prefix = `docs/features/${featureCode}/`;

  const filtered = useMemo(() => {
    return allFiles.filter(f => {
      const path = typeof f === 'string' ? f : f.path || f.name || '';
      return path.startsWith(prefix);
    });
  }, [allFiles, prefix]);

  if (loading) {
    return (
      <div className="p-3 text-[11px] text-muted-foreground italic">
        Loading files...
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="p-3 flex flex-col items-center gap-2 text-muted-foreground">
        <Folder style={{ width: 20, height: 20, opacity: 0.5 }} />
        <span className="text-[11px] italic">No files in feature folder.</span>
      </div>
    );
  }

  return (
    <div className="p-2 space-y-0.5">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground px-1 mb-1">
        Files ({filtered.length})
      </p>
      {filtered.map((f, i) => {
        const path = typeof f === 'string' ? f : f.path || f.name || '';
        const name = path.split('/').pop();
        const size = typeof f === 'object' ? f.size : null;
        const modified = typeof f === 'object' ? f.modified || f.mtime : null;

        return (
          <button
            key={i}
            onClick={() => onOpenFile?.(path)}
            className="flex items-center gap-2 w-full px-2 py-1.5 text-left rounded hover:bg-accent/10 transition-colors"
          >
            <FileText className="h-3 w-3 shrink-0 text-accent" />
            <span className="text-xs text-foreground truncate flex-1">{name}</span>
            {size != null && (
              <span className="text-[9px] text-muted-foreground tabular-nums shrink-0">
                {formatBytes(size)}
              </span>
            )}
            {modified && (
              <span className="text-[9px] text-muted-foreground shrink-0">
                {relativeTime(modified)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
