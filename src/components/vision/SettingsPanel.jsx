import React, { useCallback, useState, useEffect } from 'react';
import { LIFECYCLE_PHASE_LABELS } from './constants.js';

const POLICY_PHASES = [
  'explore_design', 'prd', 'architecture', 'blueprint', 'verification',
  'plan', 'execute', 'report', 'docs', 'ship',
];
const POLICY_MODES = ['gate', 'flag', 'skip'];
const THEMES = ['light', 'dark', 'system'];
const VIEWS = ['attention', 'gates', 'roadmap', 'list', 'board', 'tree', 'graph', 'docs', 'settings'];

function Section({ title, children }) {
  return (
    <div className="mb-6">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">{title}</h3>
      {children}
    </div>
  );
}

function FieldRow({ label, children }) {
  return (
    <div className="flex items-center justify-between py-1.5 px-1">
      <label className="text-sm text-foreground">{label}</label>
      {children}
    </div>
  );
}

function ModelInput({ value: propValue, className, onCommit }) {
  const [local, setLocal] = useState(propValue || '');
  useEffect(() => { setLocal(propValue || ''); }, [propValue]);
  return (
    <input
      type="text"
      className={className}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => { if (local.trim() && local.trim() !== propValue) onCommit(local.trim()); }}
    />
  );
}

export default function SettingsPanel({ settings, onSettingsChange, onReset }) {
  if (!settings) {
    return <div className="p-6 text-sm text-muted-foreground">Loading settings...</div>;
  }

  const handlePolicy = useCallback((phase, value) => {
    const mode = value === 'null' ? null : value;
    onSettingsChange({ policies: { [phase]: mode } });
  }, [onSettingsChange]);

  const handleIteration = useCallback((type, value) => {
    const n = parseInt(value, 10);
    if (n >= 1 && n <= 100) {
      onSettingsChange({ iterations: { [type]: { maxIterations: n } } });
    }
  }, [onSettingsChange]);

  const handleModel = useCallback((key, value) => {
    if (value.trim()) {
      onSettingsChange({ models: { [key]: value.trim() } });
    }
  }, [onSettingsChange]);

  const handleTheme = useCallback((value) => {
    onSettingsChange({ ui: { theme: value } });
    // Apply to DOM immediately
    if (value === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.classList.toggle('dark', prefersDark);
      localStorage.removeItem('compose:theme');
    } else {
      document.documentElement.classList.toggle('dark', value === 'dark');
      localStorage.setItem('compose:theme', value);
    }
  }, [onSettingsChange]);

  const handleDefaultView = useCallback((value) => {
    onSettingsChange({ ui: { defaultView: value } });
  }, [onSettingsChange]);

  const handleReset = useCallback(() => {
    if (window.confirm('Reset all settings to defaults?')) {
      onReset();
    }
  }, [onReset]);

  const selectClass = "h-7 text-xs rounded-md border border-input bg-background px-2 py-1";
  const inputClass = "h-7 text-xs rounded-md border border-input bg-background px-2 py-1 w-24";

  return (
    <div className="flex-1 overflow-auto p-6 max-w-2xl">
      <h2 className="text-lg font-semibold mb-4">Settings</h2>

      <Section title="Phase Policies">
        {POLICY_PHASES.map(phase => (
          <FieldRow key={phase} label={LIFECYCLE_PHASE_LABELS[phase] || phase}>
            <select
              className={selectClass}
              value={settings.policies[phase] === null ? 'null' : (settings.policies[phase] || 'skip')}
              onChange={(e) => handlePolicy(phase, e.target.value)}
            >
              {phase === 'explore_design' && <option value="null">—</option>}
              {POLICY_MODES.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </FieldRow>
        ))}
      </Section>

      <Section title="Iteration Limits">
        <FieldRow label="Review max iterations">
          <input
            type="number"
            className={inputClass}
            min={1} max={100}
            value={settings.iterations?.review?.maxIterations ?? 10}
            onChange={(e) => handleIteration('review', e.target.value)}
          />
        </FieldRow>
        <FieldRow label="Coverage max iterations">
          <input
            type="number"
            className={inputClass}
            min={1} max={100}
            value={settings.iterations?.coverage?.maxIterations ?? 15}
            onChange={(e) => handleIteration('coverage', e.target.value)}
          />
        </FieldRow>
      </Section>

      <Section title="Agent Models">
        {['interactive', 'agentRun', 'summarizer'].map(key => (
          <FieldRow key={key} label={key}>
            <ModelInput
              key={key}
              className={inputClass + " w-48"}
              value={settings.models?.[key] || ''}
              onCommit={(val) => handleModel(key, val)}
            />
          </FieldRow>
        ))}
      </Section>

      <Section title="Appearance">
        <FieldRow label="Theme">
          <select
            className={selectClass}
            value={settings.ui?.theme || 'system'}
            onChange={(e) => handleTheme(e.target.value)}
          >
            {THEMES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </FieldRow>
        <FieldRow label="Default view">
          <select
            className={selectClass}
            value={settings.ui?.defaultView || 'attention'}
            onChange={(e) => handleDefaultView(e.target.value)}
          >
            {VIEWS.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </FieldRow>
      </Section>

      <button
        onClick={handleReset}
        className="text-xs text-destructive hover:underline mt-2"
      >
        Reset to Defaults
      </button>
    </div>
  );
}
