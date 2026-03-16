/**
 * ItemFormDialog — quick-type item creation dialog with 5 presets.
 *
 * Dialog primitive from compose/src/components/ui/dialog.jsx (T0.2).
 * Store access: useVisionStore().createItem — NO React Query.
 * Field names: compose conventions (type, title, phase, assignedTo, governance).
 * Phase values from constants.js PHASES.
 *
 * Props: {
 *   open:        boolean
 *   onClose:     () => void
 *   parentItem?: VisionItem  — pre-fills phase when provided
 * }
 */
import React, { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog.jsx';
import { Button } from '@/components/ui/button.jsx';
import { useVisionStore } from '../useVisionStore.js';
import { PHASES, PHASE_LABELS, AGENTS } from '../constants.js';

const QUICK_TYPES = [
  { id: 'task',     label: 'Task',     defaults: { type: 'task',     phase: 'planning',      priority: 1, governance: 'flag' } },
  { id: 'decision', label: 'Decision', defaults: { type: 'decision', phase: 'specification', priority: 2, governance: 'gate' } },
  { id: 'question', label: 'Question', defaults: { type: 'question', phase: 'specification', priority: 1, governance: 'flag' } },
  { id: 'idea',     label: 'Idea',     defaults: { type: 'idea',     phase: 'vision',        priority: 0, governance: 'skip' } },
  { id: 'spec',     label: 'Spec',     defaults: { type: 'spec',     phase: 'specification', priority: 2, governance: 'gate' } },
];

const GOVERNANCE_OPTIONS = ['gate', 'flag', 'skip'];

function initialFormState(parentItem) {
  return {
    type: 'task',
    title: '',
    description: '',
    phase: parentItem?.phase ?? 'planning',
    priority: 1,
    assignedTo: 'unassigned',
    governance: 'flag',
    featureCode: '',
  };
}

export default function ItemFormDialog({ open, onClose, parentItem }) {
  const createItem = useVisionStore(s => s.createItem);
  const [form, setForm] = useState(() => initialFormState(parentItem));
  const [selectedType, setSelectedType] = useState('task');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const titleRef = useRef(null);

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      const next = initialFormState(parentItem);
      setForm(next);
      setSelectedType('task');
      setAdvancedOpen(false);
      setError('');
      setTimeout(() => titleRef.current?.focus(), 50);
    }
  }, [open, parentItem]);

  const applyPreset = (typeId) => {
    const preset = QUICK_TYPES.find(t => t.id === typeId);
    if (!preset) return;
    setSelectedType(typeId);
    setForm(prev => ({
      ...prev,
      type: preset.defaults.type,
      phase: parentItem?.phase ?? preset.defaults.phase,
      priority: preset.defaults.priority,
      governance: preset.defaults.governance,
    }));
  };

  const handleCreate = async () => {
    if (!form.title.trim()) { setError('Title is required'); return; }
    setSubmitting(true);
    setError('');
    try {
      const payload = {
        type: form.type,
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        phase: form.phase || undefined,
        status: 'planned',
        confidence: 0,
        priority: form.priority,
        assignedTo: form.assignedTo !== 'unassigned' ? form.assignedTo : undefined,
        governance: form.governance !== 'flag' ? form.governance : undefined,
        featureCode: form.featureCode.trim() || undefined,
      };
      await createItem(payload);
      onClose();
    } catch (err) {
      setError('Failed to create item');
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
      handleCreate();
    }
  };

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-md" onKeyDown={handleKeyDown}>
        <DialogHeader>
          <DialogTitle>New Item</DialogTitle>
        </DialogHeader>

        <div className="px-6 pb-2 space-y-4">
          {/* Quick-type presets */}
          <div className="grid grid-cols-5 gap-1.5">
            {QUICK_TYPES.map(t => (
              <button
                key={t.id}
                type="button"
                onClick={() => applyPreset(t.id)}
                className={cn(
                  'rounded-md px-2 py-1.5 text-[11px] font-medium border transition-colors',
                  selectedType === t.id
                    ? 'bg-accent/10 border-accent/60 text-accent'
                    : 'border-border/40 text-muted-foreground hover:border-border hover:text-foreground',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Title */}
          <input
            ref={titleRef}
            type="text"
            placeholder="Item title…"
            value={form.title}
            onChange={e => setForm(p => ({ ...p, title: e.target.value }))}
            className="w-full text-sm bg-muted text-foreground px-3 py-2 rounded-md border border-border outline-none focus:border-ring"
          />

          {/* Description */}
          <textarea
            placeholder="Description (optional)…"
            value={form.description}
            onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
            rows={2}
            className="w-full text-sm bg-muted text-foreground px-3 py-2 rounded-md border border-border outline-none focus:border-ring resize-none"
          />

          {/* Advanced collapsible */}
          <button
            type="button"
            onClick={() => setAdvancedOpen(v => !v)}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {advancedOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            Advanced
          </button>

          {advancedOpen && (
            <div className="space-y-3 border border-border/40 rounded-md p-3 bg-muted/20">
              {/* Feature code */}
              <label className="flex flex-col gap-1">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Feature Code</span>
                <input
                  type="text"
                  placeholder="e.g. COMP-UI-5"
                  value={form.featureCode}
                  onChange={e => setForm(p => ({ ...p, featureCode: e.target.value }))}
                  className="text-xs bg-muted text-foreground px-2 py-1 rounded border border-border outline-none"
                />
              </label>

              {/* Phase override */}
              <label className="flex flex-col gap-1">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Phase</span>
                <select
                  value={form.phase}
                  onChange={e => setForm(p => ({ ...p, phase: e.target.value }))}
                  className="text-xs bg-muted text-foreground px-2 py-1 rounded border border-border cursor-pointer"
                >
                  {PHASES.map(ph => (
                    <option key={ph} value={ph}>{PHASE_LABELS[ph] ?? ph}</option>
                  ))}
                </select>
              </label>

              {/* Priority */}
              <label className="flex flex-col gap-1">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Priority</span>
                <select
                  value={form.priority}
                  onChange={e => setForm(p => ({ ...p, priority: Number(e.target.value) }))}
                  className="text-xs bg-muted text-foreground px-2 py-1 rounded border border-border cursor-pointer"
                >
                  <option value={0}>Low (0)</option>
                  <option value={1}>Normal (1)</option>
                  <option value={2}>High (2)</option>
                  <option value={3}>Critical (3)</option>
                </select>
              </label>

              {/* Agent */}
              <label className="flex flex-col gap-1">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Assign to</span>
                <select
                  value={form.assignedTo}
                  onChange={e => setForm(p => ({ ...p, assignedTo: e.target.value }))}
                  className="text-xs bg-muted text-foreground px-2 py-1 rounded border border-border cursor-pointer"
                >
                  {AGENTS.map(a => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </label>

              {/* Governance */}
              <div className="flex flex-col gap-1">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Governance</span>
                <div className="flex gap-1.5">
                  {GOVERNANCE_OPTIONS.map(g => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => setForm(p => ({ ...p, governance: g }))}
                      className={cn(
                        'flex-1 text-[11px] px-2 py-1 rounded border transition-colors',
                        form.governance === g
                          ? g === 'gate'
                            ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                            : g === 'flag'
                              ? 'bg-blue-500/20 text-blue-300 border-blue-500/40'
                              : 'bg-slate-700 text-slate-400 border-slate-600'
                          : 'border-border/40 text-muted-foreground hover:border-border',
                      )}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleCreate} disabled={submitting || !form.title.trim()}>
            {submitting ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
