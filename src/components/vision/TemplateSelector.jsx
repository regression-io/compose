import React, { useState, useEffect } from 'react';
import { FileText, Clock, Layers, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils.js';

/**
 * TemplateSelector — Grid of pipeline template cards.
 *
 * Fetches /api/pipeline/templates and renders each as a clickable card.
 * On click, creates a draft via POST /api/pipeline/draft with { templateId }.
 *
 * COMP-PIPE-1-3: Pipeline authoring loop — template selection entry point.
 */

const CATEGORY_COLORS = {
  development:    'border-blue-500/30 bg-blue-500/5 text-blue-400',
  quality:        'border-emerald-500/30 bg-emerald-500/5 text-emerald-400',
  maintenance:    'border-amber-500/30 bg-amber-500/5 text-amber-400',
  documentation:  'border-violet-500/30 bg-violet-500/5 text-violet-400',
  exploration:    'border-cyan-500/30 bg-cyan-500/5 text-cyan-400',
};

export default function TemplateSelector() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(null);

  useEffect(() => {
    fetch('/api/pipeline/templates')
      .then(r => r.json())
      .then(data => {
        setTemplates(data.templates || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleSelect = async (templateId) => {
    setCreating(templateId);
    try {
      await fetch('/api/pipeline/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId }),
      });
    } catch (err) {
      console.error('[TemplateSelector] Failed to create draft:', err);
    }
    setCreating(null);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        Loading templates...
      </div>
    );
  }

  if (templates.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
        No pipeline templates found
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        Choose a pipeline template
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {templates.map(t => (
          <button
            key={t.id}
            onClick={() => handleSelect(t.id)}
            disabled={creating !== null}
            className={cn(
              'flex flex-col gap-2 p-3 rounded-lg border text-left transition-all',
              'hover:ring-1 hover:ring-accent/50',
              creating === t.id && 'opacity-60',
              CATEGORY_COLORS[t.category] || 'border-border bg-card',
            )}
          >
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 shrink-0" />
              <span className="text-sm font-medium text-foreground truncate">{t.label}</span>
            </div>
            <p className="text-xs text-muted-foreground line-clamp-2">{t.description}</p>
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground mt-auto">
              <span className="flex items-center gap-1">
                <Layers className="w-3 h-3" /> {t.steps} steps
              </span>
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" /> ~{t.estimated_minutes}m
              </span>
              <span className="ml-auto capitalize">{t.category}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
