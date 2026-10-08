// Ingest orchestrator: run enabled sources, merge results into the store.

import { Store } from './core/store.js';
import { Pricing } from './core/pricing.js';
import { enabledSources } from './sources/index.js';

export async function runIngest({
  config,
  baseDir,
  storePath,
  only = null,
  prune = false,
  sourceModules = null, // override the registry (tests)
  log = () => {},
}) {
  const pricing = new Pricing(config.pricingOverrides || {});
  const store = new Store(storePath);
  await store.load();
  const roots = config.projectRoots || [];
  if (!roots.length) {
    log('Add a detection directory in Settings to start collecting usage.');
    return { store, perSource: [], merged: null, warnings: [], needsSetup: true };
  }
  // Changing the detection scope must re-read logs previously skipped by the cache.
  if (JSON.stringify(store.projectRoots) !== JSON.stringify(roots)) store.fileCache = {};
  store.projectRoots = [...roots];
  // Cost is computed at parse time, so a price change must re-read every log too.
  const pricingKey = JSON.stringify(pricing.table);
  if (store.pricingKey !== pricingKey) store.fileCache = {};
  store.pricingKey = pricingKey;

  const sources = sourceModules || enabledSources(config, only);
  if (sources.length === 0) {
    log(only ? `No enabled source named "${only}".` : 'No sources enabled in config.json.');
    return { store, perSource: [], merged: null, warnings: [] };
  }

  // Incremental scan: a source file whose { mtimeMs, size } is unchanged has
  // already been parsed, and its records are still in the store. --prune needs
  // every record re-emitted to know what is stale, so it forces a full re-scan.
  const nextCache = {};
  let currentSource = null; // set before each collect, so a failed source can be rolled back
  const cache = prune
    ? null
    : {
        unchanged(file, fp) {
          const p = store.fileCache[file];
          return p && p.mtimeMs === fp.mtimeMs && p.size === fp.size;
        },
        note(file, fp) {
          nextCache[file] = { ...fp, source: currentSource };
        },
        keep(file) {
          nextCache[file] = { ...store.fileCache[file], source: currentSource };
        },
      };

  const perSource = [];
  const allWarnings = [];
  let collected = [];

  for (const mod of sources) {
    const sourceConfig = (config.sources && config.sources[mod.name]) || {};
    log(`\n> ${mod.name}`);
    currentSource = mod.name;
    const started = Date.now();
    try {
      const { records, warnings = [], skipped = 0, authoritative = false } = await mod.collect({
        sourceConfig,
        baseDir,
        pricing,
        projectRoots: config.projectRoots || [],
        cache,
        log,
      });
      collected = collected.concat(records);
      allWarnings.push(...warnings);
      perSource.push({ name: mod.name, records: records.length, skipped, authoritative, ms: Date.now() - started, warnings });
      const skipNote = skipped ? `, ${skipped} unchanged file(s) skipped` : '';
      log(`  ${records.length} record(s) in ${Date.now() - started}ms${skipNote}`);
    } catch (err) {
      perSource.push({ name: mod.name, records: 0, error: err.message });
      allWarnings.push(`${mod.name}: ${err.message}`);
      log(`  ERROR: ${err.message}`);
    }
  }

  const merged = store.merge(collected);

  // --prune drops stored records of the sources that just ran successfully but
  // were NOT re-emitted. Opt-in on purpose: local CLI logs can be rotated away,
  // and the store is then the only copy of that history. Use it after a record-id
  // format change, or when an export is authoritative for the whole source.
  let pruned = 0;
  if (prune) {
    const ranOk = new Set(
      perSource.filter((s) => !s.error && (s.records > 0 || s.authoritative)).map((s) => s.name)
    );
    if (ranOk.size) {
      const keep = new Set(collected.map((r) => r.id));
      pruned = store.prune((r) => ranOk.has(r.source) && !keep.has(r.id));
      if (pruned) log(`  pruned ${pruned} stale record(s) no longer produced by: ${[...ranOk].join(', ')}`);
    }
  }

  if (cache) {
    // Only sources that finished cleanly keep their fingerprints — a source that
    // threw part-way must be re-parsed next time. Entries belonging to sources
    // that did not run at all (e.g. `--source x`) are preserved untouched.
    const failed = new Set(perSource.filter((s) => s.error).map((s) => s.name));
    const next = {};
    for (const [file, fp] of Object.entries(store.fileCache)) {
      if (!(file in nextCache)) next[file] = fp;
    }
    for (const [file, fp] of Object.entries(nextCache)) {
      if (!failed.has(fp.source)) next[file] = fp;
    }
    store.fileCache = next;
  } else {
    store.fileCache = {}; // a full re-scan invalidates every fingerprint
  }

  await store.save();

  // De-duplicate identical warnings (e.g. "no price for model X" repeated).
  const uniqueWarnings = [...new Set(allWarnings)];

  return { store, perSource, merged, pruned, warnings: uniqueWarnings };
}
