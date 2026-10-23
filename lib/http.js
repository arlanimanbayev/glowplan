/**
 * HTTP glue shared by the Vercel functions in api/ and by dev-server.js.
 * Plain Node (req, res) only, so it runs the same in both places.
 *
 * Streaming: when the client sends `Accept: application/x-ndjson`, handlers
 * write one JSON object per line ({type:'step'|'trace'|'meta'}) and finish with
 * {type:'result'} or {type:'error'}; otherwise they return one JSON document.
 *
 * Privacy: photos are read into memory, forwarded to YouCam and dropped.
 * Nothing here writes images to disk or logs request bodies.
 */
import { randomUUID } from 'node:crypto';
import { depsFromEnv, modeInfo, planSkin, validatePlanInput } from './agent.js';
import { decodeImageString, inspectImage, parseMultipart, ImageError } from './image.js';
import { YouCamError, guidanceFor, TONE_UNITS } from './youcam.js';
import { sampleBuffer, isMockTaskId, SAMPLES } from './mock-youcam.js';
import { estimateUnits, CONCERN_KEYS } from './concerns.js';

/** Vercel rejects request bodies over 4.5 MB, so the decoded photo must stay below ~3.3 MB. */
export const MAX_BODY = 4_400_000;
export const MAX_IMAGE_BYTES = 3_300_000;

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

async function readRaw(req, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, 'The photo is too large. Use one under 3 MB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Reads a JSON body (or a pre-parsed Vercel body). */
export async function readJson(req, max = 256 * 1024) {
  try {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'string') return JSON.parse(req.body);
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
  const text = (await readRaw(req, max)).toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

// --- Rate limiting (per warm instance; protects the YouCam unit balance) -----
const windows = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const LIMITS = { analyze: 12, analyze_demo: 60, poll: 240, plan: 30 };

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.socket?.remoteAddress || 'unknown';
}

export function rateLimited(req, bucket, env = process.env) {
  if (env.RATE_LIMIT === 'off') return false;
  const key = `${bucket}:${clientIp(req)}`;
  const now = Date.now();
  const hits = (windows.get(key) || []).filter((t) => now - t < WINDOW_MS);
  const limit = Number(env[`RATE_LIMIT_${bucket.toUpperCase()}`]) || LIMITS[bucket];
  if (hits.length >= limit) {
    windows.set(key, hits);
    return true;
  }
  hits.push(now);
  windows.set(key, hits);
  if (windows.size > 5000) windows.delete(windows.keys().next().value);
  return false;
}

// --- Streaming ---------------------------------------------------------------
const wantsStream = (req) => String(req.headers.accept || '').includes('application/x-ndjson');

function errorBody(err) {
  if (err instanceof YouCamError && err.guidance) return { error: err.guidance.message, code: err.code, tips: err.guidance.tips };
  if (err instanceof YouCamError) return { error: err.message, code: err.code, tips: err.code === 'rate_limited' ? ['Wait a minute and try again.'] : ['Try again in a moment.'] };
  if (err instanceof ImageError) return { error: err.message, code: err.code, tips: guidanceFor(err.code).tips };
  if (err instanceof HttpError) return { error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.tips ? { tips: err.tips } : {}) };
  return { error: 'Something went wrong. Try again in a moment.' };
}
function errorStatus(err) {
  if (err instanceof HttpError) return err.status;
  if (err instanceof ImageError) return 400;
  if (err instanceof YouCamError) return err.guidance ? 422 : err.status === 429 ? 429 : 502;
  return 500;
}

async function respond(req, res, run) {
  if (!wantsStream(req)) {
    const result = await run(() => {});
    return sendJson(res, 200, result);
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  const write = (obj) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`);
  };
  try {
    const result = await run(write);
    write({ type: 'result', ...result });
  } catch (err) {
    if (!(err instanceof YouCamError || err instanceof ImageError || err instanceof HttpError)) console.error('[glowplan] request failed:', err?.message);
    write({ type: 'error', status: errorStatus(err), ...errorBody(err) });
  }
  res.end();
}

function guard(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (!(err instanceof YouCamError || err instanceof ImageError || err instanceof HttpError)) console.error('[glowplan] request failed:', err?.message);
      if (!res.headersSent) sendJson(res, errorStatus(err), errorBody(err));
      else res.end();
    }
  };
}

// --- Analyze -----------------------------------------------------------------

const TITLES = {
  check: ['Checking the photo', 'Checked the photo'],
  upload: ['Uploading your photo to the YouCam File API', 'Uploaded once to the YouCam File API'],
  skin: ['Skin analysis', 'Skin analysis'],
  tone: ['Skin tone', 'Skin tone'],
};
const titleFor = (id, status) => (TITLES[id] ? TITLES[id][status === 'running' ? 0 : 1] : id);
const TASK_ID = /^[A-Za-z0-9_\-+=/.]{8,600}$/;

/** SKIN_TONE_MODE: 'first' (default: when the browser has no stored tone profile), 'every', or 'off'. */
function toneWanted(requested, env = process.env) {
  const mode = env.SKIN_TONE_MODE || 'first';
  if (mode === 'off') return false;
  if (mode === 'every') return true;
  return requested !== false;
}

function toneFields(tone) {
  if (!tone || tone.status === 'skipped') return { toneStatus: 'skipped' };
  if (tone.status === 'success') return { tone: { ...tone.result, measuredAt: new Date().toISOString() }, toneStatus: 'measured' };
  if (tone.status === 'running') return { toneStatus: 'pending', toneTaskId: tone.taskId };
  return { toneStatus: 'error', toneError: tone.error?.message || 'Skin tone could not be read.', toneTips: tone.error?.tips || [] };
}

function scanFrom(result, { tier, demo, source, sample, units, taskId, apiVersion, tone }) {
  const t = toneFields(tone);
  const toneUnits = tone?.status === 'success' ? tone.units : 0;
  return {
    id: randomUUID(),
    takenAt: new Date().toISOString(),
    tier: result.tier || tier,
    demo,
    source,
    ...(sample ? { sample } : {}),
    overall: result.overall,
    overallSource: result.overallSource,
    skinAge: result.skinAge,
    concerns: result.concerns,
    ...t,
    units: { skin: units, tone: toneUnits, total: units + toneUnits },
    taskId,
    apiVersion,
  };
}

/** Pull the image (and options) out of a JSON or multipart request. */
async function readAnalyzeRequest(req) {
  const ctype = String(req.headers['content-type'] || '');
  if (ctype.startsWith('multipart/form-data')) {
    const raw = Buffer.isBuffer(req.body) ? req.body : await readRaw(req, MAX_BODY);
    const { file, fields } = parseMultipart(raw, ctype);
    return { buffer: file?.buffer || null, fileName: file?.fileName, sample: fields.sample, tier: fields.tier, tone: fields.tone !== 'false' };
  }
  const body = await readJson(req, MAX_BODY);
  const tone = body.tone !== false;
  if (SAMPLES.includes(body.sample)) return { sample: body.sample, tone };
  if (body.sample) throw new HttpError(400, 'Unknown sample.');
  return { buffer: decodeImageString(body.image, MAX_IMAGE_BYTES), fileName: body.fileName, tier: body.tier, tone };
}

const safeName = (n, type) => {
  const ext = type === 'image/png' ? 'png' : 'jpg';
  const base = String(n || 'selfie').replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40) || 'selfie';
  return `${base}.${ext}`;
};

/** GET /api/analyze?task_id=…&tier=hd[&tone_task_id=…]  or  ?tone_task_id=… alone. */
async function continuePolling(req, res, deps, apiVersion) {
  const url = new URL(req.url, 'http://localhost');
  const taskId = url.searchParams.get('task_id') || '';
  const toneTaskId = url.searchParams.get('tone_task_id') || '';
  const tier = url.searchParams.get('tier') === 'sd' ? 'sd' : 'hd';
  if ((!taskId && !toneTaskId) || (taskId && !TASK_ID.test(taskId)) || (toneTaskId && !TASK_ID.test(toneTaskId))) throw new HttpError(400, 'Missing or invalid task_id.');
  if (rateLimited(req, 'poll')) throw new HttpError(429, 'Too many checks from this connection. Wait a minute.');
  const pick = (id) => (isMockTaskId(id) ? deps.demo : deps.youcam);
  const demo = isMockTaskId(taskId || toneTaskId) || deps.youcam.mode !== 'live';
  const deadline = Date.now() + 15000;
  return respond(req, res, async (emit) => {
    const tonePromise = toneTaskId
      ? pick(toneTaskId).waitForToneTask(toneTaskId, { deadline })
        .then((out) => (out.status === 'success' ? { status: 'success', result: out.result, units: TONE_UNITS, taskId: toneTaskId } : { status: 'running', taskId: toneTaskId }))
        .catch((err) => ({ status: 'error', error: { message: err?.guidance?.message || err.message, tips: err?.guidance?.tips || [] } }))
      : Promise.resolve(null);
    if (!taskId) {
      const tone = await tonePromise;
      if (tone.status === 'success') emit({ type: 'step', step: { id: 'tone', title: titleFor('tone', 'done'), status: 'done', detail: `Skin colour ${tone.result.skinHex}` } });
      return { status: 'success', demo, ...toneFields(tone) };
    }
    emit({ type: 'step', step: { id: 'skin', title: titleFor('skin', 'running'), status: 'running', detail: 'Still analysing' } });
    const out = await pick(taskId).waitForSkinTask(taskId, { deadline, tier, onPoll: ({ polls }) => emit({ type: 'step', step: { id: 'skin', title: titleFor('skin', 'running'), status: 'running', detail: `Checked again ${polls}×` } }) });
    const tone = await tonePromise;
    if (out.status !== 'success') return { status: 'running', taskId, tier, demo, ...(toneTaskId ? { toneTaskId: tone?.status === 'running' ? toneTaskId : null } : {}) };
    emit({ type: 'step', step: { id: 'skin', title: titleFor('skin', 'done'), status: 'done', detail: `${out.result.concerns.length} concern scores` } });
    if (tone?.status === 'success') emit({ type: 'step', step: { id: 'tone', title: titleFor('tone', 'done'), status: 'done', detail: `Skin colour ${tone.result.skinHex}` } });
    return { status: 'success', taskId, demo, scan: scanFrom(out.result, { tier, demo, source: demo ? 'demo' : 'photo', units: estimateUnits(tier, CONCERN_KEYS.length), taskId, apiVersion, tone: tone || { status: 'skipped' } }) };
  });
}

export const handleAnalyze = guard(async (req, res) => {
  const deps = depsFromEnv();
  const apiVersion = deps.youcam.version;
  if (req.method === 'GET') return continuePolling(req, res, deps, apiVersion);

  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST with a photo, or GET with a task_id.' });
  const input = await readAnalyzeRequest(req);
  const usingSample = Boolean(input.sample);
  const live = deps.youcam.mode === 'live' && !usingSample;
  if (rateLimited(req, live ? 'analyze' : 'analyze_demo')) throw new HttpError(429, 'Too many scans from this connection. Wait a few minutes and try again.');

  let buffer;
  let info;
  if (usingSample) {
    buffer = sampleBuffer(input.sample);
    info = { type: 'image/jpeg', tier: 'hd', width: 1440, height: 1920 };
  } else {
    if (!input.buffer) throw new HttpError(400, 'Add a photo first.');
    info = inspectImage(input.buffer, { maxBytes: MAX_IMAGE_BYTES });
    buffer = input.buffer;
  }
  const tier = input.tier === 'sd' ? 'sd' : info.tier;
  const client = usingSample ? deps.demo : deps.youcam;
  const demo = client.mode !== 'live';
  const withTone = toneWanted(input.tone);

  await respond(req, res, async (emit) => {
    emit({ type: 'meta', mode: modeInfo(deps), demo });
    emit({
      type: 'step',
      step: {
        id: 'check',
        title: titleFor('check', 'done'),
        status: 'done',
        detail: usingSample ? 'Bundled sample (synthetic demo data)' : `${info.width}×${info.height} ${info.type === 'image/png' ? 'PNG' : 'JPG'}, ${tier === 'hd' ? 'HD scan (short side ≥ 1080 px)' : 'standard scan (short side under 1080 px)'}`,
      },
    });
    if (!withTone) emit({ type: 'step', step: { id: 'tone', title: titleFor('tone', 'done'), status: 'skipped', detail: 'Reusing your measured skin tone: no extra units' } });
    const out = await client.analyzeProfile(buffer, {
      contentType: info.type,
      fileName: usingSample ? 'sample.jpg' : safeName(input.fileName, info.type),
      tier,
      withTone,
      deadline: Date.now() + Number(process.env.ANALYZE_WAIT_MS ?? 19000),
      onStep: (s) => emit({
        type: 'step',
        step: { ...s, title: titleFor(s.id, s.status), ...(usingSample && s.id === 'upload' && s.status === 'done' ? { detail: 'Sample marker sent once to the demo File API (no real photo)' } : {}) },
      }),
    });
    buffer = null; // drop the photo as soon as YouCam has it
    if (out.status !== 'success') {
      return { status: 'running', taskId: out.skin.taskId, tier, demo, ...(out.tone.status === 'running' ? { toneTaskId: out.tone.taskId } : {}), ...(out.tone.status === 'success' || out.tone.status === 'error' ? { toneDone: toneFields(out.tone) } : {}) };
    }
    return {
      status: 'success',
      taskId: out.skin.taskId,
      demo,
      uploads: out.uploads,
      scan: scanFrom(out.skin.result, { tier, demo, source: usingSample ? 'sample' : demo ? 'demo' : 'photo', sample: input.sample, units: out.skin.units, taskId: out.skin.taskId, apiVersion, tone: out.tone }),
    };
  });
});

// --- Plan --------------------------------------------------------------------

export const handlePlan = guard(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
  if (rateLimited(req, 'plan')) throw new HttpError(429, 'Too many plans from this connection. Wait a few minutes and try again.');
  const body = await readJson(req);
  const input = validatePlanInput(body);
  if (input.error) throw new HttpError(400, input.error);
  const deps = depsFromEnv();
  await respond(req, res, (emit) => planSkin(input.value, { llm: deps.llm, youcam: deps.youcam, emit }));
});

// --- Health ------------------------------------------------------------------

export const handleHealth = guard(async (req, res) => {
  const deps = depsFromEnv();
  sendJson(res, 200, { ok: true, mode: modeInfo(deps), limits: { maxImageBytes: MAX_IMAGE_BYTES, minShortSide: { sd: 480, hd: 1080 } } });
});
