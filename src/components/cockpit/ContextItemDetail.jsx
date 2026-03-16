/**
 * ContextItemDetail — renders item detail with tabbed sections inside the cockpit ContextPanel.
 *
 * Pulls all data from useVisionStore() so App.jsx doesn't need to thread the entire store.
 * COMP-UX-1b: Added DetailTabs with Overview/Pipeline/Sessions/Errors/Files sections.
 *
 * Props:
 *   itemId   {string}  the vision item ID to display
 *   onSelect {fn}      called when user navigates to a related item (updates contextSelection)
 *   onClose  {fn}      called to clear contextSelection
 *   onOpenFile {fn}    called when user clicks a file (navigates to DocsView)
 */
import React, { useState, useMemo } from 'react';
import { useVisionStore } from '../vision/useVisionStore.js';
import { useShallow } from 'zustand/react/shallow';
import ItemDetailPanel from '../vision/ItemDetailPanel.jsx';
import DetailTabs from './DetailTabs.jsx';
import ContextPipelineDots from '../vision/ContextPipelineDots.jsx';
import ContextSessionsTable from '../vision/ContextSessionsTable.jsx';
import ContextErrorLog from '../vision/ContextErrorLog.jsx';
import ContextFilesTab from '../vision/ContextFilesTab.jsx';

export default function ContextItemDetail({ itemId, onSelect, onClose, onOpenFile, onViewInGraph, onViewInTree }) {
  const {
    items, connections, gates, updateItem, deleteItem,
    createConnection, deleteConnection, resolveGate,
    activeBuild, sessions, agentErrors,
  } = useVisionStore(useShallow(s => ({
    items: s.items, connections: s.connections, gates: s.gates,
    updateItem: s.updateItem, deleteItem: s.deleteItem,
    createConnection: s.createConnection, deleteConnection: s.deleteConnection,
    resolveGate: s.resolveGate, activeBuild: s.activeBuild,
    sessions: s.sessions, agentErrors: s.agentErrors,
  })));

  const item = items.find(i => i.id === itemId) || null;
  const [activeDetailTab, setActiveDetailTab] = useState('overview');

  // Resolve canonical feature code — lifecycle is the authoritative source
  const featureCode = item?.lifecycle?.featureCode || item?.featureCode || item?.feature_code || '';
  const featureErrors = useMemo(() => {
    if (!featureCode) return [];
    return agentErrors.filter(e =>
      e.featureCode === featureCode ||
      (featureCode && e.message && e.message.includes(featureCode))
    );
  }, [agentErrors, featureCode]);

  if (!item) {
    return (
      <div className="p-3 text-[11px] text-muted-foreground italic">
        Item not found.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <DetailTabs
        activeTab={activeDetailTab}
        onTabChange={setActiveDetailTab}
        errorCount={featureErrors.length}
      />
      <div className="flex-1 min-h-0 overflow-auto">
        {activeDetailTab === 'overview' && (
          <>
            <ItemDetailPanel
              item={item}
              items={items}
              connections={connections}
              gates={gates}
              onUpdate={(id, data) => updateItem(id, data)}
              onDelete={(id) => {
                deleteItem(id);
                onClose();
              }}
              onCreateConnection={createConnection}
              onDeleteConnection={deleteConnection}
              onSelect={onSelect}
              onClose={onClose}
              onPressureTest={() => {}}
              onResolveGate={resolveGate}
            />
            {/* COMP-UX-1e: View in Graph / View in Tree navigation links */}
            <div
              className="flex items-center gap-3 px-4 py-2 mt-1"
              style={{ borderTop: '1px solid hsl(var(--border))' }}
            >
              {onViewInGraph && (
                <button
                  onClick={() => onViewInGraph(itemId)}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  <span style={{ fontSize: 10 }}>{'\u2191'}</span> View in Graph
                </button>
              )}
              {onViewInTree && (
                <button
                  onClick={() => onViewInTree(itemId)}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  <span style={{ fontSize: 10 }}>{'\u2193'}</span> View in Tree
                </button>
              )}
            </div>
          </>
        )}
        {activeDetailTab === 'pipeline' && (
          <ContextPipelineDots item={item} activeBuild={activeBuild} />
        )}
        {activeDetailTab === 'sessions' && (
          <ContextSessionsTable featureCode={featureCode} sessions={sessions} items={items} />
        )}
        {activeDetailTab === 'errors' && (
          <ContextErrorLog featureCode={featureCode} errors={agentErrors} items={items} />
        )}
        {activeDetailTab === 'files' && (
          <ContextFilesTab featureCode={featureCode} onOpenFile={onOpenFile} />
        )}
      </div>
    </div>
  );
}
