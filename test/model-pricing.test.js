/**
 * Tests for lib/model-pricing.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { MODEL_PRICING, calculateCost } = await import(`${REPO_ROOT}/lib/model-pricing.js`);

// ---------------------------------------------------------------------------
// MODEL_PRICING table
// ---------------------------------------------------------------------------

test('MODEL_PRICING contains expected models', () => {
  assert.ok(MODEL_PRICING['claude-opus-4-6'], 'opus-4-6 should be present');
  assert.ok(MODEL_PRICING['claude-sonnet-4-6'], 'sonnet-4-6 should be present');
  assert.ok(MODEL_PRICING['claude-haiku-4-5'], 'haiku-4-5 should be present');
});

test('MODEL_PRICING has correct opus rates', () => {
  assert.equal(MODEL_PRICING['claude-opus-4-6'].inputPerMTok, 15);
  assert.equal(MODEL_PRICING['claude-opus-4-6'].outputPerMTok, 75);
});

test('MODEL_PRICING has correct sonnet rates', () => {
  assert.equal(MODEL_PRICING['claude-sonnet-4-6'].inputPerMTok, 3);
  assert.equal(MODEL_PRICING['claude-sonnet-4-6'].outputPerMTok, 15);
});

test('MODEL_PRICING has correct haiku rates', () => {
  assert.equal(MODEL_PRICING['claude-haiku-4-5'].inputPerMTok, 1);
  assert.equal(MODEL_PRICING['claude-haiku-4-5'].outputPerMTok, 5);
});

// ---------------------------------------------------------------------------
// calculateCost — known inputs
// ---------------------------------------------------------------------------

test('calculateCost sonnet: 1M input + 1M output', () => {
  // 1M input × $3/MTok + 1M output × $15/MTok = $18
  const cost = calculateCost('claude-sonnet-4-6', 1_000_000, 1_000_000);
  assert.equal(cost, 18);
});

test('calculateCost opus: 1M input + 1M output', () => {
  // 1M × $15 + 1M × $75 = $90
  const cost = calculateCost('claude-opus-4-6', 1_000_000, 1_000_000);
  assert.equal(cost, 90);
});

test('calculateCost haiku: 1M input + 1M output', () => {
  // 1M × $1 + 1M × $5 = $6
  const cost = calculateCost('claude-haiku-4-5', 1_000_000, 1_000_000);
  assert.equal(cost, 6);
});

test('calculateCost sonnet: small call (10k input, 2k output)', () => {
  // 10k × $3/MTok + 2k × $15/MTok = 0.03 + 0.03 = $0.06
  const cost = calculateCost('claude-sonnet-4-6', 10_000, 2_000);
  assert.ok(Math.abs(cost - 0.06) < 0.0001, `expected ~$0.06 got ${cost}`);
});

test('calculateCost includes cache write at 1.25x input rate', () => {
  // 1M cache_write tokens × $3/MTok × 1.25 = $3.75
  const cost = calculateCost('claude-sonnet-4-6', 0, 0, 1_000_000, 0);
  assert.equal(cost, 3.75);
});

test('calculateCost includes cache read at 0.1x input rate', () => {
  // 1M cache_read tokens × $3/MTok × 0.1 = $0.30
  const cost = calculateCost('claude-sonnet-4-6', 0, 0, 0, 1_000_000);
  assert.ok(Math.abs(cost - 0.3) < 0.0001, `expected ~$0.30 got ${cost}`);
});

test('calculateCost with dated model variant (prefix match)', () => {
  // 'claude-sonnet-4-6-20250514' should match 'claude-sonnet-4-6' by prefix
  const cost = calculateCost('claude-sonnet-4-6-20250514', 1_000_000, 0);
  assert.equal(cost, 3);
});

// ---------------------------------------------------------------------------
// calculateCost — unknown models
// ---------------------------------------------------------------------------

test('calculateCost returns 0 for unknown model', () => {
  const cost = calculateCost('gpt-99-ultra', 1_000_000, 1_000_000);
  assert.equal(cost, 0);
});

test('calculateCost returns 0 for null model', () => {
  const cost = calculateCost(null, 1_000_000, 1_000_000);
  assert.equal(cost, 0);
});

test('calculateCost returns 0 for undefined model', () => {
  const cost = calculateCost(undefined, 1_000_000, 1_000_000);
  assert.equal(cost, 0);
});

test('calculateCost returns 0 for empty model string', () => {
  const cost = calculateCost('', 1_000_000, 1_000_000);
  assert.equal(cost, 0);
});

// ---------------------------------------------------------------------------
// calculateCost — zero tokens
// ---------------------------------------------------------------------------

test('calculateCost returns 0 for zero input and output tokens', () => {
  const cost = calculateCost('claude-sonnet-4-6', 0, 0);
  assert.equal(cost, 0);
});

test('calculateCost returns 0 for null token counts', () => {
  const cost = calculateCost('claude-sonnet-4-6', null, null);
  assert.equal(cost, 0);
});

test('calculateCost returns 0 for undefined token counts', () => {
  const cost = calculateCost('claude-sonnet-4-6', undefined, undefined);
  assert.equal(cost, 0);
});
