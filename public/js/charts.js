/**
 * Charts, drawn as inline SVG with DOM APIs (labels go in via textContent).
 *
 *  - Score bars: every measured concern, lowest first. Emphasis form: focus
 *    concerns in the data hue, the rest in a recessive grey. Values at the tips.
 *  - Progress dumbbell: before -> after per concern on one 0-100 axis, one hue in
 *    two steps (validated with the dataviz palette checker), sorted by change.
 *
 * Both have a per-row hover/focus tooltip and a table twin, so no value is
 * reachable only by hovering.
 */

const NS = 'http://www.w3.org/2000/svg';
function el(name, attrs = {}, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (parent) parent.appendChild(node);
  return node;
}
function text(parent, x, y, str, attrs = {}) {
  const t = el('text', { x, y, ...attrs }, parent);
  t.textContent = str;
  return t;
}

export function bandOf(score) {
  if (score >= 85) return 'Excellent';
  if (score >= 70) return 'Good';
  if (score >= 55) return 'Fair';
  if (score >= 40) return 'Needs care';
  return 'Needs attention';
}

/** Rounded data-end, square at the baseline. */
function barPath(x, y, w, h, r = 4) {
  if (w <= r) return `M${x},${y}h${Math.max(w, 1)}v${h}h${-Math.max(w, 1)}Z`;
  return `M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(w - r)}Z`;
}

// ---------------------------------------------------------------------------
// Tooltip (one shared element; values lead, labels follow)
// ---------------------------------------------------------------------------
export function attachTooltip(target, tip, content) {
  const show = (x, y) => {
    tip.replaceChildren();
    const [value, ...rest] = content();
    const s = document.createElement('strong');
    s.textContent = value;
    tip.appendChild(s);
    for (const line of rest) {
      const d = document.createElement('div');
      d.textContent = line;
      tip.appendChild(d);
    }
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(window.innerWidth - r.width - 8, Math.max(8, x + 14))}px`;
    tip.style.top = `${Math.max(8, y - r.height - 10)}px`;
  };
  const hide = () => {
    tip.hidden = true;
  };
  target.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
  target.addEventListener('pointerleave', hide);
  target.addEventListener('focus', () => {
    const b = target.getBoundingClientRect();
    show(b.left + b.width / 2, b.top);
  });
  target.addEventListener('blur', hide);
}

// ---------------------------------------------------------------------------
// Score bars
// ---------------------------------------------------------------------------
export function renderScoreBars(container, concerns, focusKeys, tip) {
  container.replaceChildren();
  const width = Math.max(280, container.clientWidth || 600);
  const rows = [...concerns].sort((a, b) => a.score - b.score);
  const labelW = Math.min(170, Math.round(width * 0.36));
  const valueW = 34;
  const top = 22;
  const rowH = 30;
  const plotX = labelW;
  const plotW = width - labelW - valueW;
  const height = top + rows.length * rowH + 4;
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, role: 'list', 'aria-label': 'All measured scores, lowest first' }, container);
  const x = (v) => plotX + (v / 100) * plotW;

  for (const t of [0, 25, 50, 75, 100]) {
    el('line', { x1: x(t), x2: x(t), y1: top - 4, y2: height - 4, class: t === 0 ? 'baseline' : 'grid' }, svg);
    text(svg, x(t), 12, String(t), { class: 'tick', 'text-anchor': t === 0 ? 'start' : t === 100 ? 'end' : 'middle' });
  }

  rows.forEach((c, i) => {
    const y = top + i * rowH;
    const focus = focusKeys.includes(c.key);
    const g = el('g', { class: 'row', tabindex: 0, role: 'listitem', 'aria-label': `${c.label}: ${c.score} out of 100, ${bandOf(c.score)}${focus ? ', focus area' : ''}` }, svg);
    el('rect', { x: 0, y, width, height: rowH, class: 'hit', rx: 6 }, g);
    text(g, 0, y + rowH / 2 + 4.5, c.label, { class: `row-label${focus ? '' : ' muted'}`, 'font-weight': focus ? 600 : 400 });
    const bw = x(c.score) - plotX;
    el('path', { d: barPath(plotX, y + 10, bw, 10), class: focus ? 'bar-focus' : 'bar-other' }, g);
    text(g, x(c.score) + 6, y + rowH / 2 + 4.5, String(c.score), { class: 'value' });
    attachTooltip(g, tip, () => [
      `${c.score}/100`,
      `${c.label}, ${bandOf(c.score).toLowerCase()}`,
      ...(c.regions?.length ? [c.regions.slice().sort((a, b) => a.score - b.score).map((r) => `${r.label} ${r.score}`).join(', ')] : []),
      ...(focus ? ['Focus area'] : []),
    ]);
  });
}

export function renderScoreTable(container, concerns, focusKeys) {
  container.replaceChildren();
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  for (const h of ['Concern', 'Score', 'Band', 'By region']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  }
  const body = table.createTBody();
  for (const c of [...concerns].sort((a, b) => a.score - b.score)) {
    const r = body.insertRow();
    r.insertCell().textContent = `${c.label}${focusKeys.includes(c.key) ? ' (focus)' : ''}`;
    const s = r.insertCell();
    s.textContent = String(c.score);
    s.className = 'num';
    r.insertCell().textContent = bandOf(c.score);
    r.insertCell().textContent = c.regions?.length ? c.regions.map((x) => `${x.label} ${x.score}`).join(', ') : '';
  }
  container.appendChild(table);
}

// ---------------------------------------------------------------------------
// Progress dumbbell
// ---------------------------------------------------------------------------
const sign = (d) => (d > 0 ? `+${d}` : d < 0 ? `−${Math.abs(d)}` : '0');
const arrow = (dir) => (dir === 'up' ? '▲ ' : dir === 'down' ? '▼ ' : '');

export function renderDumbbell(container, progress, tip, { beforeLabel = 'Before', afterLabel = 'Now' } = {}) {
  container.replaceChildren();
  const width = Math.max(280, container.clientWidth || 600);
  const stacked = width < 520;
  const items = progress.items;
  const labelW = stacked ? 0 : Math.min(170, Math.round(width * 0.32));
  const deltaW = 54;
  const top = 22;
  const rowH = stacked ? 46 : 32;
  const plotX = labelW + 6;
  const plotW = width - plotX - deltaW - 6;
  const height = top + items.length * rowH + 4;
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, role: 'list', 'aria-label': `Change per concern between ${beforeLabel} and ${afterLabel}` }, container);
  const x = (v) => plotX + (v / 100) * plotW;
  for (const t of [0, 25, 50, 75, 100]) {
    el('line', { x1: x(t), x2: x(t), y1: top - 4, y2: height - 4, class: t === 0 ? 'baseline' : 'grid' }, svg);
    text(svg, x(t), 12, String(t), { class: 'tick', 'text-anchor': t === 0 ? 'start' : t === 100 ? 'end' : 'middle' });
  }
  items.forEach((it, i) => {
    const y0 = top + i * rowH;
    const cy = stacked ? y0 + 31 : y0 + rowH / 2;
    const g = el('g', { class: 'row', tabindex: 0, role: 'listitem', 'aria-label': `${it.label}: ${it.before} to ${it.after}, change ${sign(it.delta)}` }, svg);
    el('rect', { x: 0, y: y0, width, height: rowH, class: 'hit', rx: 6 }, g);
    text(g, stacked ? plotX : 0, stacked ? y0 + 15 : cy + 4.5, it.label, { class: 'row-label' });
    el('line', { x1: x(Math.min(it.before, it.after)), x2: x(Math.max(it.before, it.after)), y1: cy, y2: cy, class: 'db-link' }, g);
    el('circle', { cx: x(it.before), cy, r: 5, class: 'db-before' }, g);
    el('circle', { cx: x(it.after), cy, r: 6, class: 'db-after' }, g);
    text(g, width, cy + 4.5, `${arrow(it.direction)}${sign(it.delta)}`, { class: `delta ${it.direction}`, 'text-anchor': 'end' });
    attachTooltip(g, tip, () => [`${it.before} → ${it.after} (${sign(it.delta)})`, it.label, it.direction === 'steady' ? 'Within normal photo-to-photo variation' : it.direction === 'up' ? 'Improved' : 'Lower than before']);
  });
}

export function renderProgressTable(container, progress, { beforeLabel = 'Before', afterLabel = 'Now' } = {}) {
  container.replaceChildren();
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  for (const h of ['Concern', beforeLabel, afterLabel, 'Change']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  }
  const body = table.createTBody();
  for (const it of progress.items) {
    const r = body.insertRow();
    r.insertCell().textContent = it.label;
    for (const v of [it.before, it.after]) {
      const c = r.insertCell();
      c.textContent = String(v);
      c.className = 'num';
    }
    const d = r.insertCell();
    d.textContent = `${sign(it.delta)}${it.direction === 'steady' ? ' (steady)' : ''}`;
    d.className = 'num';
  }
  container.appendChild(table);
}
