/**
 * Small, dependency-free image helpers: decode a data URL / base64 string,
 * sniff JPEG or PNG from magic bytes, and read pixel dimensions from the
 * header so the server can pick the YouCam tier (HD needs a short side of
 * at least 1080 px, SD at least 480 px) before spending any units.
 *
 * Images stay in memory as Buffers. Nothing here writes to disk or logs bytes.
 */
import { IMAGE_RULES } from './concerns.js';

export class ImageError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ImageError';
    this.code = code;
  }
}

/** Decode `data:image/jpeg;base64,...` or bare base64 into a Buffer. */
export function decodeImageString(value, maxBytes) {
  if (typeof value !== 'string' || !value) throw new ImageError('Add a photo first.', 'no_image');
  const m = value.match(/^data:([a-z/+.-]+);base64,(.*)$/is);
  const b64 = (m ? m[2] : value).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=_-]+$/.test(b64)) throw new ImageError('The photo could not be read. Try a JPG or PNG.', 'bad_encoding');
  // Reject before decoding when the encoded size already exceeds the limit.
  if (maxBytes && Math.floor((b64.length * 3) / 4) > maxBytes + 3) throw new ImageError('The photo is too large. Use one under 3 MB.', 'too_large');
  return Buffer.from(b64, 'base64');
}

export function sniffType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  return null;
}

function pngSize(buf) {
  // IHDR is always the first chunk: width/height at bytes 16-23.
  if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), orientation: exifOrientation(buf) };
    }
    if (marker === 0xda) break; // start of scan without a frame header
    i += 2 + len;
  }
  return null;
}

/** EXIF orientation 5-8 means the stored pixels are rotated 90 degrees. */
function exifOrientation(buf) {
  const idx = buf.indexOf(Buffer.from('Exif\0\0', 'binary'));
  if (idx < 0 || idx > 65536) return 1;
  const tiff = idx + 6;
  if (tiff + 8 > buf.length) return 1;
  const le = buf.toString('ascii', tiff, tiff + 2) === 'II';
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  try {
    const ifd = tiff + u32(tiff + 4);
    const count = u16(ifd);
    for (let n = 0; n < count; n += 1) {
      const e = ifd + 2 + n * 12;
      if (u16(e) === 0x0112) return u16(e + 8);
    }
  } catch {
    /* malformed EXIF: treat as upright */
  }
  return 1;
}

/**
 * Inspect an image buffer. Returns `{ type, width, height, bytes, shortSide, tier }`
 * where tier is 'hd' | 'sd' (the best YouCam tier the resolution allows),
 * or throws ImageError with a user-facing message.
 */
export function inspectImage(buf, { maxBytes = IMAGE_RULES.maxBytes } = {}) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new ImageError('Add a photo first.', 'no_image');
  if (buf.length > maxBytes) throw new ImageError(`The photo is too large. Use one under ${Math.floor(maxBytes / (1024 * 1024))} MB.`, 'too_large');
  const type = sniffType(buf);
  if (!type) throw new ImageError('Use a JPG or PNG photo.', 'unsupported_type');
  const dims = type === 'image/png' ? pngSize(buf) : jpegSize(buf);
  if (!dims || !dims.width || !dims.height) throw new ImageError('The photo could not be read. Try taking it again.', 'unreadable');
  const rotated = dims.orientation >= 5 && dims.orientation <= 8;
  const width = rotated ? dims.height : dims.width;
  const height = rotated ? dims.width : dims.height;
  const shortSide = Math.min(width, height);
  if (shortSide < IMAGE_RULES.minShortSideSd) {
    throw new ImageError(`The photo is too small (${width}×${height}). Use one at least ${IMAGE_RULES.minShortSideSd} pixels on its short side.`, 'error_below_min_image_size');
  }
  const tier = shortSide >= IMAGE_RULES.minShortSideHd ? 'hd' : 'sd';
  return { type, width, height, bytes: buf.length, shortSide, tier };
}

/**
 * Minimal multipart/form-data reader for one file field. Returns
 * `{ file: { buffer, contentType, fileName } | null, fields: {name: value} }`.
 */
export function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new ImageError('The upload is missing its boundary.', 'bad_multipart');
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  const fields = {};
  let file = null;
  let pos = body.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (body.slice(start, start + 2).toString() === '--') break;
    const next = body.indexOf(boundary, start);
    if (next === -1) break;
    const part = body.slice(start + 2, next - 2); // strip CRLF after boundary and before next
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headers = part.slice(0, headerEnd).toString('utf8');
      const content = part.slice(headerEnd + 4);
      const name = /name="([^"]*)"/i.exec(headers)?.[1];
      const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
      const ctype = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim();
      if (filename !== undefined) {
        if (!file) file = { buffer: content, contentType: ctype || 'application/octet-stream', fileName: filename, field: name };
      } else if (name) {
        fields[name] = content.toString('utf8').slice(0, 2000);
      }
    }
    pos = next;
  }
  return { file, fields };
}
