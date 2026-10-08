#!/usr/bin/env node
// JH AI Observatory - CLI entry point.
//
//   node observatory.js ingest [--source <name>] [--config <path>]
//   node observatory.js serve  [--port <n>] [--config <path>]
//   node observatory.js serve --mock  (generated demo data, port 4318)
//   node observatory.js stats  [--granularity daily|weekly|monthly]
//   node observatory.js sources
//
// Zero runtime dependencies. Node >= 18.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIngest } from './src/ingest.js';
import { startServer } from './src/server.js';
import { Store } from './src/core/store.js';
import { summarize } from './src/core/aggregate.js';
import { pathSettings, ensureConfig } from './src/settings.js';
import { allSources } from './src/sources/index.js';
import { Pricing } from './src/core/pricing.js';
import { MOCK_ROOT, writeMockStore } from './src/mock.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  const configPath = args.config ? path.resolve(args.config) : path.join(ROOT, 'config.json');
  if (!args.config && (await ensureConfig(configPath))) console.log('Created config.json from config.example.json.');
  const config = await loadConfig(configPath);
  const baseDir = path.dirname(configPath);
  const storePath = config.storePath
    ? path.resolve(baseDir, config.storePath)
    : path.join(ROOT, 'data', 'store.json');

  switch (cmd) {
    case 'ingest':
      return cmdIngest({ config, baseDir, storePath, only: args.source || null, prune: Boolean(args.prune) });
    case 'serve':
      return cmdServe({
        configPath,
        config,
        baseDir,
        storePath,
        port: args.port ? Number(args.port) : null,
        noIngest: Boolean(args['no-ingest']),
        mock: Boolean(args.mock),
      });
    case 'stats':
      return cmdStats({
        storePath,
        granularity: args.granularity || 'daily',
        display: config.display,
      });
    case 'sources':
      console.log('Registered sources:');
      for (const s of allSources()) {
        const sc = (config.sources && config.sources[s]) || {};
        console.log(`  ${s}${sc.enabled === false ? '  (disabled)' : ''}`);
      }
      return;
    default:
      printHelp();
      process.exitCode = cmd ? 1 : 0;
  }
}

async function cmdIngest(opts) {
  const t0 = Date.now();
  console.log(`Ingesting into ${opts.storePath}`);
  const { perSource, merged, pruned, warnings } = await runIngest({ ...opts, log: (m) => console.log(m) });

  console.log('\n--- summary ---');
  for (const s of perSource) {
    console.log(`  ${s.name.padEnd(14)} ${String(s.records).padStart(6)} turn(s)${s.error ? `  ERROR: ${s.error}` : ''}`);
  }
  if (merged) {
    const p = pruned ? `, -${pruned} pruned` : '';
    console.log(`\n  store: +${merged.added} new, ~${merged.updated} updated${p}, ${merged.invalid} invalid, ${merged.total - (pruned || 0)} total`);
  }
  if (warnings.length) {
    console.log('\n  warnings:');
    for (const w of warnings.slice(0, 20)) console.log(`   - ${w}`);
    if (warnings.length > 20) console.log(`   ...and ${warnings.length - 20} more`);
  }
  console.log(`\nDone in ${Date.now() - t0}ms. Run "node observatory.js serve" to view the dashboard.`);
}

async function cmdServe({ configPath, config, baseDir, storePath, port, noIngest, mock }) {
  const srv = config.server || {};
  if (mock) return cmdServeMock({ config, port });
  // Ingest is incremental, so refreshing on start and on a timer is cheap:
  // unchanged source files are fingerprinted and skipped entirely.
  const ingest = noIngest ? null : () => runIngest({ config, baseDir, storePath });

  if (ingest) {
    process.stdout.write('Refreshing usage data... ');
    const t0 = Date.now();
    try {
      const { merged, needsSetup } = await ingest();
      console.log(needsSetup ? 'waiting for detection directories in Settings.' : merged ? `done in ${Date.now() - t0}ms (+${merged.added} new, ${merged.total} turns)` : 'no enabled sources.');
    } catch (err) {
      console.log(`failed: ${err.message}`);
    }
  }

  const store = new Store(storePath);
  await store.load();
  if (store.records.length === 0) {
    console.log('Note: the store is empty. Check your source paths in config.json.\n');
  }

  await startServer({
    settings: pathSettings({ config, configPath, baseDir }),
    storePath,
    ingest,
    autoIngestMinutes: srv.autoIngestMinutes != null ? srv.autoIngestMinutes : 5,
    port: port || srv.port || 4317,
    host: srv.host || '127.0.0.1',
    display: config.display || null,
    pricingOverrides: config.pricingOverrides || null,
    log: (m) => console.log(m),
  });
}

/** Serve generated demo data on its own port and store; real logs are never read. */
async function cmdServeMock({ config, port }) {
  const srv = config.server || {};
  const storePath = path.join(ROOT, 'data', 'mock-store.json');
  const pricing = new Pricing(config.pricingOverrides || {});
  // Dates end "today", so regenerate once the day rolls over; a long-running
  // server would otherwise drift out of the default "last 30 days" view.
  let generatedFor = new Date().toDateString();
  await writeMockStore(storePath, { pricing });
  setInterval(() => {
    if (new Date().toDateString() === generatedFor) return;
    generatedFor = new Date().toDateString();
    writeMockStore(storePath, { pricing }).catch((err) => console.log(`Mock refresh failed: ${err.message}`));
  }, 60 * 60 * 1000).unref();
  const roots = { projectRoots: [MOCK_ROOT], availableRoots: [MOCK_ROOT] };
  await startServer({
    settings: {
      get: () => roots,
      save: async () => { throw new Error('Mock mode: detection directories are read-only.'); },
    },
    storePath,
    mock: true,
    port: port || 4318,
    host: srv.host || '127.0.0.1',
    display: config.display || null,
    pricingOverrides: config.pricingOverrides || null,
    log: (m) => console.log(m),
  });
  console.log('  MOCK DATA - generated demo usage, not your real logs');
}

async function cmdStats({ storePath, granularity, display }) {
  const store = new Store(storePath);
  await store.load();
  if (store.records.length === 0) {
    console.log('Store is empty. Run "node observatory.js ingest" first.');
    return;
  }
  const cur = (display && display.currency) || 'USD';
  const rate = (display && display.rates && display.rates[cur]) || 1;
  const money = (usd) => `${cur} ${(usd * rate).toFixed(2)}`;

  const s = summarize(store.records, { granularity });
  const t = s.totals;

  console.log(`Date range:   ${s.buckets[0]?.label} -> ${s.buckets.at(-1)?.label}  (${t.activeDays} active days)`);

  const mt = t.measuredTokens;
  console.log('\nUSAGE  (what you consumed)');
  console.log(`  Turns:          ${fmt(t.turns)}  across ${fmt(t.conversations)} conversation(s)`);
  console.log(`  Measured tokens:${fmt(mt.total).padStart(15)}  (in ${fmt(mt.input)} / out ${fmt(mt.output)} / cache ${fmt(mt.cacheRead + mt.cacheWrite)})`);
  if (t.tokenUnavailableTurns) {
    console.log(`  ${fmt(t.tokenUnavailableTurns)} turn(s) have no token usage data`);
  }
  if (t.unpricedTurns) console.log(`  ${fmt(t.unpricedTurns)} measured turn(s) use an unpriced model`);
  console.log(`  API value*:     ${money(t.apiValue)}  (measured tokens at configured prices — not a bill)`);

  const tok = (row) => (row.tokenAvailable ? fmt(row.measuredTokens.total).padStart(14) + ' tok' : '—'.padStart(18));
  const val = (row) => (row.tokenAvailable ? money(row.apiValue).padStart(13) : '—'.padStart(13));
  console.log('\nBy source:');
  for (const row of s.bySource) {
    console.log(`  ${row.name.padEnd(20)} ${val(row)}   ${tok(row)}   ${row.turns} turns`);
  }
  console.log('\nBy model (measured only):');
  for (const row of s.byModel.filter((r) => r.tokenAvailable)) {
    console.log(`  ${row.name.padEnd(22)} ${val(row)}   ${tok(row)}`);
  }
  console.log('\nBy project (measured only):');
  for (const row of s.byProject.filter((r) => r.tokenAvailable).slice(0, 10)) {
    console.log(`  ${row.name.padEnd(22)} ${val(row)}   ${tok(row)}   ${row.turns} turns`);
  }
  console.log(`\nLast ${Math.min(s.buckets.length, 14)} ${granularity} buckets:`);
  for (const b of s.buckets.slice(-14)) {
    const bt = b.measuredTokens.total ? fmt(b.measuredTokens.total).padStart(13) + ' tok' : '—'.padStart(17);
    console.log(`  ${b.label.padEnd(12)} ${String(b.turns).padStart(5)} turns  ${bt}   ${b.measuredTokens.total ? money(b.apiValue) : ''}`);
  }

}

function fmt(n) {
  return n.toLocaleString('en-US');
}

function parseArgs(rest) {
  const out = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

async function loadConfig(configPath) {
  try {
    return JSON.parse(await readFile(configPath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`Config not found at ${configPath}. Copy config.example.json to config.json and adjust it.`);
      process.exit(1);
    }
    console.error(`Could not read config: ${err.message}`);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`JH AI Observatory

Usage:
  node observatory.js ingest [--source <name>]   Collect usage from all enabled sources
  node observatory.js serve  [--port <n>]        Start the local dashboard
  node observatory.js serve --mock               Demo dashboard with generated data (port 4318)
  node observatory.js stats  [--granularity ...] Print a summary to the terminal
  node observatory.js sources                    List registered sources

Options:
  --config <path>   Use an alternate config.json
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
