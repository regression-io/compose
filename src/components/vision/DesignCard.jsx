/**
 * DesignCard — clickable decision card for the design conversation.
 *
 * Pure presentational component. Renders a card with a letter ID prefix,
 * bold title, bullet list, and optional recommended/selected badges.
 *
 * Props:
 *   card         {{ id: string, title: string, bullets: string[] }}
 *   recommended  {boolean}  show star badge
 *   selected     {boolean}  accent border + check icon
 *   disabled     {boolean}  no click, reduced opacity
 *   onSelect     {fn}       called with (cardId) on click
 */
import React from 'react';
import { Star, Check } from 'lucide-react';

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

export default function DesignCard({ card, recommended = false, selected = false, disabled = false, onSelect }) {
  const letterIndex = parseInt(card.id, 10);
  const letter = Number.isFinite(letterIndex) ? (LETTERS[letterIndex] ?? card.id) : card.id;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect?.(card.id)}
      className={[
        'relative w-full text-left rounded-lg border p-3 transition-colors cursor-pointer',
        'bg-card',
        selected
          ? 'border-accent'
          : 'border-border hover:border-foreground',
        disabled && 'opacity-50 pointer-events-none',
      ].filter(Boolean).join(' ')}
    >
      {/* Badge: check (selected) or star (recommended) */}
      {(selected || recommended) && (
        <span className="absolute top-2 right-2 text-accent">
          {selected
            ? <Check style={{ width: 14, height: 14 }} />
            : <Star style={{ width: 14, height: 14 }} />}
        </span>
      )}

      {/* Title with letter prefix */}
      <span className="block text-[12px] font-bold text-foreground">
        {letter}. {card.title}
      </span>

      {/* Bullets */}
      {card.bullets?.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 list-none pl-0">
          {card.bullets.map((b, i) => (
            <li key={i} className="text-[11px] text-muted-foreground leading-snug">
              <span className="mr-1">&bull;</span>{b}
            </li>
          ))}
        </ul>
      )}
    </button>
  );
}
