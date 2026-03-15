/**
 * @deprecated VisionTracker is deprecated. Its logic has been absorbed into App.jsx
 * (flat cockpit layout). This file is kept alive only for PopoutView compatibility.
 * Use VisionChangesContext from './VisionChangesContext.js' instead.
 */
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';

import { VisionChangesContext } from './VisionChangesContext.js';
export { VisionChangesContext };
import { useVisionStore } from './useVisionStore.js';
import AttentionQueueSidebar from './AttentionQueueSidebar.jsx';
import TreeView from './TreeView.jsx';
import GraphView from './GraphView.jsx';
import DocsView from './DocsView.jsx';
import GateView from './GateView.jsx';
import GateToast from './GateToast.jsx';

import ChallengeModal from './ChallengeModal.jsx';
import SettingsPanel from './SettingsPanel.jsx';
import PipelineView from './PipelineView.jsx';
import SessionsView from './SessionsView.jsx';
import CommandPalette      from './shared/CommandPalette.jsx';
import ItemFormDialog      from './shared/ItemFormDialog.jsx';
import SettingsModal       from './shared/SettingsModal.jsx';
import GateNotificationBar from './shared/GateNotificationBar.jsx';

export default function VisionTracker({ onContextSelect, sidebarOpen = true, onToggleSidebar }) {
  const {
    items, connections, connected, uiCommand, clearUICommand, recentChanges,
    createItem, updateItem, deleteItem, createConnection, deleteConnection,
    agentActivity, agentErrors, sessionState, registerSnapshotProvider,
    gates, gateEvent, resolveGate,
    settings, updateSettings, resetSettings,
    activeBuild,
    setActiveBuild,
    sessions,
    // Global phase filter (managed by the store — affects all views)
    selectedPhase, setSelectedPhase,
  } = useVisionStore();

  const [selectedItemId, setSelectedItemId] = useState(() => sessionStorage.getItem('vision-selectedItemId') || null);
  const hadSessionView = useRef(!!sessionStorage.getItem('vision-activeView'));
  const [activeView, setActiveView] = useState(() => sessionStorage.getItem('vision-activeView') || 'roadmap');
  // selectedPhase is now global in useVisionStore — persisted there automatically
  const [searchQuery, setSearchQuery] = useState('');
  const [challengeItemId, setChallengeItemId] = useState(null);
  // COMP-UI-5: interaction component state
  const [paletteOpen,  setPaletteOpen]  = useState(false);
  const [createOpen,   setCreateOpen]   = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Persist local UI state to sessionStorage
  useEffect(() => { sessionStorage.setItem('vision-activeView', activeView); }, [activeView]);
  useEffect(() => {
    if (selectedItemId) sessionStorage.setItem('vision-selectedItemId', selectedItemId);
    else sessionStorage.removeItem('vision-selectedItemId');
  }, [selectedItemId]);

  // Apply settings defaultView on first WS connect (only on fresh sessions)
  const defaultViewApplied = useRef(false);
  useEffect(() => {
    if (settings?.ui?.defaultView && !defaultViewApplied.current && !hadSessionView.current) {
      setActiveView(settings.ui.defaultView);
      defaultViewApplied.current = true;
    }
  }, [settings]);

  // UI commands from server
  useEffect(() => {
    if (!uiCommand) return;
    if (uiCommand.view) setActiveView(uiCommand.view);
    if (uiCommand.phase !== undefined) setSelectedPhase(uiCommand.phase);
    if (uiCommand.select !== undefined) setSelectedItemId(uiCommand.select);
    clearUICommand();
  }, [uiCommand, clearUICommand]);

  // COMP-UI-5: Global keyboard shortcuts (Cmd+K, Cmd+N, comma)
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

  // Filter items by phase + search
  const filteredItems = useMemo(() => {
    let result = items;
    if (selectedPhase) result = result.filter(i => i.phase === selectedPhase);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(i =>
        i.title.toLowerCase().includes(q) ||
        (i.description || '').toLowerCase().includes(q)
      );
    }
    return result;
  }, [items, selectedPhase, searchQuery]);

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

  // Filter connections to match filtered items
  const filteredConnections = useMemo(() => {
    if (!selectedPhase && !searchQuery) return connections;
    const ids = new Set(filteredItems.map(i => i.id));
    return connections.filter(c => ids.has(c.fromId) && ids.has(c.toId));
  }, [connections, filteredItems, selectedPhase, searchQuery]);

  // Register snapshot provider so the store can capture UI state on demand
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

  const handleSelect = useCallback((id) => {
    setSelectedItemId(id);
    if (onContextSelect) {
      onContextSelect({ type: 'item', id });
    }
  }, [onContextSelect]);

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
      setSelectedItemId(result.id);
    }
  }, [createItem, selectedPhase]);

  const handleDelete = useCallback(async (id) => {
    await deleteItem(id);
    if (selectedItemId === id) {
      setSelectedItemId(null);
      if (onContextSelect) onContextSelect(null);
    }
  }, [deleteItem, selectedItemId, onContextSelect]);

  // Open gate's parent item in context panel (preserves current view)
  const handleOpenGate = useCallback((gateId) => {
    const gate = gates.find(g => g.id === gateId);
    if (!gate) return;
    setSelectedItemId(gate.itemId);
    if (onContextSelect) {
      onContextSelect({ type: 'item', id: gate.itemId });
    }
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
    if (onContextSelect) {
      onContextSelect({ type: 'step', id: stepId });
    }
  }, [onContextSelect]);

  return (
    <VisionChangesContext.Provider value={recentChanges}>
    <div className="h-full flex bg-background" data-snapshot-root>
      {/* Sidebar — cockpit-controlled toggle + attention-queue content (COMP-UI-2) */}
      <div className="flex h-full shrink-0" style={{ borderRight: '1px solid hsl(var(--border))' }}>
        {/* Toggle tab — always visible */}
        {onToggleSidebar && (
          <button
            className="w-4 h-full flex items-center justify-center text-[10px] text-muted-foreground hover:text-foreground transition-colors select-none"
            onClick={onToggleSidebar}
            title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            aria-expanded={sidebarOpen}
            aria-label="Toggle sidebar"
            style={{ background: 'hsl(var(--muted) / 0.3)' }}
          >
            {sidebarOpen ? '\u2039' : '\u203A'}
          </button>
        )}
        {/* Sidebar content — hidden when collapsed */}
        {sidebarOpen && (
          <AttentionQueueSidebar
            items={items}
            gates={gates}
            activeBuild={activeBuild}
            activeView={activeView}
            onViewChange={setActiveView}
            selectedPhase={selectedPhase}
            onPhaseSelect={setSelectedPhase}
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

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Connection warning */}
        {!connected && (
          <div className="text-center text-[10px] py-0.5 bg-destructive text-destructive-foreground">
            Disconnected — reconnecting...
          </div>
        )}

        {/* View content */}
        {activeView === 'tree' && (
          <TreeView
            items={filteredItems}
            connections={filteredConnections}
            selectedItemId={selectedItemId}
            onSelect={handleSelect}
          />
        )}
        {activeView === 'graph' && (
          <GraphView
            items={filteredItems}
            connections={filteredConnections}
            selectedItemId={selectedItemId}
            onSelect={handleSelect}
          />
        )}
        {activeView === 'pipeline' && (
          <PipelineView
            activeBuild={activeBuild}
            onSelectStep={handleSelectStep}
            onRefresh={handleRefreshBuild}
          />
        )}
        {activeView === 'sessions' && (
          <SessionsView
            sessions={sessions}
            items={items}
            onSelectItem={handleSelect}
          />
        )}
        {activeView === 'docs' && (
          <DocsView items={phaseFilteredItems} />
        )}
        {activeView === 'gates' && (
          <GateView
            gates={phaseFilteredGates}
            items={phaseFilteredItems}
            onResolve={resolveGate}
            onSelect={handleSelect}
          />
        )}
        {activeView === 'settings' && (
          <SettingsPanel
            settings={settings}
            onSettingsChange={updateSettings}
            onReset={resetSettings}
          />
        )}
      </div>

      {/* COMP-UI-5: Gate notification bar — persistent bottom bar above detail panel */}
      <GateNotificationBar onOpenGate={handleOpenGate} />

      {/* Detail panel — now rendered in cockpit ContextPanel via ContextItemDetail */}

      {/* Challenge modal */}
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
        onNavigate={() => setActiveView('gates')}
      />
      {/* COMP-UI-5: Interaction components */}
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
