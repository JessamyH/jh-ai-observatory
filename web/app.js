import { generateInsights, parseInsights, listModels, DEFAULT_MODEL, FALLBACK_MODELS } from '/insights.js';
// Dashboard controller: read filters -> hit the API -> render KPIs, charts, table.

import { donut, stackedBar, rankBar, bindHoverHtml, fmtCompact, fmtInt, h } from '/charts.js';

const MODEL_STORAGE = 'obs-insights-model';
const CUSTOM_MODEL = '__custom__';
const CURRENCY_SYMBOLS = { USD: '$', AUD: 'A$', CNY: '¥', NZD: 'NZ$', CAD: 'C$', EUR: '€', GBP: '£', JPY: '¥', SGD: 'S$', INR: '₹' };

const state = {
  meta: null,
  granularity: 'daily',
  range: '30',
  model: '',
  project: '',
  sources: null, // null = all; otherwise Set
  sourceColors: {},
  customFrom: null,
  customTo: null,
  sourceMetric: 'turns',
  usageMetric: 'turns',
  usageMode: 'bars',
  lastSummary: null,
  currency: 'USD',
  rates: { USD: 1 },
  money: (n) => (n == null ? '—' : '$' + Number(n).toFixed(2)),
};

/** USD amount -> display-currency string. */
function makeMoney(currency, rate) {
  const sym = CURRENCY_SYMBOLS[currency] || currency + ' ';
  return (usd) => {
    if (usd == null) return '—';
    const v = usd * rate;
    if (v === 0) return sym + '0';
    const abs = Math.abs(v);
    if (abs < 0.01) return sym + v.toFixed(4);
    if (abs < 1) return sym + v.toFixed(3);
    return sym + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
}

const $ = (sel) => document.querySelector(sel);

init();

async function init() {
  setupTheme();
  wireControls();
  try {
    state.meta = await getJSON('/api/meta');
  } catch (e) {
    $('#app').prepend(errorBox('Could not reach the server. Is `node observatory.js serve` running?'));
    return;
  }
  setupCurrency(state.meta.display);
  assignSourceColors(state.meta.facets.sources);
  buildSourceChecks(state.meta.facets.sources);
  buildModelOptions(state.meta.facets.models);
  rebuildProjectOptions();
  renderMeta();
  renderPricingTable(state.meta.pricing);
  await refresh();
}

/** claude-opus-5-5 -> "Claude Opus 5.5", claude-3-5-sonnet -> "Claude 3.5 Sonnet". */
function prettyModel(id) {
  const words = [];
  for (const w of id.split('-')) {
    const numeric = /^[\d.]+$/.test(w);
    // consecutive version segments are one dotted version number
    if (numeric && /^[\d.]+$/.test(words.at(-1) || '')) words[words.length - 1] += '.' + w;
    else words.push(w === 'gpt' ? 'GPT' : numeric || /^o\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1));
  }
  return words.join(' ');
}

function officialPricingUrl(model, p) {
  if (p.url) return p.url;
  if (/^claude/.test(model)) return 'https://www.anthropic.com/pricing#api';
  if (/^(gpt|o\d|chatgpt)/.test(model)) return 'https://platform.openai.com/docs/pricing';
  return null;
}

/** Reference table: model unit prices only. Details live behind the ⓘ tooltip. */
function renderPricingTable(pricing) {
  const card = $('#pricing-card');
  if (!pricing || !pricing.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $('#pricing-subtitle').textContent = `${state.currency} per 1M tokens · API reference rates`;

  const tbody = $('#pricing-table tbody');
  tbody.innerHTML = '';
  pricing.forEach((p) => {
    const cells = p.rates
      ? [p.rates.input, p.rates.output, p.rates.cacheRead, p.rates.cacheWrite].map((r) => state.money(r))
      : ['Unpriced', 'Unpriced', 'Unpriced', 'Unpriced'];
    const row = document.createElement('tr');

    // model name (linked) + optional Promo badge
    const name = document.createElement('td');
    const url = officialPricingUrl(p.model, p);
    const label = prettyModel(p.model);
    const nameEl = url
      ? h('a', { href: url, target: '_blank', rel: 'noopener', class: 'model-link', title: p.model }, label)
      : h('span', { title: p.model }, label);
    // flex lives on an inner wrapper: flex on the <td> itself breaks the row's borders
    const wrap = h('span', { class: 'model-cell' }, nameEl);
    if (p.used) wrap.appendChild(h('span', { class: 'badge in-use' }, 'In use'));
    if (p.effectiveUntil) wrap.appendChild(h('span', { class: 'badge promo' }, 'Promo'));
    name.appendChild(wrap);
    row.appendChild(name);

    cells.forEach((c) => {
      const td = document.createElement('td');
      td.className = 'num';
      td.textContent = c;
      row.appendChild(td);
    });

    // ⓘ details
    const info = document.createElement('td');
    info.className = 'pricing-info-cell';
    const notes = Array.isArray(p.notes) ? p.notes : p.note ? [p.note] : [];
    if (notes.length || p.source) {
      const btn = h('button', { type: 'button', class: 'info-btn', 'aria-label': 'pricing details' }, 'ⓘ');
      const html =
        `<div class="tt-title">API reference pricing</div>` +
        notes.map((n) => `<div class="tt-line">${n}</div>`).join('') +
        (p.source ? `<div class="tt-line muted">Source: ${p.source}</div>` : '');
      bindHoverHtml(btn, html);
      info.appendChild(btn);
    }
    row.appendChild(info);

    tbody.appendChild(row);
  });

  renderCalculator(pricing);
}

// ---- API cost calculator -------------------------------------------------

/** "100k" -> 100000, "1.5m" -> 1500000, "1,000,000" -> 1000000, "" -> 0. */
function parseTokens(str) {
  const s = String(str || '').trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, '');
  if (!s) return 0;
  const m = s.match(/^([\d.]+)\s*([kmb])?$/);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return NaN;
  return Math.round(n * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1));
}

let calcWired = false;

function renderCalculator(pricing) {
  const priced = (pricing || []).filter((p) => p.rates);
  const card = $('#calc-card');
  if (!priced.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const modelSel = $('#calc-model');
  const keep = modelSel.value;
  modelSel.innerHTML = '';
  priced.forEach((p) => modelSel.appendChild(h('option', { value: p.model }, prettyModel(p.model))));
  if (keep && priced.some((p) => p.model === keep)) modelSel.value = keep;

  if (!calcWired) {
    ['calc-model', 'calc-input', 'calc-output', 'calc-cached', 'calc-cachew'].forEach((id) =>
      $('#' + id).addEventListener('input', computeCalc)
    );
    $('#calc-clear').addEventListener('click', () => {
      ['calc-input', 'calc-output', 'calc-cached', 'calc-cachew'].forEach((id) => ($('#' + id).value = ''));
      computeCalc();
    });
    $('#calc-use').addEventListener('click', useCurrentUsage);
    calcWired = true;
  }
  computeCalc();
}

function useCurrentUsage() {
  const s = state.lastSummary;
  if (!s) return;
  // Respect whatever's already picked in the calculator's own Model select;
  // only fall back (dashboard filter, then top model) if nothing valid is chosen yet.
  const priced = (state.meta.pricing || []).filter((p) => p.rates).map((p) => p.model);
  const picked = $('#calc-model').value;
  let model = picked && priced.includes(picked) ? picked : null;
  if (!model) model = state.model && priced.includes(state.model) ? state.model : null;
  if (!model) {
    const top = (s.byModel || []).find((m) => m.tokenAvailable && priced.includes(m.name));
    model = top ? top.name : priced[0];
    // if a specific model row exists, prefer its own token split
  }
  const row = (s.byModel || []).find((m) => m.name === model);
  const t = row ? row.measuredTokens : s.totals.measuredTokens;
  $('#calc-model').value = model;
  $('#calc-input').value = String(t.input); // stored input is already the uncached part
  $('#calc-output').value = String(t.output);
  $('#calc-cached').value = String(t.cacheRead);
  $('#calc-cachew').value = String(t.cacheWrite);
  computeCalc();
}

function computeCalc() {
  const out = $('#calc-result');
  const p = (state.meta.pricing || []).find((x) => x.model === $('#calc-model').value);
  if (!p || !p.rates) {
    out.innerHTML = '<p class="calc-unavailable">Pricing unavailable for this model.</p>';
    return;
  }
  const cur = state.currency;
  const money = makeMoney(cur, state.rates[cur] || 1); // takes a USD amount, returns `cur`

  const fields = [
    ['New input', 'calc-input', p.rates.input],
    ['Output', 'calc-output', p.rates.output],
    ['Cached input', 'calc-cached', p.rates.cacheRead],
    ['Cache write', 'calc-cachew', p.rates.cacheWrite],
  ];

  let total = 0;
  let bad = false;
  const rows = fields.map(([label, id, usdRatePerM]) => {
    const n = parseTokens($('#' + id).value);
    if (isNaN(n)) {
      bad = true;
      return `<tr><td>${label}</td><td colspan="3">?</td></tr>`;
    }
    const lineUsd = (n * usdRatePerM) / 1e6;
    total += lineUsd;
    return `<tr><td>${label}</td><td>${fmtInt(n)}</td><td>× ${money(usdRatePerM)}/M</td><td>${money(lineUsd)}</td></tr>`;
  });

  out.innerHTML = bad
    ? '<p class="calc-unavailable">Enter numbers like 100k, 1.5m or 250000.</p>'
    : `<table><tbody>${rows.join('')}<tr class="total"><td>Total</td><td></td><td></td><td>${money(
        total
      )}</td></tr></tbody></table>`;
}

// ---- controls ---------------------------------------------------------------

function wireControls() {
  $('#settings-open').addEventListener('click', () => { $('#settings-dialog').showModal(); loadPathSettings(); });
  $('#paths-add').addEventListener('click', addPathFromInput);
  $('#paths-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); addPathFromInput(); } });
  $('#paths-save').addEventListener('click', savePathSettings);
  $('#setup-open').addEventListener('click', () => $('#settings-open').click());
  $('#settings-close').addEventListener('click', () => $('#settings-dialog').close());
  const keyInput = $('#insights-key');
  const keyStorage = 'obs-claude-api-key';
  keyInput.value = localStorageGet(keyStorage) || '';
  const saveKey = () => {
    try {
      const value = keyInput.value.trim();
      if (value) localStorage.setItem(keyStorage, value);
      else localStorage.removeItem(keyStorage);
    } catch {
      $('#insights-status').textContent = 'Browser storage is unavailable. Your key will only last for this page.';
    }
  };
  keyInput.addEventListener('input', saveKey);
  wireModelPicker(keyInput);
  $('#insights-clear').addEventListener('click', () => {
    keyInput.value = '';
    saveKey();
  });
  $('#insights-generate').addEventListener('click', generateUsageInsights);
  $('#range').addEventListener('change', (e) => {
    if (e.target.value === 'custom') {
      // keep whatever dates are currently shown as the starting custom range
      state.customFrom = $('#date-from').value || null;
      state.customTo = $('#date-to').value || null;
    }
    state.range = e.target.value;
    refresh();
  });
  const onCustomDate = () => {
    state.customFrom = $('#date-from').value || null;
    state.customTo = $('#date-to').value || null;
    state.range = 'custom';
    $('#range').value = 'custom';
    refresh();
  };
  $('#date-from').addEventListener('change', onCustomDate);
  $('#date-to').addEventListener('change', onCustomDate);
  $('#model').addEventListener('change', (e) => {
    state.model = e.target.value;
    refresh();
  });
  $('#project').addEventListener('change', (e) => {
    state.project = e.target.value;
    refresh();
  });
  $('#granularity').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.granularity = btn.dataset.value;
    [...e.currentTarget.children].forEach((b) => b.classList.toggle('active', b === btn));
    refresh();
  });
  $('#source-metric').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.sourceMetric = btn.dataset.value;
    [...e.currentTarget.children].forEach((b) => b.classList.toggle('active', b === btn));
    if (state.lastSummary) renderSourceChart(state.lastSummary);
  });
  const usageToggle = (key, alsoTable) => (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state[key] = btn.dataset.value;
    [...e.currentTarget.children].forEach((b) => b.classList.toggle('active', b === btn));
    if (state.lastSummary) {
      renderUsageOverTime(state.lastSummary);
      if (alsoTable) renderTable(state.lastSummary);
    }
  };
  $('#usage-metric').addEventListener('click', usageToggle('usageMetric', true));
  $('#usage-mode').addEventListener('click', usageToggle('usageMode', false));
  $('#refresh').addEventListener('click', triggerIngest);
  $('#breakdown-toggle').addEventListener('click', () => {
    const toggle = $('#breakdown-toggle');
    const expanded = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(expanded));
    $('#breakdown-rows').hidden = !expanded;
  });
  // keep the "updated N ago" label honest without polling the server
  setInterval(() => state.meta && renderMeta(), 30_000);
}

function buildSourceChecks(sources) {
  const wrap = $('#sources');
  wrap.innerHTML = '';
  sources.forEach((s) => {
    const id = 'src-' + s;
    const label = h('label', { for: id });
    const cb = h('input', { type: 'checkbox', id, checked: 'checked', value: s });
    cb.checked = state.sources === null || state.sources.has(s);
    cb.addEventListener('change', () => {
      const checked = [...wrap.querySelectorAll('input:checked')].map((i) => i.value);
      state.sources = checked.length === sources.length ? null : new Set(checked);
      refresh();
    });
    label.append(cb, swatch(state.sourceColors[s]), document.createTextNode(' ' + s));
    wrap.appendChild(label);
  });
}

function buildModelOptions(models) {
  const sel = $('#model');
  sel.replaceChildren(h('option', { value: '' }, 'All models'));
  if (!models.includes(state.model)) state.model = '';
  models.filter((m) => m !== 'unknown').forEach((m) => sel.appendChild(h('option', { value: m }, m)));
}

/** Keep a select stable at the width of its longest label. */
function fixSelectWidth(sel, labels) {
  const canvas = fixSelectWidth.canvas || (fixSelectWidth.canvas = document.createElement('canvas'));
  const ctx = canvas.getContext('2d');
  ctx.font = getComputedStyle(sel).font;
  const textWidth = Math.max(...labels.map((label) => ctx.measureText(label).width), 0);
  // Text + horizontal padding + the native dropdown arrow, bounded for long paths.
  sel.style.width = `${Math.min(280, Math.max(150, Math.ceil(textWidth + 48)))}px`;
}

/** Project dropdown, built from the projects in the store. */
function rebuildProjectOptions() {
  const projects = (state.meta.facets.projects || []).filter((p) => p !== 'Unclassified');
  if (state.project && !projects.includes(state.project)) state.project = ''; // stale selection
  const sel = $('#project');
  sel.innerHTML = '';
  sel.appendChild(h('option', { value: '' }, 'All projects'));
  projects.forEach((p) => sel.appendChild(h('option', { value: p }, p)));
  sel.value = state.project;
  fixSelectWidth(sel, ['All projects', ...projects]);
}

function setupCurrency(display = {}) {
  state.rates = { USD: 1, ...(display.rates || {}) };
  const saved = localStorageGet('obs-currency');
  const codes = Object.keys(state.rates);
  state.currency = codes.includes(saved) ? saved : codes.includes(display.currency) ? display.currency : 'USD';

  const sel = $('#currency');
  sel.innerHTML = '';
  codes.forEach((code) => {
    const rateHint = code === 'USD' ? '' : `  (1 USD = ${state.rates[code]})`;
    sel.appendChild(h('option', { value: code }, code + rateHint));
  });
  sel.value = state.currency;
  applyCurrency();

  sel.addEventListener('change', (e) => {
    state.currency = e.target.value;
    localStorageSet('obs-currency', state.currency);
    applyCurrency();
    if (state.meta) renderPricingTable(state.meta.pricing);
    refresh();
  });
}

function applyCurrency() {
  state.money = makeMoney(state.currency, state.rates[state.currency] || 1);
}

// ---- data + render --------------------------------------------------------
//
// The whole render layer honours one rule: a figure is shown only where it is
// real. Turns and conversations exist for every source. Tokens, models and
// API-equivalent value exist only for sources that actually report them; where
// they don't, the UI shows "—", never 0.

async function refresh() {
  state.meta = await getJSON('/api/meta');
  assignSourceColors(state.meta.facets.sources);
  buildSourceChecks(state.meta.facets.sources);
  renderMeta();
  const params = new URLSearchParams();
  params.set('granularity', state.granularity);

  const { from, to } = currentRangeDates();
  // the two date inputs always reflect the effective range
  if (document.activeElement !== $('#date-from')) $('#date-from').value = from || '';
  if (document.activeElement !== $('#date-to')) $('#date-to').value = to || '';
  if (from) params.set('from', from + 'T00:00:00');
  if (to) params.set('to', to + 'T23:59:59.999');

  if (state.model) params.set('model', state.model);
  if (state.project) params.set('project', state.project);
  if (state.sources) [...state.sources].forEach((s) => params.append('source', s));

  const summary = await getJSON('/api/summary?' + params.toString());
  render(summary);
}

function sourceColor(name) {
  return state.sourceColors[name] || 'var(--series-8)';
}

/** A token/value figure that is absent rather than zero. */
const DASH = '—';
const tokenCell = (n) => (n == null ? DASH : fmtInt(n));
const compactCell = (n) => (n == null ? DASH : fmtCompact(n));

function render(s) {
  state.lastSummary = s;
  $('#setup-prompt').hidden = !state.meta.needsSetup;
  $('#app').classList.toggle('needs-setup', state.meta.needsSetup);
  $('#empty-state').hidden = state.meta.needsSetup || s.totals.turns > 0;

  renderKPIs(s.totals);
  renderUsageOverTime(s);
  renderModelChart(s);
  renderSourceChart(s);
  renderProjectChart(s);
  renderTable(s);
}

// ---- KPIs -----------------------------------------------------------------

function renderKPIs(t) {
  const mt = t.measuredTokens;
  const notes = [];
  if (t.tokenUnavailableTurns) {
    notes.push(`${fmtInt(t.tokenUnavailableTurns)} turns have no token usage data`);
  }
  if (t.unpricedTurns) notes.push(`${fmtInt(t.unpricedTurns)} measured turns use an unpriced model`);
  $('#kpi-note').textContent = notes.join(' · ');

  fillKpiRow($('#kpis'), [
    { label: 'Assistant turns', value: fmtInt(t.turns), sub: 'all sources', hero: true },
    { label: 'Conversations', value: fmtInt(t.conversations), sub: 'all sources' },
    {
      label: 'Measured tokens',
      value: mt.total ? fmtCompact(mt.total) : DASH,
      sub: mt.total
        ? `${fmtCompact(mt.input)} in · ${fmtCompact(mt.output)} out · ${fmtCompact(mt.cacheRead + mt.cacheWrite)} cache`
        : 'no source in range reports tokens',
    },
    { label: 'Active days', value: fmtInt(t.activeDays), sub: 'days with activity' },
  ]);
}

function fillKpiRow(row, kpis) {
  row.innerHTML = '';
  kpis.forEach((k) => {
    row.appendChild(
      h('div', { class: 'kpi' }, [
        h('div', { class: 'label' }, k.label),
        h('div', { class: 'value' + (k.hero ? ' hero' : '') }, k.value),
        h('div', { class: 'sub' }, k.sub),
      ])
    );
  });
}

// ---- 1. Usage over time ---------------------------------------------------

function renderUsageOverTime(s) {
  const metric = state.usageMetric; // 'turns' | 'tokens'
  const cumulative = state.usageMode === 'cumulative';

  const tokenSources = new Set((s.bySource || []).filter((r) => r.tokenAvailable).map((r) => r.name));
  const excluded = (s.sources || []).filter((src) => !tokenSources.has(src));
  // Turns are real for every source; token counts only for measured ones.
  const shown = metric === 'turns' ? s.sources.slice().sort() : s.sources.filter((x) => tokenSources.has(x)).sort();

  const running = {};
  const buckets = s.buckets.map((b) => ({
    label: b.label,
    segments: shown.map((src) => {
      const d = b.bySource[src];
      let v = metric === 'turns' ? (d && d.turns) || 0 : (d && d.measuredTokens) || 0;
      if (cumulative) {
        running[src] = (running[src] || 0) + v;
        v = running[src];
      }
      return { name: src, value: v };
    }),
  }));

  stackedBar($('#chart-usage'), {
    buckets,
    seriesOrder: shown,
    color: sourceColor,
    valueFormat: metric === 'turns' ? fmtInt : fmtCompact,
    tooltipHtml: (i) => usageTooltip(s, i, shown, metric),
  });

  const modeBySource = {};
  (s.bySource || []).forEach((r) => (modeBySource[r.name] = r.mode));
  legend($('#legend-usage'), shown, sourceColor, modeBySource);

  const bits = [];
  if (metric === 'turns') {
    bits.push(cumulative ? 'assistant turns, running total — all sources' : 'assistant turns per period — all sources');
  } else {
    bits.push(cumulative ? 'measured tokens, running total' : 'measured tokens per period, stacked by source');
    if (excluded.length) bits.push('Records without token usage are excluded — see the Turns view');
  }
  $('#usage-note').textContent = bits.join(' · ');
}

/** Tooltip shows only what the active metric can honestly report. */
function usageTooltip(s, i, shown, metric) {
  const b = s.buckets[i];
  const nameEl = (src) =>
    `<span class="tt-g-name"><span class="swatch" style="background:${sourceColor(src)}"></span>${src}</span>`;
  const present = shown.filter((src) => b.bySource[src]);

  if (metric === 'turns') {
    const groups = present
      .map((src) => {
        const d = b.bySource[src];
        return (
          `<div class="tt-group">${nameEl(src)}` +
          `<div class="tt-g-lines">${fmtInt(d.turns)} turns · ${fmtInt(d.conversations)} conversation${
            d.conversations === 1 ? '' : 's'
          }</div></div>`
        );
      })
      .join('');
    return groups + `<div class="tt-foot">Total ${fmtInt(b.turns)} turns · ${fmtInt(b.conversations)} conversations</div>`;
  }

  const mt = b.measuredTokens;
  const groups = present
    .map((src) => {
      const d = b.bySource[src];
      return `<div class="tt-group">${nameEl(src)}<div class="tt-g-lines">${compactCell(d.measuredTokens)} tokens</div></div>`;
    })
    .join('');
  const detail = `<div class="tt-foot">${fmtCompact(mt.input)} in · ${fmtCompact(mt.output)} out · ${fmtCompact(
    mt.cacheRead + mt.cacheWrite
  )} cache<br>Total ${fmtCompact(mt.total)} measured tokens</div>`;
  return groups + detail;
}

// ---- 2. Usage by model ----------------------------------------------------

const TOKEN_KEYS = [
  { key: 'input', label: 'Input', color: 'var(--series-1)' },
  { key: 'output', label: 'Output', color: 'var(--series-2)' },
  { key: 'cacheRead', label: 'Cache read', color: 'var(--series-3)' },
  { key: 'cacheWrite', label: 'Cache write', color: 'var(--series-4)' },
];
const tokenColor = (k) => (TOKEN_KEYS.find((t) => t.key === k) || {}).color || 'var(--series-8)';

function renderModelChart(s) {
  // Only models whose usage was actually measured can be ranked by tokens.
  const rows = foldRows(s.byModel.filter((m) => m.tokenAvailable && m.identified), 8);
  const excludedTurns = s.byModel.filter((m) => !m.tokenAvailable).reduce((a, m) => a + m.turns, 0);

  rankBar($('#chart-models'), {
    color: tokenColor,
    legendKeys: TOKEN_KEYS,
    rows: rows.map((m) => ({
      name: m.name,
      primaryLabel: fmtCompact(m.measuredTokens.total),
      segments: TOKEN_KEYS.map((t) => ({ key: t.key, value: m.measuredTokens[t.key] || 0 })),
      detail: `${fmtCompact(m.measuredTokens.total)} tokens · ${fmtInt(m.turns)} turns · ${
        m.unpricedTurns >= m.turns ? 'Unpriced' : `${state.money(m.apiValue)} API value*`
      }`,
      tip: [
        { k: 'Tokens', v: fmtInt(m.measuredTokens.total) },
        { k: 'Input', v: fmtInt(m.measuredTokens.input), color: tokenColor('input') },
        { k: 'Output', v: fmtInt(m.measuredTokens.output), color: tokenColor('output') },
        { k: 'Cache read', v: fmtInt(m.measuredTokens.cacheRead), color: tokenColor('cacheRead') },
        { k: 'Cache write', v: fmtInt(m.measuredTokens.cacheWrite), color: tokenColor('cacheWrite') },
        { k: 'Turns', v: fmtInt(m.turns) },
        { k: 'API value*', v: m.unpricedTurns >= m.turns ? 'Unpriced' : state.money(m.apiValue) },
      ],
    })),
  });

  $('#models-note').textContent = excludedTurns
    ? `${fmtInt(excludedTurns)} turns excluded because model or token usage is unavailable.`
    : 'measured tokens, split by type';
}

// ---- 3. Usage by source ---------------------------------------------------

function renderSourceChart(s) {
  const metric = state.sourceMetric; // 'tokens' | 'turns' | 'conversations'
  const valueOf = (r) =>
    metric === 'turns' ? r.turns : metric === 'conversations' ? r.conversations : r.tokenAvailable ? r.measuredTokens.total : null;
  const fmtVal = (n) => (n == null ? DASH : metric === 'tokens' ? fmtCompact(n) : fmtInt(n));

  const rows = (s.bySource || []).slice().sort((a, b) => (valueOf(b) || 0) - (valueOf(a) || 0));
  const grand = rows.reduce((a, r) => a + (valueOf(r) || 0), 0) || 1;

  rankBar($('#chart-sources'), {
    color: sourceColor,
    rows: rows.map((r) => {
      const v = valueOf(r);
      const pct = v == null ? null : (v / grand) * 100;
      const pctStr = pct == null ? '' : pct >= 0.1 ? pct.toFixed(1) + '%' : '<0.1%';
      return {
        name: r.name,
        muted: v == null,
        primaryLabel: `${fmtVal(v)}${pctStr ? '  ' + pctStr : ''}`,
        segments: [{ key: r.name, value: v || 0 }],
        detail: `${fmtInt(r.turns)} turns · ${fmtInt(r.conversations)} conversations · ${
          r.tokenAvailable ? fmtCompact(r.measuredTokens.total) + ' tokens' : 'no token data'
        }`,
        tip: [
          { k: 'Turns', v: fmtInt(r.turns), color: sourceColor(r.name) },
          { k: 'Conversations', v: fmtInt(r.conversations) },
          { k: 'Measured tokens', v: r.tokenAvailable ? fmtInt(r.measuredTokens.total) : DASH },
          { k: 'API value*', v: r.tokenAvailable && r.unpricedTurns < r.turns ? state.money(r.apiValue) : DASH },
          ...(pctStr ? [{ k: `Share (${metric})`, v: pctStr }] : []),
        ],
      };
    }),
  });

  $('#sources-note').textContent =
    metric === 'tokens' ? 'Records without token usage are excluded.' : `${metric} are a real count for every source`;
}

// ---- 4. Usage by project ------------------------------------------------

/** Stable colour per measured model id. */
function modelColor(model) {
  const models = (state.meta.facets.models || []).filter((m) => m && m !== 'unknown').slice().sort();
  const i = models.indexOf(model);
  return i < 0 ? 'var(--text-muted)' : `var(--series-${(i % 8) + 1})`;
}

function renderProjectChart(s) {
  const rows = foldRows((s.byProject || []).filter((r) => r.tokenAvailable), 5);
  const projects = (state.meta.facets.projects || []).slice().sort();
  donut($('#chart-projects'), {
    slices: rows.map((r) => ({ name: r.name, value: r.measuredTokens.total, selectable: !(rows.length === 5 && (s.byProject || []).filter((p) => p.tokenAvailable).length > 5 && r === rows[rows.length - 1]) })),
    selected: state.project,
    onPick: (name) => {
      state.project = state.project === name ? '' : name;
      $('#project').value = state.project;
      refresh();
    },
    color: (name) => name === 'Other' ? 'var(--text-muted)' : `var(--series-${(Math.max(0, projects.indexOf(name)) % 8) + 1})`,
    valueFormat: fmtCompact,
    centerLabel: { top: fmtCompact(rows.reduce((n, r) => n + r.measuredTokens.total, 0)), bottom: 'tokens' },
  });
  const tokens = s.totals.measuredTokens;
  donut($('#chart-token-composition'), {
    slices: [
      { name: 'Input', value: tokens.input },
      { name: 'Output', value: tokens.output },
      { name: 'Cache read', value: tokens.cacheRead },
      { name: 'Cache write', value: tokens.cacheWrite },
    ],
    color: (name) => `var(--series-${['Input', 'Output', 'Cache read', 'Cache write'].indexOf(name) + 1})`,
    valueFormat: fmtCompact,
    centerLabel: { top: fmtCompact(tokens.total), bottom: 'tokens' },
  });
}

/** Keep the top `max` rows by measured tokens; sum the rest into "Other". */
function foldRows(rows, max) {
  const sorted = rows.slice().sort((a, b) => b.measuredTokens.total - a.measuredTokens.total);
  if (sorted.length <= max) return sorted;
  const other = sorted.slice(max - 1).reduce(
    (acc, r) => {
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
        acc.measuredTokens[k] += r.measuredTokens[k];
      }
      acc.turns += r.turns;
      acc.conversations += r.conversations;
      acc.apiValue += r.apiValue;
      acc.unpricedTurns += r.unpricedTurns;
      return acc;
    },
    {
      name: 'Other',
      measuredTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      turns: 0,
      conversations: 0,
      apiValue: 0,
      unpricedTurns: 0,
      tokenAvailable: true,
      identified: true,
    }
  );
  return [...sorted.slice(0, max - 1), other];
}

// ---- 5. Breakdown table ---------------------------------------------------

function renderTable(s) {
  const tokensMode = state.usageMetric === 'tokens';
  const tok = (n) => (n ? fmtInt(n) : DASH);
  // API value* is measured + priced only; never A$0 for "no data".
  const apiVal = (o) => {
    if (!o.measuredTokens.total) return DASH;
    return o.apiValue > 0 ? state.money(o.apiValue) : 'Unpriced';
  };

  const cols = tokensMode
    ? [
        { h: 'Period', get: (b) => b.label },
        { h: 'Turns', n: true, get: (b) => fmtInt(b.turns) },
        { h: 'Input', n: true, get: (b) => tok(b.measuredTokens.input) },
        { h: 'Output', n: true, get: (b) => tok(b.measuredTokens.output) },
        { h: 'Cache', n: true, get: (b) => tok(b.measuredTokens.cacheRead + b.measuredTokens.cacheWrite) },
        { h: 'Measured tokens', n: true, get: (b) => tok(b.measuredTokens.total) },
        { h: 'API value*', n: true, get: apiVal },
      ]
    : [
        { h: 'Period', get: (b) => b.label },
        { h: 'Turns', n: true, get: (b) => fmtInt(b.turns) },
        { h: 'Conversations', n: true, get: (b) => fmtInt(b.conversations) },
        { h: 'Measured tokens', n: true, get: (b) => tok(b.measuredTokens.total) },
        { h: 'API value*', n: true, get: apiVal },
        { h: 'Active sources', get: (b) => Object.keys(b.bySource).sort().join(', ') },
      ];

  const thead = $('#breakdown thead');
  thead.innerHTML = '';
  const htr = document.createElement('tr');
  cols.forEach((c) => {
    const th = document.createElement('th');
    th.textContent = c.h;
    if (c.n) th.className = 'num';
    if (c.h === 'Active sources') th.classList.add('active-sources-col');
    htr.appendChild(th);
  });
  thead.appendChild(htr);

  const body = $('#breakdown tbody');
  body.innerHTML = '';
  s.buckets
    .slice()
    .reverse()
    .forEach((b) => body.appendChild(tr(cols.map((c) => (c.n ? num(c.get(b)) : c.get(b))))));

  const t = s.totals;
  let tfoot = $('#breakdown tfoot');
  if (!tfoot) {
    tfoot = document.createElement('tfoot');
    $('#breakdown').appendChild(tfoot);
  }
  tfoot.innerHTML = '';
  tfoot.appendChild(
    tr(
      cols.map((c, i) => {
        if (i === 0) return `Total (${s.buckets.length})`;
        if (c.h === 'Turns') return num(fmtInt(t.turns));
        if (c.h === 'Conversations') return num(fmtInt(t.conversations));
        if (c.h === 'Input') return num(tok(t.measuredTokens.input));
        if (c.h === 'Output') return num(tok(t.measuredTokens.output));
        if (c.h === 'Cache') return num(tok(t.measuredTokens.cacheRead + t.measuredTokens.cacheWrite));
        if (c.h === 'Measured tokens') return num(tok(t.measuredTokens.total));
        if (c.h === 'API value*') return num(apiVal(t));
        return '';
      })
    )
  );

  const bits = [];
  if (t.tokenUnavailableTurns)
    bits.push(`${fmtInt(t.tokenUnavailableTurns)} turn(s) have no token usage data`);
  if (t.unpricedTurns) bits.push(`${fmtInt(t.unpricedTurns)} measured turn(s) use an unpriced model`);
  $('#table-note').textContent = bits.join(' · ');
}

// ---- misc helpers ---------------------------------------------------------

/**
 * Data freshness. The store is a snapshot, so say plainly how old it is and warn
 * once it is stale enough that new usage is probably missing.
 */
function renderMeta() {
  // Mock mode: flag it everywhere, and hide collection since there is nothing to collect.
  const mock = Boolean(state.meta.mock);
  $('#mock-badge').hidden = !mock;
  $('#refresh').hidden = mock;
  $('#generated-at').hidden = mock; // regenerated daily; freshness is meaningless here
  document.title = (mock ? '[Mock] ' : '') + document.title.replace(/^\[Mock\] /, '');
  const el = $('#generated-at');
  const at = state.meta.generatedAt ? new Date(state.meta.generatedAt) : null;
  if (!at || isNaN(at)) {
    el.textContent = 'never collected';
    el.className = 'freshness stale';
  } else {
    const mins = Math.max(0, Math.round((Date.now() - at.getTime()) / 60000));
    const auto = state.meta.autoIngestMinutes || 0;
    // stale = well past the auto-refresh interval, or 30 min when auto is off
    const staleAfter = auto > 0 ? Math.max(auto * 3, 15) : 30;
    el.textContent = 'updated ' + relTime(mins);
    el.title = at.toLocaleString() + (auto ? ` · auto-refresh every ${auto} min` : ' · auto-refresh off');
    el.className = 'freshness' + (mins > staleAfter ? ' stale' : '');
  }
  $('#store-path').textContent = 'store: ' + state.meta.storePath;
}

function relTime(mins) {
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 min ago';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`;
  const d = Math.round(h / 24);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

/** Ask the server to collect new usage now, then re-render. */
async function triggerIngest() {
  const btn = $('#refresh');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('spinning');
  try {
    await fetch('/api/ingest', { method: 'POST' });
    state.meta = await getJSON('/api/meta');
    renderMeta();
    renderPricingTable(state.meta.pricing);
    await refresh();
  } catch {
    /* leave the previous view in place */
  } finally {
    btn.disabled = false;
    btn.classList.remove('spinning');
  }
}

function assignSourceColors(sources) {
  sources.slice().sort().forEach((s, i) => {
    state.sourceColors[s] = `var(--series-${(i % 8) + 1})`;
  });
}

function legend(mount, names, color, modeBySource = {}) {
  mount.innerHTML = '';
  names.forEach((n) => {
    const label = modeBySource[n] === 'subscription' ? `${n} (sub)` : n;
    const item = h('span', { class: 'item' }, [swatch(color(n)), document.createTextNode(label)]);
    mount.appendChild(item);
  });
}

function swatch(c) {
  return h('span', { class: 'swatch', style: `background:${c}` });
}

/** The effective range as local YYYY-MM-DD strings (null = open-ended). */
function currentRangeDates() {
  const now = new Date();
  const ymd = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const storeR = (state.meta && state.meta.facets && state.meta.facets.range) || {};

  if (state.range === 'custom') {
    return { from: state.customFrom || null, to: state.customTo || null };
  }
  if (state.range === 'all') {
    return {
      from: storeR.from ? storeR.from.slice(0, 10) : null,
      to: storeR.to ? storeR.to.slice(0, 10) : null,
    };
  }
  if (state.range === 'mtd') {
    return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(now) };
  }
  const days = parseInt(state.range, 10) || 30;
  return { from: ymd(new Date(now.getTime() - (days - 1) * 86400000)), to: ymd(now) };
}

function tr(cells) {
  const row = document.createElement('tr');
  cells.forEach((c) => {
    const td = document.createElement('td');
    if (c && c.__num) {
      td.className = 'num';
      td.textContent = c.text;
    } else {
      td.textContent = c;
    }
    row.appendChild(td);
  });
  return row;
}
function num(text) {
  return { __num: true, text };
}

function setupTheme() {
  const saved = localStorageGet('obs-theme');
  if (saved) document.documentElement.dataset.theme = saved;
  $('#theme-toggle').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme;
    const isDark = cur === 'dark' || (!cur && matchMedia('(prefers-color-scheme: dark)').matches);
    const next = isDark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorageSet('obs-theme', next);
    // re-render so SVG picks up new CSS var values
    refresh();
  });
}

function localStorageGet(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localStorageSet(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

function errorBox(msg) {
  return h('p', { class: 'empty' }, msg);
}

// ---- insights model picker ---------------------------------------------------

function wireModelPicker(keyInput) {
  const select = $('#insights-model');
  const custom = $('#insights-model-custom');
  renderModelOptions(FALLBACK_MODELS, localStorageGet(MODEL_STORAGE) || DEFAULT_MODEL);
  select.addEventListener('change', () => {
    $('#insights-model-custom-wrap').hidden = select.value !== CUSTOM_MODEL;
    if (select.value === CUSTOM_MODEL) custom.focus();
    else localStorageSet(MODEL_STORAGE, select.value);
  });
  custom.addEventListener('change', () => { if (custom.value.trim()) localStorageSet(MODEL_STORAGE, custom.value.trim()); });
  // Fetch on commit, not per keystroke, so a half-typed key isn't sent.
  keyInput.addEventListener('change', refreshModelList);
  if (keyInput.value.trim()) refreshModelList();
}

async function refreshModelList() {
  const key = $('#insights-key').value.trim();
  const status = $('#insights-model-status');
  if (!key) { renderModelOptions(FALLBACK_MODELS, selectedModel()); status.textContent = ''; return; }
  status.textContent = 'Loading models for this key...';
  try {
    const models = await listModels(key);
    if (!models.length) throw new Error('No Claude models available for this key.');
    renderModelOptions(models, selectedModel());
    status.textContent = '';
  } catch (err) {
    renderModelOptions(FALLBACK_MODELS, selectedModel());
    status.textContent = `Showing the default list. ${err.name === 'TimeoutError' || err instanceof TypeError ? 'Could not reach Anthropic.' : err.message}`;
  }
}

/** Fill the dropdown; a saved id that isn't listed is kept as the custom value. */
function renderModelOptions(models, current) {
  const select = $('#insights-model');
  select.replaceChildren(
    ...models.map((m) => h('option', { value: m.id }, m.name === m.id ? m.id : `${m.name} (${m.id})`)),
    h('option', { value: CUSTOM_MODEL }, 'Custom...'),
  );
  const listed = models.some((m) => m.id === current);
  select.value = listed ? current : CUSTOM_MODEL;
  if (!listed) $('#insights-model-custom').value = current || '';
  $('#insights-model-custom-wrap').hidden = listed;
}

function selectedModel() {
  const select = $('#insights-model');
  return select.value === CUSTOM_MODEL ? $('#insights-model-custom').value.trim() : select.value;
}

async function generateUsageInsights() {
  const status = $('#insights-status');
  const button = $('#insights-generate');
  const key = $('#insights-key').value.trim();
  if (!key) { status.textContent = 'Add your Claude API key in Settings.'; $('#settings-dialog').showModal(); $('#insights-key').focus(); return; }
  const s = state.lastSummary;
  if (!s || !s.totals.turns) { status.textContent = 'No usage data for the current filters.'; return; }
  const row = (r) => ({ name: r.name, turns: r.turns, conversations: r.conversations, measuredTokens: r.measuredTokens, apiValueUSD: r.apiValue, unpricedTurns: r.unpricedTurns });
  const summary = { filters: s.filters, totals: s.totals, byModel: s.byModel.slice(0, 30).map(row), byProject: s.byProject.slice(0, 30).map(row), bySource: s.bySource.map(row) };
  button.disabled = true;
  status.textContent = 'Analyzing your usage...';
  $('#insights-result').textContent = '';
  try {
    const text = await generateInsights({ apiKey: key, model: selectedModel(), summary });
    renderUsageInsights(parseInsights(text));
    status.textContent = `Updated ${new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })} - Current filter snapshot`;
  } catch (err) {
    status.textContent = err.name === 'TimeoutError' ? 'Claude request timed out. Please try again.'
      : err instanceof TypeError ? 'Cannot connect to Claude. Check your browser network or proxy connection, then try again.'
      : err.message;
  }
  finally { button.disabled = false; }
}

function renderUsageInsights(report) {
  const mount = $('#insights-result');
  mount.replaceChildren();
  mount.appendChild(h('p', { class: 'insight-overview' }, report.summary));
  const grid = h('div', { class: 'insight-grid' });
  for (const [label, items] of [['Key findings', report.findings], ['Next steps', report.actions]]) {
    const section = h('section', { class: 'insight-section' });
    section.appendChild(h('h3', {}, label));
    items.forEach((item, index) => section.appendChild(h('article', { class: 'insight-item' }, [
      h('span', { class: 'insight-number', 'aria-hidden': 'true' }, String(index + 1).padStart(2, '0')),
      h('div', {}, [h('h4', {}, item.title), h('p', {}, item.detail)])
    ])));
    grid.appendChild(section);
  }
  mount.appendChild(grid);
  mount.appendChild(h('p', { class: 'insight-caveat' }, report.limitation));
}

let pathChoices = [];
let pathSavePending = false;
function renderPathChoices() {
  const list = $('#paths-list');
  list.replaceChildren();
  for (const choice of pathChoices) {
    const row = h('div', { class: 'path-choice' });
    const label = h('label', {});
    const check = h('input', { type: 'checkbox' });
    check.checked = choice.selected;
    check.disabled = pathSavePending;
    check.addEventListener('change', () => { choice.selected = check.checked; });
    label.append(check, document.createTextNode(choice.path));
    const remove = h('button', { type: 'button', 'aria-label': `Remove ${choice.path}` }, 'Remove');
    remove.disabled = pathSavePending;
    remove.addEventListener('click', () => { pathChoices = pathChoices.filter((c) => c !== choice); renderPathChoices(); });
    row.append(label, remove);
    list.append(row);
  }
}
async function loadPathSettings() {
  if (pathSavePending) return;
  $('#paths-save').disabled = true;
  $('#paths-add').disabled = true;
  $('#paths-status').textContent = 'Loading directories…';
  try {
    const settings = await getJSON('/api/settings/paths');
    pathChoices = [...new Set([...settings.availableRoots, ...settings.projectRoots])].map((path) => ({ path, selected: settings.projectRoots.includes(path) }));
    renderPathChoices();
    $('#paths-save').disabled = false;
    $('#paths-add').disabled = false;
    $('#paths-status').textContent = '';
  } catch (error) { $('#paths-status').textContent = `Could not load directories: ${error.message}. Restart the server with the latest code, then reopen Settings.`; }
}
function addPathFromInput() {
  if (pathSavePending || $('#paths-add').disabled) return;
  const path = $('#paths-input').value.trim();
  if (!path) { $('#paths-status').textContent = 'Enter a directory path first, then click Add directory.'; $('#paths-input').focus(); return; }
  const existing = pathChoices.find((c) => c.path === path);
  if (existing) existing.selected = true;
  else pathChoices.push({ path, selected: true });
  $('#paths-input').value = '';
  renderPathChoices();
}
async function savePathSettings() {
  if (pathSavePending) return;
  addPathFromInput();
  const projectRoots = pathChoices.filter((c) => c.selected).map((c) => c.path);
  if (!projectRoots.length) { $('#paths-status').textContent = 'Select at least one directory.'; return; }
  pathSavePending = true;
  $('#paths-save').disabled = true;
  $('#paths-add').disabled = true;
  $('#paths-input').disabled = true;
  renderPathChoices();
  $('#paths-status').textContent = 'Saving and collecting usage…';
  try {
    const response = await fetch('/api/settings/paths', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectRoots, availableRoots: pathChoices.map((c) => c.path) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not save paths.');
    pathChoices = result.availableRoots.map((path) => ({ path, selected: result.projectRoots.includes(path) }));
    $('#paths-status').textContent = result.warning ? `Saved. ${result.warning}` : 'Directories saved. Usage updated.';
    try {
      state.meta = await getJSON('/api/meta');
      buildModelOptions(state.meta.facets.models);
      $('#model').value = state.model;
      rebuildProjectOptions();
      await refresh();
    } catch { $('#paths-status').textContent += ' Reload the page to update the dashboard.'; }
  } catch (error) { $('#paths-status').textContent = error.message; }
  finally {
    pathSavePending = false;
    $('#paths-save').disabled = false;
    $('#paths-add').disabled = false;
    $('#paths-input').disabled = false;
    renderPathChoices();
  }
}
