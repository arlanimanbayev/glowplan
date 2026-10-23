// HTTP handlers (the same code Vercel runs): streaming, validation, privacy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeReqRes, makePng, sampleScan } from './helpers.js';
import { handleAnalyze, handlePlan, handleHealth } from '../lib/http.js';
import { createDemoYouCam } from '../lib/agent.js';
import { sampleBuffer } from '../lib/mock-youcam.js';

test('GET /api/health reports demo mode without keys', async () => {
  const { req, res, out } = fakeReqRes({ url: '/api/health' });
  await handleHealth(req, res);
  assert.equal(out.status, 200);
  assert.deepEqual(out.json().mode, { youcam: 'demo', skinApiVersion: 'v2.1', agent: 'scripted', model: null });
});

test('POST /api/analyze with a sample streams steps then a scan', async () => {
  const { req, res, out } = fakeReqRes({ method: 'POST', url: '/api/analyze', headers: { accept: 'application/x-ndjson' }, body: { sample: 'demo-a' } });
  await handleAnalyze(req, res);
  const lines = out.lines();
  assert.equal(out.headers['content-type'], 'application/x-ndjson; charset=utf-8');
  const steps = lines.filter((l) => l.type === 'step').map((l) => `${l.step.id}:${l.step.status}`);
  for (const s of ['check:done', 'upload:done', 'skin:done', 'tone:done']) assert.ok(steps.includes(s), s);
  const titles = lines.filter((l) => l.type === 'step' && l.step.status === 'done').map((l) => l.step.title);
  assert.ok(titles.includes('Skin analysis') && titles.includes('Skin tone'));
  const result = lines.at(-1);
  assert.equal(result.type, 'result');
  assert.equal(result.status, 'success');
  assert.equal(result.scan.demo, true);
  assert.equal(result.scan.source, 'sample');
  assert.equal(result.scan.concerns.length, 15);
  assert.deepEqual(result.scan.units, { skin: 22, tone: 20, total: 42 });
  assert.equal(result.uploads, 1, 'both analyses ran on one upload');
  assert.equal(result.scan.toneStatus, 'measured');
  assert.equal(result.scan.tone.skinHex, '#cf9a7b');
  assert.equal(result.scan.tone.depth, 'intermediate');
});

test('POST /api/analyze with a photo (JSON base64) picks the tier from its size', async () => {
  const png = makePng(720, 960);
  const { req, res, out } = fakeReqRes({ method: 'POST', url: '/api/analyze', body: { image: `data:image/png;base64,${png.toString('base64')}`, fileName: 'me.png' } });
  await handleAnalyze(req, res);
  const body = out.json();
  assert.equal(out.status, 200);
  assert.equal(body.scan.tier, 'sd', '720 px short side is a standard scan');
  assert.equal(body.scan.source, 'demo');
  assert.ok(body.scan.concerns.every((c) => c.regions.length === 0));
});

test('POST /api/analyze accepts multipart uploads', async () => {
  const png = makePng(1080, 1440);
  const b = 'xyz';
  const body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="image"; filename="me.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${b}--\r\n`)]);
  const { req, res, out } = fakeReqRes({ method: 'POST', url: '/api/analyze', headers: { 'content-type': `multipart/form-data; boundary=${b}` }, body });
  await handleAnalyze(req, res);
  assert.equal(out.json().scan.tier, 'hd');
});

test('a too-small photo is refused before any YouCam call, with retake tips', async () => {
  const png = makePng(300, 400);
  const { req, res, out } = fakeReqRes({ method: 'POST', url: '/api/analyze', body: { image: png.toString('base64') } });
  await handleAnalyze(req, res);
  assert.equal(out.status, 400);
  const body = out.json();
  assert.equal(body.code, 'error_below_min_image_size');
  assert.ok(body.tips.length);
});

test('a YouCam task error streams as an error line with guidance', async () => {
  const { req, res, out } = fakeReqRes({ method: 'POST', url: '/api/analyze', headers: { accept: 'application/x-ndjson' }, body: { sample: 'no-face' } });
  await handleAnalyze(req, res);
  const last = out.lines().at(-1);
  assert.equal(last.type, 'error');
  assert.equal(last.code, 'error_no_face');
  assert.equal(last.status, 422);
  assert.ok(last.tips.length);
});

test('GET /api/analyze?task_id= continues a running task', async () => {
  const yc = createDemoYouCam({ MOCK_TASK_MS: '0', MOCK_LATENCY_MS: '0' });
  const fileId = await yc.uploadImage(sampleBuffer('demo-b'));
  const taskId = await yc.createSkinTask({ fileId, actions: ['hd_pore', 'hd_acne', 'hd_texture'] });
  const { req, res, out } = fakeReqRes({ url: `/api/analyze?task_id=${encodeURIComponent(taskId)}&tier=hd` });
  await handleAnalyze(req, res);
  const body = out.json();
  assert.equal(body.status, 'success');
  assert.deepEqual(body.scan.concerns.map((c) => c.key), ['pore', 'texture', 'acne']);
  const bad = fakeReqRes({ url: '/api/analyze?task_id=%3Cscript%3E' });
  await handleAnalyze(bad.req, bad.res);
  assert.equal(bad.out.status, 400);
});

test('POST /api/plan streams agent trace and a grounded plan; bad input is a 400', async () => {
  const scan = sampleScan();
  const { req, res, out } = fakeReqRes({ method: 'POST', url: '/api/plan', headers: { accept: 'application/x-ndjson' }, body: { scan, preferences: { goals: ['breakouts'] } } });
  await handlePlan(req, res);
  const lines = out.lines();
  assert.ok(lines.filter((l) => l.type === 'trace').length >= 5);
  const result = lines.at(-1);
  assert.equal(result.type, 'result');
  assert.deepEqual(result.plan.grounding.problems, []);

  const bad = fakeReqRes({ method: 'POST', url: '/api/plan', body: { scan: { concerns: [] } } });
  await handlePlan(bad.req, bad.res);
  assert.equal(bad.out.status, 400);
  const wrong = fakeReqRes({ method: 'GET', url: '/api/plan' });
  await handlePlan(wrong.req, wrong.res);
  assert.equal(wrong.out.status, 405);
});

test('privacy: the analyze path never logs request bodies', async () => {
  const logged = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a) => logged.push(a.join(' '));
  try {
    const png = makePng(500, 700);
    const { req, res } = fakeReqRes({ method: 'POST', url: '/api/analyze', body: { image: png.toString('base64') } });
    await handleAnalyze(req, res);
  } finally {
    Object.assign(console, orig);
  }
  assert.ok(!logged.some((l) => l.includes('base64') || l.length > 500));
});

test('tone can be skipped (reused profile) and SKIN_TONE_MODE=off disables it', async () => {
  const a = fakeReqRes({ method: 'POST', url: '/api/analyze', headers: { accept: 'application/x-ndjson' }, body: { sample: 'demo-b', tone: false } });
  await handleAnalyze(a.req, a.res);
  const lines = a.out.lines();
  assert.ok(lines.some((l) => l.type === 'step' && l.step.id === 'tone' && l.step.status === 'skipped'));
  const r = lines.at(-1);
  assert.equal(r.scan.toneStatus, 'skipped');
  assert.deepEqual(r.scan.units, { skin: 22, tone: 0, total: 22 });

  process.env.SKIN_TONE_MODE = 'off';
  try {
    const b = fakeReqRes({ method: 'POST', url: '/api/analyze', body: { sample: 'demo-a', tone: true } });
    await handleAnalyze(b.req, b.res);
    assert.equal(b.out.json().scan.toneStatus, 'skipped');
  } finally {
    delete process.env.SKIN_TONE_MODE;
  }
});

test('a skin-tone failure never blocks the skin scan', async () => {
  const { req, res, out } = fakeReqRes({ method: 'POST', url: '/api/analyze', headers: { accept: 'application/x-ndjson' }, body: { sample: 'tilted' } });
  await handleAnalyze(req, res);
  const lines = out.lines();
  const toneStep = lines.filter((l) => l.type === 'step' && l.step.id === 'tone').at(-1);
  assert.equal(toneStep.step.status, 'error');
  const r = lines.at(-1);
  assert.equal(r.status, 'success');
  assert.equal(r.scan.toneStatus, 'error');
  assert.match(r.scan.toneError, /tilted down/);
  assert.equal(r.scan.units.total, 22, 'failed tasks cost nothing');
});

test('GET /api/analyze?tone_task_id= fetches a late skin-tone result on its own', async () => {
  const yc = createDemoYouCam({ MOCK_TASK_MS: '0', MOCK_LATENCY_MS: '0' });
  const fileId = await yc.uploadImage(sampleBuffer('demo-a'));
  const toneTaskId = await yc.createToneTask({ fileId });
  const { req, res, out } = fakeReqRes({ url: `/api/analyze?tone_task_id=${encodeURIComponent(toneTaskId)}` });
  await handleAnalyze(req, res);
  const body = out.json();
  assert.equal(body.toneStatus, 'measured');
  assert.equal(body.tone.skinHex, '#cf9a7b');
});
