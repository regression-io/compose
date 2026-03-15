import React, { useState, useMemo, useCallback, useContext } from 'react';
import { cn } from '@/lib/utils.js';
import { Badge } from '@/components/ui/badge.jsx';
import { Input } from '@/components/ui/input.jsx';
import { ScrollArea } from '@/components/ui/scroll-area.jsx';
import { ChevronRight, ChevronDown, Search, X, Plus } from 'lucide-react';
import { TYPE_COLORS, STATUS_COLORS } from './constants.js';
import ConfidenceDots from './ConfidenceDots.jsx';
import { VisionChangesContext } from './VisionChangesContext.js';

// ─── Filter presets ──────────────────────────────────────────────────────────

const STATUS_FILTERS = [
  { key: 'all',     label: 'All',     statuses: null },
  { key: 'active',  label: 'Active',  statuses: ['planned', 'ready', 'in_progress', 'review'] },
  { key: 'done',    label: 'Done',    statuses: ['complete'] },
  { key: 'blocked', label: 'Blocked', statuses: ['blocked', 'parked'] },
];

const TYPE_FILTERS = [
  { key: 'all',     label: 'All' },
  { key: 'feature', label: 'Feature' },
  { key: 'task',    label: 'Task' },
  { key: 'track',   label: 'Track' },
];

// ─── Toolbar button (matches GraphView FilterBtn) ───────────────────────────

function FilterBtn({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 11,
        padding: '2px 7px',
        borderRadius: 4,
        cursor: 'pointer',
        transition: 'all 0.15s',
        border: `1px solid ${active ? '#3b82f6' : '#334155'}`,
        background: active ? '#3b82f6' : '#1e293b',
        color: active ? '#fff' : '#94a3b8',
      }}
    >
      {children}
    </button>
  );
}

function TreeItem({ item, children, depth, selectedItemId, onSelect, onToggle, expandedIds }) {
  const hasChildren = children.length > 0;
  const isExpanded = expandedIds.has(item.id);
  const isSelected = selectedItemId === item.id;
  const typeColor = TYPE_COLORS[item.type] || TYPE_COLORS.task;
  const statusColor = STATUS_COLORS[item.status] || STATUS_COLORS.planned;
  const { newIds, changedIds } = useContext(VisionChangesContext);
  const isNew = newIds.has(item.id);
  const isChanged = changedIds.has(item.id);

  return (
    <div>
      <div
        data-item-id={item.id}
        onClick={() => onSelect(item.id)}
        className={cn(
          'flex items-center gap-1.5 py-1 px-2 cursor-pointer transition-colors rounded-md',
          'hover:bg-accent/5',
          isSelected && 'bg-accent/10',
          isNew && 'bg-green-500/5 border-l-2 border-l-green-500',
          isChanged && !isNew && 'bg-amber-500/5 border-l-2 border-l-amber-500',
        )}
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
      >
        {/* Expand toggle */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggle(item.id);
          }}
          className={cn(
            'shrink-0 w-4 h-4 flex items-center justify-center rounded',
            hasChildren ? 'text-muted-foreground hover:text-foreground' : 'invisible'
          )}
        >
          {hasChildren && (
            isExpanded
              ? <ChevronDown className="h-3.5 w-3.5" />
              : <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>

        {/* Status dot */}
        <div
          className="w-2 h-2 rounded-full shrink-0"
          style={{ background: statusColor }}
        />

        {/* Type badge */}
        <span
          className="text-[9px] uppercase tracking-wider shrink-0 w-12"
          style={{ color: typeColor }}
        >
          {item.type}
        </span>

        {/* Title */}
        <span className={cn(
          'text-sm text-foreground truncate flex-1',
          item.status === 'killed' && 'line-through opacity-50'
        )}>
          {item.title}
        </span>

        {/* Confidence */}
        <ConfidenceDots level={item.confidence || 0} />

        {/* Phase badge */}
        {item.phase && (
          <Badge variant="outline" className="text-[9px] px-1 py-0 h-3.5 shrink-0">
            {item.phase}
          </Badge>
        )}
      </div>

      {/* Children */}
      {hasChildren && isExpanded && (
        <div>
          {children.map(child => (
            <TreeItem
              key={child.id}
              item={child}
              children={child._children || []}
              depth={depth + 1}
              selectedItemId={selectedItemId}
              onSelect={onSelect}
              onToggle={onToggle}
              expandedIds={expandedIds}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function TreeView({ items, connections, selectedItemId, onSelect, onCreate }) {
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');

  const onToggle = useCallback((id) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Filter items by status, type, and search query
  const searchedItems = useMemo(() => {
    let result = items;

    // Status filter
    const statusPreset = STATUS_FILTERS.find(f => f.key === statusFilter);
    if (statusPreset?.statuses) {
      result = result.filter(i => statusPreset.statuses.includes(i.status || 'planned'));
    }

    // Type filter
    if (typeFilter !== 'all') {
      result = result.filter(i => i.type === typeFilter);
    }

    // Search filter
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(i =>
        (i.title || '').toLowerCase().includes(q) ||
        (i.description || '').toLowerCase().includes(q) ||
        (i.type || '').toLowerCase().includes(q) ||
        (i.phase || '').toLowerCase().includes(q)
      );
    }

    return result;
  }, [items, searchQuery, statusFilter, typeFilter]);

  // Build tree from connections:
  //   informs:  A informs B  → B.parent = A  (child consumes parent's output)
  //   supports: A supports B → A.parent = B  (evidence sits under what it supports)
  //   blocks:   A blocks B   → A.parent = B  (blocker is sub-problem of the blocked)
  const tree = useMemo(() => {
    const itemIds = new Set(searchedItems.map(i => i.id));
    const byId = new Map();
    for (const item of searchedItems) {
      byId.set(item.id, { ...item, _children: [] });
    }

    // Derive parentId from connections (first match wins)
    const parentOf = new Map();
    for (const conn of connections) {
      if (!itemIds.has(conn.fromId) || !itemIds.has(conn.toId)) continue;

      if (conn.type === 'informs') {
        // A informs B → B is child of A
        if (!parentOf.has(conn.toId)) parentOf.set(conn.toId, conn.fromId);
      } else if (conn.type === 'supports') {
        // A supports B → A is child of B
        if (!parentOf.has(conn.fromId)) parentOf.set(conn.fromId, conn.toId);
      } else if (conn.type === 'blocks') {
        // A blocks B → A is child of B
        if (!parentOf.has(conn.fromId)) parentOf.set(conn.fromId, conn.toId);
      }
    }

    // Also use parentId field if present (explicit hierarchy takes priority)
    for (const item of items) {
      if (item.parentId && byId.has(item.parentId)) {
        parentOf.set(item.id, item.parentId);
      }
    }

    // Detect cycles: walk up from each node, if we revisit → break it
    for (const [childId] of parentOf) {
      const visited = new Set();
      let cur = childId;
      while (cur && parentOf.has(cur)) {
        if (visited.has(cur)) { parentOf.delete(cur); break; }
        visited.add(cur);
        cur = parentOf.get(cur);
      }
    }

    // Build tree
    const roots = [];
    for (const item of byId.values()) {
      const pid = parentOf.get(item.id);
      if (pid && byId.has(pid)) {
        byId.get(pid)._children.push(item);
      } else {
        roots.push(item);
      }
    }

    // Sort children by confidence ascending (lowest first = needs attention)
    const sortChildren = (nodes) => {
      nodes.sort((a, b) => (a.confidence || 0) - (b.confidence || 0));
      for (const node of nodes) {
        if (node._children.length > 0) sortChildren(node._children);
      }
    };
    sortChildren(roots);

    return roots;
  }, [searchedItems, connections]);

  // Auto-expand roots on first render, expand all when searching
  React.useEffect(() => {
    if (searchQuery) {
      // Expand everything when searching so matches are visible
      const all = new Set();
      const walk = (nodes) => {
        for (const n of nodes) {
          if (n._children.length > 0) { all.add(n.id); walk(n._children); }
        }
      };
      walk(tree);
      setExpandedIds(all);
    } else if (expandedIds.size === 0 && tree.length > 0) {
      setExpandedIds(new Set(tree.map(r => r.id)));
    }
  }, [tree, searchQuery]);

  // COMP-UX-1e: Scroll to selected item and expand its parent chain
  React.useEffect(() => {
    if (!selectedItemId || tree.length === 0) return;
    // Find ancestors to expand
    const ancestors = [];
    const findPath = (nodes, target) => {
      for (const n of nodes) {
        if (n.id === target) return true;
        if (n._children.length > 0 && findPath(n._children, target)) {
          ancestors.push(n.id);
          return true;
        }
      }
      return false;
    };
    findPath(tree, selectedItemId);
    if (ancestors.length > 0) {
      setExpandedIds(prev => {
        const next = new Set(prev);
        for (const id of ancestors) next.add(id);
        return next;
      });
    }
    // Scroll after a tick so the DOM has expanded
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-item-id="${selectedItemId}"]`);
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }, [selectedItemId, tree]);

  const expandAll = useCallback(() => {
    const all = new Set();
    const walk = (nodes) => {
      for (const n of nodes) {
        if (n._children.length > 0) {
          all.add(n.id);
          walk(n._children);
        }
      }
    };
    walk(tree);
    setExpandedIds(all);
  }, [tree]);

  const collapseAll = useCallback(() => {
    setExpandedIds(new Set());
  }, []);

  // Count items with children vs orphans
  const withChildren = tree.filter(r => r._children.length > 0).length;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        {/* Search */}
        <div className="relative flex-1 max-w-[180px]">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search items..."
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

        {/* Status filter */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground mr-0.5">Status:</span>
          {STATUS_FILTERS.map(f => (
            <FilterBtn key={f.key} active={statusFilter === f.key} onClick={() => setStatusFilter(f.key)}>
              {f.label}
            </FilterBtn>
          ))}
        </div>

        {/* Type filter */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground mr-0.5">Type:</span>
          {TYPE_FILTERS.map(f => (
            <FilterBtn key={f.key} active={typeFilter === f.key} onClick={() => setTypeFilter(f.key)}>
              {f.label}
            </FilterBtn>
          ))}
        </div>

        {/* Count */}
        <span className="text-[10px] text-muted-foreground">
          {searchedItems.length}{(searchQuery || statusFilter !== 'all' || typeFilter !== 'all') ? `/${items.length}` : ''}
        </span>

        <div className="flex-1" />

        {/* Expand/Collapse */}
        <button
          onClick={expandAll}
          className="text-[10px] px-1.5 py-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/10 transition-colors"
        >
          Expand
        </button>
        <button
          onClick={collapseAll}
          className="text-[10px] px-1.5 py-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/10 transition-colors"
        >
          Collapse
        </button>

        {/* Create button */}
        {onCreate && (
          <button
            onClick={onCreate}
            title="Create item"
            style={{
              width: 24,
              height: 24,
              borderRadius: 4,
              border: '1px solid #334155',
              background: '#1e293b',
              color: '#94a3b8',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.15s',
            }}
            className="hover:border-blue-500 hover:text-white"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Tree */}
      <ScrollArea className="flex-1">
        <div className="py-1">
          {tree.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              No items to display
            </div>
          ) : (
            tree.map(item => (
              <TreeItem
                key={item.id}
                item={item}
                children={item._children}
                depth={0}
                selectedItemId={selectedItemId}
                onSelect={onSelect}
                onToggle={onToggle}
                expandedIds={expandedIds}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
