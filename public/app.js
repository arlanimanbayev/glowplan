/**
 * GlowPlan front end. Three views: start (photo + preferences), working
 * (live YouCam and agent steps), results (plan, face map, charts, progress).
 *
 * Storage: scores, preferences and the last plan live in localStorage on this
 * device only. Photos are never stored; they stay in memory for this tab.
 */
import { decodeFile, exportFull, Cropper, PhotoError } from './js/photo.js';
import { analyze, stream, health, ApiError } from './js/api.js';
import { renderScoreBars, renderScoreTable, renderDumbbell, renderProgressTable, bandOf } from './js/charts.js';
import { renderZoneMap, MODE_KEYS, modeLabel, BANDS } from './js/zonemap.js';
import { buildPrintSheet } from './js/print.js';
import { compareScans } from './shared/progress.js';

const $ = (id) => document.getElementById(id);
const STORE = 'glowplan-v1';

const GOALS = [
  ['breakouts', 'Fewer breakouts'],
  ['even_tone', 'More even tone'],
  ['smoother', 'Smoother, firmer skin'],
  ['hydration', 'Comfortable, hydrated skin'],
  ['eyes', 'Fresher eye area'],
  ['glow', 'More glow'],
];
const SKIN_TYPES = [['oily', 'Oily'], ['combination', 'Combination'], ['normal', 'Normal'], ['dry', 'Dry'], ['unsure', 'Not sure']];
const BUDGETS = [['1', 'Essentials'], ['2', 'Balanced'], ['3', 'Flexible']];
const TIMES = [['quick', 'Quick', 'under 3 min'], ['standard', 'Standard', '5–10 min'], ['unhurried', 'Unhurried', '15 min+']];

const state = {
  cropper: null,
  photoName: null,
  sample: null,
  before: null, // decoded "before" photo for compare mode
  checkIn: false,
  photoUrl: null,
  scan: null,
  previous: null,
  plan: null,
  meta: null,
  zoneMode: 'pores',
  overlay: null,
  clinic: null,
  health: null,
};

// ---------------------------------------------------------------------------
// Storage (best effort; the app works without it)
// ---------------------------------------------------------------------------
function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE) || '{}') || {};
  } catch {
    return {};
  }
}
function save(patch) {
  try {
    localStorage.setItem(STORE, JSON.stringify({ ...load(), ...patch }));
  } catch {
    /* storage full or blocked */
  }
}
/** Scores only: no photo, no expiring mask URLs, no task ids. */
const storableScan = (s) => ({
  id: s.id, takenAt: s.takenAt, tier: s.tier, demo: s.demo, source: s.source, sample: s.sample, overall: s.overall, overallSource: s.overallSource, skinAge: s.skinAge,
  concerns: s.concerns.map((c) => ({ key: c.key, label: c.label, noun: c.noun, score: c.score, regions: c.regions })),
  ...(s.tone ? { tone: { skinHex: s.tone.skinHex, quality: s.tone.quality, measuredAt: s.tone.measuredAt, ...(s.tone.reused ? { reused: true } : {}) } } : {}),
  ...(s.toneError ? { toneError: s.toneError } : {}),
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
const shortDate = (iso) => new Date(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function show(view) {
  for (const v of ['start', 'working', 'results']) $(`view-${v}`).hidden = v !== view;
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------
function buildControls(prefs = {}) {
  const goals = $('goals');
  goals.replaceChildren();
  for (const [id, label] of GOALS) {
    const l = node('label', 'chip');
    const i = document.createElement('input');
    i.type = 'checkbox';
    i.name = 'goal';
    i.value = id;
    i.checked = (prefs.goals || ['breakouts', 'even_tone']).includes(id);
    l.append(i, node('span', '', label));
    goals.appendChild(l);
  }
  goals.addEventListener('change', limitGoals);
  limitGoals();

  const seg = (container, name, options, value) => {
    container.replaceChildren();
    container.setAttribute('role', 'radiogroup');
    for (const [id, label, sub] of options) {
      const l = document.createElement('label');
      const i = document.createElement('input');
      i.type = 'radio';
      i.name = name;
      i.value = id;
      i.checked = String(value) === id;
      const s = node('span', '', label);
      if (sub) s.appendChild(node('small', '', sub));
      l.append(i, s);
      container.appendChild(l);
    }
  };
  seg($('skin-type'), 'skinType', SKIN_TYPES, prefs.skinType || 'combination');
  seg($('budget'), 'budget', BUDGETS, prefs.budget || 2);
  seg($('time'), 'time', TIMES, prefs.time || 'standard');
  $('sensitive').checked = Boolean(prefs.sensitive);
  $('pregnant').checked = Boolean(prefs.pregnant);
}

function limitGoals() {
  const boxes = [...document.querySelectorAll('input[name="goal"]')];
  const n = boxes.filter((b) => b.checked).length;
  for (const b of boxes) b.disabled = !b.checked && n >= 3;
}

function readPrefs() {
  const val = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
  return {
    goals: [...document.querySelectorAll('input[name="goal"]:checked')].map((b) => b.value),
    skinType: val('skinType') || 'unsure',
    budget: Number(val('budget') || 2),
    time: val('time') || 'standard',
    sensitive: $('sensitive').checked,
    pregnant: $('pregnant').checked,
  };
}

// ---------------------------------------------------------------------------
// Photo
// ---------------------------------------------------------------------------
function photoError(msg) {
  $('photo-error').textContent = msg || '';
  $('photo-error').hidden = !msg;
}

async function choosePhoto(file) {
  photoError('');
  if (!file) return;
  try {
    const photo = await decodeFile(file);
    state.sample = null;
    state.photoName = photo.name;
    $('sample-preview').hidden = true;
    $('preview').hidden = false;
    $('arch').classList.add('has-photo');
    $('arch-empty').hidden = true;
    $('photo-tools').hidden = false;
    $('zoom').value = '1';
    state.cropper = new Cropper($('preview'), photo, { onChange: updateTierNote });
    $('scan-btn').textContent = 'Scan and plan';
  } catch (err) {
    photoError(err instanceof PhotoError ? err.message : 'That photo could not be opened. Try a JPG or PNG.');
  }
}

function updateTierNote({ width, height, tier }) {
  const note = $('tier-note');
  note.replaceChildren();
  if (tier === 'hd') {
    note.append(node('b', '', 'HD scan. '), `${width}×${height} px: YouCam also scores pores and lines by face region.`);
  } else if (tier === 'sd') {
    note.append(node('b', '', 'Standard scan. '), `${width}×${height} px. Use a sharper photo or zoom out for HD (1080 px across) and regional detail.`);
  } else {
    note.append(node('b', '', 'Too small to scan. '), `${width}×${height} px. Zoom out or use a sharper photo (480 px across at least).`);
  }
}

function useSample() {
  photoError('');
  state.cropper = null;
  state.sample = state.checkIn && load().last?.scan?.sample === 'demo-a' ? 'demo-b' : 'demo-a';
  $('preview').hidden = true;
  $('sample-preview').hidden = false;
  $('arch').classList.add('has-photo');
  $('arch-empty').hidden = true;
  $('photo-tools').hidden = false;
  $('zoom').closest('label').hidden = true;
  const note = $('tier-note');
  note.replaceChildren(node('b', '', 'Sample face. '), state.sample === 'demo-b'
    ? 'An illustration with synthetic scores from 8 weeks later. No YouCam units are used.'
    : 'An illustration with synthetic demo scores, not a real person. No YouCam units are used.');
  $('scan-btn').textContent = state.sample === 'demo-b' ? 'Scan the sample check-in' : 'Scan the sample';
}

function resetPhoto() {
  state.cropper = null;
  state.sample = null;
  $('preview').hidden = true;
  $('sample-preview').hidden = true;
  $('arch').classList.remove('has-photo');
  $('arch-empty').hidden = false;
  $('photo-tools').hidden = true;
  $('zoom').closest('label').hidden = false;
  $('camera-input').value = '';
  $('file-input').value = '';
  $('scan-btn').textContent = 'Scan and plan';
}

// ---------------------------------------------------------------------------
// Working view: live steps
// ---------------------------------------------------------------------------
function stepList(list, prefix = '') {
  const items = new Map();
  return (s) => {
    const id = `${prefix}${s.id}`;
    let li = items.get(id);
    if (!li) {
      li = node('li');
      li.append(node('span', 'st-icon'), node('div', 'st-body'), node('span', 'st-by'));
      items.set(id, li);
      list.appendChild(li);
    }
    li.dataset.status = s.status;
    const body = li.querySelector('.st-body');
    body.replaceChildren(node('span', 'st-title', `${prefix ? 'Before photo: ' : ''}${s.title || s.id}`));
    if (s.detail) body.appendChild(node('span', 'st-detail', s.detail));
    li.querySelector('.st-by').textContent = s.by === 'gemini' ? 'Gemini' : s.by === 'scripted' ? 'Scripted' : s.ms ? `${(s.ms / 1000).toFixed(1)} s` : s.status === 'skipped' ? 'Saved units' : '';
  };
}

function showRetake(err) {
  $('working-title').textContent = 'That photo didn’t work';
  $('working-sub').textContent = 'Nothing was charged: YouCam only uses units when an analysis succeeds.';
  $('retake').hidden = false;
  $('retake-title').textContent = err.message;
  const tips = $('retake-tips');
  tips.replaceChildren(...(err.tips?.length ? err.tips : ['Try again in a moment.']).map((t) => node('li', '', t)));
}

async function photoPayload() {
  if (state.sample) return { sample: state.sample };
  if (!state.cropper) throw new PhotoError('Take a selfie, upload a photo or use the sample face first.');
  const out = await state.cropper.export();
  if (state.photoUrl) URL.revokeObjectURL(state.photoUrl);
  state.photoUrl = out.previewUrl;
  return { image: out.dataUrl, fileName: state.photoName || 'selfie.jpg' };
}

async function runScan(event) {
  event.preventDefault();
  photoError('');
  let payload;
  try {
    payload = await photoPayload();
  } catch (err) {
    photoError(err.message);
    $('arch').scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  const prefs = readPrefs();
  save({ prefs });
  const stored = load();

  show('working');
  $('working-title').textContent = state.checkIn ? 'Reading your check-in scan' : 'Reading your skin';
  $('working-sub').textContent = 'YouCam is analysing 15 concerns. This usually takes a few seconds.';
  $('retake').hidden = true;
  const list = $('steps');
  list.replaceChildren();
  const trace = [];
  const onStep = stepList(list);

  try {
    // Optional "before" photo for an instant comparison.
    let previous = null;
    if (state.before && !state.sample) {
      const b = await exportFull(state.before);
      const onBefore = stepList(list, 'before-');
      const res = await analyze({ image: b.dataUrl, fileName: 'before.jpg', tone: false }, (e) => e.type === 'step' && onBefore(e.step));
      // The file's own date is the best guess for when the before photo was taken.
      const when = state.beforeDate && state.beforeDate < Date.now() - 86400000 ? state.beforeDate : Date.now() - 1000;
      previous = { ...res.scan, takenAt: new Date(when).toISOString() };
    } else if (state.checkIn && stored.last?.scan) {
      previous = stored.last.scan;
    }

    // Skin colour doesn't change with a routine: measure it once, reuse it on check-ins.
    const storedTone = state.checkIn ? stored.toneProfile : null;
    payload.tone = !storedTone;
    const res = await analyze(payload, (e) => {
      if (e.type === 'step') {
        onStep(e.step);
        trace.push(e.step);
      }
    });
    const scan = res.scan;
    if (scan.tone) save({ toneProfile: { skinHex: scan.tone.skinHex, quality: scan.tone.quality, measuredAt: scan.tone.measuredAt || scan.takenAt } });
    else if (storedTone && scan.toneStatus === 'skipped') scan.tone = { ...storedTone, reused: true };
    // The sample check-in is synthetic data for the same illustrated person 8 weeks later.
    if (previous && scan.sample === 'demo-b' && previous.sample === 'demo-a') {
      previous = { ...previous, takenAt: new Date(Date.parse(scan.takenAt) - 56 * 86400000).toISOString() };
    }

    $('working-title').textContent = 'Building your plan';
    $('working-sub').textContent = 'The planner ranks your scores against your goals, reads your skin profile, picks ingredient classes and checks every step against a measured score or colour.';
    const onTrace = stepList(list, '');
    const planRes = await stream('/api/plan', {
      body: { scan: storableScan(scan), preferences: prefs, ...(previous ? { previous: storableScan(previous) } : {}) },
      onEvent: (e) => e.type === 'trace' && onTrace({ ...e.event, id: `plan-${e.event.id}` }),
    });

    state.scan = scan;
    state.previous = previous;
    state.plan = planRes.plan;
    state.meta = planRes.meta;
    state.overlay = null;
    const history = [...(stored.history || []), storableScan(scan)].slice(-12);
    save({ history, last: { scan: storableScan(scan), previous: previous ? storableScan(previous) : null, plan: planRes.plan, meta: { ...planRes.meta, trace: planRes.meta.trace }, prefs } });
    state.checkIn = false;
    state.before = null;
    $('before-label').textContent = 'Choose a before photo';
    renderResults();
  } catch (err) {
    showRetake(err instanceof ApiError || err instanceof PhotoError ? err : new ApiError('Something went wrong. Try again in a moment.'));
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
function citeEl(item) {
  const wrap = node('p', 'cite');
  const meter = node('span', 'meter');
  const fill = document.createElement('i');
  fill.style.width = `${item.cites[0].score}%`;
  meter.appendChild(fill);
  meter.setAttribute('aria-hidden', 'true');
  wrap.append(meter, node('span', '', item.because.charAt(0).toUpperCase() + item.because.slice(1)));
  return wrap;
}

function toneCiteEl(item) {
  const wrap = node('p', 'cite');
  const dot = node('span', 'dot');
  dot.style.background = item.toneCite.hex;
  dot.setAttribute('aria-hidden', 'true');
  wrap.append(dot, node('span', '', item.toneBecause.charAt(0).toUpperCase() + item.toneBecause.slice(1)));
  return wrap;
}

const DEPTH_ORDER = [['dark', 'Dark', '#5c3a28'], ['brown', 'Brown', '#8d5a3c'], ['tan', 'Tan', '#b5835f'], ['intermediate', 'Inter\u00admediate', '#c99a7b'], ['light', 'Light', '#e2b79c'], ['very_light', 'Very light', '#f1d3c0']];
/** ITA axis drawn from -60 to +75 degrees across six equal-width bands, marker at the measured value. */
function itaPosition(ita) {
  const edges = [-60, -30, 10, 28, 41, 55, 75];
  const v = Math.max(-60, Math.min(75, ita));
  let i = 0;
  while (i < 5 && v > edges[i + 1]) i += 1;
  return ((i + (v - edges[i]) / (edges[i + 1] - edges[i])) / 6) * 100;
}

function renderProfile() {
  const p = state.plan.profile;
  const block = $('profile-block');
  if (!p) {
    block.hidden = true;
    return;
  }
  block.hidden = false;
  const sw = $('tone-swatch');
  sw.classList.toggle('empty', !p.tone);
  sw.style.setProperty('--skin', p.tone ? p.tone.skinHex : '');
  sw.textContent = p.tone ? '' : 'Not measured';
  const facts = $('profile-facts');
  facts.replaceChildren();
  const fact = (label, ...content) => {
    const d = node('div');
    const dd = document.createElement('dd');
    dd.append(...content);
    d.append(node('dt', '', label), dd);
    facts.appendChild(d);
  };
  if (p.tone) {
    const when = p.tone.reused && p.tone.measuredAt ? ` Measured on ${fmtDate(p.tone.measuredAt)} and reused, so this scan cost no extra units.` : '';
    fact('Skin colour', node('b', '', p.tone.skinHex), `, ${p.tone.depthLabel.toLowerCase()} on the ITA scale (${p.tone.ita}°).${when}`);
  } else {
    fact('Skin colour', p.toneError ? `Not measured: ${p.toneError}` : 'Not measured on this scan.');
  }
  const scores = [p.oil ? `oil balance ${p.oil.score}` : null, p.moisture ? `hydration ${p.moisture.score}` : null].filter(Boolean).join(', ');
  fact('Skin type', node('b', '', p.skinType), ` (your answer)${scores ? `. Measured ${scores}.` : '.'}`);
  const spf = [...state.plan.routine.am].reverse().find((s) => s.slot === 'protect');
  if (spf) {
    const match = [spf.shade, spf.finish].filter(Boolean).join(', ').toLowerCase();
    fact('Sunscreen match', match.charAt(0).toUpperCase() + match.slice(1));
  }
  if (p.quality.checked) {
    fact('Photo check', p.quality.issues.length
      ? `YouCam rated the ${p.quality.issues.map((i) => `${i.label} as “${i.value}”`).join(' and ')}. Scores can shift on a better photo.`
      : 'YouCam rated lighting, face size, position and angle as good.');
  }
  const ita = $('ita-scale');
  ita.hidden = !p.tone;
  ita.replaceChildren();
  if (p.tone) {
    const track = node('div', 'ita-track');
    track.setAttribute('role', 'img');
    track.setAttribute('aria-label', `ITA skin-tone scale: ${p.tone.ita} degrees, ${p.tone.depthLabel}`);
    for (const [, , hex] of DEPTH_ORDER) {
      const b = document.createElement('span');
      b.style.background = hex;
      track.appendChild(b);
    }
    const m = node('i', 'ita-marker');
    m.style.left = `${itaPosition(p.tone.ita)}%`;
    m.style.background = p.tone.skinHex;
    track.appendChild(m);
    const labels = node('div', 'ita-labels');
    labels.setAttribute('aria-hidden', 'true');
    for (const [id, label] of DEPTH_ORDER) {
      const l = node('span', id === p.tone.depth ? 'on' : '');
      l.textContent = label;
      labels.appendChild(l);
    }
    ita.append(track, labels);
  }
  $('profile-notes').replaceChildren(...p.notes.map((n) => {
    const li = node('li', '', n.text);
    if (n.cites?.length) li.appendChild(citeEl(n));
    if (n.toneCite) li.appendChild(toneCiteEl(n));
    return li;
  }));
}

function renderPhoto() {
  const scan = state.scan;
  const photo = $('result-photo');
  const overlay = $('result-overlay');
  const sw = $('overlay-switch');
  sw.replaceChildren();
  if (scan.source === 'sample') {
    photo.src = '/samples/face.svg';
    photo.alt = 'Illustrated sample face';
  } else if (state.photoUrl) {
    photo.src = state.photoUrl;
    photo.alt = 'Your photo (kept only in this tab)';
  } else {
    photo.removeAttribute('src');
    photo.alt = '';
  }
  photo.hidden = !photo.getAttribute('src');
  const focus = state.plan.focus.map((f) => scan.concerns.find((c) => c.key === f.key)).filter((c) => c?.overlayUrl);
  overlay.hidden = true;
  if (!focus.length) return;
  const buttons = [{ key: null, label: 'Photo' }, ...focus.map((c) => ({ key: c.key, label: c.label, url: c.overlayUrl }))];
  for (const b of buttons) {
    const btn = node('button', '', b.label);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(state.overlay === b.key));
    btn.addEventListener('click', () => {
      state.overlay = b.key;
      for (const x of sw.children) x.setAttribute('aria-pressed', String(x === btn));
      if (b.url) {
        overlay.src = b.url;
        overlay.alt = `Where the scan saw ${b.label.toLowerCase()}`;
        overlay.hidden = false;
      } else overlay.hidden = true;
    });
    sw.appendChild(btn);
  }
  overlay.onerror = () => {
    overlay.hidden = true;
  };
}

function renderZone() {
  const tabs = $('zone-tabs');
  tabs.replaceChildren();
  for (const m of MODE_KEYS) {
    const b = node('button', '', modeLabel(m));
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(state.zoneMode === m));
    b.addEventListener('click', () => {
      state.zoneMode = m;
      renderZone();
    });
    tabs.appendChild(b);
  }
  const out = renderZoneMap($('zone-map'), state.scan, state.zoneMode, $('tooltip'));
  const legend = $('zone-legend');
  legend.replaceChildren(...BANDS.map((b) => {
    const li = node('li');
    const sw = document.createElement('i');
    sw.style.background = `var(--zone-${b.cls})`;
    li.append(sw, `${b.label}`);
    li.title = b.name;
    return li;
  }));
  const parts = out.entries.map((e) => `${e.label} ${e.score}`).join(', ');
  const needsHd = state.zoneMode !== 'eyes' && !out.regional;
  $('zone-note').textContent = `${parts}.${needsHd ? ' Region detail needs an HD scan (photo 1080 px across or more).' : ''}`;
}

function renderCharts() {
  const focusKeys = state.plan.focus.map((f) => f.key);
  renderScoreBars($('scores-chart'), state.scan.concerns, focusKeys, $('tooltip'));
  renderScoreTable($('scores-table'), state.scan.concerns, focusKeys);
  const prog = state.plan.progress || (state.previous ? compareScans(state.previous, state.scan) : null);
  $('progress-block').hidden = !prog;
  if (prog) {
    const labels = { beforeLabel: state.previous?.takenAt ? `Before (${shortDate(state.previous.takenAt)})` : 'Before', afterLabel: `Now (${shortDate(state.scan.takenAt)})` };
    $('progress-summary').textContent = prog.summary;
    const leg = $('progress-legend');
    const key = (cls, label) => {
      const s = node('span');
      const i = document.createElement('i');
      i.style.background = `var(${cls})`;
      s.append(i, label);
      return s;
    };
    leg.replaceChildren(key('--data-soft', labels.beforeLabel), key('--data', labels.afterLabel));
    renderDumbbell($('progress-chart'), prog, $('tooltip'), labels);
    renderProgressTable($('progress-table'), prog, labels);
    $('progress-notes').textContent = [...prog.notes, 'Changes of 2 points or less are within normal photo-to-photo variation.'].join(' ');
  }
}

function renderResults() {
  const { scan, plan, meta } = state;
  show('results');
  const toneBit = scan.tone ? (scan.tone.reused ? ', skin tone from your first scan' : ' plus skin tone') : '';
  $('scan-meta').textContent = `Scanned ${fmtDate(scan.takenAt)}: ${scan.tier === 'hd' ? 'HD' : 'standard'} skin analysis of ${scan.concerns.length} concerns${toneBit}`;
  $('plan-headline').textContent = plan.headline;
  const flag = $('demo-flag');
  flag.hidden = !scan.demo;
  flag.textContent = scan.source === 'sample'
    ? 'Demo data: synthetic scores for the illustrated sample face.'
    : 'Demo data: this server has no YouCam key, so these scores are illustrative and not from your photo.';

  renderPhoto();
  renderProfile();
  const overall = $('overall');
  overall.replaceChildren(node('strong', '', String(scan.overall)), scan.overallSource === 'api' ? 'Overall skin score' : `Average of ${scan.concerns.length} scores`);
  renderZone();

  // Focus
  const fl = $('focus-list');
  fl.replaceChildren(...plan.focus.map((f) => {
    const li = node('li');
    const sc = node('div', 'focus-score');
    sc.append(node('strong', '', String(f.score)), node('span', '', 'of 100'));
    const title = node('div', 'focus-title');
    title.append(node('h4', '', f.label), node('span', 'band', f.band));
    for (const g of f.goals) title.appendChild(node('span', 'goal-tag', g));
    const p = node('p', '', `${f.regionNote ? `${f.regionNote} ` : ''}${f.explanation}`);
    li.append(sc, title, p, citeEl(f));
    return li;
  }));

  // Routine
  const pref = plan.preferences;
  $('routine-prefs').textContent = `${pref.budget}. ${pref.time}. ${pref.skinType} skin${pref.sensitive ? ', reacts easily' : ''}${pref.pregnant ? ', pregnant or breastfeeding' : ''}.`;
  const stepsEl = (steps) => steps.map((s) => {
    const li = node('li');
    const body = node('div');
    const name = node('p', 'step-name', s.name);
    body.append(name, node('p', 'step-cadence', s.cadence));
    body.appendChild(node('p', 'step-does', s.note || s.does));
    if (s.shade || s.finish) {
      const m = node('p', 'step-match');
      m.append(node('b', '', 'Look for: '), [s.shade, s.finish].filter(Boolean).join(', ').toLowerCase());
      body.appendChild(m);
    }
    body.appendChild(citeEl(s));
    if (s.toneCite) body.appendChild(toneCiteEl(s));
    if (s.start) body.appendChild(node('p', 'step-caution', s.start));
    if (s.caution) body.appendChild(node('p', 'step-caution', s.caution));
    li.appendChild(body);
    return li;
  });
  $('am-list').replaceChildren(...stepsEl(plan.routine.am));
  $('pm-list').replaceChildren(...stepsEl(plan.routine.pm));
  $('routine-issues').replaceChildren(...plan.routine.issues.map((i) => node('li', '', i)));
  $('ramp').replaceChildren(...plan.routine.rampUp.map((r) => {
    const li = node('li');
    li.append(node('b', '', r.when), node('span', '', r.text));
    return li;
  }));

  // Professional
  const pro = plan.professional;
  $('pro-summary').textContent = pro.summary;
  $('pro-list').replaceChildren(...pro.items.map((p) => {
    const d = node('div', 'pro-item');
    d.appendChild(node('h4', '', p.label));
    d.appendChild(citeEl(p));
    const ul = node('ul');
    for (const c of p.categories) {
      const li = node('li');
      li.append(node('b', '', `${c.name}. `), c.what);
      ul.appendChild(li);
    }
    d.appendChild(ul);
    if (p.regionCites?.length) d.appendChild(node('p', 'hint', `Lowest areas: ${p.regionCites.map((r) => r.because.replace(/^your /, '')).join('; ')}.`));
    if (p.toneNote) {
      const t = node('div', 'pro-tone');
      t.append(node('p', '', p.toneNote), toneCiteEl(p));
      d.appendChild(t);
    }
    return d;
  }));
  $('pro-when').textContent = pro.when;
  $('red-flags').replaceChildren(...pro.redFlags.map((f) => node('li', '', f)));

  renderCharts();

  // Trace
  const tl = $('trace-list');
  tl.replaceChildren();
  const add = stepList(tl);
  for (const t of meta.trace || []) add(t);
  const agentName = meta.agent === 'gemini' ? `Gemini (${meta.model})` : meta.agent === 'scripted-fallback' ? 'scripted planner (Gemini was unavailable)' : meta.agent === 'gemini+scripted' ? `Gemini (${meta.model}) with scripted completion` : 'scripted planner';
  $('trace-summary').textContent = `${(meta.trace || []).length} steps by the ${agentName}`;
  $('disclaimer').textContent = plan.disclaimer;
  buildPrintSheet($('print-sheet'), { scan, plan, clinic: state.clinic, bandOf });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function startOver({ checkIn = false } = {}) {
  state.checkIn = checkIn;
  resetPhoto();
  $('form-title').textContent = checkIn ? 'Check-in photo' : 'Your photo';
  $('form-sub').textContent = checkIn ? 'Same place, same light as last time, so the comparison is fair.' : 'Front-facing, no glasses, hair off your face.';
  $('sample-btn').textContent = checkIn && load().last?.scan?.sample === 'demo-a' ? 'Use the sample’s 8-week check-in' : 'Use the sample face';
  $('compare').hidden = checkIn;
  refreshResume();
  show('start');
}

function refreshResume() {
  const last = load().last;
  $('resume').hidden = !last?.plan || state.checkIn;
  if (last?.scan) $('resume-text').textContent = `Last scan: ${fmtDate(last.scan.takenAt)}.`;
}

function openLast() {
  const last = load().last;
  if (!last?.plan) return;
  state.scan = last.scan;
  state.previous = last.previous;
  state.plan = last.plan;
  state.meta = last.meta || { trace: [] };
  state.overlay = null;
  renderResults();
}

async function initHealth() {
  const h = await health();
  state.health = h;
  const yc = $('youcam-status');
  const ag = $('agent-status');
  if (!h?.mode) {
    yc.querySelector('span').textContent = 'Server offline';
    return;
  }
  yc.dataset.state = h.mode.youcam;
  yc.querySelector('span').textContent = h.mode.youcam === 'live' ? 'YouCam live' : 'Demo data';
  yc.title = h.mode.youcam === 'live' ? `Photos are analysed by YouCam AI Skin Analysis ${h.mode.skinApiVersion}` : 'No YouCam key on this server: scans return illustrative demo data';
  ag.dataset.state = h.mode.agent === 'gemini' ? 'live' : 'demo';
  ag.querySelector('span').textContent = h.mode.agent === 'gemini' ? 'Gemini planner' : 'Scripted planner';
}

function initTheme() {
  const btn = $('theme-toggle');
  const current = () => document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const label = () => btn.setAttribute('aria-label', current() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  label();
  btn.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('glowplan-theme', next);
    } catch {
      /* ignore */
    }
    label();
    if (!$('view-results').hidden) renderZone();
  });
}

function initClinic() {
  const raw = new URLSearchParams(location.search).get('clinic');
  let name = raw ? raw.replace(/[^\p{L}\p{N} .,'&-]/gu, '').trim().slice(0, 60) : '';
  try {
    if (name) sessionStorage.setItem('glowplan-clinic', name);
    else name = sessionStorage.getItem('glowplan-clinic') || '';
  } catch {
    /* ignore */
  }
  state.clinic = name || null;
  if (name) {
    $('clinic-tag').hidden = false;
    $('clinic-tag').textContent = `Offered by ${name}`;
  }
}

function init() {
  initTheme();
  initClinic();
  initHealth();
  const stored = load();
  buildControls(stored.prefs);
  refreshResume();

  $('camera-input').addEventListener('change', (e) => choosePhoto(e.target.files[0]));
  $('file-input').addEventListener('change', (e) => choosePhoto(e.target.files[0]));
  $('sample-btn').addEventListener('click', useSample);
  $('zoom').addEventListener('input', (e) => state.cropper?.setZoom(Number(e.target.value)));
  $('before-input').addEventListener('change', async (e) => {
    try {
      state.before = await decodeFile(e.target.files[0]);
      state.beforeDate = e.target.files[0].lastModified;
      $('before-label').textContent = `Before photo: ${e.target.files[0].name.slice(0, 32)}`;
    } catch (err) {
      photoError(err.message);
    }
  });
  $('scan-form').addEventListener('submit', runScan);
  $('retake-btn').addEventListener('click', () => startOver({ checkIn: state.checkIn }));
  $('restart-btn').addEventListener('click', () => startOver());
  $('checkin-btn').addEventListener('click', () => startOver({ checkIn: true }));
  $('resume-btn').addEventListener('click', openLast);
  $('print-btn').addEventListener('click', () => {
    buildPrintSheet($('print-sheet'), { scan: state.scan, plan: state.plan, clinic: state.clinic, bandOf });
    window.print();
  });
  window.addEventListener('beforeprint', () => state.plan && buildPrintSheet($('print-sheet'), { scan: state.scan, plan: state.plan, clinic: state.clinic, bandOf }));
  $('forget-btn').addEventListener('click', () => {
    try {
      localStorage.removeItem(STORE);
    } catch {
      /* ignore */
    }
    $('forget-btn').textContent = 'Scans forgotten on this device';
    $('forget-btn').disabled = true;
  });
  const toggle = (btnId, chartId, tableId) => $(btnId).addEventListener('click', () => {
    const showTable = $(tableId).hidden;
    $(tableId).hidden = !showTable;
    $(chartId).hidden = showTable;
    $(btnId).setAttribute('aria-pressed', String(showTable));
    $(btnId).textContent = showTable ? 'Show as chart' : 'Show as table';
  });
  toggle('scores-table-btn', 'scores-chart', 'scores-table');
  toggle('progress-table-btn', 'progress-chart', 'progress-table');

  let resizeTimer;
  let lastW = window.innerWidth;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (Math.abs(window.innerWidth - lastW) < 8) return;
      lastW = window.innerWidth;
      if (!$('view-results').hidden && state.plan) renderCharts();
      state.cropper?.draw();
    }, 150);
  });
}

init();
