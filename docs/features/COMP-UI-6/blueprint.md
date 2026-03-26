# COMP-UI-6: Blueprint

## Task 1: Delete Dead Code

### Files to delete
- `compose-ui/` — entire directory (zero runtime references)
- `compose/src/hooks/use-mobile.jsx` — zero references
- `compose/src/components/vision/shared/SkeletonCard.jsx` — zero references

### Code to remove
- `compose/src/components/cockpit/agentBarState.js:50` — `expandAgentBar()` export (unused)
- `compose/src/components/vision/vision-logic.js:8-10` — stale comments referencing deleted BoardView, ItemListView, RoadmapView
- `compose/src/index.css` — unused CSS variables: `--button-border-radius`, `--button-font-weight`, `--button-padding-vertical`, `--button-padding-horizontal`, `--input-height`

## Task 2: Error Boundaries Per Zone

### Current state
- `App.jsx` wraps main content and context panel with `PanelErrorBoundary`
- No boundaries on: sidebar, header/ViewTabs, AgentBar, OpsStrip

### Implementation
Add `ZoneErrorBoundary` component (or extend existing `PanelErrorBoundary`) with zone-name prop. Wrap in `App.jsx`:
- Sidebar → boundary with "Sidebar" fallback
- Header/ViewTabs → boundary with "Navigation" fallback
- AgentBar → boundary with "Agent Bar" fallback
- OpsStrip → boundary with "Status Bar" fallback

Each fallback: zone name + "crashed" message + retry button. Same pattern as existing `PanelErrorBoundary`.

## Task 3: Color Token Merge

### Strategy
Two-pass approach:
1. **Replace legacy CSS var references** with Tailwind classes or modern HSL vars
2. **Delete the legacy block** from `index.css` once all consumers are migrated

### Migration map (legacy → modern)

**Surface tokens:**
| Legacy | Tailwind class / modern var |
|---|---|
| `--compose-raised`, `--compose-base`, `--compose-void` | `bg-background` / `hsl(var(--background))` |
| `--compose-overlay`, `--compose-inset` | `bg-muted` / `hsl(var(--muted))` |
| `--color-surface` | `bg-card` / `hsl(var(--card))` |
| `--color-surface-overlay` | `bg-accent` / `hsl(var(--accent))` |
| `--color-background` | `bg-background` / `hsl(var(--background))` |

**Text tokens:**
| Legacy | Tailwind class / modern var |
|---|---|
| `--ink-primary`, `--color-text-primary` | `text-foreground` |
| `--ink-secondary`, `--color-text-secondary` | `text-muted-foreground` |
| `--ink-tertiary`, `--color-text-tertiary` | `text-muted-foreground` (same — collapse the distinction) |
| `--ink-muted`, `--color-text-muted` | `text-muted-foreground/70` or `opacity-70` |

**Brand/semantic tokens:**
| Legacy | Modern var |
|---|---|
| `--ember`, `--color-accent` | `hsl(var(--primary))` |
| `--indigo`, `--color-primary` | `hsl(var(--primary))` |
| `--magenta` | `hsl(var(--artifact))` |
| `--error`, `--color-error` | `hsl(var(--destructive))` |
| `--color-success` | `hsl(var(--success))` |
| `--color-warning` | `hsl(var(--warning))` |
| `--info` | `hsl(var(--primary))` |

**Border tokens:**
| Legacy | Tailwind class / modern var |
|---|---|
| `--border-standard` | `border-border` / `hsl(var(--border))` |
| `--border-soft` | `border-border/40` |
| `--border-emphasis` | `border-border` (standard is fine) |
| `--border-focus` | `ring` / `hsl(var(--ring))` |
| `--input-border-color` | `border-input` / `hsl(var(--input))` |

**Glow/shadow tokens:**
| Legacy | Modern replacement |
|---|---|
| `--ember-glow`, `--accent-glow` | `bg-primary/10` |
| `--indigo-glow`, `--primary-glow` | `bg-primary/8` |
| `--magenta-glow` | `bg-artifact/15` |
| `--card-shadow` | `shadow-sm` (Tailwind) |

**Keep as-is (activity categories):**
`--color-category-reading`, `--color-category-writing`, `--color-category-executing`, `--color-category-searching`, `--color-category-fetching`, `--color-category-delegating` — these have light/dark mode variants and are consumed dynamically. Keep in `index.css` but move to the modern section.

### Consumer files (in migration order)

1. **Canvas.jsx** — ~20 legacy refs. Heavy user of `--ember`, `--ink-*`, `--compose-*`.
2. **GraphRenderer.jsx** — ~50 legacy refs. Heaviest consumer. `--color-text-*`, `--color-surface-*`, `--border-*`.
3. **AgentPanel.jsx** — ~20 legacy refs. Category colors + `--ink-*` with fallbacks.
4. **ItemRow.jsx** — ~30 legacy refs + many hardcoded hex. `--color-text-*`, `--border-*`, hardcoded `#818cf8`, `#22c55e`, `#ef4444`.
5. **PopoutView.jsx** — 3 refs. Trivial — already uses modern HSL for most.
6. **StratumPanel.jsx** — 0 legacy CSS var refs (all hardcoded hex). Low priority but could use semantic tokens for consistency.
7. **ProductGraph.jsx** — 0 legacy CSS var refs (hardcoded entity colors). Keep as-is — entity colors are intentional.
8. **GraphView.jsx** — 0 legacy CSS var refs (uses TYPE_COLORS constant). Keep as-is.

### Hardcoded hex cleanup

StratumPanel and ItemRow have extensive hardcoded hex values (`#ef4444`, `#22c55e`, `#818cf8`, etc.) that match semantic tokens. These should be migrated to `hsl(var(--destructive))`, `hsl(var(--success))`, `hsl(var(--primary))` for theme consistency. However, this is lower priority — the inline styles work and changing them to Tailwind classes would require restructuring JSX.

**Decision:** Migrate CSS var references (breaks when legacy block is deleted). Leave hardcoded hex values for a future pass — they won't break.

### What to delete from index.css after migration

The entire legacy block (lines ~99-160 light, ~207-231 dark overrides), EXCEPT:
- Activity category variables (move to modern section)
- Any variable still referenced after migration

## Verification

- [ ] `npm run build` passes (no broken imports)
- [ ] `npm test` passes (no broken tests)
- [ ] Dev server renders all views correctly in light and dark mode
- [ ] No console errors about missing CSS variables
- [ ] `grep -r 'compose-void\|compose-base\|compose-raised\|compose-overlay\|compose-inset\|ink-primary\|ink-secondary\|ink-tertiary\|ink-muted\|--ember\b' compose/src/` returns empty
