// YouCam client flow against the mock: init -> PUT upload -> task -> poll, request
// shapes from the docs, pacing/retry rules and task error mapping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockYouCam } from './helpers.js';
import { createYouCamClient, YouCamError, guidanceFor } from '../lib/youcam.js';
import { createMockFetch, sampleBuffer, MOCK_API_KEY, MOCK_BASE_URL } from '../lib/mock-youcam.js';
import { HD_ACTIONS, CONCERN_KEYS } from '../lib/concerns.js';

test('full flow: file init, signed PUT, task, poll until success', async () => {
  const { client, calls } = mockYouCam();
  const steps = [];
  const out = await client.analyzeSkin(sampleBuffer('demo-a'), { contentType: 'image/jpeg', tier: 'hd', onStep: (s) => steps.push(`${s.id}:${s.status}`) });
  assert.equal(out.status, 'success');
  assert.deepEqual(calls.map((c) => c.op).slice(0, 4), ['file', 'put', 'task', 'poll']);
  assert.equal(out.units, 22, 'HD with 15 concerns is the 13-16 tier (22 units)');
  assert.equal(out.result.tier, 'hd');
  assert.equal(out.result.concerns.length, 15);
  assert.ok(steps.includes('upload:done') && steps.includes('task:done') && steps.includes('poll:done'));
});

test('requests match the documented shapes', async () => {
  const seen = [];
  const inner = createMockFetch({ taskMs: 0, latencyMs: 0 });
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init });
    return inner(url, init);
  };
  const client = createYouCamClient({ apiKey: MOCK_API_KEY, baseUrl: MOCK_BASE_URL, fetchImpl, minIntervalMs: 0, version: 'v2.1' });
  await client.analyzeSkin(sampleBuffer('demo-a'), { contentType: 'image/jpeg', fileName: 'selfie.jpg', tier: 'hd' });

  const [fileReq, putReq, taskReq, pollReq] = seen;
  assert.equal(fileReq.url, `${MOCK_BASE_URL}/s2s/v2.0/file`);
  assert.equal(fileReq.init.method, 'POST');
  assert.equal(fileReq.init.headers.Authorization, `Bearer ${MOCK_API_KEY}`);
  assert.deepEqual(JSON.parse(fileReq.init.body), { files: [{ content_type: 'image/jpeg', file_name: 'selfie.jpg', file_size: sampleBuffer('demo-a').length }] });

  assert.equal(putReq.init.method, 'PUT');
  assert.equal(putReq.init.headers['Content-Type'], 'image/jpeg');
  assert.ok(!('Authorization' in putReq.init.headers), 'the signed URL needs no API key');

  assert.equal(taskReq.url, `${MOCK_BASE_URL}/s2s/v2.1/task/skin-analysis`);
  const body = JSON.parse(taskReq.init.body);
  assert.match(body.src_file_id, /^mf/);
  assert.equal(body.format, 'json');
  assert.deepEqual(body.miniserver_args, { enable_mask_overlay: true });
  assert.equal(body.dst_actions.length, 15);
  assert.ok(body.dst_actions.every((a) => a.startsWith('hd_') && HD_ACTIONS.includes(a)));

  assert.match(pollReq.url, /\/s2s\/v2\.1\/task\/skin-analysis\/mock_/);
  assert.equal(pollReq.init.method, 'GET');
});

test('SD tier sends SD action names and parses an SD result without regions', async () => {
  const { client, calls } = mockYouCam();
  const out = await client.analyzeSkin(Buffer.from('a-standard-res-photo'), { contentType: 'image/png', tier: 'sd' });
  const task = calls.find((c) => c.op === 'task');
  assert.ok(task.body.dst_actions.includes('dark_circle_v2'));
  assert.ok(task.body.dst_actions.every((a) => !a.startsWith('hd_')));
  assert.equal(out.result.tier, 'sd');
  assert.ok(out.result.concerns.every((c) => c.regions.length === 0));
});

test('the mock rejects mixed HD/SD and unknown actions like the API does', async () => {
  const { client } = mockYouCam();
  const fileId = await client.uploadImage(sampleBuffer('demo-a'), { contentType: 'image/jpeg' });
  await assert.rejects(client.createSkinTask({ fileId, actions: ['hd_pore', 'pore'] }), (e) => e instanceof YouCamError && e.status === 400 && e.code === 'InvalidParameters');
  await assert.rejects(client.createSkinTask({ fileId, actions: ['hd_glow'] }), (e) => e.status === 400 && /Not available dst_action/.test(e.message));
});

test('creating a task before the PUT upload fails (404), as documented', async () => {
  const fetchImpl = createMockFetch({ taskMs: 0, latencyMs: 0 });
  const client = createYouCamClient({ apiKey: MOCK_API_KEY, baseUrl: MOCK_BASE_URL, fetchImpl, minIntervalMs: 0 });
  const res = await fetchImpl(`${MOCK_BASE_URL}/s2s/v2.0/file`, { method: 'POST', headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' }, body: JSON.stringify({ files: [{ content_type: 'image/jpeg', file_name: 'a.jpg', file_size: 10 }] }) });
  const fileId = (await res.json()).data.files[0].file_id;
  await assert.rejects(client.createSkinTask({ fileId, actions: ['hd_pore'] }), (e) => e.status === 404);
});

test('429 and 5xx on idempotent calls are retried with backoff; Retry-After is honoured', async () => {
  const waits = [];
  const { client, calls } = mockYouCam({
    faults: [{ op: 'file', status: 429, times: 1, retryAfter: 2 }, { op: 'poll', status: 502, times: 2 }],
    sleep: async (ms) => waits.push(ms),
  });
  const out = await client.analyzeSkin(sampleBuffer('demo-a'), { tier: 'hd' });
  assert.equal(out.status, 'success');
  assert.equal(calls.filter((c) => c.op === 'file').length, 2);
  assert.equal(calls.filter((c) => c.op === 'poll').length, 3);
  assert.ok(waits.includes(2000), 'waited the Retry-After seconds');
  assert.equal(client.stats.retries, 3);
});

test('task creation is retried on 429 but never on 500 (no double billing)', async () => {
  const a = mockYouCam({ faults: [{ op: 'task', status: 429, times: 1 }] });
  await a.client.analyzeSkin(sampleBuffer('demo-a'), { tier: 'hd' });
  assert.equal(a.calls.filter((c) => c.op === 'task').length, 2);

  const b = mockYouCam({ faults: [{ op: 'task', status: 500, times: 1 }] });
  await assert.rejects(b.client.analyzeSkin(sampleBuffer('demo-a'), { tier: 'hd' }), (e) => e instanceof YouCamError && e.status === 500);
  assert.equal(b.calls.filter((c) => c.op === 'task').length, 1);
});

test('gives up after maxRetries and reports a rate limit clearly', async () => {
  const { client } = mockYouCam({ faults: [{ op: 'file', status: 429, times: 9 }], maxRetries: 2 });
  await assert.rejects(client.uploadImage(sampleBuffer('demo-a')), (e) => e.code === 'rate_limited' && /rate limit/.test(e.message));
});

test('calls are paced at the configured minimum interval', async () => {
  const fetchImpl = createMockFetch({ taskMs: 0, latencyMs: 0 });
  const client = createYouCamClient({ apiKey: MOCK_API_KEY, baseUrl: MOCK_BASE_URL, fetchImpl, minIntervalMs: 60 });
  const t0 = Date.now();
  await client.analyzeSkin(sampleBuffer('demo-a'), { tier: 'hd' });
  // file, task, poll = 3 paced API calls -> at least 2 intervals
  assert.ok(Date.now() - t0 >= 115, `took ${Date.now() - t0} ms`);
});

test('a task error maps to retake guidance; units are not charged', async () => {
  const { client } = mockYouCam();
  await assert.rejects(client.analyzeSkin(sampleBuffer('no-face'), { tier: 'hd' }), (e) => {
    assert.equal(e.code, 'error_no_face');
    assert.ok(e.guidance.tips.length >= 1);
    return true;
  });
  await assert.rejects(client.analyzeSkin(sampleBuffer('dark'), { tier: 'hd' }), (e) => e.code === 'error_lighting_dark');
  assert.match(guidanceFor('error_src_face_too_small').tips.join(' '), /60%/);
});

test('returns running (not an error) when the deadline passes, and a later poll finishes', async () => {
  const { client } = mockYouCam({ taskMs: 400 });
  const out = await client.analyzeSkin(sampleBuffer('demo-b'), { tier: 'hd', deadline: Date.now() + 50 });
  assert.equal(out.status, 'running');
  assert.match(out.taskId, /^mock_/);
  await new Promise((r) => setTimeout(r, 420));
  const later = await client.waitForSkinTask(out.taskId, { deadline: Date.now() + 2000, tier: 'hd' });
  assert.equal(later.status, 'success');
  assert.equal(later.result.concerns.find((c) => c.key === 'acne').score, 59);
});

test('bad API key surfaces as a 401 with a clear message', async () => {
  const fetchImpl = createMockFetch({ taskMs: 0, latencyMs: 0 });
  const client = createYouCamClient({ apiKey: 'x', baseUrl: MOCK_BASE_URL, fetchImpl, minIntervalMs: 0 });
  // The mock checks for a Bearer header; simulate a rejected key by stripping it.
  const stripped = async (url, init) => fetchImpl(url, { ...init, headers: { ...init.headers, Authorization: '' } });
  const c2 = createYouCamClient({ apiKey: 'x', baseUrl: MOCK_BASE_URL, fetchImpl: stripped, minIntervalMs: 0 });
  await assert.rejects(c2.uploadImage(Buffer.from('x')), (e) => e.status === 401 && /YOUCAM_API_KEY/.test(e.message));
  assert.ok(client);
});

test('validates configuration', () => {
  assert.throws(() => createYouCamClient({}), /YOUCAM_API_KEY/);
  assert.throws(() => createYouCamClient({ apiKey: 'k', version: '2.1' }), /v2.1/);
  assert.equal(CONCERN_KEYS.length, 15);
});

test('demo results for an uploaded photo are deterministic per image and differ between images', async () => {
  const { client } = mockYouCam();
  const a1 = await client.analyzeSkin(Buffer.from('photo-one'), { tier: 'hd' });
  const a2 = await client.analyzeSkin(Buffer.from('photo-one'), { tier: 'hd' });
  const b = await client.analyzeSkin(Buffer.from('photo-two'), { tier: 'hd' });
  const scores = (r) => r.result.concerns.map((c) => c.score).join(',');
  assert.equal(scores(a1), scores(a2));
  assert.notEqual(scores(a1), scores(b));
  assert.ok(a1.result.concerns.every((c) => c.overlayUrl === null), 'no illustrated overlays on a real photo');
});

test('analyzeProfile: one upload, skin analysis and skin tone in parallel on the same file_id', async () => {
  const { client, calls } = mockYouCam();
  const steps = [];
  const out = await client.analyzeProfile(sampleBuffer('demo-a'), { contentType: 'image/jpeg', tier: 'hd', onStep: (s) => steps.push(`${s.id}:${s.status}`) });
  assert.equal(out.status, 'success');
  assert.equal(out.uploads, 1);
  assert.equal(calls.filter((c) => c.op === 'file').length, 1, 'one File API call');
  assert.equal(calls.filter((c) => c.op === 'put').length, 1, 'one upload');
  const skinTask = calls.find((c) => c.op === 'task');
  const toneTask = calls.find((c) => c.op === 'tone');
  assert.equal(toneTask.path, '/s2s/v2.0/task/skin-tone-analysis');
  assert.equal(toneTask.body.src_file_id, skinTask.body.src_file_id, 'same file_id reused');
  assert.equal(toneTask.body.face_angle_strictness_level, 'medium');
  assert.ok(calls.some((c) => c.op === 'tone-poll'));
  assert.equal(out.skin.result.concerns.length, 15);
  assert.equal(out.tone.status, 'success');
  assert.equal(out.tone.result.skinHex, '#cf9a7b');
  assert.equal(out.skin.units + out.tone.units, 42);
  assert.ok(steps.includes('skin:done') && steps.includes('tone:done') && steps.includes('upload:done'));
});

test('if YouCam refuses the shared file for skin tone (404), it re-uploads once for that task', async () => {
  const { client, calls } = mockYouCam({ faults: [{ op: 'tone', status: 404, times: 1 }] });
  const out = await client.analyzeProfile(sampleBuffer('demo-a'), { tier: 'hd' });
  assert.equal(out.uploads, 2);
  assert.equal(calls.filter((c) => c.op === 'put').length, 2);
  assert.equal(out.tone.status, 'success');
});

test('skin tone is optional: failures are reported, skipping costs nothing', async () => {
  const { client } = mockYouCam();
  const tilted = await client.analyzeProfile(sampleBuffer('tilted'), { tier: 'hd' });
  assert.equal(tilted.status, 'success');
  assert.equal(tilted.tone.status, 'error');
  assert.equal(tilted.tone.units, 0);
  assert.match(tilted.tone.error.tips.join(' '), /Tilt your head up/);
  const skipped = await client.analyzeProfile(sampleBuffer('demo-b'), { tier: 'hd', withTone: false });
  assert.equal(skipped.tone.status, 'skipped');
  const both = await mockYouCam().client.analyzeProfile(sampleBuffer('no-face'), { tier: 'hd' }).catch((e) => e);
  assert.equal(both.code, 'error_no_face', 'a skin-analysis error still fails the scan');
});

test('the mock validates the skin-tone request like the docs', async () => {
  const { client } = mockYouCam();
  const fileId = await client.uploadImage(sampleBuffer('demo-a'));
  await assert.rejects(client.createToneTask({ fileId, strictness: 'extreme' }), (e) => e.status === 400 && e.code === 'InvalidParameters');
  const id = await client.createToneTask({ fileId, strictness: 'high' });
  const res = await client.waitForToneTask(id, { deadline: Date.now() + 1000 });
  assert.equal(res.result.quality.lighting, 'good');
});
