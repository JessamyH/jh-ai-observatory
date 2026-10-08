// The incremental file cache is only safe if a skipped file's records are
// already in the store. These tests pin that invariant down.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runIngest } from '../src/ingest.js';
import { Store } from '../src/core/store.js';
import { codexRollout } from './helpers.js';

/** A scratch workspace with one Codex rollout file the ingest can read. */
async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'obs-ingest-'));
  const sessions = path.join(root, 'sessions', '2026', '08', '30');
  await mkdir(sessions, { recursive: true });
  const file = path.join(sessions, 'rollout-2026-08-30T01-00-00-01a0505a-5998-74e1-a417-19755f9950eb.jsonl');
  await writeFile(file, codexRollout({ events: [{ input: 100, output: 10 }, { input: 150, output: 25 }] }), 'utf8');

  const config = {
    projectRoots: [path.dirname(path.resolve('E:\\side-project\\demo'))],
    sources: {
      'claude-code': { enabled: false },
      codex: { enabled: true, sessionsDir: path.join(root, 'sessions') },
    },
  };
  return {
    root,
    file,
    storePath: path.join(root, 'store.json'),
    config,
    run: (extra = {}) => runIngest({ config, baseDir: root, storePath: path.join(root, 'store.json'), ...extra }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('an unchanged file is skipped on the next run, and its records survive', async () => {
  const w = await workspace();
  try {
    const first = await w.run();
    assert.equal(first.perSource[0].records, 2);
    assert.equal(first.merged.added, 2);

    const second = await w.run();
    assert.equal(second.perSource[0].skipped, 1, 'the file is fingerprinted and skipped');
    assert.equal(second.perSource[0].records, 0, 'nothing is re-parsed');
    assert.equal(second.merged.total, 2, 'but the records are still in the store');
  } finally {
    await w.cleanup();
  }
});

test('a price change re-parses unchanged files so stored costs are recomputed', async () => {
  const w = await workspace();
  try {
    await w.run();
    const repriced = { ...w.config, pricingOverrides: { 'gpt-5-codex': { input: 99 } } };
    const res = await runIngest({ config: repriced, baseDir: w.root, storePath: w.storePath });
    assert.equal(res.perSource[0].skipped, 0, 'the fingerprint cache was reset');
    assert.equal(res.merged.updated, 2, 'every record was re-priced');
  } finally {
    await w.cleanup();
  }
});

test('a changed file is re-parsed and new turns are picked up', async () => {
  const w = await workspace();
  try {
    await w.run();
    await writeFile(
      w.file,
      codexRollout({ events: [{ input: 100, output: 10 }, { input: 150, output: 25 }, { input: 400, output: 90 }] }),
      'utf8'
    );
    const after = await w.run();
    assert.equal(after.perSource[0].skipped, 0);
    assert.equal(after.merged.added, 1, 'the third turn is new');
    assert.equal(after.merged.total, 3);
  } finally {
    await w.cleanup();
  }
});

test('a file that is touched but identical in size and mtime stays skipped', async () => {
  const w = await workspace();
  try {
    await w.run();
    const second = await w.run();
    assert.equal(second.perSource[0].skipped, 1);
  } finally {
    await w.cleanup();
  }
});

test('changing mtime alone forces a re-parse', async () => {
  const w = await workspace();
  try {
    await w.run();
    const future = new Date(Date.now() + 60_000);
    await utimes(w.file, future, future);
    const second = await w.run();
    assert.equal(second.perSource[0].skipped, 0, 'a new mtime invalidates the fingerprint');
    assert.equal(second.perSource[0].records, 2);
  } finally {
    await w.cleanup();
  }
});

test('--prune forces a full re-scan, so nothing valid is pruned away', async () => {
  const w = await workspace();
  try {
    await w.run();
    const pruned = await w.run({ prune: true });
    assert.equal(pruned.perSource[0].skipped, 0, 'prune must never rely on the cache');
    assert.equal(pruned.perSource[0].records, 2, 'every record is re-emitted');
    assert.equal(pruned.pruned, 0, 'so nothing looks stale');
    assert.equal(pruned.merged.total, 2);
  } finally {
    await w.cleanup();
  }
});

test('--prune drops records a source no longer produces', async () => {
  const w = await workspace();
  try {
    await w.run();
    // shrink the rollout to a single turn
    await writeFile(w.file, codexRollout({ events: [{ input: 100, output: 10 }] }), 'utf8');
    const after = await w.run({ prune: true });
    assert.equal(after.pruned, 1);

    const store = new Store(w.storePath);
    await store.load();
    assert.equal(store.records.length, 1);
  } finally {
    await w.cleanup();
  }
});

test('deleting the store also resets the cache, so everything re-parses', async () => {
  const w = await workspace();
  try {
    await w.run();
    await rm(w.storePath);
    const after = await w.run();
    assert.equal(after.perSource[0].skipped, 0);
    assert.equal(after.merged.added, 2, 'records come back rather than being skipped into a void');
  } finally {
    await w.cleanup();
  }
});

test('a missing source directory is reported but leaves the store intact', async () => {
  const w = await workspace();
  try {
    await w.run();
    const bad = {
      ...w.config,
      sources: { ...w.config.sources, codex: { enabled: true, sessionsDir: path.join(w.root, 'gone') } },
    };
    const res = await runIngest({ config: bad, baseDir: w.root, storePath: w.storePath });
    assert.ok(res.warnings.some((x) => /sessions dir not found/i.test(x)));
    assert.equal(res.merged.total, 2, 'existing records are untouched');
  } finally {
    await w.cleanup();
  }
});

test('a source that throws after reading files does not keep its fingerprints', async () => {
  const w = await workspace();
  try {
    // This source fingerprints the file (so it would be skipped next time) and
    // *then* fails — the run must not leave that fingerprint behind.
    const flaky = {
      name: 'codex',
      shouldThrow: true,
      async collect(ctx) {
        const { partitionChangedFiles } = await import('../src/core/util.js');
        const { changed, skipped } = await partitionChangedFiles([w.file], ctx.cache);
        if (flaky.shouldThrow) throw new Error('boom, half-way through');
        return { records: [], warnings: [], skipped: skipped + changed.length * 0 };
      },
    };

    const failed = await runIngest({
      config: w.config,
      baseDir: w.root,
      storePath: w.storePath,
      sourceModules: [flaky],
    });
    assert.ok(failed.perSource[0].error, 'the run is recorded as failed');

    // A later healthy run must still see the file as changed, not cached away.
    const real = await w.run();
    assert.equal(real.perSource[0].skipped, 0, 'the failed run left no fingerprint');
    assert.equal(real.perSource[0].records, 2, 'so the turns are parsed');
  } finally {
    await w.cleanup();
  }
});

test('changing project roots re-reads unchanged logs that were outside the previous scope', async () => {
  const w = await workspace();
  try {
    const projectRoot = path.join(w.root, 'projects');
    const body = codexRollout({ events: [{ input: 100, output: 10 }] }).split('\n').filter(Boolean).map(JSON.parse);
    body[0].payload.cwd = path.join(projectRoot, 'demo');
    await writeFile(w.file, body.map(JSON.stringify).join('\n') + '\n');
    w.config.projectRoots = [path.join(w.root, 'other')];
    assert.equal((await w.run()).merged.total, 0);
    assert.equal((await w.run()).perSource[0].skipped, 1);
    w.config.projectRoots = [projectRoot];
    const updated = await w.run();
    assert.equal(updated.perSource[0].skipped, 0);
    assert.equal(updated.merged.total, 1);
    assert.equal(updated.store.records[0].meta.project, 'demo');
    assert.equal((await w.run()).perSource[0].skipped, 1);
  } finally { await w.cleanup(); }
});

test('no selected roots skips collectors and preserves the stored snapshot', async () => {
  const w = await workspace();
  try {
    await w.run();
    const { readFile } = await import('node:fs/promises');
    const before = await readFile(w.storePath, 'utf8');
    delete w.config.projectRoots;
    const result = await w.run({ sourceModules: [{ name: 'codex', collect() { throw new Error('must not run'); } }] });
    assert.equal(result.needsSetup, true);
    assert.deepEqual(result.perSource, []);
    assert.equal(await readFile(w.storePath, 'utf8'), before);
  } finally { await w.cleanup(); }
});
