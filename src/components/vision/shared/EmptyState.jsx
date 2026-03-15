/**
 * EmptyState — centered empty state with icon, title, description, optional action button.
 *
 * Default icon: Inbox (from lucide-react).
 * Button from compose/src/components/ui/button.jsx.
 *
 * Props:
 *   icon?       LucideIcon  — default: Inbox
 *   title       string
 *   description? string
 *   action?     string      — button label; omit to hide button
 *   onAction?   () => void
 *   className?  string
 */
import React from 'react';
import { Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button.jsx';
import { cn } from '@/lib/utils.js';

export default function EmptyState({ icon: Icon = Inbox, title, description, action, onAction, className }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 p-8 text-center', className)}>
      <div className="flex items-center justify-center w-12 h-12 rounded-full bg-muted/50">
        <Icon className="w-6 h-6 text-muted-foreground/60" />
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      {action && (
        <Button variant="outline" size="sm" onClick={onAction}>
          {action}
        </Button>
      )}
    </div>
  );
}
