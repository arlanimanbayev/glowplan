// Skin Tone Analysis: result parsing, colour maths (CIELAB, ITA) and sanitising.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hexToLab, itaOf, depthOf, toneFromHex, parseToneResult, qualityIssues, sanitizeTone, toneCiteText, isDeeper } from '../lib/tone.js';
import { loadFixture } from '../lib/mock-youcam.js';

test('sRGB hex to CIELAB matches reference values', () => {
  assert.deepEqual(hexToLab('#ffffff'), { L: 100, a: 0, b: 0 });
  assert.deepEqual(hexToLab('#000000'), { L: 0, a: 0, b: 0 });
  const doc = hexToLab('#b9947c'); // the docs' example skin_color
  assert.ok(Math.abs(doc.L - 64.1) < 0.2 && Math.abs(doc.a - 10.4) < 0.2 && Math.abs(doc.b - 18) < 0.2, JSON.stringify(doc));
  assert.equal(hexToLab('not-a-colour'), null);
});

test('ITA degrees and depth bands (Chardon 1991 / Del Bino 2006)', () => {
  assert.equal(itaOf(hexToLab('#b9947c')), 38);
  const cases = [['#f1d3c0', 'very_light'], ['#e2b79c', 'light'], ['#c99a7b', 'intermediate'], ['#b5835f', 'tan'], ['#8d5a3c', 'brown'], ['#5c3a28', 'dark']];
  for (const [hex, depth] of cases) assert.equal(toneFromHex(hex).depth, depth, hex);
  assert.equal(depthOf(56).id, 'very_light');
  assert.equal(depthOf(55).id, 'light');
  assert.equal(depthOf(-31).id, 'dark');
  assert.equal(toneFromHex('#c99a7b').tint, 'medium');
  assert.ok(isDeeper(toneFromHex('#b5835f')) && !isDeeper(toneFromHex('#c99a7b')));
});

test('parses the documented GET response shape (results.color + results.face_quality)', () => {
  const t = parseToneResult(loadFixture('tone-demo'));
  assert.equal(t.skinHex, '#cf9a7b');
  assert.equal(t.eyeName, 'Brown');
  assert.equal(t.hairName, 'Black');
  assert.deepEqual(t.quality, { hasFace: true, area: 'good', frontal: 'good', lighting: 'good', faceangle: 'good' });
  assert.deepEqual(qualityIssues(t), []);
  // data / results / bare color all work; no colour -> null
  const fx = loadFixture('tone-demo');
  assert.equal(parseToneResult(fx.data).skinHex, '#cf9a7b');
  assert.equal(parseToneResult(fx.data.results.color).skinHex, '#cf9a7b');
  assert.equal(parseToneResult({ data: { results: {} } }), null);
  assert.ok(!('undertone' in t), 'no undertone is invented');
});

test('quality issues and server-side re-derivation of client data', () => {
  const t = toneFromHex('#cf9a7b', { quality: { lighting: 'dark', area: 'good' } });
  assert.deepEqual(qualityIssues(t), [{ key: 'lighting', label: 'lighting', value: 'dark' }]);
  const s = sanitizeTone({ skinHex: '#CF9A7B', ita: 80, depth: 'very_light', quality: { lighting: 'good', evil: '<x>' }, measuredAt: '2026-10-01T00:00:00Z', reused: true });
  assert.equal(s.skinHex, '#cf9a7b');
  assert.equal(s.ita, 37);
  assert.equal(s.depth, 'intermediate');
  assert.deepEqual(s.quality, { lighting: 'good' });
  assert.equal(s.reused, true);
  assert.equal(sanitizeTone({ skinHex: 'red' }), null);
  assert.equal(toneCiteText(s), 'YouCam measured your skin colour as #cf9a7b (intermediate on the ITA skin-tone scale, 37°)');
});
