import test from 'node:test';
import assert from 'node:assert/strict';
import { Pricing, normalizeModel } from '../src/core/pricing.js';

const M = 1_000_000;
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);

test('Anthropic: each token class is billed at its own rate', () => {
  const p = new Pricing({ 'test-claude': { input: 3, output: 15 } });
  // claude-* models get the standard cache multipliers: read 0.1x, 5m write 1.25x, 1h write 2x
  const claude = new Pricing({ 'claude-test': { input: 3, output: 15 } });

  close(p.cost('test-claude', { input: M, output: 0 }).amount, 3, 'input');
  close(p.cost('test-claude', { input: 0, output: M }).amount, 15, 'output');
  close(claude.cost('claude-test', { cacheRead: M }).amount, 0.3, 'cache read = 0.1x input');
  close(claude.cost('claude-test', { cacheWrite5m: M }).amount, 3.75, '5m write = 1.25x input');
  close(claude.cost('claude-test', { cacheWrite1h: M }).amount, 6, '1h write = 2x input');
});

test('Anthropic: an undifferentiated cache write is treated as the 5-minute tier', () => {
  const p = new Pricing({ 'claude-test': { input: 4, output: 20 } });
  close(p.cost('claude-test', { cacheWrite: M }).amount, 5, '1.25 x 4');
});

test('OpenAI models are not charged an Anthropic cache-write premium', () => {
  const p = new Pricing({ 'gpt-test': { input: 4, output: 20, cacheRead: 0.4 } });
  close(p.cost('gpt-test', { cacheWrite: M }).amount, 0, 'no implicit cache-write fee');
  close(p.cost('gpt-test', { cacheRead: M }).amount, 0.4, 'explicit cached-input rate');
});

test('an explicit cacheWrite override wins for any provider', () => {
  const p = new Pricing({ 'gpt-test': { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 } });
  close(p.cost('gpt-test', { cacheWrite: M }).amount, 5);
});

test('a mixed turn sums every class', () => {
  const p = new Pricing({ 'claude-test': { input: 2, output: 10 } });
  const amount = p.cost('claude-test', {
    input: 1000,
    output: 2000,
    cacheRead: 500_000,
    cacheWrite: 100_000,
  }).amount;
  // 1000*2 + 2000*10 + 500000*0.2 + 100000*2.5, all per 1M
  close(amount, (2000 + 20000 + 100000 + 250000) / M);
});

test('an unknown model yields null, never zero', () => {
  const p = new Pricing();
  assert.equal(p.cost('totally-made-up-model', { input: 1000 }).amount, null);
  assert.equal(p.effectiveRates('totally-made-up-model'), null);
});

test('model ids normalise past date and version suffixes', () => {
  assert.equal(normalizeModel('claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(normalizeModel('anthropic.claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(normalizeModel('claude-opus-4-5@20251101'), 'claude-opus-4-5');
  assert.equal(normalizeModel('gpt-4o-2024-08-06'), 'gpt-4o');
  assert.equal(normalizeModel('gpt-4o-latest'), 'gpt-4o');
  assert.equal(normalizeModel(''), 'unknown');
});

test('config overrides beat the built-in table', () => {
  const base = new Pricing();
  const over = new Pricing({ 'claude-sonnet-5': { input: 99, output: 99 } });
  assert.notEqual(base.rateFor('claude-sonnet-5').input, 99);
  assert.equal(over.rateFor('claude-sonnet-5').input, 99);
});

test('price provenance is metadata, not a rate', () => {
  const p = new Pricing({
    'promo-model': { input: 4, output: 20, source: 'vendor page', effectiveUntil: '2026-11-21', notes: ['promo'] },
  });
  const meta = p.priceMeta('promo-model');
  assert.equal(meta.source, 'vendor page');
  assert.equal(meta.effectiveUntil, '2026-11-21');
  assert.deepEqual(meta.notes, ['promo']);
  // metadata keys must not leak into the computed cost
  close(p.cost('promo-model', { input: M }).amount, 4);
});

test('Opus 5.5 uses its own rates, including the 0.05x cache read', () => {
  const p = new Pricing();
  const c = p.cost('claude-opus-5-5', { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 });
  assert.equal(c.amount, 4 + 20 + 0.2);
});

test('an unlisted model version stays unpriced instead of borrowing an older version', () => {
  const p = new Pricing();
  assert.equal(p.rateFor('claude-opus-5-9'), null);
  assert.ok(p.rateFor('claude-haiku-4-5-20251001'), 'date suffixes still resolve');
});
