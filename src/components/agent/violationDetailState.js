/**
 * violationDetailState.js — pure logic backing ViolationDetail.jsx
 *
 * Extracted so it can be unit-tested without DOM/React.
 */

/**
 * Returns null when violations list is empty, indicating the component
 * should render nothing.
 *
 * @param {string[]} violations
 * @returns {'hidden'|'collapsed'|'expanded'}
 */
export function violationDisplayState(violations, expanded) {
  if (!Array.isArray(violations) || violations.length === 0) return 'hidden';
  return expanded ? 'expanded' : 'collapsed';
}

/**
 * Returns the header label string.
 *
 * @param {string[]} violations
 * @returns {string}
 */
export function violationHeaderLabel(violations) {
  const n = Array.isArray(violations) ? violations.length : 0;
  return `violations (${n})`;
}

/**
 * Returns the chevron character for the current expansion state.
 *
 * @param {boolean} expanded
 * @returns {string}
 */
export function violationChevron(expanded) {
  return expanded ? '▾' : '▸';
}

/**
 * Toggles expanded state.
 *
 * @param {boolean} expanded
 * @returns {boolean}
 */
export function toggleViolationExpanded(expanded) {
  return !expanded;
}
