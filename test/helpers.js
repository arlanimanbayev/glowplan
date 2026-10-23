// Shared test helpers: demo-mode YouCam client, a parsed sample scan, a PNG
// generator and a scriptable fake Gemini endpoint. Tests never touch real services.
import { deflateSync } from 'node:zlib';
import { createYouCamClient } from '../lib/youcam.js';
import { createMockFetch, MOCK_API_KEY, MOCK_BASE_URL, loadFixture } from '../lib/mock-youcam.js';
import { parseSkinResult } from '../lib/concerns.js';
import { createGemini } from '../lib/llm.js';

delete process.env.YOUCAM_API_KEY;
delete process.env.GEMINI_API_KEY;
process.env.MOCK_TASK_MS = '0';
process.env.MOCK_LATENCY_MS = '0';
process.env.RATE_LIMIT = 'off';

export const noSleep = async () => {};

export function mockYouCam({ faults = [], taskMs = 0, ...opts } = {}) {
  const fetchImpl = createMockFetch({ taskMs, latencyMs: 0, faults });
  const client = createYouCamClient({ apiKey: MOCK_API_KEY, baseUrl: MOCK_BASE_URL, fetchImpl, mode: 'mock', minIntervalMs: 0, sleep: noSleep, ...opts });
  return { client, calls: fetchImpl.calls, fetchImpl };
}

export function sampleScan(name = 'demo-a', extra = {}) {
  const r = parseSkinResult(loadFixture(name));
  return { ...r, takenAt: name === 'demo-b' ? '2026-10-22T10:00:00.000Z' : '2026-08-27T10:00:00.000Z', demo: true, ...extra };
}

// zlib.crc32 only exists on newer Node versions, so compute it here.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A valid, solid-colour PNG of the given size (no real face). */
export function makePng(width, height) {
  const row = Buffer.alloc(1 + width * 3, 0x9c);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Minimal JPEG header (SOI, optional EXIF orientation, SOF0) for dimension parsing. */
export function makeJpegHeader(width, height, orientation) {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (orientation) {
    const tiff = Buffer.alloc(8 + 2 + 12 + 4);
    tiff.write('MM', 0, 'ascii');
    tiff.writeUInt16BE(42, 2);
    tiff.writeUInt32BE(8, 4);
    tiff.writeUInt16BE(1, 8);
    tiff.writeUInt16BE(0x0112, 10);
    tiff.writeUInt16BE(3, 12);
    tiff.writeUInt32BE(1, 14);
    tiff.writeUInt16BE(orientation, 18);
    const body = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(body.length + 2);
    parts.push(Buffer.from([0xff, 0xe1]), len, body);
  }
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  parts.push(sof, Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

/**
 * Fake Gemini generateContent endpoint. `script(turn, body)` returns
 * { parts } for a model turn, { status, message } for an HTTP error, or an Error to throw.
 */
export function fakeGemini(script, model = 'test-model') {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, headers: init.headers, body });
    const out = script(requests.length - 1, body);
    if (out instanceof Error) throw out;
    if (out.status) return new Response(JSON.stringify({ error: { message: out.message } }), { status: out.status });
    return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: out.parts }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 10 } }), { status: 200 });
  };
  return { requests, llm: createGemini({ apiKey: 'gemini-test-key', model, fetchImpl }) };
}

export const call = (name, args = {}) => ({ functionCall: { name, args } });

/** The last function response the agent sent back to Gemini, by tool name. */
export function lastToolResult(body, name) {
  const turn = body.contents[body.contents.length - 1];
  return turn.parts.find((p) => p.functionResponse?.name === name)?.functionResponse.response.result;
}

/** Fake Node req/res pair for handler tests. */
export function fakeReqRes({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const req = {
    method,
    url,
    headers: { 'content-type': 'application/json', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
  const out = { status: 200, headers: {}, chunks: [] };
  const res = {
    headersSent: false,
    writableEnded: false,
    set statusCode(v) {
      out.status = v;
    },
    get statusCode() {
      return out.status;
    },
    setHeader(k, v) {
      out.headers[k.toLowerCase()] = v;
    },
    write(c) {
      this.headersSent = true;
      out.chunks.push(String(c));
    },
    end(c) {
      if (c) out.chunks.push(String(c));
      this.headersSent = true;
      this.writableEnded = true;
    },
  };
  out.text = () => out.chunks.join('');
  out.json = () => JSON.parse(out.text());
  out.lines = () => out.text().trim().split('\n').map((l) => JSON.parse(l));
  return { req, res, out };
}
