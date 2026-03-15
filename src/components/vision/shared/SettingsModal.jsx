/**
 * SettingsModal — governance policy configuration modal.
 *
 * Dialog primitive from compose/src/components/ui/dialog.jsx (T0.2).
 * Store access: settings (live from WebSocket), updateSettings (PATCH /api/settings).
 * SettingsPanel.jsx is UNCHANGED — this modal is additive.
 *
 * Phase rows use LIFECYCLE_PHASE_LABELS (constants.js:48–61).
 * explore_design row is grayed — no toggle (no policy applies to that step).
 * Remaining 9 phases: gate | flag | skip toggle button group.
 * Immediate save on toggle click. "Saved ✓" for 1.5 s.
 *
 * Props: {
 *   open:             boolean
 *   onClose:          () => void
 *   settings:         object   — from useVisionStore().settings
 *   onSettingsChange: (patch) => void  — from useVisionStore().updateSettings
 * }
 */
import React, { useState, useRef, useCallback } from 'react';
import { ShieldCheck, Eye, SkipForward } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog.jsx';
import { LIFECYCLE_PHASE_LABELS } from '../constants.js';

// Lifecycle phases for governance (explore_design is display-only)
const GOVERNANCE_PHASES = [
  'explore_design',
  'prd',
  'architecture',
  'blueprint',
  'verification',
  'plan',
  'execute',
  'report',
  'docs',
  'ship',
];

const GOVERNANCE_OPTIONS = [
  { id: 'gate', Icon: ShieldCheck, label: 'Gate',
    active: 'bg-amber-500/20 text-amber-300 border-amber-500/40' },
  { id: 'flag', Icon: Eye,         label: 'Flag',
    active: 'bg-blue-500/20 text-blue-300 border-blue-500/40'   },
  { id: 'skip', Icon: SkipForward, label: 'Skip',
    active: 'bg-slate-700 text-slate-400 border-slate-600'       },
];

function getPhasePolicy(settings, phase) {
  return settings?.governance?.phases?.[phase] ?? 'flag';
}

export default function SettingsModal({ open, onClose, settings, onSettingsChange }) {
  const [savedFlash, setSavedFlash] = useState(false);
  const flashTimer = useRef(null);

  const handleToggle = useCallback((phase, value) => {
    onSettingsChange?.({ governance: { phases: { [phase]: value } } });
    clearTimeout(flashTimer.current);
    setSavedFlash(true);
    flashTimer.current = setTimeout(() => setSavedFlash(false), 1500);
  }, [onSettingsChange]);

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <div className="flex items-center justify-between pr-6">
            <DialogTitle>Governance Settings</DialogTitle>
            {savedFlash && (
              <span className="text-[11px] text-emerald-400 font-medium">Saved ✓</span>
            )}
          </div>
        </DialogHeader>

        <div className="px-6 pb-6 space-y-1 max-h-96 overflow-y-auto">
          {GOVERNANCE_PHASES.map(phase => {
            const isExploreDesign = phase === 'explore_design';
            const currentPolicy = getPhasePolicy(settings, phase);
            const phaseLabel = LIFECYCLE_PHASE_LABELS[phase] ?? phase;

            return (
              <div
                key={phase}
                className={cn(
                  'flex items-center gap-3 rounded-md px-2 py-1.5',
                  isExploreDesign && 'opacity-40',
                )}
              >
                {/* Phase label */}
                <span className={cn(
                  'text-xs flex-1 min-w-0 truncate',
                  isExploreDesign ? 'text-muted-foreground' : 'text-foreground',
                )}>
                  {phaseLabel}
                </span>

                {/* Toggle buttons */}
                {isExploreDesign ? (
                  <span className="text-[10px] text-muted-foreground italic">no policy</span>
                ) : (
                  <div className="flex gap-1 shrink-0">
                    {GOVERNANCE_OPTIONS.map(opt => {
                      const isActive = currentPolicy === opt.id;
                      const { Icon } = opt;
                      return (
                        <button
                          key={opt.id}
                          onClick={() => handleToggle(phase, opt.id)}
                          title={opt.label}
                          className={cn(
                            'flex items-center gap-1 px-2 py-0.5 text-[10px] rounded border transition-colors',
                            isActive
                              ? opt.active
                              : 'border-border/30 text-muted-foreground hover:border-border hover:text-foreground',
                          )}
                        >
                          <Icon className="h-2.5 w-2.5" />
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer note */}
        <div className="px-6 pb-4 text-[10px] text-muted-foreground border-t border-border/30 pt-3">
          Agent config via Compose CLI
        </div>
      </DialogContent>
    </Dialog>
  );
}
