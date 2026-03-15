import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import cytoscape from 'cytoscape';
import cytoscapeDagre from 'cytoscape-dagre';
import { TYPE_COLORS, PHASE_LABELS } from './constants.js';
import { BUILD_STATES, BUILD_STATE_COLORS } from './graphOpsOverlays.js';

try { cytoscape.use(cytoscapeDagre); } catch (e) { /* already registered */ }

// ─── Constants ──────────────────────────────────────────────────────────────

const STATUS_HEX = {
  planned:     '#64748b',
  ready:       '#0ea5e9',
  in_progress: '#3b82f6',
  review:      '#f59e0b',
  complete:    '#22c55e',
  blocked:     '#ef4444',
  parked:      '#475569',
  killed:      '#1e293b',
};

const TYPE_BG = Object.fromEntries(
  Object.entries(TYPE_COLORS).map(([k, hex]) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const bg = [15, 23, 42];
    const mix = 0.15;
    const c = [
      Math.round(bg[0] * (1 - mix) + r * mix),
      Math.round(bg[1] * (1 - mix) + g * mix),
      Math.round(bg[2] * (1 - mix) + b * mix),
    ];
    return [k, `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`];
  })
);

const CONF_BORDER = [1, 1.5, 2, 2.5, 3];

const EDGE_CONFIG = {
  informs:     { color: '#64748b', style: 'solid' },
  supports:    { color: '#22c55e', style: 'solid' },
  blocks:      { color: '#ef4444', style: 'solid' },
  contradicts: { color: '#f472b6', style: 'dashed' },
  implements:  { color: '#a78bfa', style: 'solid' },
};

const EDGE_FILTER_TYPES = ['blocks', 'informs', 'supports', 'implements'];

const STATUS_FILTERS = [
  { key: 'all',      label: 'All',     statuses: null },
  { key: 'active',   label: 'Active',  statuses: ['planned', 'ready', 'in_progress', 'review'] },
  { key: 'complete', label: 'Done',    statuses: ['complete'] },
  { key: 'blocked',  label: 'Blocked', statuses: ['blocked', 'parked'] },
];

const TRACK_COLORS = {
  knowledge: '#0ea5e9', distribution: '#10b981', governance: '#a855f7',
  agent: '#f59e0b', worker: '#ef4444', platform: '#ec4899',
  developer: '#f97316', async: '#6b7280', standalone: '#64748b',
  feature: '#3b82f6', other: '#475569', task: '#64748b',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function getTrack(item) {
  const match = (item.description || '').match(/Track:\s*(\w+)/i);
  return match ? match[1].toLowerCase() : item.type || 'other';
}

function getDisplayName(item) {
  const lines = (item.description || '').split('\n').filter(Boolean);
  for (const line of lines) {
    if (line.match(/^(Track|Priority):/i)) continue;
    return line.length > 20 ? line.slice(0, 20) + '\u2026' : line;
  }
  return item.title || '';
}

function buildElements(items, connections) {
  const elements = [];
  const itemIds = new Set(items.map(i => i.id));

  // Compound parent nodes by track — sorted by priority
  // Priority: blocked count (desc) → active count (desc) → total (desc) → name
  const trackSet = [...new Set(items.map(i => getTrack(i)).filter(Boolean))];
  const trackPriority = trackSet.map(track => {
    const trackItems = items.filter(i => getTrack(i) === track);
    const blocked = trackItems.filter(i => ['blocked', 'parked'].includes(i.status)).length;
    const active = trackItems.filter(i => ['in_progress', 'review', 'ready'].includes(i.status)).length;
    const planned = trackItems.filter(i => i.status === 'planned').length;
    return { track, blocked, active, planned, total: trackItems.length };
  });
  trackPriority.sort((a, b) =>
    (b.active - a.active) || (b.total - a.total) || (b.blocked - a.blocked) || a.track.localeCompare(b.track)
  );
  const sortedTracks = trackPriority.map(t => t.track);

  for (const track of sortedTracks) {
    const color = TRACK_COLORS[track] || '#475569';
    elements.push({
      data: {
        id: `track-${track}`,
        label: track.charAt(0).toUpperCase() + track.slice(1),
        isGroup: true,
        groupType: track,
        trackColor: color,
      },
    });
  }

  // Invisible edges between consecutive tracks to enforce ordering in dagre
  for (let i = 0; i < sortedTracks.length - 1; i++) {
    elements.push({
      data: {
        id: `_track-order-${i}`,
        source: `track-${sortedTracks[i]}`,
        target: `track-${sortedTracks[i + 1]}`,
      },
      classes: 'track-order',
    });
  }

  // Item nodes
  for (const item of items) {
    const code = item.title || item.slug || item.id.slice(0, 8);
    const name = getDisplayName(item);
    const label = name && name !== code && !name.toLowerCase().startsWith(code.toLowerCase())
      ? `${code}\n${name}` : code;
    const track = getTrack(item);

    elements.push({
      data: {
        id: item.id, label,
        itemType: item.type || 'task',
        status: item.status || 'planned',
        phase: item.phase || 'vision',
        confidence: item.confidence ?? 0,
        title: item.title, description: item.description,
        slug: item.slug || code, track,
        parent: `track-${track}`,
      },
    });
  }

  // Edges
  for (const conn of connections) {
    if (!itemIds.has(conn.fromId) || !itemIds.has(conn.toId)) continue;
    let source, target;
    if (conn.type === 'supports' || conn.type === 'blocks') {
      source = conn.toId; target = conn.fromId;
    } else {
      source = conn.fromId; target = conn.toId;
    }
    const cfg = EDGE_CONFIG[conn.type] || EDGE_CONFIG.informs;
    elements.push({
      data: {
        id: conn.id || `${conn.fromId}-${conn.toId}`,
        source, target, edgeType: conn.type,
        edgeColor: cfg.color, edgeStyle: cfg.style,
      },
    });
  }
  return elements;
}

function buildStylesheet() {
  return [
    // Track compound nodes
    {
      selector: '[?isGroup]',
      style: {
        'label': 'data(label)', 'text-valign': 'top', 'text-halign': 'center',
        'font-size': '10px', 'font-weight': 600, 'color': '#94a3b8',
        'text-transform': 'uppercase', 'letter-spacing': '0.06em',
        'background-color': '#1a2537',
        'border-width': 1, 'border-color': '#283548', 'border-style': 'solid',
        'padding': '18px', 'text-margin-y': 0,
      },
    },
    // Item nodes
    {
      selector: 'node[status]',
      style: {
        'label': 'data(label)', 'text-valign': 'center', 'text-halign': 'center',
        'font-size': '9px', 'font-family': 'ui-monospace, "SF Mono", monospace',
        'font-weight': 500, 'color': '#e2e8f0',
        'text-wrap': 'wrap', 'text-max-width': '100px',
        'width': '140px', 'height': '32px', 'shape': 'round-rectangle',
        'background-color': '#1e293b',
        'border-style': 'solid', 'border-width': 2, 'border-color': '#3b82f6',
        'shadow-color': '#3b82f6', 'shadow-opacity': 0.3,
        'shadow-offset-x': 0, 'shadow-offset-y': 0, 'shadow-blur': 2,
      },
    },
    ...Object.entries(STATUS_HEX).map(([status, color]) => ({
      selector: `node[status="${status}"]`,
      style: {
        'border-color': color, 'shadow-color': color,
        ...(status === 'parked' || status === 'killed' ? { opacity: 0.7 } : {}),
      },
    })),
    ...Object.entries(TYPE_BG).map(([type, bg]) => ({
      selector: `node[itemType="${type}"]`, style: { 'background-color': bg },
    })),
    ...CONF_BORDER.map((w, i) => ({
      selector: `node[confidence=${i}]`,
      style: { 'border-width': w, 'shadow-blur': 2 + (i * 2) },
    })),
    {
      selector: 'node:selected',
      style: {
        'background-color': '#1e3a5f', 'border-width': 3, 'border-color': '#60a5fa',
        'shadow-color': '#60a5fa', 'shadow-opacity': 0.5, 'shadow-blur': 12,
      },
    },
    {
      selector: 'edge',
      style: {
        'width': 1.5, 'line-color': 'data(edgeColor)',
        'target-arrow-color': 'data(edgeColor)', 'target-arrow-shape': 'vee',
        'arrow-scale': 0.7, 'curve-style': 'bezier', 'opacity': 0.6,
      },
    },
    { selector: 'edge[edgeStyle="dashed"]', style: { 'line-style': 'dashed', 'line-dash-pattern': [6, 3], 'target-arrow-shape': 'diamond' } },
    { selector: 'edge[edgeType="blocks"]', style: { 'target-arrow-shape': 'tee' } },
    { selector: '.track-order', style: { 'opacity': 0, 'width': 0, 'target-arrow-shape': 'none' } },
    { selector: '.dimmed', style: { opacity: 0.12 } },
    { selector: '.highlighted', style: { 'border-width': 3, 'border-color': '#60a5fa' } },
    // COMP-UX-1c: Build state overlay styles
    { selector: '.build-building', style: { 'border-color': '#3b82f6', 'border-width': 3, 'shadow-color': '#3b82f6', 'shadow-opacity': 0.6, 'shadow-blur': 12 } },
    { selector: '.build-gate-pending', style: { 'border-color': '#f59e0b', 'border-width': 3, 'shadow-color': '#f59e0b', 'shadow-opacity': 0.5, 'shadow-blur': 8 } },
    { selector: '.build-blocked-downstream', style: { 'opacity': 0.35, 'border-color': '#94a3b8' } },
    { selector: '.build-error', style: { 'border-color': '#ef4444', 'border-width': 3, 'shadow-color': '#ef4444', 'shadow-opacity': 0.5, 'shadow-blur': 8 } },
  ];
}

// ─── Tooltip ─────────────────────────────────────────────────────────────────

function Tooltip({ data }) {
  if (!data) return null;
  const { x, y, item } = data;
  const statusColor = STATUS_HEX[item.status] || STATUS_HEX.planned;
  const typeColor = TYPE_COLORS[item.itemType] || '#94a3b8';
  const left = x + 300 > window.innerWidth ? x - 294 : x + 14;
  const top = Math.min(y - 10, window.innerHeight - 200);

  return (
    <div style={{
      position: 'fixed', left, top, zIndex: 9999, pointerEvents: 'none', maxWidth: 280,
      background: '#1e293b', border: '1px solid #475569',
      borderRadius: 8, padding: '10px 13px', fontSize: 12,
      boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
    }}>
      <div style={{ fontWeight: 700, fontSize: 13, color: '#f8fafc', marginBottom: 3 }}>{item.slug}</div>
      <div style={{ color: '#94a3b8', marginBottom: 6, lineHeight: 1.4 }}>{item.title}</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge color={statusColor}>{(item.status || 'planned').replace('_', ' ')}</Badge>
        <Badge color={typeColor}>{item.itemType}</Badge>
        {item.phase && <Badge color="#94a3b8">{PHASE_LABELS[item.phase] || item.phase}</Badge>}
      </div>
      {item.description && (() => {
        const desc = item.description.split('\n').filter(l => !l.match(/^(Track|Priority):/i)).join('\n').trim();
        return desc ? (
          <div style={{ marginTop: 8, color: '#94a3b8', fontSize: 11, lineHeight: 1.4, maxHeight: 120, overflowY: 'auto' }}>
            {desc.length > 300 ? desc.slice(0, 300) + '\u2026' : desc}
          </div>
        ) : null;
      })()}
    </div>
  );
}

function Badge({ color, children }) {
  return (
    <span style={{
      fontSize: 10, padding: '1px 6px', borderRadius: 3, fontWeight: 600,
      background: `${color}20`, color, border: `1px solid ${color}40`,
      textTransform: 'uppercase', letterSpacing: '0.03em',
    }}>{children}</span>
  );
}

// ─── Toolbar buttons ─────────────────────────────────────────────────────────

const btnBase = { fontSize: 11, padding: '3px 9px', borderRadius: 4, cursor: 'pointer', transition: 'all 0.15s' };

function FilterBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      ...btnBase,
      border: `1px solid ${active ? '#3b82f6' : '#334155'}`,
      background: active ? '#3b82f6' : '#1e293b',
      color: active ? '#fff' : '#94a3b8',
    }}>{children}</button>
  );
}

function CtrlBtn({ onClick, children, title }) {
  return (
    <button onClick={onClick} title={title} style={{
      ...btnBase, border: '1px solid #334155', background: '#1e293b', color: '#94a3b8',
    }}>{children}</button>
  );
}

function Sep() {
  return <div style={{ width: 1, height: 20, background: '#334155', margin: '0 2px' }} />;
}

// ─── Main component ─────────────────────────────────────────────────────────

export default function GraphView({ items, connections, selectedItemId, onSelect, visibleTracks, buildStateMap, resolveGate, gates }) {
  const containerRef = useRef(null);
  const cyRef = useRef(null);
  const [tooltip, setTooltip] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [rankDir, setRankDir] = useState('LR');
  const [activeEdgeTypes, setActiveEdgeTypes] = useState(new Set(EDGE_FILTER_TYPES));
  const [gatePopoverNodeId, setGatePopoverNodeId] = useState(null);
  const [badgePositions, setBadgePositions] = useState([]);

  // Filter items — only features, then by status, then by visible tracks
  const filteredItems = useMemo(() => {
    let result = items.filter(i => i.type !== 'track');
    const preset = STATUS_FILTERS.find(f => f.key === statusFilter);
    if (preset?.statuses) {
      result = result.filter(i => preset.statuses.includes(i.status || 'planned'));
    }
    if (visibleTracks) {
      result = result.filter(i => visibleTracks.has(getTrack(i)));
    }
    return result;
  }, [items, statusFilter, visibleTracks]);

  const filteredConnections = useMemo(() => {
    const ids = new Set(filteredItems.map(i => i.id));
    return connections.filter(c => ids.has(c.fromId) && ids.has(c.toId));
  }, [connections, filteredItems]);

  const elements = useMemo(
    () => buildElements(filteredItems, filteredConnections),
    [filteredItems, filteredConnections],
  );

  const stylesheet = useMemo(() => buildStylesheet(), []);

  // ─── Cytoscape lifecycle ────────────────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return;

    if (cyRef.current) { cyRef.current.destroy(); cyRef.current = null; }

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: stylesheet,
      layout: {
        name: 'dagre', rankDir,
        nodeSep: 30, rankSep: 70, edgeSep: 10, padding: 30,
        animate: false, fit: false,
      },
      minZoom: 0.1, maxZoom: 4, wheelSensitivity: 0.3, boxSelectionEnabled: false,
    });
    cyRef.current = cy;

    // Set viewport — start at top-left of the graph at readable zoom
    if (selectedItemId) {
      const node = cy.$id(selectedItemId);
      if (node.length) { highlightChain(cy, node); cy.zoom(1.2); cy.center(node); }
      else { cy.zoom(1.0); panToTopLeft(cy); }
    } else {
      cy.zoom(1.0);
      panToTopLeft(cy);
    }

    // Tooltip
    cy.on('mouseover', 'node[status]', (evt) => {
      const pos = evt.renderedPosition || evt.position;
      const rect = cy.container().getBoundingClientRect();
      setTooltip({ x: rect.left + pos.x, y: rect.top + pos.y, item: evt.target.data() });
    });
    cy.on('mousemove', 'node[status]', (evt) => {
      const pos = evt.renderedPosition || evt.position;
      const rect = cy.container().getBoundingClientRect();
      setTooltip(prev => prev ? { x: rect.left + pos.x, y: rect.top + pos.y, item: prev.item } : null);
    });
    cy.on('mouseout', 'node[status]', () => setTooltip(null));

    // Click node
    cy.on('tap', 'node[status]', (evt) => {
      const node = evt.target;
      if (node.hasClass('highlighted')) {
        cy.elements().removeClass('dimmed highlighted');
        onSelect(node.id());
      } else {
        highlightChain(cy, node);
        onSelect(node.id());
      }
    });

    // Tap background or compound track node — deselect
    cy.on('tap', (evt) => {
      if (evt.target === cy || evt.target.data('isGroup')) {
        cy.elements().removeClass('dimmed highlighted');
        onSelect(null);
      }
    });

    return () => { cy.destroy(); cyRef.current = null; };
  }, [elements, stylesheet, rankDir]); // eslint-disable-line react-hooks/exhaustive-deps

  // COMP-UX-1e: Pan to selected item when selection changes while graph is open
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !selectedItemId) return;
    const node = cy.$id(selectedItemId);
    if (node.length) {
      cy.elements().removeClass('dimmed highlighted');
      highlightChain(cy, node);
      cy.animate({ center: { eles: node }, duration: 200 });
    }
  }, [selectedItemId]);

  // Edge type visibility
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    for (const type of EDGE_FILTER_TYPES) {
      cy.edges(`[edgeType="${type}"]`).style('display', activeEdgeTypes.has(type) ? 'element' : 'none');
    }
  }, [activeEdgeTypes]);

  // COMP-UX-1c: Apply build-state classes to nodes
  const BUILD_STATE_CLASSES = ['build-building', 'build-gate-pending', 'build-blocked-downstream', 'build-error'];
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().removeClass(BUILD_STATE_CLASSES.join(' '));
    if (!buildStateMap || Object.keys(buildStateMap).length === 0) return;

    for (const [featureCode, state] of Object.entries(buildStateMap)) {
      const className = `build-${state.replace(/_/g, '-')}`;
      const node = cy.nodes().filter(n => {
        const d = n.data();
        return d.slug === featureCode || d.title === featureCode
          || (d.title && d.title.startsWith(featureCode + ':'));
      });
      if (node.length) node.addClass(className);
    }
  }, [buildStateMap]);

  // COMP-UX-1c: Pulse animation for building nodes
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !buildStateMap) return;
    const hasBuilding = Object.values(buildStateMap).includes('building');
    if (!hasBuilding) return;

    let bright = true;
    const interval = setInterval(() => {
      const nodes = cy.nodes('.build-building');
      if (!nodes.length) return;
      bright = !bright;
      nodes.style('shadow-blur', bright ? 12 : 4);
      nodes.style('shadow-opacity', bright ? 0.6 : 0.2);
    }, 800);
    return () => clearInterval(interval);
  }, [buildStateMap]);

  // COMP-UX-1c: Compute badge positions from cy node rendered positions
  const updateBadgePositions = useCallback(() => {
    const cy = cyRef.current;
    if (!cy || !buildStateMap || Object.keys(buildStateMap).length === 0) {
      setBadgePositions([]);
      return;
    }
    const rect = cy.container()?.getBoundingClientRect();
    if (!rect) return;

    const badges = [];
    for (const [featureCode, state] of Object.entries(buildStateMap)) {
      if (state !== 'gate_pending' && state !== 'error' && state !== 'building') continue;
      const node = cy.nodes().filter(n => {
        const d = n.data();
        return d.slug === featureCode || d.title === featureCode
          || (d.title && d.title.startsWith(featureCode + ':'));
      });
      if (!node.length) continue;
      const pos = node.renderedPosition();
      const w = node.renderedOuterWidth();
      badges.push({
        featureCode,
        state,
        x: pos.x + w / 2 - 6,
        y: pos.y - node.renderedOuterHeight() / 2 - 6,
        nodeId: node.id(),
      });
    }
    setBadgePositions(badges);
  }, [buildStateMap]);

  // Update badge positions on cy render/pan/zoom
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.on('render pan zoom', updateBadgePositions);
    updateBadgePositions();
    return () => { cy.removeListener('render pan zoom', updateBadgePositions); };
  }, [updateBadgePositions]);

  const handleFit = useCallback(() => cyRef.current?.fit(undefined, 40), []);
  const handleZoomIn = useCallback(() => {
    const cy = cyRef.current;
    if (cy) cy.zoom({ level: cy.zoom() * 1.3, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  }, []);
  const handleZoomOut = useCallback(() => {
    const cy = cyRef.current;
    if (cy) cy.zoom({ level: cy.zoom() / 1.3, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  }, []);

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 flex flex-col min-h-0" style={{ background: '#0f172a' }}>
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 shrink-0"
        style={{ background: '#1e293b', borderBottom: '1px solid #334155' }}>
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 11, color: '#64748b' }}>Status:</span>
          {STATUS_FILTERS.map(f => (
            <FilterBtn key={f.key} active={statusFilter === f.key} onClick={() => setStatusFilter(f.key)}>
              {f.label}
            </FilterBtn>
          ))}
          <Sep />
          <span style={{ fontSize: 11, color: '#64748b' }}>Edges:</span>
          <FilterBtn
            active={activeEdgeTypes.size === EDGE_FILTER_TYPES.length}
            onClick={() => setActiveEdgeTypes(new Set(EDGE_FILTER_TYPES))}
          >All</FilterBtn>
          {EDGE_FILTER_TYPES.map(type => (
            <FilterBtn
              key={type}
              active={activeEdgeTypes.has(type)}
              onClick={() => setActiveEdgeTypes(prev => {
                const next = new Set(prev);
                next.has(type) ? next.delete(type) : next.add(type);
                return next;
              })}
            >{type}</FilterBtn>
          ))}
          <Sep />
          <span style={{ fontSize: 10, color: '#475569' }}>
            {filteredItems.length} items &middot; {filteredConnections.length} edges
          </span>
        </div>
        <div className="flex items-center gap-1">
          <CtrlBtn onClick={() => setRankDir(d => d === 'LR' ? 'TB' : 'LR')} title="Toggle direction">
            {rankDir === 'LR' ? '\u2192' : '\u2193'}
          </CtrlBtn>
          <Sep />
          <CtrlBtn onClick={handleZoomOut} title="Zoom out">&minus;</CtrlBtn>
          <CtrlBtn onClick={handleFit} title="Fit to view">Fit</CtrlBtn>
          <CtrlBtn onClick={handleZoomIn} title="Zoom in">+</CtrlBtn>
        </div>
      </div>

      {/* Graph */}
      <div className="flex-1 relative min-h-0">
        <div ref={containerRef} className="w-full h-full" />
        <Tooltip data={tooltip} />

        {/* COMP-UX-1c: Badge overlays */}
        {badgePositions.map(badge => (
          <BuildBadge
            key={badge.featureCode}
            badge={badge}
            onClick={
              badge.state === 'gate_pending'
                ? () => setGatePopoverNodeId(gatePopoverNodeId === badge.featureCode ? null : badge.featureCode)
                : badge.state === 'error'
                  ? () => onSelect(badge.nodeId)
                  : undefined
            }
          />
        ))}

        {/* COMP-UX-1c: Gate popover */}
        {gatePopoverNodeId && (
          <GatePopover
            featureCode={gatePopoverNodeId}
            gates={gates}
            items={items}
            badgePositions={badgePositions}
            onResolve={(gateId, outcome) => {
              if (resolveGate) resolveGate(gateId, outcome);
              setGatePopoverNodeId(null);
            }}
            onClose={() => setGatePopoverNodeId(null)}
          />
        )}
      </div>
    </div>
  );
}

// ─── COMP-UX-1c: Build badge & gate popover ─────────────────────────────────

const BADGE_CONFIG = {
  building:     { bg: '#3b82f620', border: '#3b82f6', color: '#3b82f6', label: '\u2699' },
  gate_pending: { bg: '#f59e0b20', border: '#f59e0b', color: '#f59e0b', label: '\u26A0' },
  error:        { bg: '#ef444420', border: '#ef4444', color: '#ef4444', label: '\u2716' },
};

function BuildBadge({ badge, onClick }) {
  const cfg = BADGE_CONFIG[badge.state];
  if (!cfg) return null;
  return (
    <div
      onClick={onClick}
      style={{
        position: 'absolute',
        left: badge.x,
        top: badge.y,
        width: 16,
        height: 16,
        borderRadius: '50%',
        background: cfg.bg,
        border: `1.5px solid ${cfg.border}`,
        color: cfg.color,
        fontSize: 9,
        fontWeight: 700,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: onClick ? 'pointer' : 'default',
        zIndex: 100,
        pointerEvents: onClick ? 'auto' : 'none',
        transition: 'transform 0.1s',
      }}
      title={badge.state.replace(/_/g, ' ')}
    >
      {cfg.label}
    </div>
  );
}

function GatePopover({ featureCode, gates, items, badgePositions, onResolve, onClose }) {
  const badge = badgePositions.find(b => b.featureCode === featureCode);
  if (!badge) return null;

  // Find the gate for this feature
  const item = items.find(i => i.featureCode === featureCode)
    || items.find(i => i.title === featureCode)
    || items.find(i => i.title && i.title.startsWith(featureCode + ':'));
  const gate = item && gates?.find(g => g.itemId === item.id && !g.resolvedAt);

  if (!gate) return null;

  const gateLabel = gate.stepId
    ? gate.stepId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    : 'Gate';

  return (
    <>
      {/* Backdrop to close on outside click */}
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 199 }}
        onClick={onClose}
      />
      <div style={{
        position: 'absolute',
        left: badge.x - 80,
        top: badge.y + 22,
        zIndex: 200,
        width: 200,
        background: '#1e293b',
        border: '1px solid #475569',
        borderRadius: 8,
        padding: '10px 12px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
      }}>
        <div style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
          {gateLabel}
        </div>
        <div style={{ fontSize: 12, color: '#f8fafc', fontWeight: 600, marginBottom: 8 }}>
          {featureCode}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            onClick={() => onResolve(gate.id, 'approve')}
            style={{
              flex: 1, padding: '4px 0', fontSize: 10, fontWeight: 600, borderRadius: 4,
              background: '#22c55e20', color: '#22c55e', border: '1px solid #22c55e40',
              cursor: 'pointer',
            }}
          >
            Approve
          </button>
          <button
            onClick={() => onResolve(gate.id, 'revise')}
            style={{
              flex: 1, padding: '4px 0', fontSize: 10, fontWeight: 600, borderRadius: 4,
              background: '#f59e0b20', color: '#f59e0b', border: '1px solid #f59e0b40',
              cursor: 'pointer',
            }}
          >
            Revise
          </button>
          <button
            onClick={() => onResolve(gate.id, 'kill')}
            style={{
              flex: 1, padding: '4px 0', fontSize: 10, fontWeight: 600, borderRadius: 4,
              background: '#ef444420', color: '#ef4444', border: '1px solid #ef444440',
              cursor: 'pointer',
            }}
          >
            Kill
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Graph helpers ──────────────────────────────────────────────────────────

function panToTopLeft(cy) {
  const bb = cy.elements().boundingBox();
  if (!bb || bb.w === 0) { cy.center(); return; }
  // Pan so the top-left of the graph is at (20, 20) in rendered space
  cy.pan({
    x: -bb.x1 * cy.zoom() + 20,
    y: -bb.y1 * cy.zoom() + 20,
  });
}

function highlightChain(cy, node) {
  cy.elements().removeClass('dimmed highlighted');
  const connected = node
    .union(node.predecessors('node[status]'))
    .union(node.successors('node[status]'));
  const connectedEdges = connected.edgesWith(connected);
  cy.nodes('[status]').not(connected).addClass('dimmed');
  cy.edges().not(connectedEdges).addClass('dimmed');
  node.addClass('highlighted');
}

if (import.meta.hot) import.meta.hot.accept();
