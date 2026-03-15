import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronRight, ChevronDown, FileText, Folder, FolderOpen, Search, X, ArrowLeft, Pencil, Eye, Save } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { Input } from '@/components/ui/input.jsx';
import { ScrollArea } from '@/components/ui/scroll-area.jsx';

/*
 * DocsView — hierarchical file tree + markdown preview split pane.
 *
 * Left: full directory tree built from /api/files
 * Right: markdown preview of selected file via /api/file?path=...
 * Tracks which files are referenced by board items.
 */

// ---------------------------------------------------------------------------
// Tree builder
// ---------------------------------------------------------------------------

function buildFileTree(files) {
  const root = { name: '', children: new Map(), files: [] };

  for (const file of files) {
    const parts = file.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.children.has(parts[i])) {
        node.children.set(parts[i], { name: parts[i], children: new Map(), files: [] });
      }
      node = node.children.get(parts[i]);
    }
    node.files.push({ name: parts[parts.length - 1], path: file });
  }

  return root;
}

function filterTree(node, query) {
  if (!query) return node;
  const q = query.toLowerCase();

  const filtered = {
    name: node.name,
    children: new Map(),
    files: node.files.filter(f => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)),
  };

  for (const [key, child] of node.children) {
    const fc = filterTree(child, query);
    if (fc.files.length > 0 || fc.children.size > 0) {
      filtered.children.set(key, fc);
    }
  }

  return filtered;
}

function countFiles(node) {
  let count = node.files.length;
  for (const child of node.children.values()) count += countFiles(child);
  return count;
}

// ---------------------------------------------------------------------------
// Tree node components
// ---------------------------------------------------------------------------

function DirNode({ node, depth, expandedDirs, onToggleDir, selectedFile, onSelectFile, trackedPaths, searchQuery }) {
  const dirPath = getDirPath(node, depth);
  const isExpanded = expandedDirs.has(dirPath) || !!searchQuery;
  const fileCount = countFiles(node);

  return (
    <div>
      <button
        onClick={() => onToggleDir(dirPath)}
        className="flex items-center gap-1.5 w-full px-2 py-1 text-left hover:bg-muted/30 transition-colors rounded-sm"
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
      >
        {isExpanded
          ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-accent" />
          : <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        }
        <span className="text-xs font-medium text-foreground truncate">{node.name}</span>
        <span className="text-[10px] text-muted-foreground ml-auto tabular-nums shrink-0">{fileCount}</span>
      </button>
      {isExpanded && (
        <>
          {[...node.children.values()]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(child => (
              <DirNode
                key={child.name}
                node={child}
                depth={depth + 1}
                expandedDirs={expandedDirs}
                onToggleDir={onToggleDir}
                selectedFile={selectedFile}
                onSelectFile={onSelectFile}
                trackedPaths={trackedPaths}
                searchQuery={searchQuery}
              />
            ))}
          {node.files
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(file => (
              <FileNode
                key={file.path}
                file={file}
                depth={depth + 1}
                isSelected={selectedFile === file.path}
                isTracked={trackedPaths.has(file.path)}
                onSelect={() => onSelectFile(file.path)}
              />
            ))}
        </>
      )}
    </div>
  );
}

function FileNode({ file, depth, isSelected, isTracked, onSelect }) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        'flex items-center gap-1.5 w-full px-2 py-1 text-left transition-colors rounded-sm',
        isSelected ? 'bg-accent/10 text-accent' : 'hover:bg-muted/30',
      )}
      style={{ paddingLeft: `${depth * 16 + 4}px` }}
    >
      <FileText className="h-3 w-3 shrink-0" style={{ color: isTracked ? 'hsl(var(--primary))' : undefined }} />
      <span className={cn('text-xs truncate', isSelected ? 'text-accent font-medium' : 'text-foreground')}>
        {file.name}
      </span>
      {isTracked && (
        <div className="w-1.5 h-1.5 rounded-full shrink-0 ml-auto" style={{ background: 'hsl(var(--primary))' }} />
      )}
    </button>
  );
}

function getDirPath(node, depth) {
  // Use the node name as a simple key — works because names are unique per level
  return `dir-${depth}-${node.name}`;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function DocsView({ items, selectedFile: externalSelectedFile, onSelectedFileChange, previousView, onBack }) {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [internalSelectedFile, setInternalSelectedFile] = useState(null);

  // External navigation takes priority
  const selectedFile = externalSelectedFile || internalSelectedFile;
  const setSelectedFile = (f) => {
    setInternalSelectedFile(f);
    if (onSelectedFileChange) onSelectedFileChange(f);
  };
  const [fileContent, setFileContent] = useState(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [savedContent, setSavedContent] = useState(null);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedDirs, setExpandedDirs] = useState(() => new Set(['dir-0-docs']));
  const [treeWidth, setTreeWidth] = useState(() => {
    try { return parseInt(localStorage.getItem('compose:docsTreeWidth'), 10) || 260; } catch { return 260; }
  });
  const dragging = useRef(false);
  const containerRef = useRef(null);

  const onDividerMouseDown = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;
    const onMove = (ev) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const next = Math.min(Math.max(ev.clientX - rect.left, 160), 500);
      setTreeWidth(next);
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // Persist
      setTreeWidth(w => { localStorage.setItem('compose:docsTreeWidth', w); return w; });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const isModified = editMode && editContent !== savedContent;

  const handleSave = useCallback(async () => {
    if (!selectedFile || saving) return;
    setSaving(true);
    try {
      const res = await fetch('/api/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedFile, content: editContent }),
      });
      if (res.ok) {
        setSavedContent(editContent);
        setFileContent(editContent);
      }
    } catch { /* ignore */ }
    setSaving(false);
  }, [selectedFile, editContent, saving]);

  const toggleEditMode = useCallback(() => {
    setEditMode(prev => {
      if (!prev && fileContent !== null) {
        setEditContent(fileContent);
        setSavedContent(fileContent);
      }
      return !prev;
    });
  }, [fileContent]);

  // Cmd+S keyboard shortcut in edit mode
  useEffect(() => {
    if (!editMode) return;
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editMode, handleSave]);

  // Reset edit mode when file changes
  useEffect(() => {
    setEditMode(false);
    setEditContent('');
    setSavedContent(null);
  }, [selectedFile]);

  // Fetch file list
  useEffect(() => {
    fetch('/api/files')
      .then(r => r.json())
      .then(data => {
        setFiles(data.files || []);
        setLoading(false);
        // Auto-expand first two levels
        const dirs = new Set(['dir-0-docs']);
        for (const f of (data.files || [])) {
          const parts = f.split('/');
          if (parts.length > 1) dirs.add(`dir-1-${parts[1]}`);
        }
        setExpandedDirs(dirs);
      })
      .catch(() => setLoading(false));
  }, []);

  // Fetch file content when selected
  useEffect(() => {
    if (!selectedFile) { setFileContent(null); return; }
    setContentLoading(true);
    fetch(`/api/file?path=${encodeURIComponent(selectedFile)}`)
      .then(r => r.json())
      .then(data => { setFileContent(data.content ?? null); setContentLoading(false); })
      .catch(() => { setFileContent(null); setContentLoading(false); });
  }, [selectedFile]);

  // Tracked paths
  const trackedPaths = useMemo(() => {
    const paths = new Set();
    const fileName = (p) => p.split('/').pop();
    for (const item of items) {
      const text = `${item.title || ''} ${item.description || ''} ${item.planLink || ''}`.toLowerCase();
      for (const file of files) {
        if (text.includes(file.toLowerCase()) || text.includes(fileName(file).replace('.md', '').toLowerCase())) {
          paths.add(file);
        }
      }
    }
    return paths;
  }, [items, files]);

  const tree = useMemo(() => buildFileTree(files), [files]);
  const filteredTree = useMemo(() => filterTree(tree, searchQuery), [tree, searchQuery]);

  const onToggleDir = useCallback((dirPath) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  }, []);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-sm text-muted-foreground">Loading docs...</span>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 flex min-h-0">
      {/* Left: file tree */}
      <div className="shrink-0 flex flex-col min-h-0" style={{ width: `${treeWidth}px` }}>
        {/* Search */}
        <div className="px-2 py-2 shrink-0" style={{ borderBottom: '1px solid hsl(var(--border))' }}>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search files..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-7 pl-7 pr-7 text-xs"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <div className="flex items-center justify-between mt-1.5 px-1">
            <span className="text-[10px] text-muted-foreground">{files.length} files</span>
            <span className="text-[10px] text-muted-foreground">
              {files.length - trackedPaths.size} untracked
            </span>
          </div>
        </div>

        {/* Tree */}
        <ScrollArea className="flex-1">
          <div className="py-1">
            {[...filteredTree.children.values()]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map(child => (
                <DirNode
                  key={child.name}
                  node={child}
                  depth={0}
                  expandedDirs={expandedDirs}
                  onToggleDir={onToggleDir}
                  selectedFile={selectedFile}
                  onSelectFile={setSelectedFile}
                  trackedPaths={trackedPaths}
                  searchQuery={searchQuery}
                />
              ))}
            {filteredTree.files
              .sort((a, b) => a.name.localeCompare(b.name))
              .map(file => (
                <FileNode
                  key={file.path}
                  file={file}
                  depth={0}
                  isSelected={selectedFile === file.path}
                  isTracked={trackedPaths.has(file.path)}
                  onSelect={() => setSelectedFile(file.path)}
                />
              ))}
          </div>
        </ScrollArea>
      </div>

      {/* Resize divider */}
      <div
        onMouseDown={onDividerMouseDown}
        className="w-1 shrink-0 cursor-col-resize hover:bg-accent/30 active:bg-accent/50 transition-colors"
        style={{ background: 'hsl(var(--border))' }}
      />

      {/* Right: preview */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {selectedFile ? (
          <>
            <div className="px-4 py-2 shrink-0 flex items-center gap-2" style={{ borderBottom: '1px solid hsl(var(--border))' }}>
              {previousView && onBack && (
                <button
                  onClick={onBack}
                  className="flex items-center gap-1 text-xs text-accent hover:text-accent/80 transition-colors shrink-0"
                  title={`Back to ${previousView}`}
                >
                  <ArrowLeft className="h-3 w-3" />
                  Back to {previousView.charAt(0).toUpperCase() + previousView.slice(1)}
                </button>
              )}
              <span className="text-xs text-muted-foreground truncate flex-1">{selectedFile}</span>
              {isModified && (
                <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ color: 'hsl(var(--accent))', background: 'hsl(var(--accent) / 0.1)' }}>
                  modified
                </span>
              )}
              {trackedPaths.has(selectedFile) && (
                <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: 'hsl(var(--primary))', background: 'hsl(var(--primary) / 0.1)' }}>
                  tracked
                </span>
              )}
              {editMode && (
                <button
                  onClick={handleSave}
                  disabled={saving || !isModified}
                  className={cn(
                    'flex items-center gap-1 text-xs px-2 py-0.5 rounded transition-colors',
                    isModified
                      ? 'bg-accent text-accent-foreground hover:bg-accent/80'
                      : 'bg-muted text-muted-foreground cursor-default',
                  )}
                  title="Save (Cmd+S)"
                >
                  <Save className="h-3 w-3" />
                  {saving ? 'Saving...' : 'Save'}
                </button>
              )}
              <button
                onClick={toggleEditMode}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded hover:bg-muted/50"
                title={editMode ? 'Preview' : 'Edit'}
                disabled={fileContent === null}
              >
                {editMode ? <Eye className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
              </button>
            </div>
            {contentLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <span className="text-sm text-muted-foreground">Loading...</span>
              </div>
            ) : fileContent !== null && editMode ? (
              <textarea
                ref={textareaRef}
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="flex-1 w-full resize-none border-0 outline-none px-4 py-3 text-sm"
                style={{
                  fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
                  background: 'hsl(var(--background))',
                  color: 'hsl(var(--foreground))',
                  tabSize: 2,
                }}
                spellCheck={false}
              />
            ) : fileContent !== null ? (
              <ScrollArea className="flex-1">
                <div className="px-6 py-4 max-w-3xl">
                  <article className="prose prose-sm prose-invert max-w-none
                    prose-headings:text-foreground prose-p:text-muted-foreground
                    prose-a:text-accent prose-strong:text-foreground
                    prose-code:text-accent prose-code:bg-muted prose-code:px-1 prose-code:rounded
                    prose-pre:bg-muted prose-pre:border prose-pre:border-border
                    prose-li:text-muted-foreground prose-table:text-xs
                    prose-th:text-foreground prose-td:text-muted-foreground
                    prose-hr:border-border">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {fileContent}
                    </ReactMarkdown>
                  </article>
                </div>
              </ScrollArea>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <span className="text-sm text-muted-foreground">Could not load file</span>
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <FileText className="h-8 w-8 mx-auto mb-2 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">Select a file to preview</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Markdown files from the project docs/ directory</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
