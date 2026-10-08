// Model price table, in USD per 1,000,000 tokens.
//
// Accuracy note: prices change and vary by region/tier. Treat computed cost as a
// close estimate, not an invoice. Override or extend via config.json ->
// "pricingOverrides". A record whose model is not in the table gets cost = null
// (shown as "unpriced" in the dashboard) rather than a wrong number.
//
// Anthropic prices verified against the Claude API skill table (cached 2026-09-25).
// Cache multipliers follow Anthropic's public schedule:
//   cache read      = 0.10x input
//   cache write 5m  = 1.25x input
//   cache write 1h  = 2.00x input
// OpenAI prices are best-effort public list prices; verify for your account.

const M = 1_000_000;

const CLAUDE_FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'];

/** Reference-table order: Claude before others, then family, then newest version first. */
export function compareModels(a, b) {
  const key = (id) => {
    const claude = id.startsWith('claude');
    const family = claude ? CLAUDE_FAMILIES.findIndex((f) => id.includes(f)) : id.startsWith('gpt') ? 0 : 1;
    const version = (id.match(/\d+(?:[.-]\d+)*/) || [''])[0].replaceAll('-', '.');
    return { provider: claude ? 0 : 1, family, version };
  };
  const ka = key(a);
  const kb = key(b);
  return ka.provider - kb.provider
    || ka.family - kb.family
    || kb.version.localeCompare(ka.version, undefined, { numeric: true })
    || a.localeCompare(b);
}

/** hue-free base table. cacheRead/cacheWrite* default to Anthropic multipliers when omitted. */
const BASE_TABLE = {
  // --- Anthropic (Claude) ---
  'claude-fable-5': { input: 10, output: 50 },
  // Fable 5.1's cache read is 0.025x input (not the usual 0.1x) - verified against
  // the public pricing page, so it's spelled out explicitly rather than relying
  // on the default multiplier in cost()/effectiveRates().
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-mythos-5': { input: 10, output: 50 },
  // Opus 5.5's cache read is $0.20 (0.05x input), not the default 0.1x.
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-3-7-sonnet': { input: 3, output: 15 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },

  // --- OpenAI API --- verify against your plan
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075 },
  'gpt-4.1': { input: 2, output: 8, cacheRead: 0.5 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cacheRead: 0.1 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4, cacheRead: 0.025 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'gpt-4': { input: 30, output: 60 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  'o1': { input: 15, output: 60, cacheRead: 7.5 },
  'o1-mini': { input: 1.1, output: 4.4, cacheRead: 0.55 },
  'o3': { input: 2, output: 8, cacheRead: 0.5 },
  'o3-mini': { input: 1.1, output: 4.4, cacheRead: 0.55 },
  'o4-mini': { input: 1.1, output: 4.4, cacheRead: 0.275 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025 },
  'gpt-5-nano': { input: 0.05, output: 0.4, cacheRead: 0.005 },
  'gpt-5-codex': { input: 1.25, output: 10, cacheRead: 0.125 },
  'gpt-5.1': { input: 1.25, output: 10, cacheRead: 0.125 },
  'gpt-5.1-codex': { input: 1.25, output: 10, cacheRead: 0.125 },
  'gpt-5.1-codex-mini': { input: 0.25, output: 2, cacheRead: 0.025 },
  // Short-context rates from developers.openai.com/api/docs/pricing (2026-09-29);
  // the higher long-context tier is not modeled. These bill cache writes explicitly.
  'gpt-6-astra': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'gpt-5.6-sol': { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  // Other preview model ids have no built-in price - add them under
  // config.json -> pricingOverrides, with source / effectiveUntil / note.
};

const META_KEYS = new Set(['source', 'url', 'effectiveFrom', 'effectiveUntil', 'note', 'notes']);

const CLAUDE_RE = /^claude/;

/** Normalize a raw model id to a table key. Strips date suffixes and known prefixes. */
export function normalizeModel(raw) {
  if (!raw) return 'unknown';
  let m = String(raw).toLowerCase().trim();
  m = m.replace(/^(anthropic\.|openai\.|us\.|eu\.)/, '');
  m = m.replace(/[@:]\d{6,8}$/, ''); // claude-opus-4-5@20251101
  m = m.replace(/-\d{8}$/, ''); //   gpt-4o-2024-08-06 -> handled below too
  m = m.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  m = m.replace(/-latest$/, '');
  if (BASE_TABLE[m]) return m;
  // Progressive fallback: drop trailing suffix segments until we hit a known key.
  // Stop at a version number, so an unlisted release (claude-opus-5-5) stays
  // unpriced instead of silently borrowing an older model's rates.
  const parts = m.split('-');
  while (parts.length > 1) {
    if (/^\d/.test(parts.at(-1))) break;
    parts.pop();
    const candidate = parts.join('-');
    if (BASE_TABLE[candidate]) return candidate;
  }
  return m;
}

export class Pricing {
  constructor(overrides = {}) {
    this.table = { ...BASE_TABLE };
    for (const [k, v] of Object.entries(overrides || {})) {
      if (k.startsWith('$')) continue;
      this.table[k.toLowerCase()] = { ...(this.table[k.toLowerCase()] || {}), ...v };
    }
  }

  rateFor(model) {
    const key = normalizeModel(model);
    return this.table[key] || null;
  }

  /**
   * Compute USD cost for one record's token breakdown.
   * @param {string} model
   * @param {{input:number,output:number,cacheRead:number,cacheWrite:number,cacheWrite5m?:number,cacheWrite1h?:number}} tokens
   * @returns {{amount:number|null, estimated:boolean}}
   */
  cost(model, tokens) {
    const r = this.rateFor(model);
    if (!r) return { amount: null, estimated: false };

    const inRate = r.input || 0;
    const isClaude = CLAUDE_RE.test(normalizeModel(model));
    // Anthropic bills cache writes (1.25x / 2x input); OpenAI and others don't.
    const cacheReadRate = r.cacheRead != null ? r.cacheRead : inRate * 0.1;
    const cw5mRate = r.cacheWrite5m != null ? r.cacheWrite5m : r.cacheWrite != null ? r.cacheWrite : isClaude ? inRate * 1.25 : 0;
    const cw1hRate = r.cacheWrite1h != null ? r.cacheWrite1h : isClaude ? inRate * 2.0 : 0;

    const cw = tokens.cacheWrite || 0;
    let cw5m = tokens.cacheWrite5m;
    let cw1h = tokens.cacheWrite1h;
    if (cw5m == null && cw1h == null) {
      cw5m = cw; // no breakdown available -> assume 5-minute TTL
      cw1h = 0;
    } else {
      cw5m = cw5m || 0;
      cw1h = cw1h || 0;
    }

    const amount =
      ((tokens.input || 0) * inRate +
        (tokens.output || 0) * (r.output || 0) +
        (tokens.cacheRead || 0) * cacheReadRate +
        cw5m * cw5mRate +
        cw1h * cw1hRate) /
      M;

    return { amount, estimated: false };
  }

  knownModels() {
    return Object.keys(this.table).sort();
  }

  /** Effective USD-per-1M-token rates for display. null when the model is unpriced. */
  effectiveRates(model) {
    const r = this.rateFor(model);
    if (!r) return null;
    const inRate = r.input || 0;
    const isClaude = CLAUDE_RE.test(normalizeModel(model));
    return {
      input: inRate,
      output: r.output || 0,
      cacheRead: r.cacheRead != null ? r.cacheRead : inRate * 0.1,
      cacheWrite:
        r.cacheWrite5m != null ? r.cacheWrite5m : r.cacheWrite != null ? r.cacheWrite : isClaude ? inRate * 1.25 : 0,
    };
  }

  /** Provenance for a model's price: { source, effectiveFrom, effectiveUntil, note }. */
  priceMeta(model) {
    const r = this.rateFor(model);
    const out = {};
    if (r) for (const k of META_KEYS) if (r[k] != null) out[k] = r[k];
    return out;
  }
}
