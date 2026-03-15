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
import ItemDetailPanel from '../vision/ItemDetailPanel.jsx';
import DetailTabs from './DetailTabs.jsx';
import ContextPipelineDots from '../vision/ContextPipelineDots.jsx';
import ContextSessionsTable from '../vision/ContextSessionsTable.jsx';
import ContextErrorLog from '../vision/ContextErrorLog.jsx';
import ContextFilesTab from '../vision/ContextFilesTab.jsx';

export default function ContextItemDetail({ itemId, onSelect, onClose, onOpenFile }) {
  const {
    items,
    connections,
    gates,
    updateItem,
    deleteItem,
    createConnection,
    deleteConnection,
    resolveGate,
    activeBuild,
    sessions,
    agentErrors,
  } = useVisionStore();

  const item = items.find(i => i.id === itemId) || null;
  const [activeDetailTab, setActiveDetailTab] = useState('overview');

  // Compute error count for this feature
  const featureCode = item?.featureCode || item?.text || '';
  const featureErrors = useMemo(() => {
    if (!featureCode) return [];
    return agentErrors.filter(e =>
      e.featureCode === featureCode ||
      (e.message && e.message.includes(featureCode))
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
