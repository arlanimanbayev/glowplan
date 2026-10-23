/**
 * YouCam Skin Tone Analysis ("AI Facial Color Tones Analyzer").
 *
 * Source: https://docs.perfectcorp.com/reference/ai_skin_tone_analysis (v1.0 doc,
 * endpoint /s2s/v2.0/task/skin-tone-analysis) and the official YouCam-API/skills repo.
 *
 * The API returns measured colours, not an undertone:
 *   results.color        { skin_color '#b9947c', eye_color, eye_color_name, lip_color,
 *                          eyebrow_color, hair_color, hair_color_name }
 *   results.face_quality { has_face, area, frontal, lighting, faceangle }  ("good" when fine)
 *
 * GlowPlan derives one thing from the measured skin colour: the Individual Typology
 * Angle (ITA°), a standard colorimetric measure of skin depth computed from CIELAB
 * (ITA = atan((L* - 50) / b*) in degrees; bands from Chardon et al. 1991 and Del Bino
 * et al. 2006). It is an estimate from one photo, labelled as such, and it never
 * claims an undertone the API did not return.
 */

const HEX = /^#?([0-9a-f]{6})$/i;

export function normHex(v) {
  const m = HEX.exec(String(v || '').trim());
  return m ? `#${m[1].toLowerCase()}` : null;
}

/** sRGB hex -> CIELAB (D65). */
export function hexToLab(hex) {
  const h = normHex(hex);
  if (!h) return null;
  const lin = [1, 3, 5].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const [r, g, b] = lin;
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const Z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const L = 116 * f(Y) - 16;
  return { L: round1(L), a: round1(500 * (f(X) - f(Y))), b: round1(200 * (f(Y) - f(Z))) };
}
const round1 = (n) => Math.round(n * 10) / 10 || 0; // no -0

/** Individual Typology Angle in whole degrees. */
export function itaOf(lab) {
  if (!lab) return null;
  return Math.round((Math.atan2(lab.L - 50, lab.b) * 180) / Math.PI);
}

/** ITA bands (Chardon 1991 / Del Bino 2006) mapped to a three-step tint family for tinted sunscreen. */
export const DEPTHS = [
  { id: 'very_light', min: 55, label: 'Very light', tint: 'light' },
  { id: 'light', min: 41, label: 'Light', tint: 'light' },
  { id: 'intermediate', min: 28, label: 'Intermediate', tint: 'medium' },
  { id: 'tan', min: 10, label: 'Tan', tint: 'medium' },
  { id: 'brown', min: -30, label: 'Brown', tint: 'deep' },
  { id: 'dark', min: -Infinity, label: 'Dark', tint: 'deep' },
];
export function depthOf(ita) {
  return DEPTHS.find((d) => ita > d.min || d.min === -Infinity);
}
/** Medium-to-deep skin (roughly ITA under 28°) where pigment-change cautions apply. */
export const isDeeper = (tone) => Boolean(tone && ['tan', 'brown', 'dark'].includes(tone.depth));

const QUALITY_KEYS = ['area', 'frontal', 'lighting', 'faceangle'];
const QUALITY_LABELS = { area: 'face size', frontal: 'face position', lighting: 'lighting', faceangle: 'face angle' };

/** Build GlowPlan's tone profile from a measured skin colour (and optional extras). */
export function toneFromHex(skinHex, extra = {}) {
  const hex = normHex(skinHex);
  const lab = hexToLab(hex);
  if (!lab) return null;
  const ita = itaOf(lab);
  const d = depthOf(ita);
  return { skinHex: hex, lab, ita, depth: d.id, depthLabel: d.label, tint: d.tint, ...extra };
}

/**
 * Parse a Skin Tone Analysis result. Accepts the full GET response, its data,
 * its results, or the bare `color` object. Returns null if no skin colour.
 */
export function parseToneResult(payload) {
  const results = payload?.data?.results || payload?.results || payload;
  const color = results?.color || (results?.skin_color ? results : null);
  if (!color?.skin_color) return null;
  const q = results?.face_quality && typeof results.face_quality === 'object' ? results.face_quality : null;
  const quality = q
    ? {
      hasFace: q.has_face !== false,
      ...Object.fromEntries(QUALITY_KEYS.filter((k) => typeof q[k] === 'string').map((k) => [k, q[k].slice(0, 24)])),
    }
    : null;
  return toneFromHex(color.skin_color, {
    eye: normHex(color.eye_color),
    eyeName: typeof color.eye_color_name === 'string' ? color.eye_color_name.slice(0, 20) : null,
    lip: normHex(color.lip_color),
    brow: normHex(color.eyebrow_color),
    hair: normHex(color.hair_color),
    hairName: typeof color.hair_color_name === 'string' ? color.hair_color_name.slice(0, 20) : null,
    quality,
  });
}

/** Quality fields YouCam did not rate "good" (they make all scores less reliable). */
export function qualityIssues(tone) {
  if (!tone?.quality) return [];
  return QUALITY_KEYS.filter((k) => tone.quality[k] && tone.quality[k].toLowerCase() !== 'good').map((k) => ({ key: k, label: QUALITY_LABELS[k], value: tone.quality[k] }));
}

/** Re-derive a tone profile from client-sent data (never trust client-computed ITA). */
export function sanitizeTone(t) {
  if (!t || typeof t !== 'object') return null;
  const quality = t.quality && typeof t.quality === 'object'
    ? Object.fromEntries(QUALITY_KEYS.filter((k) => typeof t.quality[k] === 'string').map((k) => [k, t.quality[k].slice(0, 24)]))
    : null;
  const measuredAt = typeof t.measuredAt === 'string' && !Number.isNaN(Date.parse(t.measuredAt)) ? new Date(t.measuredAt).toISOString() : null;
  return toneFromHex(t.skinHex, { quality, ...(measuredAt ? { measuredAt } : {}), ...(t.reused ? { reused: true } : {}) });
}

/** "YouCam measured your skin colour as #b9947c (intermediate on the ITA skin-tone scale, 38°)" */
export function toneCiteText(tone) {
  return `YouCam measured your skin colour as ${tone.skinHex} (${tone.depthLabel.toLowerCase()} on the ITA skin-tone scale, ${tone.ita}°)`;
}
