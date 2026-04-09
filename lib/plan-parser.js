/**
 * plan-parser.js — agent-side helper for extracting acceptance criteria from plan.md.
 *
 * Used by the ship step agent to populate plan_items before calling step_done.
 * NOT called by the ensure function — the ensure function receives precomputed data.
 */

/**
 * Heuristic patterns for marking an item as critical.
 * Items matching any of these are flagged critical: true.
 */
const CRITICAL_PATTERNS = [
  /\bMUST\b/,
  /\brequired\b/i,
  /\bsecurity\b/i,
  /\bauth\b/i,
  /\bcrypto\b/i,
  /\btest\b/i,
  /\btests\b/i,
];

/**
 * parsePlanItems(planMarkdown) → Array<{ text, file, critical }>
 *
 * Extracts checkbox items from plan.md markdown.
 * Handles both unchecked `- [ ]` and checked `- [x]` / `- [X]` lines.
 *
 * @param {string} planMarkdown - Raw markdown content of a plan.md file.
 * @returns {Array<{text: string, file: string|null, critical: boolean}>}
 */
function parsePlanItems(planMarkdown) {
  if (!planMarkdown || typeof planMarkdown !== 'string') {
    return [];
  }

  const items = [];
  const lines = planMarkdown.split('\n');

  for (const line of lines) {
    // Match checkbox lines: `- [ ] text` or `- [x] text` or `- [X] text`
    const match = line.match(/^\s*-\s+\[[ xX]\]\s+(.+)$/);
    if (!match) continue;

    const text = match[1].trim();

    // Extract the first backtick-quoted file path reference
    const fileMatch = text.match(/`([^`]+\.[a-zA-Z0-9]+[^`]*)`/);
    const file = fileMatch ? fileMatch[1] : null;

    // Determine criticality
    const critical = CRITICAL_PATTERNS.some(pattern => pattern.test(text));

    items.push({ text, file, critical });
  }

  return items;
}

/**
 * matchItemsToDiff(planItems, filesChanged) → { done, missing, extra }
 *
 * Classifies plan items against the set of files that changed in the diff.
 *
 * - done:    plan items whose file reference appears in filesChanged
 * - missing: plan items with a file reference NOT in filesChanged
 * - extra:   files in filesChanged not mentioned in any plan item (scope creep)
 *
 * Items without a file reference are treated as done (unverifiable, assumed complete).
 *
 * @param {Array<{text: string, file: string|null, critical: boolean}>} planItems
 * @param {string[]} filesChanged - List of file paths touched in the diff.
 * @returns {{ done: Array, missing: Array, extra: string[] }}
 */
function matchItemsToDiff(planItems, filesChanged) {
  const changedSet = new Set(filesChanged || []);
  const mentionedFiles = new Set();

  const done = [];
  const missing = [];

  for (const item of planItems) {
    if (!item.file) {
      // No file reference — treat as done
      done.push(item);
      continue;
    }

    mentionedFiles.add(item.file);

    if (changedSet.has(item.file)) {
      done.push(item);
    } else {
      missing.push({ ...item, critical: item.critical ?? false });
    }
  }

  // Extra: files changed that no plan item mentions (scope creep)
  const extra = [...changedSet].filter(f => !mentionedFiles.has(f));

  return { done, missing, extra };
}

export { parsePlanItems, matchItemsToDiff };
