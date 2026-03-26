/**
 * Clamps a value between a minimum and maximum bound.
 * If min and max are inverted, they are swapped automatically.
 *
 * @param {number} value - The value to clamp.
 * @param {number} min - The lower bound.
 * @param {number} max - The upper bound.
 * @returns {number} The clamped value.
 */
export function clamp(value, min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.min(Math.max(value, lo), hi);
}
