// The canonical shape every source must emit. One record = one billable AI turn
// (an assistant response) with its token counts, cost, and provenance.
//
// Keeping this contract small and explicit is what lets the dashboard stay
// "trustworthy": every field is either measured from the provider or clearly
// flagged as estimated.

import { round } from './util.js';

export const STORE_VERSION = 1;

/**
 * @typedef {Object} UsageRecord
 * @property {string}  id         Stable dedupe key, "<source>:<nativeId>".
 * @property {string}  source     e.g. "claude-code", "codex".
 * @property {string}  timestamp  ISO 8601 UTC.
 * @property {string}  model      Provider model id, best effort ("unknown" allowed).
 * @property {string}  session    Conversation / session id.
 * @property {Object}  tokens     { input, output, cacheRead, cacheWrite, total }
 * @property {Object}  cost       { amount: number|null, currency: "USD", estimated: boolean }
 * @property {boolean} measured   true = token counts came from the provider; false = estimated.
 * @property {Object}  meta       Source-specific extras (project, title, branch, ...).
 */

export function makeRecord(input) {
  const tokens = normalizeTokens(input.tokens);
  const rec = {
    id: String(input.id),
    source: String(input.source),
    timestamp: new Date(input.timestamp).toISOString(),
    model: input.model || 'unknown',
    // modelMeasured: did the real model id come from the provider's logs?
    // false = the source does not record it.
    modelMeasured: input.modelMeasured !== false,
    // pricingModel: which model's rates were used to compute `cost`. Equal to
    // `model` when known; null when no price could be applied.
    pricingModel: input.pricingModel || (input.model && input.model !== 'unknown' ? input.model : null),
    // tokenAvailability: "measured" = real counts from the provider's logs;
    // "unavailable" = the source does not report token usage at all (incomplete
    // logs). Never "estimated" — a guess is not a measurement.
    tokenAvailability: input.tokenAvailability || (input.measured ? 'measured' : 'unavailable'),
    session: input.session ? String(input.session) : 'unknown',
    tokens,
    cost: {
      amount: input.cost && input.cost.amount != null ? round(input.cost.amount, 6) : null,
      currency: (input.cost && input.cost.currency) || 'USD',
      estimated: Boolean(input.cost && input.cost.estimated),
    },
    measured: Boolean(input.measured),
    meta: input.meta && typeof input.meta === 'object' ? input.meta : {},
  };
  return rec;
}

export function normalizeTokens(t = {}) {
  const input = int(t.input);
  const output = int(t.output);
  const cacheRead = int(t.cacheRead);
  const cacheWrite = int(t.cacheWrite);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  };
}

function int(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

const REQUIRED = ['id', 'source', 'timestamp', 'model', 'session', 'tokens', 'cost'];

/** Returns an array of problem strings; empty array = valid. */
export function validateRecord(rec) {
  const problems = [];
  for (const key of REQUIRED) {
    if (rec[key] == null) problems.push(`missing "${key}"`);
  }
  if (rec.timestamp && isNaN(new Date(rec.timestamp))) problems.push('bad timestamp');
  if (rec.tokens && typeof rec.tokens.total !== 'number') problems.push('tokens.total not numeric');
  if (rec.cost && rec.cost.amount != null && typeof rec.cost.amount !== 'number') {
    problems.push('cost.amount not numeric');
  }
  return problems;
}
