import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import AgentStream from './components/AgentStream';
import PopoutView from './components/PopoutView';
import StratumPanel from './components/StratumPanel';

// Cockpit shell components
import ViewTabs from './components/cockpit/ViewTabs.jsx';
import AgentBar from './components/cockpit/AgentBar.jsx';
import ContextPanel from './components/cockpit/ContextPanel.jsx';
import ContextItemDetail from './components/cockpit/ContextItemDetail.jsx';
import ContextStepDetail from './components/cockpit/ContextStepDetail.jsx';
import NotificationBar from './components/cockpit/NotificationBar.jsx';
import OpsStrip from './components/cockpit/OpsStrip.jsx';

// Pure state-logic modules
import {
  AGENT_BAR_STATES,
  loadAgentBarState,
  saveAgentBarState,
  agentBarHeightClass,
} from './components/cockpit/agentBarState.js';
import {
  loadMainTabs,
  loadActiveTab,
  saveActiveTab,
} from './components/cockpit/viewTabsState.js';
import {
  loadSidebarOpen,
  saveSidebarOpen,
  loadContextOpen,
  saveContextOpen,
} from './components/cockpit/panelState.js';
import {
  CONTEXT_HIDDEN_VIEWS,
} from './components/cockpit/contextPanelState.js';

// Vision surface — views, sidebar, modals, store
import { VisionChangesContext } from './components/vision/VisionChangesContext.js';
import { useVisionStore } from './components/vision/useVisionStore.js';
import { useShallow } from 'zustand/react/shallow';
import AttentionQueueSidebar from './components/vision/AttentionQueueSidebar.jsx';
import TreeView from './components/vision/TreeView.jsx';
import GraphView from './components/vision/GraphView.jsx';
import DocsView from './components/vision/DocsView.jsx';
import GateView from './components/vision/GateView.jsx';
import GateToast from './components/vision/GateToast.jsx';
import ChallengeModal from './components/vision/ChallengeModal.jsx';
import SettingsPanel from './components/vision/SettingsPanel.jsx';
import PipelineView from './components/vision/PipelineView.jsx';
import SessionsView from './components/vision/SessionsView.jsx';
import DesignView from './components/vision/DesignView.jsx';
import DesignSidebar from './components/vision/DesignSidebar.jsx';
import { useDesignStore } from './components/vision/useDesignStore.js';
import CommandPalette from './components/vision/shared/CommandPalette.jsx';
import ItemFormDialog from './components/vision/shared/ItemFormDialog.jsx';
import SettingsModal from './components/vision/shared/SettingsModal.jsx';
import GateNotificationBar from './components/vision/shared/GateNotificationBar.jsx';
import { computeBuildStateMap } from './components/vision/graphOpsOverlays.js';

/*
 * COMP-UI-1 — Cockpit shell (flat layout)
 *
 * Layout (top -> bottom, left -> right):
 *
 *   +-----------------------------------------------------+
 *   | HEADER: [Compose] [ViewTabs with icons]  [Controls]  |
 *   +---------+----------------------------+---------------+
 *   |         |                            |               |
 *   | SIDEBAR |      MAIN AREA             |   CONTEXT     |
 *   |         |   (direct view rendering)  |    PANEL      |
 *   |         |                            |               |
 *   +---------+----------------------------+---------------+
 *   |  AGENT BAR  (collapsed | expanded | maximized)       |
 *   +-----------------------------------------------------+
 *   |  NOTIFICATION BAR                                    |
 *   +-----------------------------------------------------+
 *
 * Views are direct children of the content area — no Canvas/VisionTracker
 * nesting. The vision surface is the primary interface; agent chat is a
 * collapsible bottom panel.
 */

// ---------------------------------------------------------------------------
// Error boundaries
// ---------------------------------------------------------------------------

class PanelErrorBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div
          className="w-full h-full flex flex-col items-center justify-center gap-3 p-4"
          style={{ background: 'hsl(var(--background))', color: 'hsl(var(--muted-foreground))' }}
        >
          <div
            className="text-xs uppercase tracking-wider font-semibold"
            style={{ color: 'hsl(var(--destructive))' }}
          >
            panel crashed
          </div>
          <div className="text-[11px] max-w-[300px] text-center opacity-70 font-mono">
            {this.state.error?.message?.substring(0, 120)}
          </div>
          <button
            className="mt-2 px-3 py-1 text-xs rounded border"
            style={{ borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
            onClick={() => this.setState({ error: null })}
          >
            retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

class SafeModeBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="h-screen w-screen flex flex-col bg-background">
          <div
            className="h-8 flex items-center justify-between px-3 shrink-0"
            style={{
              borderBottom: '1px solid hsl(var(--border))',
              background: 'hsl(var(--destructive) / 0.1)',
            }}
          >
            <span
              className="text-[10px] uppercase tracking-wider font-semibold"
              style={{ color: 'hsl(var(--destructive))' }}
            >
              safe mode — UI crashed: {this.state.error?.message?.substring(0, 80)}
            </span>
            <button
              className="px-2 py-0.5 text-[10px] rounded border"
              style={{ borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
              onClick={() => this.setState({ error: null })}
            >
              retry
            </button>
          </div>
          <div className="flex-1 min-h-0">
            <AgentStream />
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FONT_SIZE_KEY    = 'compose:fontSize';
const THEME_KEY        = 'compose:theme';
const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE     = 10;
const MAX_FONT_SIZE     = 20;

function loadFontSize() {
  try {
    const v = parseInt(localStorage.getItem(FONT_SIZE_KEY), 10);
    return v >= MIN_FONT_SIZE && v <= MAX_FONT_SIZE ? v : DEFAULT_FONT_SIZE;
  } catch {
    return DEFAULT_FONT_SIZE;
  }
}

// ---------------------------------------------------------------------------
// App root
// ---------------------------------------------------------------------------

const POPOUT_PATH = new URLSearchParams(window.location.search).get('popout');

export default function App() {
  if (POPOUT_PATH) {
    return <PopoutView path={POPOUT_PATH} />;
  }
  return (
    <SafeModeBoundary>
      <AppInner />
    </SafeModeBoundary>
  );
}

// ---------------------------------------------------------------------------
// CockpitView — pure render function, no hooks
// ---------------------------------------------------------------------------

function CockpitView({
  activeView,
  // data
  items, filteredItems, phaseFilteredItems, phaseFilteredGates,
  connections, filteredConnections, sessions, activeBuild,
  gates, settings, selectedPhase, selectedItemId,
  buildStateMap,
  // docs navigation
  docsSelectedFile, onDocsSelectedFileChange, docsPreviousView, onDocsBack,
  // graph filtering
  visibleTracks, hiddenGroups,
  // callbacks
  onSelect, onUpdate, onCreate, onDelete, onOpenGate,
  onCreateConnection, onDeleteConnection, onRefreshBuild, onSelectStep,
  onResolveGate, onUpdateSettings, onResetSettings,
  projectRoot,
}) {
  switch (activeView) {
    case 'tree':
      return (
        <TreeView
          items={filteredItems}
          connections={filteredConnections}
          selectedItemId={selectedItemId}
          onSelect={onSelect}
          onCreate={onCreate}
        />
      );
    case 'graph':
      return (
        <GraphView
          items={items}
          connections={connections}
          selectedItemId={selectedItemId}
          onSelect={onSelect}
          visibleTracks={visibleTracks}
          hiddenGroups={hiddenGroups}
          buildStateMap={buildStateMap}
          resolveGate={onResolveGate}
          gates={gates}
        />
      );
    case 'pipeline':
      return (
        <PipelineView
          activeBuild={activeBuild}
          onSelectStep={onSelectStep}
          onRefresh={onRefreshBuild}
        />
      );
    case 'sessions':
      return (
        <SessionsView
          sessions={sessions}
          items={items}
          onSelectItem={onSelect}
        />
      );
    case 'gates':
      return (
        <GateView
          gates={phaseFilteredGates}
          items={phaseFilteredItems}
          onResolve={onResolveGate}
          onSelect={onSelect}
        />
      );
    case 'docs':
      return (
        <DocsView
          items={phaseFilteredItems}
          selectedFile={docsSelectedFile}
          onSelectedFileChange={onDocsSelectedFileChange}
          previousView={docsPreviousView}
          onBack={onDocsBack}
        />
      );
    case 'design':
      return <DesignView key={projectRoot} />;
    case 'settings':
      return (
        <SettingsPanel
          settings={settings}
          onSettingsChange={onUpdateSettings}
          onReset={onResetSettings}
        />
      );
    case 'stratum':
      return <StratumPanel />;
    default:
      return (
        <div className="flex-1 flex items-center justify-center text-[12px] text-muted-foreground italic">
          View &ldquo;{activeView}&rdquo; not found.
        </div>
      );
  }
}

// ---------------------------------------------------------------------------
// AppInner — cockpit shell with absorbed VisionTracker logic
// ---------------------------------------------------------------------------

function AppInner() {
  // ── Design store ────────────────────────────────────────────────────────
  const designDecisions = useDesignStore(s => s.decisions);
  const designStatus = useDesignStore(s => s.status);

  // ── Persistent UI state ─────────────────────────────────────────────────
  const [fontSize, setFontSize] = useState(loadFontSize);
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains('dark')
  );

  // Main-area tabs
  const [mainTabs] = useState(loadMainTabs);
  const [activeTab, setActiveTabRaw] = useState(() => loadActiveTab(mainTabs));

  // Agent bar
  const [agentBarState, setAgentBarStateRaw] = useState(loadAgentBarState);

  // Sidebar / context panel visibility
  const [sidebarOpen, setSidebarOpen] = useState(loadSidebarOpen);
  const [contextOpen, setContextOpen] = useState(loadContextOpen);

  // COMP-UI-3: Context selection
  const [contextSelection, setContextSelection] = useState(null);

  // COMP-UX-1b: Context panel width in pixels
  const [contextWidthPx, setContextWidthPx] = useState(() => {
    try { return parseInt(localStorage.getItem('compose:contextWidthPx'), 10) || 420; }
    catch { return 420; }
  });

  // ── Vision store (absorbed from VisionTracker) ──────────────────────────
  const {
    items, connections, connected, uiCommand, clearUICommand, recentChanges,
    createItem, updateItem, deleteItem, createConnection, deleteConnection,
    agentActivity, agentErrors, sessionState, registerSnapshotProvider,
    gates, gateEvent, resolveGate,
    settings, updateSettings, resetSettings,
    activeBuild, setActiveBuild,
    sessions,
    selectedPhase, setSelectedPhase,
  } = useVisionStore(useShallow(s => ({
    items: s.items, connections: s.connections, connected: s.connected,
    uiCommand: s.uiCommand, clearUICommand: s.clearUICommand, recentChanges: s.recentChanges,
    createItem: s.createItem, updateItem: s.updateItem, deleteItem: s.deleteItem,
    createConnection: s.createConnection, deleteConnection: s.deleteConnection,
    agentActivity: s.agentActivity, agentErrors: s.agentErrors,
    sessionState: s.sessionState, registerSnapshotProvider: s.registerSnapshotProvider,
    gates: s.gates, gateEvent: s.gateEvent, resolveGate: s.resolveGate,
    settings: s.settings, updateSettings: s.updateSettings, resetSettings: s.resetSettings,
    activeBuild: s.activeBuild, setActiveBuild: s.setActiveBuild,
    sessions: s.sessions,
    selectedPhase: s.selectedPhase, setSelectedPhase: s.setSelectedPhase,
  })));

  // ── Local vision state (absorbed from VisionTracker) ────────────────────
  const [selectedItemId, setSelectedItemId] = useState(null);
  const hadSessionView = useRef(!!localStorage.getItem('compose:activeView'));
  const [activeView, setActiveView] = useState(() =>
    localStorage.getItem('compose:activeView') || 'graph'
  );
  const [searchQuery, setSearchQuery] = useState('');

  const handleContextResizePx = useCallback((px) => {
    setContextWidthPx(px);
    localStorage.setItem('compose:contextWidthPx', String(Math.round(px)));
  }, []);

  const [docsSelectedFile, setDocsSelectedFile] = useState(null);
  const [docsPreviousView, setDocsPreviousView] = useState(null);
  const [selectedTrack, setSelectedTrack] = useState(() =>
    localStorage.getItem('compose:selectedTrack') || null
  );
  // Checkbox-style track filter for graph — null means show all
  const [visibleTracks, setVisibleTracks] = useState(() => {
    try {
      const raw = localStorage.getItem('compose:visibleTracks');
      if (raw) { const arr = JSON.parse(raw); return new Set(arr); }
    } catch { /* ignore */ }
    return null;
  });
  // COMP-UX-1: Group filter (shared between sidebar and graph)
  const [hiddenGroups, setHiddenGroups] = useState(new Set());
  const handleToggleGroup = useCallback((group) => {
    setHiddenGroups(prev => {
      const next = new Set(prev);
      next.has(group) ? next.delete(group) : next.add(group);
      return next;
    });
  }, []);

  const [challengeItemId, setChallengeItemId] = useState(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ── Project info ────────────────────────────────────────────────────────
  const [projectName, setProjectName] = useState('');
  const [projectRoot, setProjectRoot] = useState('');
  const [projectSwitchOpen, setProjectSwitchOpen] = useState(false);

  useEffect(() => {
    fetch('/api/project').then(r => r.json()).then(data => {
      setProjectName(data.name || '');
      setProjectRoot(data.targetRoot || '');
    }).catch(() => {});
  }, []);

  const handleProjectSwitch = useCallback((newPath) => {
    fetch('/api/project/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: newPath }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          setProjectName(data.name);
          setProjectRoot(data.targetRoot);
          setProjectSwitchOpen(false);
          // Vision store will get new state via WebSocket broadcast
        }
      })
      .catch(() => {});
  }, []);

  // ── Derived flags ───────────────────────────────────────────────────────
  const isMaximized = agentBarState === AGENT_BAR_STATES.MAXIMIZED;

  // ── Sync activeView ↔ activeTab ─────────────────────────────────────────
  // activeView is the view key used by CockpitView; activeTab drives ViewTabs.
  // Keep them in sync: tab changes drive the view.
  const setActiveTab = useCallback((tab) => {
    setActiveTabRaw(tab);
    saveActiveTab(tab);
    setActiveView(tab);
  }, []);

  // When sidebar nav changes view, sync tabs too
  const handleViewChange = useCallback((view) => {
    setActiveView(view);
    // If the view is in mainTabs, sync the tab
    setActiveTabRaw(view);
    saveActiveTab(view);
  }, []);

  // ── Layout persistence ───────────────────────────────────────────────────
  useEffect(() => {
    localStorage.setItem('compose:activeView', activeView);
    // COMP-UX-1e: Clear stale docs back-navigation state when leaving docs
    // via tab switch (not via the back button which clears it explicitly)
    if (activeView !== 'docs') {
      setDocsPreviousView(null);
      setDocsSelectedFile(null);
    }
  }, [activeView]);

  useEffect(() => {
    if (selectedTrack) localStorage.setItem('compose:selectedTrack', selectedTrack);
    else localStorage.removeItem('compose:selectedTrack');
  }, [selectedTrack]);

  useEffect(() => {
    if (selectedItemId) sessionStorage.setItem('vision-selectedItemId', selectedItemId);
    else sessionStorage.removeItem('vision-selectedItemId');
  }, [selectedItemId]);

  useEffect(() => {
    try {
      if (visibleTracks) localStorage.setItem('compose:visibleTracks', JSON.stringify([...visibleTracks]));
      else localStorage.removeItem('compose:visibleTracks');
    } catch { /* ignore */ }
  }, [visibleTracks]);

  // ── Apply settings defaultView on first WS connect ──────────────────────
  const defaultViewApplied = useRef(false);
  useEffect(() => {
    if (defaultViewApplied.current || hadSessionView.current) return;
    if (settings?.ui?.defaultView) {
      handleViewChange(settings.ui.defaultView);
      defaultViewApplied.current = true;
    }
  }, [settings]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── UI commands from server ─────────────────────────────────────────────
  useEffect(() => {
    if (!uiCommand) return;
    if (uiCommand.view) handleViewChange(uiCommand.view);
    if (uiCommand.phase !== undefined) setSelectedPhase(uiCommand.phase);
    if (uiCommand.select !== undefined) handleSelect(uiCommand.select);
    clearUICommand();
  }, [uiCommand, clearUICommand]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Keyboard shortcuts ──────────────────────────────────────────────────
  useEffect(() => {
    const isInputFocused = () =>
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setPaletteOpen(v => !v); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') { e.preventDefault(); setCreateOpen(true); }
      if (e.key === ',' && !e.metaKey && !e.ctrlKey && !isInputFocused()) { setSettingsOpen(true); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ── Memoized filtering ──────────────────────────────────────────────────
  const filteredItems = useMemo(() => {
    let result = items;
    if (selectedPhase) result = result.filter(i => i.phase === selectedPhase);
    if (selectedTrack) {
      result = result.filter(i => {
        const match = (i.description || '').match(/Track:\s*(\w+)/i);
        return match && match[1].toLowerCase() === selectedTrack;
      });
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(i =>
        i.title.toLowerCase().includes(q) ||
        (i.description || '').toLowerCase().includes(q)
      );
    }
    return result;
  }, [items, selectedPhase, selectedTrack, searchQuery]);

  const phaseFilteredItems = useMemo(() => {
    if (!selectedPhase) return items;
    return items.filter(i => i.phase === selectedPhase);
  }, [items, selectedPhase]);

  const phaseFilteredItemIds = useMemo(
    () => new Set(phaseFilteredItems.map(i => i.id)),
    [phaseFilteredItems],
  );

  const phaseFilteredGates = useMemo(() => {
    if (!selectedPhase) return gates;
    return gates.filter(g => phaseFilteredItemIds.has(g.itemId));
  }, [gates, phaseFilteredItemIds, selectedPhase]);

  const filteredConnections = useMemo(() => {
    if (!selectedPhase && !selectedTrack && !searchQuery) return connections;
    const ids = new Set(filteredItems.map(i => i.id));
    return connections.filter(c => ids.has(c.fromId) && ids.has(c.toId));
  }, [connections, filteredItems, selectedPhase, selectedTrack, searchQuery]);

  // COMP-UX-1c: Derived build state map for graph overlays
  const buildStateMap = useMemo(
    () => computeBuildStateMap(activeBuild, items, connections, gates),
    [activeBuild, items, connections, gates],
  );

  // Context selection handler (must be before handleSelect which depends on it)
  const onContextSelect = useCallback((selection) => {
    setContextSelection(selection);
  }, []);

  // Vision callbacks (must be before COMP-UX-1f hooks that depend on handleSelect)
  const handleSelect = useCallback((id) => {
    setSelectedItemId(prev => {
      if (prev === id) {
        // Toggle off — deselect
        onContextSelect(null);
        return null;
      }
      onContextSelect({ type: 'item', id });
      return id;
    });
  }, [onContextSelect]);

  // COMP-UX-1f: Build lifecycle — detect transitions and update ops strip / graph
  const prevBuildRef = useRef(activeBuild);
  useEffect(() => {
    const prev = prevBuildRef.current;
    if (!prev && activeBuild) {
      // Build started — context panel auto-selects the feature item if available
      if (activeBuild.featureItemId) {
        handleSelect(activeBuild.featureItemId);
      }
    } else if (prev && !activeBuild) {
      // Build ended — if failed, the error is already surfaced via recentErrors → OpsStrip
      // On success, OpsStrip's flash animation is driven by the 'done' entry type
      // Graph overlays clear automatically since buildStateMap derives from activeBuild
    }
    prevBuildRef.current = activeBuild;
  }, [activeBuild]); // eslint-disable-line react-hooks/exhaustive-deps

  // COMP-UX-1f: OpsStrip feature click → select item in context panel
  const handleOpsSelectFeature = useCallback((featureCode) => {
    if (!featureCode) return;
    const item = items.find(i =>
      i.lifecycle?.featureCode === featureCode ||
      i.featureCode === featureCode ||
      i.feature_code === featureCode ||
      i.title?.includes(featureCode)
    );
    if (item) handleSelect(item.id);
  }, [items, handleSelect]);

  // COMP-UX-1f: Listen for feature code pre-selection from agent bar
  useEffect(() => {
    const handler = (e) => {
      const { featureCode } = e.detail || {};
      if (featureCode) handleOpsSelectFeature(featureCode);
    };
    window.addEventListener('compose:select-feature', handler);
    return () => window.removeEventListener('compose:select-feature', handler);
  }, [handleOpsSelectFeature]);

  // ── Snapshot provider ───────────────────────────────────────────────────
  useEffect(() => {
    registerSnapshotProvider(() => ({
      activeView,
      selectedPhase,
      searchQuery,
      selectedItemId,
      totalItems: items.length,
      filteredCount: filteredItems.length,
      connected,
    }));
  }, [registerSnapshotProvider, activeView, selectedPhase, searchQuery, selectedItemId, items.length, filteredItems.length, connected]);

  // ── Theme tracking ──────────────────────────────────────────────────────
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, []);

  // ── Auto-open context panel on selection ────────────────────────────────
  useEffect(() => {
    if (contextSelection && !contextOpen) {
      setContextOpen(true);
      saveContextOpen(true);
    }
  }, [contextSelection]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Callbacks ───────────────────────────────────────────────────────────
  const toggleTheme = useCallback(() => {
    const next = isDark ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', next === 'dark');
    localStorage.setItem(THEME_KEY, next);
    fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ui: { theme: next } }),
    }).catch(() => {});
  }, [isDark]);

  const changeFontSize = useCallback((delta) => {
    setFontSize(prev => {
      const next = Math.min(Math.max(prev + delta, MIN_FONT_SIZE), MAX_FONT_SIZE);
      localStorage.setItem(FONT_SIZE_KEY, next);
      return next;
    });
  }, []);

  const resetFontSize = useCallback(() => {
    setFontSize(DEFAULT_FONT_SIZE);
    localStorage.setItem(FONT_SIZE_KEY, DEFAULT_FONT_SIZE);
  }, []);

  const setAgentBarState = useCallback((next) => {
    setAgentBarStateRaw(next);
    saveAgentBarState(next);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen(v => {
      saveSidebarOpen(!v);
      return !v;
    });
  }, []);

  const toggleContext = useCallback(() => {
    setContextOpen(v => {
      saveContextOpen(!v);
      return !v;
    });
  }, []);



  const handleUpdate = useCallback((id, data) => {
    updateItem(id, data);
  }, [updateItem]);

  const handleCreate = useCallback(async () => {
    const phase = selectedPhase || 'vision';
    const result = await createItem({
      type: 'task',
      title: 'New item',
      description: '',
      status: 'planned',
      confidence: 0,
      phase,
    });
    if (result && result.id) {
      handleSelect(result.id);
    }
  }, [createItem, selectedPhase]);

  const handleDelete = useCallback(async (id) => {
    await deleteItem(id);
    if (selectedItemId === id) {
      setSelectedItemId(null);
      onContextSelect(null);
    }
  }, [deleteItem, selectedItemId, onContextSelect]);

  const handleOpenGate = useCallback((gateId) => {
    const gate = gates.find(g => g.id === gateId);
    if (!gate) return;
    setSelectedItemId(gate.itemId);
    onContextSelect({ type: 'item', id: gate.itemId });
  }, [gates, onContextSelect]);

  const handleCreateConnection = useCallback(async (data) => {
    return createConnection(data);
  }, [createConnection]);

  const handleDeleteConnection = useCallback(async (id) => {
    return deleteConnection(id);
  }, [deleteConnection]);

  const handleRefreshBuild = useCallback(() => {
    fetch('/api/build/state')
      .then(r => r.json())
      .then(data => setActiveBuild(data.state ?? null))
      .catch(() => {});
  }, [setActiveBuild]);

  const handleSelectStep = useCallback((stepId) => {
    onContextSelect({ type: 'step', id: stepId });
  }, [onContextSelect]);

  // COMP-UX-1e: View in Graph / View in Tree from context panel
  // Ensures the target item is visible by adding its track to visibleTracks
  // and clearing selectedTrack if it would hide the item.
  const ensureItemVisible = useCallback((itemId) => {
    const item = items.find(i => i.id === itemId);
    if (!item) return;
    const trackMatch = (item.description || '').match(/Track:\s*(\w+)/i);
    const itemTrack = trackMatch ? trackMatch[1].toLowerCase() : null;
    // If selectedTrack is filtering out this item, clear it
    if (selectedTrack && itemTrack && selectedTrack !== itemTrack) {
      setSelectedTrack(null);
    }
    // If visibleTracks is set and doesn't include this item's track, add it
    if (itemTrack && visibleTracks && !visibleTracks.has(itemTrack)) {
      setVisibleTracks(prev => {
        const next = new Set(prev);
        next.add(itemTrack);
        return next;
      });
    }
  }, [items, selectedTrack, visibleTracks]);

  const handleViewInGraph = useCallback((itemId) => {
    ensureItemVisible(itemId);
    setSelectedItemId(itemId);
    onContextSelect({ type: 'item', id: itemId });
    handleViewChange('graph');
  }, [handleViewChange, onContextSelect, ensureItemVisible]);

  const handleViewInTree = useCallback((itemId) => {
    ensureItemVisible(itemId);
    setSelectedItemId(itemId);
    onContextSelect({ type: 'item', id: itemId });
    handleViewChange('tree');
  }, [handleViewChange, onContextSelect, ensureItemVisible]);

  const navigateToDocs = useCallback((filePath) => {
    setDocsPreviousView(activeView);
    setDocsSelectedFile(filePath);
    handleViewChange('docs');
  }, [activeView, handleViewChange]);

  const navigateBackFromDocs = useCallback(() => {
    if (docsPreviousView) {
      handleViewChange(docsPreviousView);
      setDocsPreviousView(null);
      setDocsSelectedFile(null);
    }
  }, [docsPreviousView, handleViewChange]);

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <VisionChangesContext.Provider value={recentChanges}>
      <div
        className="h-screen w-screen flex flex-col bg-background overflow-hidden"
        style={{ fontSize: `${fontSize}px` }}
      >
        {/* ================================================================ */}
        {/* HEADER                                                            */}
        {/* ================================================================ */}
        <header
          className="h-9 flex items-center px-3 gap-3 shrink-0 justify-between"
          style={{ borderBottom: '1px solid hsl(var(--border))' }}
        >
          {/* Logo + project name */}
          <div className="flex items-center shrink-0 gap-2 relative">
            <span className="text-xs font-semibold tracking-widest uppercase text-accent">
              Compose
            </span>
            <button
              className="text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setProjectSwitchOpen(v => !v)}
              title={projectRoot || 'Switch project'}
            >
              {projectName || 'no project'}
            </button>
            {projectSwitchOpen && (
              <div
                className="absolute top-full left-0 mt-1 z-50 p-2 rounded-md shadow-lg"
                style={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', minWidth: '280px' }}
              >
                <div className="text-[10px] text-muted-foreground mb-1 px-1">
                  Current: {projectRoot}
                </div>
                <input
                  autoFocus
                  className="w-full px-2 py-1 text-xs rounded border bg-background text-foreground"
                  style={{ borderColor: 'hsl(var(--border))' }}
                  placeholder="Absolute path to project..."
                  defaultValue={projectRoot}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleProjectSwitch(e.target.value);
                    if (e.key === 'Escape') setProjectSwitchOpen(false);
                  }}
                />
              </div>
            )}
          </div>

          {/* View tabs — centred in the header */}
          <div className="flex-1 min-w-0 h-full flex items-center">
            <ViewTabs
              tabs={mainTabs}
              activeTab={activeTab}
              onTabChange={setActiveTab}
              onOpenPalette={() => setPaletteOpen(v => !v)}
              badges={{ gates: gates.filter(g => !g.resolvedAt).length }}
            />
          </div>

          {/* Controls */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Connection indicator */}
            {!connected && (
              <span className="text-[9px] uppercase tracking-wider text-destructive animate-pulse">
                disconnected
              </span>
            )}

            {/* Theme toggle */}
            <button
              className="compose-btn-icon"
              onClick={toggleTheme}
              title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {isDark ? '\u2600' : '\u263E'}
            </button>

            {/* Font size controls */}
            <div className="flex items-center gap-1">
              <button
                className="compose-btn-icon"
                onClick={() => changeFontSize(-1)}
                disabled={fontSize <= MIN_FONT_SIZE}
                title="Decrease font size"
              >
                A&#x2212;
              </button>
              <span className="text-[10px] tabular-nums min-w-[20px] text-center text-muted-foreground">
                {fontSize}
              </span>
              <button
                className="compose-btn-icon"
                onClick={() => changeFontSize(1)}
                disabled={fontSize >= MAX_FONT_SIZE}
                title="Increase font size"
              >
                A+
              </button>
            </div>
            <button
              className="compose-btn-icon"
              onClick={resetFontSize}
              disabled={fontSize === DEFAULT_FONT_SIZE}
              title="Reset font size"
            >
              1:1
            </button>
          </div>
        </header>

        {/* ================================================================ */}
        {/* WORKSPACE                                                         */}
        {/* ================================================================ */}
        <div className="flex-1 min-h-0 flex flex-col">

          {/* Normal horizontal layout — hidden when agent bar maximized */}
          {!isMaximized && (
            <div className="flex-1 min-h-0 flex overflow-hidden">

              {/* Sidebar toggle + AttentionQueueSidebar */}
              <div className="flex h-full shrink-0" style={{ borderRight: '1px solid hsl(var(--border))' }}>
                <button
                  className="w-4 h-full flex items-center justify-center text-[10px] text-muted-foreground hover:text-foreground transition-colors select-none"
                  onClick={toggleSidebar}
                  title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
                  aria-expanded={sidebarOpen}
                  aria-label="Toggle sidebar"
                  style={{ background: 'hsl(var(--muted) / 0.3)' }}
                >
                  {sidebarOpen ? '\u2039' : '\u203A'}
                </button>
                {sidebarOpen && (
                  activeView === 'design'
                    ? <DesignSidebar
                        decisions={designDecisions}
                        sessionComplete={designStatus === 'complete'}
                        onReviseDecision={(i) => useDesignStore.getState().reviseDecision(i)}
                      />
                    : <AttentionQueueSidebar
                        items={items}
                        gates={gates}
                        activeBuild={activeBuild}
                        onViewChange={handleViewChange}
                        selectedPhase={selectedPhase}
                        onPhaseSelect={setSelectedPhase}
                        selectedTrack={selectedTrack}
                        onTrackSelect={setSelectedTrack}
                        visibleTracks={visibleTracks}
                        onToggleVisibleTrack={(track, allTracks) => setVisibleTracks(prev => {
                          // First toggle: init from all tracks, then remove the unchecked one
                          if (!prev) {
                            const next = new Set(allTracks);
                            next.delete(track);
                            return next;
                          }
                          const next = new Set(prev);
                          if (next.has(track)) next.delete(track);
                          else next.add(track);
                          // If all are checked again, go back to null (show all)
                          if (allTracks && next.size >= allTracks.length) return null;
                          return next;
                        })}
                        onShowAllTracks={() => setVisibleTracks(null)}
                        hiddenGroups={hiddenGroups}
                        onToggleGroup={handleToggleGroup}
                        searchQuery={searchQuery}
                        onSearchChange={setSearchQuery}
                        connected={connected}
                        agentActivity={agentActivity}
                        agentErrors={agentErrors}
                        sessionState={sessionState}
                        onSelectItem={handleSelect}
                        onThemeChange={updateSettings}
                        onNewItem={() => setCreateOpen(true)}
                      />
                )}
              </div>

              {/* Main content area */}
              <main className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
                <div className="flex-1 min-h-0 flex flex-col">
                  <PanelErrorBoundary>
                    <CockpitView
                      activeView={activeView}
                      items={items}
                      filteredItems={filteredItems}
                      phaseFilteredItems={phaseFilteredItems}
                      phaseFilteredGates={phaseFilteredGates}
                      connections={connections}
                      filteredConnections={filteredConnections}
                      sessions={sessions}
                      activeBuild={activeBuild}
                      gates={gates}
                      settings={settings}
                      selectedPhase={selectedPhase}
                      selectedItemId={selectedItemId}
                      onSelect={handleSelect}
                      onUpdate={handleUpdate}
                      onCreate={handleCreate}
                      onDelete={handleDelete}
                      onOpenGate={handleOpenGate}
                      onCreateConnection={handleCreateConnection}
                      onDeleteConnection={handleDeleteConnection}
                      onRefreshBuild={handleRefreshBuild}
                      onSelectStep={handleSelectStep}
                      onResolveGate={resolveGate}
                      onUpdateSettings={updateSettings}
                      onResetSettings={resetSettings}
                      visibleTracks={visibleTracks}
                      hiddenGroups={hiddenGroups}
                      buildStateMap={buildStateMap}
                      docsSelectedFile={docsSelectedFile}
                      onDocsSelectedFileChange={setDocsSelectedFile}
                      docsPreviousView={docsPreviousView}
                      onDocsBack={navigateBackFromDocs}
                      projectRoot={projectRoot}
                    />
                  </PanelErrorBoundary>
                </div>
              </main>

              {/* Context panel — hidden in docs view (docs has its own preview pane) */}
              {activeView !== 'docs' && (
                <PanelErrorBoundary>
                  <ContextPanel
                    isOpen={contextOpen}
                    onToggle={toggleContext}
                    widthPx={contextWidthPx}
                    onResizePx={handleContextResizePx}
                    activeBuild={activeBuild}
                    gates={gates}
                    agentErrors={agentErrors}
                    items={items}
                  >
                    {contextSelection?.type === 'item' && (
                      <ContextItemDetail
                        itemId={contextSelection.id}
                        onSelect={(id) => { setContextSelection({ type: 'item', id }); setSelectedItemId(id); }}
                        onClose={() => { setContextSelection(null); setSelectedItemId(null); }}
                        onOpenFile={navigateToDocs}
                        onViewInGraph={handleViewInGraph}
                        onViewInTree={handleViewInTree}
                      />
                    )}
                    {contextSelection?.type === 'step' && (
                      <ContextStepDetail stepId={contextSelection.id} />
                    )}
                  </ContextPanel>
                </PanelErrorBoundary>
              )}
            </div>
          )}

          {/* ============================================================== */}
          {/* OPS STRIP (COMP-UX-1d)                                           */}
          {/* ============================================================== */}
          <OpsStrip activeView={activeView} onSelectFeature={handleOpsSelectFeature} />

          {/* ============================================================== */}
          {/* AGENT BAR                                                        */}
          {/* ============================================================== */}
          <div
            className={[
              'shrink-0 flex flex-col overflow-hidden',
              isMaximized ? 'flex-1 min-h-0' : agentBarHeightClass(agentBarState),
            ].join(' ')}
          >
            <AgentBar
              barState={agentBarState}
              onStateChange={setAgentBarState}
            />
          </div>
        </div>

        {/* ================================================================ */}
        {/* NOTIFICATION BAR                                                   */}
        {/* ================================================================ */}
        <NotificationBar />

        {/* ================================================================ */}
        {/* GATE NOTIFICATION + MODALS                                         */}
        {/* ================================================================ */}
        <GateNotificationBar onOpenGate={handleOpenGate} />

        {challengeItemId && (() => {
          const challengeItem = items.find(i => i.id === challengeItemId);
          if (!challengeItem) return null;
          return (
            <ChallengeModal
              item={challengeItem}
              items={items}
              connections={connections}
              onUpdate={handleUpdate}
              onClose={() => setChallengeItemId(null)}
            />
          );
        })()}

        <GateToast
          event={gateEvent}
          items={items}
          onNavigate={() => handleViewChange('gates')}
        />

        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          onSelectItem={(id) => { handleSelect(id); setPaletteOpen(false); }}
          onSelectGate={(gateId) => { handleOpenGate(gateId); setPaletteOpen(false); }}
        />

        <ItemFormDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
        />

        <SettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          settings={settings}
          onSettingsChange={updateSettings}
        />
      </div>
    </VisionChangesContext.Provider>
  );
}
