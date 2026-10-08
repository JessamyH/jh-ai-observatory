// Hand-rolled SVG charts. No dependencies, theme-aware (colors come from CSS
// custom properties via currentColor / var()), responsive via viewBox.

const NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'g', 'rect', 'line', 'text', 'path', 'circle', 'polyline', 'polygon', 'tspan']);

export function h(tag, attrs = {}, children = []) {
  const node = SVG_TAGS.has(tag)
    ? document.createElementNS(NS, tag)
    : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    node.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

// ---- formatting ---------------------------------------------------------------

export function fmtUSD(n) {
  if (n == null) return '—';
  if (n === 0) return '$0';
  if (n < 0.01) return '$' + n.toFixed(4);
  if (n < 1) return '$' + n.toFixed(3);
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtCompact(n) {
  if (n == null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

export function fmtInt(n) {
  return (n || 0).toLocaleString('en-US');
}

// ---- tooltip ----------------------------------------------------------------

const tip = () => document.getElementById('tooltip');

function showTip(html, evt) {
  const t = tip();
  t.innerHTML = html;
  t.hidden = false;
  moveTip(evt);
}
function moveTip(evt) {
  const t = tip();
  const pad = 14;
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  const r = t.getBoundingClientRect();
  if (x + r.width > window.innerWidth) x = evt.clientX - r.width - pad;
  if (y + r.height > window.innerHeight) y = evt.clientY - r.height - pad;
  t.style.left = x + 'px';
  t.style.top = y + 'px';
}
function hideTip() {
  tip().hidden = true;
}

/** Wire hover tooltip on a node, given a title and rows [{k,v,color}]. */
function attachTip(node, title, rows) {
  node.addEventListener('mouseenter', (e) =>
    showTip(`<div class="tt-title">${title}</div>${tipRows(rows)}`, e)
  );
  node.addEventListener('mousemove', moveTip);
  node.addEventListener('mouseleave', hideTip);
}

/** Wire a hover tooltip that shows arbitrary HTML. */
export function bindHoverHtml(node, html) {
  node.addEventListener('mouseenter', (e) => showTip(html, e));
  node.addEventListener('mousemove', moveTip);
  node.addEventListener('mouseleave', hideTip);
  node.addEventListener('click', (e) => {
    e.preventDefault();
    showTip(html, e);
  });
}

function tipRows(rows) {
  return rows
    .map(
      (r) =>
        `<div class="tt-row"><span class="k">${
          r.color ? `<span class="swatch" style="background:${r.color}"></span>` : ''
        }${r.k}</span><span>${r.v}</span></div>`
    )
    .join('');
}

// ---- stacked / single vertical bar ----------------------------------------

/**
 * @param {HTMLElement} mount
 * @param {Object} opts
 *   buckets: [{ label, segments: [{ name, value }] }]
 *   seriesOrder: string[]
 *   color: (name) => string
 *   valueFormat: (n) => string
 *   unit: string  (tooltip suffix label, e.g. "cost" / "tokens")
 */
export function stackedBar(mount, opts) {
  const { buckets, seriesOrder, color, valueFormat = fmtCompact, tipExtra, tooltipHtml } = opts;
  mount.innerHTML = '';
  if (!buckets.length) {
    mount.appendChild(h('p', { class: 'empty' }, 'No data in range.'));
    return;
  }

  const W = 840;
  const H = 200;
  const m = { top: 14, right: 14, bottom: 36, left: 58 };
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;

  const totals = buckets.map((b) => b.segments.reduce((s, x) => s + (x.value || 0), 0));
  const max = Math.max(1, ...totals);
  const niceMax = niceCeil(max);
  const y = (v) => m.top + plotH - (v / niceMax) * plotH;

  const n = buckets.length;
  const band = plotW / n;
  const barW = Math.min(band * 0.62, 44);

  const svg = h('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'bar chart' });

  // gridlines + y labels
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const val = (niceMax / ticks) * i;
    const yy = y(val);
    svg.appendChild(h('line', { class: 'grid-line', x1: m.left, x2: m.left + plotW, y1: yy, y2: yy }));
    svg.appendChild(
      h('text', { class: 'axis-label', x: m.left - 8, y: yy + 3, 'text-anchor': 'end' }, valueFormat(val))
    );
  }
  // baseline
  svg.appendChild(
    h('line', { class: 'axis-line', x1: m.left, x2: m.left + plotW, y1: y(0), y2: y(0) })
  );

  const labelEvery = n <= 14 ? 1 : Math.ceil(n / 12);

  buckets.forEach((b, i) => {
    const cx = m.left + band * i + band / 2;
    let acc = 0;
    const ordered = seriesOrder
      .map((name) => b.segments.find((s) => s.name === name))
      .filter(Boolean);

    ordered.forEach((seg) => {
      if (!seg.value) return;
      const yTop = y(acc + seg.value);
      const yBot = y(acc);
      const height = Math.max(1, yBot - yTop - 2); // 2px surface gap between segments
      svg.appendChild(
        h('rect', {
          class: 'chart-bar',
          x: cx - barW / 2,
          y: yTop,
          width: barW,
          height,
          rx: 2,
          fill: color(seg.name),
        })
      );
      acc += seg.value;
    });

    // x label
    if (i % labelEvery === 0) {
      svg.appendChild(
        h('text', { class: 'axis-label', x: cx, y: H - m.bottom + 16, 'text-anchor': 'middle' }, b.label)
      );
    }

    // hover hit area
    const hit = h('rect', {
      x: m.left + band * i,
      y: m.top,
      width: band,
      height: plotH,
      fill: 'transparent',
    });
    const rows = ordered
      .slice()
      .reverse()
      .map((s) => ({ k: s.name, v: valueFormat(s.value), color: color(s.name) }));
    rows.push({ k: 'Total', v: valueFormat(totals[i]) });
    if (tipExtra) rows.push(...tipExtra(i));
    const body = tooltipHtml ? tooltipHtml(i) : tipRows(rows);
    hit.addEventListener('mouseenter', (e) => showTip(`<div class="tt-title">${b.label}</div>${body}`, e));
    hit.addEventListener('mousemove', moveTip);
    hit.addEventListener('mouseleave', hideTip);
    svg.appendChild(hit);
  });

  mount.appendChild(svg);
}

// ---- horizontal bar -------------------------------------------------------

/**
 * @param {HTMLElement} mount
 * @param {Object} opts
 *   rows: [{ label, value, sub }]
 *   color: (row, i) => string
 *   valueFormat, tooltip: (row) => [{k,v,color}]
 */
export function hBar(mount, opts) {
  const { rows, color, valueFormat = fmtUSD, tooltip } = opts;
  mount.innerHTML = '';
  if (!rows.length) {
    mount.appendChild(h('p', { class: 'empty' }, 'No data in range.'));
    return;
  }

  const rowH = 34;
  const W = 840;
  const labelW = 150;
  const valueW = 90;
  const H = rows.length * rowH + 8;
  const trackX = labelW + 8;
  const trackW = W - trackX - valueW;
  const max = Math.max(1, ...rows.map((r) => r.value || 0));

  const svg = h('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'horizontal bar chart' });

  rows.forEach((r, i) => {
    const cy = i * rowH + rowH / 2 + 2;
    const w = Math.max(2, ((r.value || 0) / max) * trackW);
    const fill = color(r, i);

    svg.appendChild(
      h('text', { class: 'axis-label', x: labelW, y: cy + 4, 'text-anchor': 'end' }, truncate(r.label, 20))
    );
    svg.appendChild(h('rect', { class: 'bar-track', x: trackX, y: cy - 9, width: trackW, height: 18, rx: 4 }));
    svg.appendChild(
      h('rect', { class: 'chart-bar', x: trackX, y: cy - 9, width: w, height: 18, rx: 4, fill })
    );
    svg.appendChild(
      h('text', { class: 'value-label', x: trackX + trackW + 8, y: cy + 4, 'text-anchor': 'start' }, valueFormat(r.value))
    );

    const hit = h('rect', { x: 0, y: i * rowH + 2, width: W, height: rowH, fill: 'transparent' });
    const ttRows = tooltip ? tooltip(r) : [{ k: r.label, v: valueFormat(r.value) }];
    hit.addEventListener('mouseenter', (e) => showTip(`<div class="tt-title">${r.label}</div>${tipRows(ttRows)}`, e));
    hit.addEventListener('mousemove', moveTip);
    hit.addEventListener('mouseleave', hideTip);
    svg.appendChild(hit);
  });

  mount.appendChild(svg);
}

// ---- donut / pie ----------------------------------------------------------

/**
 * @param {HTMLElement} mount
 * @param {Object} opts
 *   slices: [{ name, value, ... }]   (value sizes the arc; extra fields pass through)
 *   color: (name, i) => string
 *   valueFormat: (n) => string
 *   centerLabel: { top, bottom }        optional text for the hole
 *   legendRow: (slice, pct) => string   optional right-side legend text
 *   tip: (slice, pct) => [{k,v,color}]  optional tooltip rows
 */
export function donut(mount, opts) {
  const { slices, color, valueFormat = fmtUSD, centerLabel, legendRow, tip, onPick, selected } = opts;
  mount.innerHTML = '';
  const data = slices.filter((s) => s.value > 0);
  const total = data.reduce((s, x) => s + x.value, 0);
  if (!data.length || total <= 0) {
    mount.appendChild(h('p', { class: 'empty' }, 'No data in range.'));
    return;
  }

  const S = 240;
  const cx = S / 2;
  const cy = S / 2;
  const rOut = 108;
  const rIn = 62;
  const svg = h('svg', { viewBox: `0 0 ${S} ${S}`, role: 'img', 'aria-label': 'donut chart' });

  const wrap = h('div', { class: 'donut-wrap' });

  const pctOf = (v) => {
    const f = v / total;
    return (f * 100).toFixed(f < 0.1 ? 1 : 0) + '%';
  };
  const bindPick = (node, slice) => {
    if (!onPick || slice.selectable === false) return;
    node.setAttribute('tabindex', '0');
    node.setAttribute('role', 'button');
    node.setAttribute('aria-pressed', String(selected === slice.name));
    node.setAttribute('aria-label', `${selected === slice.name ? 'Clear filter for' : 'Filter by'} ${slice.name}`);
    node.style.cursor = 'pointer';
    node.addEventListener('click', () => { hideTip(); onPick(slice.name); });
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); hideTip(); onPick(slice.name); }
    });
  };
  const bindTip = (node, s, i) => {
    bindPick(node, s);
    const rows = tip
      ? tip(s, pctOf(s.value))
      : [
          { k: 'Value', v: valueFormat(s.value), color: color(s.name, i) },
          { k: 'Share', v: pctOf(s.value) },
        ];
    node.addEventListener('mouseenter', (e) =>
      showTip(`<div class="tt-title">${s.name}</div>${tipRows(rows)}`, e)
    );
    node.addEventListener('mousemove', moveTip);
    node.addEventListener('mouseleave', hideTip);
  };

  if (data.length === 1) {
    const ring = h('circle', {
      cx,
      cy,
      r: (rOut + rIn) / 2,
      fill: 'none',
      stroke: color(data[0].name, 0),
      'stroke-width': rOut - rIn,
    });
    bindTip(ring, data[0], 0);
    svg.appendChild(ring);
  } else {
    let a0 = -Math.PI / 2;
    data.forEach((s, i) => {
      const a1 = a0 + (s.value / total) * 2 * Math.PI;
      const seg = h('path', {
        d: arcPath(cx, cy, rOut, rIn, a0, a1),
        fill: color(s.name, i),
        stroke: 'var(--surface-1)',
        'stroke-width': 2,
        'stroke-linejoin': 'round',
        class: 'chart-bar',
      });
      bindTip(seg, s, i);
      svg.appendChild(seg);
      a0 = a1;
    });
  }

  if (centerLabel) {
    svg.appendChild(h('text', { x: cx, y: cy - 2, 'text-anchor': 'middle', class: 'donut-center-top' }, centerLabel.top || ''));
    svg.appendChild(h('text', { x: cx, y: cy + 16, 'text-anchor': 'middle', class: 'donut-center-bottom' }, centerLabel.bottom || ''));
  }
  wrap.appendChild(svg);

  const list = h('div', { class: 'donut-legend' });
  data.forEach((s, i) => {
    const pct = pctOf(s.value);
    const detail = legendRow ? legendRow(s, pct) : `${valueFormat(s.value)} · ${pct}`;
    const legendItem = h('div', { class: 'donut-legend-row' }, [
        h('span', { class: 'swatch', style: `background:${color(s.name, i)}` }),
        h('span', { class: 'dl-name' }, s.name),
        h('span', { class: 'dl-detail' }, detail),
      ]);
    bindPick(legendItem, s);
    list.appendChild(legendItem);
  });
  wrap.appendChild(list);
  mount.appendChild(wrap);
}

function arcPath(cx, cy, rOut, rIn, a0, a1) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const x0o = cx + rOut * Math.cos(a0);
  const y0o = cy + rOut * Math.sin(a0);
  const x1o = cx + rOut * Math.cos(a1);
  const y1o = cy + rOut * Math.sin(a1);
  const x0i = cx + rIn * Math.cos(a1);
  const y0i = cy + rIn * Math.sin(a1);
  const x1i = cx + rIn * Math.cos(a0);
  const y1i = cy + rIn * Math.sin(a0);
  return `M ${x0o} ${y0o} A ${rOut} ${rOut} 0 ${large} 1 ${x1o} ${y1o} L ${x0i} ${y0i} A ${rIn} ${rIn} 0 ${large} 0 ${x1i} ${y1i} Z`;
}

// ---- horizontal ranking bars (HTML) -------------------------------------------

/**
 * @param {HTMLElement} mount
 * @param {Object} opts
 *   rows: [{ name, segments: [{key, value}], primaryLabel, detail, tip: [{k,v,color}] }]
 *         rows are drawn in the given order; bar length = sum of segment values
 *   color: (key) => cssColor
 *   legendKeys: [{ key, label }]   optional swatch legend under the chart
 */
export function rankBar(mount, opts) {
  const { rows, color, legendKeys } = opts;
  mount.innerHTML = '';
  if (!rows.length) {
    mount.appendChild(h('p', { class: 'empty' }, 'No data in range.'));
    return;
  }
  const totalOf = (r) => r.segments.reduce((s, x) => s + (x.value || 0), 0);
  const max = Math.max(1, ...rows.map(totalOf));

  const wrap = h('div', { class: 'rank' });
  rows.forEach((r) => {
    const total = totalOf(r);
    const row = h('div', { class: 'rank-row' + (r.muted ? ' muted' : '') });
    row.appendChild(
      h('div', { class: 'rank-head' }, [
        h('span', { class: 'rank-name' }, r.name),
        h('span', { class: 'rank-primary' }, r.primaryLabel),
      ])
    );
    const track = h('div', { class: 'rank-track' });
    const fill = h('div', {
      class: 'rank-fill',
      style: `width:${total > 0 ? Math.max((total / max) * 100, 0) : 0}%;${total > 0 ? 'min-width:3px;' : ''}`,
    });
    r.segments.forEach((seg) => {
      if (!seg.value) return;
      fill.appendChild(
        h('div', {
          class: 'rank-seg',
          style: `flex:${seg.value} ${seg.value} 0;background:${color(seg.key)}`,
        })
      );
    });
    track.appendChild(fill);
    if (r.tip) attachTip(track, r.name, r.tip);
    row.appendChild(track);
    if (r.detail) row.appendChild(h('div', { class: 'rank-detail' }, r.detail));
    if (r.onClick) {
      row.classList.add('clickable');
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.addEventListener('click', r.onClick);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          r.onClick();
        }
      });
    }
    wrap.appendChild(row);
  });
  mount.appendChild(wrap);

  if (legendKeys && legendKeys.length) {
    const lg = h('div', { class: 'legend' });
    legendKeys.forEach((k) => {
      lg.appendChild(
        h('span', { class: 'item' }, [
          h('span', { class: 'swatch', style: `background:${color(k.key)}` }),
          document.createTextNode(k.label),
        ])
      );
    });
    mount.appendChild(lg);
  }
}

// ---- helpers ------------------------------------------------------------------

function niceCeil(x) {
  if (x <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(x));
  const norm = x / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
