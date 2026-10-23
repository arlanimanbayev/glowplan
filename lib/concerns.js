/**
 * The skin concerns YouCam AI Skin Analysis measures, and a parser that turns
 * any documented result shape into one normalised scan object.
 *
 * Source: https://docs.perfectcorp.com/reference/ai_skin_analysis (v2.0 / v2.1)
 * and the official YouCam-API/skills repo (skin-analysis-expert, api-fallback.yaml).
 *
 * - 16 actions exist in two tiers: HD (`hd_*`, photo short side >= 1080 px) and
 *   SD (short side >= 480 px). One request may not mix tiers.
 * - Scores: `ui_score` is an integer 1-100 where HIGHER means healthier-looking
 *   skin (less of that concern). `raw_score` is the model's direct float output.
 * - HD pores and wrinkles also come back per facial region.
 *
 * GlowPlan requests the 15 scored concerns and leaves out `skin_type` (the
 * person tells us their skin type instead): 15 actions sit in the same unit
 * tier as 16, so nothing is lost on cost.
 */

import { sanitizeTone } from './tone.js';

/** @typedef {{ key: string, hd: string, sd: string, label: string, noun: string, regions?: string[] }} Concern */

/** @type {Concern[]} */
export const CONCERNS = [
  { key: 'wrinkle', hd: 'hd_wrinkle', sd: 'wrinkle', label: 'Lines and wrinkles', noun: 'wrinkles', regions: ['forehead', 'glabellar', 'crowfeet', 'periocular', 'nasolabial', 'marionette'] },
  { key: 'pore', hd: 'hd_pore', sd: 'pore', label: 'Pores', noun: 'pores', regions: ['forehead', 'nose', 'cheek'] },
  { key: 'texture', hd: 'hd_texture', sd: 'texture', label: 'Texture', noun: 'texture' },
  { key: 'acne', hd: 'hd_acne', sd: 'acne', label: 'Breakouts', noun: 'acne' },
  { key: 'redness', hd: 'hd_redness', sd: 'redness', label: 'Redness', noun: 'redness' },
  { key: 'oiliness', hd: 'hd_oiliness', sd: 'oiliness', label: 'Oil balance', noun: 'oiliness' },
  { key: 'moisture', hd: 'hd_moisture', sd: 'moisture', label: 'Hydration', noun: 'hydration' },
  { key: 'radiance', hd: 'hd_radiance', sd: 'radiance', label: 'Radiance', noun: 'radiance' },
  { key: 'firmness', hd: 'hd_firmness', sd: 'firmness', label: 'Firmness', noun: 'firmness' },
  { key: 'age_spot', hd: 'hd_age_spot', sd: 'age_spot', label: 'Spots and even tone', noun: 'spots' },
  { key: 'dark_circle', hd: 'hd_dark_circle', sd: 'dark_circle_v2', label: 'Dark circles', noun: 'dark circles' },
  { key: 'eye_bag', hd: 'hd_eye_bag', sd: 'eye_bag', label: 'Eye bags', noun: 'eye bags' },
  { key: 'tear_trough', hd: 'hd_tear_trough', sd: 'tear_trough', label: 'Tear trough', noun: 'tear trough' },
  { key: 'droopy_upper_eyelid', hd: 'hd_droopy_upper_eyelid', sd: 'droopy_upper_eyelid', label: 'Upper eyelids', noun: 'upper eyelid' },
  { key: 'droopy_lower_eyelid', hd: 'hd_droopy_lower_eyelid', sd: 'droopy_lower_eyelid', label: 'Lower eyelids', noun: 'lower eyelid' },
];

export const CONCERN_KEYS = CONCERNS.map((c) => c.key);
export const BY_KEY = Object.fromEntries(CONCERNS.map((c) => [c.key, c]));

/** Every action name the API accepts (for validation and the mock). */
export const HD_ACTIONS = [...CONCERNS.map((c) => c.hd), 'hd_skin_type'];
export const SD_ACTIONS = [...CONCERNS.map((c) => c.sd), 'skin_type'];

const ACTION_TO_KEY = new Map();
for (const c of CONCERNS) {
  ACTION_TO_KEY.set(c.hd, c.key);
  ACTION_TO_KEY.set(c.sd, c.key);
  ACTION_TO_KEY.set(c.key, c.key);
}
ACTION_TO_KEY.set('dark_circle', 'dark_circle');

export const REGION_LABELS = {
  forehead: 'Forehead',
  nose: 'Nose',
  cheek: 'Cheeks',
  glabellar: 'Between the brows',
  crowfeet: "Crow's feet",
  periocular: 'Under the eyes',
  nasolabial: 'Smile lines',
  marionette: 'Mouth corners',
};

/** "Pores look most visible on your nose" style phrases. */
export const REGION_PHRASE = {
  forehead: 'on your forehead',
  nose: 'on your nose',
  cheek: 'on your cheeks',
  glabellar: 'between your brows',
  crowfeet: "at your crow's feet",
  periocular: 'under your eyes',
  nasolabial: 'along your smile lines',
  marionette: 'at the corners of your mouth',
};

/** The dst_actions list for a tier. */
export function actionsFor(tier, keys = CONCERN_KEYS) {
  const t = tier === 'sd' ? 'sd' : 'hd';
  return keys.filter((k) => BY_KEY[k]).map((k) => BY_KEY[k][t]);
}

/**
 * Documented unit cost per Skin Analysis task (v2.0/v2.1), by tier and the
 * number of concerns requested. Units are only charged when a task succeeds.
 */
export const UNIT_TIERS = [
  { max: 4, sd: 9, hd: 12 },
  { max: 8, sd: 12, hd: 16 },
  { max: 12, sd: 14, hd: 20 },
  { max: 16, sd: 16, hd: 22 },
];
export function estimateUnits(tier, count) {
  const row = UNIT_TIERS.find((r) => count <= r.max) || UNIT_TIERS[UNIT_TIERS.length - 1];
  return row[tier === 'sd' ? 'sd' : 'hd'];
}

/** Photo requirements from the docs (File Specs & Errors). */
export const IMAGE_RULES = {
  types: ['image/jpeg', 'image/png'],
  maxBytes: 10 * 1024 * 1024,
  minShortSideSd: 480,
  minShortSideHd: 1080,
  autoResizeLongSide: 2560,
};

/** Score bands used for wording (same cut-offs as the official skill's star scale). */
export function band(score) {
  if (score >= 85) return { id: 'excellent', label: 'Excellent' };
  if (score >= 70) return { id: 'good', label: 'Good' };
  if (score >= 55) return { id: 'fair', label: 'Fair' };
  if (score >= 40) return { id: 'care', label: 'Needs care' };
  return { id: 'attention', label: 'Needs attention' };
}

const clampScore = (n) => Math.max(1, Math.min(100, Math.round(n)));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round2 = (n) => Math.round(n * 100) / 100;

/** Finds the `output` array in any of the documented response wrappers. */
function findOutput(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [payload.output, payload.results?.output, payload.data?.results?.output, payload.data?.output];
  return candidates.find(Array.isArray) || null;
}

/** Looks like score_info.json (format=zip): concern keys at the top level. */
function looksLikeScoreInfo(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  return Object.keys(payload).some((k) => ACTION_TO_KEY.has(k));
}

/**
 * Normalise a YouCam Skin Analysis result.
 *
 * Accepts: the full GET task response, its `data`, `data.results`, the bare
 * `output` array (format=json, v2.0/v2.1: items `{type, region?, ui_score,
 * raw_score, score?, mask_urls}`), or a `score_info.json` object (format=zip:
 * `{hd_pore: {nose: {ui_score, raw_score, output_mask_name}, ...}, all: {score}, skin_age}`).
 *
 * Returns `{ tier, concerns[], overall, overallSource, skinAge, unknownTypes[] }`.
 * Concerns are in catalogue order; only concerns present in the payload appear.
 */
export function parseSkinResult(payload, { tier: tierHint } = {}) {
  const acc = new Map(); // key -> { whole, regions: Map(region -> entry), mask, action }
  const unknownTypes = [];
  let overall = null;
  let skinAge = null;
  const itemScores = [];
  let sawHd = false;
  let sawSd = false;

  const entry = (key, action) => {
    if (!acc.has(key)) acc.set(key, { whole: null, regions: new Map(), mask: null, action });
    return acc.get(key);
  };
  const noteTier = (action) => {
    if (String(action).startsWith('hd_')) sawHd = true;
    else sawSd = true;
  };

  const output = findOutput(payload);
  if (output) {
    for (const item of output) {
      if (!item || typeof item !== 'object') continue;
      const type = String(item.type || '');
      if (type === 'all' || type === 'overall') {
        const v = isNum(item.score) ? item.score : isNum(item.ui_score) ? item.ui_score : null;
        if (v !== null) overall = v;
        continue;
      }
      if (type === 'skin_age') {
        const v = [item.score, item.ui_score, item.raw_score, item.value].find(isNum);
        if (v !== undefined) skinAge = Math.round(v);
        continue;
      }
      if (type === 'hd_skin_type' || type === 'skin_type') continue;
      const key = ACTION_TO_KEY.get(type);
      if (!key) {
        if (type) unknownTypes.push(type);
        continue;
      }
      if (!isNum(item.ui_score) && !isNum(item.raw_score)) continue;
      noteTier(type);
      if (isNum(item.score)) itemScores.push(item.score);
      const e = entry(key, type);
      const value = {
        score: clampScore(isNum(item.ui_score) ? item.ui_score : item.raw_score),
        raw: isNum(item.raw_score) ? round2(item.raw_score) : null,
        mask: Array.isArray(item.mask_urls) ? item.mask_urls.find((u) => typeof u === 'string') || null : null,
      };
      const region = typeof item.region === 'string' ? item.region : '';
      if (!region || region === 'whole' || region === 'all') e.whole = value;
      else e.regions.set(region, value);
      if (value.mask && (!e.mask || !region || region === 'whole')) e.mask = value.mask;
    }
  } else if (looksLikeScoreInfo(payload)) {
    for (const [k, v] of Object.entries(payload)) {
      if (k === 'all') {
        if (isNum(v?.score)) overall = v.score;
        continue;
      }
      if (k === 'skin_age') {
        if (isNum(v)) skinAge = Math.round(v);
        continue;
      }
      const key = ACTION_TO_KEY.get(k);
      if (!key) {
        if (!/skin_type/.test(k)) unknownTypes.push(k);
        continue;
      }
      if (!v || typeof v !== 'object') continue;
      noteTier(k);
      const e = entry(key, k);
      const toValue = (o) => ({ score: clampScore(isNum(o.ui_score) ? o.ui_score : o.raw_score), raw: isNum(o.raw_score) ? round2(o.raw_score) : null, mask: null });
      if (isNum(v.ui_score) || isNum(v.raw_score)) {
        e.whole = toValue(v);
      } else {
        for (const [region, o] of Object.entries(v)) {
          if (!o || typeof o !== 'object' || (!isNum(o.ui_score) && !isNum(o.raw_score))) continue;
          if (region === 'whole' || region === 'all') e.whole = toValue(o);
          else e.regions.set(region, toValue(o));
        }
      }
    }
  } else {
    throw new Error('Unrecognised skin analysis result.');
  }

  const concerns = [];
  for (const c of CONCERNS) {
    const e = acc.get(c.key);
    if (!e) continue;
    const regions = [...e.regions.entries()].map(([region, v]) => ({ region, label: REGION_LABELS[region] || region, score: v.score }));
    let whole = e.whole;
    let wholeSource = 'api';
    if (!whole && regions.length) {
      whole = { score: clampScore(regions.reduce((s, r) => s + r.score, 0) / regions.length), raw: null, mask: null };
      wholeSource = 'regions-average';
    }
    if (!whole) continue;
    concerns.push({
      key: c.key,
      label: c.label,
      noun: c.noun,
      action: e.action,
      score: whole.score,
      raw: whole.raw,
      ...(wholeSource !== 'api' ? { scoreSource: wholeSource } : {}),
      regions,
      overlayUrl: e.mask || null,
    });
  }
  if (!concerns.length) throw new Error('The skin analysis result had no concern scores.');

  // `score` on v2.x output items is documented as the general skin condition.
  if (overall === null && itemScores.length && itemScores.every((s) => Math.abs(s - itemScores[0]) < 0.01)) overall = itemScores[0];
  const overallSource = overall !== null ? 'api' : 'average';
  if (overall === null) overall = concerns.reduce((s, c) => s + c.score, 0) / concerns.length;

  const tier = sawHd && !sawSd ? 'hd' : sawSd && !sawHd ? 'sd' : tierHint === 'sd' ? 'sd' : 'hd';
  return { tier, concerns, overall: Math.round(overall), overallSource, skinAge, unknownTypes };
}

/**
 * Validate a scan the browser sends back (for /api/plan). Only known concerns
 * with integer scores 1-100 survive; regions are kept only for concerns that have them.
 */
export function sanitizeScan(scan) {
  if (!scan || typeof scan !== 'object' || !Array.isArray(scan.concerns)) return null;
  const seen = new Set();
  const concerns = [];
  for (const c of scan.concerns) {
    const meta = BY_KEY[c?.key];
    if (!meta || seen.has(meta.key) || !isNum(c.score)) continue;
    seen.add(meta.key);
    const regions = Array.isArray(c.regions) && meta.regions
      ? c.regions.filter((r) => meta.regions.includes(r?.region) && isNum(r.score)).map((r) => ({ region: r.region, label: REGION_LABELS[r.region], score: clampScore(r.score) }))
      : [];
    concerns.push({ key: meta.key, label: meta.label, noun: meta.noun, score: clampScore(c.score), regions });
  }
  if (concerns.length < 3) return null;
  concerns.sort((a, b) => CONCERN_KEYS.indexOf(a.key) - CONCERN_KEYS.indexOf(b.key));
  const takenAt = typeof scan.takenAt === 'string' && !Number.isNaN(Date.parse(scan.takenAt)) ? new Date(scan.takenAt).toISOString() : new Date().toISOString();
  const tone = sanitizeTone(scan.tone);
  const toneError = !tone && typeof scan.toneError === 'string' ? scan.toneError.replace(/[\u0000-\u001f]/g, ' ').slice(0, 160) : null;
  return {
    tier: scan.tier === 'sd' ? 'sd' : 'hd',
    concerns,
    ...(tone ? { tone } : {}),
    ...(toneError ? { toneError } : {}),
    overall: isNum(scan.overall) ? clampScore(scan.overall) : clampScore(concerns.reduce((s, c) => s + c.score, 0) / concerns.length),
    takenAt,
    demo: Boolean(scan.demo),
  };
}

/** "because your pores score is 41/100" */
export function citeText(concern) {
  return `your ${concern.noun} score is ${concern.score}/100`;
}
