// Image sniffing, dimensions, tier selection, EXIF rotation and multipart parsing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectImage, decodeImageString, parseMultipart, ImageError } from '../lib/image.js';
import { makePng, makeJpegHeader } from './helpers.js';

test('PNG dimensions pick HD at 1080 px short side, SD below', () => {
  const hd = inspectImage(makePng(1080, 1440));
  assert.deepEqual([hd.type, hd.width, hd.height, hd.tier], ['image/png', 1080, 1440, 'hd']);
  assert.equal(inspectImage(makePng(720, 960)).tier, 'sd');
});

test('JPEG SOF parsing and EXIF orientation', () => {
  const j = inspectImage(makeJpegHeader(1500, 2000));
  assert.deepEqual([j.type, j.width, j.height, j.tier], ['image/jpeg', 1500, 2000, 'hd']);
  const rotated = inspectImage(makeJpegHeader(2000, 1500, 6));
  assert.deepEqual([rotated.width, rotated.height], [1500, 2000]);
});

test('rejects tiny, unknown and oversized images with user-facing messages', () => {
  assert.throws(() => inspectImage(makePng(300, 400)), (e) => e instanceof ImageError && e.code === 'error_below_min_image_size');
  assert.throws(() => inspectImage(Buffer.from('GIF89a....')), (e) => e.code === 'unsupported_type');
  assert.throws(() => inspectImage(makePng(500, 500), { maxBytes: 100 }), (e) => e.code === 'too_large');
  assert.throws(() => inspectImage(Buffer.alloc(0)), (e) => e.code === 'no_image');
});

test('decodes data URLs and bare base64, and refuses junk before decoding', () => {
  const png = makePng(480, 640);
  assert.deepEqual(decodeImageString(`data:image/png;base64,${png.toString('base64')}`), png);
  assert.deepEqual(decodeImageString(png.toString('base64')), png);
  assert.throws(() => decodeImageString('data:image/png;base64,<script>'), (e) => e.code === 'bad_encoding');
  assert.throws(() => decodeImageString('A'.repeat(4000), 1000), (e) => e.code === 'too_large');
  assert.throws(() => decodeImageString(undefined), (e) => e.code === 'no_image');
});

test('multipart parser extracts the file and fields', () => {
  const png = makePng(480, 640);
  const b = '----glowplan';
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="tier"\r\n\r\nsd\r\n`),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="image"; filename="me.png"\r\nContent-Type: image/png\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  const { file, fields } = parseMultipart(body, `multipart/form-data; boundary=${b}`);
  assert.equal(fields.tier, 'sd');
  assert.equal(file.fileName, 'me.png');
  assert.equal(file.contentType, 'image/png');
  assert.deepEqual(file.buffer, png);
});
