// Filtering + daily / weekly / monthly rollups over UsageRecords.
//
// All bucketing is done in the host machine's local time (the user's wall clock),
// which is what a personal "how much did I use today" dashboard expects.

import { sum, groupBy } from './util.js';

const GRANULARITIES = new Set(['daily', 'weekly', 'monthly']);

/** @param {Date} d */
function localParts(d) {
  return {
    y: d.getFullYear(),
    m: d.getMonth() + 1,
    day: d.getDate(),
  };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** ISO week key like "2026-W35", Monday-based, and the Monday's date. */
function isoWeek(d) {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayNum = (date.getDay() + 6) % 7; // Mon=0..Sun=6
  date.setDate(date.getDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(date.getFullYear(), 0, 4);
  const firstDayNum = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDayNum + 3);
  const week = 1 + Math.round((date - firstThursday) / (7 * 24 * 3600 * 1000));
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dayNum);
  return {
    key: `${date.getFullYear()}-W${pad(week)}`,
    start: `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`,
  };
}

export function bucketKey(record, granularity) {
  const d = new Date(record.timestamp);
  const { y, m, day } = localParts(d);
  if (granularity === 'monthly') return { key: `${y}-${pad(m)}`, label: `${y}-${pad(m)}` };
  if (granularity === 'weekly') {
    const w = isoWeek(d);
    return { key: w.key, label: w.start };
  }
  return { key: `${y}-${pad(m)}-${pad(day)}`, label: `${y}-${pad(m)}-${pad(day)}` };
}

/**
 * @param {UsageRecord[]} records
 * @param {Object} filters { from, to, sources[], models[], sessions[], projects[], measuredOnly }
 */
export function filterRecords(records, filters = {}) {
  const from = filters.from ? new Date(filters.from).getTime() : -Infinity;
  const to = filters.to ? new Date(filters.to).getTime() : Infinity;
  const srcSet = setOrNull(filters.sources);
  const modelSet = setOrNull(filters.models);
  const sessSet = setOrNull(filters.sessions);
  const projSet = setOrNull(filters.projects);

  return records.filter((r) => {
    const t = new Date(r.timestamp).getTime();
    if (t < from || t > to) return false;
    if (srcSet && !srcSet.has(r.source)) return false;
    if (modelSet && !modelSet.has(r.model)) return false;
    if (sessSet && !sessSet.has(r.session)) return false;
    if (projSet && !projSet.has(projectOf(r))) return false;
    if (filters.measuredOnly && !r.measured) return false;
    return true;
  });
}

function setOrNull(v) {
  if (!v || (Array.isArray(v) && v.length === 0)) return null;
  return new Set(Array.isArray(v) ? v : [v]);
}

export const UNCLASSIFIED = 'Unclassified';

// Working-directory basenames that carry no project meaning. Deliberately short:
// better to leave a real folder mislabeled than to guess it away.
const PROJECT_NOISE = new Set([
  '_extracted', 'tmp', 'temp', 'users', 'home', '.claude', '.codex', 'desktop', 'downloads', 'documents',
]);

/**
 * Best-effort project attribution from the local working-directory name.
 * Sources with no working directory (incomplete records) are Unclassified.
 */
export function projectOf(r) {
  const p = r.meta && r.meta.project;
  if (!p) return UNCLASSIFIED;
  const s = String(p).trim();
  if (!s || PROJECT_NOISE.has(s.toLowerCase())) return UNCLASSIFIED;
  if (/^\d+$/.test(s)) return UNCLASSIFIED; // e.g. a numeric Windows user folder
  return s;
}

/** A turn's token counts are real only when the source actually reports them. */
export function hasMeasuredTokens(r) {
  return r.tokenAvailability ? r.tokenAvailability === 'measured' : Boolean(r.measured);
}

function blankTotals() {
  return {
    turns: 0, // assistant turns — a real count for EVERY source
    // Token figures cover measured sources only. Sources that report no token
    // usage (incomplete records) contribute turns but never tokens.
    measuredTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    measuredTurns: 0,
    tokenUnavailableTurns: 0,
    apiValue: 0, // API-equivalent value of measured + priced turns
    unpricedTurns: 0, // measured turns whose model has no configured price
  };
}

function addInto(acc, r) {
  acc.turns += 1;

  if (!hasMeasuredTokens(r)) {
    acc.tokenUnavailableTurns += 1;
    return; // no tokens, no price — this turn is activity only
  }

  acc.measuredTurns += 1;
  acc.measuredTokens.input += r.tokens.input;
  acc.measuredTokens.output += r.tokens.output;
  acc.measuredTokens.cacheRead += r.tokens.cacheRead;
  acc.measuredTokens.cacheWrite += r.tokens.cacheWrite;
  acc.measuredTokens.total += r.tokens.total;

  if (r.cost.amount == null) {
    acc.unpricedTurns += 1;
  } else {
    acc.apiValue += r.cost.amount;
  }
}

/**
 * Full summary for the dashboard.
 * @returns {{ granularity, totals, buckets:[], bySource:[], byModel:[], sources:[] }}
 */
export function summarize(records, { granularity = 'daily', filters = {} } = {}) {
  if (!GRANULARITIES.has(granularity)) granularity = 'daily';
  const rows = filterRecords(records, filters);

  const sources = [...new Set(rows.map((r) => r.source))].sort();

  // Time buckets, each split by source so charts can stack.
  const bucketMap = new Map();
  for (const r of rows) {
    const { key, label } = bucketKey(r, granularity);
    if (!bucketMap.has(key)) {
      bucketMap.set(key, { key, label, ...blankTotals(), bySource: {}, _convs: new Set() });
    }
    const b = bucketMap.get(key);
    addInto(b, r);
    b._convs.add(r.source + ':' + r.session);

    if (!b.bySource[r.source]) {
      b.bySource[r.source] = { turns: 0, measuredTurns: 0, measuredTokens: 0, apiValue: 0, _convs: new Set() };
    }
    const bs = b.bySource[r.source];
    bs.turns += 1;
    bs._convs.add(r.session);
    if (hasMeasuredTokens(r)) {
      bs.measuredTurns += 1;
      bs.measuredTokens += r.tokens.total;
      bs.apiValue += r.cost.amount || 0;
    }
  }

  const buckets = [...bucketMap.values()]
    .map((b) => {
      b.conversations = b._convs.size;
      delete b._convs;
      for (const src of Object.keys(b.bySource)) {
        const bs = b.bySource[src];
        bs.conversations = bs._convs.size;
        delete bs._convs;
        // null (not 0) when the source reported no token usage at all
        if (bs.measuredTurns === 0) {
          bs.measuredTokens = null;
          bs.apiValue = null;
        }
      }
      return b;
    })
    .sort((a, b) => a.key.localeCompare(b.key));

  const bySource = rollup(groupBy(rows, (r) => r.source));
  const byModel = rollup(groupBy(rows, (r) => r.model));

  const projectGroups = groupBy(rows, projectOf);
  const byProject = rollup(projectGroups).map((row) => ({
    ...row,
    models: [...groupBy(projectGroups.get(row.name), (r) => r.model)].map(([model, items]) => ({
      model,
      tokens: items.reduce((sum, r) => sum + (hasMeasuredTokens(r) ? r.tokens.total : 0), 0),
    })).filter((m) => m.tokens > 0).sort((a, b) => b.tokens - a.tokens),
  }));

  const totals = blankTotals();
  for (const r of rows) addInto(totals, r);

  totals.activeDays = new Set(rows.map((r) => bucketKey(r, 'daily').key)).size;
  totals.conversations = new Set(rows.map((r) => r.source + ':' + r.session)).size;

  return { granularity, filters, totals, buckets, bySource, byModel, byProject, sources };
}

function rollup(map) {
  const out = [];
  for (const [name, items] of map) {
    const acc = blankTotals();
    for (const r of items) addInto(acc, r);
    acc.conversations = new Set(items.map((r) => r.session)).size;
    acc.sources = [...new Set(items.map((r) => r.source))].sort();
    // Does this row have real token counts at all?
    acc.tokenAvailable = acc.measuredTurns > 0;
    // A row is "identified" when the real model came from the provider's logs.
    acc.identified = name !== 'unknown' && items.every((r) => r.modelMeasured !== false);
    acc.pricingModel = items[0].pricingModel || (name !== 'unknown' ? name : null);
    out.push({ name, ...acc });
  }
  return out.sort(
    (a, b) => b.measuredTokens.total - a.measuredTokens.total || b.turns - a.turns || b.apiValue - a.apiValue
  );
}

/** Distinct dimension values for building filter controls. */
export function facets(records) {
  return {
    sources: [...new Set(records.map((r) => r.source))].sort(),
    models: [...new Set(records.map((r) => r.model))].sort(),
    projects: [...new Set(records.map(projectOf))].sort(),
    range: dateRange(records),
    count: records.length,
  };
}

function dateRange(records) {
  if (!records.length) return { from: null, to: null };
  let from = records[0].timestamp;
  let to = records[0].timestamp;
  for (const r of records) {
    if (r.timestamp < from) from = r.timestamp;
    if (r.timestamp > to) to = r.timestamp;
  }
  return { from, to };
}
