import React from 'react';

/**
 * OpsStripEntry — Individual pill in the ops strip.
 *
 * Types: build (blue), gate (amber), error (red), done (green).
 * Each pill is a compact 24px-tall rounded element with icon + label.
 */

const TOKENS = {
  build: {
    background: 'hsl(217 91% 60% / 0.12)',
    borderColor: 'hsl(217 91% 60% / 0.3)',
    color: 'hsl(217 91% 60%)',
  },
  gate: {
    background: 'hsl(38 92% 50% / 0.12)',
    borderColor: 'hsl(38 92% 50% / 0.3)',
    color: 'hsl(38 92% 50%)',
  },
  error: {
    background: 'hsl(0 72% 51% / 0.12)',
    borderColor: 'hsl(0 72% 51% / 0.3)',
    color: 'hsl(0 72% 51%)',
  },
  done: {
    background: 'hsl(160 60% 45% / 0.12)',
    borderColor: 'hsl(160 60% 45% / 0.3)',
    color: 'hsl(160 60% 45%)',
  },
  iteration: {
    background: 'hsl(217 91% 60% / 0.12)',
    borderColor: 'hsl(217 91% 60% / 0.3)',
    color: 'hsl(210 100% 66%)',
  },
};

const ANIMATION_STYLES = {
  enter: { transform: 'translateX(20px)', opacity: 0 },
  steady: { transform: 'translateX(0)', opacity: 1 },
  flash: { transform: 'translateX(0)', opacity: 1 },
  exit: { transform: 'translateX(0)', opacity: 0 },
};

export default function OpsStripEntry({
  type = 'build',
  label,
  retries = 0,
  onClick,
  onApprove,
  onDismiss,
  animationState = 'steady',
}) {
  const tokens = (animationState === 'flash' ? TOKENS.done : TOKENS[type]) || TOKENS.build;
  const animStyle = ANIMATION_STYLES[animationState] || ANIMATION_STYLES.steady;
  const transitionDuration = animationState === 'exit' ? '200ms'
    : animationState === 'flash' ? '300ms'
    : '200ms';

  return (
    <div
      className="ops-strip-entry"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        height: '24px',
        padding: '0 10px',
        borderRadius: '12px',
        border: `1px solid ${tokens.borderColor}`,
        background: tokens.background,
        color: tokens.color,
        fontSize: '11px',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        cursor: onClick ? 'pointer' : 'default',
        whiteSpace: 'nowrap',
        transition: `transform ${transitionDuration} ease, opacity ${transitionDuration} ease, background 300ms ease, border-color 300ms ease, color 300ms ease`,
        ...animStyle,
      }}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' && onClick) onClick(); }}
    >
      {/* Icon */}
      <span style={{ fontSize: '12px', lineHeight: 1 }}>
        {type === 'build' && '\u25B6'}
        {type === 'gate' && '\u26A0'}
        {type === 'error' && '\u2715'}
        {type === 'done' && '\u2713'}
        {type === 'iteration' && '\u21BB'}
      </span>

      {/* Label */}
      <span>{label}</span>

      {/* Retry badge (COMP-OBS-SURFACE) */}
      {retries > 0 && (
        <span style={{
          background: 'hsl(38 90% 50% / 0.2)',
          color: 'hsl(38 90% 60%)',
          padding: '0 5px',
          borderRadius: '9999px',
          fontSize: '9px',
        }}>
          {retries}
        </span>
      )}

      {/* Inline approve button for gates */}
      {type === 'gate' && onApprove && (
        <button
          className="ops-strip-approve"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '18px',
            height: '18px',
            borderRadius: '9px',
            border: `1px solid ${tokens.borderColor}`,
            background: 'transparent',
            color: tokens.color,
            fontSize: '11px',
            cursor: 'pointer',
            padding: 0,
            marginLeft: '2px',
            lineHeight: 1,
          }}
          onClick={(e) => {
            e.stopPropagation();
            onApprove();
          }}
          title="Approve gate"
        >
          &#x2713;
        </button>
      )}

      {/* Dismiss button for errors */}
      {type === 'error' && onDismiss && (
        <button
          className="ops-strip-dismiss"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '18px',
            height: '18px',
            borderRadius: '9px',
            border: 'none',
            background: 'transparent',
            color: tokens.color,
            fontSize: '10px',
            cursor: 'pointer',
            padding: 0,
            marginLeft: '2px',
            opacity: 0.6,
            lineHeight: 1,
          }}
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          title="Dismiss error"
        >
          &#x2715;
        </button>
      )}
    </div>
  );
}

// Export tokens for testing
export { TOKENS };
