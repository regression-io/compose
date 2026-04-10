/**
 * IdeaboxPromoteDialog — 3-step wizard for promoting an idea to a feature.
 *
 * Step 1: Choose feature ID (text input with auto-suggestion based on cluster)
 * Step 2: Preview generated plan.md stub (template + idea details)
 * Step 3: Confirm — calls POST /api/ideabox/ideas/:id/promote
 *         Visual confirmation with feature code shown.
 *
 * Follows ItemFormDialog patterns (Dialog primitive, Button, same class conventions).
 */

import React, { useState, useEffect, useRef } from 'react';
import { ChevronRight, ChevronLeft, Check, Lightbulb } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog.jsx';
import { Button } from '@/components/ui/button.jsx';
import { Badge } from '@/components/ui/badge.jsx';
import { useIdeaboxStore } from './useIdeaboxStore.js';

// ---------------------------------------------------------------------------
// Feature ID suggestion based on cluster
// ---------------------------------------------------------------------------

function suggestFeatureId(idea) {
  if (!idea) return '';
  // Cluster-based: "UX improvements" → "UX", "Core" → "CORE", etc.
  const cluster = idea.cluster || '';
  const clusterSlug = cluster
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 8);

  // Fall back to tag-based
  if (!clusterSlug) {
    const tag = (idea.tags?.[0] || '').replace('#', '').toUpperCase().slice(0, 6);
    if (tag) return `${tag}-1`;
    return 'FEAT-1';
  }
  return `${clusterSlug}-1`;
}

// ---------------------------------------------------------------------------
// Plan template generator
// ---------------------------------------------------------------------------

function generatePlanStub(idea, featureCode) {
  const today = new Date().toISOString().slice(0, 10);
  const tags = (idea.tags || []).join(', ') || 'N/A';
  return `# ${featureCode}: ${idea.title}

**Date:** ${today}
**Promoted from:** ${idea.id}
**Priority:** ${idea.priority || 'TBD'}
**Tags:** ${tags}

## Context

${idea.description || idea.title}

## Source

${idea.source || 'Internal idea'}

## Goals

- [ ] Define acceptance criteria
- [ ] Identify affected components
- [ ] Estimate effort

## Related

${idea.mapsTo ? `- Maps to: ${idea.mapsTo}` : '- TBD'}
`.trimStart();
}

// ---------------------------------------------------------------------------
// Step indicators
// ---------------------------------------------------------------------------

function StepIndicator({ step, current }) {
  const done = current > step;
  const active = current === step;
  return (
    <div className="flex items-center gap-1.5">
      <div className={cn(
        'w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-semibold border transition-colors',
        done ? 'bg-emerald-400/20 border-emerald-400/60 text-emerald-400'
          : active ? 'bg-accent/20 border-accent/60 text-accent'
          : 'bg-muted border-border/40 text-muted-foreground/40',
      )}>
        {done ? <Check className="w-3 h-3" /> : step}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// IdeaboxPromoteDialog
// ---------------------------------------------------------------------------

export default function IdeaboxPromoteDialog({ idea, onClose }) {
  const { promoteIdea } = useIdeaboxStore();

  const [step, setStep] = useState(1);
  const [featureCode, setFeatureCode] = useState(() => suggestFeatureId(idea));
  const [featureCodeError, setFeatureCodeError] = useState('');
  const [planPreview, setPlanPreview] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null); // { featureCode } on success
  const inputRef = useRef(null);

  // Update plan preview whenever featureCode changes
  useEffect(() => {
    setPlanPreview(generatePlanStub(idea, featureCode || 'FEAT-?'));
  }, [idea, featureCode]);

  // Auto-focus input on step 1
  useEffect(() => {
    if (step === 1) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [step]);

  const validateStep1 = () => {
    if (!featureCode.trim()) {
      setFeatureCodeError('Feature code is required');
      return false;
    }
    // Basic format check: uppercase letters, hyphens, numbers
    if (!/^[A-Z0-9][A-Z0-9-]*[A-Z0-9]$/i.test(featureCode.trim())) {
      setFeatureCodeError('Use format like FEAT-1 or COMP-UI-5');
      return false;
    }
    setFeatureCodeError('');
    return true;
  };

  const handleNext = () => {
    if (step === 1 && !validateStep1()) return;
    setStep(s => s + 1);
  };

  const handleBack = () => setStep(s => s - 1);

  const handleConfirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await promoteIdea(idea.id, featureCode.trim().toUpperCase());
      setResult({ featureCode: featureCode.trim().toUpperCase() });
      setStep(4); // completion step
    } catch (err) {
      setFeatureCodeError(err.message || 'Failed to promote');
      setStep(1);
    } finally {
      setSubmitting(false);
    }
  };

  const STEP_LABELS = ['Feature ID', 'Preview', 'Confirm'];

  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lightbulb className="w-4 h-4 text-amber-400" />
            Promote to Feature
          </DialogTitle>
        </DialogHeader>

        {/* Step indicators */}
        {step < 4 && (
          <div className="px-6 -mt-1 mb-1">
            <div className="flex items-center gap-2">
              {[1, 2, 3].map((s, i) => (
                <React.Fragment key={s}>
                  <StepIndicator step={s} current={step} />
                  <span className={cn(
                    'text-[10px] transition-colors',
                    step === s ? 'text-foreground font-medium' : 'text-muted-foreground/60',
                  )}>
                    {STEP_LABELS[i]}
                  </span>
                  {i < 2 && <ChevronRight className="w-3 h-3 text-muted-foreground/30 mx-0.5" />}
                </React.Fragment>
              ))}
            </div>
          </div>
        )}

        <div className="px-6 pb-2">
          {/* Idea summary */}
          {step < 4 && (
            <div className="mb-4 px-3 py-2 rounded border border-border/50 bg-muted/20">
              <div className="flex items-center gap-2 mb-0.5">
                <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 font-mono opacity-70">
                  {idea.id}
                </Badge>
                {idea.priority && idea.priority !== '—' && (
                  <span className={cn(
                    'text-[9px] px-1 py-0.5 rounded font-mono font-semibold',
                    idea.priority === 'P0' ? 'text-red-400' : idea.priority === 'P1' ? 'text-amber-400' : 'text-blue-400',
                  )}>
                    {idea.priority}
                  </span>
                )}
              </div>
              <p className="text-[12px] text-foreground font-medium leading-snug">{idea.title}</p>
            </div>
          )}

          {/* Step 1: Feature ID */}
          {step === 1 && (
            <div className="space-y-3">
              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold block mb-1.5">
                  Feature Code
                </span>
                <input
                  ref={inputRef}
                  type="text"
                  value={featureCode}
                  onChange={e => { setFeatureCode(e.target.value.toUpperCase()); setFeatureCodeError(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') handleNext(); }}
                  placeholder="e.g. COMP-UI-5"
                  className="w-full text-sm bg-muted text-foreground px-3 py-2 rounded-md border border-border outline-none focus:border-ring font-mono"
                />
                {featureCodeError && (
                  <p className="text-[11px] text-destructive mt-1">{featureCodeError}</p>
                )}
              </label>

              {idea.cluster && (
                <p className="text-[10px] text-muted-foreground/60">
                  Suggested from cluster: <span className="text-muted-foreground">{idea.cluster}</span>
                </p>
              )}

              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1.5">
                  Suggestions
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {[suggestFeatureId(idea), `COMP-${(idea.tags?.[0] || 'FEAT').replace('#', '').toUpperCase()}-1`]
                    .filter((v, i, a) => a.indexOf(v) === i)
                    .map(s => (
                      <button
                        key={s}
                        onClick={() => { setFeatureCode(s); setFeatureCodeError(''); }}
                        className={cn(
                          'text-[10px] px-2 py-1 rounded border font-mono transition-colors',
                          featureCode === s
                            ? 'bg-accent/10 border-accent/60 text-accent'
                            : 'border-border/40 text-muted-foreground hover:border-border hover:text-foreground',
                        )}
                      >
                        {s}
                      </button>
                    ))}
                </div>
              </div>
            </div>
          )}

          {/* Step 2: Preview */}
          {step === 2 && (
            <div className="space-y-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                Generated plan.md stub
              </p>
              <pre className="text-[10px] font-mono text-muted-foreground bg-muted/40 border border-border/40 rounded p-3 overflow-auto max-h-48 whitespace-pre-wrap leading-relaxed">
                {planPreview}
              </pre>
              <p className="text-[10px] text-muted-foreground/60">
                This stub will be created when you run the promote workflow from the CLI.
              </p>
            </div>
          )}

          {/* Step 3: Confirm */}
          {step === 3 && (
            <div className="space-y-3">
              <p className="text-[12px] text-muted-foreground">
                Promote <span className="text-foreground font-medium">{idea.id}</span> to feature{' '}
                <span className="font-mono text-accent font-semibold">{featureCode}</span>?
              </p>
              <p className="text-[11px] text-muted-foreground/70">
                The idea will be marked <span className="font-mono">PROMOTED ({featureCode})</span> in the ideabox.
              </p>
            </div>
          )}

          {/* Step 4: Success */}
          {step === 4 && result && (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <div className="w-10 h-10 rounded-full bg-emerald-400/20 flex items-center justify-center">
                <Check className="w-5 h-5 text-emerald-400" />
              </div>
              <p className="text-sm font-semibold text-foreground">Promoted!</p>
              <p className="text-[12px] text-muted-foreground">
                {idea.id} is now linked to feature{' '}
                <span className="font-mono text-accent font-semibold">{result.featureCode}</span>
              </p>
              <Button size="sm" onClick={onClose} className="mt-1">Close</Button>
            </div>
          )}
        </div>

        {step < 4 && (
          <DialogFooter>
            {step > 1 && (
              <Button variant="ghost" size="sm" onClick={handleBack} disabled={submitting}>
                <ChevronLeft className="w-3 h-3 mr-1" />
                Back
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            {step < 3 ? (
              <Button size="sm" onClick={handleNext}>
                Next
                <ChevronRight className="w-3 h-3 ml-1" />
              </Button>
            ) : (
              <Button size="sm" onClick={handleConfirm} disabled={submitting}>
                {submitting ? 'Promoting…' : 'Promote'}
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
