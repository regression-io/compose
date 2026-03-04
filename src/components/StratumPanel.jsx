import { useState } from 'react'
import { RunList, RunDetail, GateQueue, PipelineEditor, GeneratePanel } from '@stratum/ui'

const STRATUM_API = import.meta.env.VITE_STRATUM_API_BASE || 'http://localhost:7821'

const TABS = ['Author', 'Monitor']

export default function StratumPanel() {
  const [tab, setTab] = useState('Author')
  const [selectedRunId, setSelectedRunId] = useState(null)

  return (
    <div className="stratum-panel">
      <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '4px 12px',
              border: '1px solid #ccc',
              borderBottom: tab === t ? '2px solid #333' : '1px solid #ccc',
              background: tab === t ? '#f8f8f8' : '#fff',
              cursor: 'pointer',
              fontSize: '0.85em',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Author' && (
        <div>
          <PipelineEditor apiBase={STRATUM_API} />
          <div style={{ marginTop: 16 }}>
            <GeneratePanel apiBase={STRATUM_API} />
          </div>
        </div>
      )}

      {tab === 'Monitor' && (
        <div>
          <GateQueue
            apiBase={STRATUM_API}
            onApprove={(runId, phase) => console.log('approved', runId, phase)}
            onReject={(runId, phase) => console.log('rejected', runId, phase)}
          />
          <div style={{ marginTop: 16 }}>
            <RunList apiBase={STRATUM_API} onSelect={setSelectedRunId} />
          </div>
          {selectedRunId && (
            <div style={{ marginTop: 16 }}>
              <RunDetail runId={selectedRunId} apiBase={STRATUM_API} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
