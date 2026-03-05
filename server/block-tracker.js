/**
 * block-tracker.js — Work block detection and classification.
 *
 * These functions operate on a session object passed by reference,
 * extracted from SessionManager to keep it under the line limit.
 */

// ---------------------------------------------------------------------------
// Block detection
// ---------------------------------------------------------------------------

/**
 * Detect block boundaries: a new block starts when the set of resolved items changes.
 *
 * @param {object} session — the current session object (mutated in place)
 * @param {string[]} itemIds — current resolved item IDs
 * @param {string} now — ISO timestamp
 * @param {string} category — tool category string
 */
export function updateBlock(session, itemIds, now, category) {
  const currentSet = session.currentBlock?.itemIds;

  const sameBlock = currentSet
    && itemIds.length === currentSet.size
    && itemIds.every(id => currentSet.has(id));

  if (sameBlock) {
    session.currentBlock.toolCount++;
    if (category) session.currentBlock.categories.add(category);
    return;
  }

  // Different set → close current block, start new one
  closeCurrentBlock(session);

  session.currentBlock = {
    itemIds: new Set(itemIds),
    startedAt: now,
    toolCount: 1,
    categories: new Set(category ? [category] : []),
  };
}

// ---------------------------------------------------------------------------
// Block closing
// ---------------------------------------------------------------------------

/**
 * Close the current block and push it to session.blocks.
 *
 * @param {object} session — the current session object (mutated in place)
 */
export function closeCurrentBlock(session) {
  if (!session?.currentBlock) return;

  const block = session.currentBlock;
  session.blocks.push({
    itemIds: Array.from(block.itemIds),
    startedAt: block.startedAt,
    endedAt: new Date().toISOString(),
    toolCount: block.toolCount,
    categories: Array.from(block.categories || []),
    intent: classifyBlockIntent(block),
  });

  session.currentBlock = null;
}

// ---------------------------------------------------------------------------
// Block classification
// ---------------------------------------------------------------------------

/**
 * Classify a work block's intent from the categories of tools used.
 *
 * @param {object} block — block with a categories Set
 * @returns {'building'|'debugging'|'testing'|'exploring'|'thinking'|'mixed'}
 */
export function classifyBlockIntent(block) {
  const cats = block.categories || new Set();
  const hasWriting = cats.has('writing');
  const hasExecuting = cats.has('executing');
  const hasReading = cats.has('reading') || cats.has('searching');
  if (hasWriting && !hasExecuting) return 'building';
  if (hasWriting && hasExecuting) return 'debugging';
  if (hasExecuting && !hasWriting) return 'testing';
  if (hasReading && !hasWriting && !hasExecuting) return 'exploring';
  if (cats.size === 0) return 'thinking';
  return 'mixed';
}
