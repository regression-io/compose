/**
 * roadmap-parser.js — Parse ROADMAP.md into structured feature entries.
 *
 * Extracts feature codes, descriptions, statuses, and phase membership
 * from the markdown table format used by Compose roadmaps.
 */

const SKIP_STATUSES = new Set(['COMPLETE', 'SUPERSEDED', 'PARKED']);

const PHASE_HEADING_RE = /^##\s+(.+?)(?:\s+—\s+(.+))?$/;
const MILESTONE_HEADING_RE = /^###\s+(.+?)(?:\s*:\s*(.+))?$/;
const TABLE_ROW_RE = /^\|(.+)\|$/;
const FEATURE_CODE_RE = /^[A-Z][\w-]*-\d+/;

/**
 * @typedef {{ code: string, description: string, status: string, phaseId: string, position: number }} FeatureEntry
 */

/**
 * Parse ROADMAP.md text into an ordered list of feature entries.
 * Anonymous rows (code === '—' or no code) are included for dependency chain
 * purposes but can be filtered out for build lists.
 *
 * @param {string} text - Raw ROADMAP.md content
 * @returns {FeatureEntry[]}
 */
export function parseRoadmap(text) {
  const lines = text.split('\n');
  const entries = [];
  let currentPhaseId = '';
  let currentPhaseStatus = '';
  let position = 0;
  let inTable = false;
  let columnLayout = null; // { codeCol, descCol, statusCol }

  for (const line of lines) {
    const trimmed = line.trim();

    // Phase heading: ## Phase 0: Bootstrap — COMPLETE
    const phaseMatch = trimmed.match(PHASE_HEADING_RE);
    if (phaseMatch) {
      currentPhaseId = phaseMatch[1].trim();
      currentPhaseStatus = phaseMatch[2]?.trim() ?? '';
      inTable = false;
      columnLayout = null;
      continue;
    }

    // Milestone heading: ### Milestone 1: Stratum Engine Complete
    const milestoneMatch = trimmed.match(MILESTONE_HEADING_RE);
    if (milestoneMatch) {
      // Nest under parent phase
      const milestoneLabel = milestoneMatch[1].trim();
      if (currentPhaseId) {
        currentPhaseId = `${currentPhaseId} > ${milestoneLabel}`;
      } else {
        currentPhaseId = milestoneLabel;
      }
      inTable = false;
      columnLayout = null;
      continue;
    }

    // Table row
    if (!TABLE_ROW_RE.test(trimmed)) {
      if (inTable) {
        inTable = false;
        columnLayout = null;
      }
      continue;
    }

    const cells = trimmed.split('|').slice(1, -1).map(c => c.trim());

    // Skip separator rows (|---|---|---|)
    if (cells.every(c => /^[-:]+$/.test(c))) {
      continue;
    }

    // Detect header row
    if (!inTable) {
      inTable = true;
      columnLayout = detectColumnLayout(cells);
      continue;
    }

    if (!columnLayout) continue;

    // Parse data row
    const code = cells[columnLayout.codeCol] ?? '—';
    const desc = cells[columnLayout.descCol] ?? '';
    let status = cells[columnLayout.statusCol] ?? '';

    // Clean up status (strip bold markers, etc.)
    status = status.replace(/\*\*/g, '').trim();

    // If the entire phase is COMPLETE, override individual statuses
    if (SKIP_STATUSES.has(currentPhaseStatus)) {
      status = currentPhaseStatus;
    }

    const isAnonymous = code === '—' || code === '-' || !FEATURE_CODE_RE.test(code);

    entries.push({
      code: isAnonymous ? `_anon_${position}` : code,
      description: desc.replace(/\*\*/g, '').trim(),
      status: status || 'PLANNED',
      phaseId: currentPhaseId,
      position: position++,
    });
  }

  return entries;
}

/**
 * Detect the column layout of a table header row.
 *
 * Supported layouts:
 *   4-col: # | Feature | Item | Status   → code=Feature, desc=Item
 *   4-col: ID | Item | Location | Status → code=ID, desc=Item
 *   3-col: ID | Feature | Status         → code=ID, desc=Feature
 *   3-col: ID | Item | Status            → code=ID, desc=Item
 *   3-col: # | Item | Status             → anonymous (# is a row number, not a code)
 */
function detectColumnLayout(headerCells) {
  const lower = headerCells.map(c => c.toLowerCase());

  // 4+ columns: look for a Feature column as the code source
  if (lower.length >= 4) {
    const featureIdx = lower.findIndex(c => c === 'feature');
    if (featureIdx !== -1) {
      return {
        codeCol: featureIdx,
        descCol: featureIdx + 1,
        statusCol: lower.length - 1,
      };
    }
    // No "feature" column — use first col as code, second as desc
    return {
      codeCol: 0,
      descCol: 1,
      statusCol: lower.length - 1,
    };
  }

  // 3 columns: check if first column is "id" (contains feature codes)
  if (lower.length === 3 && lower[0] === 'id') {
    return {
      codeCol: 0,
      descCol: 1,
      statusCol: 2,
    };
  }

  // 3-column fallback: # | Item | Status (row-number tables, anonymous)
  return {
    codeCol: -1, // will yield undefined → anonymous
    descCol: Math.min(1, lower.length - 2),
    statusCol: lower.length - 1,
  };
}

/**
 * Return only features that should be built:
 * - has a real feature code (not anonymous)
 * - status is PLANNED or IN_PROGRESS or PARTIAL
 *
 * @param {FeatureEntry[]} entries
 * @returns {FeatureEntry[]}
 */
export function filterBuildable(entries) {
  return entries.filter(e =>
    !e.code.startsWith('_anon_') && !SKIP_STATUSES.has(e.status)
  );
}
