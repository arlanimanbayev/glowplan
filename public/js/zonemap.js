/**
 * Face map: a line-drawn face with zones tinted by YouCam's regional scores.
 * HD scans return pores per region (forehead, nose, cheek) and wrinkles per
 * region (forehead, between the brows, crow's feet, under the eyes, smile
 * lines, mouth corners). The tint is a binned sequential ramp: the darker the
 * zone, the lower the score. Numbers sit on the zones, and the caption lists
 * every value, so the colour never carries meaning alone.
 */
import { attachTooltip, bandOf } from './charts.js';

const NS = 'http://www.w3.org/2000/svg';
function el(name, attrs = {}, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (parent) parent.appendChild(node);
  return node;
}

export const BANDS = [
  { min: 85, label: '85+', name: 'Excellent', cls: 1 },
  { min: 70, label: '70–84', name: 'Good', cls: 2 },
  { min: 55, label: '55–69', name: 'Fair', cls: 3 },
  { min: 40, label: '40–54', name: 'Needs care', cls: 4 },
  { min: 0, label: 'Under 40', name: 'Needs attention', cls: 5 },
];
const zoneFill = (score) => `var(--zone-${BANDS.find((b) => score >= b.min).cls})`;

// Geometry shared with scripts/build-samples.mjs (600 x 800 space).
const FACE = 'M300 165 C392 165 452 232 452 340 C452 452 392 560 300 568 C208 560 148 452 148 340 C148 232 208 165 300 165 Z';
const FEATURES = [
  'M206 312 C226 302 254 302 274 309', 'M326 309 C346 302 374 302 394 312',
  'M212 348 C226 334 256 334 270 348 C256 358 226 358 212 348 Z', 'M330 348 C344 334 374 334 388 348 C374 358 344 358 330 348 Z',
  'M300 352 C298 380 292 404 286 420 C292 430 308 430 314 420',
  'M262 480 C282 488 318 488 338 480',
];

// Zones: [concernKey, region, shape, labelPosition?]
const MODES = {
  pores: {
    label: 'Pores',
    concern: 'pore',
    zones: [
      { region: 'forehead', shape: ['ellipse', 300, 252, 90, 30] },
      { region: 'nose', shape: ['ellipse', 300, 396, 27, 46] },
      { region: 'cheek', shape: ['ellipse', 210, 434, 46, 36] },
      { region: 'cheek', shape: ['ellipse', 390, 434, 46, 36], mirror: true },
    ],
  },
  lines: {
    label: 'Lines',
    concern: 'wrinkle',
    zones: [
      { region: 'forehead', shape: ['ellipse', 300, 252, 90, 28] },
      { region: 'glabellar', shape: ['ellipse', 300, 320, 16, 15], at: [300, 297] },
      { region: 'crowfeet', shape: ['ellipse', 178, 350, 17, 26], label: false },
      { region: 'crowfeet', shape: ['ellipse', 422, 350, 17, 26], at: [474, 357] },
      { region: 'periocular', shape: ['ellipse', 241, 378, 34, 11], label: false },
      { region: 'periocular', shape: ['ellipse', 359, 378, 34, 11], at: [359, 409] },
      { region: 'nasolabial', shape: ['ellipse', 266, 462, 11, 34, -16], label: false },
      { region: 'nasolabial', shape: ['ellipse', 334, 462, 11, 34, 16], at: [374, 462] },
      { region: 'marionette', shape: ['ellipse', 262, 522, 10, 17], label: false },
      { region: 'marionette', shape: ['ellipse', 338, 522, 10, 17], at: [372, 534] },
    ],
  },
  eyes: {
    label: 'Eye area',
    zones: [
      { concern: 'droopy_upper_eyelid', shape: ['ellipse', 241, 333, 32, 8], label: false },
      { concern: 'droopy_upper_eyelid', shape: ['ellipse', 359, 333, 32, 8], at: [432, 322] },
      { concern: 'dark_circle', shape: ['ellipse', 241, 375, 34, 11], label: false },
      { concern: 'dark_circle', shape: ['ellipse', 359, 375, 34, 11], at: [432, 380] },
      { concern: 'tear_trough', shape: ['ellipse', 244, 398, 30, 8], label: false },
      { concern: 'tear_trough', shape: ['ellipse', 356, 398, 30, 8], at: [432, 410] },
    ],
  },
};

export const MODE_KEYS = Object.keys(MODES);
export const modeLabel = (m) => MODES[m].label;

function shapeEl(parent, [kind, cx, cy, rx, ry, rot], attrs) {
  return el(kind, { cx, cy, rx, ry, ...(rot ? { transform: `rotate(${rot} ${cx} ${cy})` } : {}), ...attrs }, parent);
}

/**
 * Draw the map for a mode. Returns caption entries [{label, score}] sorted lowest first.
 */
export function renderZoneMap(container, scan, mode, tip) {
  container.replaceChildren();
  const byKey = new Map(scan.concerns.map((c) => [c.key, c]));
  const def = MODES[mode];
  const svg = el('svg', { viewBox: '120 156 380 428', role: 'group', 'aria-label': `Face map: ${def.label.toLowerCase()} scores by area` }, container);
  el('path', { d: FACE, class: 'face-outline' }, svg);
  for (const d of FEATURES) el('path', { d, class: 'feature' }, svg);

  const caption = new Map();
  let regional = false;
  for (const z of def.zones) {
    const concern = byKey.get(z.concern || def.concern);
    if (!concern) continue;
    let score = concern.score;
    let name = concern.label;
    if (z.region) {
      const r = concern.regions?.find((x) => x.region === z.region);
      if (r) {
        score = r.score;
        name = r.label;
        regional = true;
      }
    }
    const zoneLabel = z.region && regional ? name : concern.label;
    const shape = shapeEl(svg, z.shape, { class: 'zone', fill: zoneFill(score), tabindex: z.label === false || z.mirror ? -1 : 0, role: 'img', 'aria-label': `${zoneLabel}: ${score} out of 100` });
    shape.style.fill = zoneFill(score);
    attachTooltip(shape, tip, () => [`${score}/100`, zoneLabel, bandOf(score)]);
    caption.set(zoneLabel, score);
    if (z.label !== false) {
      const [lx, ly] = z.at || [z.shape[1], z.shape[2] + 7];
      const t = el('text', { x: lx, y: ly, 'text-anchor': 'middle', 'aria-hidden': 'true' }, svg);
      t.textContent = String(score);
    }
  }
  return {
    regional,
    entries: [...caption.entries()].map(([label, score]) => ({ label, score })).sort((a, b) => a.score - b.score),
  };
}
