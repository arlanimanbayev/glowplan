#!/usr/bin/env node
/**
 * Writes the synthetic demo fixtures in data/fixtures/. They are shaped exactly
 * like a YouCam AI Skin Analysis GET task response with format=json (v2.1):
 *
 *   { status: 200, data: { task_status: 'success', results: { output: [
 *       { type, region?, ui_score, raw_score, score, mask_urls } ] } } }
 *
 * The scores are invented for a fictional person (no real face was scanned).
 * demo-a is a first scan; demo-b is the same fictional person eight weeks later.
 * tone-demo is a Skin Tone Analysis result for the same illustrated face.
 *
 *   node scripts/build-fixtures.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'data', 'fixtures');

// [action, ui_score, regions?]
const DEMO_A = [
  ['hd_wrinkle', 62, { forehead: 66, glabellar: 70, crowfeet: 57, periocular: 55, nasolabial: 64, marionette: 71 }],
  ['hd_pore', 41, { forehead: 52, nose: 33, cheek: 47 }],
  ['hd_texture', 54],
  ['hd_acne', 47],
  ['hd_redness', 58],
  ['hd_oiliness', 44],
  ['hd_moisture', 63],
  ['hd_radiance', 57],
  ['hd_firmness', 72],
  ['hd_age_spot', 66],
  ['hd_dark_circle', 52],
  ['hd_eye_bag', 69],
  ['hd_tear_trough', 61],
  ['hd_droopy_upper_eyelid', 78],
  ['hd_droopy_lower_eyelid', 74],
];

const DEMO_B = [
  ['hd_wrinkle', 63, { forehead: 67, glabellar: 70, crowfeet: 58, periocular: 56, nasolabial: 64, marionette: 71 }],
  ['hd_pore', 48, { forehead: 58, nose: 40, cheek: 52 }],
  ['hd_texture', 61],
  ['hd_acne', 59],
  ['hd_redness', 62],
  ['hd_oiliness', 52],
  ['hd_moisture', 60],
  ['hd_radiance', 63],
  ['hd_firmness', 72],
  ['hd_age_spot', 68],
  ['hd_dark_circle', 50],
  ['hd_eye_bag', 69],
  ['hd_tear_trough', 61],
  ['hd_droopy_upper_eyelid', 78],
  ['hd_droopy_lower_eyelid', 75],
];

// Deterministic raw scores: the API's raw_score is a float on the same 1-100
// scale that the ui_score is adjusted from (ui is "more favourable").
function rawFor(ui, salt) {
  const wobble = ((salt * 37) % 29) / 10; // 0.0 - 2.8
  return Math.round((ui - 4.5 - wobble) * 100) / 100;
}

const REGION_ORDER = ['forehead', 'glabellar', 'crowfeet', 'periocular', 'nasolabial', 'marionette', 'nose', 'cheek'];

function build(rows, overall) {
  const output = [];
  rows.forEach(([type, ui, regions], i) => {
    const mask = `/samples/overlays/${type}.svg`;
    if (regions) {
      output.push({ type, region: 'whole', ui_score: ui, raw_score: rawFor(ui, i + 1), score: overall, mask_urls: [mask] });
      for (const region of REGION_ORDER.filter((r) => r in regions)) {
        output.push({ type, region, ui_score: regions[region], raw_score: rawFor(regions[region], i + region.length), score: overall, mask_urls: [mask] });
      }
    } else {
      output.push({ type, ui_score: ui, raw_score: rawFor(ui, i + 1), score: overall, mask_urls: [mask] });
    }
  });
  return { status: 200, data: { task_status: 'success', results: { output } } };
}

writeFileSync(join(out, 'demo-a.json'), `${JSON.stringify(build(DEMO_A, 59.84), null, 2)}\n`);
writeFileSync(join(out, 'demo-b.json'), `${JSON.stringify(build(DEMO_B, 63.12), null, 2)}\n`);

// The same first scan as score_info.json from a format=zip result, used to test the parser.
const scoreInfo = {};
DEMO_A.forEach(([type, ui, regions], i) => {
  const leaf = (score, suffix = '') => ({ raw_score: rawFor(score, i + 1), ui_score: score, output_mask_name: `${type}_output${suffix}.png` });
  if (regions) {
    scoreInfo[type] = { whole: leaf(ui, '_all') };
    for (const [r, s] of Object.entries(regions)) scoreInfo[type][r] = leaf(s, `_${r}`);
  } else if (type === 'hd_texture' || type === 'hd_acne') {
    scoreInfo[type] = { whole: leaf(ui) };
  } else {
    scoreInfo[type] = leaf(ui);
  }
});
scoreInfo.all = { score: 59.84 };
scoreInfo.skin_age = 31;
writeFileSync(join(out, 'score-info-hd.json'), `${JSON.stringify(scoreInfo, null, 2)}\n`);
// Skin Tone Analysis result for the illustrated sample face, shaped like the GET
// task response in the docs (results.face_quality + results.color). The skin hex is
// the illustration's own skin fill, so the swatch matches what people see.
const tone = {
  status: 200,
  data: {
    task_status: 'success',
    results: {
      face_quality: { has_face: true, area: 'good', frontal: 'good', lighting: 'good', faceangle: 'good' },
      color: {
        eye_color: '#3b2a22',
        eye_color_name: 'Brown',
        lip_color: '#b25f5a',
        eyebrow_color: '#3a2c26',
        skin_color: '#cf9a7b',
        hair_color: '#000000',
        hair_color_name: 'Black',
      },
    },
  },
};
writeFileSync(join(out, 'tone-demo.json'), `${JSON.stringify(tone, null, 2)}\n`);
console.log('Fixtures written to', out);
