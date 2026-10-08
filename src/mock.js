// Mock data mode: a deterministic, realistic-looking usage history for demos and
// screenshots. It lives in its own store file and never touches real logs.

import path from 'node:path';
import { makeRecord } from './core/schema.js';
import { Store } from './core/store.js';

export const MOCK_ROOT = path.resolve('/mock/Developer');

const PROJECTS = [
  { name: 'atlas-web', weight: 5 },
  { name: 'billing-api', weight: 4 },
  { name: 'data-pipeline', weight: 3 },
  { name: 'mobile-app', weight: 2 },
  { name: 'infra', weight: 1 },
];

const SOURCES = [
  {
    name: 'claude-code',
    weight: 3,
    models: [
      { id: 'claude-sonnet-5-5', weight: 6 },
      { id: 'claude-opus-5-5', weight: 3 },
      { id: 'claude-haiku-4-5', weight: 1 },
    ],
  },
  {
    name: 'codex',
    weight: 1,
    models: [
      { id: 'gpt-6-astra', weight: 2 },
      { id: 'gpt-5.6-sol', weight: 1 },
    ],
  },
];

/** mulberry32: small seeded PRNG, so the same seed always yields the same data. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate `days` of usage ending today (local time).
 * @param {{ pricing: import('./core/pricing.js').Pricing, days?: number, now?: Date, seed?: number }} opts
 */
export function generateMockRecords({ pricing, days = 90, now = new Date(), seed = 42 }) {
  const rand = prng(seed);
  const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = (items) => {
    let r = rand() * items.reduce((sum, i) => sum + i.weight, 0);
    for (const item of items) if ((r -= item.weight) < 0) return item;
    return items.at(-1);
  };

  const records = [];
  for (let d = days - 1; d >= 0; d--) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    // Usage ramps up over the period, with lighter weekends and some days off.
    const ramp = 0.6 + 0.8 * ((days - d) / days);
    if (rand() < (weekend ? 0.55 : 0.08)) continue;
    const sessions = Math.max(1, Math.round(between(1, weekend ? 2 : 5) * ramp));

    for (let s = 0; s < sessions; s++) {
      const source = pick(SOURCES);
      const model = pick(source.models).id;
      const project = pick(PROJECTS).name;
      const sessionId = `mock-${day.toISOString().slice(0, 10)}-${s}`;
      let t = new Date(day);
      t.setHours(between(9, 21), between(0, 59), between(0, 59));
      let context = between(8000, 20000); // system prompt + tools

      const turns = between(4, 45);
      for (let n = 0; n < turns; n++) {
        const output = between(80, 2500);
        const fresh = between(200, 6000); // tool results / new messages this turn
        const tokens = { input: between(2, 400), output, cacheRead: context, cacheWrite: fresh };
        context += fresh + output;
        records.push(makeRecord({
          id: `${source.name}:${sessionId}:${n}`,
          source: source.name,
          timestamp: t.toISOString(),
          model,
          modelMeasured: true,
          session: sessionId,
          tokens,
          tokenAvailability: 'measured',
          cost: pricing.cost(model, tokens),
          measured: true,
          meta: { project, cwd: path.join(MOCK_ROOT, project), gitBranch: 'main', mock: true },
        }));
        t = new Date(t.getTime() + between(15, 240) * 1000);
      }
    }
  }
  return records;
}

/** Write a fresh mock store (dates relative to today) and return its path. */
export async function writeMockStore(storePath, opts) {
  const store = new Store(storePath);
  store.projectRoots = [MOCK_ROOT];
  store.merge(generateMockRecords(opts));
  await store.save();
  return storePath;
}
