import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as codex from '../src/sources/codex.js';
import { Pricing } from '../src/core/pricing.js';
import { codexRollout } from './helpers.js';

const pricing = new Pricing();

/** Write one rollout file into a throwaway sessions dir and collect from it. */
async function collect(body, { file = 'rollout-2026-08-30T01-00-00-01a0505a-5998-74e1-a417-19755f9950eb.jsonl' } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'obs-codex-'));
  const dir = path.join(root, '2026', '08', '30');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), body, 'utf8');
  try {
    return await codex.collect({ sourceConfig: { sessionsDir: root }, baseDir: root, pricing });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('per-turn usage is the delta of the cumulative counter', async () => {
  const { records } = await collect(
    codexRollout({
      events: [{ input: 100, output: 10 }, { input: 150, output: 25 }, { input: 220, output: 60 }],
    })
  );
  assert.deepEqual(
    records.map((r) => r.tokens.input),
    [100, 50, 70]
  );
  assert.deepEqual(
    records.map((r) => r.tokens.output),
    [10, 15, 35]
  );
});

test('cached tokens are split out of the input total', async () => {
  const { records } = await collect(
    codexRollout({ events: [{ input: 1000, cached: 800, output: 10 }] })
  );
  assert.equal(records[0].tokens.input, 200, 'uncached input only');
  assert.equal(records[0].tokens.cacheRead, 800);
  assert.equal(records[0].tokens.total, 1010);
});

test('a counter reset does not silently drop a turn', async () => {
  // Cumulative goes 100 -> 150 -> (reset) 20 -> 50. The reset turn must survive.
  const { records, warnings } = await collect(
    codexRollout({ events: [{ input: 100 }, { input: 150 }, { input: 20 }, { input: 50 }] })
  );
  assert.deepEqual(
    records.map((r) => r.tokens.input),
    [100, 50, 20, 30],
    'the post-reset turn keeps its 20 tokens and the next delta rebases'
  );
  assert.equal(records[2].meta.counterReset, true);
  assert.ok(
    warnings.some((w) => /counter reset/i.test(w)),
    'a reset is surfaced as a warning'
  );
});

test('on reset, the provider per-turn figure wins over the raw counter', async () => {
  const { records } = await collect(
    codexRollout({
      events: [{ input: 100 }, { input: 30, last: { input: 7, output: 3 } }],
    })
  );
  assert.equal(records[1].tokens.input, 7);
  assert.equal(records[1].tokens.output, 3);
});

test('every delta is non-negative', async () => {
  const { records } = await collect(
    codexRollout({ events: [{ input: 500, output: 100 }, { input: 10, output: 1 }, { input: 40, output: 9 }] })
  );
  for (const r of records) {
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      assert.ok(r.tokens[k] >= 0, `${k} must not be negative`);
    }
  }
});

test('record ids are stable across runs, so re-ingest is idempotent', async () => {
  const body = codexRollout({ events: [{ input: 100 }, { input: 150 }] });
  const a = await collect(body);
  const b = await collect(body);
  assert.deepEqual(
    a.records.map((r) => r.id),
    b.records.map((r) => r.id)
  );
  assert.ok(
    a.records.every((r) => /^codex:[0-9a-f-]+:(ordinal|usage)-\d+$/.test(r.id)),
    `ids must be derived from the file, got ${a.records[0].id}`
  );
});

test('codex turns are flagged as measured', async () => {
  const { records } = await collect(codexRollout({ events: [{ input: 100, output: 10 }] }));
  assert.equal(records[0].measured, true);
  assert.equal(records[0].tokenAvailability, 'measured');
  assert.equal(records[0].modelMeasured, true);
  assert.equal(records[0].meta.project, 'demo', 'project comes from cwd basename');
});

test('an unpriced model leaves cost null rather than zero', async () => {
  const { records, warnings } = await collect(
    codexRollout({ model: 'gpt-9-nonexistent', events: [{ input: 100, output: 10 }] })
  );
  assert.equal(records[0].cost.amount, null);
  assert.ok(warnings.some((w) => /no price/i.test(w)));
});
