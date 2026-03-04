import { useState } from 'react'
import { RunDetail, GateQueue } from '@stratum/ui'

const STRATUM_API = import.meta.env.VITE_STRATUM_API_BASE || 'http://localhost:7821'

export default function StratumPanel() {
  const [selectedRunId, setSelectedRunId] = useState(null)

  return (
    <div className="stratum-panel">
      <GateQueue
        apiBase={STRATUM_API}
        onApprove={(runId, phase) => console.log('approved', runId, phase)}
        onReject={(runId, phase) => console.log('rejected', runId, phase)}
        onSelect={setSelectedRunId}
      />
      {selectedRunId && (
        <RunDetail runId={selectedRunId} apiBase={STRATUM_API} />
      )}
    </div>
  )
}
