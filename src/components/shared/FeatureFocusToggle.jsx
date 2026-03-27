import React from 'react';

export default function FeatureFocusToggle({ featureCode, active, onToggle }) {
  if (!featureCode) return null;
  return (
    <button onClick={onToggle} style={{
      fontSize: 11, padding: '3px 9px', borderRadius: 4, cursor: 'pointer',
      transition: 'all 0.15s',
      border: `1px solid ${active ? '#f59e0b' : '#334155'}`,
      background: active ? '#f59e0b20' : '#1e293b',
      color: active ? '#f59e0b' : '#94a3b8',
    }}>
      Focus: {featureCode}
    </button>
  );
}
