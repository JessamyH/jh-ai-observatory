import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/core/store.js';
import { validateRecord } from '../src/core/schema.js';
import { measuredTurn, unavailableTurn } from './helpers.js';

async function tmpStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'obs-store-'));
  const store = new Store(path.join(dir, 'store.json'));
  await store.load();
  return { store, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('merging the same id updates in place instead of appending', async () => {
  const { store, cleanup } = await tmpStore();
  try {
    const first = store.merge([measuredTurn({ id: 'a', cost: 0.1 }), measuredTurn({ id: 'b' })]);
    assert.deepEqual([first.added, first.updated, first.total], [2, 0, 2]);

    const second = store.merge([measuredTurn({ id: 'a', cost: 0.9 })]);
    assert.deepEqual([second.added, second.updated, second.total], [0, 1, 2]);
    assert.equal(store.byId.get('claude-code:a').cost.amount, 0.9, 're-ingest picks up corrected values');
  } finally {
    await cleanup();
  }
});

test('a full re-ingest of identical data adds nothing', async () => {
  const { store, cleanup } = await tmpStore();
  try {
    const batch = [measuredTurn({ id: 'a' }), measuredTurn({ id: 'b' }), unavailableTurn({ id: 'c' })];
    store.merge(batch);
    const again = store.merge(batch);
    assert.equal(again.added, 0);
    assert.equal(again.total, 3);
  } finally {
    await cleanup();
  }
});

test('save then load round-trips the records', async () => {
  const { store, cleanup } = await tmpStore();
  try {
    store.merge([measuredTurn({ id: 'a' }), unavailableTurn({ id: 'b' })]);
    await store.save();

    const reopened = new Store(store.filePath);
    await reopened.load();
    assert.equal(reopened.records.length, 2);
    assert.equal(reopened.byId.get('unavailable-source:b').tokenAvailability, 'unavailable');
    assert.equal(reopened.byId.get('unavailable-source:b').cost.amount, null, 'null cost survives the round trip');
  } finally {
    await cleanup();
  }
});

test('prune removes only what the predicate matches', async () => {
  const { store, cleanup } = await tmpStore();
  try {
    store.merge([measuredTurn({ id: 'a' }), measuredTurn({ id: 'b' }), unavailableTurn({ id: 'c' })]);
    const removed = store.prune((r) => r.source === 'claude-code');
    assert.equal(removed, 2);
    assert.equal(store.records.length, 1);
    assert.equal(store.byId.has('claude-code:a'), false, 'the id index is updated too');
    assert.equal(store.byId.has('unavailable-source:c'), true);
  } finally {
    await cleanup();
  }
});

test('invalid records are rejected, not stored', async () => {
  const { store, cleanup } = await tmpStore();
  try {
    const bad = { ...measuredTurn({ id: 'a' }), timestamp: 'not-a-date' };
    const res = store.merge([bad, measuredTurn({ id: 'ok' })]);
    assert.equal(res.invalid, 1);
    assert.equal(res.added, 1);
  } finally {
    await cleanup();
  }
});

test('validateRecord accepts a null cost but rejects a broken timestamp', () => {
  assert.deepEqual(validateRecord(unavailableTurn({ id: 'w' })), [], 'null cost is valid');
  assert.ok(validateRecord({ ...measuredTurn({ id: 'a' }), timestamp: 'nope' }).includes('bad timestamp'));
});

test('loading a legacy store excludes retired website sources and keeps CLI records', async () => {
  const { store, cleanup } = await tmpStore();
  try {
    store.merge([
      measuredTurn({ id: 'claude', source: 'claude-code' }),
      measuredTurn({ id: 'codex', source: 'codex' }),
      unavailableTurn({ id: 'old-chatgpt', source: 'chatgpt' }),
      unavailableTurn({ id: 'old-claude', source: 'claude-web' }),
    ]);
    await store.save();
    const reopened = await new Store(store.filePath).load();
    assert.deepEqual(reopened.records.map((r) => r.source).sort(), ['claude-code', 'codex']);
    assert.equal(reopened.byId.size, 2);
  } finally {
    await cleanup();
  }
});
