/**
 * graph-export.js — Generate roadmap-graph.html from vision store state.
 *
 * Exports the vision store's items and connections as a standalone Cytoscape
 * dependency graph HTML file, compatible with the SmartMemory roadmap-graph format.
 *
 * Route: GET /api/export/roadmap-graph
 */

import path from 'node:path';
import fs from 'node:fs';
import { getTargetRoot } from './project-root.js';

// ---------------------------------------------------------------------------
// Data extraction
// ---------------------------------------------------------------------------

const STATUS_MAP = {
  planned: 'planned',
  ready: 'planned',
  in_progress: 'partial',
  review: 'partial',
  blocked: 'parked',
  parked: 'parked',
  complete: 'complete',
  killed: 'complete',
};

const EDGE_TYPE_MAP = {
  blocks: 'dep',
  informs: 'dep',
  implements: 'dep',
  supports: 'concurrent',
  contradicts: 'concurrent',
};

function extractGraphData(store) {
  const items = Array.from(store.items.values());
  const connections = Array.from(store.connections.values());

  // Only include features (not tracks/tasks)
  const features = items.filter(i => i.type === 'feature');

  // Build nodes
  const nodes = [];
  const completed = [];
  const itemIdToCode = new Map();

  for (const item of features) {
    const code = item.lifecycle?.featureCode || item.title;
    itemIdToCode.set(item.id, code);
    const graphStatus = STATUS_MAP[item.status] || 'planned';

    // Extract track from description if available
    const trackMatch = (item.description || '').match(/Track:\s*(\w+)/i);
    const track = trackMatch ? trackMatch[1].toLowerCase() : 'standalone';

    // Extract priority from description if available
    const priorityMatch = (item.description || '').match(/Priority:\s*(\w+)/i);
    const priority = priorityMatch ? priorityMatch[1].toLowerCase() : 'medium';

    // Clean description — remove Track/Priority metadata lines
    const desc = (item.description || '')
      .split('\n')
      .filter(l => !l.match(/^Track:/i) && !l.match(/^Priority:/i))
      .join('\n')
      .trim();

    // First line is the full name, rest is description
    const lines = desc.split('\n').filter(Boolean);
    const name = lines[0] || code;
    const descText = lines.slice(1).join(' ').substring(0, 300);

    if (graphStatus === 'complete') {
      completed.push({
        group: track.charAt(0).toUpperCase() + track.slice(1),
        id: code,
        name,
        date: item.updatedAt ? item.updatedAt.split('T')[0] : '',
      });
    } else {
      nodes.push({
        id: code,
        label: `${code}\\n${name.substring(0, 30)}`,
        name,
        status: graphStatus,
        priority,
        track,
        desc: descText,
      });
    }
  }

  // Build edges
  const edges = [];
  for (const conn of connections) {
    const source = itemIdToCode.get(conn.fromId);
    const target = itemIdToCode.get(conn.toId);
    if (!source || !target) continue;

    // Only include edges where both endpoints are open (not complete)
    const sourceNode = nodes.find(n => n.id === source);
    const targetNode = nodes.find(n => n.id === target);
    if (!sourceNode || !targetNode) continue;

    edges.push({
      source,
      target,
      type: EDGE_TYPE_MAP[conn.type] || 'dep',
    });
  }

  return { nodes, edges, completed };
}

// ---------------------------------------------------------------------------
// HTML generation
// ---------------------------------------------------------------------------

function generateHTML(store) {
  const { nodes, edges, completed } = extractGraphData(store);
  const projectName = path.basename(getTargetRoot());
  const date = new Date().toISOString().split('T')[0];

  // Collect unique tracks
  const tracks = [...new Set(nodes.map(n => n.track))].sort();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${projectName} — Roadmap Dependency Graph</title>
  <script src="https://unpkg.com/cytoscape@3.28.1/dist/cytoscape.min.js"><\/script>
  <script src="https://unpkg.com/dagre@0.8.5/dist/dagre.min.js"><\/script>
  <script src="https://unpkg.com/cytoscape-dagre@2.5.0/cytoscape-dagre.js"><\/script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 12px 20px; background: #1e293b; border-bottom: 1px solid #334155; flex-shrink: 0; }
    header h1 { font-size: 15px; font-weight: 600; color: #f1f5f9; }
    header .subtitle { font-size: 12px; color: #64748b; margin-top: 2px; }
    .controls { display: flex; align-items: center; gap: 8px; }
    .filter-group { display: flex; gap: 4px; align-items: center; }
    .filter-label { font-size: 11px; color: #64748b; margin-right: 2px; }
    button.filter-btn { font-size: 11px; padding: 3px 9px; border-radius: 4px; border: 1px solid #334155; background: #1e293b; color: #94a3b8; cursor: pointer; transition: all 0.15s; }
    button.filter-btn:hover { border-color: #64748b; color: #e2e8f0; }
    button.filter-btn.active { background: #3b82f6; border-color: #3b82f6; color: #fff; }
    .sep { width: 1px; height: 20px; background: #334155; }
    .zoom-btn { font-size: 12px; padding: 3px 9px; border-radius: 4px; border: 1px solid #334155; background: #1e293b; color: #94a3b8; cursor: pointer; }
    .zoom-btn:hover { border-color: #64748b; color: #e2e8f0; }
    #cy { flex: 1; }
    #tooltip { display: none; position: fixed; background: #1e293b; border: 1px solid #475569; border-radius: 8px; padding: 10px 13px; font-size: 12px; pointer-events: none; z-index: 9999; max-width: 280px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
    #tooltip .tt-id { font-weight: 700; font-size: 13px; color: #f8fafc; margin-bottom: 3px; }
    #tooltip .tt-name { color: #94a3b8; margin-bottom: 6px; line-height: 1.4; }
    #tooltip .tt-row { display: flex; gap: 6px; align-items: center; margin-top: 4px; }
    #tooltip .tt-badge { font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase; }
    #tooltip .tt-deps { margin-top: 8px; color: #64748b; font-size: 11px; }
    #tooltip .tt-deps strong { color: #94a3b8; }
    #legend { position: fixed; bottom: 16px; left: 16px; background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 13px; font-size: 11px; z-index: 100; }
    #legend h4 { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 7px; }
    .legend-row { display: flex; align-items: center; gap: 7px; margin-bottom: 4px; color: #94a3b8; }
    .legend-dot { width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; }
    .legend-line { width: 22px; height: 2px; flex-shrink: 0; }
    .legend-dashed { width: 22px; height: 0; border-top: 2px dashed; flex-shrink: 0; }
    .legend-sep { height: 1px; background: #334155; margin: 5px 0; }
    #track-panel { position: fixed; bottom: 16px; right: 16px; background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 13px; font-size: 11px; z-index: 100; }
    #track-panel h4 { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 7px; }
    .track-row { display: flex; align-items: center; gap: 7px; margin-bottom: 3px; color: #94a3b8; cursor: pointer; }
    .track-row:hover { color: #e2e8f0; }
    .track-swatch { width: 12px; height: 12px; border-radius: 2px; flex-shrink: 0; }
    .dimmed { opacity: 0.15; }
    .highlighted { border-width: 3px; border-color: #60a5fa; }
  </style>
</head>
<body>
<header>
  <div>
    <h1>${projectName} — Roadmap Dependency Graph</h1>
    <div class="subtitle">Generated from Compose · ${date}</div>
  </div>
  <div class="controls">
    <span class="filter-label">Status:</span>
    <div class="filter-group">
      <button class="filter-btn active" data-status="all">All</button>
      <button class="filter-btn" data-status="planned">Planned</button>
      <button class="filter-btn" data-status="parked">Parked</button>
      <button class="filter-btn" data-status="partial">Partial</button>
    </div>
    <div class="sep"></div>
    <button class="zoom-btn" id="btn-fit">⊡ Fit</button>
    <button class="zoom-btn" id="btn-in">+</button>
    <button class="zoom-btn" id="btn-out">−</button>
  </div>
</header>
<div id="cy"></div>
<div id="tooltip"></div>
<div id="legend">
  <h4>Legend</h4>
  <div class="legend-row"><div class="legend-dot" style="background:#3b82f6"></div> Planned</div>
  <div class="legend-row"><div class="legend-dot" style="background:#6b7280"></div> Parked</div>
  <div class="legend-row"><div class="legend-dot" style="background:#f59e0b"></div> Partial</div>
  <div class="legend-sep"></div>
  <div class="legend-row"><div class="legend-line" style="background:#64748b"></div> Depends on</div>
  <div class="legend-row"><div class="legend-dashed" style="border-color:#94a3b8"></div> Concurrent</div>
</div>
<div id="track-panel"><h4>Tracks</h4></div>
<script>
const TRACK_COLORS = {
  knowledge: '#0ea5e9', distribution: '#10b981', governance: '#a855f7',
  agent: '#f59e0b', worker: '#ef4444', platform: '#ec4899',
  developer: '#f97316', async: '#6b7280', standalone: '#64748b',
};
const STATUS_COLORS = { planned: '#3b82f6', parked: '#6b7280', partial: '#f59e0b' };

const nodes = ${JSON.stringify(nodes, null, 2)};
const edges = ${JSON.stringify(edges, null, 2)};
const completed = ${JSON.stringify(completed, null, 2)};

cytoscape.use(cytoscapeDagre);
const elements = [];
const tracks = [...new Set(nodes.map(n => n.track))];
tracks.forEach(t => elements.push({ data: { id: 'track-'+t, label: t.charAt(0).toUpperCase()+t.slice(1), isTrack: true, track: t } }));
nodes.forEach(n => elements.push({ data: { ...n, parent: 'track-'+n.track } }));
edges.forEach((e,i) => elements.push({ data: { id: 'e'+i, source: e.source, target: e.target, type: e.type } }));

const cy = cytoscape({
  container: document.getElementById('cy'),
  elements,
  style: [
    { selector: '[?isTrack]', style: { label: 'data(label)', 'text-valign': 'top', 'text-halign': 'center', 'font-size': '10px', 'font-weight': '600', color: '#64748b', 'text-transform': 'uppercase', 'background-color': '#1a2537', 'border-width': 1, 'border-color': '#283548', padding: '18px' } },
    { selector: 'node[status]', style: { label: 'data(label)', 'text-valign': 'center', 'text-halign': 'center', 'font-size': '9px', 'font-weight': '500', color: '#e2e8f0', 'text-wrap': 'wrap', 'text-max-width': '90px', width: '110px', height: '48px', shape: 'round-rectangle', 'background-color': '#1e293b', 'border-color': '#3b82f6', 'border-width': 2 } },
    { selector: 'node[status="planned"]', style: { 'border-color': '#3b82f6' } },
    { selector: 'node[status="parked"]', style: { 'border-color': '#6b7280', opacity: 0.75 } },
    { selector: 'node[status="partial"]', style: { 'border-color': '#f59e0b' } },
    { selector: 'node[priority="high"]', style: { 'border-width': 3 } },
    { selector: 'node[priority="low"]', style: { 'border-width': 1 } },
    { selector: 'node[track="knowledge"]', style: { 'background-color': '#0d2538' } },
    { selector: 'node[track="distribution"]', style: { 'background-color': '#0d2620' } },
    { selector: 'node[track="governance"]', style: { 'background-color': '#1e1630' } },
    { selector: 'node[track="agent"]', style: { 'background-color': '#231d0a' } },
    { selector: 'node[track="worker"]', style: { 'background-color': '#281515' } },
    { selector: 'node[track="platform"]', style: { 'background-color': '#281020' } },
    { selector: 'node[track="developer"]', style: { 'background-color': '#271a0d' } },
    { selector: 'node[track="async"]', style: { 'background-color': '#1a1e24' } },
    { selector: 'node[track="standalone"]', style: { 'background-color': '#1c2030' } },
    { selector: 'edge[type="dep"]', style: { width: 1.5, 'line-color': '#475569', 'target-arrow-color': '#475569', 'target-arrow-shape': 'triangle', 'arrow-scale': 0.9, 'curve-style': 'bezier' } },
    { selector: 'edge[type="concurrent"]', style: { width: 1.5, 'line-color': '#64748b', 'line-style': 'dashed', 'target-arrow-shape': 'none', 'curve-style': 'bezier' } },
    { selector: '.dimmed', style: { opacity: 0.15 } },
  ],
  layout: { name: 'dagre', rankDir: 'LR', nodeSep: 30, rankSep: 70, padding: 20, animate: false, fit: true }
});

// Track panel
const trackPanel = document.getElementById('track-panel');
Object.entries(TRACK_COLORS).forEach(([track, color]) => {
  if (!nodes.find(n => n.track === track)) return;
  const div = document.createElement('div');
  div.className = 'track-row';
  div.innerHTML = '<div class="track-swatch" style="background:'+color+'"></div>'+track.charAt(0).toUpperCase()+track.slice(1);
  div.addEventListener('click', () => { cy.fit(cy.nodes('[track="'+track+'"]'), 80); });
  trackPanel.appendChild(div);
});

// Tooltip
const tt = document.getElementById('tooltip');
cy.on('mouseover', 'node[status]', evt => {
  const d = evt.target.data();
  const inc = evt.target.incomers('node[status]').map(n=>n.data('id')).join(', ')||'—';
  const out = evt.target.outgoers('node[status]').map(n=>n.data('id')).join(', ')||'—';
  tt.innerHTML = '<div class="tt-id">'+d.id+'</div><div class="tt-name">'+d.name+'</div><div class="tt-deps"><strong>Depends on:</strong> '+inc+'</div><div class="tt-deps"><strong>Unblocks:</strong> '+out+'</div><div class="tt-deps" style="margin-top:6px;color:#94a3b8">'+d.desc+'</div>';
  tt.style.display = 'block';
});
cy.on('mousemove', 'node[status]', evt => {
  const pos = evt.renderedPosition || evt.position;
  const off = cy.container().getBoundingClientRect();
  tt.style.left = (off.left+pos.x+14)+'px';
  tt.style.top = (off.top+pos.y-10)+'px';
});
cy.on('mouseout', 'node[status]', () => { tt.style.display = 'none'; });

// Click to highlight
cy.on('tap', 'node[status]', evt => {
  cy.elements().removeClass('dimmed');
  const n = evt.target;
  const connected = n.union(n.predecessors('node[status]')).union(n.successors('node[status]'));
  cy.nodes('[status]').not(connected).addClass('dimmed');
  cy.edges().not(connected.edgesWith(connected)).addClass('dimmed');
});
cy.on('tap', evt => { if (evt.target === cy) cy.elements().removeClass('dimmed'); });

// Filters
let activeStatus = 'all';
document.querySelectorAll('[data-status]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-status]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeStatus = btn.dataset.status;
    cy.nodes('[status]').forEach(n => {
      n.style('display', (activeStatus === 'all' || n.data('status') === activeStatus) ? 'element' : 'none');
    });
  });
});

// Zoom
document.getElementById('btn-fit').addEventListener('click', () => cy.fit(undefined, 30));
document.getElementById('btn-in').addEventListener('click', () => cy.zoom({ level: cy.zoom()*1.3, renderedPosition: { x: cy.width()/2, y: cy.height()/2 } }));
document.getElementById('btn-out').addEventListener('click', () => cy.zoom({ level: cy.zoom()*0.77, renderedPosition: { x: cy.width()/2, y: cy.height()/2 } }));
setTimeout(() => cy.fit(undefined, 30), 100);
<\/script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export function attachGraphExportRoutes(app, { store }) {
  // GET /api/export/roadmap-graph — returns generated HTML
  app.get('/api/export/roadmap-graph', (_req, res) => {
    try {
      const html = generateHTML(store);
      res.type('html').send(html);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/export/roadmap-graph/save — writes to project docs
  app.post('/api/export/roadmap-graph/save', (_req, res) => {
    try {
      const html = generateHTML(store);
      const docsDir = path.join(getTargetRoot(), 'docs');
      fs.mkdirSync(docsDir, { recursive: true });
      const outPath = path.join(docsDir, 'roadmap-graph.html');
      fs.writeFileSync(outPath, html, 'utf-8');
      res.json({ ok: true, path: outPath });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
