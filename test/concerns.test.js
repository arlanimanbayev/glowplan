// Result parsing for every documented shape, scan sanitising and unit costs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSkinResult, sanitizeScan, estimateUnits, actionsFor, band, CONCERNS } from '../lib/concerns.js';
import { loadFixture } from '../lib/mock-youcam.js';

test('format=json v2.1 output: whole score, regions, overlay URL and overall from `score`', () => {
  const r = parseSkinResult(loadFixture('demo-a'));
  assert.equal(r.tier, 'hd');
  assert.equal(r.concerns.length, 15);
  const pore = r.concerns.find((c) => c.key === 'pore');
  assert.equal(pore.score, 41);
  assert.equal(pore.action, 'hd_pore');
  assert.deepEqual(pore.regions.map((x) => [x.region, x.score]), [['forehead', 52], ['nose', 33], ['cheek', 47]]);
  assert.equal(pore.overlayUrl, '/samples/overlays/hd_pore.svg');
  assert.equal(typeof pore.raw, 'number');
  const wrinkle = r.concerns.find((c) => c.key === 'wrinkle');
  assert.equal(wrinkle.regions.length, 6);
  assert.equal(r.overall, 60);
  assert.equal(r.overallSource, 'api');
});

test('accepts the full response, data, results or the bare output array', () => {
  const full = loadFixture('demo-a');
  for (const shape of [full, full.data, full.data.results, full.data.results.output]) {
    assert.equal(parseSkinResult(shape).concerns.length, 15);
  }
});

test('score_info.json (format=zip) with nested HD regions, all.score and skin_age', () => {
  const r = parseSkinResult(loadFixture('score-info-hd'));
  assert.equal(r.tier, 'hd');
  assert.equal(r.concerns.length, 15);
  assert.equal(r.skinAge, 31);
  assert.equal(r.overall, 60);
  assert.equal(r.concerns.find((c) => c.key === 'pore').regions.find((x) => x.region === 'nose').score, 33);
  assert.equal(r.concerns.find((c) => c.key === 'acne').score, 47, 'hd_acne nests its score under "whole"');
});

test('SD names, `all`/`skin_age` items, unknown types and missing overall', () => {
  const r = parseSkinResult({
    output: [
      { type: 'pore', ui_score: 70, raw_score: 66.1, mask_urls: ['https://x/pore.png'] },
      { type: 'dark_circle_v2', ui_score: 55, raw_score: 50 },
      { type: 'skin_type', ui_score: 80 },
      { type: 'all', score: 71.6 },
      { type: 'skin_age', score: 29.4 },
      { type: 'future_concern', ui_score: 10 },
    ],
  });
  assert.equal(r.tier, 'sd');
  assert.deepEqual(r.concerns.map((c) => c.key), ['pore', 'dark_circle']);
  assert.equal(r.overall, 72);
  assert.equal(r.skinAge, 29);
  assert.deepEqual(r.unknownTypes, ['future_concern']);

  const avg = parseSkinResult({ output: [{ type: 'hd_pore', ui_score: 40 }, { type: 'hd_acne', ui_score: 60 }] });
  assert.equal(avg.overall, 50);
  assert.equal(avg.overallSource, 'average');
});

test('regions without a whole entry fall back to their average', () => {
  const r = parseSkinResult({ output: [{ type: 'hd_pore', region: 'nose', ui_score: 30 }, { type: 'hd_pore', region: 'cheek', ui_score: 50 }] });
  assert.equal(r.concerns[0].score, 40);
  assert.equal(r.concerns[0].scoreSource, 'regions-average');
});

test('rejects payloads with no scores', () => {
  assert.throws(() => parseSkinResult({ data: { task_status: 'success', results: { output: [] } } }), /no concern scores/);
  assert.throws(() => parseSkinResult({ hello: 1 }), /Unrecognised/);
});

test('sanitizeScan keeps only known concerns with valid scores', () => {
  const scan = parseSkinResult(loadFixture('demo-a'));
  const s = sanitizeScan({ ...scan, concerns: [...scan.concerns, { key: 'evil', score: 5 }, { key: 'pore', score: 1 }], takenAt: 'nope' });
  assert.equal(s.concerns.length, 15);
  assert.equal(s.concerns.find((c) => c.key === 'pore').score, 41, 'first entry wins');
  assert.ok(!Number.isNaN(Date.parse(s.takenAt)));
  assert.equal(sanitizeScan({ concerns: [{ key: 'pore', score: 50 }] }), null, 'needs at least 3 concerns');
  const clamped = sanitizeScan({ concerns: [{ key: 'pore', score: 140 }, { key: 'acne', score: -3 }, { key: 'texture', score: 50.6 }] });
  assert.deepEqual(clamped.concerns.map((c) => [c.key, c.score]), [['pore', 100], ['texture', 51], ['acne', 1]], 'clamped and in catalogue order');
});

test('unit cost tiers and action lists follow the docs', () => {
  assert.equal(estimateUnits('sd', 4), 9);
  assert.equal(estimateUnits('hd', 4), 12);
  assert.equal(estimateUnits('sd', 8), 12);
  assert.equal(estimateUnits('hd', 12), 20);
  assert.equal(estimateUnits('hd', 15), 22);
  assert.equal(estimateUnits('sd', 16), 16);
  assert.equal(actionsFor('hd').length, 15);
  assert.ok(actionsFor('sd').includes('dark_circle_v2'));
  assert.ok(!actionsFor('hd').includes('hd_skin_type'));
  assert.equal(new Set(CONCERNS.map((c) => c.noun)).size, 15);
  assert.equal(band(85).label, 'Excellent');
  assert.equal(band(39).label, 'Needs attention');
});
