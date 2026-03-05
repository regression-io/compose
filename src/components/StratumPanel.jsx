import { useState, useEffect, useCallback } from 'react'

// All stratum routes are served by the compose server at the same origin.
const API = '/api/stratum'

// ---------------------------------------------------------------------------
// Data fetching helpers
// ---------------------------------------------------------------------------

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  })
  return res.json()
}

function post(path, body) {
  return apiFetch(path, { method: 'POST', body: JSON.stringify(body) })
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ status }) {
  const colors = {
    running:       'var(--compose-raised, #2a2a2a)',
    awaiting_gate: '#7c3aed',
    complete:      '#166534',
    killed:        '#7f1d1d',
    blocked:       '#7f1d1d',
  }
  const labels = {
    running: 'running', awaiting_gate: 'gate pending',
    complete: 'complete', killed: 'killed', blocked: 'blocked',
  }
  return (
    <span style={{
      fontSize: '0.72em', padding: '2px 6px', borderRadius: 4,
      background: colors[status] || '#333', color: '#e5e7eb',
      textTransform: 'uppercase', letterSpacing: '0.05em',
    }}>
      {labels[status] || status}
    </span>
  )
}

function Spinner() {
  return <span style={{ opacity: 0.5, fontSize: '0.85em' }}>loading…</span>
}

// ---------------------------------------------------------------------------
// Gate Queue
// ---------------------------------------------------------------------------

function GateQueue({ onAction }) {
  const [gates, setGates] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState({})
  const [notes, setNotes] = useState({})

  const load = useCallback(() => {
    apiFetch('/gates')
      .then(data => { setGates(Array.isArray(data) ? data : []); setError(null) })
      .catch(err => setError(err.message))
  }, [])

  useEffect(() => { load(); const t = setInterval(load, 10_000); return () => clearInterval(t) }, [load])

  async function act(flowId, stepId, action) {
    const key = `${flowId}/${stepId}/${action}`
    setBusy(b => ({ ...b, [key]: true }))
    const note = notes[`${flowId}/${stepId}`] || ''
    try {
      const result = await post(`/gates/${flowId}/${stepId}/${action}`, { note })
      if (result.conflict) {
        setError(`Gate already resolved (${flowId}/${stepId})`)
      } else if (result.error) {
        setError(result.error.message)
      } else {
        onAction?.()
        load()
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(b => ({ ...b, [key]: false }))
    }
  }

  if (gates === null && !error) return <Spinner />

  return (
    <section>
      <h3 style={{ fontSize: '0.8em', textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.5, margin: '0 0 8px' }}>
        Pending Gates {gates?.length > 0 && <span style={{ opacity: 1, color: '#f59e0b' }}>({gates.length})</span>}
      </h3>
      {error && <p style={{ color: '#ef4444', fontSize: '0.8em', margin: '0 0 8px' }}>{error}</p>}
      {gates?.length === 0 && <p style={{ opacity: 0.4, fontSize: '0.85em' }}>No pending gates.</p>}
      {gates?.map(g => {
        const gkey = `${g.flow_id}/${g.step_id}`
        const isBusy = (a) => busy[`${gkey}/${a}`]
        return (
          <div key={gkey} style={{
            border: '1px solid #3f3f46', borderRadius: 6, padding: '10px 12px',
            marginBottom: 8, background: '#18181b',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontWeight: 600, fontSize: '0.9em' }}>{g.flow_name || g.flow_id}</span>
              <span style={{ opacity: 0.4, fontSize: '0.8em' }}>›</span>
              <span style={{ fontFamily: 'monospace', fontSize: '0.82em', opacity: 0.7 }}>{g.step_id}</span>
              {g.function && <span style={{ opacity: 0.4, fontSize: '0.78em' }}>fn:{g.function}</span>}
            </div>
            <input
              type="text"
              placeholder="Note (optional)"
              value={notes[gkey] || ''}
              onChange={e => setNotes(n => ({ ...n, [gkey]: e.target.value }))}
              style={{
                width: '100%', boxSizing: 'border-box', marginBottom: 8,
                background: '#27272a', border: '1px solid #3f3f46', borderRadius: 4,
                color: '#e4e4e7', padding: '4px 8px', fontSize: '0.82em',
              }}
            />
            <div style={{ display: 'flex', gap: 6 }}>
              {[
                { a: 'approve', label: 'Approve', color: '#166534', hover: '#15803d' },
                { a: 'reject',  label: 'Reject',  color: '#7f1d1d', hover: '#b91c1c' },
                { a: 'revise',  label: 'Revise',  color: '#1e3a5f', hover: '#1d4ed8' },
              ].map(({ a, label, color }) => (
                <button
                  key={a}
                  disabled={isBusy(a)}
                  onClick={() => act(g.flow_id, g.step_id, a)}
                  style={{
                    padding: '4px 12px', fontSize: '0.8em', borderRadius: 4, border: 'none',
                    background: color, color: '#e5e7eb', cursor: isBusy(a) ? 'not-allowed' : 'pointer',
                    opacity: isBusy(a) ? 0.5 : 1,
                  }}
                >
                  {isBusy(a) ? '…' : label}
                </button>
              ))}
            </div>
          </div>
        )
      })}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Flow List + Detail
// ---------------------------------------------------------------------------

function FlowDetail({ flowId, onClose }) {
  const [flow, setFlow] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    apiFetch(`/flows/${flowId}`)
      .then(data => { if (data.error) setError(data.error.message); else setFlow(data) })
      .catch(e => setError(e.message))
  }, [flowId])

  return (
    <div style={{ border: '1px solid #3f3f46', borderRadius: 6, padding: '10px 12px', background: '#18181b' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontWeight: 600, fontSize: '0.9em' }}>{flow?.flow_name || flowId}</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: '1.1em' }}>✕</button>
      </div>
      {error && <p style={{ color: '#ef4444', fontSize: '0.8em' }}>{error}</p>}
      {!flow && !error && <Spinner />}
      {flow && (
        <div style={{ fontSize: '0.82em', opacity: 0.8 }}>
          <div style={{ display: 'flex', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
            <span><StatusBadge status={flow.status} /></span>
            <span>steps {flow.completed_steps}/{flow.step_count}</span>
            {flow.round > 0 && <span>round {flow.round}</span>}
          </div>
          {Array.isArray(flow.ordered_steps) && flow.ordered_steps.length > 0 && (
            <ol style={{ margin: 0, padding: '0 0 0 18px', lineHeight: 1.7 }}>
              {flow.ordered_steps.map((s, i) => (
                <li key={s.id} style={{ opacity: i < flow.completed_steps ? 0.4 : 1 }}>
                  <span style={{ fontFamily: 'monospace' }}>{s.id}</span>
                  {s.mode === 'gate' && <span style={{ marginLeft: 6, color: '#f59e0b', fontSize: '0.9em' }}>gate</span>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  )
}

function FlowList() {
  const [flows, setFlows] = useState(null)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)

  const load = useCallback(() => {
    apiFetch('/flows')
      .then(data => { setFlows(Array.isArray(data) ? data : []); setError(null) })
      .catch(err => setError(err.message))
  }, [])

  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t) }, [load])

  if (flows === null && !error) return <Spinner />

  return (
    <section>
      <h3 style={{ fontSize: '0.8em', textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.5, margin: '0 0 8px' }}>
        Flows
      </h3>
      {error && <p style={{ color: '#ef4444', fontSize: '0.8em' }}>{error}</p>}
      {flows?.length === 0 && <p style={{ opacity: 0.4, fontSize: '0.85em' }}>No flows found.</p>}
      {flows?.map(f => (
        <div
          key={f.flow_id}
          onClick={() => setSelected(selected === f.flow_id ? null : f.flow_id)}
          style={{
            border: `1px solid ${selected === f.flow_id ? '#6366f1' : '#3f3f46'}`,
            borderRadius: 6, padding: '8px 12px', marginBottom: 6,
            background: selected === f.flow_id ? '#1e1b4b' : '#18181b',
            cursor: 'pointer',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.88em', fontWeight: 500 }}>{f.flow_name || f.flow_id}</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: '0.78em', opacity: 0.5 }}>{f.completed_steps}/{f.step_count}</span>
              <StatusBadge status={f.status} />
            </div>
          </div>
        </div>
      ))}
      {selected && (
        <div style={{ marginTop: 8 }}>
          <FlowDetail flowId={selected} onClose={() => setSelected(null)} />
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Root panel
// ---------------------------------------------------------------------------

export default function StratumPanel() {
  return (
    <div style={{ padding: '12px 14px', color: '#e4e4e7', fontSize: '0.9em', overflowY: 'auto', height: '100%' }}>
      <GateQueue />
      <div style={{ marginTop: 20 }}>
        <FlowList />
      </div>
    </div>
  )
}
