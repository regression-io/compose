/**
 * AgentAvatar — circular icon badge for compose agents.
 *
 * Agents from constants.js: claude, codex, gemini, human, unassigned.
 * Icons from lucide-react: Bot (claude/gemini/unassigned), Cpu (codex), User (human).
 * Size map: sm=w-6 h-6, md=w-8 h-8, lg=w-10 h-10.
 *
 * Props: { agent: string, size?: 'sm'|'md'|'lg', className?: string }
 */
import React from 'react';
import { Bot, Cpu, User } from 'lucide-react';
import { cn } from '@/lib/utils.js';

const AGENT_CONFIG = {
  claude:     { bg: 'bg-orange-500/20',  text: 'text-orange-400',  Icon: Bot  },
  codex:      { bg: 'bg-emerald-500/20', text: 'text-emerald-400', Icon: Cpu  },
  gemini:     { bg: 'bg-blue-500/20',    text: 'text-blue-400',    Icon: Bot  },
  human:      { bg: 'bg-slate-500/20',   text: 'text-slate-400',   Icon: User },
  unassigned: { bg: 'bg-slate-800',      text: 'text-slate-600',   Icon: Bot  },
};

const FALLBACK = { bg: 'bg-slate-800', text: 'text-slate-600', Icon: Bot };

const SIZE_MAP = {
  sm: { outer: 'w-6 h-6', icon: 'w-3 h-3' },
  md: { outer: 'w-8 h-8', icon: 'w-4 h-4' },
  lg: { outer: 'w-10 h-10', icon: 'w-5 h-5' },
};

export default function AgentAvatar({ agent, size = 'md', className }) {
  const cfg = AGENT_CONFIG[agent] || FALLBACK;
  const sz = SIZE_MAP[size] || SIZE_MAP.md;
  const { Icon } = cfg;

  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-full shrink-0',
        cfg.bg,
        cfg.text,
        sz.outer,
        className,
      )}
      title={agent || 'unassigned'}
    >
      <Icon className={sz.icon} />
    </span>
  );
}
