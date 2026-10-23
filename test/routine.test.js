// Knowledge mapping and the routine engine, checked across every combination of
// preferences: limits, layering rules, safety exclusions and grounding.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleScan } from './helpers.js';
import * as R from '../lib/routine.js';
import { CONCERNS, CONCERN_KEYS } from '../lib/concerns.js';
import { INGREDIENTS, INGREDIENT_BY_ID, PROFESSIONAL, EXPLAIN, GOALS, BASE, TIMES, BUDGETS } from '../lib/knowledge.js';
import { createDemoYouCam } from '../lib/agent.js';
import { sampleBuffer } from '../lib/mock-youcam.js';
import { toneFromHex } from '../lib/tone.js';

test('knowledge covers every measured concern', () => {
  for (const c of CONCERNS) {
    assert.ok(EXPLAIN[c.key]?.what && EXPLAIN[c.key]?.focus, `EXPLAIN.${c.key}`);
    assert.ok(PROFESSIONAL[c.key]?.categories?.length, `PROFESSIONAL.${c.key}`);
    assert.ok(PROFESSIONAL[c.key].threshold > 0 && PROFESSIONAL[c.key].threshold < 70);
  }
  for (const g of Object.values(GOALS)) for (const k of g.concerns) assert.ok(CONCERN_KEYS.includes(k), `goal concern ${k}`);
  for (const i of INGREDIENTS) for (const k of Object.keys(i.fit)) assert.ok(CONCERN_KEYS.includes(k), `${i.id} fits unknown ${k}`);
  for (const b of Object.values(BASE)) for (const k of b.cites) assert.ok(CONCERN_KEYS.includes(k), `${b.id} cites ${k}`);
  // At least one usable ingredient for every routine-actionable concern.
  for (const k of ['acne', 'pore', 'oiliness', 'texture', 'redness', 'moisture', 'radiance', 'wrinkle', 'firmness', 'age_spot', 'dark_circle', 'eye_bag']) {
    assert.ok(INGREDIENTS.some((i) => (i.fit[k] || 0) >= 0.5), `ingredient for ${k}`);
  }
});

test('knowledge text stays conservative: no brands, cures or guarantees', () => {
  const text = JSON.stringify({ INGREDIENTS, PROFESSIONAL, EXPLAIN: Object.fromEntries(Object.entries(EXPLAIN).map(([k, v]) => [k, { what: v.what, focus: v.focus }])), BASE });
  assert.doesNotMatch(text, /\b(cure|cures|guarantee|guaranteed|miracle|clinically proven)\b/i);
  assert.doesNotMatch(text, /®|™|\b(CeraVe|La Roche|Ordinary|Paula|Neutrogena|Olay|Differin|Botox|Juvederm)\b/i);
});

test('ranking weights goals up and structural eye concerns down', () => {
  const scan = sampleScan();
  const none = R.rankConcerns(scan, R.normalizePrefs({}));
  assert.equal(none[0].key, 'pore', 'lowest score leads without goals');
  const smoother = R.rankConcerns(scan, R.normalizePrefs({ goals: ['smoother'] }));
  assert.ok(smoother.slice(0, 3).some((r) => r.key === 'wrinkle'));
  assert.ok(smoother.findIndex((r) => r.key === 'tear_trough') > smoother.findIndex((r) => r.key === 'wrinkle'));
  assert.equal(none.find((r) => r.key === 'pore').lowestRegion.region, 'nose');
});

test('candidates respect budget, sensitivity and pregnancy', () => {
  const scan = sampleScan();
  const c = R.candidatesFor(['wrinkle', 'acne'], R.normalizePrefs({ budget: 1, pregnant: true, sensitive: true }), scan);
  const retinoid = c.wrinkle.find((x) => x.id === 'retinoid');
  assert.ok(retinoid.excluded);
  assert.ok(c.acne.find((x) => x.id === 'salicylic_acid').excluded, 'BHA left out in pregnancy');
  assert.ok(c.acne.find((x) => x.id === 'benzoyl_peroxide').excluded, 'irritating for sensitive skin');
  assert.ok(c.acne.some((x) => x.id === 'niacinamide' && !x.excluded));
});

// Exhaustive sweep of preference combinations against both demo scans and a photo-derived scan.
const withTone = (scan, hex) => ({ ...scan, tone: toneFromHex(hex) });
const SCANS = [sampleScan('demo-a'), sampleScan('demo-b'), withTone(sampleScan('demo-a'), '#e2b79c'), withTone(sampleScan('demo-b'), '#8d5a3c'), withTone(sampleScan('demo-a'), '#5c3a28')];
const GOAL_SETS = [[], ['breakouts'], ['even_tone', 'glow'], ['smoother', 'eyes'], ['hydration', 'breakouts', 'smoother']];
const combos = [];
for (const scan of SCANS) for (const goals of GOAL_SETS) for (const budget of [1, 2, 3]) for (const time of Object.keys(TIMES)) for (const sensitive of [false, true]) for (const pregnant of [false, true]) for (const skinType of ['oily', 'dry', 'unsure']) combos.push({ scan, prefs: R.normalizePrefs({ goals, budget, time, sensitive, pregnant, skinType }) });

test(`every plan across ${combos.length} preference combinations obeys the rules and is grounded`, () => {
  for (const { scan, prefs } of combos) {
    const label = JSON.stringify(prefs);
    const focus = R.pickFocus(R.rankConcerns(scan, prefs));
    const ids = R.chooseActives(focus, prefs, scan);
    assert.ok(ids.length <= BUDGETS[prefs.budget].maxActives, `budget ${label}`);
    const plan = R.assemblePlan({ scan, prefs, focusKeys: focus, activeIds: ids });
    const { am, pm } = plan.routine;
    assert.deepEqual(plan.grounding.problems, [], label);
    assert.equal(plan.focus.length, 3);
    // Sunscreen every morning, last step.
    assert.equal(am[am.length - 1].slot, 'protect', `SPF last ${label}`);
    // Time limits (alternating evening actives share one slot).
    const pmCount = pm.length - Math.max(0, pm.filter((s) => s.alternates).length - 1);
    assert.ok(am.length <= TIMES[prefs.time].am && pmCount <= TIMES[prefs.time].pm, `time ${label}`);
    // Never two strong actives on the same evening.
    const strongNightly = pm.filter((s) => INGREDIENT_BY_ID[s.id]?.strong && !s.alternates);
    assert.ok(strongNightly.length <= 1, `layering ${label}`);
    // Safety exclusions.
    const used = [...am, ...pm].filter((s) => s.kind === 'active').map((s) => INGREDIENT_BY_ID[s.id]);
    if (prefs.pregnant) assert.ok(used.every((i) => i.pregnancy !== 'avoid'), `pregnancy ${label}`);
    if (prefs.sensitive) assert.ok(used.every((i) => i.irritation < 2), `sensitive ${label}`);
    assert.ok(used.every((i) => i.cost <= BUDGETS[prefs.budget].maxCost), `cost ${label}`);
    // Retinoids only in the evening, vitamin C only in the morning.
    assert.ok(!am.some((s) => s.id === 'retinoid' || s.id === 'retinol_gentle'));
    assert.ok(!pm.some((s) => s.id === 'vitamin_c'));
    // Every step's citation sentence matches the format the brief asks for.
    for (const s of [...am, ...pm]) assert.match(s.because, /^because your [a-z ]+ score is \d{1,3}\/100( and your [a-z ]+ score is \d{1,3}\/100)?$/);
    // Tone-aware sunscreen: tinted for medium-to-deep skin, and every tone mention cites the measured colour.
    const spf = am[am.length - 1];
    if (scan.tone && ['tan', 'brown', 'dark'].includes(scan.tone.depth)) assert.match(spf.name, /^Tinted/, `tinted SPF ${label}`);
    if (spf.toneCite) assert.equal(spf.toneCite.hex, scan.tone.skinHex);
    if (!scan.tone) assert.ok(!spf.toneCite && !plan.profile.tone);
    assert.ok(spf.finish, 'every sunscreen names a finish');
    assert.ok(plan.profile.notes.length >= 1);
    assert.ok(plan.routine.rampUp.at(-1).text.includes('Scan again'));
  }
});

test('buildRoutine reports what it changed', () => {
  const scan = sampleScan();
  const prefs = R.normalizePrefs({ budget: 1, time: 'quick', pregnant: true });
  const r = R.buildRoutine(['retinoid', 'niacinamide', 'not_real', 'vitamin_c', 'aha'], scan, prefs, ['pore', 'oiliness', 'acne']);
  assert.ok(r.issues.some((i) => /Retinoid was left out: above your budget|Retinoid was left out/.test(i)));
  assert.ok(r.issues.some((i) => /Unknown ingredient/.test(i)));
  assert.ok(r.issues.some((i) => /Essentials budget allows 1/.test(i)));
  assert.deepEqual(r.actives, ['niacinamide']);
  const alt = R.buildRoutine(['retinoid', 'salicylic_acid'], scan, R.normalizePrefs({ budget: 3, time: 'unhurried' }), ['wrinkle', 'pore']);
  assert.ok(alt.issues.some((i) => /alternate evenings/.test(i)));
  assert.deepEqual(alt.pm.filter((s) => s.alternates).map((s) => s.cadence), ['Mon, Wed, Fri evenings', 'Tue, Thu, Sat evenings']);
});

test('professional guidance uses thresholds and HD regions', () => {
  const scan = sampleScan();
  const pro = R.professionalGuidance(scan, R.normalizePrefs({}));
  assert.deepEqual(pro.items.map((i) => i.key), ['pore', 'acne']);
  assert.ok(pro.items.every((i) => i.because === `because your ${i.cites[0].noun} score is ${i.score}/100`));
  // A scan with deep crow's feet and smile lines gets region-specific categories.
  const lined = { ...scan, concerns: scan.concerns.map((c) => (c.key === 'wrinkle' ? { ...c, score: 40, regions: [{ region: 'crowfeet', label: "Crow's feet", score: 35 }, { region: 'nasolabial', label: 'Smile lines', score: 45 }] } : c)) };
  const p2 = R.professionalGuidance(lined, R.normalizePrefs({}));
  const w = p2.items.find((i) => i.key === 'wrinkle');
  const names = w.categories.map((c) => c.name);
  assert.ok(names.includes('Neuromodulator injections') && names.includes('Dermal fillers'));
  assert.ok(w.regionCites.some((r) => r.because.includes('35/100')));
  assert.ok(pro.redFlags.length >= 2);
});

test('safeText drops model text with invented numbers or medical claims', () => {
  assert.equal(R.safeText('Your pores score is 41/100 so we start gently.', [41]), 'Your pores score is 41/100 so we start gently.');
  assert.equal(R.safeText('Your pores score is 12/100.', [41]), '');
  assert.equal(R.safeText('This will cure your acne.', [41]), '');
  assert.equal(R.safeText('See https://example.com for more', [41]), 'See for more');
});

test('grounding check catches a wrong or missing citation', () => {
  const scan = sampleScan();
  const prefs = R.normalizePrefs({ goals: ['breakouts'] });
  const plan = R.assemblePlan({ scan, prefs, focusKeys: ['pore', 'oiliness', 'acne'], activeIds: ['niacinamide'] });
  assert.deepEqual(plan.grounding.problems, []);
  const bad = structuredClone(plan);
  bad.routine.am[1].cites[0].score = 99;
  bad.routine.pm[0].cites = [];
  bad.focus[0].explanation = 'Your pores are 12/100.';
  const problems = R.checkGrounding(bad, scan);
  assert.ok(problems.some((p) => /scan says 41/.test(p)));
  assert.ok(problems.some((p) => /no citation/.test(p)));
  assert.ok(problems.some((p) => /mentions 12\/100/.test(p)));
});

test('a photo-derived demo scan (SD tier) also plans cleanly', async () => {
  const yc = createDemoYouCam({ MOCK_TASK_MS: '0', MOCK_LATENCY_MS: '0' });
  const out = await yc.analyzeSkin(Buffer.from('some other photo bytes'), { tier: 'sd' });
  const scan = { ...out.result, takenAt: new Date().toISOString() };
  const prefs = R.normalizePrefs({ goals: ['glow'] });
  const focus = R.pickFocus(R.rankConcerns(scan, prefs));
  const plan = R.assemblePlan({ scan, prefs, focusKeys: focus, activeIds: R.chooseActives(focus, prefs, scan) });
  assert.deepEqual(plan.grounding.problems, []);
  assert.ok(!plan.focus.some((f) => f.regionNote), 'no region notes without HD regions');
  void sampleBuffer;
});

test('skin tone personalises sunscreen, profile notes and procedure cautions', () => {
  const prefs = R.normalizePrefs({ goals: ['breakouts'], skinType: 'oily' });
  const deep = withTone(sampleScan(), '#8d5a3c');
  const plan = R.assemblePlan({ scan: deep, prefs, focusKeys: ['pore', 'oiliness', 'acne'], activeIds: ['niacinamide', 'azelaic_acid'] });
  const spf = plan.routine.am.at(-1);
  assert.equal(spf.id, 'sunscreen_tinted');
  assert.equal(spf.shade, 'Deep tint');
  assert.equal(spf.finish, 'Matte or gel-fluid finish');
  assert.match(spf.toneBecause, /#8d5a3c \(brown on the ITA skin-tone scale, -15°\)/);
  assert.match(spf.because, /oiliness score is 44\/100/, 'the finish cites the measured oil balance');
  assert.deepEqual(plan.profile.notes.map((n) => n.id), ['spf', 'pih', 'redness']);
  assert.ok(plan.professional.items.every((i) => i.toneNote && i.toneCite.hex === '#8d5a3c'), 'laser/peel caution on deeper skin');
  assert.deepEqual(plan.grounding.problems, []);

  const light = withTone(sampleScan('demo-b'), '#f1d3c0');
  const lp = R.assemblePlan({ scan: light, prefs: R.normalizePrefs({ skinType: 'dry' }), focusKeys: ['pore', 'oiliness', 'acne'], activeIds: [] });
  assert.ok(lp.profile.notes.some((n) => n.id === 'burn'));
  assert.ok(!lp.professional.items.some((i) => i.toneNote));
  assert.equal(lp.routine.am.at(-1).id, 'sunscreen_tinted', 'spots score 68 < 70 still suggests visible-light protection');
  assert.equal(lp.routine.am.at(-1).shade, 'Light tint');

  const none = R.assemblePlan({ scan: sampleScan(), prefs, focusKeys: ['pore', 'oiliness', 'acne'], activeIds: [] });
  assert.equal(none.profile.toneStatus, 'not_measured');
  assert.equal(none.routine.am.at(-1).id, 'sunscreen');
});

test('medium-to-deep skin with breakouts in focus favours gentle, tone-evening actives', () => {
  const prefs = R.normalizePrefs({ goals: ['breakouts', 'even_tone'], budget: 3, time: 'unhurried' });
  const focus = ['pore', 'acne', 'age_spot'];
  const light = R.chooseActives(focus, prefs, withTone(sampleScan(), '#e2b79c'));
  const deep = R.chooseActives(focus, prefs, withTone(sampleScan(), '#5c3a28'));
  assert.ok(deep.includes('azelaic_acid'), deep.join(','));
  assert.ok(!deep.includes('aha'));
  assert.ok(light.length >= 1);
});

test('grounding catches a wrong skin-colour citation', () => {
  const scan = withTone(sampleScan(), '#c99a7b');
  const plan = R.assemblePlan({ scan, prefs: R.normalizePrefs({}), focusKeys: ['pore', 'oiliness', 'acne'], activeIds: ['niacinamide'] });
  assert.deepEqual(plan.grounding.problems, []);
  const bad = structuredClone(plan);
  bad.routine.am.at(-1).toneCite.hex = '#ffffff';
  bad.profile.notes[0].toneBecause = 'because it looked nice';
  const problems = R.checkGrounding(bad, scan);
  assert.ok(problems.some((p) => /cites skin colour #ffffff/.test(p)));
  assert.ok(problems.some((p) => /tone citation text missing/.test(p)));
  const noTone = R.checkGrounding(plan, sampleScan());
  assert.ok(noTone.some((p) => /none was measured/.test(p)));
});
