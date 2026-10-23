// Progress deltas between two scans (shared by browser and server).
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareScans, STEADY_BAND } from '../public/shared/progress.js';
import { sampleScan } from './helpers.js';

test('per-concern deltas between the two demo scans', () => {
  const p = compareScans(sampleScan('demo-a'), sampleScan('demo-b'));
  assert.equal(p.days, 56);
  assert.equal(p.items.length, 15);
  const acne = p.items.find((i) => i.key === 'acne');
  assert.deepEqual([acne.before, acne.after, acne.delta, acne.direction], [47, 59, 12, 'up']);
  assert.equal(p.items[0].key, 'acne', 'sorted by biggest gain');
  assert.equal(p.items.find((i) => i.key === 'moisture').direction, 'down');
  assert.equal(p.items.find((i) => i.key === 'dark_circle').direction, 'steady', `-2 is inside the ±${STEADY_BAND} band`);
  assert.equal(p.improved + p.declined + p.steady, 15);
  assert.deepEqual([p.improved, p.declined, p.steady], [6, 1, 8]);
  assert.deepEqual(p.overall, { before: 60, after: 63, delta: 3 });
  assert.match(p.summary, /^6 improved, 1 dropped and 8 held steady over 56 days\. Biggest gain: breakouts, 47 to 59\./);
});

test('only shared concerns are compared, and mismatched tiers are flagged', () => {
  const a = { takenAt: '2026-01-01T00:00:00Z', tier: 'hd', concerns: [{ key: 'pore', label: 'Pores', score: 40 }, { key: 'acne', label: 'Breakouts', score: 50 }] };
  const b = { takenAt: '2026-01-01T12:00:00Z', tier: 'sd', concerns: [{ key: 'pore', label: 'Pores', score: 44 }] };
  const p = compareScans(a, b);
  assert.equal(p.items.length, 1);
  assert.equal(p.days, 1);
  assert.ok(p.notes.some((n) => /HD/.test(n)));
  assert.equal(compareScans(a, { concerns: [] }).summary, 'These scans share no concerns to compare.');
});
