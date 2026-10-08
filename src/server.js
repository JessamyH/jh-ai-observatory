import { generateInsights } from './insights.js';
// Minimal zero-dependency HTTP server: static dashboard + read-only JSON API.
//
// Endpoints:
//   GET  /                         -> dashboard
//   GET  /api/meta                 -> store info + filter facets + pricing
//   GET  /api/summary?...          -> rollups for the current filter/granularity
//   GET  /api/records?...&limit=   -> filtered raw records (drill-down)
//   POST /api/ingest               -> run an incremental ingest now
//
// Query params for summary/records:
//   from, to        ISO date (inclusive day handled client-side by sending to=end-of-day)
//   source          repeatable
//   model           repeatable
//   project         repeatable
//   granularity     daily | weekly | monthly   (summary only)
//   limit, offset   (records only)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './core/store.js';
import { scopeRecords } from './core/scope.js';
import { summarize, facets, filterRecords } from './core/aggregate.js';
import { Pricing, compareModels } from './core/pricing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', 'web');

/**
 * Keeps the parsed store in memory and re-reads it only when the file changes.
 * Without this, every filter click re-parses a multi-megabyte JSON file.
 */
function storeCache(storePath) {
  let cached = null;
  let fingerprint = null;
  return {
    invalidate() {
      cached = null;
    },
    async get() {
      let fp = null;
      try {
        const st = await stat(storePath);
        fp = `${st.mtimeMs}:${st.size}`;
      } catch {
        fp = 'missing';
      }
      if (cached && fp === fingerprint) return cached;
      const store = new Store(storePath);
      await store.load();
      cached = store;
      fingerprint = fp;
      return store;
    },
  };
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export async function startServer({
  storePath,
  settings = null,
  port = 4317,
  host = '127.0.0.1',
  display = null,
  tags = null,
  pricingOverrides = null,
  ingest = null, // async () => ingest result; enables auto-refresh + POST /api/ingest
  autoIngestMinutes = 0,
  mock = false, // serving generated demo data (flagged in /api/meta)
  log = () => {},
}) {
  const rates = (display && display.rates) || { USD: 1 };
  const pricing = new Pricing(pricingOverrides || {});
  const cache = storeCache(storePath);

  // One ingest at a time; concurrent callers await the run already in flight.
  let settingsBusy = false;
  let inFlight = null;
  let lastIngestAt = null;
  const runIngestOnce = async () => {
    if (!ingest) return null;
    if (!inFlight) {
      inFlight = (async () => {
        try {
          const result = await ingest();
          cache.invalidate();
          lastIngestAt = new Date().toISOString();
          return result;
        } finally {
          inFlight = null;
        }
      })();
    }
    return inFlight;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/api/settings/paths') {
        if (!settings) return send(res, 501, { error: 'Path settings unavailable' });
        if (req.method === 'GET') return send(res, 200, settings.get());
        if (req.method !== 'PUT') return send(res, 405, { error: 'PUT required' });
        if (req.headers.origin !== `http://${req.headers.host}` || !['localhost', '127.0.0.1', '[::1]', host].includes(url.hostname)) return send(res, 403, { error: 'Same-origin dashboard requests only' });
        if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'JSON required' });
        if (settingsBusy) return send(res, 409, { error: 'Path update in progress. Try again.' });
        settingsBusy = true;
        try {
          let body = '';
          for await (const chunk of req) {
            body += chunk.toString();
            if (Buffer.byteLength(body) > 65536) return send(res, 413, { error: 'Path list too large' });
          }
          if (inFlight) await inFlight;
          const result = await settings.save(JSON.parse(body));
          let warning = ingest ? null : 'Collection is disabled (--no-ingest). Restart without --no-ingest to collect these directories.';
          try {
            const collected = await runIngestOnce();
            warning = collected?.warnings?.join('; ') || warning;
          } catch (err) { warning = `Paths saved, but collection failed: ${err.message}`; }
          return send(res, 200, { ...result, warning });
        } catch (err) { return send(res, 400, { error: err.message }); }
        finally { settingsBusy = false; }
      }
      if (url.pathname === '/api/insights') {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });
        if (req.headers.origin !== `http://${req.headers.host}` || !['127.0.0.1', 'localhost'].includes(url.hostname)) return send(res, 403, { error: 'Local dashboard requests only' });
        if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'JSON required' });
        let body = '';
        for await (const chunk of req) {
          body += chunk.toString();
          if (Buffer.byteLength(body) > 100000) return send(res, 413, { error: 'Summary too large' });
        }
        try {
          const text = await generateInsights(JSON.parse(body));
          return send(res, 200, { text });
        } catch (err) {
          return send(res, 400, { error: err.name === 'TimeoutError' ? 'Claude request timed out. Try again.' : err.message });
        }
      }
      if (url.pathname === '/api/ingest') {
        if (settingsBusy) return send(res, 409, { error: 'Path update in progress' });
        if (!ingest) return send(res, 501, { error: 'ingest not available' });
        const started = Date.now();
        const result = await runIngestOnce();
        return send(res, 200, {
          ok: true,
          ms: Date.now() - started,
          added: result && result.merged ? result.merged.added : 0,
          updated: result && result.merged ? result.merged.updated : 0,
          ingestedAt: lastIngestAt,
        });
      }
      if (url.pathname.startsWith('/api/')) {
        const store = await cache.get();
        await handleApi(url, res, store, { display, tags, pricing, autoIngestMinutes, mock, projectRoots: settings?.get().projectRoots || [] });
      } else {
        await handleStatic(url, res);
      }
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  });

  let timer = null;
  if (ingest && autoIngestMinutes > 0) {
    timer = setInterval(() => {
      if (settingsBusy) return;
      runIngestOnce().catch((err) => log(`  auto-ingest failed: ${err.message}`));
    }, autoIngestMinutes * 60_000);
    timer.unref?.();
  }

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      log(`JH AI Observatory -> http://${host}:${port}`);
      if (ingest && autoIngestMinutes > 0) log(`  auto-ingest every ${autoIngestMinutes} min`);
      server.on('close', () => timer && clearInterval(timer));
      resolve(server);
    });
  });
}

async function handleApi(url, res, store, opts = {}) {
  const records = scopeRecords(store.records, opts.projectRoots);

  if (url.pathname === '/api/meta') {
    const display = opts.display || {};
    const rates = display.rates && typeof display.rates === 'object' ? { ...display.rates } : {};
    rates.USD = 1;

    // rates (USD per 1M tokens) for every model in the price table plus any
    // unpriced model seen in usage — for the reference table.
    const used = new Set(
      records
        .map((r) => r.model)
        .concat(records.map((r) => r.pricingModel).filter(Boolean))
        .filter((m) => m && m !== 'unknown')
    );
    const modelIds = [...new Set([...opts.pricing.knownModels(), ...used])].sort(compareModels);
    const pricing = modelIds.map((model) => ({
      model,
      rates: opts.pricing.effectiveRates(model),
      used: used.has(model),
      ...opts.pricing.priceMeta(model),
    }));

    return send(res, 200, {
      generatedAt: store.generatedAt,
      needsSetup: !opts.projectRoots?.length,
      mock: Boolean(opts.mock),
      storePath: store.filePath,
      autoIngestMinutes: opts.autoIngestMinutes || 0,
      display: { currency: display.currency || 'USD', rates },
      tags: opts.tags || null,
      pricing,
      facets: facets(records, opts.tags),
    });
  }

  const filters = parseFilters(url.searchParams);

  if (url.pathname === '/api/summary') {
    const granularity = url.searchParams.get('granularity') || 'daily';
    const summary = summarize(records, { granularity, filters, tags: opts.tags });
    return send(res, 200, summary);
  }

  if (url.pathname === '/api/records') {
    const limit = clampInt(url.searchParams.get('limit'), 1, 5000, 200);
    const offset = clampInt(url.searchParams.get('offset'), 0, 1e9, 0);
    const filtered = filterRecords(records, filters).sort((a, b) =>
      b.timestamp.localeCompare(a.timestamp)
    );
    return send(res, 200, {
      total: filtered.length,
      limit,
      offset,
      records: filtered.slice(offset, offset + limit),
    });
  }

  return send(res, 404, { error: 'unknown endpoint' });
}

function parseFilters(sp) {
  return {
    from: sp.get('from') || null,
    to: sp.get('to') || null,
    sources: sp.getAll('source'),
    models: sp.getAll('model'),
    projects: sp.getAll('project'),
    tags: sp.getAll('tag'),
    // kept for API compatibility; the dashboard no longer offers this toggle
    measuredOnly: sp.get('measuredOnly') === '1',
  };
}

async function handleStatic(url, res) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  rel = rel.replace(/\.\.+/g, '.'); // basic traversal guard
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) return send(res, 403, 'forbidden');
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    send(res, 404, 'not found');
  }
}

function send(res, status, payload) {
  const isObj = typeof payload === 'object';
  res.writeHead(status, {
    'content-type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
  });
  res.end(isObj ? JSON.stringify(payload) : String(payload));
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
