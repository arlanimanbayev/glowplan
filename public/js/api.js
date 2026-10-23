/**
 * Talks to the GlowPlan API. Both endpoints stream NDJSON: progress lines
 * ({type:'step'|'trace'|'meta'}) followed by {type:'result'} or {type:'error'}.
 */

export class ApiError extends Error {
  constructor(message, { code, tips, status } = {}) {
    super(message);
    this.code = code;
    this.tips = tips || [];
    this.status = status;
  }
}

export async function stream(url, { method = 'POST', body, onEvent = () => {}, signal } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Accept: 'application/x-ndjson', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch {
    throw new ApiError('Could not reach GlowPlan. Check your connection and try again.');
  }
  const type = res.headers.get('content-type') || '';
  if (!type.includes('ndjson')) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new ApiError(data.error || `Request failed (${res.status}).`, { code: data.code, tips: data.tips, status: res.status });
    return data;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let result = null;
  const handle = (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === 'result') result = msg;
    else if (msg.type === 'error') throw new ApiError(msg.error, { code: msg.code, tips: msg.tips, status: msg.status });
    else onEvent(msg);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      handle(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  handle(buf);
  if (!result) throw new ApiError('The response ended early. Try again.');
  return result;
}

/**
 * Run the scan (skin analysis + optional skin tone on one upload) and keep
 * polling until YouCam finishes. A late skin-tone result is merged in; a failed
 * one never blocks the skin scan.
 */
export async function analyze(payload, onEvent) {
  let out = await stream('/api/analyze', { body: payload, onEvent });
  let toneDone = out.toneDone || null;
  let toneTaskId = out.toneTaskId || null;
  for (let i = 0; out.status === 'running' && i < 10; i += 1) {
    const q = new URLSearchParams({ task_id: out.taskId, tier: out.tier || 'hd', ...(toneTaskId ? { tone_task_id: toneTaskId } : {}) });
    out = await stream(`/api/analyze?${q}`, { method: 'GET', onEvent });
    if (out.toneDone) toneDone = out.toneDone;
    if (out.status === 'running') toneTaskId = out.toneTaskId || null;
  }
  if (out.status !== 'success') throw new ApiError('YouCam is taking longer than usual. Try again in a minute.');
  const scan = out.scan;
  if (toneDone && (scan.toneStatus === 'skipped' || !scan.toneStatus)) Object.assign(scan, toneDone);
  for (let i = 0; scan.toneStatus === 'pending' && scan.toneTaskId && i < 4; i += 1) {
    const t = await stream(`/api/analyze?${new URLSearchParams({ tone_task_id: scan.toneTaskId })}`, { method: 'GET', onEvent });
    delete scan.toneTaskId;
    Object.assign(scan, { toneStatus: t.toneStatus, ...(t.tone ? { tone: t.tone } : {}), ...(t.toneError ? { toneError: t.toneError } : {}), ...(t.toneTaskId ? { toneTaskId: t.toneTaskId } : {}) });
  }
  if (scan.toneStatus === 'pending') Object.assign(scan, { toneStatus: 'error', toneError: 'Skin tone took too long; the plan uses your skin scores only.' });
  return out;
}

export async function health() {
  try {
    const res = await fetch('/api/health');
    return await res.json();
  } catch {
    return null;
  }
}
