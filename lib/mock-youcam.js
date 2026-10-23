/**
 * Demo-mode stand-in for the YouCam API. It is a `fetch` implementation that
 * answers the same four calls the real flow makes, with the same request
 * validation and response shapes, so lib/youcam.js runs unchanged on top of it:
 *
 *   POST {base}/s2s/v2.0/file                   -> file_id + signed PUT request
 *   PUT  https://upload.demo.youcam.invalid/... -> 200 (checks Content-Type/Length)
 *   POST {base}/s2s/v2.x/task/skin-analysis     -> task_id (rejects mixed HD/SD or unknown actions)
 *   GET  {base}/s2s/v2.x/task/skin-analysis/:id -> running ... then success / error
 *   POST {base}/s2s/v2.0/task/skin-tone-analysis     -> task_id (same uploaded file_id)
 *   GET  {base}/s2s/v2.0/task/skin-tone-analysis/:id -> face_quality + color
 *
 * Task ids are self-describing (fixture, seed, tier, ready time) so a poll that
 * lands on a different serverless instance still gets the right answer.
 *
 * Results:
 *   - Samples (`sampleBuffer('demo-a' | 'demo-b' | 'no-face' | 'dark' | 'tilted')`) return
 *     the bundled synthetic fixtures in data/fixtures/ or a documented task error
 *     ('tilted' passes skin analysis but fails skin tone with a face-angle error).
 *   - Any other image returns illustrative scores derived from a hash of its bytes.
 *     They are NOT an analysis of the photo; the UI labels every demo result.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { HD_ACTIONS, SD_ACTIONS, CONCERNS } from './concerns.js';

export const MOCK_API_KEY = 'glowplan-demo-key';
export const MOCK_BASE_URL = 'https://demo.youcam.invalid';
const UPLOAD_HOST = 'https://upload.demo.youcam.invalid';
const SAMPLE_PREFIX = 'GLOWPLAN-SAMPLE:';
export const SAMPLES = ['demo-a', 'demo-b', 'no-face', 'dark', 'tilted'];
const TONE_STRICTNESS = ['strict', 'high', 'medium', 'low', 'flexible'];
/** Skin colours for illustrative photo results, one per ITA depth band (very light to dark). */
const PHOTO_SKIN = ['#f1d3c0', '#e2b79c', '#c99a7b', '#b5835f', '#8d5a3c', '#5c3a28'];
const PHOTO_EYES = [['#5b3a29', 'Brown'], ['#3b2a22', 'Brown'], ['#4f6b3a', 'Green'], ['#3f5f8f', 'Blue'], ['#7a5a2e', 'Amber']];

const fixtureCache = new Map();
export function loadFixture(name) {
  if (!fixtureCache.has(name)) {
    const file = new URL(`../data/fixtures/${name}.json`, import.meta.url);
    fixtureCache.set(name, JSON.parse(readFileSync(file, 'utf8')));
  }
  return structuredClone(fixtureCache.get(name));
}

/** The marker "image" the server uploads when someone picks a bundled sample. */
export function sampleBuffer(name) {
  if (!SAMPLES.includes(name)) throw new Error(`Unknown sample ${name}`);
  return Buffer.from(`${SAMPLE_PREFIX}${name}`);
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const b64u = (s) => Buffer.from(s).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url').toString('utf8');

/** Seeded pseudo-random in [0,1). */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}

/** Deterministic illustrative output for an arbitrary uploaded photo. */
function photoOutput(seedHex) {
  const base = loadFixture('demo-a').data.results.output;
  const rand = rng(parseInt(seedHex.slice(0, 8), 16));
  const shift = new Map();
  const output = base.map((item) => {
    if (!shift.has(item.type)) shift.set(item.type, Math.round((rand() - 0.5) * 30));
    const ui = Math.max(18, Math.min(94, item.ui_score + shift.get(item.type) + Math.round((rand() - 0.5) * 6)));
    return { ...item, ui_score: ui, raw_score: Math.round((ui - 5.2) * 100) / 100, mask_urls: [] };
  });
  const overall = Math.round((output.filter((o) => !o.region || o.region === 'whole').reduce((s, o) => s + o.ui_score, 0) / 15) * 100) / 100;
  return output.map((o) => ({ ...o, score: overall }));
}

const HD_TO_SD = Object.fromEntries(CONCERNS.map((c) => [c.hd, c.sd]));

/** Keep only requested actions; SD results drop regions and use SD names. */
function shapeOutput(output, actions) {
  const sd = !actions[0].startsWith('hd_');
  const wanted = new Set(actions);
  const res = [];
  for (const item of output) {
    const type = sd ? HD_TO_SD[item.type] : item.type;
    if (!wanted.has(type)) continue;
    if (sd) {
      if (item.region && item.region !== 'whole') continue;
      const { region, ...rest } = item;
      res.push({ ...rest, type, mask_urls: rest.mask_urls.map((u) => u.replace(item.type, type)) });
    } else {
      res.push(item);
    }
  }
  return res;
}

/**
 * @param {object} [o]
 * @param {number} [o.taskMs]     how long a task stays "running" (default 1500)
 * @param {number} [o.latencyMs]  per-request latency (default 40)
 * @param {Array<{op:'file'|'put'|'task'|'poll', status:number, times:number, retryAfter?:number}>} [o.faults]
 *        inject HTTP errors (for retry tests)
 * @param {Function} [o.now]
 */
export function createMockFetch({ taskMs = 1500, latencyMs = 40, faults = [], now = Date.now } = {}) {
  const uploads = new Map(); // file_id -> { contentType, size, uploaded, hash, sample }
  const calls = [];
  const pending = faults.map((f) => ({ ...f }));

  const injected = (op) => {
    const f = pending.find((x) => x.op === op && x.times > 0);
    if (!f) return null;
    f.times -= 1;
    return json(f.status, { status: f.status, error: f.status === 429 ? 'Too many requests' : 'Service unavailable' }, f.retryAfter ? { 'Retry-After': String(f.retryAfter) } : {});
  };

  async function mockFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = String(init.method || 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

    // --- Signed upload URL (S3-style PUT) ---
    if (url.origin === UPLOAD_HOST) {
      calls.push({ op: 'put', method, path: url.pathname });
      const fault = injected('put');
      if (fault) return fault;
      if (method !== 'PUT') return new Response('Method not allowed', { status: 405 });
      const fileId = decodeURIComponent(url.pathname.split('/').pop());
      const meta = uploads.get(fileId);
      if (!meta) return new Response('<Error>NoSuchUpload</Error>', { status: 404 });
      const body = Buffer.isBuffer(init.body) ? init.body : Buffer.from(init.body ? new Uint8Array(await new Response(init.body).arrayBuffer()) : []);
      if (headers['content-type'] !== meta.contentType) return new Response('<Error>SignatureDoesNotMatch</Error>', { status: 403 });
      if (headers['content-length'] && Number(headers['content-length']) !== body.length) return new Response('<Error>IncompleteBody</Error>', { status: 400 });
      if (body.length !== meta.size) return new Response('<Error>IncompleteBody</Error>', { status: 400 });
      const text = body.subarray(0, 64).toString('latin1');
      meta.sample = text.startsWith(SAMPLE_PREFIX) ? text.slice(SAMPLE_PREFIX.length) : null;
      meta.hash = createHash('sha256').update(body).digest('hex');
      meta.uploaded = true;
      return new Response(null, { status: 200 });
    }

    if (url.origin !== MOCK_BASE_URL) throw new TypeError(`fetch failed (mock has no route for ${url.origin})`);
    if (!/^Bearer \S+/.test(headers.authorization || '')) return json(401, { status: 401, error: 'Invalid API key' });
    const body = init.body ? JSON.parse(init.body) : null;

    // --- File API ---
    if (method === 'POST' && url.pathname === '/s2s/v2.0/file') {
      calls.push({ op: 'file', method, path: url.pathname, body });
      const fault = injected('file');
      if (fault) return fault;
      const f = body?.files?.[0];
      if (!f || !['image/jpeg', 'image/png'].includes(f.content_type) || !(f.file_size > 0) || !f.file_name) {
        return json(400, { status: 400, error: 'Invalid files parameter', error_code: 'InvalidParameters' });
      }
      if (f.file_size > 10 * 1024 * 1024) return json(400, { status: 400, error: 'exceed_max_filesize', error_code: 'InvalidParameters' });
      const fileId = `mf${randomBytes(9).toString('base64url')}`;
      uploads.set(fileId, { contentType: f.content_type, size: f.file_size, uploaded: false });
      return json(200, {
        status: 200,
        data: {
          files: [{
            content_type: f.content_type,
            file_name: f.file_name,
            file_id: fileId,
            requests: [{ method: 'PUT', url: `${UPLOAD_HOST}/demo/ttl30/${encodeURIComponent(fileId)}`, headers: { 'Content-Type': f.content_type, 'Content-Length': String(f.file_size) } }],
          }],
        },
      });
    }

    // --- Skin Tone Analysis (create + poll) ---
    const tone = /^\/s2s\/v2\.0\/task\/skin-tone-analysis(?:\/([^/]+))?$/.exec(url.pathname);
    if (tone && method === 'POST' && !tone[1]) {
      calls.push({ op: 'tone', method, path: url.pathname, body });
      const fault = injected('tone');
      if (fault) return fault;
      const meta = uploads.get(body?.src_file_id);
      if (!meta || !meta.uploaded) return json(404, { status: 404, error: 'File not found. Upload the file to the URL from the File API first.' });
      if (body.face_angle_strictness_level !== undefined && !TONE_STRICTNESS.includes(body.face_angle_strictness_level)) {
        return json(400, { status: 400, error: 'Invalid face_angle_strictness_level', error_code: 'InvalidParameters' });
      }
      const info = { k: 'tone', f: meta.sample || 'photo', s: meta.hash.slice(0, 12), r: now() + taskMs };
      return json(200, { status: 200, data: { task_id: `mock_${b64u(JSON.stringify(info))}` } });
    }
    if (tone && method === 'GET' && tone[1]) {
      calls.push({ op: 'tone-poll', method, path: url.pathname });
      const fault = injected('tone-poll');
      if (fault) return fault;
      let info;
      try {
        info = JSON.parse(unb64u(decodeURIComponent(tone[1]).replace(/^mock_/, '')));
      } catch {
        return json(400, { status: 400, error: 'Invalid task ID' });
      }
      if (info.k !== 'tone') return json(400, { status: 400, error: 'Invalid task ID' });
      if (now() < info.r) return json(200, { status: 200, data: { task_status: 'running' } });
      if (info.f === 'no-face') return json(200, { status: 200, data: { task_status: 'error', error: 'error_no_face', error_message: 'No face detected in source image' } });
      if (info.f === 'tilted') return json(200, { status: 200, data: { task_status: 'error', error: 'error_face_angle_downward', error_message: 'Tilt head up slightly' } });
      const res = loadFixture('tone-demo');
      if (info.f === 'dark') res.data.results.face_quality.lighting = 'dark';
      if (info.f === 'photo') {
        const n = parseInt(info.s.slice(0, 8), 16);
        const [eye, eyeName] = PHOTO_EYES[n % PHOTO_EYES.length];
        Object.assign(res.data.results.color, { skin_color: PHOTO_SKIN[n % PHOTO_SKIN.length], eye_color: eye, eye_color_name: eyeName });
      }
      return json(200, res);
    }

    const task = /^\/s2s\/(v2\.[01])\/task\/skin-analysis(?:\/([^/]+))?$/.exec(url.pathname);
    // --- Create task ---
    if (task && method === 'POST' && !task[2]) {
      calls.push({ op: 'task', method, path: url.pathname, body });
      const fault = injected('task');
      if (fault) return fault;
      const meta = uploads.get(body?.src_file_id);
      if (!meta || !meta.uploaded) return json(404, { status: 404, error: 'File not found. Upload the file to the URL from the File API first.' });
      const actions = body.dst_actions;
      if (!Array.isArray(actions) || !actions.length) return json(400, { status: 400, error: 'dst_actions is required', error_code: 'InvalidParameters' });
      const unknown = actions.find((a) => !HD_ACTIONS.includes(a) && !SD_ACTIONS.includes(a));
      if (unknown) return json(400, { status: 400, error: `Not available dst_action ${unknown}`, error_code: 'InvalidParameters' });
      const hd = actions.filter((a) => a.startsWith('hd_')).length;
      if (hd && hd !== actions.length) return json(400, { status: 400, error: 'cannot mix HD and SD dst_actions', error_code: 'InvalidParameters' });
      // Compact, self-describing id: fixture, seed, tier + bitmask of actions, ready time.
      const list = hd ? HD_ACTIONS : SD_ACTIONS;
      const mask = actions.reduce((m, a) => m | (1 << list.indexOf(a)), 0);
      const info = { f: meta.sample || 'photo', s: meta.hash.slice(0, 12), t: hd ? 'hd' : 'sd', m: mask, r: now() + taskMs };
      return json(200, { status: 200, data: { task_id: `mock_${b64u(JSON.stringify(info))}` } });
    }

    // --- Poll task ---
    if (task && method === 'GET' && task[2]) {
      calls.push({ op: 'poll', method, path: url.pathname });
      const fault = injected('poll');
      if (fault) return fault;
      let info;
      try {
        info = JSON.parse(unb64u(decodeURIComponent(task[2]).replace(/^mock_/, '')));
      } catch {
        return json(400, { status: 400, error: 'Invalid task ID' });
      }
      if (now() < info.r) return json(200, { status: 200, data: { task_status: 'running' } });
      if (info.f === 'no-face') return json(200, { status: 200, data: { task_status: 'error', error: 'error_no_face', error_message: 'No face detected in source image' } });
      if (info.f === 'dark') return json(200, { status: 200, data: { task_status: 'error', error: 'error_lighting_dark', error_message: 'Lighting is too dark' } });
      const list = info.t === 'sd' ? SD_ACTIONS : HD_ACTIONS;
      const actions = list.filter((_, i) => info.m & (1 << i));
      if (info.k || !actions.length || (info.f !== 'photo' && !SAMPLES.includes(info.f))) return json(400, { status: 400, error: 'Invalid task ID' });
      const output = info.f === 'photo' ? photoOutput(info.s) : loadFixture(info.f === 'tilted' ? 'demo-a' : info.f).data.results.output;
      return json(200, { status: 200, data: { task_status: 'success', results: { output: shapeOutput(output, actions) } } });
    }

    return json(404, { status: 404, error: 'Not found' });
  }

  mockFetch.calls = calls;
  return mockFetch;
}

/** True for task ids minted by the mock (so a poll is always answered by the mock). */
export const isMockTaskId = (id) => typeof id === 'string' && id.startsWith('mock_');
