/**
 * YouCam API client for AI Skin Analysis (Perfect Corp).
 *
 * Verified against https://docs.perfectcorp.com (Quick Start, API Server, Rate Limit,
 * AI Skin Analysis v2.0/v2.1 reference) and the official YouCam-API/skills repo:
 *
 *   Auth      Authorization: Bearer <YOUCAM_API_KEY>   (one API key from the API console)
 *   Server    https://yce-api-01.makeupar.com
 *   1. POST /s2s/v2.0/file                     {files:[{content_type,file_name,file_size}]}
 *        -> data.files[0].file_id + data.files[0].requests[0] {method:'PUT', url, headers}
 *   2. PUT  <requests[0].url>                   raw bytes, with the returned headers
 *   3. POST /s2s/v2.1/task/skin-analysis       {src_file_id, dst_actions[], miniserver_args, format:'json'}
 *        -> data.task_id
 *   4. GET  /s2s/v2.1/task/skin-analysis/{id}  -> data.task_status running | success | error
 *        success: data.results.output[] {type, region?, ui_score, raw_score, score?, mask_urls[]}
 *        error:   data.error (e.g. error_src_face_too_small), data.error_message
 *
 *   Skin tone (AI Facial Color Tones Analyzer, 20 units), on the same file_id:
 *   5. POST /s2s/v2.0/task/skin-tone-analysis  {src_file_id, face_angle_strictness_level}
 *   6. GET  /s2s/v2.0/task/skin-tone-analysis/{id} -> results.color {skin_color, ...} + results.face_quality
 *
 * Rate limit: 250 requests / 300 s per IP and per key; ~5 requests/s recommended.
 * This client paces calls (min interval), retries 429/5xx with backoff, and
 * honours Retry-After. Task creation is retried only when the server explicitly
 * refused it (429/503), so a slow response can never create a second billable task.
 */
import { actionsFor, estimateUnits, parseSkinResult } from './concerns.js';
import { parseToneResult } from './tone.js';

export const YOUCAM_DEFAULT_BASE_URL = 'https://yce-api-01.makeupar.com';
export const YOUCAM_FILE_PATH = '/s2s/v2.0/file';
export const YOUCAM_SKIN_VERSION = 'v2.1';
/** Skin Tone Analysis ("AI Facial Color Tones Analyzer", doc v1.0): 20 units per successful task. */
export const YOUCAM_TONE_PATH = '/s2s/v2.0/task/skin-tone-analysis';
export const TONE_UNITS = 20;

/** Retake guidance for the documented image / task error codes. */
export const ERROR_GUIDANCE = {
  error_src_face_too_small: { message: 'Your face is too small in the photo.', tips: ['Hold the camera closer so your face fills most of the frame.', 'Crop the photo so your face is at least 60% of its width.'] },
  error_src_face_out_of_bound: { message: 'Part of your face is outside the photo.', tips: ['Centre your face and keep your forehead and chin in frame.'] },
  error_lighting_dark: { message: 'The photo is too dark to read your skin.', tips: ['Face a window or soft daylight.', 'Avoid strong light from behind you.'] },
  error_below_min_image_size: { message: 'The photo resolution is too low.', tips: ['Use the main camera, or a photo at least 480 pixels on its short side. 1080 pixels or more unlocks the detailed HD scan.'] },
  error_exceed_max_image_size: { message: 'The photo is too large.', tips: ['Use a photo under 10 MB.'] },
  exceed_max_filesize: { message: 'The photo file is too large.', tips: ['Use a photo under 10 MB.'] },
  error_no_face: { message: 'No face was found in the photo.', tips: ['Use a front-facing photo of one face, without sunglasses or a mask.'] },
  error_multiple_people: { message: 'More than one person is in the photo.', tips: ['Use a photo with only your face in it.'] },
  error_large_face_angle: { message: 'Your face is turned too far.', tips: ['Look straight at the camera with your head level.'] },
  error_pose: { message: 'The face angle could not be read.', tips: ['Look straight at the camera with your head level.'] },
  error_face_parsing: { message: 'Your face could not be mapped.', tips: ['Pull hair back from your face and remove glasses.', 'Use even lighting.'] },
  error_decode_image: { message: 'The photo could not be opened.', tips: ['Try a JPG or PNG photo.'] },
  error_download_image: { message: 'YouCam could not read the uploaded photo.', tips: ['Try again in a moment.'] },
  error_nsfw_content_detected: { message: 'This photo cannot be analysed.', tips: ['Use a plain, front-facing selfie.'] },
  error_unsupport_ratio: { message: 'The photo shape is not supported.', tips: ['Use a portrait or square photo.'] },
  invalid_parameter: { message: 'The scan request was not accepted.', tips: ['Try again. If it keeps happening, the server configuration needs a check.'] },
  error_inference: { message: 'The skin analysis failed on this photo.', tips: ['Try again, or retake the photo in even light.'] },
  unknown_internal_error: { message: 'YouCam had an internal error.', tips: ['Try again in a moment.'] },
  // Skin Tone Analysis photo checks
  error_face_position_invalid: { message: 'Your face needs to be fully visible, forward-facing and centred.', tips: ['Centre your face and look straight at the camera.'] },
  error_face_position_too_small: { message: 'Your face is too small in the photo.', tips: ['Hold the camera closer so your face fills most of the frame.'] },
  error_face_position_out_of_boundary: { message: 'Part of your face is outside the photo.', tips: ['Keep your whole face inside the frame.'] },
  error_face_not_forward_facing: { message: 'Your face is not facing the camera.', tips: ['Look straight at the camera.'] },
  error_face_angle_upward: { message: 'Your head is tilted up.', tips: ['Tilt your head down slightly.'] },
  error_face_angle_downward: { message: 'Your head is tilted down.', tips: ['Tilt your head up slightly.'] },
  error_face_angle_leftward: { message: 'Your head is turned to the left.', tips: ['Turn your head slightly to the right.'] },
  error_face_angle_rightward: { message: 'Your head is turned to the right.', tips: ['Turn your head slightly to the left.'] },
  error_face_angle_left_tilt: { message: 'Your head is tilted to one side.', tips: ['Tilt your head gently to the right.'] },
  error_face_angle_right_tilt: { message: 'Your head is tilted to one side.', tips: ['Tilt your head gently to the left.'] },
};

export function guidanceFor(code) {
  return ERROR_GUIDANCE[code] || { message: 'The skin analysis did not finish.', tips: ['Try again with a clear, front-facing photo in even light.'] };
}

export class YouCamError extends Error {
  constructor(message, { status, code, retryable = false, guidance } = {}) {
    super(message);
    this.name = 'YouCamError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.guidance = guidance;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} o
 * @param {string} o.apiKey
 * @param {string} [o.baseUrl]
 * @param {string} [o.version]   skin-analysis API version path segment (v2.1 default, v2.0 supported)
 * @param {Function} [o.fetchImpl]
 * @param {'live'|'mock'} [o.mode]
 * @param {number} [o.minIntervalMs]  pacing between API calls (default 220 ms, about 4.5 req/s)
 * @param {number} [o.maxRetries]
 * @param {number} [o.timeoutMs]
 */
export function createYouCamClient({
  apiKey,
  baseUrl = YOUCAM_DEFAULT_BASE_URL,
  version = YOUCAM_SKIN_VERSION,
  filePath = YOUCAM_FILE_PATH,
  fetchImpl = globalThis.fetch,
  mode = 'live',
  minIntervalMs = 220,
  maxRetries = 3,
  timeoutMs = 15000,
  uploadTimeoutMs = 25000,
  backoffMs = 400,
  sleep = defaultSleep,
} = {}) {
  if (!apiKey) throw new YouCamError('YOUCAM_API_KEY is required.');
  if (!/^v\d+\.\d+$/.test(version)) throw new YouCamError('YOUCAM_SKIN_VERSION must look like v2.1.');
  const base = baseUrl.replace(/\/+$/, '');
  const taskPath = `/s2s/${version}/task/skin-analysis`;
  const tonePath = YOUCAM_TONE_PATH;
  const stats = { requests: 0, retries: 0 };

  // Pacing gate: each API call starts at least minIntervalMs after the previous one.
  let gate = Promise.resolve();
  let lastStart = 0;
  const paced = () => {
    const turn = gate.then(async () => {
      const wait = lastStart + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
    });
    gate = turn.catch(() => {});
    return turn;
  };

  async function once(url, init, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  const retryAfterMs = (res) => {
    const h = res?.headers?.get?.('retry-after');
    const s = Number(h);
    return Number.isFinite(s) && s > 0 ? Math.min(8000, s * 1000) : null;
  };
  const backoff = (attempt) => Math.min(4000, backoffMs * 2 ** attempt) + Math.floor(Math.random() * 120);

  /**
   * JSON API call with retries. `retryOn` decides which failures are safe to retry.
   * Returns the parsed body; throws YouCamError on failure.
   */
  async function api(method, path, { body, retryOn = 'idempotent' } = {}) {
    const url = `${base}${path}`;
    for (let attempt = 0; ; attempt += 1) {
      await paced();
      stats.requests += 1;
      let res;
      let data;
      try {
        res = await once(url, {
          method,
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }, timeoutMs);
        data = await res.json().catch(() => ({}));
      } catch (err) {
        const timedOut = err?.name === 'AbortError';
        // A network failure on task creation may still have created the task: never retry it.
        if (retryOn === 'idempotent' && attempt < maxRetries) {
          stats.retries += 1;
          await sleep(backoff(attempt));
          continue;
        }
        throw new YouCamError(timedOut ? 'YouCam did not respond in time.' : 'Could not reach YouCam.', { code: timedOut ? 'timeout' : 'network', retryable: true });
      }
      if (res.ok && (data?.status === undefined || Number(data.status) < 400)) return data;

      const status = Number(data?.status) || res.status;
      const retryable = status === 429 || status === 503 || (retryOn === 'idempotent' && (status === 500 || status === 502 || status === 504));
      if (retryable && attempt < maxRetries) {
        stats.retries += 1;
        await sleep(retryAfterMs(res) ?? backoff(attempt));
        continue;
      }
      const code = data?.error_code || (status === 401 ? 'unauthorized' : status === 429 ? 'rate_limited' : undefined);
      const message = status === 401
        ? 'YouCam rejected the API key. Check YOUCAM_API_KEY.'
        : status === 429
          ? 'YouCam is busy (rate limit). Try again in a minute.'
          : `YouCam request failed: ${typeof data?.error === 'string' ? data.error : `HTTP ${status}`}`;
      throw new YouCamError(message, { status, code, retryable: status === 429 || status >= 500 });
    }
  }

  /** Step 1+2: register the file and PUT the bytes to the signed URL. Returns file_id. */
  async function uploadImage(buffer, { contentType = 'image/jpeg', fileName = 'selfie.jpg' } = {}) {
    const init = await api('POST', filePath, {
      body: { files: [{ content_type: contentType, file_name: fileName, file_size: buffer.length }] },
    });
    const file = init?.data?.files?.[0];
    const put = file?.requests?.find?.((r) => String(r?.method || 'PUT').toUpperCase() === 'PUT') || file?.requests?.[0];
    if (!file?.file_id || !put?.url) throw new YouCamError('YouCam did not return an upload URL.', { code: 'bad_upload_init' });

    const headers = { ...(put.headers || {}) };
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = contentType;
    for (let attempt = 0; ; attempt += 1) {
      let res;
      try {
        res = await once(put.url, { method: 'PUT', headers, body: buffer }, uploadTimeoutMs);
      } catch (err) {
        if (attempt < maxRetries) {
          stats.retries += 1;
          await sleep(backoff(attempt));
          continue;
        }
        throw new YouCamError('The photo upload to YouCam failed.', { code: 'upload_failed', retryable: true });
      }
      if (res.ok) break;
      if ((res.status >= 500 || res.status === 429) && attempt < maxRetries) {
        stats.retries += 1;
        await sleep(backoff(attempt));
        continue;
      }
      throw new YouCamError(`The photo upload to YouCam failed (HTTP ${res.status}).`, { status: res.status, code: 'upload_failed' });
    }
    return file.file_id;
  }

  /** Step 3: start a Skin Analysis task. Returns task_id. */
  async function createSkinTask({ fileId, actions, overlay = true }) {
    const body = {
      src_file_id: fileId,
      dst_actions: actions,
      miniserver_args: { enable_mask_overlay: Boolean(overlay) },
      format: 'json',
    };
    const out = await api('POST', taskPath, { body, retryOn: 'explicit-refusal' });
    const taskId = out?.data?.task_id;
    if (!taskId) throw new YouCamError('YouCam did not return a task id.', { code: 'bad_task' });
    return taskId;
  }

  /** Start a Skin Tone Analysis task on an already uploaded file. Returns task_id. */
  async function createToneTask({ fileId, strictness = 'medium' }) {
    const out = await api('POST', tonePath, { body: { src_file_id: fileId, face_angle_strictness_level: strictness }, retryOn: 'explicit-refusal' });
    const taskId = out?.data?.task_id;
    if (!taskId) throw new YouCamError('YouCam did not return a task id.', { code: 'bad_task' });
    return taskId;
  }

  /** One status check of any task path: returns { status, data }. */
  async function getTask(path, taskId) {
    const out = await api('GET', `${path}/${encodeURIComponent(taskId)}`);
    const data = out?.data || {};
    return { status: String(data.task_status || 'running'), data };
  }
  const getSkinTask = (taskId) => getTask(taskPath, taskId);
  const getToneTask = (taskId) => getTask(tonePath, taskId);

  /**
   * Poll until success/error or the deadline. Returns
   * `{ status:'success', result, data, polls }` | `{ status:'running', polls }`, or throws on task error.
   */
  async function waitForTask(path, taskId, parse, { deadline = Date.now() + 20000, intervalMs = 1500, maxIntervalMs = 3000, onPoll } = {}) {
    let polls = 0;
    let wait = intervalMs;
    for (;;) {
      const { status, data } = await getTask(path, taskId);
      polls += 1;
      onPoll?.({ polls, status });
      if (status === 'success') return { status, data, polls, result: parse(data) };
      if (status === 'error') {
        const code = String(data.error || 'unknown_internal_error');
        const guidance = guidanceFor(code);
        throw new YouCamError(guidance.message, { code, guidance, status: 422 });
      }
      if (Date.now() + wait > deadline) return { status: 'running', polls };
      await sleep(wait);
      wait = Math.min(maxIntervalMs, Math.round(wait * 1.4));
    }
  }
  const waitForSkinTask = (taskId, { tier, ...opts } = {}) => waitForTask(taskPath, taskId, (d) => parseSkinResult(d, { tier }), opts);
  const waitForToneTask = (taskId, opts = {}) => waitForTask(tonePath, taskId, (d) => {
    const tone = parseToneResult(d);
    if (!tone) throw new YouCamError('YouCam returned no skin colour.', { code: 'bad_tone_result' });
    return tone;
  }, opts);

  /**
   * End to end: upload -> task -> poll. `tier` is 'hd' | 'sd'.
   * Returns { status, taskId, result?, units, polls, actions }.
   */
  async function analyzeSkin(buffer, { contentType, fileName, tier = 'hd', keys, overlay = true, deadline, onStep = () => {} } = {}) {
    const actions = actionsFor(tier, keys);
    onStep({ id: 'upload', status: 'running' });
    const fileId = await uploadImage(buffer, { contentType, fileName });
    const size = buffer.length < 1024 ? `${buffer.length} bytes` : `${Math.round(buffer.length / 1024)} KB`;
    onStep({ id: 'upload', status: 'done', detail: `${size} sent to the YouCam File API` });
    onStep({ id: 'task', status: 'running' });
    const taskId = await createSkinTask({ fileId, actions, overlay });
    onStep({ id: 'task', status: 'done', detail: `${actions.length} ${tier.toUpperCase()} concerns requested` });
    onStep({ id: 'poll', status: 'running' });
    const out = await waitForSkinTask(taskId, { deadline, tier, onPoll: ({ polls }) => onStep({ id: 'poll', status: 'running', detail: `Checked ${polls}×` }) });
    if (out.status === 'success') onStep({ id: 'poll', status: 'done', detail: `Finished after ${out.polls} check${out.polls === 1 ? '' : 's'}` });
    return { ...out, taskId, actions, units: estimateUnits(tier, actions.length) };
  }

  /**
   * One upload, two analyses in parallel: Skin Analysis (required) and, when
   * `withTone`, Skin Tone Analysis on the SAME file_id. Skin tone is optional:
   * if it fails, the scan still succeeds and `tone.status` says why.
   *
   * If YouCam refuses the shared file for the tone task (404, i.e. file ids turn
   * out to be single-use), the photo is uploaded once more for that task only.
   *
   * Returns { status:'success'|'running', skin:{taskId, result?, units, actions},
   *           tone:{status:'success'|'running'|'error'|'skipped', taskId?, result?, error?, units}, uploads }
   */
  async function analyzeProfile(buffer, { contentType, fileName, tier = 'hd', keys, withTone = true, deadline = Date.now() + 19000, onStep = () => {} } = {}) {
    const actions = actionsFor(tier, keys);
    let uploads = 1;
    onStep({ id: 'upload', status: 'running' });
    const fileId = await uploadImage(buffer, { contentType, fileName });
    const size = buffer.length < 1024 ? `${buffer.length} bytes` : `${Math.round(buffer.length / 1024)} KB`;
    onStep({ id: 'upload', status: 'done', detail: `${size} sent once to the YouCam File API` });

    const skinTask = (async () => {
      onStep({ id: 'skin', status: 'running', detail: `Starting: ${actions.length} ${tier.toUpperCase()} concerns` });
      const taskId = await createSkinTask({ fileId, actions, overlay: true });
      const out = await waitForSkinTask(taskId, { deadline, tier, onPoll: ({ polls }) => onStep({ id: 'skin', status: 'running', detail: `${actions.length} ${tier.toUpperCase()} concerns, checked ${polls}×` }) });
      if (out.status === 'success') onStep({ id: 'skin', status: 'done', detail: `${out.result.concerns.length} concern scores${out.result.concerns.some((c) => c.regions.length) ? ' with face regions' : ''}` });
      return { ...out, taskId, actions, units: estimateUnits(tier, actions.length) };
    })();

    const toneTask = !withTone
      ? Promise.resolve({ status: 'skipped', units: 0 })
      : (async () => {
        onStep({ id: 'tone', status: 'running', detail: 'Starting on the same upload' });
        let taskId;
        try {
          taskId = await createToneTask({ fileId });
        } catch (err) {
          if (!(err instanceof YouCamError) || err.status !== 404) throw err;
          uploads += 1;
          const again = await uploadImage(buffer, { contentType, fileName });
          taskId = await createToneTask({ fileId: again });
        }
        const out = await waitForToneTask(taskId, { deadline, onPoll: ({ polls }) => onStep({ id: 'tone', status: 'running', detail: `Checked ${polls}×` }) });
        if (out.status === 'success') onStep({ id: 'tone', status: 'done', detail: `Skin colour ${out.result.skinHex}, ${out.result.depthLabel.toLowerCase()} on the ITA scale (${out.result.ita}°)` });
        return { ...out, taskId, units: TONE_UNITS };
      })().catch((err) => {
        const msg = err?.guidance?.message || err?.message || 'Skin tone could not be read.';
        onStep({ id: 'tone', status: 'error', detail: `${msg} The skin scan continues without it.` });
        return { status: 'error', error: { code: err?.code || 'tone_failed', message: msg, tips: err?.guidance?.tips || [] }, units: 0 };
      });

    const [skin, tone] = await Promise.all([skinTask, toneTask]);
    return { status: skin.status, skin, tone, uploads };
  }

  return { mode, version, baseUrl: base, taskPath, tonePath, stats, uploadImage, createSkinTask, createToneTask, getSkinTask, getToneTask, waitForSkinTask, waitForToneTask, analyzeSkin, analyzeProfile };
}
