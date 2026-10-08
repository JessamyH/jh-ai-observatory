import test from 'node:test';
import assert from 'node:assert/strict';
import { bucketKey, summarize, projectOf, makeTagResolver, UNCLASSIFIED } from '../src/core/aggregate.js';
import { trackedProject } from '../src/core/util.js';
import { measuredTurn, unavailableTurn } from './helpers.js';

// bucketKey works on local wall-clock time, so build timestamps the same way.
const localAt = (y, m, d, h = 12) => new Date(y, m - 1, d, h).toISOString();

test('tracked projects are first-level folders below configured roots', () => {
  const roots = ['E:/side-project', 'E:/Work/code'];
  assert.equal(trackedProject('E:/side-project/ai-usage-observatory/src', roots), 'ai-usage-observatory');
  assert.equal(trackedProject('E:/Work/code/client/app', roots), 'client');
  assert.equal(trackedProject('E:/side-project', roots), null);
  assert.equal(trackedProject('E:/Work/code', roots), null);
  assert.equal(trackedProject('E:/Work/Doc', roots), null);
});

test('ISO week: the days around New Year fall in the right ISO year', () => {
  // 2025-12-29 is a Monday; its ISO week is 2026-W01 (the week holding Jan 1).
  assert.equal(bucketKey({ timestamp: localAt(2025, 12, 29) }, 'weekly').key, '2026-W01');
  assert.equal(bucketKey({ timestamp: localAt(2025, 12, 31) }, 'weekly').key, '2026-W01');
  assert.equal(bucketKey({ timestamp: localAt(2026, 1, 1) }, 'weekly').key, '2026-W01');
  // ...and the preceding Sunday still belongs to the last week of 2025.
  assert.equal(bucketKey({ timestamp: localAt(2025, 12, 28) }, 'weekly').key, '2025-W52');
});

test('ISO week: all seven days of one week share a key and a Monday label', () => {
  const keys = new Set();
  const labels = new Set();
  for (let d = 29; d <= 31; d++) {
    const b = bucketKey({ timestamp: localAt(2025, 12, d) }, 'weekly');
    keys.add(b.key);
    labels.add(b.label);
  }
  for (let d = 1; d <= 4; d++) {
    const b = bucketKey({ timestamp: localAt(2026, 1, d) }, 'weekly');
    keys.add(b.key);
    labels.add(b.label);
  }
  assert.equal(keys.size, 1, 'one ISO week key');
  assert.equal(labels.size, 1, 'one Monday label');
  assert.equal([...labels][0], '2025-12-29');
});

test('daily and monthly bucket keys', () => {
  assert.equal(bucketKey({ timestamp: localAt(2026, 8, 30) }, 'daily').key, '2026-08-30');
  assert.equal(bucketKey({ timestamp: localAt(2026, 8, 30) }, 'monthly').key, '2026-08');
});

test('unavailable turns are counted but contribute no tokens and no API value', () => {
  const rows = [
    measuredTurn({ id: 'a', ts: localAt(2026, 8, 30), input: 100, output: 50, cost: 0.4 }),
    unavailableTurn({ id: 'b', ts: localAt(2026, 8, 30) }),
    unavailableTurn({ id: 'c', ts: localAt(2026, 8, 30) }),
  ];
  const t = summarize(rows).totals;

  assert.equal(t.turns, 3, 'every turn counts');
  assert.equal(t.measuredTurns, 1);
  assert.equal(t.tokenUnavailableTurns, 2);
  assert.equal(t.measuredTokens.total, 150, 'unavailable data adds no tokens');
  assert.equal(t.apiValue, 0.4, 'unavailable data adds no value');
  assert.equal(t.unpricedTurns, 0, 'an unavailable turn is not an unpriced turn');
});

test('a bucket with only unavailable turns reports null tokens, not zero', () => {
  const s = summarize([unavailableTurn({ id: 'w', ts: localAt(2026, 8, 29) })]);
  const b = s.buckets[0];
  assert.equal(b.turns, 1);
  assert.equal(b.measuredTokens.total, 0, 'bucket roll-up is numeric');
  assert.equal(b.bySource['unavailable-source'].measuredTokens, null, 'per-source is null, not 0');
  assert.equal(b.bySource['unavailable-source'].apiValue, null);
});

test('a measured source that genuinely used zero tokens stays 0, not null', () => {
  const s = summarize([measuredTurn({ id: 'z', ts: localAt(2026, 8, 29), input: 0, output: 0, cost: 0 })]);
  assert.equal(s.buckets[0].bySource['claude-code'].measuredTokens, 0);
});

test('conversations are de-duplicated per source', () => {
  const rows = [
    measuredTurn({ id: 'a', ts: localAt(2026, 8, 30), session: 's1' }),
    measuredTurn({ id: 'b', ts: localAt(2026, 8, 30), session: 's1' }),
    measuredTurn({ id: 'c', ts: localAt(2026, 8, 30), session: 's2' }),
    unavailableTurn({ id: 'd', ts: localAt(2026, 8, 30), session: 's1' }), // same id, different source
  ];
  const s = summarize(rows);
  assert.equal(s.totals.conversations, 3);
  assert.equal(s.buckets[0].conversations, 3);
});

test('unpriced measured turns are counted separately from unavailable ones', () => {
  const rows = [
    measuredTurn({ id: 'a', ts: localAt(2026, 8, 30), cost: null }),
    unavailableTurn({ id: 'b', ts: localAt(2026, 8, 30) }),
  ];
  const t = summarize(rows).totals;
  assert.equal(t.unpricedTurns, 1);
  assert.equal(t.tokenUnavailableTurns, 1);
});

test('rollups flag whether a row has real token counts', () => {
  const s = summarize([
    measuredTurn({ id: 'a', ts: localAt(2026, 8, 30), model: 'claude-sonnet-5' }),
    unavailableTurn({ id: 'b', ts: localAt(2026, 8, 30) }),
  ]);
  const byModel = Object.fromEntries(s.byModel.map((r) => [r.name, r]));
  assert.equal(byModel['claude-sonnet-5'].tokenAvailable, true);
  assert.equal(byModel['claude-sonnet-5'].identified, true);
  assert.equal(byModel['unknown'].tokenAvailable, false);
  assert.equal(byModel['unknown'].identified, false);
});

test('project attribution ignores noise directories and records without a working directory', () => {
  assert.equal(projectOf({ meta: { project: 'debrief' } }), 'debrief');
  assert.equal(projectOf({ meta: { project: '_extracted' } }), UNCLASSIFIED);
  assert.equal(projectOf({ meta: { project: 'tmp' } }), UNCLASSIFIED);
  assert.equal(projectOf({ meta: { project: '15112' } }), UNCLASSIFIED);
  // an unavailable turn carries a chat title, never a project
  assert.equal(projectOf({ meta: { title: 'Some chat' } }), UNCLASSIFIED);
  assert.equal(projectOf({ meta: {} }), UNCLASSIFIED);
});

test('date filters bound the range inclusively', () => {
  const rows = [
    measuredTurn({ id: 'a', ts: localAt(2026, 8, 1) }),
    measuredTurn({ id: 'b', ts: localAt(2026, 8, 15) }),
    measuredTurn({ id: 'c', ts: localAt(2026, 8, 31) }),
  ];
  const s = summarize(rows, {
    filters: { from: localAt(2026, 8, 10, 0), to: localAt(2026, 8, 20, 23) },
  });
  assert.equal(s.totals.turns, 1);
});

// ---- tags ---------------------------------------------------------------

test('tag resolver matches project name and full cwd path, case-insensitively', () => {
  const tagOf = makeTagResolver({ $default: 'personal', work: ['*Work*', 'client-*'] });
  assert.equal(tagOf({ meta: { project: 'code', cwd: 'e:\\Work\\code' } }), 'work');
  assert.equal(tagOf({ meta: { project: 'docs-gen', cwd: 'E:\\work\\code\\docs-gen' } }), 'work');
  assert.equal(tagOf({ meta: { project: 'debrief', cwd: 'e:\\side-project\\debrief' } }), 'personal');
  assert.equal(tagOf({ meta: {} }), 'personal', 'unmatched -> default');
  assert.equal(tagOf.forProject('Work'), 'work');
});

test('no tag config turns the dimension off', () => {
  assert.equal(makeTagResolver(null), null);
  assert.equal(makeTagResolver({ $default: 'x' }), null, 'needs at least one rule');
  const s = summarize([measuredTurn({ id: 'a' })]);
  assert.deepEqual(s.byTag, []);
});

test('byTag rolls up, and the tag filter narrows the whole summary', () => {
  const tags = { $default: 'personal', work: ['*Work*'] };
  const rows = [
    measuredTurn({ id: 'a', project: 'debrief', input: 100, output: 50, cost: 0.4 }),
    measuredTurn({ id: 'b', project: 'code', input: 200, output: 20, cost: 0.9 }), // cwd default 'demo' — not work
    { ...measuredTurn({ id: 'c', input: 10, output: 5, cost: 0.1 }), meta: { project: 'code', cwd: 'e:\\Work\\code' } },
  ];
  const all = summarize(rows, { tags });
  const byTag = Object.fromEntries(all.byTag.map((r) => [r.name, r]));
  assert.equal(byTag.work.turns, 1);
  assert.equal(byTag.personal.turns, 2);

  const workOnly = summarize(rows, { tags, filters: { tags: ['work'] } });
  assert.equal(workOnly.totals.turns, 1);
  assert.equal(workOnly.totals.apiValue, 0.1);
});

test('byProject rows carry the tag from their real records', () => {
  const tags = { $default: 'personal', work: ['*Work*'] };
  const rows = [
    { ...measuredTurn({ id: 'a' }), meta: { project: 'code', cwd: 'e:\\Work\\code' } },
    measuredTurn({ id: 'b', project: 'debrief' }),
  ];
  const byProject = Object.fromEntries(summarize(rows, { tags }).byProject.map((r) => [r.name, r.tag]));
  assert.equal(byProject['code'], 'work');
  assert.equal(byProject['debrief'], 'personal');
});
